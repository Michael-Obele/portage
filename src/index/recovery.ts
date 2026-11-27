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
 *     The journal claims proof the drive cannot corroborate. A destination that
 *     cannot be read is listed as `unreadable` and the row is left alone.
 *  3. A partial in `.portage/partial/` with no matching row is reported, never
 *     adopted blindly — it may belong to a run from a different machine.
 *  4. A run still marked `running` is closed as `interrupted`.
 */

import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";

import {
  diskSpaceAsync,
  readMount,
  type MountState,
} from "#lib/util/fs.ts";
import {
  PROBE_TIMEOUT_MS,
  probe,
  statDrive,
  type ProbeResult,
} from "#lib/util/probe.ts";
import type { SpawnFn } from "#lib/util/spawn.ts";
import type { Journal } from "#lib/index/journal.ts";

export interface RecoveryReport {
  /** Transfer rows moved out of a live state by reconciliation. */
  interrupted: number;
  /** `verified` rows whose destination file is gone. */
  missing: number;
  /** Partial files with no journal row. */
  orphanPartials: string[];
  /** Paths whose stat got no answer. Not missing: nothing was concluded. */
  unreadable: string[];
  /** Runs left in `running` from a previous process. */
  staleRuns: number;
  notes: string[];
}

const EMPTY_REPORT: RecoveryReport = {
  interrupted: 0,
  missing: 0,
  orphanPartials: [],
  unreadable: [],
  staleRuns: 0,
  notes: [],
};

export async function reconcile(
  journal: Journal,
  partialDir: string,
  root: string,
): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    ...EMPTY_REPORT,
    orphanPartials: [],
    unreadable: [],
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
    const stat = await statDrive(root, row.dest_path);
    if (stat.kind === "unreadable") {
      // Unknown is not missing: the row keeps its proof until a read answers.
      report.unreadable.push(row.dest_path);
    } else if (stat.kind === "missing") {
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
      const stat = await statDrive(root, full);
      if (stat.kind === "unreadable") report.unreadable.push(full);
      if (stat.kind !== "ok") continue;
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
  /** `unreadable` means a read got no answer; the drive is not judged. */
  status: "ok" | "refused" | "unreadable";
  reason?: string;
  fix?: string;
  freeBytes: number;
  totalBytes: number;
  usedFraction: number;
}

export interface DestinationProbe {
  mount: MountState;
  space:
    | { kind: "ok"; free: number; total: number }
    | { kind: "unreadable"; reason: string };
}

/** EH-13. */
export const DESTINATION_UNREADABLE =
  "the destination could not be read; nothing was changed";

/**
 * True when a mount's option list carries the `ro` flag.
 *
 * Matching `ro` as a substring is wrong: `errors=remount-ro` is an option on
 * ordinary read-write ext4 mounts, and it made every destination on such a
 * filesystem look read-only. Split on commas and compare whole tokens.
 */
export function isReadOnlyMount(options: string): boolean {
  return options.split(",").some((option) => option.trim() === "ro");
}

/** Two reads, each under its own deadline. Decides nothing. */
export async function probeDestination(
  spawn: SpawnFn,
  destRoot: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<DestinationProbe> {
  const [mount, space] = await Promise.all([
    probe(destRoot, "findmnt", () => readMount(spawn, destRoot, timeoutMs), timeoutMs),
    probe(destRoot, "df", () => diskSpaceAsync(spawn, destRoot, timeoutMs), timeoutMs),
  ]);
  return {
    mount:
      mount.kind === "ok"
        ? mount.value
        : { kind: "unreadable", reason: unreadableReason(mount) },
    space:
      space.kind === "ok" && space.value !== null
        ? { kind: "ok", free: space.value.free, total: space.value.total }
        : { kind: "unreadable", reason: unreadableReason(space) },
  };
}

function unreadableReason(result: ProbeResult<unknown>): string {
  if (result.kind === "unreadable") {
    return result.reason === "timeout" ? "timeout" : result.message;
  }
  return result.kind === "ok" ? "no reading" : "missing";
}

const unreadable = (): DestinationCheck => ({
  ok: false,
  status: "unreadable",
  reason: DESTINATION_UNREADABLE,
  freeBytes: 0,
  totalBytes: 0,
  usedFraction: 0,
});

/** Pure: judges what `probeDestination` read, and reads nothing itself. */
export function judgeDestination(
  read: DestinationProbe,
  plannedBytes: number,
  headroom: number,
  destRoot = "",
): DestinationCheck {
  if (read.mount.kind === "unreadable") return unreadable();

  if (read.mount.kind === "not-mounted") {
    return {
      ok: false,
      status: "refused",
      reason: `destination is not on a mounted filesystem: ${destRoot}`,
      fix: `mount the drive, or set dest_root with: portage config set dest_root <path>`,
      freeBytes: 0,
      totalBytes: 0,
      usedFraction: 0,
    };
  }

  // R2.14: an unmounted drive's folder sits on the system disk, and findmnt
  // then reports the parent filesystem. Never copy there.
  if (read.mount.target === "/") {
    return {
      ok: false,
      status: "refused",
      reason: "the archive drive is not mounted",
      fix: "mount the drive, or set dest_root with: portage config set dest_root <path>",
      freeBytes: 0,
      totalBytes: 0,
      usedFraction: 0,
    };
  }

  if (isReadOnlyMount(read.mount.options)) {
    return {
      ok: false,
      status: "refused",
      reason: `destination is mounted read-only (NTFS dirty bit?): ${destRoot}`,
      fix: "unmount, then run `sudo ntfsfix /dev/<partition>` — or cleanly eject the drive from Windows first",
      freeBytes: 0,
      totalBytes: 0,
      usedFraction: 0,
    };
  }

  if (read.space.kind === "unreadable") return unreadable();

  const { free, total } = read.space;
  // The headroom is a margin for the bytes this run is about to write. A plan
  // that moves nothing writes nothing, so it needs no margin — without this,
  // `0 > free - reserve` refused an EMPTY plan on any drive with less free
  // space than the reserve (2 % of 2 TB is 40 GB).
  const reserve = plannedBytes > 0 ? Math.ceil(total * headroom) : 0;
  const usable = free - reserve;

  if (plannedBytes > usable) {
    const short = plannedBytes - usable;
    return {
      ok: false,
      status: "refused",
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
    status: "ok",
    freeBytes: free,
    totalBytes: total,
    usedFraction: total > 0 ? 1 - free / total : 0,
  };
}

/** The probe, then the judgement. The plan and run paths call the halves. */
export async function checkDestination(
  spawn: SpawnFn,
  destRoot: string,
  plannedBytes: number,
  headroom: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<DestinationCheck> {
  const read = await probeDestination(spawn, destRoot, timeoutMs);
  return judgeDestination(read, plannedBytes, headroom, destRoot);
}
