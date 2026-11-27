/**
 * Stat and drive-space helpers. Durable writes (fsync, mkdir, move) live in
 * `src/util/durable.ts`. `Bun.file().exists()` is false for a directory, so
 * path stat goes through node:fs. `Bun.spawnSync` cannot be interrupted;
 * prefer the async, deadline-bound variants on drive paths.
 */

import { mkdir, stat as statPath } from "node:fs/promises";
import { join } from "node:path";

import type { SpawnFn } from "#lib/util/spawn.ts";

export interface DiskSpace {
  free: number;
  total: number;
}

/**
 * Free/total bytes for the filesystem holding `path`. Goes through `SpawnFn`,
 * which has a deadline and kills the child: a synchronous `df` on a wedged mount
 * would block the whole event loop.
 */
export async function diskSpaceAsync(
  spawn: (cmd: string[], opts?: { timeoutMs?: number }) => Promise<{
    code: number;
    stdout: string;
  }>,
  path: string,
  timeoutMs = 3_000,
): Promise<DiskSpace | null> {
  const res = await spawn(["df", "-B1", "--output=size,avail", path], {
    timeoutMs,
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

export type MountState =
  | { kind: "mounted"; fsType: string; options: string; target: string }
  | { kind: "not-mounted" }
  | { kind: "unreadable"; reason: string };

const unescapeMount = (field: string): string =>
  field.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

/**
 * One `findmnt` for the mount holding `path`. A killed child is `unreadable`,
 * never `not-mounted`: only exit 1 with no output means the path has no mount.
 */
export async function readMount(
  spawn: SpawnFn,
  path: string,
  timeoutMs = 3_000,
): Promise<MountState> {
  const res = await spawn(
    ["findmnt", "-rno", "FSTYPE,OPTIONS,TARGET", "--target", path],
    { timeoutMs },
  );
  if (res.signal === "TIMEOUT") {
    return { kind: "unreadable", reason: `no answer within ${timeoutMs} ms` };
  }
  const out = res.stdout.trim();
  if (res.code === 1 && out === "") return { kind: "not-mounted" };
  if (res.code !== 0) {
    return { kind: "unreadable", reason: `findmnt exited ${res.code}` };
  }
  // A short line still reads as mounted: the volume list only needs the type.
  const [fsType, options = "", ...rest] = out.split(" ");
  const target = rest.join(" ");
  if (!fsType) {
    return { kind: "unreadable", reason: "findmnt printed an empty line" };
  }
  return {
    kind: "mounted",
    fsType: unescapeMount(fsType),
    options: unescapeMount(options),
    target: unescapeMount(target),
  };
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
