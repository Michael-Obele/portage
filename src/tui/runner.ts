/**
 * The dashboard's engine runner.
 *
 * This is a SIBLING of `src/cli/commands/pull.ts`, never a patch to it.
 *
 * `pull()` returns `Promise<number>` (an exit code), prints its own summary, and
 * hardcodes its progress callback — so it cannot be given a view. What it CAN do
 * is be read: every symbol below is exported, and the acceptance gate that says
 * "the engine files are untouched" runs `git diff`, which constrains editing,
 * not importing.
 *
 * So this file re-does the ~60 lines of orchestration (devices -> state dirs ->
 * reconcile -> gather -> plan -> space check -> runTransfer) with ONE difference:
 * the `onFileEvent` we hand the engine is `TransferSink.onFileEvent`.
 *
 * That is the whole seam. One engine, two sinks: the plain renderer gets lines,
 * this gets `view`.
 */
import type { Adb, DeviceInfo } from "../device/adb.ts";
import type { ResolvedConfig } from "../config/load.ts";
import { requireDestRoot } from "../config/load.ts";
import { ensureStateDirs } from "../util/fs.ts";
import { checkDestination, reconcile } from "../index/recovery.ts";
import { Journal } from "../index/journal.ts";
import { buildPlan, type PlanResult } from "../plan/plan.ts";
import { eligible, scanDevice, type Candidate } from "../scan/scan.ts";
import { AdbTransport } from "../xfer/adb.ts";
import { runTransfer, type EngineSummary } from "../xfer/engine.ts";
import type { DeleteSource } from "../config/schema.ts";
import { preconditionError } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";

import { TransferSink } from "./sink.ts";
import { view } from "./state.svelte.ts";

/**
 * Pause and stop.
 *
 * The engine polls `shouldStop()` BETWEEN files only (engine.ts:130). So pause
 * means "finish what is in flight, then hold" — it is not a preemption, and
 * saying otherwise would be a lie the dashboard cannot keep. The same mechanism
 * serves `q` and Ctrl-C, which is why both stay resumable: the journal, not this
 * flag, is what makes a stopped run resumable.
 */
export interface TransferControl {
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  /** Ask the engine to finish the file in flight and stop. */
  stop(): void;
  /** True when the user asked to stop (q / Q / Ctrl-C / SIGTERM). */
  stopped(): boolean;
}

export function createControl(): TransferControl {
  let paused = false;
  let stopped = false;
  return {
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    isPaused: () => paused,
    stop: () => {
      stopped = true;
      paused = false;
    },
    stopped: () => stopped,
  };
}

export interface PullRunOptions {
  adb: Adb;
  resolved: ResolvedConfig;
  logger: Logger;
  deviceFilter?: string;
  show?: string;
  sinceSeconds?: number;
  jobs?: number;
  keepSource: boolean;
  deleteSource: boolean;
  control: TransferControl;
}

export interface PullRunHandle {
  /** Resolves with the engine's own summary when the run ends. */
  summary: Promise<EngineSummary>;
  /** The plan, once it exists — the footer wants its destination. */
  plan: Promise<PlanResult>;
}

/**
 * Starts the transfer. Resolves as soon as the engine is running, NOT when it
 * finishes — the screen has to be live for the whole run, which is the entire
 * point of the dashboard.
 */
export async function startPull(
  opts: PullRunOptions,
  sink: TransferSink,
): Promise<PullRunHandle> {
  const { config } = opts.resolved;
  const destRoot = requireDestRoot(config);

  if (opts.keepSource && opts.deleteSource) {
    throw preconditionError(
      "--keep-source and --delete-source cannot both be set",
      "pick one: --keep-source copies and leaves the phone alone, --delete-source copies then deletes",
    );
  }
  const deleteSource: DeleteSource = opts.keepSource
    ? "never"
    : opts.deleteSource
      ? "after-verify"
      : config.delete_source;

  const attached = await opts.adb.devices();
  const ready = attached.filter((d) => d.state === "device");
  if (ready.length === 0) {
    throw preconditionError(
      "no device is attached and authorised",
      "plug in a phone, enable USB debugging, and accept the RSA prompt",
    );
  }

  const filter = opts.deviceFilter;
  const selected = filter
    ? ready.filter(
        (d) =>
          d.id.startsWith(filter) ||
          d.serial === filter ||
          d.model.toLowerCase().includes(filter.toLowerCase()),
      )
    : ready;
  if (selected.length === 0) {
    throw preconditionError(`no attached device matches "${filter}"`);
  }

  const { partial } = await ensureStateDirs(destRoot);
  const journal = Journal.open(destRoot, opts.logger);

  // Recovery first, exactly as pull() does it: a killed transfer must leave a
  // journal the next run can continue from (gate C5).
  const recovery = await reconcile(journal, partial);
  if (recovery.interrupted || recovery.missing) {
    sink.onNotice(
      `recovered from a previous run: ${recovery.interrupted} interrupted, ${recovery.missing} missing`,
    );
  }

  const candidates = await gather(opts, selected);
  const planResult = buildPlan(candidates, {
    destRoot,
    journal,
    spaceHeadroom: config.space_headroom,
    show: opts.show,
    sinceSeconds: opts.sinceSeconds,
  });

  const space = checkDestination(
    destRoot,
    planResult.bytesTotal,
    config.space_headroom,
  );
  if (!space.ok) {
    journal.close();
    throw preconditionError(
      space.reason ?? "destination check failed",
      space.fix ??
        "free space on the drive, or point --dest-root somewhere else",
    );
  }

  // The sink now owns every denominator. Before this line the dashboard has
  // nothing to be honest about.
  const jobs = opts.jobs ?? config.jobs;
  sink.begin(planResult, selected, jobs);

  const transport = new AdbTransport(opts.adb, (path: string) => {
    opts.logger.debug(`partial below threshold — restarting ${path}`);
  });
  const deviceMap = new Map<string, DeviceInfo>(selected.map((d) => [d.id, d]));

  const summary = runTransfer(planResult, deviceMap, {
    journal,
    transport,
    adb: opts.adb,
    partialDir: partial,
    jobs,
    verify: config.verify,
    deleteSource,
    resumeThreshold: config.resume_threshold,
    logger: opts.logger,
    dryRun: false,
    // Pause and stop share one predicate. The engine checks it between files.
    shouldStop: () => opts.control.stopped() || opts.control.isPaused(),
    onFileEvent: (event) => sink.onFileEvent(event),
  })
    .then((s) => {
      sink.finish(s);
      journal.close();
      return s;
    })
    .catch((err: unknown) => {
      journal.close();
      sink.onNotice(err instanceof Error ? err.message : String(err));
      throw err;
    });

  return { summary, plan: Promise.resolve(planResult) };
}

/**
 * Walk the selected devices and return the candidate list.
 *
 * A device with no configured roots is SKIPPED, not an error, and definitely not
 * a reason to start walking all of /sdcard. Mirrors gather() in pull.ts.
 */
async function gather(
  opts: PullRunOptions,
  devices: DeviceInfo[],
): Promise<Candidate[]> {
  const { config } = opts.resolved;
  const all: Candidate[] = [];
  for (const device of devices) {
    const deviceConfig = config.devices[device.id];
    const roots = deviceConfig?.roots ?? [];
    if (roots.length === 0) {
      opts.logger.debug(
        `skipping ${device.model || device.serial}: no roots configured`,
      );
      continue;
    }
    const found = await scanDevice(opts.adb, device, roots, {
      quietSeconds: config.quiet_seconds,
      deviceConfig,
    });
    all.push(...found);
  }
  return eligible(all);
}

/** A last breath after a run: leave the view in a state that explains itself. */
export function settle(
  viewRef: typeof view,
  summary: EngineSummary,
  hard: boolean,
): number {
  viewRef.overall.paused = false;
  if (hard) viewRef.notice = "stopped — the journal will resume next run";
  else if (summary.failed > 0) {
    viewRef.notice = `${summary.failed} failed — press r to retry, q to quit`;
  } else
    viewRef.notice = "done — every transferred file verified against the phone";
  return summary.failed > 0 ? 3 : 0;
}
