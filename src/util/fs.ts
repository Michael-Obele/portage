/**
 * Filesystem helpers, Bun-first.
 *
 * `Bun.spawnSync` covers the handful of places where a system tool is genuinely
 * the right tool (`sync -f`, `statvfs` via `df`, `du`). Path stat goes through
 * `node:fs/promises`, because `Bun.file().exists()` is a question about FILES and
 * answers false for a directory.
 *
 * The durability discipline lives here. Measured on this machine: about **25 %
 * of a transfer's wall time is writeback** that `adb` had already reported as
 * finished. So "the copy exited 0" is a different claim from "the bytes are on
 * the platters", and Portage never makes the first claim on the second's
 * behalf.
 */

import { mkdir, rm, rename, stat as statPath } from "node:fs/promises";
import { join } from "node:path";

/**
 * Flush one path to stable storage.
 *
 * Prefers `sync -f <file>` (fsync that single file, cheap). Falls back to a
 * bare `sync` where `sync -f` is unsupported. Returns true when a flush ran.
 */
export function fsyncPath(path: string): boolean {
  const scoped = Bun.spawnSync(["sync", "-f", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (scoped.exitCode === 0) return true;
  const global = Bun.spawnSync(["sync"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return global.exitCode === 0;
}

export interface DiskSpace {
  free: number;
  total: number;
}

/** Free/total bytes for the filesystem holding `path`. */
export function diskSpace(path: string): DiskSpace | null {
  // Node has no statvfs binding; `df -B1 --output=size,avail` is the portable way.
  const res = Bun.spawnSync(["df", "-B1", "--output=size,avail", path], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (res.exitCode !== 0) return null;

  const text = res.stdout.toString();
  const lines = text.trim().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return null;

  const parts = last.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const total = Number(parts[0]);
  const free = Number(parts[1]);
  if (!Number.isFinite(total) || !Number.isFinite(free)) return null;
  return { free, total };
}

/**
 * The same reading, bounded.
 *
 * `diskSpace` above is synchronous on purpose for callers that only have a
 * path, but `Bun.spawnSync` cannot be interrupted: on a wedged FUSE mount `df`
 * blocks forever and takes the whole event loop with it, so the engine stops
 * answering ANY command — the app looks dead because one drive is sick. This
 * version goes through `SpawnFn`, which has a deadline and kills the child.
 */
export async function diskSpaceAsync(
  spawn: (cmd: string[], opts?: { timeoutMs?: number }) => Promise<{
    code: number;
    stdout: string;
  }>,
  path: string,
): Promise<DiskSpace | null> {
  const res = await spawn(["df", "-B1", "--output=size,avail", path], {
    timeoutMs: 3_000,
  });
  if (res.code !== 0) return null;
  const lines = res.stdout.trim().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return null;
  const parts = last.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const total = Number(parts[0]);
  const free = Number(parts[1]);
  if (!Number.isFinite(total) || !Number.isFinite(free)) return null;
  return { free, total };
}

/** Resolve to `fallback` when `task` takes longer than `ms`. */
export async function withTimeout<T>(
  task: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    // A pending timer must not keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([task, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDir: boolean;
}

/**
 * Stat a path, following symlinks, returning `null` instead of throwing.
 *
 * `node:fs` rather than `Bun.file().stat()`, and the reason is a real bug this
 * replaced: `Bun.file(path).exists()` answers false for a DIRECTORY, so gating
 * on it made `isDirectory()` false for every directory on the machine — doctor
 * reported a present destination as "does not exist", and a trash that was full
 * of files as "no trash". One API answers for files, the other for paths, and
 * `isDir` has to come from the filesystem rather than from a constant.
 */
export async function statSafe(path: string): Promise<FileStat | null> {
  try {
    const stat = await statPath(path);
    return {
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      isDir: stat.isDirectory(),
    };
  } catch {
    // Missing, unreadable, or on a mount that will not answer. All three are
    // "I cannot vouch for this path", which is what null means everywhere here.
    return null;
  }
}

/** Synchronous stat for call sites deep in sync code paths. */
export function statSyncSafe(path: string): FileStat | null {
  const res = Bun.spawnSync(["stat", "-c", "%s\t%Y\t%F", path], {
    stderr: "ignore",
  });
  if (res.exitCode !== 0) return null;
  const [size, mtime, kind] = res.stdout.toString().trim().split("\t");
  return {
    size: Number(size),
    mtimeMs: Number(mtime) * 1000,
    isDir: (kind ?? "").startsWith("directory"),
  };
}

/** Move a file, falling back to copy+unlink across a device boundary. */
/** Create a directory (and parents) if missing. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Create the whole `.portage` state tree on a drive. */
export async function ensureStateDirs(
  destRoot: string,
): Promise<{ root: string; partial: string; trash: string }> {
  const root = join(destRoot, ".portage");
  const partial = join(root, "partial");
  const trash = join(root, "trash");
  await Promise.all([
    mkdir(partial, { recursive: true }),
    mkdir(trash, { recursive: true }),
  ]);
  return { root, partial, trash };
}

/** Is `path` an existing directory? */
export async function isDirectory(path: string): Promise<boolean> {
  const stat = await statSafe(path);
  // "We could not read it" is not "it is a directory". The old fallback ran a
  // SYNCHRONOUS `test -d`, and a synchronous child cannot be timed out: on a
  // mount that wedged between the stat and the spawn it blocked the event loop
  // for as long as the mount stayed sick — taking every command in the engine
  // with it. A caller that needs to try harder can; this never lies and never
  // blocks.
  return stat?.isDir ?? false;
}

/** Move a file, falling back to copy+unlink across a device boundary. */
export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "EXDEV") throw err;
  }
  await Bun.write(to, Bun.file(from));
  await rm(from, { force: true });
}
