/**
 * E1: does a flush on the archive drive move its flush-requests-completed counter,
 * and how long does a healthy flush take? Each timed run writes a 300 MB file and
 * deletes it. The script deletes only paths it created (R4.12).
 *
 * Usage: bun scripts/bench/e1-flush.ts <archive-root>
 */
import { readFileSync } from "node:fs";
import { mkdir, open, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  diskOf,
  mountGuard,
  parseDiskstatsFlush,
  writeRecord,
} from "./record.ts";

export type Reading = { before: number; after: number };
export type E1Runs = {
  // form0: `sync -f`. form1a: "r". form1b: "r+". form2: form1a, then the directory.
  counter: { form0: Reading; form1a: Reading; form1b: Reading; form2: Reading };
  flushMs: number;
  dirSyncMs: number;
};
export type E1Verdict = {
  result: "pass" | "fail";
  openMode: "r" | "r+" | null;
};

export const FILE_BYTES = 300_000_000;
// R1.12: 30 s plus 1 s per 10 MB, rounded up. durable.ts owns this rule (task 1.8).
const deadlineMs = (size: number) =>
  30_000 + 1_000 * Math.ceil(size / 10_000_000);
export const FILE_DEADLINE_MS = deadlineMs(FILE_BYTES);
export const DIR_DEADLINE_MS = deadlineMs(0);

const TIMED_RUNS = 5;
const STAT_CALLS = 50;
// Covers the 6.3 GB of writes with a margin.
const MIN_FREE_BYTES = 7_000_000_000;
const FORMS = ["form0", "form1a", "form1b", "form2"] as const;
type Form = (typeof FORMS)[number];

const moved = (r: Reading) => r.after > r.before;

// The open mode follows the counter even when timing fails. Pass needs a mode and both times.
export function e1Verdict(runs: E1Runs): E1Verdict {
  const openMode = moved(runs.counter.form1a)
    ? "r"
    : moved(runs.counter.form1b)
      ? "r+"
      : null;
  const inTime =
    runs.flushMs <= FILE_DEADLINE_MS && runs.dirSyncMs <= DIR_DEADLINE_MS;
  return { result: openMode !== null && inTime ? "pass" : "fail", openMode };
}

type Snap = {
  partition: number;
  disk: number;
  dirtyKb: number;
  writebackKb: number;
};
type Handle = { role: string; mode: "r" | "r+" | null; path: string };
type FlushTimes = {
  handles: Handle[];
  wallMs: number;
  fileSyncMs: number;
  dirSyncMs: number | null;
};
type Created = { files: string[]; dirs: string[] };
type Dev = { partition: string; disk: string };

function meminfoKb(text: string, key: "Dirty" | "Writeback"): number {
  const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"));
  if (!m?.[1]) throw new Error(`/proc/meminfo has no ${key}`);
  return Number(m[1]);
}

function snap(dev: Dev): Snap {
  const diskstats = readFileSync("/proc/diskstats", "utf8");
  const partition = parseDiskstatsFlush(diskstats, dev.partition);
  const disk = parseDiskstatsFlush(diskstats, dev.disk);
  if (partition === null || disk === null) {
    throw new Error(`no flush counter in /proc/diskstats for ${dev.partition}`);
  }
  const meminfo = readFileSync("/proc/meminfo", "utf8");
  return {
    partition,
    disk,
    dirtyKb: meminfoKb(meminfo, "Dirty"),
    writebackKb: meminfoKb(meminfo, "Writeback"),
  };
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

// Returns the time of sync() alone. The open and close are not timed.
async function syncHandle(path: string, mode: "r" | "r+"): Promise<number> {
  const h = await open(path, mode);
  try {
    const t = performance.now();
    await h.sync();
    return performance.now() - t;
  } finally {
    await h.close();
  }
}

async function runForm(form: Form, file: string): Promise<FlushTimes> {
  if (form === "form0") {
    const t = performance.now();
    const proc = Bun.spawn(["sync", "-f", file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    const wallMs = performance.now() - t;
    if (code !== 0) throw new Error(`sync -f exited ${code}: ${stderr.trim()}`);
    return {
      handles: [{ role: "sync -f child", mode: null, path: file }],
      wallMs,
      fileSyncMs: wallMs,
      dirSyncMs: null,
    };
  }

  const mode = form === "form1b" ? "r+" : "r";
  const t = performance.now();
  const fileSyncMs = await syncHandle(file, mode);
  const handles: Handle[] = [{ role: "file", mode, path: file }];
  if (form !== "form2") {
    return {
      handles,
      wallMs: performance.now() - t,
      fileSyncMs,
      dirSyncMs: null,
    };
  }
  // Linux does not open a directory for writing, so the directory is "r".
  const dir = dirname(file);
  const dirSyncMs = await syncHandle(dir, "r");
  handles.push({ role: "dir", mode: "r", path: dir });
  return { handles, wallMs: performance.now() - t, fileSyncMs, dirSyncMs };
}

async function removeFile(file: string, made: Created): Promise<void> {
  await unlink(file).catch((err: { code?: string }) => {
    if (err.code !== "ENOENT") throw err;
  });
  made.files = made.files.filter((p) => p !== file);
}

type TimedRun = {
  form: Form;
  index: number;
  file: string;
  beforeWrite: Snap;
  afterWrite: Snap;
  beforeFlush: Snap;
  afterFlush: Snap;
  flush: FlushTimes;
};

async function timedRun(
  form: Form,
  index: number,
  dir: string,
  dev: Dev,
  made: Created,
): Promise<TimedRun> {
  const file = join(dir, `e1-${form}-${index}.bin`);
  const beforeWrite = snap(dev);
  await writeFixed(file, FILE_BYTES, made);
  const afterWrite = snap(dev);
  const beforeFlush = snap(dev);
  const flush = await runForm(form, file);
  const afterFlush = snap(dev);
  await removeFile(file, made);
  return {
    form,
    index,
    file,
    beforeWrite,
    afterWrite,
    beforeFlush,
    afterFlush,
    flush,
  };
}

// One form 2 flush is pending while 50 stats run on the same drive (DV-5, N18).
async function statScenario(dir: string, dev: Dev, made: Created) {
  const file = join(dir, "e1-stat.bin");
  await writeFixed(file, FILE_BYTES, made);
  const before = snap(dev);
  let pending = true;
  const flushing = runForm("form2", file).finally(() => {
    pending = false;
  });
  // One synchronous pass issues all 50, so each one starts while the flush is pending.
  const calls = await Promise.all(
    Array.from({ length: STAT_CALLS }, async () => {
      const pendingAtStart = pending;
      const t = performance.now();
      await stat(file);
      return { ms: performance.now() - t, pendingAtStart };
    }),
  );
  const flush = await flushing;
  const t = performance.now();
  await stat(file);
  const firstAfterMs = performance.now() - t;
  const after = snap(dev);
  await removeFile(file, made);
  const whilePending = calls.filter((c) => c.pendingAtStart);
  return {
    file,
    before,
    after,
    flush,
    calls,
    pendingStats: whilePending.length,
    longestMs: Math.max(...calls.map((c) => c.ms)),
    longestWhilePendingMs:
      whilePending.length === 0
        ? null
        : Math.max(...whilePending.map((c) => c.ms)),
    firstAfterMs,
  };
}

// Weakest run: the reading with the smallest delta. It moves only when every run moved.
function weakest(readings: Reading[]): Reading {
  let w = readings[0];
  if (w === undefined) throw new Error("no timed runs");
  for (const r of readings) {
    if (r.after - r.before < w.after - w.before) w = r;
  }
  return w;
}

// Removes only what this run created. Files go first, then folders deepest first.
async function removeCreated(made: Created): Promise<void> {
  for (const file of [...made.files]) await removeFile(file, made);
  for (const dir of [...made.dirs].reverse()) {
    await rmdir(dir).catch((err: { code?: string }) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}

async function main(): Promise<void> {
  const dest = process.argv[2];
  if (!dest)
    throw new Error("usage: bun scripts/bench/e1-flush.ts <archive-root>");

  // Nothing may be written before the guard passes.
  const guard = mountGuard(dest);
  const partition = basename(guard.source);
  const disk = diskOf(partition);
  if (disk === null) throw new Error(`no sysfs disk for ${guard.source}`);
  const dev: Dev = { partition, disk };

  const dfStart = df(guard.root);
  if (dfStart.avail < MIN_FREE_BYTES) {
    throw new Error(`free space ${dfStart.avail} is under ${MIN_FREE_BYTES}`);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const made: Created = { files: [], dirs: [] };
  const runDir = join(guard.root, ".portage", "bench", `e1-${runId}`);
  const baseline = snap(dev);

  let timed: Record<Form, TimedRun[]> | null = null;
  let stat: Awaited<ReturnType<typeof statScenario>> | null = null;
  let dfBeforeCleanup = "";
  let dfAfterCleanup = "";
  try {
    await ensureDir(join(guard.root, ".portage"), made);
    await ensureDir(join(guard.root, ".portage", "bench"), made);
    await ensureDir(runDir, made);
    timed = { form0: [], form1a: [], form1b: [], form2: [] };
    // Blocks by form, not alternating (O-12 leaves the order open).
    for (const form of FORMS) {
      for (let i = 1; i <= TIMED_RUNS; i += 1) {
        timed[form].push(await timedRun(form, i, runDir, dev, made));
      }
    }
    stat = await statScenario(runDir, dev, made);
    dfBeforeCleanup = df(guard.root).raw;
  } finally {
    await removeCreated(made);
    dfAfterCleanup = df(guard.root).raw;
  }
  if (timed === null || stat === null) throw new Error("run did not finish");

  // The disk line moves on every fsync form and never on `sync -f`. The partition
  // line read 0 under every form in the first run, so it cannot show a device flush.
  const runsFor = (line: "partition" | "disk"): E1Runs => {
    const readings = (form: Form) =>
      weakest(
        timed[form].map((r) => ({
          before: r.beforeFlush[line],
          after: r.afterFlush[line],
        })),
      );
    return {
      counter: {
        form0: readings("form0"),
        form1a: readings("form1a"),
        form1b: readings("form1b"),
        form2: readings("form2"),
      },
      flushMs: Math.max(...timed.form2.map((r) => r.flush.fileSyncMs)),
      dirSyncMs: Math.max(
        ...timed.form2.map((r) => r.flush.dirSyncMs ?? Infinity),
      ),
    };
  };
  const decided = runsFor("disk");
  const verdict = {
    ...e1Verdict(decided),
    counterLine: "disk",
    fileDeadlineMs: FILE_DEADLINE_MS,
    dirDeadlineMs: DIR_DEADLINE_MS,
    flushMsMax: decided.flushMs,
    dirSyncMsMax: decided.dirSyncMs,
    counterReadings: decided.counter,
    partitionLine: e1Verdict(runsFor("partition")),
  };

  const path = writeRecord("e1-flush", verdict, {
    archiveRoot: guard.root,
    partition: dev,
    fixtureRoot: runDir,
    baseline,
    df: {
      start: dfStart.raw,
      beforeCleanup: dfBeforeCleanup,
      afterCleanup: dfAfterCleanup,
    },
    timed,
    statScenario: stat,
  });
  process.stdout.write(`${path}\n`);
}

if (import.meta.main) {
  await main();
}
