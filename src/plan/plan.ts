/**
 * Planning: the read-only answer to "what would `pull` actually do?"
 *
 * `plan` exists because the most expensive mistake in this workflow is copying
 * 6.8 GB you already have. On the first real job the phone's Higehiro S1 had
 * **17 of 23 episodes already on the drive** — the correct job was 6 files, not
 * 23. A plan that shows the byte total and the reason each file is in or out
 * turns that from a surprise into a fact.
 */

import { join, dirname } from "node:path";

import type { Journal } from "../index/journal.ts";
import type { Candidate } from "../scan/scan.ts";
import { checkDestination, type DestinationCheck } from "../index/recovery.ts";
import { formatBytes, formatDuration, normPath } from "../util/paths.ts";

export interface PlannedFile {
  candidate: Candidate;
  /** Final path on the drive. */
  destPath: string;
  destNorm: string;
  /** Null when nothing on the drive looks like this file. */
  matchesArchive?: ArchiveHit | null;
  /** True when the file is already in the journal as verified/done. */
  alreadyTransferred: boolean;
  /** Why this file is not being transferred, when it is not. */
  skipReason?: string;
  /** Bytes this file would add (0 when it is a skip). */
  bytes: number;
}

export interface ArchiveHit {
  path: string;
  size: number;
  hash: string | null;
  /** "identical" when size and hash match; "collision" when only the name matches. */
  relation: "identical" | "same-size" | "collision";
  note: string;
}

export interface PlanResult {
  destRoot: string;
  files: PlannedFile[];
  /** Files that would actually be transferred. */
  toTransfer: PlannedFile[];
  /** Files we already have — the whole point of the plan. */
  skipped: PlannedFile[];
  bytesTotal: number;
  bytesSkipped: number;
  fileCount: number;
  /** Null when there is not enough throughput history to be honest about it. */
  etaSeconds: number | null;
  space: DestinationCheck;
  warnings: string[];
}

export interface PlanOptions {
  destRoot: string;
  journal: Journal;
  spaceHeadroom: number;
  /** Bytes/sec from a previous run, for the ETA. Null means "unknown". */
  rateBps?: number | null;
  /** Only plan files matching this show name (case-insensitive substring). */
  show?: string;
  /** Only files whose relative path is newer than this many seconds. */
  sinceSeconds?: number;
}

/**
 * Build the plan.
 *
 * Every file gets a destination whether or not it will be transferred — the
 * whole value of `plan` is seeing the *full* picture, including what is being
 * skipped and why.
 */
export function buildPlan(
  candidates: Candidate[],
  opts: PlanOptions,
): PlanResult {
  const warnings: string[] = [];
  const files: PlannedFile[] = [];
  const nowSeconds = Date.now() / 1000;

  for (const candidate of candidates) {
    if (
      opts.show &&
      !candidate.srcPath.toLowerCase().includes(opts.show.toLowerCase())
    ) {
      continue;
    }
    if (
      opts.sinceSeconds !== undefined &&
      nowSeconds - candidate.mtime > opts.sinceSeconds
    ) {
      continue;
    }

    const destPath = join(opts.destRoot, candidate.relative);
    const destNorm = normPath(destPath);

    // An ineligible file is still *shown* — "why was this skipped?" is the
    // question `plan` exists to answer — but it must never be queued.
    if (
      candidate.verdict !== "new" &&
      candidate.verdict !== "duplicate-candidate"
    ) {
      files.push({
        candidate,
        destPath,
        destNorm,
        alreadyTransferred: false,
        skipReason: candidate.reason,
        bytes: 0,
      });
      continue;
    }

    const priorTransfer = opts.journal.findTransfer(
      candidate.deviceId,
      candidate.srcPath,
      candidate.size,
      candidate.mtime,
    );
    const alreadyTransferred =
      priorTransfer !== null &&
      (priorTransfer.state === "done" ||
        priorTransfer.state === "verified" ||
        priorTransfer.state === "source_deleted");

    const archiveHit = matchArchive(opts.journal, destNorm, candidate.size);
    if (archiveHit) warnings.push(archiveHit.note);

    // A file is only worth transferring bytes for when we do not already have
    // it. Everything else is free to skip — and skipping is the feature.
    const skip = alreadyTransferred || archiveHit?.relation === "identical";

    files.push({
      candidate,
      destPath,
      destNorm,
      matchesArchive: archiveHit,
      alreadyTransferred,
      skipReason: skip
        ? alreadyTransferred
          ? "already transferred and verified in an earlier run"
          : "identical content is already on the drive"
        : undefined,
      bytes: skip ? 0 : candidate.size,
    });
  }

  const toTransfer = files.filter((f) => f.bytes > 0);
  const skipped = files.filter((f) => f.bytes === 0);

  const bytesTotal = toTransfer.reduce((sum, f) => sum + f.bytes, 0);
  const bytesSkipped = skipped.reduce((sum, f) => sum + f.candidate.size, 0);

  // An ETA built on one sample is a lie told with confidence. Say nothing
  // instead of saying something wrong.
  const rate = opts.rateBps ?? null;
  const etaSeconds =
    rate && rate > 0 && bytesTotal > 0 ? bytesTotal / rate : null;

  const space = checkDestination(opts.destRoot, bytesTotal, opts.spaceHeadroom);
  if (!space.ok) warnings.push(space.reason ?? "");

  return {
    destRoot: opts.destRoot,
    files,
    toTransfer,
    skipped,
    bytesTotal,
    bytesSkipped,
    fileCount: toTransfer.length,
    etaSeconds,
    space,
    warnings: warnings.filter(Boolean),
  };
}

/**
 * Compare a candidate against the archive.
 *
 * Size alone is never enough to call something a duplicate — two different
 * episodes from the same encode can share a size exactly. So:
 *
 *   - archive has the same normalised path and a stored hash → we can prove it
 *   - archive has the same normalised path but a different size → a *collision*,
 *     a re-download of the same name that is a different file. Never overwrite.
 *   - archive has the same size and no path match → a candidate only
 */
function matchArchive(
  journal: Journal,
  destNorm: string,
  size: number,
): ArchiveHit | null {
  const byPath = journal.findArchive(destNorm);
  if (byPath) {
    if (byPath.size === size) {
      return {
        path: byPath.path,
        size: byPath.size,
        hash: byPath.hash,
        relation: "identical",
        note: "",
      };
    }
    return {
      path: byPath.path,
      size: byPath.size,
      hash: byPath.hash,
      relation: "collision",
      note:
        `collision: ${byPath.path} already exists with a different size ` +
        `(${byPath.size} on the drive, ${size} on the phone) — will not overwrite`,
    };
  }

  const sameSize = journal.archiveBySize(size);
  if (sameSize.length > 0) {
    const hit = sameSize[0];
    if (!hit) return null;
    return {
      path: hit.path,
      size: hit.size,
      hash: hit.hash,
      relation: "same-size",
      note: "",
    };
  }

  return null;
}

/** One-line summary for the TUI header and `--plain`. */
export function planSummary(plan: PlanResult): string {
  const parts = [
    `${plan.fileCount} file${plan.fileCount === 1 ? "" : "s"}`,
    formatBytes(plan.bytesTotal),
    `ETA ${formatDuration(plan.etaSeconds)}`,
  ];
  if (plan.skipped.length > 0) {
    parts.push(
      `${plan.skipped.length} already on the drive (${formatBytes(plan.bytesSkipped)})`,
    );
  }
  return parts.join(" · ");
}

/** Destination directory for a file — used to create the tree before pulling. */
export function destDirFor(destPath: string): string {
  return dirname(destPath);
}
