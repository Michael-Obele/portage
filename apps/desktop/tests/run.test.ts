/**
 * The reducers are the app's honesty boundary: every number a screen shows came
 * out of a frame, and these tests are what keeps that true.
 *
 * Deliberately imports nothing that needs a Svelte compiler — a reducer that
 * reaches for a rune is the failure this file exists to catch.
 */
import { describe, expect, test } from "bun:test";

import type {
	EngineSummary,
	FileRow,
	Overall,
	RunFrame,
	StateFrame,
} from "../src/lib/engine/protocol.ts";
import { PROTOCOL_VERSION } from "../src/lib/engine/protocol.ts";
import {
	STALL_MS,
	emptyOverall,
	emptyRunView,
	pct,
	proofCounts,
	rates,
	reduceRun,
	reduceState,
	rowFraction,
	stalledFor,
	stalledRows,
	startRun,
	type RunView,
} from "../src/lib/state/run.ts";

function overall(patch: Partial<Overall> = {}): Overall {
	return { ...emptyOverall(), ...patch };
}

function row(patch: Partial<FileRow> = {}): FileRow {
	return {
		key: "dev /sdcard/a.mkv 1000",
		srcPath: "/sdcard/Download/a.mkv",
		destPath: "/media/node/2TB/Videos/a.mkv",
		size: 1000,
		bytes: 0,
		state: "queued",
		reason: "",
		startedAt: null,
		lastProgressAt: 0,
		onDrive: false,
		...patch,
	};
}

function stateFrame(rows: FileRow[], patch: Partial<Overall> = {}): StateFrame {
	return {
		v: PROTOCOL_VERSION,
		type: "state",
		screen: "dashboard",
		rows,
		overall: overall(patch),
		devices: [],
		notice: null,
	};
}

function runFrame(patch: Partial<EngineSummary> = {}): RunFrame {
	return {
		v: PROTOCOL_VERSION,
		type: "run",
		summary: {
			runId: 1,
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
			...patch,
		},
	};
}

describe("the ETA", () => {
	test("stays null until the frame carries a number", () => {
		let view = reduceState(emptyRunView(), stateFrame([], { bytesDone: 5_000_000, samples: 1 }));
		expect(view.overall.etaSeconds).toBeNull();

		view = reduceState(view, stateFrame([], { bytesDone: 40_000_000, samples: 4 }));
		expect(view.overall.etaSeconds).toBeNull();
	});

	test("reports the frame's own estimate once the engine gives one", () => {
		const view = reduceState(emptyRunView(), stateFrame([], { etaSeconds: 222 }));
		expect(view.overall.etaSeconds).toBe(222);
	});

	test("the reducer never derives one of its own", () => {
		const view = reduceState(
			emptyRunView(),
			stateFrame([], { bytesDone: 100, bytesTotal: 1000, smoothedBps: 10 }),
		);
		expect(view.overall.etaSeconds).toBeNull();
	});
});

describe("stalled rows", () => {
	const copying = row({
		key: "k",
		state: "copying",
		startedAt: 1_000,
		lastProgressAt: 1_000,
		bytes: 500,
		size: 1_000,
	});

	test("the threshold is 10 s of no bytes", () => {
		expect(STALL_MS).toBe(10_000);
		expect(stalledFor(copying, 1_000 + 9_999)).toBe(0);
		expect(stalledFor(copying, 1_000 + 10_000)).toBe(10_000);
	});

	test("a row that has moved bytes is not stalled", () => {
		const moving = row({ ...copying, lastProgressAt: 10_999 });
		expect(stalledFor(moving, 11_000)).toBe(0);
	});

	test("a row at 100 % is verifying, not stalled", () => {
		const verifying = row({ ...copying, bytes: 1_000 });
		expect(stalledFor(verifying, 500_000)).toBe(0);
		expect(rowFraction(verifying)).toBe(1);
	});

	test("stalledRows returns the frozen rows, worst first", () => {
		const slower = row({ ...copying, key: "slow", startedAt: 0, lastProgressAt: 500 });
		const view = reduceState(emptyRunView(), stateFrame([copying, slower]));
		const found = stalledRows(view, 1_000 + 20_000);
		expect(found).toHaveLength(2);
		expect(found[0]?.key).toBe("slow");
	});

	test("a queued row never reads as stalled", () => {
		expect(stalledFor(row({ state: "queued" }), 999_999)).toBe(0);
	});
});

describe("failure reasons", () => {
	test("a failed row keeps the engine's reason, through later frames", () => {
		const failed = row({
			key: "bad",
			state: "failed",
			reason: "the phone stopped answering mid-file",
		});
		let view = reduceState(emptyRunView(), stateFrame([failed]));
		view = reduceState(view, stateFrame([failed], { bytesDone: 10 }));
		view = reduceRun(view, runFrame({ failed: 1 }));

		expect(view.rows[0]?.reason).toBe("the phone stopped answering mid-file");
		expect(view.rows[0]?.state).toBe("failed");
	});

	test("a skipped row keeps its reason too", () => {
		const skipped = row({ key: "s", state: "skipped", reason: "already on the drive" });
		const view = reduceState(emptyRunView(), stateFrame([skipped]));
		expect(view.rows[0]?.reason).toBe("already on the drive");
	});
});

describe("the proof counters", () => {
	test("written and verified come from the rows a state frame carries", () => {
		const view = reduceState(
			emptyRunView(),
			stateFrame([
				row({ key: "a", state: "done", bytes: 1_000 }),
				row({ key: "b", state: "copying", bytes: 1_000, size: 1_000 }),
				row({ key: "c", state: "copying", bytes: 100, size: 1_000 }),
				row({ key: "d", state: "queued" }),
			]),
		);
		expect(proofCounts(view)).toEqual({
			written: 2,
			verified: 1,
			deleted: 0,
			kept: 0,
		});
	});

	test("never decrease, even when a stale snapshot arrives late", () => {
		const three = [
			row({ key: "a", state: "done" }),
			row({ key: "b", state: "done" }),
			row({ key: "c", state: "done" }),
		];
		let view = reduceState(emptyRunView(), stateFrame(three));
		expect(proofCounts(view).verified).toBe(3);

		view = reduceState(view, stateFrame([three[0]!]));
		expect(proofCounts(view).verified).toBe(3);

		view = reduceState(view, stateFrame([]));
		expect(proofCounts(view).verified).toBe(3);
	});

	test("deleted and kept are only knowable from the terminal run frame", () => {
		let view = reduceState(
			emptyRunView(),
			stateFrame([row({ key: "a", state: "done", bytes: 1_000 })]),
		);
		expect(proofCounts(view).deleted).toBe(0);
		expect(proofCounts(view).kept).toBe(0);
		expect(view.ended).toBe(false);

		view = reduceRun(view, runFrame({ transferred: 1, verified: 1, deleted: 1, kept: 0 }));
		expect(proofCounts(view)).toEqual({
			written: 1,
			verified: 1,
			deleted: 1,
			kept: 0,
		});
		expect(view.ended).toBe(true);
	});

	test("a run that was kept rather than deleted says so", () => {
		const view = reduceRun(
			emptyRunView(),
			runFrame({ transferred: 4, verified: 4, deleted: 0, kept: 4 }),
		);
		expect(proofCounts(view)).toEqual({ written: 4, verified: 4, deleted: 0, kept: 4 });
	});

	test("startRun clears the counters, because they belong to one run", () => {
		const done = reduceRun(emptyRunView(), runFrame({ transferred: 3, verified: 3 }));
		expect(proofCounts(done).verified).toBe(3);

		const fresh: RunView = startRun(done);
		expect(proofCounts(fresh)).toEqual({ written: 0, verified: 0, deleted: 0, kept: 0 });
		expect(fresh.summary).toBeNull();
		expect(fresh.ended).toBe(false);
	});
});

describe("percent and rates", () => {
	test("percent is an integer and never NaN on an empty run", () => {
		expect(pct(0, 0)).toBe(0);
		expect(pct(1, 3)).toBe(33);
		expect(pct(3, 3)).toBe(100);
		expect(pct(5, 3)).toBe(100);
	});

	test("a zero rate means not measured, not zero measured", () => {
		expect(rates(overall())).toEqual({ instant: null, average: null });
		expect(rates(overall({ rateBps: 1_500_000, avgBps: 1_400_000 }))).toEqual({
			instant: 1_500_000,
			average: 1_400_000,
		});
	});
});
