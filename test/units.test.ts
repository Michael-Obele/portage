/**
 * Eligibility rules, path safety, config precedence, and argument parsing.
 *
 * These are the pure functions. They carry the rules that decide what Portage
 * is even allowed to touch, so they are tested directly rather than through the
 * CLI — a rule that is only tested end-to-end is a rule that breaks quietly.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { classify, isAlwaysExcluded, looksInFlight, summarise } from "../src/scan/scan.ts";
import { normPath, resolveInside, formatBytes, formatDuration, truncateMiddle } from "../src/util/paths.ts";
import { parseArgs, bool, int, str } from "../src/cli/args.ts";
import { loadConfig, coerceConfigValue } from "../src/config/load.ts";
import { DEFAULT_CONFIG } from "../src/config/schema.ts";

import { parseLsusbTree, maxLinkSpeed, isUsb2 } from "../src/device/adb.ts";
import { secondsAgo } from "./helpers.ts";

const OLD = secondsAgo(3600); // an hour ago — comfortably quiescent

describe("eligibility", () => {
  test("an old, ordinary file is new", () => {
    const c = classify({ path: "/sdcard/Movies/Frieren/S01/ep01.mkv", size: 400, mtime: OLD }, {
      quietSeconds: 120,
    });
    expect(c.verdict).toBe("new");
  });

  test("a file modified seconds ago is too recent to touch", () => {
    const c = classify(
      { path: "/sdcard/Movies/ep.mkv", size: 400, mtime: secondsAgo(10) },
      { quietSeconds: 120 },
    );
    expect(c.verdict).toBe("too-recent");
    // The remaining wait is stated, so the user knows when to come back —
    // but it is not asserted to the second, because the clock is moving.
    expect(c.reason).toMatch(/modified \d+s ago — wait \d+s/);
    const wait = Number(/wait (\d+)s/.exec(c.reason)?.[1] ?? "0");
    expect(wait).toBeGreaterThan(100);
    expect(wait).toBeLessThanOrEqual(110);
  });

  test("in-flight suffixes are refused regardless of age", () => {
    for (const name of [
      "ep01.mkv.part",
      "ep02.mkv.tmp",
      "ep03.mkv.crdownload",
      "ep04.mkv.!ut",
    ]) {
      const c = classify({ path: `/sdcard/Download/${name}`, size: 400, mtime: OLD }, {
        quietSeconds: 120,
      });
      expect(c.verdict).toBe("in-flight");
    }
  });

  test("app-private media is excluded even though it is readable", () => {
    expect(isAlwaysExcluded("/sdcard/Android/data/com.foo/files/ep.mkv")).toBe(true);
    expect(isAlwaysExcluded("/sdcard/Android/obb/com.foo/ep.mkv")).toBe(true);
    expect(isAlwaysExcluded("/sdcard/Movies/ep.mkv")).toBe(false);
  });

  test("a zero-byte file is reported as empty, not as a transfer", () => {
    const c = classify({ path: "/sdcard/Movies/ep.mkv", size: 0, mtime: OLD }, { quietSeconds: 120 });
    expect(c.verdict).toBe("empty");
  });

  test("a per-device exclude list is honoured, in any spelling", () => {
    const base = { label: "", roots: [], jobs: undefined };
    for (const entry of ["/Secret/", "Secret", "Secret/"]) {
      const c = classify(
        { path: "/sdcard/Movies/Secret/ep.mkv", size: 400, mtime: OLD },
        { quietSeconds: 120, deviceConfig: { ...base, exclude: [entry] } },
      );
      expect(c.verdict).toBe("excluded");
    }
  });

  test("summarise counts every verdict it is given", () => {
    const counts = summarise([
      { verdict: "new" },
      { verdict: "new" },
      { verdict: "too-recent" },
    ] as never);
    expect(counts.new).toBe(2);
    expect(counts["too-recent"]).toBe(1);
    expect(counts.excluded).toBe(0);
  });
});

describe("path safety", () => {
  test("a relative path resolves inside the root", () => {
    expect(resolveInside("/media/2TB/Anime", "Frieren/S01/ep.mkv")).toBe(
      "/media/2TB/Anime/Frieren/S01/ep.mkv",
    );
  });

  test("`..` cannot climb out of the root", () => {
    expect(resolveInside("/media/2TB/Anime", "../../etc/passwd")).toBeNull();
    expect(resolveInside("/media/2TB/Anime", "Frieren/../../../etc/passwd")).toBeNull();
  });

  test("an absolute path that points elsewhere is refused", () => {
    expect(resolveInside("/media/2TB/Anime", "/etc/shadow")).toBeNull();
  });

  test("a NUL byte is refused outright", () => {
    expect(resolveInside("/media/2TB/Anime", "ep\0.mkv")).toBeNull();
  });

  test("a sibling directory with a shared prefix is not inside the root", () => {
    // `/media/2TB/Anime-2` must not pass a `/media/2TB/Anime` prefix check.
    expect(resolveInside("/media/2TB/Anime", "../Anime-2/x.mkv")).toBeNull();
  });

  test("normPath lowercases and unifies separators", () => {
    expect(normPath("/Media/2TB/Anime/Frieren/EP01.MKV")).toBe("/media/2tb/anime/frieren/ep01.mkv");
    expect(normPath("C:\\Anime\\ep.mkv")).toBe("c:/anime/ep.mkv");
  });
});

describe("formatting", () => {
  test("bytes render in the unit a human reads", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(400 * 1024 * 1024)).toBe("400 MB");
  });

  test("an unknown ETA is an em dash, never a guess", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(90)).toBe("01:30");
    expect(formatDuration(3_661)).toBe("1:01:01");
  });

  test("long names truncate in the middle so the extension survives", () => {
    const out = truncateMiddle("[SubsPlease] Frieren - 07 (1080p) [A1B2C3D4].mkv", 24);
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out).toContain("…");
    expect(out.endsWith("D4].mkv")).toBe(true);
  });
});

describe("argument parsing", () => {
  test("commands, positionals and flags are separated", () => {
    const a = parseArgs(["pull", "--device", "abc", "--dry-run", "extra"]);
    expect(a.command).toBe("pull");
    expect(a.flags.device).toBe("abc");
    expect(a.flags["dry-run"]).toBe(true);
    expect(a.positionals).toEqual(["extra"]);
  });

  test("--flag=value and --flag value are equivalent", () => {
    expect(parseArgs(["plan", "--jobs=4"]).flags.jobs).toBe("4");
    expect(parseArgs(["plan", "--jobs", "4"]).flags.jobs).toBe("4");
  });

  test("--no-tui sets the flag to false", () => {
    expect(parseArgs(["pull", "--no-tui"]).flags.tui).toBe(false);
  });

  test("short aliases expand", () => {
    const a = parseArgs(["pull", "-d", "xyz", "-n"]);
    expect(a.flags.device).toBe("xyz");
    expect(a.flags["dry-run"]).toBe(true);
  });

  test("a value flag with no value is a usage error, not a silent undefined", () => {
    expect(() => parseArgs(["pull", "--jobs"])).toThrow(/--jobs needs a value/);
    expect(() => parseArgs(["pull", "--jobs", "--dry-run"])).toThrow(/--jobs needs a value/);
  });

  test("everything after `--` is positional", () => {
    const a = parseArgs(["db", "export", "--", "--weird-path"]);
    expect(a.positionals).toEqual(["export", "--weird-path"]);
  });

  test("accessors read the right shapes", () => {
    const a = parseArgs(["pull", "--jobs", "5", "--dry-run", "--show", "frieren"]);
    expect(int(a.flags, "jobs", 1)).toBe(5);
    expect(bool(a.flags, "dry-run")).toBe(true);
    expect(bool(a.flags, "keep-source")).toBe(false);
    expect(str(a.flags, "show")).toBe("frieren");
  });

  test("a non-numeric value for a number flag names the flag", () => {
    expect(() => int(parseArgs(["pull", "--jobs", "lots"]).flags, "jobs", 1)).toThrow(/--jobs/);
  });
});

describe("config", () => {
  test("defaults are what the plan says they are", () => {
    expect(DEFAULT_CONFIG.quiet_seconds).toBe(120);
    expect(DEFAULT_CONFIG.jobs).toBe(3);
    expect(DEFAULT_CONFIG.delete_source).toBe("after-verify");
    expect(DEFAULT_CONFIG.resume_threshold).toBe(0.76);
    expect(DEFAULT_CONFIG.space_headroom).toBe(0.02);
  });

  test("precedence is flags > env > user > defaults", async () => {
    const resolved = await loadConfig({
      configPath: "/nonexistent/portage.toml",
      env: { PORTAGE_JOBS: "5" },
      cliOverrides: { jobs: 7 },
    });
    expect(resolved.config.jobs).toBe(7);
    expect(resolved.origins.jobs).toBe("flag");
  });

  test("env beats the user config", async () => {
    const resolved = await loadConfig({
      configPath: "/nonexistent/portage.toml",
      env: { PORTAGE_JOBS: "5" },
    });
    expect(resolved.config.jobs).toBe(5);
    expect(resolved.origins.jobs).toBe("env");
  });

  test("a drive config is discovered via dest_root and outranks the user config", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "portage-drive-"));
    const stateDir = join(root, ".portage");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "config.toml"), 'jobs = 2\ndelete_source = "never"\n');

    const resolved = await loadConfig({
      configPath: "/nonexistent/portage.toml",
      destRoot: root,
      env: {},
    });

    expect(resolved.config.jobs).toBe(2);
    expect(resolved.config.delete_source).toBe("never");
    expect(resolved.sources.drivePath).toBe(join(stateDir, "config.toml"));
  });

  test("an invalid value is rejected before it can be written", () => {
    expect(() => coerceConfigValue("jobs", "999")).toThrow(/invalid value for jobs/);
    expect(() => coerceConfigValue("quiet_seconds", "-5")).toThrow(/invalid value for quiet_seconds/);
    expect(() => coerceConfigValue("delete_source", "maybe")).toThrow(/invalid value for delete_source/);
    expect(() => coerceConfigValue("not_a_key", "x")).toThrow(/unknown config key/);
  });

  test("valid values are coerced to the right type", () => {
    expect(coerceConfigValue("jobs", "4")).toBe(4);
    expect(coerceConfigValue("quiet_seconds", "300")).toBe(300);
    expect(coerceConfigValue("delete_source", "never")).toBe("never");
    expect(coerceConfigValue("dest_root", "/media/2TB/Anime")).toBe("/media/2TB/Anime");
  });

  test("an unknown key suggests the closest real one", () => {
    // The suggestion lives on the error's `fix` field — that is what the CLI
    // prints under the message, so this asserts what the user will actually see.
    try {
      coerceConfigValue("jbs", "3");
      throw new Error("expected coerceConfigValue to throw");
    } catch (err) {
      const { message, fix } = err as { message: string; fix?: string };
      expect(message).toContain("unknown config key: jbs");
      expect(fix).toContain('did you mean "jobs"');
    }
  });
});

describe("link speed", () => {
  test("lsusb -t is parsed into a speed per device", () => {
    const tree = [
      "/:  Bus 02.Port 1: Dev 1, Class=root_hub, Driver=xhci_hcd/4p, 10000M",
      "    |__ 1.1: Dev 2, If 0, Class=Hub, Driver=hub/4p, 5000M",
      "    |__ 1.2: Dev 5, If 0, Class=Mass Storage, Driver=usb-storage, 480M",
      "    |__ 1.3: Dev 6, If 0, Class=Mass Storage, Driver=usb-storage, 5000M",
      "/:  Bus 04.Port 1: Dev 1, Class=root_hub, Driver=xhci_hcd/4p, 10000M",
    ].join("\n");

    const speeds = parseLsusbTree(tree);

    // The USB 2 device must be identifiable as such, not confused with the
    // `If 0` interface number that follows `Dev N`.
    expect(speeds.get("02:1.2")).toBe(480);
    expect(speeds.get("02:1.3")).toBe(5000);
    // The root hub's own speed is what proves a SuperSpeed port exists.
    expect(maxLinkSpeed(speeds)).toBe(10000);
    expect(isUsb2(480)).toBe(true);
    expect(isUsb2(5000)).toBe(false);
  });

  test("an unparsed tree reports 0 rather than guessing a number", () => {
    expect(maxLinkSpeed(parseLsusbTree("garbage"))).toBe(0);
    expect(isUsb2(0)).toBe(false);
  });
});