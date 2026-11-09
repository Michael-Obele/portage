/**
 * The wire contract between `portage serve` and the desktop app.
 *
 * The app mirrors this protocol by hand
 * (`apps/desktop/src/lib/engine/protocol.ts`) because the engine is a separate
 * binary it spawns, not an import. A mirror that drifts is not a documentation
 * problem — it is a crash. The app read `answer.sources.userPath` out of
 * `config.get`, whose answer is a key COUNT, and threw
 * `undefined is not an object (evaluating 'sources.userPath')` the first time a
 * real destination was picked. Nothing caught it because the fixture answered
 * with the frame's payload instead of the engine's.
 *
 * So the app's `ANSWER_KEYS` table is the contract, and this file holds the
 * ENGINE to it, in three ways:
 *
 *  1. every command the engine accepts has a declared answer shape;
 *  2. the engine's real answers have exactly those keys; and
 *  3. a command's payload FRAME is written BEFORE its answer — the ordering the
 *     app's `loadConfig`/`loadVolumes`/`loadDevices` rely on when they read the
 *     frame's result from state instead of the answer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/schema.ts";
import type { ResolvedConfig } from "../src/config/load.ts";
import { serve } from "../src/serve/index.ts";
import {
  COMMAND_TYPES,
  PROTOCOL_VERSION,
  parseFrame,
  type WireFrame,
} from "../src/serve/protocol.ts";
import { silentLogger } from "../src/util/log.ts";
import { ANSWER_KEYS, type CommandType } from "../apps/desktop/src/lib/engine/protocol.ts";

// --- harness ----------------------------------------------------------------

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const run of cleanup) await run();
  cleanup = [];
});

/** A destination and a user config file that both live in a temp folder. */
async function tempConfig(): Promise<ResolvedConfig> {
  const root = await mkdtemp(join(tmpdir(), "portage-contract-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return {
    config: { ...DEFAULT_CONFIG, dest_root: root, roots: [] },
    sources: { userPath: join(root, "config.toml"), drivePath: null },
    origins: {},
  };
}

async function session(
  lines: string[],
  resolved: ResolvedConfig,
): Promise<WireFrame[]> {
  const raw: string[] = [];
  await serve({
    lines,
    sink: (line) => raw.push(line),
    logger: silentLogger,
    engineVersion: "contract",
    resolveConfig: async () => resolved,
    adb: async () => null,
  });
  return raw.map((line) => {
    const parsed = parseFrame(JSON.parse(line) as unknown);
    if (!parsed.ok) {
      throw new Error(`a frame the protocol does not describe: ${parsed.issues.join("; ")}`);
    }
    return parsed.frame;
  });
}

function cmd(id: string, type: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, id, type, args });
}

type Answer = Extract<WireFrame, { type: "answer" }>;

function answersFor(frames: WireFrame[], id: string): Answer[] {
  return frames.filter(
    (frame): frame is Answer => frame.type === "answer" && frame.id === id,
  );
}

function onlyAnswer(frames: WireFrame[], id: string): Answer {
  const found = answersFor(frames, id);
  if (found.length !== 1) {
    throw new Error(`expected exactly one answer for ${id}, got ${found.length}`);
  }
  return found[0]!;
}

function sortedKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    throw new Error(`an answer must be an object, got ${typeof value}`);
  }
  return Object.keys(value).sort();
}

/** The keys the app declares for a command, each shape sorted for comparison. */
const DECLARED: Record<string, string[][]> = Object.fromEntries(
  (Object.keys(ANSWER_KEYS) as CommandType[]).map((type) => [
    type,
    (ANSWER_KEYS[type] as readonly (readonly string[])[]).map((shape) =>
      [...shape].sort(),
    ),
  ]),
);

// --- 1. the tables agree ----------------------------------------------------

describe("the app's answer contract", () => {
  test("names every command the engine accepts", () => {
    expect([...Object.keys(ANSWER_KEYS)].sort()).toEqual([...COMMAND_TYPES].sort());
  });

  test("declares at least one shape per command, and no empty shape", () => {
    for (const [type, shapes] of Object.entries(DECLARED)) {
      expect({ type, shapes: shapes.length }).toEqual({ type, shapes: expect.any(Number) });
      expect(shapes.length).toBeGreaterThan(0);
      for (const shape of shapes) expect(shape.length).toBeGreaterThan(0);
    }
  });

  test("is satisfied by PROTOCOL_VERSION 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

// --- 2. the engine's answers ------------------------------------------------

describe("the engine's answers", () => {
  test("volumes.list answers a count, after the volumes frame", async () => {
    const frames = await session([cmd("v1", "volumes.list")], await tempConfig());
    const answer = onlyAnswer(frames, "v1");
    expect(answer.ok).toBe(true);
    expect(DECLARED["volumes.list"]).toContainEqual(sortedKeys(answer.data));

    const frameAt = frames.findIndex((frame) => frame.type === "volumes");
    const answerAt = frames.findIndex((frame) => frame.type === "answer" && frame.id === "v1");
    expect(frameAt).toBeGreaterThanOrEqual(0);
    expect(frameAt).toBeLessThan(answerAt);
  });

  test("devices.list answers a count and adbFound", async () => {
    const frames = await session([cmd("d1", "devices.list")], await tempConfig());
    const answer = onlyAnswer(frames, "d1");
    expect(answer.ok).toBe(true);
    expect(DECLARED["devices.list"]).toContainEqual(sortedKeys(answer.data));
    expect(answer.data).toMatchObject({ adbFound: false });

    const frameAt = frames.findIndex((frame) => frame.type === "devices");
    const answerAt = frames.findIndex((frame) => frame.type === "answer" && frame.id === "d1");
    expect(frameAt).toBeGreaterThanOrEqual(0);
    expect(frameAt).toBeLessThan(answerAt);
  });

  test("config.get answers a key count, and carries the config in a frame first", async () => {
    const frames = await session([cmd("c1", "config.get")], await tempConfig());
    const answer = onlyAnswer(frames, "c1");
    expect(answer.ok).toBe(true);
    // The exact shape the app used to read `sources` off. It has no `sources`.
    expect(sortedKeys(answer.data)).toEqual(["keys"]);
    expect(DECLARED["config.get"]).toContainEqual(sortedKeys(answer.data));

    const configAt = frames.findIndex((frame) => frame.type === "config");
    const answerAt = frames.findIndex((frame) => frame.type === "answer" && frame.id === "c1");
    expect(configAt).toBeGreaterThanOrEqual(0);
    expect(configAt).toBeLessThan(answerAt);
  });

  test("the config frame carries the two paths the app reads", async () => {
    const resolved = await tempConfig();
    const frames = await session([cmd("c2", "config.get")], resolved);
    const config = frames.find((frame) => frame.type === "config");
    if (config?.type !== "config") throw new Error("expected a config frame");
    expect(config.sources.userPath).toBe(resolved.sources.userPath);
    expect(config.sources.drivePath).toBeNull();
    expect(config.origins).toBeTypeOf("object");
  });

  test("config.get with a key answers that key, its value and its origin", async () => {
    const frames = await session(
      [cmd("c3", "config.get", { key: "jobs" })],
      await tempConfig(),
    );
    const answer = onlyAnswer(frames, "c3");
    expect(answer.ok).toBe(true);
    expect(DECLARED["config.get"]).toContainEqual(sortedKeys(answer.data));
    expect(answer.data).toMatchObject({ key: "jobs", origin: expect.any(String) });
    expect(frames.some((frame) => frame.type === "config")).toBe(true);
  });

  test("config.set answers key, value and path, after re-announcing the config", async () => {
    const resolved = await tempConfig();
    const frames = await session(
      [cmd("s1", "config.set", { key: "jobs", value: 3 })],
      resolved,
    );
    const answer = onlyAnswer(frames, "s1");
    expect(answer.ok).toBe(true);
    expect(DECLARED["config.set"]).toContainEqual(sortedKeys(answer.data));
    expect(answer.data).toMatchObject({
      key: "jobs",
      value: 3,
      path: resolved.sources.userPath,
    });

    const configAt = frames.findIndex((frame) => frame.type === "config");
    const answerAt = frames.findIndex((frame) => frame.type === "answer" && frame.id === "s1");
    expect(configAt).toBeGreaterThanOrEqual(0);
    expect(configAt).toBeLessThan(answerAt);
  });

  test("dupes.scan answers ids and counts, after the dupes frame", async () => {
    const frames = await session([cmd("u1", "dupes.scan", { tier: 1 })], await tempConfig());
    const answer = onlyAnswer(frames, "u1");
    expect(answer.ok).toBe(true);
    expect(DECLARED["dupes.scan"]).toContainEqual(sortedKeys(answer.data));

    const frameAt = frames.findIndex((frame) => frame.type === "dupes");
    const answerAt = frames.findIndex((frame) => frame.type === "answer" && frame.id === "u1");
    expect(frameAt).toBeGreaterThanOrEqual(0);
    expect(frameAt).toBeLessThan(answerAt);
  });

  test("status.get answers counts, after the status frame", async () => {
    const frames = await session([cmd("t1", "status.get")], await tempConfig());
    const answer = onlyAnswer(frames, "t1");
    expect(answer.ok).toBe(true);
    expect(DECLARED["status.get"]).toContainEqual(sortedKeys(answer.data));

    const frameAt = frames.findIndex((frame) => frame.type === "status");
    const answerAt = frames.findIndex((frame) => frame.type === "answer" && frame.id === "t1");
    expect(frameAt).toBeGreaterThanOrEqual(0);
    expect(frameAt).toBeLessThan(answerAt);
  });

  test("shutdown answers, and stops the loop", async () => {
    const frames = await session([cmd("x1", "shutdown")], await tempConfig());
    const answer = onlyAnswer(frames, "x1");
    expect(answer.ok).toBe(true);
    expect(DECLARED.shutdown).toContainEqual(sortedKeys(answer.data));
    expect(frames.some((frame) => frame.type === "bye")).toBe(true);
  });

  test("a refusal is an answer too, and never a payload frame", async () => {
    const frames = await session([cmd("p1", "pull.pause")], await tempConfig());
    const answer = onlyAnswer(frames, "p1");
    expect(answer.ok).toBe(false);
    // The engine names what happened and what to do, and the app renders both.
    expect(answer.error?.message.length).toBeGreaterThan(0);
    expect(answer.error?.fix.length).toBeGreaterThan(0);
  });
});

// --- 3. the ordering rule, generically --------------------------------------

describe("frame before answer", () => {
  /**
   * The app settles a request on the `answer` and then reads the payload the
   * FRAME put into state — so a frame written after its answer is a frame the
   * app misses. That is not a style rule; it is the difference between
   * "configured" and a crash.
   */
  const cases: Array<{ id: string; type: string; frame: WireFrame["type"] }> = [
    { id: "g1", type: "volumes.list", frame: "volumes" },
    { id: "g2", type: "devices.list", frame: "devices" },
    { id: "g3", type: "config.get", frame: "config" },
    { id: "g4", type: "dupes.scan", frame: "dupes" },
    { id: "g5", type: "status.get", frame: "status" },
  ];

  test("every payload frame precedes the answer that reports it", async () => {
    const frames = await session(
      cases.map((entry) => cmd(entry.id, entry.type)),
      await tempConfig(),
    );
    for (const entry of cases) {
      const answerAt = frames.findIndex(
        (frame) => frame.type === "answer" && frame.id === entry.id,
      );
      const frameAt = frames.findIndex((frame) => frame.type === entry.frame);
      expect({ id: entry.id, answered: answerAt >= 0 }).toEqual({
        id: entry.id,
        answered: true,
      });
      expect({ id: entry.id, frame: frameAt >= 0 }).toEqual({ id: entry.id, frame: true });
      expect({ id: entry.id, order: frameAt < answerAt }).toEqual({
        id: entry.id,
        order: true,
      });
    }
  });
});
