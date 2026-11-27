/**
 * `portage serve`, asserted on rather than described.
 *
 * The tests that matter most are the refusals. A tool whose whole job is
 * deleting files safely is not trustworthy because a happy path worked; it is
 * trustworthy once a FORGED key, a STALE scan id and a WRONG confirm have each
 * been shown to move nothing. Those are the first tests in this file, and every
 * one of them asserts against a real file on a real temporary drive.
 *
 * Every frame any test emits is pushed through `parseFrame`, so a test fails if
 * the engine ever writes something its own protocol does not describe.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";

import { DEFAULT_CONFIG, type DeviceConfig } from "../src/config/schema.ts";
import type { ResolvedConfig } from "../src/config/load.ts";
import { Adb, type DeviceFile, type DeviceInfo } from "../src/device/adb.ts";
import type { DupeReport } from "../src/dedupe/types.ts";
import type { EngineSummary } from "../src/xfer/engine.ts";
import type { PlanResult, PlannedFile } from "../src/plan/plan.ts";
import { applyPurge, type PurgePlan } from "../src/xfer/purge.ts";
import { Journal } from "../src/index/journal.ts";
import { probe, resetDriveState, statDrive } from "../src/util/probe.ts";
import { doctor, type DoctorContext } from "../src/serve/doctor.ts";
import type { SpawnFn } from "../src/util/spawn.ts";
import { captureOutput, createContext, dispatch, withFreshDriveCopies } from "../src/serve/dispatch.ts";
import { connect, snapshot, type Sink } from "../src/serve/frames.ts";
import { serve, type ServeOptions } from "../src/serve/index.ts";
import { PendingRegister } from "../src/serve/pending.ts";
import {
  COMMAND_TYPES,
  EnvelopeSchema,
  PROTOCOL_VERSION,
  describeFileEvent,
  parseFrame,
  type WireFrame,
} from "../src/serve/protocol.ts";
import { RunController, type PullStarter } from "../src/serve/run.ts";
import {
  ETA_MIN_BYTES,
  ETA_MIN_SAMPLES,
  view,
} from "../src/serve/view.svelte.ts";
import { TransferSink } from "../src/serve/sink.ts";
import { silentLogger } from "../src/util/log.ts";
import { fakeDevice, makeTempDrive } from "./helpers.ts";

// --- the harness ------------------------------------------------------------

type AnswerFrame = Extract<WireFrame, { type: "answer" }>;

interface Collector {
  raw: string[];
  sink: Sink;
  /** Every line, parsed AND validated against the protocol. */
  frames(): WireFrame[];
}

function collector(): Collector {
  const raw: string[] = [];
  return {
    raw,
    sink: (line: string) => {
      raw.push(line);
    },
    frames: () =>
      raw
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const parsed = parseFrame(JSON.parse(line) as unknown);
          if (!parsed.ok) {
            throw new Error(
              `a frame the protocol does not describe: ${parsed.issues.join("; ")}`,
            );
          }
          return parsed.frame;
        }),
  };
}

function answers(frames: WireFrame[]): AnswerFrame[] {
  return frames.filter(
    (frame): frame is AnswerFrame => frame.type === "answer",
  );
}

function one<T extends WireFrame["type"]>(
  frames: WireFrame[],
  type: T,
): Extract<WireFrame, { type: T }> {
  const found = frames.find((frame) => frame.type === type);
  if (!found) throw new Error(`expected a ${type} frame`);
  return found as Extract<WireFrame, { type: T }>;
}

function answerFor(frames: WireFrame[], id: string): AnswerFrame {
  const found = answers(frames).filter((frame) => frame.id === id);
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one answer for ${id}, got ${found.length}`,
    );
  }
  return found[0]!;
}

function cmd(
  id: string,
  type: string,
  args: Record<string, unknown> = {},
): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, id, type, args });
}

/** A config that writes nowhere and deletes nothing. */
function resolvedFor(
  destRoot: string | undefined,
  userPath = join(tmpdir(), "portage-serve-test-config.toml"),
  devices: Record<string, DeviceConfig> = {},
): ResolvedConfig {
  return {
    config: { ...DEFAULT_CONFIG, dest_root: destRoot ?? "", devices },
    sources: { userPath, drivePath: null },
    origins: {},
  };
}

/**
 * The device table `pull.start` needs in order to be allowed to start.
 *
 * Keyed the way the engine keys it — by `device.id`, not by serial — because a
 * mismatched key reads as "no folders configured" and would test the refusal
 * instead of the transfer.
 */
function configuredDevice(): Record<string, DeviceConfig> {
  return {
    [fakeDevice().id]: {
      label: "",
      roots: ["/sdcard/Movies"],
      exclude: [],
    },
  };
}

/** adb that reports one ready phone, and does nothing else. */
function fakeAdb(device: DeviceInfo): Adb {
  // `pull.start`/`scan` only ever call `devices()` before handing off, so a
  // two-method stand-in is honest about what the test exercises.
  return {
    devices: async () => [device],
  } as unknown as Adb;
}

async function runServe(
  lines: string[],
  init: Partial<ServeOptions> = {},
): Promise<{ frames: WireFrame[]; raw: string[]; code: number }> {
  const c = collector();
  const code = await serve({
    lines,
    sink: c.sink,
    logger: silentLogger,
    engineVersion: "test",
    resolveConfig: async () => resolvedFor(undefined),
    adb: async () => null,
    ...init,
  });
  return { frames: c.frames(), raw: c.raw, code };
}

// --- the protocol -----------------------------------------------------------

describe("the envelope", () => {
  const good = {
    v: PROTOCOL_VERSION,
    id: "1",
    type: "volumes.list",
    args: {},
  };

  test("accepts a well-formed command", () => {
    expect(v.safeParse(EnvelopeSchema, good).success).toBe(true);
  });

  test("rejects an unknown key rather than dropping it", () => {
    const result = v.safeParse(EnvelopeSchema, { ...good, extra: "typo" });
    expect(result.success).toBe(false);
  });

  test("rejects a wrong protocol version", () => {
    expect(v.safeParse(EnvelopeSchema, { ...good, v: 2 }).success).toBe(false);
  });

  test("rejects a missing or empty id, and a missing type", () => {
    expect(
      v.safeParse(EnvelopeSchema, { v: 1, type: "x", args: {} }).success,
    ).toBe(false);
    expect(v.safeParse(EnvelopeSchema, { ...good, id: "" }).success).toBe(
      false,
    );
    expect(
      v.safeParse(EnvelopeSchema, { v: 1, id: "1", args: {} }).success,
    ).toBe(false);
  });

  test("rejects an unknown key inside a command's args", async () => {
    const { frames } = await runServe([
      cmd("a1", "config.get", { key: "jobs", extra: true }),
    ]);
    const answer = answerFor(frames, "a1");
    expect(answer.ok).toBe(false);
    expect(answer.error?.message).toContain("extra");
  });

  test("every FileEvent has a one-line reading for the log channel", () => {
    const file = planned("/sdcard/Movies/a.mkv", 10);
    const cases: Array<[Parameters<typeof describeFileEvent>[0], string]> = [
      [{ type: "start", file }, "start /sdcard/Movies/a.mkv"],
      [
        { type: "progress", file, bytes: 5, total: 10 },
        "progress 5/10 /sdcard/Movies/a.mkv",
      ],
      [{ type: "verified", file, hash: "ab" }, "verified /drive/Anime/a.mkv"],
      [
        { type: "deleted", file },
        "deleted the phone copy of /sdcard/Movies/a.mkv",
      ],
      [
        { type: "failed", file, reason: "content mismatch" },
        "failed /sdcard/Movies/a.mkv: content mismatch",
      ],
      [
        { type: "skipped", file, reason: "already on the drive" },
        "skipped /sdcard/Movies/a.mkv: already on the drive",
      ],
    ];
    for (const [event, expected] of cases) {
      expect(describeFileEvent(event)).toBe(expected);
    }
  });
});

describe("the one-answer rule", () => {
  test("every command answers exactly once", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "portage-serve-cfg-"));
    try {
      const commands: Array<[string, Record<string, unknown>]> = [
        ["volumes.list", {}],
        ["devices.list", {}],
        ["config.get", {}],
        ["config.set", { key: "jobs", value: 3 }],
        ["status.get", {}],
        ["doctor", {}],
        ["db.export", { path: join(scratch, "export.jsonl") }],
        ["browse", { path: "/sdcard" }],
        ["scan", {}],
        ["plan", {}],
        ["pull.start", { mode: "keep" }],
        ["pull.pause", {}],
        ["pull.resume", {}],
        ["pull.stop", {}],
        ["dupes.scan", {}],
        ["dupes.apply", { scanId: "nope", keys: ["k0"] }],
        ["purge.plan", {}],
        ["purge.apply", { planId: "nope", keys: ["k0"] }],
        ["trash.status", {}],
        ["trash.empty", { trashId: "nope" }],
        ["shutdown", {}],
      ];
      // The command list is exactly the protocol's, so a new command cannot
      // ship without a test showing it answers.
      expect(COMMAND_TYPES.length).toBe(commands.length);

      const lines = commands.map(([type, args], index) =>
        cmd(`c${index}`, type, args),
      );
      const { frames } = await runServe(lines, {
        resolveConfig: async () =>
          resolvedFor(undefined, join(scratch, "config.toml")),
      });

      expect(answers(frames).length).toBe(commands.length);
      for (let index = 0; index < commands.length; index++) {
        const answer = answerFor(frames, `c${index}`);
        expect(typeof answer.ok).toBe("boolean");
      }
      // Every failure carries a fix, never a bare message.
      for (const answer of answers(frames)) {
        if (!answer.ok)
          expect((answer.error?.fix ?? "").length).toBeGreaterThan(0);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("twenty junk lines get twenty well-formed answers", async () => {
    const withIds = Array.from({ length: 8 }, (_, i) =>
      i % 2 === 0
        ? `{"v":1,"id":"j${i}","type":"volumes.list","args":{}}`
        : `{"v":9,"id":"j${i}","type":"nope","args":{}}`,
    );
    const withoutIds = [
      "not json at all",
      "{ this is not json",
      "",
      "   ",
      "[]",
      "42",
      "null",
      '"a string"',
      "{}",
      '{"type":"volumes.list","args":{}}',
      '{"v":1,"type":"volumes.list","args":{}}',
      "〔〕",
    ];
    const lines = [...withIds, ...withoutIds];
    expect(lines.length).toBe(20);

    const { frames, code } = await runServe(lines);
    const all = answers(frames);
    expect(all.length).toBe(20);
    for (const answer of all) {
      expect(answer.type).toBe("answer");
      expect(typeof answer.id).toBe("string");
      expect(answer.id.length).toBeGreaterThan(0);
    }
    for (let i = 0; i < 8; i++) {
      expect(answerFor(frames, `j${i}`).id).toBe(`j${i}`);
    }
    // No shutdown, so the loop simply ends at EOF and exits 0.
    expect(code).toBe(0);
  });

  test("a thrown handler becomes ok:false with a fix, and no stack on the wire", async () => {
    const { frames, raw } = await runServe([
      cmd("t1", "config.get", { key: "no-such-key" }),
    ]);
    const answer = answerFor(frames, "t1");
    expect(answer.ok).toBe(false);
    expect(answer.data).toBeUndefined();
    expect(answer.error?.message).toContain("unknown config key");
    expect((answer.error?.fix ?? "").length).toBeGreaterThan(0);

    const line = raw.find((entry) => entry.includes('"t1"')) ?? "";
    expect(line).not.toContain(".ts:");
    expect(line).not.toContain(" at ");
    expect(line).not.toContain("\\n    at");
  });

  test("an unknown command names the ones that exist", async () => {
    const { frames } = await runServe([cmd("u1", "volumes.listt")]);
    const answer = answerFor(frames, "u1");
    expect(answer.ok).toBe(false);
    expect(answer.error?.message).toContain("volumes.listt");
    expect(answer.error?.fix).toContain("volumes.list");
  });

  test("shutdown answers, then writes bye, and exits 0", async () => {
    const { frames, code } = await runServe([cmd("s1", "shutdown")]);
    expect(answerFor(frames, "s1").ok).toBe(true);
    const types = frames.map((frame) => frame.type);
    expect(types[0]).toBe("ready");
    expect(types[types.length - 1]).toBe("bye");
    expect(types.filter((type) => type === "bye").length).toBe(1);
    expect(code).toBe(0);
  });

  test("ready is written once, first, and says what the shell needs", async () => {
    const { frames } = await runServe([]);
    expect(frames.length).toBe(1);
    const ready = one(frames, "ready");
    expect(ready.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(ready.engineVersion).toBe("test");
    expect(ready.platform).toContain(process.platform);
    expect(ready.adbFound).toBe(false);
    expect(ready.destinationConfigured).toBe(false);
  });
});

// --- the transfer lifecycle -------------------------------------------------

describe("pull.start, once", () => {
  test("a second pull.start is refused with a readable reason", async () => {
    const c = collector();
    const frames = connect(c.sink);
    let starts = 0;
    const starter: PullStarter = async () => {
      starts += 1;
      // A run that never ends: the test is about the second call, not the first.
      return { summary: new Promise<EngineSummary>(() => {}) };
    };
    const runs = new RunController(frames, starter, 5_000);

    try {
      // `sink: c.sink` redirects the frames, so read them from `c`.
      await runServe(
        [
          cmd("p1", "pull.start", { mode: "keep" }),
          cmd("p2", "pull.start", { mode: "keep" }),
        ],
        {
          sink: c.sink,
          runs,
          adb: async () => fakeAdb(fakeDevice()),
          resolveConfig: async () =>
            resolvedFor(
              "/tmp/portage-not-a-drive",
              undefined,
              configuredDevice(),
            ),
        },
      );

      const all = c.frames();
      const first = answerFor(all, "p1");
      const second = answerFor(all, "p2");
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      expect(second.error?.code).toBe(2);
      expect(second.error?.message).toContain("already running");
      expect((second.error?.fix ?? "").length).toBeGreaterThan(0);
      expect(starts).toBe(1);
      expect(runs.running).toBe(true);
    } finally {
      runs.dispose();
    }
    expect(runs.running).toBe(false);
  });

  test("pause and resume answer immediately and say the effect is between files", async () => {
    const c = collector();
    const frames = connect(c.sink);
    const starter: PullStarter = async () => ({
      summary: new Promise<EngineSummary>(() => {}),
    });
    const runs = new RunController(frames, starter, 5_000);
    try {
      await runServe(
        [
          cmd("m0", "pull.start", { mode: "keep" }),
          cmd("m1", "pull.pause"),
          cmd("m2", "pull.resume"),
          cmd("m3", "pull.stop"),
        ],
        {
          sink: c.sink,
          runs,
          adb: async () => fakeAdb(fakeDevice()),
          resolveConfig: async () =>
            resolvedFor(
              "/tmp/portage-not-a-drive",
              undefined,
              configuredDevice(),
            ),
        },
      );
      const all = c.frames();
      expect(answerFor(all, "m0").ok).toBe(true);
      const paused = answerFor(all, "m1");
      expect(paused.ok).toBe(true);
      expect(JSON.stringify(paused.data)).toContain("between files");
      expect(answerFor(all, "m2").ok).toBe(true);
      expect(answerFor(all, "m3").ok).toBe(true);
    } finally {
      runs.dispose();
    }
  });

  test("pausing with no run is refused, not silently ignored", async () => {
    const { frames } = await runServe([cmd("n1", "pull.pause")]);
    const answer = answerFor(frames, "n1");
    expect(answer.ok).toBe(false);
    expect(answer.error?.message).toContain("no transfer is running");
  });
});

// --- a device with nothing configured ---------------------------------------

describe("a device with no source folders", () => {
  test("plan names the device and says nothing on it will be copied", async () => {
    const drive = await makeTempDrive("portage-serve-roots-");
    try {
      const device = fakeDevice();
      // An entry that exists and names NO root: the shape `config.set` writes
      // when a phone has been added to the app but no folder picked yet.
      const { frames } = await runServe([cmd("r1", "plan", {})], {
        adb: async () => fakeAdb(device),
        resolveConfig: async () =>
          resolvedFor(drive.root, undefined, {
            [device.id]: { label: "", roots: [], exclude: [] },
          }),
      });

      const answer = answerFor(frames, "r1");
      expect(answer.ok).toBe(true);
      expect(answer.data).toMatchObject({ fileCount: 0 });

      // The warning lives in the FRAME, which is what the plan screen renders;
      // the answer only counts it.
      //
      // Asserted by CONTENT, not by count. `buildPlan` also adds a warning when
      // it cannot vouch for the destination's free space, and whether it can
      // depends on the machine running the test (a container without
      // `util-linux`, a nearly full temp filesystem). Pinning the count made
      // this test pass here and fail on CI, which is a test bug, not a product
      // one — and the message names the siblings so the next failure says why.
      const plan = one(frames, "plan").plan;
      const rootsWarnings = plan.warnings.filter((warning) =>
        warning.includes("no source folders are configured"),
      );
      const others = plan.warnings.filter(
        (warning) => !warning.includes("no source folders are configured"),
      );
      expect(
        rootsWarnings.length,
        `the plan also warned: ${others.join(" | ")}`,
      ).toBe(1);
      const rootsWarning = rootsWarnings[0] ?? "";
      expect(rootsWarning).toContain(device.model);
      expect(rootsWarning).toContain("Phone folders");
    } finally {
      await drive.cleanup();
    }
  });

  test("pull.start refuses up front, and starts no run", async () => {
    const c = collector();
    const frames = connect(c.sink);
    let starts = 0;
    const starter: PullStarter = async () => {
      starts += 1;
      return { summary: new Promise<EngineSummary>(() => {}) };
    };
    const runs = new RunController(frames, starter, 5_000);
    try {
      await runServe(
        [cmd("r2", "pull.start", { mode: "keep" }), cmd("r3", "pull.pause")],
        {
          sink: c.sink,
          runs,
          adb: async () => fakeAdb(fakeDevice()),
          // No `devices` entry at all — the state a fresh install is in.
          resolveConfig: async () => resolvedFor("/tmp/portage-not-a-drive"),
        },
      );

      const all = c.frames();
      const refused = answerFor(all, "r2");
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe(2);
      expect(refused.error?.message).toBe(
        "no source folders are configured, so there is nothing to copy",
      );
      expect(refused.error?.fix).toBe(
        "add at least one folder on the Home screen (Phone folders), then start the pull again",
      );
      // The refusal is before the controller, so there is nothing to pause.
      expect(starts).toBe(0);
      expect(runs.running).toBe(false);
      expect(answerFor(all, "r3").error?.message).toContain(
        "no transfer is running",
      );
    } finally {
      runs.dispose();
    }
  });

  test("plan with no devices configured at all is still a read that succeeds", async () => {
    const drive = await makeTempDrive("portage-serve-plan-empty-");
    try {
      const { frames } = await runServe([cmd("r4", "plan", {})], {
        adb: async () => fakeAdb(fakeDevice()),
        resolveConfig: async () => resolvedFor(drive.root),
      });
      const answer = answerFor(frames, "r4");
      expect(answer.ok).toBe(true);
      expect(answer.data).toMatchObject({ fileCount: 0, bytesTotal: 0 });
    } finally {
      await drive.cleanup();
    }
  });
});

// --- the state frame --------------------------------------------------------

describe("snapshot()", () => {
  test("maps the view field for field and invents nothing", () => {
    view.screen = "dashboard";
    view.notice = "hello";
    view.rows = [
      {
        key: "dev1 /sdcard/a.mkv 12",
        srcPath: "/sdcard/a.mkv",
        destPath: "/drive/Anime/a.mkv",
        size: 12,
        bytes: 6,
        state: "copying",
        reason: "",
        startedAt: 1,
        lastProgressAt: 2,
        onDrive: false,
      },
    ];
    view.overall.bytesDone = 123;
    view.overall.bytesTotal = 456;
    view.overall.etaSeconds = null;
    view.devices = [
      {
        id: "dev1",
        model: "Pixel",
        android: "17",
        ready: true,
        linkMbps: 480,
        freeBytes: 1,
      },
    ];

    const snap = snapshot();
    expect(Object.keys(snap).sort()).toEqual([
      "devices",
      "notice",
      "overall",
      "rows",
      "screen",
    ]);
    expect(snap.screen).toBe("dashboard");
    expect(snap.notice).toBe("hello");
    expect(snap.overall.bytesDone).toBe(123);
    expect(snap.overall.bytesTotal).toBe(456);
    expect(snap.overall.etaSeconds).toBeNull();
    expect(snap.rows.length).toBe(1);
    expect(snap.devices[0]?.id).toBe("dev1");

    // Same fields as the view's row, no more and no fewer: a field added to the
    // engine's FileRow appears here without this mapping being edited.
    expect(Object.keys(snap.rows[0] ?? {}).sort()).toEqual(
      Object.keys(view.rows[0] ?? {}).sort(),
    );
    expect(Object.keys(snap.overall).sort()).toEqual(
      Object.keys(view.overall).sort(),
    );
    expect(Object.keys(snap.devices[0] ?? {}).sort()).toEqual(
      Object.keys(view.devices[0] ?? {}).sort(),
    );
  });

  test("a state frame carries the snapshot", async () => {
    const c = collector();
    const frames = connect(c.sink);
    view.rows = [];
    view.overall.bytesDone = 0;
    view.notice = null;
    frames.state();
    const state = one(c.frames(), "state");
    expect(state.rows).toEqual([]);
    expect(state.notice).toBeNull();
    expect(state.overall.bytesTotal).toBe(view.overall.bytesTotal);
  });
});

describe("the ETA is null until it can be honest", () => {
  test("null while the samples or the bytes are short, a number once both are met", () => {
    const file = planned("/sdcard/Movies/a.mkv", 1e9);
    const sink = new TransferSink();
    const t0 = Date.now();
    sink.begin(planOf([file]), [], 1);
    expect(view.overall.etaSeconds).toBeNull();

    sink.onFileEvent({ type: "start", file });
    let bytes = 0;
    for (const step of [300, 600, 900, 1200]) {
      bytes += 5_000_000;
      sink.onFileEvent({ type: "progress", file, bytes, total: 1e9 });
      sink.tick(t0 + step);
    }

    // Enough samples, not enough bytes: still null, and that is the point.
    expect(view.overall.samples).toBeGreaterThanOrEqual(ETA_MIN_SAMPLES);
    expect(view.overall.bytesDone).toBeLessThan(ETA_MIN_BYTES);
    expect(view.overall.etaSeconds).toBeNull();

    sink.onFileEvent({
      type: "progress",
      file,
      bytes: ETA_MIN_BYTES + 1_000_000,
      total: 1e9,
    });
    expect(typeof view.overall.etaSeconds).toBe("number");
  });
});

// --- the safety spine -------------------------------------------------------

function dupeMember(path: string, relative: string) {
  return {
    path,
    relative,
    size: 64,
    mtime: null,
    hash: null,
    score: null,
    scoreReason: null,
    keep: false,
    suspicious: null,
  };
}

/** A register that only this test can reach: no scan, no engine, fixed ids. */
function fixtureRegister(): PendingRegister {
  return new PendingRegister(
    60_000,
    () => 1_000_000,
    () => "scan-fixed",
  );
}

describe("trash.empty — the one permanent delete", () => {
  const trashOf = (root: string): string => join(root, ".portage", "trash");

  test("it asks before deleting, then frees the day folders AND the loose files", async () => {
    const drive = await makeTempDrive("portage-serve-trash-");
    try {
      const day = join(trashOf(drive.root), "2026-11-08", "Videos");
      await mkdir(day, { recursive: true });
      await Bun.write(join(day, "a.mkv"), new Uint8Array(2048).fill(0x41));
      // A file outside any day folder: the panel counts its bytes, so the
      // command has to be able to delete it.
      await Bun.write(join(trashOf(drive.root), "loose.mkv"), new Uint8Array(11).fill(0x42));

      const { frames } = await runServe(
        [
          cmd("t1", "trash.status", {}),
          cmd("t2", "trash.empty", { trashId: "scan-fixed" }),
          cmd("t3", "trash.empty", { trashId: "scan-fixed", confirm: "scan-fixed" }),
        ],
        { resolveConfig: async () => resolvedFor(drive.root), pending: fixtureRegister() },
      );

      const trashFrame = frames.find((f) => f.type === "trash");
      expect(trashFrame?.type === "trash" && trashFrame.totalFiles).toBe(2);
      expect(trashFrame?.type === "trash" && trashFrame.looseFiles).toBe(1);

      // The first call only asks.
      const asked = answerFor(frames, "t2");
      expect(asked.ok).toBe(true);
      expect((asked.data as Record<string, unknown>).needsConfirm).toBe(true);
      expect(frames.some((f) => f.type === "needsConfirm")).toBe(true);

      // The confirm frees both.
      const done = answerFor(frames, "t3");
      expect(done.ok).toBe(true);
      const data = done.data as Record<string, unknown>;
      expect(data.bytesFreed).toBe(2059);
      expect((data.refused as unknown[]).length).toBe(0);
      expect(await Bun.file(join(day, "a.mkv")).exists()).toBe(false);
      expect(await Bun.file(join(trashOf(drive.root), "loose.mkv")).exists()).toBe(false);
    } finally {
      await rm(drive.root, { recursive: true, force: true });
    }
  });

  test("a file that appeared after the reading makes it ASK again, not delete", async () => {
    const drive = await makeTempDrive("portage-serve-trash-stale-");
    try {
      const day = join(trashOf(drive.root), "2026-11-08");
      await mkdir(day, { recursive: true });
      await Bun.write(join(day, "a.mkv"), new Uint8Array(100).fill(0x41));

      const register = fixtureRegister();
      // 1) read
      await runServe([cmd("s1", "trash.status", {})], {
        resolveConfig: async () => resolvedFor(drive.root),
        pending: register,
      });
      // 2) something lands in the folder the reading described
      await Bun.write(join(day, "late.mkv"), new Uint8Array(50).fill(0x42));
      // 3) a confirm that was formed against the OLD numbers
      const { frames } = await runServe(
        [cmd("s2", "trash.empty", { trashId: "scan-fixed", confirm: "scan-fixed" })],
        { resolveConfig: async () => resolvedFor(drive.root), pending: register },
      );

      const answer = answerFor(frames, "s2");
      expect(answer.ok).toBe(true);
      expect((answer.data as Record<string, unknown>).needsConfirm).toBe(true);
      // Nothing was deleted by a sheet that never named `late.mkv`.
      expect(await Bun.file(join(day, "a.mkv")).exists()).toBe(true);
      expect(await Bun.file(join(day, "late.mkv")).exists()).toBe(true);
    } finally {
      await rm(drive.root, { recursive: true, force: true });
    }
  });

  test("a folder outside the reading is refused, and nothing is deleted", async () => {
    const drive = await makeTempDrive("portage-serve-trash-foreign-");
    try {
      const day = join(trashOf(drive.root), "2026-11-08");
      await mkdir(day, { recursive: true });
      await Bun.write(join(day, "a.mkv"), new Uint8Array(100).fill(0x41));

      const { frames } = await runServe(
        [
          cmd("f1", "trash.status", {}),
          cmd("f2", "trash.empty", { trashId: "scan-fixed", days: ["/etc"], confirm: "scan-fixed" }),
        ],
        { resolveConfig: async () => resolvedFor(drive.root), pending: fixtureRegister() },
      );

      const answer = answerFor(frames, "f2");
      expect(answer.ok).toBe(false);
      expect(await Bun.file(join(day, "a.mkv")).exists()).toBe(true);
    } finally {
      await rm(drive.root, { recursive: true, force: true });
    }
  });
});

describe("dupes.apply refuses without refusing the wrong thing", () => {
  test("a forged key, a stale scanId and a wrong confirm each move NOTHING", async () => {
    const drive = await makeTempDrive("portage-serve-apply-");
    try {
      await mkdir(join(drive.root, "Anime"), { recursive: true });
      const victim = join(drive.root, "Anime", "a.mkv");
      const keeper = join(drive.root, "Anime", "b.mkv");
      await Bun.write(victim, new Uint8Array(64).fill(0x41));
      await Bun.write(keeper, new Uint8Array(64).fill(0x42));

      const report: DupeReport = {
        groups: [
          {
            id: 1,
            tier: 1,
            reason: "byte-identical",
            label: null,
            reclaimableBytes: 64,
            members: [
              dupeMember(victim, "Anime/a.mkv"),
              dupeMember(keeper, "Anime/b.mkv"),
            ],
          },
        ],
        tier1Count: 1,
        tier2Count: 0,
        reclaimableBytes: 64,
        scannedFiles: 2,
        scannedBytes: 128,
        unparsed: [],
        truncated: [],
      };

      const pending = fixtureRegister();
      pending.insert({
        kind: "dupes",
        paths: new Map([
          ["k0", victim],
          ["k1", keeper],
        ]),
        sizes: new Map([
          ["k0", 64],
          ["k1", 64],
        ]),
        bytes: 128,
        trashDir: join(drive.root, ".portage", "trash", "1970-01-01"),
        destRoot: drive.root,
        report,
      });

      const { frames } = await runServe(
        [
          // Forged key, WITH a correct confirm: the key check must be what stops it.
          cmd("f1", "dupes.apply", {
            scanId: "scan-fixed",
            keys: ["k99"],
            confirm: "scan-fixed",
          }),
          // Right key, wrong confirm: the sheet comes back, nothing moves.
          cmd("f2", "dupes.apply", {
            scanId: "scan-fixed",
            keys: ["k0"],
            confirm: "something-else",
          }),
          // A scanId nobody issued.
          cmd("f3", "dupes.apply", {
            scanId: "never-issued",
            keys: ["k0"],
            confirm: "never-issued",
          }),
        ],
        { pending },
      );

      const forged = answerFor(frames, "f1");
      expect(forged.ok).toBe(false);
      expect(forged.error?.message).toContain("not part of this scan");
      expect((forged.error?.fix ?? "").length).toBeGreaterThan(0);

      const wrongConfirm = answerFor(frames, "f2");
      expect(wrongConfirm.ok).toBe(true);
      expect(JSON.stringify(wrongConfirm.data)).toContain("needsConfirm");
      const sheet = one(frames, "needsConfirm");
      expect(sheet.actionId).toBe("scan-fixed");
      expect(sheet.count).toBe(1);
      expect(sheet.paths).toEqual([victim]);
      expect(sheet.bytes).toBe(64);
      expect(sheet.trashDir).toContain("trash");

      const stale = answerFor(frames, "f3");
      expect(stale.ok).toBe(false);
      expect(stale.error?.message).toContain("not available any more");

      // The three refusals moved nothing, on the real filesystem.
      expect(await readdir(join(drive.root, "Anime"))).toEqual([
        "a.mkv",
        "b.mkv",
      ]);
      expect(await Bun.file(victim).exists()).toBe(true);
      expect(await Bun.file(keeper).exists()).toBe(true);
      // And the register was not partially consumed.
      expect(pending.size()).toBe(1);
      expect(pending.keys("scan-fixed").sort()).toEqual(["k0", "k1"]);
    } finally {
      await drive.cleanup();
    }
  });

  test("the matching confirm moves exactly the selected file, to the sheet's trash", async () => {
    const drive = await makeTempDrive("portage-serve-apply-ok-");
    try {
      await mkdir(join(drive.root, "Anime"), { recursive: true });
      const victim = join(drive.root, "Anime", "a.mkv");
      const keeper = join(drive.root, "Anime", "b.mkv");
      await Bun.write(victim, new Uint8Array(64).fill(0x41));
      await Bun.write(keeper, new Uint8Array(64).fill(0x42));

      const report: DupeReport = {
        groups: [
          {
            id: 1,
            tier: 1,
            reason: "byte-identical",
            label: null,
            reclaimableBytes: 64,
            members: [
              dupeMember(victim, "Anime/a.mkv"),
              dupeMember(keeper, "Anime/b.mkv"),
            ],
          },
        ],
        tier1Count: 1,
        tier2Count: 0,
        reclaimableBytes: 64,
        scannedFiles: 2,
        scannedBytes: 128,
        unparsed: [],
        truncated: [],
      };

      const trashDir = join(drive.root, ".portage", "trash", "1970-01-02");
      const pending = fixtureRegister();
      pending.insert({
        kind: "dupes",
        paths: new Map([
          ["k0", victim],
          ["k1", keeper],
        ]),
        sizes: new Map([
          ["k0", 64],
          ["k1", 64],
        ]),
        bytes: 128,
        trashDir,
        destRoot: drive.root,
        report,
      });

      const { frames } = await runServe(
        [
          cmd("ok1", "dupes.apply", {
            scanId: "scan-fixed",
            keys: ["k0"],
            confirm: "scan-fixed",
          }),
        ],
        { pending },
      );

      const answer = answerFor(frames, "ok1");
      expect(answer.ok).toBe(true);
      expect(await Bun.file(victim).exists()).toBe(false);
      expect(await Bun.file(keeper).exists()).toBe(true);
      expect(await Bun.file(join(trashDir, "Anime", "a.mkv")).exists()).toBe(
        true,
      );
      expect(one(frames, "notice").message).toContain("moved 1 file");
    } finally {
      await drive.cleanup();
    }
  });

  test("a record expires, and an expired id is refused", async () => {
    let clock = 5_000;
    const pending = new PendingRegister(
      1_000,
      () => clock,
      () => "expiring",
    );
    pending.insert({
      kind: "dupes",
      paths: new Map([["k0", "/tmp/x"]]),
      sizes: new Map([["k0", 1]]),
      bytes: 1,
      trashDir: null,
      destRoot: "/tmp",
    });
    expect(pending.get("expiring")).not.toBeNull();

    clock += 1_001;
    expect(pending.get("expiring")).toBeNull();
    expect(pending.size()).toBe(0);

    const { frames } = await runServe(
      [
        cmd("x1", "dupes.apply", {
          scanId: "expiring",
          keys: ["k0"],
          confirm: "expiring",
        }),
      ],
      { pending },
    );
    expect(answerFor(frames, "x1").ok).toBe(false);
    pending.clear();
  });
});

describe("purge.apply refuses without reaching the phone", () => {
  const candidate = {
    deviceId: "dev1",
    serial: "fakeserial",
    srcPath: "/sdcard/Movies/a.mkv",
    destPath: "/tmp/portage-not-a-drive/Movies/a.mkv",
    size: 4096,
    proof: "journal-hash" as const,
    hash: "a".repeat(64),
  };

  function purgeRegister(): PendingRegister {
    return new PendingRegister(
      60_000,
      () => Date.now(),
      () => "plan-fixed",
    );
  }

  function planFor(): PurgePlan {
    return {
      eligible: [candidate],
      refused: [],
      bytesReclaimed: candidate.size,
    };
  }

  test("a forged key, a stale planId and a wrong confirm delete NOTHING", async () => {
    const pending = purgeRegister();
    pending.insert({
      kind: "purge",
      paths: new Map([["k0", candidate.srcPath]]),
      sizes: new Map([["k0", candidate.size]]),
      bytes: candidate.size,
      trashDir: null,
      destRoot: "/tmp/portage-not-a-drive",
      plan: planFor(),
    });

    const { frames } = await runServe(
      [
        cmd("q1", "purge.apply", {
          planId: "plan-fixed",
          keys: ["k9"],
          confirm: "plan-fixed",
        }),
        cmd("q2", "purge.apply", {
          planId: "plan-fixed",
          keys: ["k0"],
          confirm: "wrong",
        }),
        cmd("q3", "purge.apply", {
          planId: "never-issued",
          keys: ["k0"],
          confirm: "never-issued",
        }),
      ],
      // No adb at all: if any refusal fell through to the phone, the answer
      // would say "adb is not available" instead of naming the key.
      { pending, adb: async () => null },
    );

    const forged = answerFor(frames, "q1");
    expect(forged.ok).toBe(false);
    expect(forged.error?.message).toContain("not part of this plan");
    expect(forged.error?.message).not.toContain("adb");

    const wrongConfirm = answerFor(frames, "q2");
    expect(wrongConfirm.ok).toBe(true);
    expect(JSON.stringify(wrongConfirm.data)).toContain("needsConfirm");
    const sheet = one(frames, "needsConfirm");
    expect(sheet.action).toBe("purge.apply");
    expect(sheet.paths).toEqual([candidate.srcPath]);
    // A purge deletes rather than moves, so there is no trash directory to name.
    expect(sheet.trashDir).toBeNull();

    const stale = answerFor(frames, "q3");
    expect(stale.ok).toBe(false);
    expect(stale.error?.message).toContain("not available any more");
    expect(stale.error?.message).not.toContain("adb");

    // Nothing was deleted, and nothing was even attempted.
    expect(frames.some((frame) => frame.type === "notice")).toBe(false);
    expect(pending.size()).toBe(1);
  });
});

// --- read-only commands, end to end ----------------------------------------

describe("the read-only commands do real work", () => {
  test("dupes.scan issues opaque keys, and apply walks the confirm gate", async () => {
    const drive = await makeTempDrive("portage-serve-scan-");
    try {
      await mkdir(join(drive.root, "Anime"), { recursive: true });
      await Bun.write(
        join(drive.root, "Anime", "a.mkv"),
        new Uint8Array(4096).fill(0x41),
      );
      await Bun.write(
        join(drive.root, "Anime", "b.mkv"),
        new Uint8Array(4096).fill(0x41),
      );

      const c = collector();
      const frames = connect(c.sink);
      const pending = new PendingRegister();
      const ctx = createContext({
        frames,
        pending,
        logger: silentLogger,
        resolveConfig: async () => resolvedFor(drive.root),
        adb: async () => null,
      });

      await dispatch(cmd("d1", "dupes.scan", {}), ctx);
      const dupes = one(c.frames(), "dupes");
      expect(dupes.groups.length).toBe(1);
      const member = dupes.groups[0]!;
      expect(member.members.length).toBe(2);
      const keys = member.members.map((m) => m.key);
      // A key names no path: that is the whole safety property.
      for (const key of keys) expect(key).not.toContain("/");

      const before = (await readdir(join(drive.root, "Anime"))).sort();

      await dispatch(
        cmd("d2", "dupes.apply", { scanId: dupes.scanId, keys: [keys[0]!] }),
        ctx,
      );
      const sheet = one(c.frames(), "needsConfirm");
      expect(sheet.actionId).toBe(dupes.scanId);
      expect(sheet.count).toBe(1);
      expect(sheet.paths.length).toBe(1);
      expect(sheet.paths[0]).toContain(drive.root);
      expect(sheet.trashDir).toContain(join(".portage", "trash"));
      expect((await readdir(join(drive.root, "Anime"))).sort()).toEqual(before);

      await dispatch(
        cmd("d3", "dupes.apply", {
          scanId: dupes.scanId,
          keys: [keys[0]!],
          confirm: dupes.scanId,
        }),
        ctx,
      );
      const applied = answerFor(c.frames(), "d3");
      expect(applied.ok).toBe(true);
      const after = (await readdir(join(drive.root, "Anime"))).sort();
      expect(after.length).toBe(1);
    } finally {
      await drive.cleanup();
    }
  });

  test("db.export writes the journal as JSONL", async () => {
    const drive = await makeTempDrive("portage-serve-export-");
    try {
      const target = join(drive.root, "export.jsonl");
      const { frames } = await runServe(
        [cmd("e1", "db.export", { path: target })],
        {
          resolveConfig: async () => resolvedFor(drive.root),
        },
      );
      expect(answerFor(frames, "e1").ok).toBe(true);
      const written = await readFile(target, "utf8");
      // A journal with nothing in it exports a valid, non-empty payload.
      expect(written.length).toBeGreaterThan(0);
      expect(target).toContain("export.jsonl");
    } finally {
      await drive.cleanup();
    }
  });

  test("status.get reads the journal the engine writes", async () => {
    const drive = await makeTempDrive("portage-serve-status-");
    try {
      const { frames } = await runServe([cmd("st1", "status.get", {})], {
        resolveConfig: async () => resolvedFor(drive.root),
      });
      const answer = answerFor(frames, "st1");
      expect(answer.ok).toBe(true);
      const status = one(frames, "status");
      expect(status.archive.files).toBe(0);
      expect(Array.isArray(status.runs)).toBe(true);
      expect(Array.isArray(status.recent)).toBe(true);
      expect(Array.isArray(status.pending)).toBe(true);
    } finally {
      await drive.cleanup();
    }
  });

  test("a command with no destination answers with the fix, not a crash", async () => {
    const { frames } = await runServe([cmd("z1", "status.get")]);
    const answer = answerFor(frames, "z1");
    expect(answer.ok).toBe(false);
    expect(answer.error?.message).toContain("no destination configured");
    expect(answer.error?.fix).toContain("dest_root");
  });
});

// --- browse -----------------------------------------------------------------

describe("browse", () => {
  test("refuses the desktop mount and names the adb path to use instead", async () => {
    for (const path of [
      "/run/user/1000/gvfs/mtp:host=Pixel_10/Internal storage/DCIM",
      "mtp://[usb:001,002]/Internal storage",
      "/media/user/Pixel%3AInternal/Movies",
    ]) {
      const { frames } = await runServe([cmd("b1", "browse", { path })]);
      const answer = answerFor(frames, "b1");
      expect(answer.ok).toBe(false);
      expect(answer.error?.message).toContain("desktop mount");
      expect(answer.error?.fix).toContain("/sdcard");
      expect(frames.some((frame) => frame.type === "browse")).toBe(false);
    }
  });

  test("browse quoting matches the apull script's sq()", async () => {
    const { quoteShellArg } = await import("../src/serve/browse.ts");
    expect(quoteShellArg("/sdcard/Download/Move")).toBe(
      "'/sdcard/Download/Move'",
    );
    expect(quoteShellArg("/sdcard/It's here")).toBe("'/sdcard/It'\\''s here'");
    expect(quoteShellArg("/sdcard/a b/c[1]")).toBe("'/sdcard/a b/c[1]'");
  });

  test("a level lists directories then files, quotes the path, and says when it truncated", async () => {
    const { browseLevel, BROWSE_LIMIT } =
      await import("../src/serve/browse.ts");
    const commands: string[] = [];
    const spawn: SpawnFn = async (command) => {
      const shell = command[command.length - 1] ?? "";
      commands.push(shell);
      const stdout = shell.includes("-type d")
        ? "Anime\nMusic\nPhotos\n"
        : "1024\ta.mkv\n2048\tb.txt\n";
      return { code: 0, stdout, stderr: "", durationMs: 1 };
    };
    const adb = new Adb("/bin/true", spawn);

    const level = await browseLevel(adb, "serial", "/sdcard/Download/Move");
    expect(level.total).toBe(5);
    expect(level.truncated).toBe(false);
    expect(level.entries.map((entry) => entry.name)).toEqual([
      "Anime",
      "Music",
      "Photos",
      "a.mkv",
      "b.txt",
    ]);
    expect(level.entries[0]?.kind).toBe("dir");
    expect(level.entries[0]?.size).toBeNull();
    expect(level.entries[3]?.kind).toBe("file");
    expect(level.entries[3]?.size).toBe(1024);
    expect(level.entries[3]?.path).toBe("/sdcard/Download/Move/a.mkv");
    // The path reaches the device single-quoted and with `-H`, exactly as apull
    // does it, because /sdcard is a symlink.
    expect(
      commands.every((shell) =>
        shell.includes("find -H '/sdcard/Download/Move'"),
      ),
    ).toBe(true);

    const capped = await browseLevel(adb, "serial", "/sdcard/Download/Move", 2);
    expect(capped.entries.length).toBe(2);
    expect(capped.total).toBe(5);
    expect(capped.truncated).toBe(true);
    expect(BROWSE_LIMIT).toBeGreaterThan(2);
  });

  test("a level that cannot be listed says so instead of reading as empty", async () => {
    const { browseLevel } = await import("../src/serve/browse.ts");
    const spawn: SpawnFn = async () => ({
      code: 1,
      stdout: "",
      stderr: "No such file or directory",
      durationMs: 1,
    });
    const adb = new Adb("/bin/true", spawn);
    await expect(
      browseLevel(adb, "serial", "/sdcard/not-there"),
    ).rejects.toThrow(/could not be listed/);
  });
});

// --- helpers used only above ------------------------------------------------

function planned(srcPath: string, size: number): PlannedFile {
  return {
    candidate: {
      deviceId: "dev1",
      deviceLabel: "Pixel 10 Pro XL",
      serial: "fakeserial",
      srcPath,
      root: "/sdcard/Movies",
      relative: srcPath.replace("/sdcard/Movies/", ""),
      size,
      mtime: 1_700_000_000,
      verdict: "new",
      reason: "new",
    },
    destPath: `/drive/Anime/${srcPath.split("/").pop()}`,
    destNorm: `/drive/anime/${srcPath.split("/").pop()}`,
    matchesArchive: null,
    alreadyTransferred: false,
    bytes: size,
  };
}

function planOf(files: PlannedFile[]): PlanResult {
  return {
    destRoot: "/drive/Anime",
    files,
    toTransfer: files,
    skipped: [],
    bytesTotal: files.reduce((total, file) => total + file.bytes, 0),
    bytesSkipped: 0,
    bytesExcluded: 0,
    fileCount: files.length,
    etaSeconds: null,
    space: {
      ok: true,
      status: "ok",
      freeBytes: 1e12,
      totalBytes: 2e12,
      usedFraction: 0.5,
    },
    warnings: [],
  };
}

afterEach(() => {
  // The view is a module singleton shared with other test files; leave it sane.
  view.rows = [];
  view.devices = [];
  view.notice = null;
});

// --- the process itself ------------------------------------------------------

describe("the serve process", () => {
  /**
   * `bye` has to mean the process ENDS.
   *
   * `shutdown` stops the loop without waiting for EOF, and a caller usually
   * leaves stdin open. The loop returned 0 while its stdin reader was still
   * locked, so the runtime kept the event loop alive and a `bye`d engine sat
   * there forever — a clean exit that never happened. The shell kills the child
   * on its way out, which is exactly why this stayed invisible.
   */
  test("exits 0 after shutdown with stdin still open", async () => {
    const home = await mkdtemp(join(tmpdir(), "portage-serve-exit-"));
    const child = Bun.spawn({
      cmd: ["bun", "run", "src/serve/main.ts", "serve"],
      cwd: join(import.meta.dir, ".."),
      env: { ...Bun.env, HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = child.stdout as ReadableStream<Uint8Array>;
    const decoder = new TextDecoder();
    let written = "";
    const reading = (async () => {
      for await (const chunk of stdout) written += decoder.decode(chunk);
    })();

    const sink = child.stdin as unknown as {
      write(chunk: string): void;
      flush?(): Promise<number>;
    };
    sink.write(`${cmd("bye1", "shutdown")}\n`);
    await sink.flush?.();

    const code = await Promise.race([
      child.exited,
      Bun.sleep(15_000).then(() => "timeout" as const),
    ]);
    if (code === "timeout") child.kill();
    await reading.catch(() => undefined);
    await rm(home, { recursive: true, force: true });

    expect(written).toContain('"type":"bye"');
    expect(code).toBe(0);
  }, 30_000);
});

// --- marker files -----------------------------------------------------------

describe("a folder marker is never copied", () => {
  /**
   * `scan` classifies a file from its name and size. `.nomedia` is a 0-byte
   * marker on Android that means "do not index this folder"; it is not media,
   * and copying it to the archive is pure noise.
   *
   * `src/scan/classify()` has a branch for it, but the branch tests
   * `extname(path) === ".nomedia"` — and `extname(".nomedia")` is `""`, because
   * a leading dot marks a hidden file rather than an extension. The branch is
   * unreachable. `src/scan` is frozen by the acceptance gate, so `dispatch.ts`
   * re-labels markers before a plan can see them, and this test holds that.
   */
  async function planWith(files: DeviceFile[]) {
    const drive = await makeTempDrive("portage-serve-markers-");
    const device = fakeDevice();
    const adb = {
      devices: async () => [device],
      walk: async () => files,
    } as unknown as Adb;
    const { frames } = await runServe([cmd("mk", "plan", {})], {
      adb: async () => adb,
      resolveConfig: async () =>
        resolvedFor(drive.root, undefined, {
          [device.id]: { label: "", roots: ["/sdcard/Movies"], exclude: [] },
        }),
    });
    return { plan: one(frames, "plan").plan, drive };
  }

  /** Old enough that `quiet_seconds` cannot be the reason it was skipped. */
  function file(path: string, size: number): DeviceFile {
    return { path, size, mtime: Math.floor(Date.now() / 1000) - 86_400 };
  }

  test("the marker is reported as skipped, not silently dropped", async () => {
    const { plan, drive } = await planWith([
      file("/sdcard/Movies/.nomedia", 0),
      file("/sdcard/Movies/a.mkv", 1024),
    ]);
    try {
      expect(plan.toTransfer.map((entry) => entry.candidate.srcPath)).toEqual([
        "/sdcard/Movies/a.mkv",
      ]);
      const marker = plan.skipped.find(
        (entry) => entry.candidate.srcPath === "/sdcard/Movies/.nomedia",
      );
      // Reported, with a reason a person can act on. Silence would make the
      // plan's counts disagree with the phone.
      expect(marker?.skipReason ?? marker?.candidate.reason).toContain(
        "marker",
      );
    } finally {
      await drive.cleanup();
    }
  });

  test("a non-empty marker and a stray Thumbs.db are skipped too", async () => {
    const { plan, drive } = await planWith([
      file("/sdcard/Movies/.nomedia", 37),
      file("/sdcard/Movies/Thumbs.db", 8192),
      file("/sdcard/Movies/b.mkv", 2048),
    ]);
    try {
      expect(
        plan.toTransfer.map((entry) => entry.candidate.srcPath).sort(),
      ).toEqual(["/sdcard/Movies/b.mkv"]);
      expect(plan.fileCount).toBe(1);
    } finally {
      await drive.cleanup();
    }
  });

  test("a file whose name merely contains the word is still copied", async () => {
    const { plan, drive } = await planWith([
      file("/sdcard/Movies/not-a-nomedia-file.mkv", 4096),
    ]);
    try {
      expect(plan.toTransfer).toHaveLength(1);
    } finally {
      await drive.cleanup();
    }
  });
});

// --- purge freshness --------------------------------------------------------

describe("a purge plan is checked against the drive before it is offered", () => {
  /**
   * `planPurge` trusts the journal's stored hash unless `verifyHash` is set, so
   * a drive copy deleted by hand since the transfer would still be offered for
   * deletion — the plan would describe a file that is not there and claim it is
   * covered. `withFreshDriveCopies` closes that, locally, on the serve seam.
   */
  function candidate(destPath: string, size: number) {
    return {
      deviceId: "dev",
      serial: "serial",
      srcPath: `/sdcard/Download/${destPath.split("/").pop()}`,
      destPath,
      size,
      proof: "journal-hash" as const,
      hash: "deadbeef",
    };
  }

  test("a candidate whose drive copy exists survives", async () => {
    const drive = await makeTempDrive("portage-purge-fresh-");
    try {
      const present = join(drive.root, "here.mkv");
      await Bun.write(present, "bytes");
      const plan = await withFreshDriveCopies({
        eligible: [candidate(present, 5)],
        refused: [],
        bytesReclaimed: 5,
      });
      expect(plan.eligible).toHaveLength(1);
      expect(plan.refused).toHaveLength(0);
      expect(plan.bytesReclaimed).toBe(5);
    } finally {
      await drive.cleanup();
    }
  });

  test("a candidate whose drive copy is gone is refused, with a reason", async () => {
    const drive = await makeTempDrive("portage-purge-stale-");
    try {
      const present = join(drive.root, "here.mkv");
      const missing = join(drive.root, "gone.mkv");
      await Bun.write(present, "bytes");
      const plan = await withFreshDriveCopies({
        eligible: [candidate(present, 5), candidate(missing, 700)],
        refused: [{ srcPath: "/sdcard/Download/other.mkv", reason: "no stored hash" }],
        bytesReclaimed: 705,
      });

      expect(plan.eligible.map((entry) => entry.destPath)).toEqual([present]);
      // Refused rather than dropped: silently removing it would make the counts
      // disagree with what the person is looking at.
      expect(plan.refused.map((entry) => entry.srcPath)).toContain(
        "/sdcard/Download/gone.mkv",
      );
      expect(plan.refused.find((e) => e.srcPath.endsWith("gone.mkv"))?.reason).toContain(
        "drive copy is gone",
      );
      // The existing refusal is kept, and the byte total follows the survivors.
      expect(plan.refused).toHaveLength(2);
      expect(plan.bytesReclaimed).toBe(5);
    } finally {
      await drive.cleanup();
    }
  });

  test("a plan with nothing left reports zero bytes, not the stale total", async () => {
    const drive = await makeTempDrive("portage-purge-all-gone-");
    try {
      const plan = await withFreshDriveCopies({
        eligible: [candidate(join(drive.root, "a.mkv"), 100)],
        refused: [],
        bytesReclaimed: 100,
      });
      expect(plan.eligible).toHaveLength(0);
      expect(plan.bytesReclaimed).toBe(0);
      expect(plan.refused).toHaveLength(1);
    } finally {
      await drive.cleanup();
    }
  });
});

// --- unreadable reads -------------------------------------------------------

describe("unreadable reads", () => {
  const DEADLINE_MS = 50;
  const NEVER = () => new Promise<never>(() => {});
  /** A drive read that never answers, cut at the 50 ms deadline. */
  const stalledStat: typeof statDrive = (root, path) =>
    probe(root, `stat ${path}`, NEVER, DEADLINE_MS);

  afterEach(() => resetDriveState());

  function purgeCandidate(destPath: string) {
    return {
      deviceId: "dev",
      serial: "serial",
      srcPath: `/sdcard/Download/${destPath.split("/").pop()}`,
      destPath,
      size: 5,
      proof: "journal-hash" as const,
      hash: "deadbeef",
    };
  }

  function planOf(destPath: string): PurgePlan {
    return { eligible: [purgeCandidate(destPath)], refused: [], bytesReclaimed: 5 };
  }

  test("dispatch purge refuses an unreadable drive copy", async () => {
    const drive = await makeTempDrive("portage-unreadable-purge-");
    try {
      const dest = join(drive.root, "here.mkv");
      await Bun.write(dest, "bytes");
      const plan = await withFreshDriveCopies(planOf(dest), drive.root, {
        statDrive: stalledStat,
      });
      expect(plan.eligible).toHaveLength(0);
      expect(plan.refused.map((r) => r.reason)).toEqual(["drive copy unreadable"]);

      const gone = await withFreshDriveCopies(
        planOf(join(drive.root, "gone.mkv")),
        drive.root,
      );
      expect(gone.refused[0]?.reason).toBe(
        "the drive copy is gone — nothing was deleted",
      );
    } finally {
      await drive.cleanup();
    }
  });

  test("applyPurge refuses an unreadable drive copy", async () => {
    const drive = await makeTempDrive("portage-unreadable-apply-");
    const journal = Journal.open(drive.root);
    try {
      const removed: string[] = [];
      const options = (root: string, stat?: typeof statDrive) =>
        ({
          journal,
          transport: {
            removeSource: async (_serial: string, path: string) => {
              removed.push(path);
              return true;
            },
          },
          verifyHash: false,
          dryRun: false,
          apply: true,
          root,
          ...(stat ? { statDrive: stat } : {}),
        }) as unknown as Parameters<typeof applyPurge>[1];
      const dest = join(drive.root, "here.mkv");
      await Bun.write(dest, "bytes");

      const stalled = await applyPurge(planOf(dest), options(drive.root, stalledStat));
      expect(stalled).toEqual({ deleted: 0, failed: 1 });
      const missing = await applyPurge(
        planOf(join(drive.root, "gone.mkv")),
        options(drive.root),
      );
      expect(missing).toEqual({ deleted: 0, failed: 1 });
      const messages = journal.recentEvents(10).map((e) => e.msg);
      expect(messages.some((m) => m.includes("drive copy unreadable"))).toBe(true);
      expect(messages.some((m) => m.includes("drive copy no longer exists"))).toBe(true);
      expect(removed).toEqual([]);
    } finally {
      journal.close();
      await drive.cleanup();
    }
  });

  test("a directory in place of a drive copy is refused as not a file", async () => {
    const drive = await makeTempDrive("portage-unreadable-dir-");
    try {
      const dest = join(drive.root, "folder.mkv");
      await mkdir(dest);
      const plan = await withFreshDriveCopies(planOf(dest), drive.root);
      expect(plan.eligible).toHaveLength(0);
      expect(plan.refused.map((r) => r.reason)).toEqual([
        "the drive copy is not a file — nothing was deleted",
      ]);
    } finally {
      await drive.cleanup();
    }
  });

  async function doctorRows(
    root: string,
    deps: NonNullable<DoctorContext["deps"]>,
  ): Promise<Array<{ label: string; value: string }>> {
    const capture = captureOutput();
    await doctor({
      resolved: resolvedFor(root),
      adb: null,
      output: capture.output,
      bench: false,
      deps,
    });
    const last = capture.payloads.at(-1) as {
      checks: Array<{ label: string; value: string }>;
    };
    return last.checks;
  }

  const dfOk = (cmd: string[]) =>
    cmd[0] === "df"
      ? Promise.resolve({ code: 0, stdout: "B Avail\n1000 900\n", stderr: "", durationMs: 1 })
      : NEVER();

  test("Doctor destination row reads an unreadable root as could not be read", async () => {
    const drive = await makeTempDrive("portage-unreadable-doctor-");
    try {
      const rows = await doctorRows(drive.root, { statDrive: stalledStat, spawn: dfOk });
      const row = rows.find((r) => r.label === "destination");
      expect(row?.value).toContain("the destination could not be read");
      expect(row?.value).not.toContain("does not exist");

      const gone = await doctorRows(join(drive.root, "nope"), {});
      expect(gone.find((r) => r.label === "destination")?.value).toContain(
        "does not exist",
      );
    } finally {
      await drive.cleanup();
    }
  });

  test("Doctor mount check reads a timed-out findmnt as could not be read", async () => {
    const drive = await makeTempDrive("portage-unreadable-mount-");
    try {
      const rows = await doctorRows(drive.root, {
        spawn: dfOk,
        timeoutMs: DEADLINE_MS,
      });
      const text = rows.map((r) => r.value).join("\n");
      expect(text).toContain("the mount check could not be read");
      expect(text).not.toContain("unknown filesystem");
      expect(text).not.toContain("is mounted read-only");
    } finally {
      await drive.cleanup();
    }
  });

  test("a status request is answered while a purge probe never resolves", async () => {
    const drive = await makeTempDrive("portage-unreadable-status-");
    try {
      const c = collector();
      const ctx = createContext({
        frames: connect(c.sink),
        logger: silentLogger,
        resolveConfig: async () => resolvedFor(drive.root),
        adb: async () => null,
      });
      const dest = join(drive.root, "here.mkv");
      await Bun.write(dest, "bytes");
      const started = performance.now();
      const purge = withFreshDriveCopies(planOf(dest), drive.root, {
        statDrive: stalledStat,
      });
      await dispatch(cmd("s1", "status", {}), ctx);
      const elapsed = performance.now() - started;

      expect(answerFor(c.frames(), "s1").ok).toBe(true);
      expect(elapsed).toBeLessThan(DEADLINE_MS);
      expect((await purge).refused.map((r) => r.reason)).toEqual([
        "drive copy unreadable",
      ]);
    } finally {
      await drive.cleanup();
    }
  });
});
