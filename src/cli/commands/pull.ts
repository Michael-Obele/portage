/**
 * `pull` — where the safety rules become behaviour.
 *
 * This is the command the whole tool exists for, so it is also the command
 * with the most explicit code: nothing here deletes a phone file except the one
 * branch that has already been handed a verified file, and that branch is
 * off unless `delete_source` says so.
 */

import { join } from "node:path";

import { Adb } from "../../device/adb.ts";
import type { DeviceInfo } from "../../device/adb.ts";
import type { ResolvedConfig } from "../../config/load.ts";
import { requireDestRoot } from "../../config/load.ts";
import { Journal } from "../../index/journal.ts";
import { reconcile, checkDestination } from "../../index/recovery.ts";
import { buildPlan } from "../../plan/plan.ts";
import { scanDevice, type Candidate } from "../../scan/scan.ts";
import { AdbTransport } from "../../xfer/adb.ts";
import { runTransfer, type FileEvent } from "../../xfer/engine.ts";
import { planPurge, applyPurge } from "../../xfer/purge.ts";
import { ensureStateDirs } from "../../util/fs.ts";
import { formatBytes, formatDuration, formatRate, truncateMiddle } from "../../util/paths.ts";
import type { Output } from "../../output/output.ts";
import { createLogger, type Logger } from "../../util/log.ts";
import { preconditionError, ExitCode } from "../../util/errors.ts";
import type { DeleteSource } from "../../config/schema.ts";

export interface PullContext {
  resolved: ResolvedConfig;
  adb: Adb | null;
  output: Output;
  deviceFilter?: string;
  show?: string;
  sinceSeconds?: number;
  dryRun: boolean;
  keepSource: boolean;
  deleteSource: boolean;
  /** Recompute both hashes during purge instead of trusting the journal. */
  verifyHash: boolean;
  jobs?: number;
  logger: Logger;
}

export async function pull(ctx: PullContext): Promise<number> {
  const { config } = ctx.resolved;
  const output = ctx.output;
  if (!ctx.adb) throw preconditionError("adb is not available");

  const destRoot = requireDestRoot(config);

  // --- delete mode resolution ------------------------------------------------
  // `--keep-source` and `--delete-source` are opposites; both together is a
  // contradiction the user should see rather than have silently resolved.
  if (ctx.keepSource && ctx.deleteSource) {
    throw preconditionError(
      "--keep-source and --delete-source cannot both be set",
      "pick one: --keep-source copies and leaves the phone alone, --delete-source copies then deletes",
    );
  }

  const deleteSource: DeleteSource = ctx.keepSource
    ? "never"
    : ctx.deleteSource
      ? "after-verify"
      : config.delete_source;

  const devices = await ctx.adb.devices();
  const ready = devices.filter((d) => d.state === "device");
  if (ready.length === 0) {
    throw preconditionError(
      "no device is attached and authorised",
      "plug in a phone, enable USB debugging, and accept the RSA prompt",
    );
  }

  const selected = ctx.deviceFilter
    ? ready.filter(
        (d) =>
          d.id.startsWith(ctx.deviceFilter!) ||
          d.serial === ctx.deviceFilter ||
          d.model.toLowerCase().includes(ctx.deviceFilter!.toLowerCase()),
      )
    : ready;
  if (selected.length === 0) {
    throw preconditionError(`no attached device matches "${ctx.deviceFilter}"`);
  }

  // --- state on the drive ----------------------------------------------------
  const { partial } = await ensureStateDirs(destRoot);
  const journal = Journal.open(destRoot, ctx.logger);

  try {
    const recovery = await reconcile(journal, partial);
    if (recovery.interrupted || recovery.missing) {
      output.warn(
        `recovered from a previous run: ${recovery.interrupted} interrupted, ${recovery.missing} missing`,
      );
    }
    for (const note of recovery.notes) output.bullet(note);

    // --- plan ----------------------------------------------------------------
    const candidates = await gather(ctx, selected);
    const planResult = buildPlan(candidates, {
      destRoot,
      journal,
      spaceHeadroom: config.space_headroom,
      show: ctx.show,
      sinceSeconds: ctx.sinceSeconds,
    });

    if (planResult.fileCount === 0) {
      if (output.mode === "json") {
        output.emitJson({ moved: 0, message: "nothing to transfer", plan: planResult });
      } else {
        output.ok("nothing to transfer — every eligible file is already on the drive");
        if (planResult.skipped.length > 0) {
          output.bullet(
            `${planResult.skipped.length} file(s) skipped, ${formatBytes(planResult.bytesSkipped)} already there`,
          );
        }
      }
      return 0;
    }

    const space = checkDestination(destRoot, planResult.bytesTotal, config.space_headroom);
    if (!space.ok) {
      output.fail(space.reason ?? "destination check failed");
      if (space.fix) output.bullet(`→ ${space.fix}`);
      return ExitCode.precondition;
    }

    if (ctx.dryRun) {
      output.heading("dry run — nothing will be written or deleted");
      output.kv("would transfer", `${planResult.fileCount} files · ${formatBytes(planResult.bytesTotal)}`);
      output.kv("would delete on phone", deleteSource === "after-verify" ? "yes, after verify" : "no");
      output.kv("would skip", `${planResult.skipped.length} files · ${formatBytes(planResult.bytesSkipped)}`);
      output.line();
      for (const f of planResult.toTransfer) {
        output.bullet(`${formatBytes(f.bytes).padStart(10)}  ${f.candidate.srcPath}`);
      }
      return 0;
    }

    // --- run ------------------------------------------------------------------
    const jobs = ctx.jobs ?? config.jobs;
    const transport = new AdbTransport(ctx.adb, (path) => {
      ctx.logger.debug(`partial below threshold — restarting ${path}`);
    });

    const deviceMap = new Map<string, DeviceInfo>(selected.map((d) => [d.id, d]));
    const started = Bun.nanoseconds();
    let lastLine = 0;

    const summary = await runTransfer(planResult, deviceMap, {
      journal,
      transport,
      adb: ctx.adb,
      partialDir: partial,
      jobs,
      verify: config.verify,
      deleteSource,
      resumeThreshold: config.resume_threshold,
      logger: ctx.logger,
      dryRun: false,
      shouldStop: () => stopped,
      onFileEvent: (event) => reportProgress(event, output, () => Bun.nanoseconds(), lastLine),
    });

    const elapsed = (Bun.nanoseconds() - started) / 1_000_000_000;

    if (output.mode === "json") {
      output.emitJson({
        moved: summary.verified,
        deleted_from_device: summary.deleted,
        kept_on_device: summary.kept,
        failed: summary.failed,
        skipped: summary.skipped,
        bytes: summary.bytesMoved,
        duration_seconds: elapsed,
        rate_bps: summary.rateBps,
        failures: summary.failures,
      });
    } else {
      output.line();
      output.heading("done");
      output.kv("verified", `${summary.verified} files · ${formatBytes(summary.bytesMoved)}`);
      output.kv("deleted on phone", String(summary.deleted));
      if (summary.kept > 0) {
        output.kv("kept on phone", `${summary.kept} — run \`portage purge\` when you want them gone`);
      }
      output.kv("elapsed", formatDuration(elapsed));
      output.kv("throughput", formatRate(summary.rateBps));
      for (const failure of summary.failures) output.fail(`${failure.srcPath} — ${failure.reason}`);
      if (summary.failed === 0) output.ok("every transferred file verified against the phone");
    }

    if (summary.failed > 0) return ExitCode.transfer;
    return 0;
  } finally {
    journal.close();
  }
}

/** Walk the selected devices and return the candidate list. */
async function gather(ctx: PullContext, devices: DeviceInfo[]): Promise<Candidate[]> {
  const { config } = ctx.resolved;
  if (!ctx.adb) throw preconditionError("adb is not available");

  const all: Candidate[] = [];
  for (const device of devices) {
    const deviceConfig = config.devices[device.id];
    const roots = deviceConfig?.roots ?? [];
    if (roots.length === 0) {
      // A device with no configured roots is not set up yet — not an error,
      // and definitely not a reason to start scanning all of /sdcard.
      ctx.logger.debug(`skipping ${device.model || device.serial}: no roots configured`);
      continue;
    }

    const found = await scanDevice(ctx.adb, device, roots, {
      quietSeconds: config.quiet_seconds,
      deviceConfig,
    });
    all.push(...found);
  }
  return all;
}

/**
 * Live per-file reporting on a plain terminal.
 *
 * A single rewritten line rather than a scrolling wall — the same rule the TUI
 * follows, because a `pull` you cannot read at a glance is a `pull` you will
 * run with `--plain` and then never look at.
 */
function reportProgress(
  event: FileEvent,
  output: Output,
  nowNs: () => number,
  lastLine: number,
): void {
  if (output.mode === "json") return;

  switch (event.type) {
    case "start": {
      output.line(`→ ${truncateMiddle(event.file.candidate.srcPath, 70)}`);
      break;
    }
    case "verified": {
      output.ok(`verified ${truncateMiddle(event.file.destPath, 64)}`);
      break;
    }
    case "deleted": {
      output.bullet(`deleted the phone copy of ${truncateMiddle(event.file.candidate.srcPath, 56)}`);
      break;
    }
    case "skipped": {
      output.bullet(`skipped — ${event.reason}`);
      break;
    }
    case "failed": {
      output.fail(`${truncateMiddle(event.file.candidate.srcPath, 56)} — ${event.reason}`);
      break;
    }
    default:
      break;
  }
  void nowNs;
  void lastLine;
}

/**
 * `portage purge` — deferred deletion, as a separate command.
 *
 * Exposed here rather than in its own file because it shares the pull
 * context's device resolution, and a device you cannot reach is the single
 * most common reason a purge fails.
 */
export async function purge(ctx: PullContext): Promise<number> {
  const { config } = ctx.resolved;
  const output = ctx.output;
  if (!ctx.adb) throw preconditionError("adb is not available");

  const destRoot = requireDestRoot(config);
  const devices = await ctx.adb.devices();
  const ready = devices.filter((d) => d.state === "device");
  if (ready.length === 0) {
    throw preconditionError("no device is attached — purge needs the phone to prove the file is still there");
  }

  const journal = Journal.open(destRoot);
  try {
    const transport = new AdbTransport(ctx.adb);
    const purgeOpts = {
      journal,
      transport,
      verifyHash: ctx.verifyHash,
      dryRun: true,
      apply: false,
    };

    const planResult = await planPurge(new Map(ready.map((d) => [d.id, d])), ctx.adb, purgeOpts);

    if (planResult.eligible.length === 0 && planResult.refused.length === 0) {
      output.ok("nothing is waiting to be purged — every verified file was already removed from the phone");
      return 0;
    }

    if (output.mode === "json") {
      output.emitJson({
        dry_run: ctx.dryRun,
        eligible: planResult.eligible.map((c) => ({ path: c.srcPath, size: c.size, proof: c.proof })),
        refused: planResult.refused,
        bytes_reclaimable_on_phone: planResult.bytesReclaimed,
      });
      return 0;
    }

    output.heading("purge");
    output.kv("verified on drive", `${planResult.eligible.length} files · ${formatBytes(planResult.bytesReclaimed)}`);
    output.line();

    for (const candidate of planResult.eligible) {
      output.bullet(`${formatBytes(candidate.size).padStart(10)}  ${candidate.srcPath}  (${candidate.proof})`);
    }
    for (const refusal of planResult.refused) {
      output.warn(`${refusal.srcPath} — ${refusal.reason}`);
    }

    if (ctx.dryRun) {
      output.line();
      output.line("  dry run — nothing was deleted. Re-run without --dry-run to apply.");
      return 0;
    }

    const result = await applyPurge(planResult, { ...purgeOpts, dryRun: false, apply: true });

    output.line();
    output.ok(`removed ${result.deleted} file(s) from the phone`);
    if (result.failed > 0) output.fail(`${result.failed} could not be removed`);

    return result.failed > 0 ? ExitCode.transfer : 0;
  } finally {
    journal.close();
  }
}

/** Set from the signal handler; the engine polls it between files. */
export let stopped = false;
export function requestStop(): void {
  stopped = true;
}

export { createLogger, join, planPurge, applyPurge };