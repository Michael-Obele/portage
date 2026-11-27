/**
 * The send record: `send.db` in the state directory, never the archive journal.
 *
 * Kept apart from `.portage/portage.db` so a send never writes to the archive
 * drive (R18.2). WAL mode matches the journal.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { preconditionError } from "#lib/util/errors.ts";

/** Pure. XDG state directory, or `~/.local/state` when `XDG_STATE_HOME` is unset. */
export function sendRecordPath(
  env: Record<string, string | undefined>,
  home: string,
): string {
  const state = env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(state, "portage", "send.db");
}

export interface JobRow {
  send_id: string;
  kind: string;
  source_kind: string;
  source_label: string;
  source_device_id: string | null;
  target_device_id: string;
  target_folder: string;
  walker: string;
  replace_included: number;
  move_included: number;
  files_planned: number;
  bytes_planned: number;
  state: string;
  refusal: string | null;
  reason: string | null;
  started_at: number | null;
  finished_at: number | null;
  folders_created: string;
  leftover_partials: string;
  host_temp_remaining: string;
  relays: string;
}

export interface FileRow {
  send_id: string;
  row_id: number;
  source_path: string;
  target_path: string;
  size: number;
  expected_sha256: string | null;
  target_sha256: string | null;
  host_sha256: string | null;
  relay: string;
  write_method: string;
  state: string;
  reason: string | null;
  bytes_moved: number;
  partial_path: string | null;
  partial_removed: number | null;
  host_temp_path: string | null;
  host_temp_removed: number | null;
  old_size: number | null;
  old_sha256: string | null;
  started_at: number | null;
  finished_at: number | null;
}

/** Columns `updateFile` may write. A fixed list keeps the SQL free of caller text. */
const FILE_PATCH_COLUMNS = [
  "state",
  "reason",
  "bytes_moved",
  "target_sha256",
  "host_sha256",
  "expected_sha256",
  "write_method",
  "partial_removed",
  "host_temp_removed",
  "started_at",
  "finished_at",
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS send_jobs (
  send_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_label TEXT NOT NULL,
  source_device_id TEXT,
  target_device_id TEXT NOT NULL,
  target_folder TEXT NOT NULL,
  walker TEXT NOT NULL,
  replace_included INTEGER NOT NULL,
  move_included INTEGER NOT NULL,
  files_planned INTEGER NOT NULL,
  bytes_planned INTEGER NOT NULL,
  state TEXT NOT NULL,
  refusal TEXT,
  reason TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  folders_created TEXT NOT NULL,
  leftover_partials TEXT NOT NULL,
  host_temp_remaining TEXT NOT NULL,
  relays TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS send_files (
  send_id TEXT NOT NULL REFERENCES send_jobs(send_id),
  row_id INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  expected_sha256 TEXT,
  target_sha256 TEXT,
  host_sha256 TEXT,
  relay TEXT NOT NULL,
  write_method TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  bytes_moved INTEGER NOT NULL,
  partial_path TEXT,
  partial_removed INTEGER,
  host_temp_path TEXT,
  host_temp_removed INTEGER,
  old_size INTEGER,
  old_sha256 TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (send_id, row_id)
);
`;

export class SendRecord {
  private constructor(private readonly db: Database) {}

  /** Creates the file and tables on first use. Failure is EH-18. */
  static open(path: string): SendRecord {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path, { create: true, readwrite: true });
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(SCHEMA);
      return new SendRecord(db);
    } catch (err) {
      throw preconditionError(
        `the send record cannot be opened (${path}: ${(err as Error).message})`,
        "check that the state directory is writable",
      );
    }
  }

  insertJob(row: JobRow): void {
    const keys = Object.keys(row) as (keyof JobRow)[];
    this.db
      .query(
        `INSERT INTO send_jobs (${keys.join(", ")}) VALUES (${keys.map((k) => `$${k}`).join(", ")})`,
      )
      .run(bind(row));
  }

  insertFile(row: FileRow): void {
    const keys = Object.keys(row) as (keyof FileRow)[];
    this.db
      .query(
        `INSERT INTO send_files (${keys.join(", ")}) VALUES (${keys.map((k) => `$${k}`).join(", ")})`,
      )
      .run(bind(row));
  }

  updateFile(
    sendId: string,
    rowId: number,
    patch: Partial<Pick<FileRow, (typeof FILE_PATCH_COLUMNS)[number]>>,
  ): void {
    const cols = FILE_PATCH_COLUMNS.filter((c) => c in patch);
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = $${c}`).join(", ");
    const values: Record<string, Bind> = { $send_id: sendId, $row_id: rowId };
    for (const c of cols) values[`$${c}`] = patch[c] ?? null;
    this.db
      .query(`UPDATE send_files SET ${sets} WHERE send_id = $send_id AND row_id = $row_id`)
      .run(values);
  }

  finishJob(
    sendId: string,
    patch: Pick<JobRow, "state" | "finished_at"> &
      Partial<Pick<JobRow, "reason" | "refusal">>,
  ): void {
    this.db
      .query(
        `UPDATE send_jobs SET state = $state, finished_at = $finished_at,
           reason = COALESCE($reason, reason), refusal = COALESCE($refusal, refusal)
         WHERE send_id = $send_id`,
      )
      .run({
        $send_id: sendId,
        $state: patch.state,
        $finished_at: patch.finished_at,
        $reason: patch.reason ?? null,
        $refusal: patch.refusal ?? null,
      });
  }

  listJobs(limit: number): JobRow[] {
    return this.db
      .query("SELECT * FROM send_jobs ORDER BY started_at DESC LIMIT $limit")
      .all({ $limit: limit }) as JobRow[];
  }

  /** A job still `running` belongs to an engine that died (EH-25). */
  reconcileInterrupted(now: number): number {
    const res = this.db
      .query(
        `UPDATE send_jobs SET state = 'cancelled', reason = 'engine stopped',
           finished_at = $now WHERE state = 'running'`,
      )
      .run({ $now: now });
    return res.changes;
  }

  close(): void {
    this.db.close();
  }
}

type Bind = string | number | null;

function bind(row: object): Record<string, Bind> {
  const out: Record<string, Bind> = {};
  for (const [k, v] of Object.entries(row)) out[`$${k}`] = v ?? null;
  return out;
}
