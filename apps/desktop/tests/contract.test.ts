/**
 * The fixture is a stand-in for the ENGINE, so its answers have to be the
 * engine's answers — never the payload frames.
 *
 * This is the file that would have caught the bug that opened it. `config.get`
 * used to answer `{ config, origins, sources }` here, because the fixture copied
 * the `config` FRAME into the answer, while the real engine answers `{ keys }`
 * and sends the config in that frame. So the app looked perfect in fixture mode
 * and threw `undefined is not an object (evaluating 'sources.userPath')` the
 * first time a real destination was chosen.
 *
 * Every command is sent, and its answer's keys are checked against the app's
 * declared contract (`ANSWER_KEYS`), which `test/serve-contract.test.ts` checks
 * against the engine itself.
 */
import { describe, expect, test } from "bun:test";

import { createMockEngine } from "../src/lib/engine/mock.ts";
import {
	ANSWER_KEYS,
	type CommandType,
	type Frame,
} from "../src/lib/engine/protocol.ts";

/**
 * The args each command needs to reach its success answer. A command missing
 * from here fails to compile, so a new command cannot skip its own evidence.
 */
const ARGS: Record<CommandType, Record<string, unknown> | undefined> = {
	"volumes.list": undefined,
	"devices.list": undefined,
	"config.get": undefined,
	"config.set": { key: "dest_root", value: "/media/node/2TB/Videos/$Anime" },
	"status.get": undefined,
	doctor: undefined,
	"db.export": { path: "/tmp/portage-fixture-export.db" },
	browse: { path: "/sdcard/Download/Anime" },
	scan: undefined,
	plan: { jobs: 3 },
	"pull.start": { mode: "keep" },
	"pull.pause": undefined,
	"pull.resume": undefined,
	"pull.stop": undefined,
	"dupes.scan": undefined,
	"dupes.apply": { scanId: "dupes-2026-11-08-01", keys: ["k0"] },
	"purge.plan": undefined,
	"purge.apply": { planId: "purge-2026-11-08-01", keys: ["p0"] },
	shutdown: undefined,
};

function sortedKeys(value: unknown): string[] {
	if (typeof value !== "object" || value === null) {
		throw new Error(`an answer must be an object, got ${typeof value}`);
	}
	return Object.keys(value).sort();
}

const DECLARED: Record<string, string[][]> = Object.fromEntries(
	(Object.keys(ANSWER_KEYS) as CommandType[]).map((type) => [
		type,
		(ANSWER_KEYS[type] as readonly (readonly string[])[]).map((shape) =>
			[...shape].sort(),
		),
	]),
);

/** Connect a fixture, run `body`, and always shut its timers down. */
async function withFixture(
	body: (engine: ReturnType<typeof createMockEngine>, frames: Frame[]) => Promise<void>,
): Promise<void> {
	const engine = createMockEngine("run");
	const frames: Frame[] = [];
	const subscriptions = await engine.connect({ onFrame: (frame) => frames.push(frame) });
	try {
		await body(engine, frames);
	} finally {
		await subscriptions.close();
	}
}

function lastFrame<T extends Frame["type"]>(
	frames: Frame[],
	type: T,
): Extract<Frame, { type: T }> | undefined {
	return frames.filter((frame): frame is Extract<Frame, { type: T }> => frame.type === type).at(-1);
}

describe("the fixture's answers", () => {
	for (const type of Object.keys(ANSWER_KEYS) as CommandType[]) {
		test(`${type} answers one of the declared shapes`, async () => {
			await withFixture(async (engine) => {
				const answer = await engine.send(type, ARGS[type] as never);
				expect(DECLARED[type]).toContainEqual(sortedKeys(answer));
			});
		});
	}

	test("config.get answers a count, never the config itself", async () => {
		await withFixture(async (engine, frames) => {
			const answer = await engine.send("config.get");
			expect(answer).toEqual({ keys: expect.any(Number) });
			// The trap, named: these two belong to the FRAME.
			expect(answer).not.toHaveProperty("config");
			expect(answer).not.toHaveProperty("sources");

			const config = lastFrame(frames, "config");
			expect(config?.sources.userPath).toBeTypeOf("string");
			expect(config?.sources.drivePath).toBeTypeOf("string");
		});
	});

	test("config.set writes, re-announces in a frame, and answers the path", async () => {
		await withFixture(async (engine, frames) => {
			const answer = await engine.send("config.set", {
				key: "dest_root",
				value: "/tmp/elsewhere",
			});
			expect(sortedKeys(answer)).toEqual(["key", "path", "value"]);
			expect(lastFrame(frames, "config")?.config.dest_root).toBe("/tmp/elsewhere");
			// The engine also says where it wrote it, which the app shows in Settings.
			expect(lastFrame(frames, "notice")?.message).toContain("/tmp/elsewhere");
		});
	});

	test("plan answers a tally, after emitting the plan frame", async () => {
		await withFixture(async (engine, frames) => {
			const answer = await engine.send("plan");
			expect(answer).not.toHaveProperty("plan");
			expect(lastFrame(frames, "plan")?.plan.toTransfer.length).toBeGreaterThan(0);
			expect(answer).toMatchObject({ fileCount: expect.any(Number) });
		});
	});

	test("a frame is emitted before the answer it belongs to", async () => {
		await withFixture(async (engine, frames) => {
			const before = frames.length;
			await engine.send("dupes.scan");
			// The fixture emits the payload frame inside `send`, before it resolves.
			expect(frames.slice(before).some((frame) => frame.type === "dupes")).toBe(true);
		});
	});
});
