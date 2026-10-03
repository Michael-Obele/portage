/**
 * The journal — SQLite on the drive, via `bun:sqlite`.
 *
 * `<drive>/.portage/portage.db` with `journal_mode=WAL`,
 * `synchronous=NORMAL`, `foreign_keys=ON`. WAL on the drive's NTFS-via-FUSE
 * mount was probed on the real hardware first: `journal_mode=wal` was accepted,
 * 500 inserts in one transaction read back correctly, and the `-wal`/`-shm`
 * sidecars were created and cleaned up normally.
 *
 * Alongside it: an append-only `events.jsonl`. A database is for querying; a
 * text log is for reading at 1 a.m. when something went wrong.
 *
 * The journal lives on the drive on purpose. The drive is the thing being
 * curated and it moves between machines — "what is on here and where did it
 * come from" belongs with it, so plugging the drive into any machine with
 * portage installed tells you the whole story.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { DB_FILENAME, EVENTS_FILENAME, STATE_DIR } from "../config/schema.ts";
import type { Logger } from "../util/log.ts";

/**
 * The per-file state machine, in the order states can occur.
 *
 * `failed` is a first-class state with a reason — never a silent skip. A tool
 * whose job is not deleting your files has to be able to say "these three did
 * not move, here is why" without you having to go looking.
 */
export const TRANSFER_STATES = [
  "eligible",
  "queued",
  "copying",
  "written",
  "verified",
  "source_deleted",
  "done",
  "failed",
  "skipped_excluded",
  "skipped_duplicate",
] as const;

export type TransferState = (typeof TRANSFER_STATES)[number];

/** States from which no further work happens in this run. */
export const TERMINAL_STATES: readonly TransferState[] = [
  "done",
  "failed",
  "skipped_excluded",
  "skipped_duplicate",
];

/** States that mean "bytes are on the drive and they check out". */
export const PROVEN_STATES: readonly TransferState[] = [
  "verified",
  "source_deleted",
  "done",
];

export interface TransferRow {
  id: number;
  run_id: number | null;
  device_id: string;
  src_path: string;
  dest_path: string;
  path_norm: string;
  size: number;
  src_mtime: number;
  state: TransferState;
  hash: string | null;
  hash_scope: "full" | "partial" | null;
  attempts: number;
  last_error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface RunRow {
  id: number;
  device_id: string | null;
  transport: string;
  started_at: number;
  finished_at: number | null;
  status: "running" | "done" | "failed" | "interrupted";
  bytes_total: number;
  bytes_done: number;
  files_total: number;
  files_done: number;
  files_failed: number;
}

export interface DeviceRow {
  id: string;
  label: string | null;
  model: string | null;
  android: string | null;
  first_seen: number;
  last_seen: number;
}

export interface ArchiveRow {
  path: string;
  path_norm: string;
  size: number;
  mtime: number | null;
  hash: string | null;
  hash_kind: "sha256" | "sample" | null;
  anime_key: string | null;
  added_at: number;
  verified_at: number | null;
}

/**
 * Migrations, applied in order and keyed off `PRAGMA user_version`.
 *
 * Never edit a shipped migration — append a new one. The journal has to
 * survive being opened by an older binary after a downgrade.
 */
const MIGRATIONS: string[][] = [
  // v1 — initial schema
  [
    `CREATE TABLE devices (
      id           TEXT PRIMARY KEY,
      label        TEXT,
      model        TEXT,
      android      TEXT,
      first_seen   INTEGER NOT NULL,
      last_seen    INTEGER NOT NULL
    )`,

    `CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
      transport TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('running','done','failed','interrupted')),
      bytes_total INTEGER NOT NULL DEFAULT 0,
      bytes_done  INTEGER NOT NULL DEFAULT 0,
      files_total INTEGER NOT NULL DEFAULT 0,
      files_done  INTEGER NOT NULL DEFAULT 0,
      files_failed INTEGER NOT NULL DEFAULT 0
    )`,

    `CREATE TABLE transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      device_id TEXT NOT NULL,
      src_path  TEXT NOT NULL,
      dest_path TEXT NOT NULL,
      path_norm TEXT NOT NULL,
      size INTEGER NOT NULL,
      src_mtime INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN (${TRANSFER_STATES.map((s) => `'${s}'`).join(",")})),
      hash TEXT,
      hash_scope TEXT CHECK (hash_scope IN ('full','partial') OR hash_scope IS NULL),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      UNIQUE (device_id, src_path, size, src_mtime)
    )`,
    `CREATE INDEX idx_transfers_state ON transfers(state)`,
    `CREATE INDEX idx_transfers_norm ON transfers(path_norm)`,
    `CREATE INDEX idx_transfers_device ON transfers(device_id)`,

    // The archive outlives any one transfer and can be rebuilt from a scan, so
    // it is deliberately not a view over `transfers`.
    `CREATE TABLE archive (
      path       TEXT PRIMARY KEY,
      path_norm  TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL,
      mtime INTEGER,
      hash TEXT,
      hash_kind TEXT CHECK (hash_kind IN ('sha256','sample') OR hash_kind IS NULL),
      anime_key TEXT,
      added_at INTEGER NOT NULL,
      verified_at INTEGER
    )`,
    `CREATE INDEX idx_archive_anime ON archive(anime_key)`,
    `CREATE INDEX idx_archive_size ON archive(size)`,

    `CREATE TABLE dupe_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tier INTEGER NOT NULL CHECK (tier IN (1,2)),
      reason TEXT,
      keeper_path TEXT,
      reclaimable_bytes INTEGER NOT NULL DEFAULT 0,
      decided_at INTEGER,
      decided_by TEXT CHECK (decided_by IN ('human','auto-tier1') OR decided_by IS NULL)
    )`,

    `CREATE TABLE dupe_members (
      group_id INTEGER NOT NULL REFERENCES dupe_groups(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      score TEXT,
      PRIMARY KEY (group_id, path)
    )`,

    `CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      run_id INTEGER,
      level TEXT NOT NULL,
      msg TEXT NOT NULL,
      data TEXT
    )`,
    `CREATE INDEX idx_events_at ON events(at)`,
  ],
];

export class Journal {
  private readonly db: Database;
  private readonly eventsPath: string;
  private closed = false;

  constructor(
    dbPath: string,
    private readonly logger?: Logger,
  ) {
    // The `.portage` directory has to exist before SQLite will open a file
    // inside it — and `plan` opens a journal on a drive that may have never
    // been written to, which is exactly when this bites.
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath, { create: true, readwrite: true });
    this.eventsPath = join(dirname(dbPath), EVENTS_FILENAME);

    // WAL keeps readers from blocking the writer, which matters when the
    // dashboard reads while a transfer writes.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  /** Open (creating if needed) the journal that lives under a destination root. */
  static open(destRoot: string, logger?: Logger): Journal {
    return new Journal(join(destRoot, STATE_DIR, DB_FILENAME), logger);
  }

  private migrate(): void {
    const row = this.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get();
    let version = row?.user_version ?? 0;

    for (let i = version; i < MIGRATIONS.length; i++) {
      const statements = MIGRATIONS[i];
      if (!statements) continue;
      this.logger?.debug(`applying journal migration v${i + 1}`);
      this.db.exec("BEGIN");
      try {
        for (const sql of statements) this.db.exec(sql);
        // PRAGMA cannot be parameterised, and the value is a loop index.
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      version = i + 1;
    }
  }

  // --- devices ---------------------------------------------------------------

  /** Record that we saw a device. Idempotent — safe to call on every scan. */
  touchDevice(
    id: string,
    label?: string,
    model?: string,
    android?: string,
  ): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO devices (id, label, model, android, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label       = COALESCE(excluded.label, label),
           model       = COALESCE(excluded.model, model),
           android     = COALESCE(excluded.android, android),
           last_seen   = excluded.last_seen`,
      )
      .run(id, label ?? null, model ?? null, android ?? null, now, now);
  }

  listDevices(): DeviceRow[] {
    return this.db
      .query<DeviceRow, []>("SELECT * FROM devices ORDER BY label, id")
      .all();
  }

  // --- runs ------------------------------------------------------------------

  startRun(deviceId: string | null, transport: string): number {
    // The foreign key is the point: a run cannot reference a device the
    // journal has never seen, so the device row is written first.
    if (deviceId) {
      this.db
        .query(
          "INSERT OR IGNORE INTO devices (id, first_seen, last_seen) VALUES (?, ?, ?)",
        )
        .run(deviceId, Date.now(), Date.now());
    }
    const res = this.db
      .query<{ id: number }, [string | null, string, number]>(
        `INSERT INTO runs (device_id, transport, started_at, status) VALUES (?, ?, ?, 'running')
         RETURNING id`,
      )
      .get(deviceId, transport, Date.now());
    return Number(res?.id ?? 0);
  }

  finishRun(
    runId: number,
    status: RunRow["status"],
    totals: Partial<RunRow> = {},
  ): void {
    this.db
      .query(
        `UPDATE runs SET finished_at = ?, status = ?,
           bytes_total = COALESCE(?, bytes_total),
           bytes_done  = COALESCE(?, bytes_done),
           files_total = COALESCE(?, files_total),
           files_done  = COALESCE(?, files_done),
           files_failed = COALESCE(?, files_failed)
         WHERE id = ?`,
      )
      .run(
        Date.now(),
        status,
        totals.bytes_total ?? null,
        totals.bytes_done ?? null,
        totals.files_total ?? null,
        totals.files_done ?? null,
        totals.files_failed ?? null,
        runId,
      );
  }

  listRuns(limit = 10): RunRow[] {
    return this.db
      .query<RunRow, [number]>(
        `SELECT r.*, d.label AS device_label FROM runs r
         LEFT JOIN devices d ON d.id = r.device_id
         ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(limit) as RunRow[];
  }

  // --- transfers -------------------------------------------------------------

  /**
   * Insert a transfer row, or return the existing one.
   *
   * The `UNIQUE(device_id, src_path, size, mtime)` constraint is what makes a
   * re-run a no-op instead of a re-copy. A changed size or mtime is a different
   * file and correctly gets its own row.
   */
  upsertTransfer(input: {
    runId: number | null;
    deviceId: string;
    srcPath: string;
    destPath: string;
    pathNorm: string;
    size: number;
    srcMtime: number;
    state: TransferState;
  }): TransferRow {
    // The device row must exist before the transfer can reference it.
    this.db
      .query(
        "INSERT OR IGNORE INTO devices (id, first_seen, last_seen) VALUES (?, ?, ?)",
      )
      .run(input.deviceId, Date.now(), Date.now());

    const existing = this.findTransfer(
      input.deviceId,
      input.srcPath,
      input.size,
      input.srcMtime,
    );
    if (existing) {
      this.db
        .query(
          `UPDATE transfers SET dest_path = ?, path_norm = ?, run_id = COALESCE(?, run_id), state = ?
           WHERE id = ?`,
        )
        .run(
          input.destPath,
          input.pathNorm,
          input.runId,
          input.state,
          existing.id,
        );
      return this.getTransfer(existing.id)!;
    }

    const res = this.db
      .query<
        { id: number },
        [number | null, string, string, string, string, number, number, string]
      >(
        `INSERT INTO transfers
           (run_id, device_id, src_path, dest_path, path_norm, size, src_mtime, state, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         RETURNING id`,
      )
      .get(
        input.runId,
        input.deviceId,
        input.srcPath,
        input.destPath,
        input.pathNorm,
        input.size,
        input.srcMtime,
        input.state,
      );
    return this.getTransfer(Number(res?.id ?? 0))!;
  }

  findTransfer(
    deviceId: string,
    srcPath: string,
    size: number,
    srcMtime: number,
  ): TransferRow | null {
    return (
      this.db
        .query<TransferRow, [string, string, number, number]>(
          `SELECT * FROM transfers
           WHERE device_id = ? AND src_path = ? AND size = ? AND src_mtime = ?`,
        )
        .get(deviceId, srcPath, size, srcMtime) ?? null
    );
  }

  getTransfer(id: number): TransferRow | null {
    return (
      this.db
        .query<TransferRow, [number]>("SELECT * FROM transfers WHERE id = ?")
        .get(id) ?? null
    );
  }

  /** Move a transfer to a new state, stamping the relevant timestamps. */
  setState(id: number, state: TransferState, error?: string): void {
    const now = Date.now();
    const started = state === "copying" ? now : null;
    const finished =
      TERMINAL_STATES.includes(state) || state === "verified" ? now : null;
    this.db
      .query(
        `UPDATE transfers SET state = ?, last_error = ?, started_at = COALESCE(?, started_at),
           finished_at = COALESCE(?, finished_at), attempts = attempts + 1
         WHERE id = ?`,
      )
      .run(state, error ?? null, started, finished, id);
  }

  /** Record the content hash that proved this destination. */
  setHash(id: number, hash: string, scope: "full" | "partial"): void {
    this.db
      .query("UPDATE transfers SET hash = ?, hash_scope = ? WHERE id = ?")
      .run(hash, scope, id);
  }

  /** Every row currently at or beyond `copying` — what a resume run picks up. */
  listActive(deviceId?: string): TransferRow[] {
    const states = ["eligible", "queued", "copying", "written", "verified"];
    const placeholders = states.map(() => "?").join(",");
    if (deviceId) {
      return this.db
        .query<TransferRow, [string, ...string[]]>(
          `SELECT * FROM transfers WHERE device_id = ? AND state IN (${placeholders})
           ORDER BY src_path`,
        )
        .all(deviceId, ...states);
    }
    return this.db
      .query<
        TransferRow,
        string[]
      >(`SELECT * FROM transfers WHERE state IN (${placeholders}) ORDER BY src_path`)
      .all(...states);
  }

  listByState(state: TransferState, limit = 100): TransferRow[] {
    return this.db
      .query<
        TransferRow,
        [string, number]
      >(`SELECT * FROM transfers WHERE state = ? ORDER BY finished_at DESC LIMIT ?`)
      .all(state, limit);
  }

  /** `portage status` — recent transfers with their outcome. */
  listRecent(limit = 50): TransferRow[] {
    return this.db
      .query<
        TransferRow,
        [number]
      >("SELECT * FROM transfers ORDER BY id DESC LIMIT ?")
      .all(limit);
  }

  countByState(): Record<string, number> {
    const rows = this.db
      .query<
        { state: string; n: number },
        []
      >("SELECT state, COUNT(*) AS n FROM transfers GROUP BY state")
      .all();
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  /** Files verified on the drive whose phone copy has not been deleted yet. */
  listPendingPurge(deviceId?: string): TransferRow[] {
    const sql = `SELECT * FROM transfers WHERE state = 'verified'
       ${deviceId ? "AND device_id = ?" : ""}
       ORDER BY finished_at`;
    return deviceId
      ? this.db.query<TransferRow, [string]>(sql).all(deviceId)
      : this.db.query<TransferRow, []>(sql).all();
  }

  // --- archive ---------------------------------------------------------------

  /**
   * Record a file that is on the drive.
   *
   * `path_norm` is UNIQUE because the drive is NTFS and case-insensitive —
   * without it the archive could hold two rows for one real file, and the
   * duplicate report would then report a file as its own duplicate.
   */
  upsertArchive(input: {
    path: string;
    pathNorm: string;
    size: number;
    mtime?: number | null;
    hash?: string | null;
    hashKind?: "sha256" | "sample" | null;
    animeKey?: string | null;
    verified?: boolean;
  }): void {
    this.db
      .query(
        `INSERT INTO archive (path, path_norm, size, mtime, hash, hash_kind, anime_key, added_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path_norm) DO UPDATE SET
           size       = excluded.size,
           mtime      = excluded.mtime,
           hash       = COALESCE(excluded.hash, archive.hash),
           hash_kind  = COALESCE(excluded.hash_kind, archive.hash_kind),
           anime_key  = COALESCE(excluded.anime_key, archive.anime_key),
           verified_at = COALESCE(excluded.verified_at, archive.verified_at)`,
      )
      .run(
        input.path,
        input.pathNorm,
        input.size,
        input.mtime ?? null,
        input.hash ?? null,
        input.hashKind ?? null,
        input.animeKey ?? null,
        Date.now(),
        input.verified ? Date.now() : null,
      );
  }

  findArchive(pathNorm: string): ArchiveRow | null {
    return (
      this.db
        .query<
          ArchiveRow,
          [string]
        >("SELECT * FROM archive WHERE path_norm = ?")
        .get(pathNorm) ?? null
    );
  }

  archiveBySize(size: number): ArchiveRow[] {
    return this.db
      .query<ArchiveRow, [number]>("SELECT * FROM archive WHERE size = ?")
      .all(size);
  }

  archiveByAnimeKey(key: string): ArchiveRow[] {
    return this.db
      .query<ArchiveRow, [string]>("SELECT * FROM archive WHERE anime_key = ?")
      .all(key);
  }

  countArchive(): { files: number; bytes: number } {
    const row = this.db
      .query<
        { files: number; bytes: number },
        []
      >("SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM archive")
      .get();
    return { files: row?.files ?? 0, bytes: row?.bytes ?? 0 };
  }

  // --- events ----------------------------------------------------------------

  /**
   * Append a human-readable event.
   *
   * Dual-written: a row for querying, a line for reading. When something has
   * gone wrong at 1 a.m. nobody is writing SQL.
   */
  event(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    runId?: number,
    data?: unknown,
  ): void {
    const at = Date.now();
    const payload = data === undefined ? null : JSON.stringify(data);
    this.db
      .query(
        "INSERT INTO events (at, run_id, level, msg, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(at, runId ?? null, level, msg, payload);

    try {
      // Append-only text log. A failed append must never fail the operation
      // that was trying to report itself.
      Bun.write(
        this.eventsPath,
        `${JSON.stringify({ at, run: runId ?? null, level, msg, data })}\n`,
        {
          createPath: true,
        },
      );
    } catch {
      /* the DB row is the durable copy; the text log is best-effort */
    }
  }

  recentEvents(limit = 50): Array<{ at: number; level: string; msg: string }> {
    return this.db
      .query<
        { at: number; level: string; msg: string },
        [number]
      >("SELECT at, level, msg FROM events ORDER BY id DESC LIMIT ?")
      .all(limit);
  }

  // --- maintenance -----------------------------------------------------------

  /** A portable JSONL snapshot, for grepping and for backing up the record. */
  exportJSONL(): string {
    const rows = this.db
      .query<Record<string, unknown>, []>("SELECT * FROM transfers")
      .all() as Record<string, unknown>[];
    return rows.map((r) => JSON.stringify(r)).join("\n");
  }

  vacuum(): void {
    this.db.exec("VACUUM");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Fold the WAL back into the main DB so the drive carries one file.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}
