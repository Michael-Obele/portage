/**
 * Crash recovery.
 *
 * Portage reconciles on **every** run, before it does anything else. A tool
 * that only notices corruption when a transfer fails is a tool that will, at
 * some point, tell you a file is fine when it is half a season old.
 *
 * The rules, in the order they are applied:
 *
 *  1. A row left in `copying` means the process died mid-transfer. That is
 *     `failed(reason=interrupted)` — never silently resumed, because "was it
 *     half-written or complete?" is exactly the question the verify gate exists
 *     to answer.
 *  2. A `verified` row whose destination is gone from disk is `failed(missing)`.
 *     The journal claims proof the drive cannot corroborate.
 *  3. A partial in `.portage/partial/` with no matching row is reported, never
 *     adopted blindly — it may belong to a run from a different machine.
 *  4. A run still marked `running` is closed as `interrupted`.
 */

import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";

import { diskSpace } from "../util/fs.ts";
import { statSyncSafe } from "../util/fs.ts";
import type { Journal } from "./journal.ts";

export interface RecoveryReport {
  /** Transfer rows moved out of a live state by reconciliation. */
  interrupted: number;
  /** `verified` rows whose destination file is gone. */
  missing: number;
  /** Partial files with no journal row. */
  orphanPartials: string[];
  /** Runs left in `running` from a previous process. */
  staleRuns: number;
  notes: string[];
}

const EMPTY_REPORT: RecoveryReport = {
  interrupted: 0,
  missing: 0,
  orphanPartials: [],
  staleRuns: 0,
  notes: [],
};

export async function reconcile(
  journal: Journal,
  partialDir: string,
): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    ...EMPTY_REPORT,
    orphanPartials: [],
    notes: [],
  };

  // --- 1. rows stuck in a live state ----------------------------------------
  for (const row of journal.listActive()) {
    if (row.state !== "copying") continue;
    journal.setState(
      row.id,
      "failed",
      "interrupted: process exited mid-transfer",
    );
    report.interrupted++;
  }

  // --- 2. runs left open ----------------------------------------------------
  for (const run of journal.listRuns(50)) {
    if (run.status === "running") {
      journal.finishRun(run.id, "interrupted");
      report.staleRuns++;
    }
  }

  // --- 3. verified rows whose destination vanished ---------------------------
  // `done` is exempt on purpose: it means the file was also removed from the
  // phone, and a missing `done` row is usually a user deletion, not a failure.
  for (const row of journal.listActive()) {
    if (row.state !== "verified") continue;
    const stat = statSyncSafe(row.dest_path);
    if (!stat) {
      journal.setState(
        row.id,
        "failed",
        "missing: destination not found on the drive",
      );
      report.missing++;
    }
  }

  // --- 4. partials with no row ----------------------------------------------
  try {
    const entries = await readdir(partialDir);
    const known = new Set(
      journal.listActive().map((r) => basename(r.dest_path)),
    );

    for (const entry of entries) {
      const full = join(partialDir, entry);
      if (!statSyncSafe(full)) continue;
      // A partial is a flat file on the adb path and a directory per file on
      // the rsync fallback path; the name is the entry either way.
      if (known.has(entry)) continue;
      report.orphanPartials.push(full);
    }

    if (report.orphanPartials.length > 0) {
      report.notes.push(
        `${report.orphanPartials.length} partial file(s) in .portage/partial have no journal row — ` +
          `they may belong to another machine. Inspect before deleting.`,
      );
    }
  } catch {
    // No partial dir yet — a fresh drive. Nothing to reconcile.
  }

  if (report.interrupted || report.missing || report.staleRuns) {
    journal.event("warn", "journal reconciled on startup", undefined, {
      interrupted: report.interrupted,
      missing: report.missing,
      staleRuns: report.staleRuns,
    });
  }

  return report;
}

/**
 * Pre-flight check on the destination, run before a single byte moves.
 *
 * A read-only NTFS mount is the classic failure here: Windows left the dirty
 * bit set, Linux mounted the volume `ro`, and everything *looks* fine until the
 * first write fails 8 GB in.
 */
export interface DestinationCheck {
  ok: boolean;
  reason?: string;
  fix?: string;
  freeBytes: number;
  totalBytes: number;
  usedFraction: number;
}

export function checkDestination(
  destRoot: string,
  plannedBytes: number,
  headroom: number,
): DestinationCheck {
  const probe = Bun.spawnSync(
    ["findmnt", "-no", "OPTIONS", "--target", destRoot],
    {
      stderr: "ignore",
    },
  );
  const options = probe.exitCode === 0 ? probe.stdout.toString().trim() : "";

  if (probe.exitCode !== 0) {
    return {
      ok: false,
      reason: `destination is not on a mounted filesystem: ${destRoot}`,
      fix: `mount the drive, or set dest_root with: portage config set dest_root <path>`,
      freeBytes: 0,
      totalBytes: 0,
      usedFraction: 0,
    };
  }

  if (options.includes("ro,") || options === "ro") {
    return {
      ok: false,
      reason: `destination is mounted read-only (NTFS dirty bit?): ${destRoot}`,
      fix: "unmount, then run `sudo ntfsfix /dev/<partition>` — or cleanly eject the drive from Windows first",
      freeBytes: 0,
      totalBytes: 0,
      usedFraction: 0,
    };
  }

  const space = diskSpace(destRoot);
  if (!space) {
    return {
      ok: false,
      reason: `cannot read free space on ${destRoot}`,
      fix: "check the drive is healthy: portage doctor",
      freeBytes: 0,
      totalBytes: 0,
      usedFraction: 0,
    };
  }

  const { free, total } = space;
  const reserve = Math.ceil(total * headroom);
  const usable = free - reserve;

  if (plannedBytes > usable) {
    const short = plannedBytes - usable;
    return {
      ok: false,
      reason:
        `not enough space: need ${plannedBytes} bytes, ` +
        `${usable} usable (${free} free − ${reserve} headroom) — short by ${short}`,
      fix: "free space, or reclaim with: portage dupes",
      freeBytes: free,
      totalBytes: total,
      usedFraction: total > 0 ? 1 - free / total : 0,
    };
  }

  return {
    ok: true,
    freeBytes: free,
    totalBytes: total,
    usedFraction: total > 0 ? 1 - free / total : 0,
  };
}
