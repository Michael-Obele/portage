/**
 * Filesystem helpers, Bun-first.
 *
 * Uses `Bun.file()` for existence/stat (no syscall round trip through node's
 * binding layer) and `Bun.spawnSync` for the handful of places where a system
 * tool is genuinely the right tool (`sync -f`, `statvfs` via `df`, `du`).
 *
 * The durability discipline lives here. Measured on this machine: about **25 %
 * of a transfer's wall time is writeback** that `adb` had already reported as
 * finished. So "the copy exited 0" is a different claim from "the bytes are on
 * the platters", and Portage never makes the first claim on the second's
 * behalf.
 */

import { mkdir, rm, rename } from "node:fs/promises";
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

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDir: boolean;
}

/** Stat via `Bun.file()` — returns null instead of throwing on a missing path. */
export async function statSafe(path: string): Promise<FileStat | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return {
      size: file.size,
      mtimeMs: Math.round(file.lastModified),
      isDir: false,
    };
  } catch {
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

/** Recursive byte total + file count for a tree. Skips unreadable entries. */
export function treeSize(root: string): { bytes: number; files: number } {
  const bytes = Bun.spawnSync(["du", "-sb", root], { stderr: "ignore" });
  const count = Bun.spawnSync(["find", root, "-type", "f"], {
    stderr: "ignore",
  });
  const byteValue = Number(bytes.stdout.toString().trim().split(/\s+/)[0]);
  const fileCount =
    count.exitCode === 0
      ? count.stdout.toString().trim().split("\n").filter(Boolean).length
      : 0;
  return {
    bytes: Number.isFinite(byteValue) ? byteValue : 0,
    files: fileCount,
  };
}

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
  if (stat) return stat.isDir;
  const res = Bun.spawnSync(["test", "-d", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return res.exitCode === 0;
}

export { mkdir, rm, rename };

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
