/**
 * The Rust scanner client (`crates/portage-scan`).
 *
 * The engine keeps every DECISION — what a duplicate is, what may move, what is
 * safe to delete. This module only gets the two expensive things done: walking a
 * filesystem, and hashing files on several cores.
 *
 * # Why there is a separate binary at all
 *
 * Measured on the real 2 TB archive (ntfs-3g, 34 880 files):
 *
 *   Bun.Glob("**\/*")            178.5 s
 *   Rust walk, absolute paths    175.3 s
 *   Rust walk, relative descent    4.1 s
 *
 * Every one of those reads the same tree. The difference is PATH LENGTH: one
 * folder on that drive holds a 462-segment chain, and ntfs-3g resolves every
 * component per syscall — a stat of the deepest directory is 621 ms by full path
 * and 3 ms as `.` from inside it. GNU find is fast for the same reason (fts keeps
 * paths short with fchdir). JavaScript has no `openat`, so this cannot be fixed
 * inside the engine; it needs a process that can chdir.
 *
 * # Failure is never fatal
 *
 * A missing or broken scanner falls back to the JavaScript walker, which is
 * correct but slow, and says so. A scan that returns in three minutes and tells
 * you it was slow beats a scan that refuses to run.
 */
/// <reference types="bun" />
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Point this at a scanner to pin the binary, e.g. a locally built one. */
export const SCANNER_ENV = "PORTAGE_SCAN";

/** A full-drive walk over a cold USB disk. Long, but not unbounded. */
const WALK_TIMEOUT_MS = 180_000;
/** Hashing reads bytes, so it gets a much longer leash than a walk. */
const DIGEST_TIMEOUT_MS = 15 * 60_000;

export interface ScannerWalkFile {
  /** Index into the response's `roots`. */
  root: number;
  relative: string;
  size: number;
  /** Seconds since the epoch, or null when the filesystem would not say. */
  mtime: number | null;
  depth: number;
}

export interface ScannerWalkBody {
  ok: boolean;
  version: string;
  command: "walk";
  elapsedMs: number;
  roots: string[];
  dirs: number;
  files: ScannerWalkFile[];
  bytes: number;
  errors: Array<{ path: string; reason: string }>;
  errorCount: number;
  deepest: { relative: string; depth: number } | null;
  depthLimited: number;
}

export interface ScannerDigestBody {
  ok: boolean;
  version: string;
  command: "digest";
  elapsedMs: number;
  mode: "full" | "sample";
  root: string;
  digests: Array<{ relative: string; size: number; digest: string }>;
  errors: Array<{ relative: string; reason: string }>;
  errorCount: number;
  threads: number;
}

/**
 * Every place a scanner could be, most specific first.
 *
 * The two that matter in practice: next to the engine binary (that is where
 * Tauri's `externalBin` puts it, in the bundle AND in `src-tauri/binaries/` as
 * `portage-scan-<triple>`), and under `crates/` for a developer running the
 * engine from source.
 */
export function scannerCandidates(): string[] {
  const found: string[] = [];
  const pinned = Bun.env[SCANNER_ENV]?.trim();
  if (pinned !== undefined && pinned !== "") found.push(pinned);

  const exeDir = dirname(process.execPath);
  found.push(join(exeDir, "portage-scan"));
  // The staged sidecar carries the target triple in its filename.
  try {
    for (const name of readdirSync(exeDir)) {
      if (name.startsWith("portage-scan-")) found.push(join(exeDir, name));
    }
  } catch {
    /* the engine's own directory is always readable, but never assume */
  }

  const cwd = process.cwd();
  found.push(join(cwd, "crates", "portage-scan", "target", "release", "portage-scan"));
  found.push(join(cwd, "crates", "portage-scan", "target", "debug", "portage-scan"));
  return found;
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

let cached: string | null | undefined;

/**
 * The scanner to use, or `null`.
 *
 * Cached because a scan asks twice (walk, then digest) and neither should pay
 * for a directory listing. `resetScanner()` exists for tests and for a Settings
 * screen that has just been told to look again.
 */
export function resolveScanner(): string | null {
  if (cached !== undefined) return cached;
  cached = scannerCandidates().find(isExecutableFile) ?? null;
  return cached;
}

/** Forget the cached resolution, so the next scan looks again. */
export function resetScanner(): void {
  cached = undefined;
}

/**
 * One JSON request in, one JSON response out.
 *
 * The deadline is enforced by killing the child: a wedged ntfs-3g mount makes a
 * read block forever, and a scan that never returns is indistinguishable from a
 * dead engine.
 */
async function ask<T extends { ok: boolean }>(
  binary: string,
  request: unknown,
  timeoutMs: number
): Promise<T> {
  const proc = Bun.spawn([binary], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });

  const payload = `${JSON.stringify(request)}\n`;
  try {
    // Bun's sink buffers; `end()` flushes and closes, which is what tells the
    // child the request is complete.
    proc.stdin.write(payload);
    await proc.stdin.end();
  } catch {
    /* the child may already have died; the exit code below is the real report */
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, timeoutMs);

  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timer);

  if (timedOut) {
    throw new Error(
      `portage-scan did not answer within ${Math.round(timeoutMs / 1000)} s, so it was stopped; a mount that has stopped responding does this`
    );
  }

  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new Error(
      `portage-scan exited ${exit} without saying anything${stderr.trim() === "" ? "" : `: ${stderr.trim().slice(0, 400)}`}`
    );
  }

  let body: T;
  try {
    body = JSON.parse(trimmed) as T;
  } catch {
    throw new Error(`portage-scan answered something that is not JSON: ${trimmed.slice(0, 200)}`);
  }
  if (!body.ok) {
    const payload = body as unknown as { error?: unknown };
    const reason = typeof payload.error === "string" ? payload.error : "the request was refused";
    throw new Error(`portage-scan refused the request: ${reason}`);
  }
  return body;
}

/** Walk every root, skipping hidden entries and the caller's excluded names. */
export async function scannerWalk(
  binary: string,
  roots: string[],
  excludeDirs: string[],
  /** Files smaller than this are not reported. 1 for a scan; 0 for accounting. */
  minSize = 1
): Promise<ScannerWalkBody> {
  return ask<ScannerWalkBody>(
    binary,
    {
      command: "walk",
      roots,
      minSize,
      skipHidden: true,
      excludeDirs
    },
    WALK_TIMEOUT_MS
  );
}

/** Digest files relative to one root. `sample` REJECTS only; `full` confirms. */
export async function scannerDigest(
  binary: string,
  root: string,
  relatives: string[],
  mode: "sample" | "full"
): Promise<ScannerDigestBody> {
  return ask<ScannerDigestBody>(
    binary,
    { command: "digest", root, relatives, mode },
    DIGEST_TIMEOUT_MS
  );
}

export interface ScannerProbe {
  path: string;
  version: string;
}

/**
 * Ask a scanner for its version, or `null` when there is nothing to ask.
 *
 * Doctor uses this, so a stale binary that predates a command is visible on the
 * screen instead of being discovered by a failed scan.
 */
export async function probeScanner(): Promise<ScannerProbe | null> {
  const binary = resolveScanner();
  if (binary === null) return null;
  try {
    const proc = Bun.spawn([binary, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe"
    });
    const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exit !== 0) return null;
    // "portage-scan 0.1.15"
    const version = stdout.trim().split(/\s+/).pop() ?? '';
    return { path: binary, version: version === '' ? 'unknown' : version };
  } catch {
    return null;
  }
}
