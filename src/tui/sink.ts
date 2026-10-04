/**
 * The engine -> view seam. ONE ENGINE, TWO SINKS.
 *
 * docs/tui-impl/01-architecture.md says "src/xfer/engine.ts calls the sink". That
 * would violate the project's own non-negotiable (and acceptance gate F3,
 * `git diff --stat src/xfer src/index src/plan src/scan` must be empty).
 *
 * It does not have to. `EngineOptions.onFileEvent` IS the seam: the engine calls
 * whatever callback it is handed. So the TUI's runner calls `runTransfer` itself
 * and hands it this object. The protected files are read, never edited — and
 * "the TUI is a view" becomes true in the code rather than true in a document.
 *
 * THE AGGREGATE IS DERIVED, NOT RECEIVED.
 *
 * This is the load-bearing fact about this codebase: the engine has no
 * `onOverall`. `EngineSummary` resolves once, at the end of the run. `FileEvent`
 * carries per-file bytes only. So everything on the dashboard's "overall" band —
 * bytes done, both rates, the ETA — is computed HERE, from the plan's totals
 * (the denominator) plus this sink's own clock. `--json` calls the same
 * `snapshot()`, so the screen and the script can never disagree (gates B1, D4).
 */
import type { DeviceInfo } from "../device/adb.ts";
import type { PlanResult, PlannedFile } from "../plan/plan.ts";
import type { EngineSummary, FileEvent } from "../xfer/engine.ts";

import {
  EWMA_ALPHA,
  ETA_MIN_BYTES,
  ETA_MIN_SAMPLES,
  honestEta,
  rowIndexByKey,
  view,
  type FileRow,
  type RowState,
} from "./state.svelte.ts";

/** The interface docs/tui-impl/01-architecture.md specifies. */
export interface ViewSink {
  onFileEvent(event: FileEvent): void;
  onNotice(text: string): void;
  /** Recompute the time-dependent numbers. Called on the 200 ms tick. */
  tick(now: number): void;
}

/** Stable identity. The engine has no index, so we use the same key the journal
 * itself uses: device + source path + size.
 *
 * The size comes from `candidate.size`, NOT `PlannedFile.size` — PlannedFile has
 * no `size` field; it has `bytes` (what this file would add, 0 when it is a
 * skip) and `candidate.size` (the real file). Using `bytes` here would make two
 * different files that are both skipped collide on one key. */
function keyOf(file: PlannedFile): string {
  return `${file.candidate.deviceId} ${file.candidate.srcPath} ${file.candidate.size}`;
}

export class TransferSink implements ViewSink {
  private doneBytes = 0;
  /** Partial bytes per in-flight file, so a copy in progress counts toward the
   * total without double counting when it verifies. */
  private inflight = new Map<string, number>();
  private startedAt = Date.now();
  private lastTickAt = Date.now();
  private lastBytes = 0;
  private lastAvg = 0;

  /**
   * Seed from the plan. This is where the DENOMINATOR comes from: the engine
   * never tells us how many files it intends to move, so we take it from
   * `planResult.toTransfer` before the first byte moves.
   */
  begin(plan: PlanResult, devices: DeviceInfo[], jobs: number): void {
    this.startedAt = Date.now();
    this.lastTickAt = this.startedAt;
    this.doneBytes = 0;
    this.inflight.clear();
    this.lastBytes = 0;
    this.lastAvg = 0;

    view.rows = plan.toTransfer.map((file) => this.rowFrom(file));
    view.overall.bytesTotal = plan.bytesTotal;
    view.overall.filesTotal = plan.toTransfer.length;
    view.overall.bytesDone = 0;
    view.overall.filesDone = 0;
    view.overall.failed = 0;
    view.overall.skipped = 0;
    view.overall.rateBps = 0;
    view.overall.avgBps = 0;
    view.overall.smoothedBps = 0;
    view.overall.etaSeconds = null;
    view.overall.samples = 0;
    view.overall.elapsedMs = 0;
    view.overall.jobs = Math.max(1, jobs);
    view.overall.paused = false;
    view.selected = 0;
    view.scrollTop = 0;

    // A skipped file is not a row to watch, but it IS information. It goes in
    // the queue so the user can see what the plan decided not to do.
    for (const file of plan.skipped) {
      const row = this.rowFrom(file);
      row.state =
        file.matchesArchive?.relation === "identical" ? "duplicate" : "skipped";
      row.reason = file.skipReason ?? file.matchesArchive?.note ?? "skipped";
      view.rows.push(row);
    }

    view.devices = devices.map((d) => ({
      id: d.id,
      model: d.model,
      android: d.android,
      ready: d.state === "device",
      linkMbps: null, // filled by the runner from doctor/lsusb, not guessed
      freeBytes: null,
    }));
  }

  onFileEvent(event: FileEvent): void {
    const key = keyOf(event.file);
    const index = rowIndexByKey(key);
    const now = Date.now();

    switch (event.type) {
      case "start": {
        this.ensure(index, event.file);
        const row = view.rows[rowIndexByKey(key)]!;
        row.state = "copying";
        row.startedAt = now;
        row.lastProgressAt = now;
        this.inflight.set(key, 0);
        this.recompute(now);
        return;
      }
      case "progress": {
        this.ensure(index, event.file);
        const row = view.rows[rowIndexByKey(key)]!;
        // `total` is authoritative for the file's real size; `bytes` is how far
        // along it is. Guard against a total of 0 producing NaN in the bar.
        if (event.total > 0) row.size = event.total;
        if (event.bytes !== row.bytes) row.lastProgressAt = now;
        row.bytes = event.bytes;
        this.inflight.set(key, event.bytes);
        if (row.state === "queued") {
          row.state = "copying";
          row.startedAt = now;
        }
        this.recompute(now);
        return;
      }
      case "verified": {
        this.ensure(index, event.file);
        const row = view.rows[rowIndexByKey(key)]!;
        row.state = "done";
        row.bytes = row.size;
        row.lastProgressAt = now;
        this.inflight.delete(key);
        this.doneBytes += row.size;
        view.overall.filesDone += 1;
        this.recompute(now);
        return;
      }
      case "deleted": {
        // The phone copy went too. `verified` already counted the bytes; this
        // only changes the wording of what the row means, so nothing to add.
        return;
      }
      case "failed": {
        this.ensure(index, event.file);
        const row = view.rows[rowIndexByKey(key)]!;
        row.state = "failed";
        row.reason = event.reason;
        row.lastProgressAt = now;
        this.inflight.delete(key);
        view.overall.failed += 1;
        this.recompute(now);
        return;
      }
      case "skipped": {
        this.ensure(index, event.file);
        const row = view.rows[rowIndexByKey(key)]!;
        row.state = "skipped";
        row.reason = event.reason;
        this.inflight.delete(key);
        view.overall.skipped += 1;
        this.recompute(now);
        return;
      }
    }
  }

  onNotice(text: string): void {
    view.notice = text;
  }

  /** The 200 ms tick: elapsed, both rates, the ETA. */
  tick(now: number): void {
    view.overall.elapsedMs = now - this.startedAt;
    this.recompute(now);
  }

  /** End of run. Reconciles against the engine's own summary so the last frame
   * and the final report cannot disagree. */
  finish(summary: EngineSummary): void {
    this.doneBytes = summary.bytesMoved;
    view.overall.bytesDone = summary.bytesMoved;
    view.overall.failed = summary.failed;
    view.overall.skipped = summary.skipped;
    view.overall.filesDone = summary.verified;
    view.overall.avgBps = summary.rateBps;
    if (summary.durationMs > 0) view.overall.elapsedMs = summary.durationMs;
    this.recompute(Date.now());
  }

  /**
   * The exact numbers a script gets. `--json` emits this, so gate D4's
   * "`eta_seconds: null` when unknown" is structurally true rather than a
   * promise someone has to remember to keep.
   */
  snapshot(): Record<string, unknown> {
    const o = view.overall;
    return {
      bytes_done: o.bytesDone,
      bytes_total: o.bytesTotal,
      rate_bps: Math.round(o.rateBps),
      avg_bps: Math.round(o.avgBps),
      eta_seconds: o.etaSeconds,
      files_done: o.filesDone,
      files_total: o.filesTotal,
      failed: o.failed,
      skipped: o.skipped,
      elapsed_seconds: Number((o.elapsedMs / 1000).toFixed(1)),
      jobs: o.jobs,
      paused: o.paused,
      rows: view.rows.map((r) => ({
        path: r.srcPath,
        size: r.size,
        bytes: r.bytes,
        state: r.state,
        reason: r.reason || null,
        on_drive: r.onDrive,
      })),
    };
  }

  // --- internals ------------------------------------------------------------

  private rowFrom(file: PlannedFile): FileRow {
    return {
      key: keyOf(file),
      srcPath: file.candidate.srcPath,
      destPath: file.destPath,
      size: file.bytes > 0 ? file.bytes : file.candidate.size,
      bytes: 0,
      state: "queued",
      reason: file.skipReason ?? "",
      startedAt: null,
      lastProgressAt: Date.now(),
      onDrive: file.alreadyTransferred || file.matchesArchive !== null,
    };
  }

  /**
   * An event can arrive for a file the plan did not list (a resume from an older
   * run, or a plan that changed underneath us). Append rather than drop it: a
   * file that is really moving must be visible, and a row we did not expect is
   * information, not an error.
   */
  private ensure(index: number, file: PlannedFile): void {
    if (index >= 0) return;
    view.rows.push(this.rowFrom(file));
  }

  /**
   * Both rates, and the ETA.
   *
   *   instantaneous — a 1 s window, EWMA. This is what tells you the cable died.
   *   average      — whole run, EWMA-smoothed. THIS is what the ETA uses, because
   *                  one noisy sample must not move the finish line.
   *
   * The ETA stays null until ETA_MIN_SAMPLES and ETA_MIN_BYTES are both met.
   */
  private recompute(now: number): void {
    let inflightBytes = 0;
    for (const bytes of this.inflight.values()) inflightBytes += bytes;

    const total = this.doneBytes + inflightBytes;
    view.overall.bytesDone = total;

    const elapsed = Math.max(1, now - this.startedAt);
    const avg = total / (elapsed / 1000);
    view.overall.avgBps = avg;

    const windowMs = now - this.lastTickAt;
    if (windowMs >= 200) {
      const instant = ((total - this.lastBytes) / windowMs) * 1000;
      // Only a non-negative reading is ever shown. A clock that went backwards,
      // or a tick that observed a resume (bytes went DOWN), must not paint a
      // negative rate on the dashboard.
      const safeInstant = instant >= 0 ? instant : 0;
      view.overall.rateBps =
        view.overall.rateBps > 0
          ? EWMA_ALPHA * safeInstant + (1 - EWMA_ALPHA) * view.overall.rateBps
          : safeInstant;
      this.lastAvg =
        this.lastAvg > 0
          ? EWMA_ALPHA * avg + (1 - EWMA_ALPHA) * this.lastAvg
          : avg;
      view.overall.smoothedBps = this.lastAvg;
      view.overall.samples += 1;
      this.lastBytes = total;
      this.lastTickAt = now;
    }

    view.overall.etaSeconds = honestEta(
      view.overall.bytesDone,
      view.overall.bytesTotal,
      view.overall.smoothedBps,
      view.overall.samples,
    );
  }
}

/** Exposed for tests and for the `--json` writer. */
export const ETA_RULES = { ETA_MIN_SAMPLES, ETA_MIN_BYTES } as const;
