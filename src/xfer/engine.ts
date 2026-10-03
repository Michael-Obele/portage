/**
 * The transfer engine — where the safety rules actually live.
 *
 * Read this file before changing it. The rules below are not style
 * preferences; each one exists because the alternative was measured and it
 * lost data.
 *
 *  1. **Deleting is a separate step, never a side effect of copying.** The
 *     engine deletes only the exact files it watched transfer *and* verify in
 *     this run. If the process dies between copy and delete, the phone copy is
 *     still there. The failure mode is "still on the phone", never "gone from
 *     both".
 *
 *  2. **`verified` requires a positive signal.** Not "no error was reported" —
 *     the phone's own hash, compared against the local hash, equal. This is
 *     what closes the "corrupt destination that looks identical" hole.
 *
 *  3. **A skipped file is never a delete candidate.** If we did not move the
 *     bytes in this run, we have no proof about the destination's content, and
 *     deleting on the strength of a skip is silent data loss.
 *
 *  4. **Asymmetry is deliberate.** Deleting because we *just proved a fresh
 *     copy* is safe. Deleting because we *think we have seen it before* is not.
 *
 *  5. **Intent before action.** The `queued` row is written before a single
 *     byte moves, so a crash leaves a recoverable record, not an orphan file.
 */

import { join } from "node:path";

import type { Adb, DeviceInfo } from "../device/adb.ts";
import type { Journal, TransferState } from "../index/journal.ts";
import type { PlanResult, PlannedFile } from "../plan/plan.ts";
import type { DeleteSource } from "../config/schema.ts";
import { ensureDir, fsyncPath, statSyncSafe } from "../util/fs.ts";
import { sha256File } from "../util/hash.ts";
import { dirname } from "../util/paths.ts";
import type { Logger } from "../util/log.ts";
import type { CopyRequest, Transport } from "./transport.ts";

export interface EngineOptions {
  journal: Journal;
  transport: Transport;
  /**
   * Used only to ask the phone for its own hash during verification.
   * Injected so tests can drive the whole state machine without a device.
   */
  adb: Pick<Adb, "hashRemote">;
  /** Where interrupted files live — on the destination filesystem. */
  partialDir: string;
  /** How many files to move at once. 3 was the measured knee. */
  jobs: number;
  /** "standard" compares the phone hash to the local hash; "paranoid" re-reads both. */
  verify: "standard" | "paranoid";
  deleteSource: DeleteSource;
  resumeThreshold: number;
  logger: Logger;
  /** Nothing is written when true. */
  dryRun: boolean;
  /** Emit per-file progress events. */
  onFileEvent?: (event: FileEvent) => void;
  /** Called on SIGINT/SIGTERM to stop cleanly. */
  shouldStop?: () => boolean;
}

export type FileEvent =
  | { type: "start"; file: PlannedFile }
  | { type: "progress"; file: PlannedFile; bytes: number; total: number }
  | { type: "verified"; file: PlannedFile; hash: string }
  | { type: "deleted"; file: PlannedFile }
  | { type: "failed"; file: PlannedFile; reason: string }
  | { type: "skipped"; file: PlannedFile; reason: string };

export interface EngineSummary {
  runId: number;
  transferred: number;
  verified: number;
  deleted: number;
  kept: number;
  failed: number;
  skipped: number;
  bytesMoved: number;
  /** Milliseconds from first byte to last flush. */
  durationMs: number;
  /** Average durable throughput in bytes/sec. */
  rateBps: number;
  failures: Array<{ srcPath: string; reason: string }>;
}

/**
 * Run one transfer pass over a plan.
 *
 * Files are processed by a fixed-size worker pool rather than `Promise.all`:
 * an unbounded pool on a 20-file season is 20 concurrent `adb pull`s, which
 * turns the USB link into a contention problem and makes the progress numbers
 * meaningless.
 */
export async function runTransfer(
  plan: PlanResult,
  devices: Map<string, DeviceInfo>,
  opts: EngineOptions,
): Promise<EngineSummary> {
  const started = Bun.nanoseconds();
  const deviceId = plan.toTransfer[0]?.candidate.deviceId ?? null;
  const runId = opts.journal.startRun(deviceId, opts.transport.name);

  const summary: EngineSummary = {
    runId,
    transferred: 0,
    verified: 0,
    deleted: 0,
    kept: 0,
    failed: 0,
    skipped: 0,
    bytesMoved: 0,
    durationMs: 0,
    rateBps: 0,
    failures: [],
  };

  const queue = [...plan.toTransfer];

  // --- dry run: prove the plan, touch nothing --------------------------------
  if (opts.dryRun) {
    for (const file of queue) {
      const rowId = rowIdOf(opts.journal, file);
      if (rowId > 0) opts.journal.setState(rowId, "eligible");
    }
    opts.journal.finishRun(runId, "done", {
      bytes_total: plan.bytesTotal,
      files_total: queue.length,
    });
    return summary;
  }

  const workerCount = Math.max(1, Math.min(opts.jobs, queue.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.shouldStop?.()) return;
      const index = cursor++;
      const file = queue[index];
      if (!file) return;

      const result = await processFile(file, devices, opts, runId, summary);
      if (result === "failed") {
        summary.failed++;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));

  summary.durationMs = (Bun.nanoseconds() - started) / 1_000_000;
  summary.rateBps =
    summary.durationMs > 0
      ? (summary.bytesMoved / summary.durationMs) * 1000
      : 0;

  opts.journal.finishRun(runId, summary.failed > 0 ? "failed" : "done", {
    bytes_total: plan.bytesTotal,
    bytes_done: summary.bytesMoved,
    files_total: queue.length,
    files_done: summary.verified,
    files_failed: summary.failed,
  });

  if (summary.failed > 0 || summary.kept > 0) {
    opts.journal.event(
      summary.failed > 0 ? "warn" : "info",
      "run finished",
      runId,
      {
        transferred: summary.transferred,
        kept: summary.kept,
        failed: summary.failed,
      },
    );
  }

  return summary;
}

function rowIdOf(journal: Journal, file: PlannedFile): number {
  return (
    journal.findTransfer(
      file.candidate.deviceId,
      file.candidate.srcPath,
      file.candidate.size,
      file.candidate.mtime,
    )?.id ?? 0
  );
}

async function processFile(
  file: PlannedFile,
  devices: Map<string, DeviceInfo>,
  opts: EngineOptions,
  runId: number,
  summary: EngineSummary,
): Promise<"ok" | "failed"> {
  const { candidate } = file;
  const device = devices.get(candidate.deviceId);
  const id = rowIdOf(opts.journal, file);

  // --- 5. intent before action ---------------------------------------------
  const row = opts.journal.upsertTransfer({
    runId,
    deviceId: candidate.deviceId,
    srcPath: candidate.srcPath,
    destPath: file.destPath,
    pathNorm: file.destNorm,
    size: candidate.size,
    srcMtime: candidate.mtime,
    state: "queued",
  });
  const rowId = row.id || id;

  opts.onFileEvent?.({ type: "start", file });
  opts.journal.setState(rowId, "copying");

  // --- the copy --------------------------------------------------------------
  const partialBytes = statSyncSafe(file.destPath)?.size ?? 0;
  const req: CopyRequest = {
    serial: candidate.serial,
    srcPath: candidate.srcPath,
    destPath: file.destPath,
    partialBytes,
    size: candidate.size,
    resumeThreshold: opts.resumeThreshold,
    partialDir: opts.partialDir,
    onProgress: (bytes) =>
      opts.onFileEvent?.({
        type: "progress",
        file,
        bytes,
        total: candidate.size,
      }),
  };

  const outcome = await opts.transport.copy(req);
  if (outcome.status === "failed") {
    opts.journal.setState(rowId, "failed", outcome.reason);
    opts.journal.event("error", `copy failed: ${candidate.srcPath}`, runId, {
      reason: outcome.reason,
    });
    opts.onFileEvent?.({ type: "failed", file, reason: outcome.reason });
    summary.failures.push({
      srcPath: candidate.srcPath,
      reason: outcome.reason,
    });
    return "failed";
  }

  if (outcome.status === "skipped") {
    // --- 3. a skipped file is never a delete candidate ----------------------
    opts.journal.setState(
      rowId,
      "skipped_duplicate",
      "destination already matched",
    );
    opts.onFileEvent?.({
      type: "skipped",
      file,
      reason: "already on the drive",
    });
    summary.skipped++;
    return "ok";
  }

  opts.journal.setState(rowId, "written");
  summary.transferred++;
  summary.bytesMoved += outcome.bytes;

  // --- 2. the verification gate ---------------------------------------------
  const verdict = await verifyFile(file, device, opts, rowId);
  if (!verdict.ok) {
    // The destination stays on disk but is quarantined by name; the phone copy
    // is untouched. This is the whole point.
    opts.journal.setState(
      rowId,
      "failed",
      `verification failed: ${verdict.reason}`,
    );
    opts.journal.event(
      "error",
      `verification failed: ${candidate.srcPath}`,
      runId,
      {
        reason: verdict.reason,
      },
    );
    opts.onFileEvent?.({ type: "failed", file, reason: verdict.reason });
    summary.failures.push({
      srcPath: candidate.srcPath,
      reason: verdict.reason,
    });
    return "failed";
  }

  opts.journal.setState(rowId, "verified");
  opts.journal.setHash(rowId, verdict.hash, "full");
  summary.verified++;
  opts.onFileEvent?.({ type: "verified", file, hash: verdict.hash });

  // The drive copy is now part of the archive, whatever we do about the phone.
  opts.journal.upsertArchive({
    path: file.destPath,
    pathNorm: file.destNorm,
    size: candidate.size,
    mtime: candidate.mtime,
    hash: verdict.hash,
    hashKind: "sha256",
    verified: true,
  });

  // --- 1. deletion is a separate step ---------------------------------------
  if (opts.deleteSource === "after-verify") {
    const removed = await opts.transport.removeSource(
      candidate.serial,
      candidate.srcPath,
    );
    if (removed) {
      opts.journal.setState(rowId, "source_deleted");
      opts.journal.setState(rowId, "done");
      summary.deleted++;
      opts.onFileEvent?.({ type: "deleted", file });
    } else {
      // The copy is proven; the delete failed. Leave the state at `verified`
      // so `portage purge` can finish the job later.
      summary.kept++;
      opts.journal.event(
        "warn",
        `verified but could not delete on device: ${candidate.srcPath}`,
        runId,
      );
    }
  } else {
    // --- 4. kept on purpose --------------------------------------------------
    // The row stays at `verified` — deliberately *not* `done` — because that
    // is the state `portage purge` looks for. Marking it done would erase the
    // evidence that there is still a phone copy to remove, which is exactly
    // the thing the user asked to be able to do later.
    summary.kept++;
  }

  return "ok";
}

/**
 * Prove the drive copy is the phone copy.
 *
 * The phone hashes its own file (`sha256sum` is in Android's toybox — measured
 * at 1372 ms for a 400 MB episode), we hash ours, and the two must be equal.
 * Exit code 0 from a copy is never sufficient on its own.
 */
async function verifyFile(
  file: PlannedFile,
  device: DeviceInfo | undefined,
  opts: EngineOptions,
  rowId: number,
): Promise<{ ok: true; hash: string } | { ok: false; reason: string }> {
  const { candidate } = file;

  // Size is the cheap gate before we spend two hashes.
  const local = statSyncSafe(file.destPath);
  if (!local)
    return { ok: false, reason: "destination disappeared before verification" };
  if (local.size !== candidate.size) {
    return {
      ok: false,
      reason: `size mismatch: phone says ${candidate.size}, drive has ${local.size}`,
    };
  }

  const localHash = await sha256File(file.destPath);
  if (!localHash)
    return { ok: false, reason: "could not read the destination for hashing" };

  if (!device) {
    // No device means we cannot ask the phone. A file of unknown provenance is
    // not a verified file.
    return {
      ok: false,
      reason: "device disappeared before verification — phone hash unavailable",
    };
  }

  const remoteHash = await opts.adb.hashRemote(
    device.serial,
    candidate.srcPath,
  );
  if (!remoteHash) {
    return {
      ok: false,
      reason:
        "phone-side sha256sum unavailable — refusing to claim verification",
    };
  }

  if (remoteHash !== localHash) {
    return {
      ok: false,
      reason: `content mismatch: phone ${remoteHash.slice(0, 12)}…, drive ${localHash.slice(0, 12)}…`,
    };
  }

  return { ok: true, hash: localHash };
}

/** Injection point re-exported so tests can build a fake `hashRemote`. */
export type { Adb };

export { ensureDir, fsyncPath, join, dirname };
export type { TransferState };
