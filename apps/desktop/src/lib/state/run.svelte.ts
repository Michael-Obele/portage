/**
 * The run, as reactive state. Thin by design: every rule lives in `run.ts`,
 * which is a plain module `bun test` can drive with no Svelte compiler.
 *
 * This file adds exactly two things a pure reducer cannot have — a `$state`
 * cell and a throttled announcement for the live region.
 */
import { browser } from "$app/env";

import type { Frame, RunFrame, StateFrame } from "../engine/protocol.ts";
import { appendSample, type RateSample } from "../components/app/transfer-series.ts";
import {
	emptyRunView,
	reduceRun,
	reduceState,
	runAnnouncement,
	startRun,
	type RunView,
} from "./run.ts";

/** The a11y floor: at most one announcement every five seconds. */
export const ANNOUNCE_INTERVAL_MS = 5_000;

/** How many rate samples are kept. Two minutes at the 1 s cadence, capped so a
 * long run cannot grow the array without bound. */
export const MAX_SAMPLES = 600;

class RunStore {
	view = $state<RunView>(emptyRunView());
	/** What the `aria-live="polite"` region currently says. */
	announcement = $state("");
	/**
	 * The throughput samples for THIS run.
	 *
	 * Here rather than in the Transfer page's own state because the chart is
	 * worth as much after the run as during it: the summary is the receipt, and
	 * a receipt that drops the shape of the transfer the moment you navigate
	 * away is a receipt with a hole in it. One owner, two readers.
	 */
	series = $state<RateSample[]>([]);

	#lastAnnouncedAt = 0;
	#lastAnnouncement = "";

	/** Feed one frame in. Anything that is not a run frame is ignored here. */
	applyFrame(frame: Frame): void {
		if (frame.type === "state") {
			this.view = reduceState(this.view, frame as StateFrame);
		} else if (frame.type === "run") {
			this.view = reduceRun(this.view, frame as RunFrame);
		}
	}

	/**
	 * Clear the counters for a new run. Called when `pull.start` answers ok —
	 * the counters are per-run, and carrying them across would make the proof
	 * strip claim work the second run has not done.
	 */
	beginRun(): void {
		this.view = startRun(this.view);
		this.series = [];
		this.#lastAnnouncement = "";
		this.announcement = "";
	}

	/** Record one rate sample. Replaced, not mutated, so the chart reacts. */
	pushSample(sample: RateSample): void {
		this.series = appendSample(this.series, sample, MAX_SAMPLES);
	}

	reset(): void {
		this.view = emptyRunView();
		this.series = [];
		this.announcement = "";
	}

	/**
	 * Re-read the sentence for the live region, at most once every five
	 * seconds. Returns true when the text actually changed, so the shell can
	 * skip a DOM write it does not need.
	 */
	refreshAnnouncement(now: number = Date.now()): boolean {
		if (!browser) return false;
		const next = runAnnouncement(this.view);
		if (next === this.#lastAnnouncement) return false;
		if (now - this.#lastAnnouncedAt < ANNOUNCE_INTERVAL_MS) return false;
		this.#lastAnnouncedAt = now;
		this.#lastAnnouncement = next;
		this.announcement = next;
		return true;
	}
}

export const run = new RunStore();
