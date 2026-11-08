/**
 * The Transfer screen's local series and its row view models — pure, so a test
 * can drive them without a Svelte compiler.
 *
 * The one rule that matters: **nothing here computes a rate.** A sample is a
 * copy of two numbers the frame already carried (`rateBps`, `avgBps`), stamped
 * with the frame's own elapsed time. If the engine has not measured a rate yet,
 * the sample holds `—` and the chart draws a gap, because a chart that invents a
 * throughput is a chart about nothing.
 */
import type { FileRow, Overall } from "../../engine/protocol.ts";
import {
	isVerifying,
	rates,
	rowFraction,
	stalledFor,
	type RunView,
} from "../../state/run.ts";
import { DASH, formatPercent, formatRate, plural } from "../../util/format.ts";
import { baseName } from "./plan-filters.ts";

/** One point on the rate chart. `t` is the frame's own elapsed seconds. */
export interface RateSample {
	t: number;
	/** `null` while the engine has not measured an instant rate. */
	instant: number | null;
	/** `null` while the engine has not measured an average. */
	average: number | null;
}

/**
 * Two minutes of history at one sample per second.
 *
 * The cap exists because a run is minutes long and a chart of 3 000 points is a
 * chart nobody reads; the oldest point falls off the left.
 */
export const MAX_SAMPLES = 120;

/** How often the screen takes a sample, in milliseconds. */
export const SAMPLE_INTERVAL_MS = 1_000;

/**
 * One sample from one view.
 *
 * Returns `null` before there is anything to plot, so the chart starts empty
 * rather than at a zero that was never measured.
 */
export function sampleOf(overall: Overall): RateSample | null {
	if (overall.filesTotal === 0 && overall.bytesDone === 0) return null;
	const both = rates(overall);
	return {
		t: Math.max(0, Math.round(overall.elapsedMs / 1000)),
		instant: both.instant,
		average: both.average,
	};
}

/**
 * Append, replacing a sample with the same second.
 *
 * The frame rate is about 10 Hz and the sample rate 1 Hz, so most samples
 * overwrite the one before them; that keeps the x axis honest (one point per
 * second) instead of drawing 120 points inside 12 seconds.
 */
export function appendSample(
	series: RateSample[],
	sample: RateSample,
	cap: number = MAX_SAMPLES,
): RateSample[] {
	const last = series[series.length - 1];
	if (last && last.t === sample.t) return [...series.slice(0, -1), sample];
	return [...series, sample].slice(-cap);
}

/**
 * When the first file verified, in run seconds, or `null`.
 *
 * Recorded once from the proof count and the sample clock — the run's own
 * numbers, never a timer the screen invented.
 */
export function nextFirstVerify(
	previous: number | null,
	verified: number,
	t: number,
): number | null {
	if (previous !== null) return previous;
	return verified >= 1 ? t : null;
}

/**
 * The sentence above the chart. A number in a sentence is what a person
 * actually reads, so the chart is never the only way to the numbers.
 */
export function seriesSummary(series: RateSample[], firstVerifyAt: number | null): string {
	if (series.length === 0) {
		return "No samples yet. The chart starts once the engine reports a rate.";
	}
	const last = series[series.length - 1] as RateSample;
	const parts = [
		`instant ${formatRate(last.instant)}`,
		`average ${formatRate(last.average)}`,
		`sampled over ${formatSeconds(last.t)}`,
	];
	const text = parts.join(", ") + ".";
	if (firstVerifyAt === null) return text;
	return `${text} First file verified at ${formatSeconds(firstVerifyAt)}.`;
}

function formatSeconds(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return DASH;
	if (seconds < 60) return `${Math.round(seconds)} s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
}

// --- the row view ------------------------------------------------------------

/** The chips a run row can carry, as a subset of `StateChipState`. */
export type RowChip =
	| "queued"
	| "copying"
	| "verifying"
	| "verified"
	| "failed"
	| "skipped"
	| "duplicate";

export interface RowView {
	key: string;
	name: string;
	srcPath: string;
	destPath: string;
	size: number;
	bytes: number;
	chip: RowChip;
	/** The engine's reason, verbatim. Empty while nothing has gone wrong. */
	reason: string;
	/** Whole seconds since the last byte, once past the stall threshold. */
	stalledSeconds: number;
	/** 0..1, from `rowFraction`. Zero when the size is unknown. */
	fraction: number;
	percent: string;
}

/** `done` is the engine's "copied and verified" — the reducer counts it as such. */
function chipForState(row: FileRow): RowChip {
	if (isVerifying(row)) return "verifying";
	switch (row.state) {
		case "queued":
			return "queued";
		case "copying":
			return "copying";
		case "done":
			return "verified";
		case "failed":
			return "failed";
		case "duplicate":
			return "duplicate";
		default:
			return "skipped";
	}
}

export function rowView(row: FileRow, now: number): RowView {
	const fraction = rowFraction(row);
	return {
		key: row.key,
		name: baseName(row.srcPath),
		srcPath: row.srcPath,
		destPath: row.destPath,
		size: row.size,
		bytes: row.bytes,
		chip: chipForState(row),
		reason: row.reason,
		stalledSeconds: Math.round(stalledFor(row, now) / 1000),
		fraction,
		percent: formatPercent(fraction),
	};
}

export function rowViews(rows: FileRow[], now: number): RowView[] {
	return rows.map((row) => rowView(row, now));
}

/** One sentence naming what is stalled, for the band above the rows. */
export function stalledSentence(views: RowView[]): string | null {
	const stalled = views.filter((view) => view.stalledSeconds > 0);
	if (stalled.length === 0) return null;
	const worst = stalled.reduce((a, b) => (b.stalledSeconds > a.stalledSeconds ? b : a));
	return `${plural(stalled.length, "file")} with no bytes for at least ${worst.stalledSeconds} s — the cable, the phone, or the drive has stopped answering.`;
}

/** True while there is a run worth drawing: started, and not yet ended. */
export function viewIsLive(view: RunView): boolean {
	return view.overall.filesTotal > 0 && !view.ended;
}
