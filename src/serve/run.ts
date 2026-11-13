/**
 * The transfer lifecycle for `serve`.
 *
 * This is a SIBLING of `src/tui/main.svelte.ts`'s wiring, not a patch to it, and
 * it reuses the same two things the TUI does: `startPull` (from
 * `src/tui/runner.ts`, unedited) and `TransferSink`. That reuse is the whole
 * reason "the screen and the script cannot disagree" keeps holding for the GUI
 * (architecture.md D30) — there is still exactly one aggregate.
 *
 * Three rules here are not style:
 *
 *  1. ONE run at a time. A second `pull.start` is refused with a reason a person
 *     can read, because two concurrent runs would interleave in one journal.
 *  2. The `state` timer NEVER queues. One frame per tick, latest wins, and a
 *     tick that arrives after the run ended clears itself instead of emitting.
 *  3. Every emission is guarded by the run id, so nothing from a previous run
 *     can paint over a newer one.
 */
import type { ResolvedConfig } from "../config/load.ts";
import type { Adb } from "../device/adb.ts";
import type { Logger } from "../util/log.ts";
import {
  createControl,
  startPull,
  type TransferControl,
} from "../tui/runner.ts";
import { TransferSink } from "../tui/sink.ts";
import type { EngineSummary } from "../xfer/engine.ts";

import type { Frames } from "./frames.ts";

/** ~10 Hz. Fast enough to look live, slow enough to stay off the wire's back. */
export const STATE_TICK_MS = 100;

export interface PullRunArgs {
  adb: Adb;
  resolved: ResolvedConfig;
  logger: Logger;
  deviceFilter?: string;
  show?: string;
  sinceSeconds?: number;
  jobs?: number;
  /** Copy only, never delete the phone copy. */
  keepSource: boolean;
  /** Source paths removed from this pull by hand; planned, never moved. */
  exclude?: string[];
  /** Copy, then delete the phone copy after verification. */
  deleteSource: boolean;
}

export interface PullRunHandle {
  /** Resolves with the engine's own summary when the run ends. */
  summary: Promise<EngineSummary>;
}

/** Injected so the one-run-at-a-time rule is testable without a device. */
export type PullStarter = (
  args: PullRunArgs,
  sink: TransferSink,
  control: TransferControl,
) => Promise<PullRunHandle>;

/** The real starter. `startPull` is handed the sink and the control as-is. */
export const engineStarter: PullStarter = (args, sink, control) =>
  startPull({ ...args, control }, sink);

export type RunStartResult =
  { ok: true; runId: string } | { ok: false; reason: string; fix: string };

export interface ControlResult {
  ok: boolean;
  /** What actually happens, in the words of a thing that cannot preempt. */
  effect: string;
}

interface ActiveRun {
  id: string;
  sink: TransferSink;
  control: TransferControl;
  timer: ReturnType<typeof setInterval> | null;
  startedAt: number;
}

export class RunController {
  private active: ActiveRun | null = null;

  constructor(
    private readonly frames: Frames,
    private readonly starter: PullStarter = engineStarter,
    private readonly tickMs: number = STATE_TICK_MS,
    private readonly newId: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  /** The live run id, or null. Read by tests and by a late `ready` rebuild. */
  get runId(): string | null {
    return this.active?.id ?? null;
  }

  get running(): boolean {
    return this.active !== null;
  }

  /**
   * Start a run. Resolves as soon as the engine is running, NOT when it ends —
   * the UI has to be live for the whole run.
   *
   * A failure to even start (no device, no destination) clears the slot and
   * rethrows, so the caller answers with the engine's own message and fix.
   */
  async start(args: PullRunArgs): Promise<RunStartResult> {
    if (this.active) {
      return {
        ok: false,
        reason: "a transfer is already running",
        fix: "wait for it to finish, or send pull.stop first — one run at a time keeps one journal honest",
      };
    }

    const id = this.newId();
    const sink = new TransferSink();
    const control = createControl();
    this.active = { id, sink, control, timer: null, startedAt: Date.now() };

    const handle = await this.starter(args, sink, control).catch((err) => {
      this.active = null;
      throw err;
    });

    const timer = setInterval(() => {
      const current = this.active;
      // The guard that matters: a tick queued before the run ended must not
      // emit after the terminal frame.
      if (!current || current.id !== id) {
        clearInterval(timer);
        return;
      }
      current.sink.tick(Date.now());
      this.frames.state();
    }, this.tickMs);

    const live = this.active;
    if (live && live.id === id) live.timer = timer;
    else clearInterval(timer);

    void handle.summary.then(
      (summary) => this.finish(id, summary),
      (err: unknown) => this.finish(id, null, err),
    );

    return { ok: true, runId: id };
  }

  /**
   * Pause is NOT preemption. The engine checks the flag between files, so the
   * file in flight finishes and verifies first. The answer says exactly that
   * rather than implying the bytes stop now.
   */
  pause(): ControlResult {
    const current = this.active;
    if (!current) return { ok: false, effect: "no transfer is running" };
    if (current.control.isPaused()) {
      return { ok: true, effect: "already paused" };
    }
    current.control.pause();
    return {
      ok: true,
      effect:
        "pausing between files — the file in flight finishes and verifies first",
    };
  }

  resume(): ControlResult {
    const current = this.active;
    if (!current) return { ok: false, effect: "no transfer is running" };
    if (!current.control.isPaused()) {
      return { ok: true, effect: "not paused" };
    }
    current.control.resume();
    return { ok: true, effect: "resumed" };
  }

  /**
   * Stop finishes the file in flight, then stops — and the journal, not a flag,
   * is what makes the run resumable.
   */
  stop(): ControlResult {
    const current = this.active;
    if (!current) return { ok: false, effect: "no transfer is running" };
    current.control.stop();
    return {
      ok: true,
      effect:
        "finishing the file in flight, then stopping — the journal resumes it next run",
    };
  }

  /**
   * Drop everything without emitting a terminal frame.
   *
   * Only `shutdown` calls this: the process is about to exit 0, so a `run` frame
   * would be written into a closed pipe. What stops the run stays true either
   * way — the journal on the drive records it.
   */
  dispose(): void {
    const current = this.active;
    if (!current) return;
    if (current.timer) clearInterval(current.timer);
    current.control.stop();
    this.active = null;
  }

  /** Terminal path: stop the timer, snapshot once, then the engine's summary. */
  private finish(
    id: string,
    summary: EngineSummary | null,
    err?: unknown,
  ): void {
    const current = this.active;
    // A late resolution from a run that already ended is ignored here, which is
    // the other half of the run-id guard.
    if (!current || current.id !== id) return;
    if (current.timer) clearInterval(current.timer);
    // Nothing may fire after this line.
    this.active = null;
    current.sink.tick(Date.now());
    this.frames.state();
    if (summary) this.frames.run(summary);
    else {
      this.frames.notice(
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
