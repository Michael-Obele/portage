/**
 * The filesystem half of a scan, behind one interface: Rust, or the JS fallback.
 *
 * The report records which one ran. Both must see the same candidate set, so the
 * exclusion rule lives once (`isExcludedRelative`) and mirrors walk.rs.
 */
/// <reference types="bun" />
import { ALWAYS_EXCLUDED_DIRS } from "#lib/config/schema.ts";
import { statSafe } from "#lib/util/fs.ts";
import { sampleHash, sha256File } from "#lib/util/hash.ts";
import { resolveInside } from "#lib/util/paths.ts";

import { resolveScanner, scannerDigest, scannerWalk } from "#lib/dedupe/scanner.ts";
import type { Candidate } from "#lib/dedupe/tier1.ts";

export type ScanVia = "scanner" | "glob";

export interface WalkOutcome {
  candidates: Candidate[];
  bytes: number;
  /** Which walker produced this. Never inferred by the caller. */
  via: ScanVia;
  elapsedMs: number;
  dirs: number;
  /** Failures the walker hit, with the path it hit them on. */
  errors: Array<{ path: string; reason: string }>;
  errorCount: number;
  deepest: { relative: string; depth: number } | null;
  depthLimited: number;
  /** Why the fast path could not run, when it could not. `null` when it did. */
  scannerError: string | null;
}

export interface WalkOptions {
  /**
   * Files smaller than this are not reported. Defaults to 1, because a
   * zero-byte file is never a candidate for anything Portage does — but trash
   * accounting asks for 0 so its file count is the real number of entries.
   */
  minSize?: number;
  /** Walk deadline; the scanner default applies when unset. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ScanIo {
  readonly via: ScanVia;
  walk(roots: string[], options?: WalkOptions): Promise<WalkOutcome>;
  /**
   * Digest the given candidates. `sample` REJECTS only — it can never confirm a
   * duplicate, and a caller that treats it as proof will delete a good copy.
   * `full` is the confirmation.
   */
  digests(candidates: readonly Candidate[], mode: "sample" | "full"): Promise<Map<string, string | null>>;
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving order.
 *
 * Written here rather than imported: hashing is the one place in this engine
 * that is IO-bound enough for concurrency to matter, and a dependency for twelve
 * lines is a dependency to maintain forever.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** How many files the fallback hashes at once. FUSE round trips dominate. */
const FALLBACK_CONCURRENCY = 8;

/**
 * Whether a relative path sits under an excluded directory.
 *
 * Mirrors `crates/portage-scan/src/walk.rs` exactly, because a candidate set that
 * depends on which walker ran is a bug you cannot see: the fast path would never
 * offer `Android/data/x.mkv` and the fallback would.
 *
 * A pattern containing `/` matches a run of whole trailing segments of a
 * directory (`Android/data`, not `MyAndroid/data`); anything else is a single
 * directory name.
 */
export function isExcludedRelative(relative: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const segments = relative.split("/");
  // Only the DIRECTORIES on the way to the file can exclude it.
  const dirs = segments.slice(0, -1);
  for (let depth = 1; depth <= dirs.length; depth += 1) {
    const ancestor = dirs.slice(0, depth).join("/");
    const name = dirs[depth - 1] as string;
    for (const pattern of patterns) {
      if (pattern.includes("/")) {
        if (ancestor === pattern || ancestor.endsWith(`/${pattern}`)) return true;
      } else if (name === pattern) {
        return true;
      }
    }
  }
  return false;
}

// --- the fast path ----------------------------------------------------------

export function scannerIo(): ScanIo {
  let binary: string | null = null;

  const requireBinary = (): string => {
    binary ??= resolveScanner();
    if (binary === null) {
      throw new Error(
        'the portage-scan binary was not found next to the engine or under crates/portage-scan/target'
      );
    }
    return binary;
  };

  return {
    via: "scanner",
    async walk(roots: string[], options?: WalkOptions): Promise<WalkOutcome> {
      const path = requireBinary();
      const started = Bun.nanoseconds();
      const body = await scannerWalk(path, roots, [...ALWAYS_EXCLUDED_DIRS], options?.minSize ?? 1, {
        timeoutMs: options?.timeoutMs,
        signal: options?.signal
      });
      const candidates: Candidate[] = [];
      let bytes = 0;
      for (const file of body.files) {
        const root = body.roots[file.root];
        if (root === undefined) continue;
        const absolute = resolveInside(root, file.relative);
        // The walker never leaves a root, but the engine does not take a
        // child process's word for that: §6 rule 6 is enforced here too.
        if (absolute === null) continue;
        candidates.push({
          root,
          path: absolute,
          relative: file.relative,
          size: file.size,
          mtime: file.mtime
        });
        bytes += file.size;
      }
      return {
        candidates,
        bytes,
        via: "scanner",
        elapsedMs: Math.round((Bun.nanoseconds() - started) / 1e6),
        dirs: body.dirs,
        errors: body.errors,
        errorCount: body.errorCount,
        deepest: body.deepest,
        depthLimited: body.depthLimited,
        scannerError: null
      };
    },
    async digests(candidates, mode): Promise<Map<string, string | null>> {
      const path = requireBinary();
      const out = new Map<string, string | null>();
      // One child per root: the walker names files relative to their root, and
      // the digester opens them relative to it, so the paths stay short.
      const byRoot = new Map<string, Candidate[]>();
      for (const candidate of candidates) {
        const list = byRoot.get(candidate.root);
        if (list) list.push(candidate);
        else byRoot.set(candidate.root, [candidate]);
      }
      for (const [root, group] of byRoot) {
        if (group.length === 0) continue;
        const body = await scannerDigest(
          path,
          root,
          group.map((candidate) => candidate.relative),
          mode
        );
        const digests = new Map(body.digests.map((entry) => [entry.relative, entry.digest]));
        for (const candidate of group) {
          out.set(candidate.path, digests.get(candidate.relative) ?? null);
        }
      }
      return out;
    }
  };
}

// --- the fallback -----------------------------------------------------------

/** The original engine-side walk. Correct, portable, and slow on FUSE. */
export function globIo(): ScanIo {
  return {
    via: "glob",
    async walk(roots: string[], options?: WalkOptions): Promise<WalkOutcome> {
      const floor = options?.minSize ?? 1;
      const started = Bun.nanoseconds();
      const candidates: Candidate[] = [];
      const errors: Array<{ path: string; reason: string }> = [];
      const folders = new Set<string>();
      let bytes = 0;

      for (const root of roots) {
        const glob = new Bun.Glob("**/*");
        for await (const relative of glob.scan({ cwd: root, dot: false, followSymlinks: false })) {
          if (options?.signal?.aborted) throw new Error("the walk was cancelled");
          if (!relative || relative.endsWith("/")) continue;
          const segments = relative.split("/");
          if (isExcludedRelative(relative, ALWAYS_EXCLUDED_DIRS)) continue;

          const absolute = resolveInside(root, relative);
          if (absolute === null) continue; // §6 rule 6

          try {
            const stat = await statSafe(absolute);
            if (stat === null || stat.size < floor) continue;
            // Insurance: a file/dir question answered by the filesystem, not by
            // the glob's own idea of what it walked.
            if (stat.isDir) continue;
            candidates.push({
              root,
              path: absolute,
              relative,
              size: stat.size,
              mtime: stat.mtimeMs > 0 ? Math.round(stat.mtimeMs / 1000) : null
            });
            // An empty segment means the file sits in the root itself, and the
            // Rust walker counts only folders it DESCENDED.
            const folder = segments.slice(0, -1).join("/");
            if (folder !== "") folders.add(`${root}/${folder}`);
            bytes += stat.size;
          } catch (err) {
            if (errors.length < 50) {
              errors.push({ path: relative, reason: err instanceof Error ? err.message : String(err) });
            }
          }
        }
      }

      return {
        candidates,
        bytes,
        via: "glob",
        elapsedMs: Math.round((Bun.nanoseconds() - started) / 1e6),
        // Counted, not zero: the caption says "Walked N folders", and a fallback
        // that always said 0 put a visible falsehood in the sentence that exists
        // to explain a slow scan.
        dirs: folders.size,
        errors,
        errorCount: errors.length,
        deepest: null,
        depthLimited: 0,
        scannerError: null
      };
    },
    async digests(candidates, mode): Promise<Map<string, string | null>> {
      const hash =
        mode === "sample"
          ? (candidate: Candidate) => sampleHash(candidate.path)
          : (candidate: Candidate) => sha256File(candidate.path);
      const results = await mapLimit(candidates, FALLBACK_CONCURRENCY, hash);
      const out = new Map<string, string | null>();
      candidates.forEach((candidate, index) => out.set(candidate.path, results[index] ?? null));
      return out;
    }
  };
}

/**
 * The scanner when there is one, the built-in walker when there is not.
 *
 * A scanner that exists but FAILS (a stale binary, a mount that stopped
 * answering) is not retried here: `resilientScanIo` is the caller that decides,
 * because a whole-drive scan is minutes of the person's time and silently
 * spending three times longer is worse than being told.
 */
export function defaultScanIo(): ScanIo {
  return resolveScanner() === null ? globIo() : scannerIo();
}

/**
 * Wrap an IO so a failure in EITHER stage falls back to the built-in walker.
 *
 * The walk and the hash are separate calls, and a scanner can manage one and
 * not the other — a binary that walks fine and then hits a file it cannot read
 * used to take the whole scan down with it. Falling back is also a REPORT: the
 * `degraded` flag and the message travel into the scan's summary, so a slow scan
 * is explained instead of looking broken.
 */
export function resilientScanIo(
  primary: ScanIo,
  onProgress?: (message: string) => void
): { io: ScanIo; degraded: boolean; error: string | null } {
  if (primary.via !== "scanner") return { io: primary, degraded: false, error: null };

  const fallback = globIo();
  const state = { degraded: false, error: null as string | null };
  const note = (err: unknown): void => {
    const reason = err instanceof Error ? err.message : String(err);
    state.degraded = true;
    state.error ??= reason;
    onProgress?.(
      `the fast scanner could not run (${reason}); finishing with the built-in walker, which is slower on a mounted drive`
    );
  };

  return {
    io: {
      via: "scanner",
      async walk(roots, options) {
        try {
          return await primary.walk(roots, options);
        } catch (err) {
          note(err);
          // The fallback's own outcome says `via: "glob"`, which is the truth:
          // this walk was not the fast one.
          return fallback.walk(roots, options);
        }
      },
      async digests(candidates, mode) {
        try {
          return await primary.digests(candidates, mode);
        } catch (err) {
          note(err);
          return fallback.digests(candidates, mode);
        }
      }
    },
    get degraded() {
      return state.degraded;
    },
    get error() {
      return state.error;
    }
  };
}

export { mapLimit };
