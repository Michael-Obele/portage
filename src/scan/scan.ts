/**
 * Scanning: what is on the phone, and which of it we are willing to touch.
 *
 * Scanning is strictly read-only. Nothing in this file mutates a device — the
 * one and only deletion path is the explicit step in the transfer engine, after
 * a file has been verified.
 *
 * The eligibility rules exist because of one specific failure: a half-written
 * episode that gets "successfully copied" and then deleted. Three cheap checks
 * make that impossible.
 */

import {
  ALWAYS_EXCLUDED_DIRS,
  IN_FLIGHT_SUFFIXES,
  type DeviceConfig,
} from "../config/schema.ts";
import type { Adb, DeviceFile, DeviceInfo } from "../device/adb.ts";
import { basename, extname } from "../util/paths.ts";

/** Why a file is or isn't a candidate. Shown verbatim by `scan` and `plan`. */
export type Verdict =
  | "new"
  | "already-on-drive"
  | "too-recent"
  | "excluded"
  | "in-flight"
  | "duplicate-candidate"
  | "empty";

export interface Candidate {
  deviceId: string;
  deviceLabel: string;
  serial: string;
  /** Device-side path. */
  srcPath: string;
  /** Where the configured root this file was found under starts. */
  root: string;
  /** Path relative to that root — this is what is preserved on the drive. */
  relative: string;
  size: number;
  /** Seconds since epoch. */
  mtime: number;
  verdict: Verdict;
  reason: string;
}

export interface ScanOptions {
  quietSeconds: number;
  deviceConfig?: DeviceConfig;
  /** Journal hits: normalised destination path -> true when we already have it. */
  knownDestNorms?: Set<string>;
  now?: number;
}

/**
 * Is this path inside one of the never-descend directories?
 *
 * Entries may be written as `Secret`, `/Secret/` or `Secret/` — the user
 * configures this by hand, so normalising here rather than demanding one
 * spelling is the difference between a rule that works and a rule that
 * silently does nothing.
 */
export function isAlwaysExcluded(path: string): boolean {
  return ALWAYS_EXCLUDED_DIRS.some((dir) => matchesExclude(path, dir));
}

/** True when `path` is inside the `entry` directory, any of the usual spellings. */
export function matchesExclude(path: string, entry: string): boolean {
  const clean = entry.replace(/^\/+|\/+$/g, "");
  if (!clean) return false;
  return path.includes(`/${clean}/`) || path.endsWith(`/${clean}`);
}

/**
 * Does the filename say "this download is still running"?
 *
 * `.crdownload` is Chrome, `.!ut` is the Android DownloadManager, `.part` is
 * the usual torrent client, `.opdownload` is Opera.
 */
export function looksInFlight(path: string): boolean {
  const lower = path.toLowerCase();
  return IN_FLIGHT_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Decide one file's verdict.
 *
 * Order matters: an excluded path is reported as excluded even if it is also
 * recent, because "why did you skip this?" deserves the most specific answer.
 */
export function classify(file: DeviceFile, opts: ScanOptions): Candidate {
  const now = opts.now ?? Date.now();
  const deviceConfig = opts.deviceConfig;
  const label = deviceConfig?.label ?? "";

  const base: Omit<Candidate, "verdict" | "reason"> = {
    deviceId: "",
    deviceLabel: label,
    serial: "",
    srcPath: file.path,
    root: "",
    relative: file.path.replace(/^\//, ""),
    size: file.size,
    mtime: file.mtime,
  };

  if (file.size === 0) {
    return { ...base, verdict: "empty", reason: "zero bytes" };
  }

  const excluded = [...ALWAYS_EXCLUDED_DIRS, ...(deviceConfig?.exclude ?? [])];
  if (excluded.some((dir) => matchesExclude(file.path, dir))) {
    return {
      ...base,
      verdict: "excluded",
      reason: "path is on the never-scan list",
    };
  }

  if (looksInFlight(file.path)) {
    return {
      ...base,
      verdict: "in-flight",
      reason: "filename marks it as an unfinished download",
    };
  }

  // A file whose mtime is within `quiet_seconds` of now is probably still
  // being written. This is the man-page warning made mechanical.
  const ageSeconds = now / 1000 - file.mtime;
  if (ageSeconds < opts.quietSeconds) {
    return {
      ...base,
      verdict: "too-recent",
      reason: `modified ${Math.max(0, Math.round(ageSeconds))}s ago — wait ${Math.round(opts.quietSeconds - ageSeconds)}s`,
    };
  }

  if (extname(file.path) === ".nomedia") {
    return { ...base, verdict: "excluded", reason: ".nomedia marker" };
  }

  return { ...base, verdict: "new", reason: "not on the drive yet" };
}

/**
 * Walk every configured root on one device and classify what comes back.
 *
 * One `find -printf` per root, not one round trip per file — on a phone with a
 * few hundred episodes the difference is between one adb call and hundreds.
 */
export async function scanDevice(
  adb: Adb,
  device: DeviceInfo,
  roots: string[],
  opts: ScanOptions,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const deviceConfig: DeviceConfig = {
    label: device.model || opts.deviceConfig?.label || "",
    roots: opts.deviceConfig?.roots ?? [],
    exclude: opts.deviceConfig?.exclude ?? [],
    jobs: opts.deviceConfig?.jobs,
  };

  for (const root of roots) {
    const files = await adb.walk(device.serial, root);
    for (const file of files) {
      if (isAlwaysExcluded(file.path)) continue;
      // A file outside the configured root is not ours to move. Without this,
      // a device whose roots point at two different trees would still produce
      // candidates from the other one, with a mangled destination path.
      if (!file.path.startsWith(root)) continue;

      const candidate = classify(file, { ...opts, deviceConfig });
      candidate.deviceId = device.id;
      candidate.deviceLabel =
        deviceConfig?.label || device.model || device.serial;
      candidate.serial = device.serial;
      candidate.root = root;
      // Preserve the phone's relative layout: this is the zero-surprise rule.
      // `/sdcard/Movies/Anime/Frieren/S01/ep.mkv` under root `/sdcard/Movies`
      // becomes `Anime/Frieren/S01/ep.mkv` on the drive.
      candidate.relative = file.path.startsWith(root)
        ? file.path.slice(root.length).replace(/^\//, "")
        : file.path.replace(/^\//, "");

      out.push(candidate);
    }
  }

  return out;
}

/** Only the files we are actually willing to move. */
export function eligible(candidates: Candidate[]): Candidate[] {
  return candidates.filter(
    (c) => c.verdict === "new" || c.verdict === "duplicate-candidate",
  );
}

/** Human summary of a scan, for the header line. */
export function summarise(candidates: Candidate[]): Record<Verdict, number> {
  const counts: Record<string, number> = {
    new: 0,
    "already-on-drive": 0,
    "too-recent": 0,
    excluded: 0,
    "in-flight": 0,
    "duplicate-candidate": 0,
    empty: 0,
  };
  for (const c of candidates) counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;
  return counts as Record<Verdict, number>;
}

export { basename };
