/**
 * E4: do Bun's sync() calls succeed on an archive file and directory, and does the
 * flush counter move? The CI-pinned Bun (1.4.4, DV-25) decides the branch. The local
 * Bun runs too, and both runs go in one record. The script deletes only paths it created.
 *
 * Usage: bun scripts/bench/e4-bun-sync.ts <archive-root>
 */
import { readFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diskOf,
  mountGuard,
  parseDiskstatsFlush,
  writeRecord,
} from "./record.ts";

export const CI_PIN = "1.4.4";
const SCRIPT = fileURLToPath(import.meta.url);
// Same file size as E1, so both records describe the same fixture.
const FILE_BYTES = 300_000_000;
// Dirty data for the "r+" call. A sync with nothing dirty would not show the counter.
const DIRTY_BYTES = 1_000_000;
// Written after the file syncs and never synced, so the dir sync has an entry to flush.
const PENDING_BYTES = 4096;
const MIN_FREE_BYTES = 1_000_000_000;

export type CallName = "file-r" | "file-r+" | "dir-r";
export type Stage = "open" | "write" | "sync";
export type Call = {
  name: CallName;
  mode: "r" | "r+";
  path: string;
  counterBefore: number | null;
  counterAfter: number | null;
  ok: boolean;
  stage: Stage | null;
  error: string | null;
};
export type Branch = "A" | "B" | null;

// A: the directory sync() throws. B: it succeeds and the counter moves.
// An open or write failure is neither, because sync() never ran.
export function directoryBranch(calls: Call[]): Branch {
  const dir = calls.find((c) => c.name === "dir-r");
  if (!dir) return null;
  if (!dir.ok && dir.stage === "sync") return "A";
  if (
    dir.ok &&
    dir.counterBefore !== null &&
    dir.counterAfter !== null &&
    dir.counterAfter > dir.counterBefore
  ) {
    return "B";
  }
  return null;
}

// Decided by the CI-pinned run only. The local run is recorded, not decisive.
export function e4Verdict(pinCalls: Call[]) {
  const branch = directoryBranch(pinCalls);
  return {
    result: branch === null ? ("fail" as const) : ("pass" as const),
    directoryBranch: branch,
  };
}

type Created = { files: string[]; dirs: string[] };
type ChildRun = {
  bunVersion: string;
  execPath: string;
  partition: string;
  disk: string;
  dir: string;
  file: string;
  calls: Call[];
};

const ignoreMissing = (err: { code?: string }) => {
  if (err.code !== "ENOENT") throw err;
};

// EEXIST is not recorded, so a folder that was already there is never removed.
async function ensureDir(path: string, made: Created): Promise<void> {
  try {
    await mkdir(path);
    made.dirs.push(path);
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
  }
}

// Records the path before writing, so a partial write is still cleaned up.
async function writeFixed(file: string, bytes: number, made: Created) {
  made.files.push(file);
  const chunk = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  const h = await open(file, "wx");
  try {
    for (let left = bytes; left > 0; ) {
      const n = Math.min(left, chunk.length);
      await h.write(chunk, 0, n);
      left -= n;
    }
  } finally {
    await h.close();
  }
}

function df(path: string): { raw: string; avail: number } {
  const r = Bun.spawnSync(["df", "-B1", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = new TextDecoder().decode(r.stdout).trim();
  if (r.exitCode !== 0) {
    const err = new TextDecoder().decode(r.stderr).trim();
    throw new Error(`df failed for ${path}: ${err}`);
  }
  const avail = Number(text.split("\n").pop()?.split(/\s+/)[3]);
  if (!Number.isFinite(avail))
    throw new Error(`df gave no free space: ${text}`);
  return { raw: text, avail };
}

// The disk line is the counter E1 decided on (E1 record, counterLine).
function counter(disk: string): number {
  const v = parseDiskstatsFlush(
    readFileSync("/proc/diskstats", "utf8"),
    disk,
  );
  if (v === null) throw new Error(`no flush counter for ${disk}`);
  return v;
}

function describe(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown };
  const msg = typeof e.message === "string" ? e.message : String(err);
  return typeof e.code === "string" ? `${e.code}: ${msg}` : msg;
}

// Times only the sync() call. The open, the optional prepare step, and the close are not timed.
async function syncCall(
  name: CallName,
  path: string,
  mode: "r" | "r+",
  disk: string,
  prepare?: (h: FileHandle) => Promise<void>,
): Promise<Call> {
  const call: Call = {
    name,
    mode,
    path,
    counterBefore: null,
    counterAfter: null,
    ok: false,
    stage: null,
    error: null,
  };
  let h: FileHandle;
  try {
    h = await open(path, mode);
  } catch (err) {
    return { ...call, stage: "open", error: describe(err) };
  }
  try {
    if (prepare) {
      try {
        await prepare(h);
      } catch (err) {
        return { ...call, stage: "write", error: describe(err) };
      }
    }
    call.counterBefore = counter(disk);
    try {
      await h.sync();
      call.ok = true;
    } catch (err) {
      call.stage = "sync";
      call.error = describe(err);
    }
    call.counterAfter = counter(disk);
    return call;
  } finally {
    await h.close();
  }
}

// The dirtying write goes through the r+ handle that the sync then uses.
const dirty = (h: FileHandle) =>
  h.write(Buffer.alloc(DIRTY_BYTES, 0x33), 0, DIRTY_BYTES, 0).then(() => {});

// Runs under one Bun. Called in a child process, so each Bun writes with its own runtime.
async function childRun(dest: string): Promise<ChildRun> {
  const guard = mountGuard(dest);
  const partition = basename(guard.source);
  const disk = diskOf(partition);
  if (disk === null) throw new Error(`no sysfs disk for ${guard.source}`);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const made: Created = { files: [], dirs: [] };
  const dir = join(guard.root, ".portage", "bench", `e4-${runId}`);
  const file = join(dir, "e4.bin");
  let calls: Call[] = [];
  try {
    await ensureDir(join(guard.root, ".portage"), made);
    await ensureDir(join(guard.root, ".portage", "bench"), made);
    await ensureDir(dir, made);
    await writeFixed(file, FILE_BYTES, made);
    calls = [
      await syncCall("file-r", file, "r", disk),
      await syncCall("file-r+", file, "r+", disk, dirty),
      // Runs after the file syncs, so none of them has flushed this entry.
      await syncCall("dir-r", dir, "r", disk, () =>
        writeFixed(join(dir, "pending.bin"), PENDING_BYTES, made),
      ),
    ];
  } finally {
    for (const f of made.files) await unlink(f).catch(ignoreMissing);
    for (const d of [...made.dirs].reverse()) {
      await rmdir(d).catch(ignoreMissing);
    }
  }
  return {
    bunVersion: Bun.version,
    execPath: process.execPath,
    partition,
    disk,
    dir,
    file,
    calls,
  };
}

// The child prints one JSON line on stdout. Its stderr is shown only on failure.
async function runChild(cmd: string[]): Promise<ChildRun> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${code}: ${err.trim()}`);
  }
  return JSON.parse(out.trim().split("\n").pop() ?? "") as ChildRun;
}

async function main(): Promise<void> {
  if (process.argv[2] === "--child") {
    const root = process.argv[3];
    if (!root) throw new Error("--child needs an archive root");
    process.stdout.write(`${JSON.stringify(await childRun(root))}\n`);
    return;
  }

  const dest = process.argv[2];
  if (!dest) throw new Error("usage: bun scripts/bench/e4-bun-sync.ts <archive-root>");

  // Nothing may be written before the guard passes.
  const guard = mountGuard(dest);
  const dfStart = df(guard.root);
  if (dfStart.avail < MIN_FREE_BYTES) {
    throw new Error(`free space ${dfStart.avail} is under ${MIN_FREE_BYTES}`);
  }

  const pin = await runChild(["bunx", `bun@${CI_PIN}`, SCRIPT, "--child", guard.root]);
  if (pin.bunVersion !== CI_PIN) {
    throw new Error(`CI-pin run reported Bun ${pin.bunVersion}, not ${CI_PIN}`);
  }
  const local = await runChild([process.execPath, SCRIPT, "--child", guard.root]);
  const dfEnd = df(guard.root);

  const verdict = e4Verdict(pin.calls);
  const localBranch = directoryBranch(local.calls);
  const path = writeRecord(
    "e4-bun-sync",
    {
      ...verdict,
      pinVersion: CI_PIN,
      localVersion: local.bunVersion,
      localBranch,
      runsAgree: localBranch === verdict.directoryBranch,
      decidedBy: `Bun ${CI_PIN} (CI pin)`,
    },
    {
      archiveRoot: guard.root,
      fixture: { bytes: FILE_BYTES, dirtyBytes: DIRTY_BYTES },
      df: { start: dfStart.raw, end: dfEnd.raw },
      runs: [pin, local],
      procedure: `Pending-entry step: after the two file syncs and before the dir-r sync, the script creates pending.bin in the run folder, writes ${PENDING_BYTES} bytes, and closes it without any sync, so the directory sync is the first call that can flush that entry.`,
      supersedes: "bench/results/superseded/2026-11-26-e4-bun-sync.json",
    },
  );
  process.stdout.write(`${path}\n`);
}

if (import.meta.main) {
  await main();
}
