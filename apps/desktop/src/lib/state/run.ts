/**
 * The run reducers: frames in, a view out. PURE — no Svelte import, so
 * `bun test` can drive it without a compiler.
 *
 * The rule that shapes everything here: **the reducer invents no numbers.**
 * Every value in a `RunView` is copied out of a frame. Where the frames do not
 * carry a number, the view says so rather than estimating it — the proof
 * strip's `deleted` and `kept` are only knowable from the engine's own
 * end-of-run `run` frame, and they read zero until it arrives.
 */
import type {
	DeviceRow,
	EngineSummary,
	FileRow,
	Overall,
	RunFrame,
	ScreenName,
	StateFrame,
} from "../engine/protocol.ts";

/**
 * How long a `copying` row may go without a byte before it says `stalled`.
 * The spec's constant (`docs/tui.md` §5), not a measurement of the run.
 */
export const STALL_MS = 10_000;

/** The four counters the proof strip draws. Each only ever goes up. */
export interface ProofCounts {
	written: number;
	verified: number;
	deleted: number;
	kept: number;
}

export interface RunView {
	screen: ScreenName;
	rows: FileRow[];
	overall: Overall;
	devices: DeviceRow[];
	notice: string | null;
	/** Monotone within a run; reset by `startRun`. */
	proof: ProofCounts;
	/** The engine's own summary, once the terminal `run` frame lands. */
	summary: EngineSummary | null;
	/** True once the terminal frame has been applied. */
	ended: boolean;
}

export function emptyOverall(): Overall {
	return {
		bytesDone: 0,
		bytesTotal: 0,
		filesDone: 0,
		filesTotal: 0,
		failed: 0,
		skipped: 0,
		rateBps: 0,
		avgBps: 0,
		smoothedBps: 0,
		etaSeconds: null,
		samples: 0,
		elapsedMs: 0,
		jobs: 1,
		paused: false,
	};
}

export function emptyRunView(): RunView {
	return {
		screen: "dashboard",
		rows: [],
		overall: emptyOverall(),
		devices: [],
		notice: null,
		proof: { written: 0, verified: 0, deleted: 0, kept: 0 },
		summary: null,
		ended: false,
	};
}

/**
 * Begin a fresh run.
 *
 * Called when a `pull.start` succeeds. The counters are per-run, so they must
 * be cleared rather than carried — but only here, never mid-frame, which is
 * what keeps "the strip never decreases" true for the run it belongs to.
 */
export function startRun(previous: RunView): RunView {
	return {
		...emptyRunView(),
		screen: previous.screen,
		devices: previous.devices,
	};
}

/** A row the copy has finished but the engine has not yet confirmed. */
export function isVerifying(row: FileRow): boolean {
	return row.state === "copying" && row.size > 0 && row.bytes >= row.size;
}

/** A row's own progress, 0..1. Zero when the size is unknown. */
export function rowFraction(row: FileRow): number {
	if (row.size <= 0) return 0;
	return Math.max(0, Math.min(1, row.bytes / row.size));
}

export function stalledFor(row: FileRow, now: number): number {
	if (row.state !== "copying" || row.startedAt === null) return 0;
	if (isVerifying(row)) return 0;
	const since = now - Math.max(row.lastProgressAt, row.startedAt);
	return since >= STALL_MS ? since : 0;
}

/** The highest each counter has reached. A frame may not take one back down. */
function mergeProof(previous: ProofCounts, next: ProofCounts): ProofCounts {
	return {
		written: Math.max(previous.written, next.written),
		verified: Math.max(previous.verified, next.verified),
		deleted: Math.max(previous.deleted, next.deleted),
		kept: Math.max(previous.kept, next.kept),
	};
}

/**
 * What a `state` frame can prove on its own.
 *
 * The engine folds the delete step into a row's `done` state, so a snapshot
 * cannot separate "deleted on the phone" from "kept on purpose" — only the
 * terminal `run` frame can. Those two are reported as zero here, not guessed.
 */
function proofFromRows(rows: FileRow[]): ProofCounts {
	let written = 0;
	let verified = 0;
	for (const row of rows) {
		if (row.state === "done") {
			verified++;
			written++;
		} else if (isVerifying(row)) {
			written++;
		}
	}
	return { written, verified, deleted: 0, kept: 0 };
}

/** Apply one `state` frame. Rows and totals are replaced wholesale. */
export function reduceState(view: RunView, frame: StateFrame): RunView {
	return {
		...view,
		screen: frame.screen,
		rows: frame.rows,
		overall: frame.overall,
		devices: frame.devices,
		notice: frame.notice,
		proof: mergeProof(view.proof, proofFromRows(frame.rows)),
	};
}

/**
 * Apply the terminal `run` frame: the only place `deleted` and `kept` are
 * knowable, because only the engine's `EngineSummary` carries them.
 */
export function reduceRun(view: RunView, frame: RunFrame): RunView {
	const s = frame.summary;
	return {
		...view,
		summary: s,
		ended: true,
		proof: mergeProof(view.proof, {
			written: s.transferred,
			verified: s.verified,
			deleted: s.deleted,
			kept: s.kept,
		}),
	};
}

// --- derived helpers ---------------------------------------------------------

/** Integer percent of a whole. `pct(3, 0)` is 0, never NaN. */
export function pct(done: number, total: number): number {
	if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
	const fraction = done / total;
	return Math.round(Math.max(0, Math.min(1, fraction)) * 100);
}

/**
 * The run's two rates, as the frame reported them. `null` means "not measured
 * yet", which is not the same as zero — the UI shows `—` for one and `0 B/s`
 * for the other.
 */
export function rates(overall: Overall): {
	instant: number | null;
	average: number | null;
} {
	return {
		instant: overall.rateBps > 0 ? overall.rateBps : null,
		average: overall.avgBps > 0 ? overall.avgBps : null,
	};
}

/** Rows frozen mid-copy long enough to be worth naming, oldest first. */
export function stalledRows(view: RunView, now: number): FileRow[] {
	return view.rows
		.filter((row) => stalledFor(row, now) > 0)
		.sort((a, b) => stalledFor(b, now) - stalledFor(a, now));
}

/** The four counters, for the proof strip. */
export function proofCounts(view: RunView): ProofCounts {
	return view.proof;
}

/** Rows that stopped, with the reason the engine gave for each. */
export function failedRows(view: RunView): FileRow[] {
	return view.rows.filter((row) => row.state === "failed");
}

/**
 * The one sentence the live region says. File counts and the phase, never
 * bytes: a screen reader must not be read a 10 Hz byte counter.
 */
export function runAnnouncement(view: RunView): string {
	const o = view.overall;
	if (view.ended) {
		return `Run finished. ${o.filesDone} of ${o.filesTotal} files finished, ${o.failed} failed.`;
	}
	if (o.filesTotal === 0) return "No transfer is running.";
	const phase = o.paused ? "Paused" : "Copying";
	return `${phase}. ${o.filesDone} of ${o.filesTotal} files finished, ${o.failed} failed.`;
}

/** True while there is a run worth announcing: started, and not yet ended. */
export function runIsLive(view: RunView): boolean {
	return view.overall.filesTotal > 0 && !view.ended;
}
