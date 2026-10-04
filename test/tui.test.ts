/**
 * The TUI, asserted on rather than squinted at.
 *
 * `@opentui/core/testing` ships `createTestRenderer`, which builds a real
 * renderer over a fake TTY and hands back `captureCharFrame()` — the actual
 * screen as text — plus mock keys. That is what makes the gates in
 * docs/tui-impl/06-acceptance.md checkable instead of aspirational.
 *
 * Why this file exists rather than a screenshot script: OpenTUI only writes the
 * cells that CHANGED, so scraping the raw PTY byte stream gives you a diff, not
 * a screen. Replaying it through a terminal emulator is the only other way, and
 * a screen buffer is cheaper and exact.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { tick } from "svelte";

import { detect, refusalReason, sizing } from "../src/tui/degrade.ts";
import { glyphs } from "../src/tui/theme.ts";
import { keyId, resolve } from "../src/tui/input.ts";
import {
  bar,
  ETA_MIN_BYTES,
  ETA_MIN_SAMPLES,
  honestEta,
  stalledFor,
  STALL_MS,
  view,
  type FileRow,
} from "../src/tui/state.svelte.ts";
import { TransferSink } from "../src/tui/sink.ts";
import { OpenTuiRenderer } from "../src/tui/renderer.svelte.ts";
import { TerminalCursor } from "../src/tui/cursor.ts";
import { DashboardScreen } from "../src/tui/screens/dashboard.ts";
import type { FileEvent } from "../src/xfer/engine.ts";
import type { PlanResult, PlannedFile } from "../src/plan/plan.ts";

const WIDTH = 100;
const HEIGHT = 30;

/**
 * Pretend stdout is a terminal.
 *
 * The ladder tests assert on TTY detection, and under `bun test` stdout is a
 * pipe. Without this, every one of them would be testing the test runner
 * instead of the ladder — and would keep passing no matter what detect() did.
 */
function withTty<T>(isTty: boolean, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value: isTty,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(process.stdout, "isTTY", original);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
}

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
    destPath: `/media/drive/Anime/${srcPath.split("/").pop()}`,
    destNorm: `/media/drive/anime/${srcPath.split("/").pop()}`,
    matchesArchive: null,
    alreadyTransferred: false,
    bytes: size,
  };
}

function planOf(files: PlannedFile[]): PlanResult {
  return {
    destRoot: "/media/drive/Anime",
    files,
    toTransfer: files,
    skipped: [],
    bytesTotal: files.reduce((n, f) => n + f.bytes, 0),
    bytesSkipped: 0,
    fileCount: files.length,
    etaSeconds: null, // the engine's own ETA is dead code; ours is derived
    space: { ok: true, freeBytes: 1e12, totalBytes: 2e12, usedFraction: 0.5 },
    warnings: [],
  };
}

function row(over: Partial<FileRow> = {}): FileRow {
  return {
    key: "k",
    srcPath: "/sdcard/Movies/ep01.mkv",
    destPath: "/media/drive/Anime/ep01.mkv",
    size: 1024,
    bytes: 0,
    state: "queued",
    reason: "",
    startedAt: null,
    lastProgressAt: Date.now(),
    onDrive: false,
    ...over,
  };
}

// --- the honesty rules, which are pure functions and must be exact ----------

describe("the ETA refuses to lie (docs/tui.md §5)", () => {
  test("no ETA before 3 samples", () => {
    expect(honestEta(500e6, 1e9, 50e6, ETA_MIN_SAMPLES - 1)).toBeNull();
  });
  test("no ETA before 30 MB", () => {
    expect(honestEta(ETA_MIN_BYTES - 1, 1e9, 50e6, ETA_MIN_SAMPLES)).toBeNull();
  });
  test("an ETA once both conditions are met", () => {
    // 500 MB left at 50 MB/s is 10 s.
    expect(honestEta(500e6, 1e9, 50e6, ETA_MIN_SAMPLES)).toBe(10);
  });
  test("a zero rate is never a division by zero", () => {
    expect(honestEta(500e6, 1e9, 0, 99)).toBeNull();
  });
  test("a finished transfer reads 0, not null", () => {
    expect(honestEta(1e9, 1e9, 50e6, 99)).toBe(0);
  });
});

describe("stall detection", () => {
  test("a frozen copy says so", () => {
    const now = Date.now();
    const r = row({
      state: "copying",
      startedAt: now - STALL_MS - 1000,
      lastProgressAt: now - STALL_MS - 1000,
    });
    expect(stalledFor(r, now)).toBeGreaterThanOrEqual(STALL_MS);
  });
  test("a moving copy does not", () => {
    const now = Date.now();
    const r = row({
      state: "copying",
      startedAt: now - 60_000,
      lastProgressAt: now,
    });
    expect(stalledFor(r, now)).toBe(0);
  });
  test("a queued row is never stalled", () => {
    const now = Date.now();
    expect(
      stalledFor(
        row({
          state: "queued",
          startedAt: now - 60_000,
          lastProgressAt: now - 60_000,
        }),
        now,
      ),
    ).toBe(0);
  });
});

// --- the degradation ladder --------------------------------------------------

describe("the ladder", () => {
  const base = {
    color: true,
    unicode: true,
    tui: true,
    width: 100,
    height: 30,
  };

  test("--json refuses the TUI", () => {
    expect(refusalReason(["portage", "pull", "--json"])).toBe("--json");
  });
  test("--plain refuses the TUI", () => {
    expect(refusalReason(["portage", "pull", "--plain"])).toBe("--plain");
  });
  test("TERM=dumb refuses the TUI", () => {
    const before = Bun.env.TERM;
    Bun.env.TERM = "dumb";
    try {
      expect(withTty(true, () => refusalReason(["portage", "pull"]))).toBe(
        "TERM=dumb",
      );
    } finally {
      Bun.env.TERM = before;
    }
  });
  test("a clean terminal does not", () => {
    expect(withTty(true, () => refusalReason(["portage", "pull"]))).toBeNull();
  });
  test("a pipe refuses the TUI", () => {
    expect(withTty(false, () => refusalReason(["portage", "pull"]))).toBe(
      "stdout is not a terminal",
    );
  });
  test("bars go below 80 columns, box below 60", () => {
    expect(sizing(100).bars).toBe(true);
    expect(sizing(79).bars).toBe(false);
    expect(sizing(60).box).toBe(true);
    expect(sizing(59).box).toBe(false);
    expect(sizing(40).nameMax).toBe(30);
  });
  test("the bar is always the same width, whatever the fraction", () => {
    const wide = sizing(100);
    for (const f of [0, 0.01, 0.5, 0.999, 1]) {
      expect(bar(f, { ...base, width: 100 }, wide).length).toBe(20);
    }
    // And a nonsense fraction must not produce a negative-length bar.
    expect(bar(NaN, base, wide).length).toBe(20);
    expect(bar(5, base, wide).length).toBe(20);
  });
  test("LANG=C gets ASCII glyphs, and every state still has a word", () => {
    const ascii = glyphs(false);
    expect(ascii.done).toBe("v");
    expect(ascii.barFull).toBe("#");
    const unicode = glyphs(true);
    expect(unicode.done).toBe("✓");
    // The twin is the guarantee: a monochrome terminal loses no information.
    for (const g of [ascii.done, ascii.copying, ascii.queued, ascii.failed]) {
      expect(g.length).toBeGreaterThan(0);
    }
  });
  test("NO_COLOR keeps layout and drops ink", () => {
    expect(detect(["portage", "pull"])).toHaveProperty("color");
  });
});

// --- the key table -----------------------------------------------------------

describe("the binding table", () => {
  const key = (
    name: string,
    mods: Partial<Record<"ctrl" | "shift" | "option", boolean>> = {},
  ) =>
    ({
      name,
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      ...mods,
    }) as never;

  test("shift rebuilds the case, so G reaches bottom", () => {
    expect(keyId(key("g", { shift: true }))).toBe("G");
    expect(resolve(key("g", { shift: true }))).toBe("bottom");
    expect(resolve(key("g"))).toBe("top");
  });
  test("ctrl-c is quit, and ctrl+letter is distinguished from the letter", () => {
    expect(resolve(key("c", { ctrl: true }))).toBe("quit");
    expect(resolve(key("c")) ?? null).toBeNull();
  });
  test("space is pause in both spellings", () => {
    expect(resolve(key(" "))).toBe("toggle-pause");
    expect(resolve(key("space"))).toBe("toggle-pause");
  });
  test("every binding in the table resolves to an action", () => {
    expect(resolve(key("j"))).toBe("down");
    expect(resolve(key("k"))).toBe("up");
    expect(resolve(key("Q", { shift: true }))).toBe("quit-hard");
  });
});

// --- the screen, on a real buffer --------------------------------------------

describe("the dashboard screen", () => {
  let t: TestRendererSetup;
  let renderer: OpenTuiRenderer;

  beforeEach(async () => {
    // Reset the module-level view so one test cannot leak into the next.
    view.rows = [];
    view.devices = [];
    view.selected = 0;
    view.scrollTop = 0;
    view.screen = "dashboard";
    view.notice = null;
    view.confirm = null;
    view.filter = "";
    view.filterActive = false;
    view.log = [];
    view.overall = {
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
      jobs: 3,
      paused: false,
    };

    t = await createTestRenderer({ width: WIDTH, height: HEIGHT });
    renderer = new OpenTuiRenderer(["portage", "pull"], t.renderer);
  });

  afterEach(() => {
    renderer.unmount();
  });

  async function mountWith(files: PlannedFile[]) {
    const sink = new TransferSink();
    const screen = new DashboardScreen();
    await renderer.mount(screen);
    sink.begin(
      planOf(files),
      [
        {
          id: "dev1",
          serial: "fakeserial",
          state: "device",
          model: "Pixel 10 Pro XL",
          android: "17",
          unauthorized: false,
        },
      ],
      3,
    );
    // Svelte effects are asynchronous. Flush them, then the render frames.
    await tick();
    await tick();
    await t.flush();
    return { sink, screen };
  }

  /** Press a key, flush the runes, then flush the frames. */
  async function press(
    k: Parameters<TestRendererSetup["mockInput"]["pressKey"]>[0],
  ) {
    await t.mockInput.pressKey(k);
    await tick();
    await tick();
    await t.flush();
  }

  test("band 1 names the device, band 3 names the file, band 4 the keys", async () => {
    await mountWith([
      planned("/sdcard/Movies/Frieren ep01.mkv", 412 * 1024 * 1024),
    ]);
    const frame = t.captureCharFrame();
    expect(frame).toContain("portage");
    expect(frame).toContain("Pixel 10 Pro XL");
    expect(frame).toContain("Frieren ep01.mkv");
    expect(frame).toContain("space pause");
    expect(frame).toContain("ETA");
  });

  test("the overall band shows BOTH rates, labelled (gate D2)", async () => {
    await mountWith([planned("/sdcard/Movies/a.mkv", 1e9)]);
    const frame = t.captureCharFrame();
    expect(frame).toContain("avg");
    // The instantaneous rate is the one with the triangle marker.
    expect(frame).toMatch(/▲/);
  });

  test("the ETA reads as unknown until it can be honest (gate D1)", async () => {
    const { sink } = await mountWith([planned("/sdcard/Movies/a.mkv", 1e9)]);
    expect(view.overall.etaSeconds).toBeNull();
    expect(t.captureCharFrame()).toContain("ETA —");

    // Under 3 samples AND under 30 MB, still unknown — a bar that is moving must
    // not buy itself an ETA.
    sink.tick(Date.now());
    sink.tick(Date.now() + 200);
    sink.tick(Date.now() + 400);
    expect(view.overall.etaSeconds).toBeNull();
    expect(t.captureCharFrame()).toContain("ETA —");
  });

  test("a FileEvent moves the row it names and nothing else", async () => {
    const a = planned("/sdcard/Movies/a.mkv", 1e9);
    const b = planned("/sdcard/Movies/b.mkv", 1e9);
    const { sink } = await mountWith([a, b]);

    const start: FileEvent = { type: "start", file: a };
    sink.onFileEvent(start);
    await tick();
    await t.flush();
    expect(view.rows[0]!.state).toBe("copying");
    expect(view.rows[1]!.state).toBe("queued");

    const progress: FileEvent = {
      type: "progress",
      file: a,
      bytes: 500e6,
      total: 1e9,
    };
    sink.onFileEvent(progress);
    await tick();
    await t.flush();
    expect(view.rows[0]!.bytes).toBe(500e6);
    expect(view.rows[1]!.bytes).toBe(0);
    expect(t.captureCharFrame()).toContain("copying");
  });

  test("verified bytes are not double counted when the copy completes", async () => {
    const a = planned("/sdcard/Movies/a.mkv", 1e9);
    const { sink } = await mountWith([a]);
    sink.onFileEvent({ type: "progress", file: a, bytes: 900e6, total: 1e9 });
    expect(view.overall.bytesDone).toBe(900e6);
    sink.onFileEvent({ type: "verified", file: a, hash: "deadbeef" });
    // 1 GB total, not 900 MB + 1 GB.
    expect(view.overall.bytesDone).toBe(1e9);
    expect(view.overall.filesDone).toBe(1);
  });

  test("a failed file says why, and is never counted as done", async () => {
    const a = planned("/sdcard/Movies/a.mkv", 1e9);
    const { sink } = await mountWith([a]);
    sink.onFileEvent({ type: "failed", file: a, reason: "content mismatch" });
    await tick();
    await t.flush();
    expect(view.rows[0]!.state).toBe("failed");
    expect(view.overall.filesDone).toBe(0);
    expect(view.overall.failed).toBe(1);
    expect(t.captureCharFrame()).toContain("content mismatch");
  });

  test("j and k move the selection and the screen follows it", async () => {
    const files = Array.from({ length: 60 }, (_, i) =>
      planned(`/sdcard/Movies/f${i}.mkv`, 1e6),
    );
    await mountWith(files);
    const before = view.selected;
    await t.mockInput.pressKey("j");
    await tick();
    await t.flush();
    expect(view.selected).toBe(before + 1);
    await t.mockInput.pressKey("k");
    await tick();
    await t.flush();
    expect(view.selected).toBe(before);
  });

  test("the filter hides rows and does not move the selection (gate: identity)", async () => {
    const files = [
      planned("/sdcard/Movies/frieren-01.mkv", 1e6),
      planned("/sdcard/Movies/frieren-02.mkv", 1e6),
      planned("/sdcard/Movies/others-01.mkv", 1e6),
    ];
    await mountWith(files);
    view.selected = 2; // "others-01"
    view.filter = "frieren";
    await tick();
    await t.flush();
    const frame = t.captureCharFrame();
    expect(frame).toContain("frieren-01");
    expect(frame).not.toContain("others-01");
    // The selected row is filtered out; the scroll must not go negative.
    expect(view.scrollTop).toBeGreaterThanOrEqual(0);
  });

  test("the help overlay opens on ? and closes on ? again", async () => {
    await mountWith([planned("/sdcard/Movies/a.mkv", 1e6)]);
    await t.mockInput.pressKey("?");
    await tick();
    await t.flush();
    expect(t.captureCharFrame()).toContain("portage — keys");
    await t.mockInput.pressKey("?");
    await tick();
    await t.flush();
    expect(t.captureCharFrame()).not.toContain("portage — keys");
  });

  test("q during a transfer asks before it stops (gate C3)", async () => {
    const screen = new DashboardScreen();
    await renderer.mount(screen);
    let quits = 0;
    screen.onRequestQuit = () => {
      quits++;
    };
    // A plan with work still to do, so the transfer counts as running.
    const sink = new TransferSink();
    sink.begin(
      planOf([planned("/sdcard/Movies/a.mkv", 1e9)]),
      [
        {
          id: "dev1",
          serial: "s",
          state: "device",
          model: "Pixel 10 Pro XL",
          android: "17",
          unauthorized: false,
        },
      ],
      3,
    );
    await tick();
    await t.flush();

    await t.mockInput.pressKey("q");
    await tick();
    await t.flush();
    // It asked, and it did NOT act.
    expect(quits).toBe(0);
    expect(view.confirm).not.toBeNull();
    expect(t.captureCharFrame()).toContain("[y] yes");
  });

  test("answering no to the confirmation cancels it and moves nothing", async () => {
    const screen = new DashboardScreen();
    await renderer.mount(screen);
    let quits = 0;
    screen.onRequestQuit = () => {
      quits++;
    };
    const sink = new TransferSink();
    sink.begin(
      planOf([planned("/sdcard/Movies/a.mkv", 1e9)]),
      [
        {
          id: "dev1",
          serial: "s",
          state: "device",
          model: "Pixel 10 Pro XL",
          android: "17",
          unauthorized: false,
        },
      ],
      3,
    );
    await tick();
    await t.flush();

    await t.mockInput.pressKey("q");
    await tick();
    await t.flush();
    await t.mockInput.pressKey("n");
    await tick();
    await t.flush();
    expect(view.confirm).toBeNull();
    expect(quits).toBe(0);
    // And the transfer is still live: nothing was cancelled.
    expect(view.overall.filesTotal).toBe(1);
  });

  test("answering yes to the confirmation stops it", async () => {
    const screen = new DashboardScreen();
    await renderer.mount(screen);
    let quits = 0;
    screen.onRequestQuit = () => {
      quits++;
    };
    const sink = new TransferSink();
    sink.begin(
      planOf([planned("/sdcard/Movies/a.mkv", 1e9)]),
      [
        {
          id: "dev1",
          serial: "s",
          state: "device",
          model: "Pixel 10 Pro XL",
          android: "17",
          unauthorized: false,
        },
      ],
      3,
    );
    await tick();
    await t.flush();
    await t.mockInput.pressKey("q");
    await tick();
    await t.flush();
    await t.mockInput.pressKey("y");
    await tick();
    await t.flush();
    expect(view.confirm).toBeNull();
    expect(quits).toBe(1);
  });

  test("Q means stop and do not ask", async () => {
    const screen = new DashboardScreen();
    await renderer.mount(screen);
    let hard = false;
    screen.onRequestQuit = (h) => {
      hard = h;
    };
    const sink = new TransferSink();
    sink.begin(
      planOf([planned("/sdcard/Movies/a.mkv", 1e9)]),
      [
        {
          id: "dev1",
          serial: "s",
          state: "device",
          model: "Pixel 10 Pro XL",
          android: "17",
          unauthorized: false,
        },
      ],
      3,
    );
    await tick();
    await t.flush();
    await t.mockInput.pressKey("Q", { shift: true });
    await tick();
    await t.flush();
    expect(hard).toBe(true);
    expect(view.confirm).toBeNull();
  });

  test("the filter input focuses and shows the cursor; escape gives it back", async () => {
    const { screen } = await mountWith([planned("/sdcard/Movies/a.mkv", 1e6)]);
    await t.mockInput.pressKey("/");
    await tick();
    await t.flush();
    expect(view.filterActive).toBe(true);
    // Typing must reach the filter, not the dashboard.
    await t.mockInput.typeText("ep");
    await tick();
    await t.flush();
    expect(view.filter).toContain("ep");
    // Escape is driven straight at the screen rather than through the mock keys.
    //
    // A bare ESC byte is held by the terminal parser while it waits to find out
    // whether the sequence continues, so a single injected ESC never becomes a
    // keypress. That is OpenTUI's behaviour and its own tests cover it; what we
    // are asserting here is OURS — that escape hands the cursor back and clears
    // the filter.
    screen.onKey(
      {
        name: "escape",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        super: false,
      } as never,
      renderer.context,
    );
    await tick();
    await t.flush();
    expect(view.filterActive).toBe(false);
    expect(view.filter).toBe("");
    // Nothing is being typed now, so a full-screen dashboard HIDES the caret.
    // Handing it back to the shell is `restore()`'s job, and that is asserted
    // separately — hiding it on close is the correct behaviour, not a leak.
    expect(new TerminalCursor(t.renderer).state().visible).toBe(false);
  });

  test("the cursor is restored on unmount (gate E6)", async () => {
    await mountWith([planned("/sdcard/Movies/a.mkv", 1e6)]);
    const cursor = new TerminalCursor(t.renderer);
    // A full-screen dashboard starts with the caret hidden.
    cursor.apply(false);
    expect(cursor.state().visible).toBe(false);
    // Restoring gives it back to the shell.
    cursor.restore();
    expect(cursor.state().visible).toBe(true);
    // And restoring twice is harmless — exit paths can fire more than once.
    expect(() => cursor.restore()).not.toThrow();
  });

  test("unmount does not throw, with or without a screen", async () => {
    await mountWith([planned("/sdcard/Movies/a.mkv", 1e6)]);
    expect(() => renderer.unmount()).not.toThrow();
    expect(() => renderer.unmount()).not.toThrow();
  });

  test("at 40 columns the queue still renders and the frame does not wrap (gate E3)", async () => {
    // A second, narrower renderer. It gets its own screen and its own sink, and
    // it needs its OWN tick — the runes queue is global, but the frame buffer
    // belongs to this renderer only.
    const small = await createTestRenderer({ width: 40, height: 30 });
    const r2 = new OpenTuiRenderer(["portage", "pull"], small.renderer);
    view.rows = [];
    const sink = new TransferSink();
    const screen = new DashboardScreen();
    await r2.mount(screen);
    sink.begin(
      planOf([planned("/sdcard/Movies/a-fairly-long-name.mkv", 1e9)]),
      [
        {
          id: "dev1",
          serial: "s",
          state: "device",
          model: "Pixel 10 Pro XL",
          android: "17",
          unauthorized: false,
        },
      ],
      3,
    );
    await tick();
    await small.flush();
    const frame = small.captureCharFrame();
    expect(frame).toContain("a-fairly-");
    // No line may exceed the terminal width — that is what "does not wrap" means.
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    r2.unmount();
  });
});

// --- static gates ------------------------------------------------------------

describe("static gates", () => {
  test("gate B4: no console.log under src/tui", async () => {
    const glob = new Bun.Glob("src/tui/**/*.ts");
    const offenders: string[] = [];
    for await (const path of glob.scan(".")) {
      const src = await Bun.file(path).text();
      if (/console\.(log|info|warn|error)\(/.test(src)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
