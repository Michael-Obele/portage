/**
 * Paths — `bun:path` plus the one thing it cannot do.
 *
 * `bun:path` is the first-party module and faster than `node:path`, so all
 * plain path work goes through it. What it has no concept of is NTFS: the
 * drive is **case-insensitive**, so `Frieren 07.mkv` and `frieren 07.mkv` are
 * one file on the disk and two different strings to us. Every journal row
 * therefore stores both `path` (original case, what the user sees) and
 * `path_norm` (lowercased, used for every comparison and lookup).
 */

import {
  basename as bunBasename,
  dirname as bunDirname,
  extname as bunExtname,
} from "node:path";

/** Lowercase + normalise separators. The journal's lookup key. */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** The final component of a path (`/a/b/c.mkv` -> `c.mkv`). */
export function basename(p: string): string {
  return bunBasename(p);
}

/** Everything above the final component (`/a/b/c.mkv` -> `/a/b`). */
export function dirname(p: string): string {
  return bunDirname(p);
}

/** The extension including the dot, lowercased (`.MKV`). */
export function extname(p: string): string {
  return bunExtname(p).toLowerCase();
}

/**
 * Resolve `rel` under `root` and refuse anything that escapes it.
 *
 * This is the guard that makes "never delete outside dest_root" enforceable
 * rather than aspirational: a `..` in the path or a symlink pointing outward
 * aborts before a single byte moves.
 */
export function resolveInside(root: string, rel: string): string | null {
  if (rel.includes("\0")) return null;
  const rootAbs = root.replace(/\/+$/, "");
  const combined = rel.startsWith("/") ? rel : `${rootAbs}/${rel}`;

  // Normalise `.`/`..` lexically — no filesystem access, so a symlink can't lie.
  const out: string[] = [];
  for (const seg of combined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null; // escaped the root
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const resolved = `/${out.join("/")}`;
  if (resolved !== rootAbs && !resolved.startsWith(`${rootAbs}/`)) return null;
  return resolved;
}

/** Truncate a long name in the middle so the extension and release tag survive. */
export function truncateMiddle(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  if (s.length <= max) return s;
  const keep = max - 1; // room for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(s.length - tail) : ""}`;
}

/** Render a byte count the way a human reads it. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Render a duration in seconds as `mm:ss` / `h:mm:ss`, or an em dash if unknown. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** Format a rate in bytes/sec as MB/s. */
export function formatRate(bytesPerSecond: number | null): string {
  if (
    bytesPerSecond === null ||
    !Number.isFinite(bytesPerSecond) ||
    bytesPerSecond <= 0
  ) {
    return "—";
  }
  return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;
}
