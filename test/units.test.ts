/**
 * Eligibility rules, path safety, config precedence, and argument parsing.
 *
 * These are the pure functions. They carry the rules that decide what Portage
 * is even allowed to touch, so they are tested directly rather than through the
 * CLI — a rule that is only tested end-to-end is a rule that breaks quietly.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  classify,
  isAlwaysExcluded,
  looksInFlight,
  summarise,
} from "../src/scan/scan.ts";
import {
  normPath,
  resolveInside,
  formatBytes,
  formatDuration,
  localDayKey,
  truncateMiddle,
  isMarkerFile,
} from "../src/util/paths.ts";
import { loadConfig, coerceConfigValue } from "../src/config/load.ts";
import { DEFAULT_CONFIG } from "../src/config/schema.ts";
import { PendingRegister } from "../src/serve/pending.ts";
// The desktop app cannot import from `src/`, so `localDayKey` exists twice. This
// import is what makes "keep the two identical" a test instead of a comment.
import { localDayKey as desktopLocalDayKey } from "../apps/desktop/src/lib/util/relative-time.ts";

import {
  parseLsusbTree,
  maxLinkSpeed,
  isUsb2,
  resolveAdbBinary,
} from "../src/device/adb.ts";
import { secondsAgo } from "./helpers.ts";
import {
  mountDriver,
  mountGuard,
  parseDiskstatsFlush,
  parseLinkSpeed,
  readCiBunPin,
} from "../scripts/bench/record.ts";

import { s1Verdict } from "../scripts/bench/send-s1.ts";
import { s2Verdict } from "../scripts/bench/send-s2.ts";
import { s3Verdict } from "../scripts/bench/send-s3.ts";
import { summarizeListingTimes } from "../scripts/bench/send-listing.ts";
import {
  cleanupManifest,
  guardFolder,
  writeSpikeRecord,
} from "../scripts/bench/send-spike.ts";

const OLD = secondsAgo(3600); // an hour ago — comfortably quiescent

describe("eligibility", () => {
  test("an old, ordinary file is new", () => {
    const c = classify(
      { path: "/sdcard/Movies/Frieren/S01/ep01.mkv", size: 400, mtime: OLD },
      {
        quietSeconds: 120,
      },
    );
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
      const c = classify(
        { path: `/sdcard/Download/${name}`, size: 400, mtime: OLD },
        {
          quietSeconds: 120,
        },
      );
      expect(c.verdict).toBe("in-flight");
    }
  });

  test("app-private media is excluded even though it is readable", () => {
    expect(isAlwaysExcluded("/sdcard/Android/data/com.foo/files/ep.mkv")).toBe(
      true,
    );
    expect(isAlwaysExcluded("/sdcard/Android/obb/com.foo/ep.mkv")).toBe(true);
    expect(isAlwaysExcluded("/sdcard/Movies/ep.mkv")).toBe(false);
  });

  test("a zero-byte file is reported as empty, not as a transfer", () => {
    const c = classify(
      { path: "/sdcard/Movies/ep.mkv", size: 0, mtime: OLD },
      { quietSeconds: 120 },
    );
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
    expect(
      resolveInside("/media/2TB/Anime", "Frieren/../../../etc/passwd"),
    ).toBeNull();
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
    expect(normPath("/Media/2TB/Anime/Frieren/EP01.MKV")).toBe(
      "/media/2tb/anime/frieren/ep01.mkv",
    );
    expect(normPath("C:\\Anime\\ep.mkv")).toBe("c:/anime/ep.mkv");
  });
});

describe("the #lib alias boundary", () => {
  test("a module the other package imports does not use #lib", () => {
    // `#lib/*` means `./src/*` in the root package and `./src/lib/*` in
    // `apps/desktop`. Resolution follows the IMPORTING file's package, so a
    // `#lib` specifier inside a file the root suite imports would silently load
    // a different module than it does in the app. These are exactly the files
    // that cross the boundary today.
    const crossing = [
      "apps/desktop/src/lib/engine/protocol.ts",
      "apps/desktop/src/lib/util/relative-time.ts",
    ];
    for (const relative of crossing) {
      const source = readFileSync(
        join(import.meta.dir, "..", relative),
        "utf8",
      );
      expect({
        relative,
        aliases:
          source.includes("from '#lib/") || source.includes('from "#lib/'),
      }).toEqual({
        relative,
        aliases: false,
      });
    }
  });
});

describe("the pending-action register", () => {
  test("one record can be dropped without touching the others", () => {
    // Emptying the trash used to call `clear()`, which also wiped the duplicate
    // scan the person was still working through — the second move on that screen
    // then failed with "that duplicate scan is not available any more".
    let n = 0;
    const register = new PendingRegister(
      60_000,
      () => 1_000,
      () => `id-${++n}`,
    );
    const draft = {
      kind: "dupes" as const,
      paths: new Map<string, string>(),
      sizes: new Map<string, number>(),
      bytes: 0,
      trashDir: null,
      destRoot: "/drive",
    };
    const first = register.insert(draft);
    const second = register.insert({ ...draft, kind: "trash" });

    expect(register.delete(first.id)).toBe(true);
    expect(register.get(first.id)).toBeNull();
    expect(register.get(second.id)?.id).toBe(second.id);
    expect(register.delete(first.id)).toBe(false);
  });

  test("expired records are evicted as new ones arrive", () => {
    let now = 0;
    let n = 0;
    const register = new PendingRegister(
      1_000,
      () => now,
      () => `id-${++n}`,
    );
    const draft = {
      kind: "trash" as const,
      paths: new Map<string, string>(),
      sizes: new Map<string, number>(),
      bytes: 0,
      trashDir: null,
      destRoot: "/drive",
    };
    register.insert(draft);
    now = 5_000;
    register.insert(draft);
    // A screen that only ever inserts (`trash.status` on every mount and move)
    // must not grow this map forever.
    expect(register.size()).toBe(1);
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

  test("a trash folder is named by the LOCAL day, not the UTC one", () => {
    // The bug this pins: `toISOString().slice(0, 10)` is the UTC date, so on a
    // UTC+1 machine a move at 00:30 landed in YESTERDAY's folder.
    const justAfterMidnight = new Date(2026, 10, 17, 0, 30, 0);
    expect(localDayKey(justAfterMidnight)).toBe(
      [
        justAfterMidnight.getFullYear(),
        String(justAfterMidnight.getMonth() + 1).padStart(2, "0"),
        String(justAfterMidnight.getDate()).padStart(2, "0"),
      ].join("-"),
    );
    // And it is a date a folder can be named: zero-padded, sortable.
    expect(localDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    if (justAfterMidnight.getTimezoneOffset() !== 0) {
      expect(localDayKey(justAfterMidnight)).not.toBe(
        justAfterMidnight.toISOString().slice(0, 10),
      );
    }
  });

  test("the engine's day key and the desktop's agree, year round", () => {
    // One decides the folder `applySelection` writes into; the other decides what
    // the screen calls it. They are separate files because the desktop is its own
    // SvelteKit app, so the invariant is asserted rather than assumed.
    for (const date of [
      new Date(2026, 0, 1),
      new Date(2026, 10, 17, 0, 30),
      new Date(2026, 11, 31, 23, 59),
      new Date(2024, 1, 29, 12, 0),
    ]) {
      expect(desktopLocalDayKey(date)).toBe(localDayKey(date));
    }
  });

  test("long names truncate in the middle so the extension survives", () => {
    const out = truncateMiddle(
      "[SubsPlease] Frieren - 07 (1080p) [A1B2C3D4].mkv",
      24,
    );
    expect(out.length).toBeLessThanOrEqual(24);
    expect(out).toContain("…");
    expect(out.endsWith("D4].mkv")).toBe(true);
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
    await writeFile(
      join(stateDir, "config.toml"),
      'jobs = 2\ndelete_source = "never"\n',
    );

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
    expect(() => coerceConfigValue("jobs", "999")).toThrow(
      /invalid value for jobs/,
    );
    expect(() => coerceConfigValue("quiet_seconds", "-5")).toThrow(
      /invalid value for quiet_seconds/,
    );
    expect(() => coerceConfigValue("delete_source", "maybe")).toThrow(
      /invalid value for delete_source/,
    );
    expect(() => coerceConfigValue("not_a_key", "x")).toThrow(
      /unknown config key/,
    );
  });

  test("valid values are coerced to the right type", () => {
    expect(coerceConfigValue("jobs", "4")).toBe(4);
    expect(coerceConfigValue("quiet_seconds", "300")).toBe(300);
    expect(coerceConfigValue("delete_source", "never")).toBe("never");
    expect(coerceConfigValue("dest_root", "/media/2TB/Anime")).toBe(
      "/media/2TB/Anime",
    );
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

// --- finding adb without a login shell --------------------------------------
//
// A desktop launch inherits the session PATH and never reads `.bashrc`, so the
// only reason adb works here at all is the SDK search. These tests keep that
// true: the sandboxed PATH resolves nothing, and the folder does the work.

describe("resolveAdbBinary", () => {
  /** A throwaway HOME holding an executable at a relative path. */
  async function sandbox(relative: string) {
    const home = await mkdtemp(join(tmpdir(), "portage-adb-"));
    const bin = join(home, relative);
    await mkdir(dirname(bin), { recursive: true });
    await Bun.write(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    return { home, bin };
  }

  test("finds adb in an SDK folder when PATH holds nothing", async () => {
    const { home, bin } = await sandbox(
      join("Android", "Sdk", "platform-tools", "adb"),
    );

    const found = await resolveAdbBinary("", {
      HOME: home,
      PATH: "/nonexistent-bin",
    });

    expect(found.source).toBe("search");
    expect(found.bin).toBe(bin);
    // The search reports what it looked at, so a failure can name the folders.
    expect(found.tried).toContain(bin);

    await rm(home, { recursive: true, force: true });
  });

  test("a configured path wins over the search", async () => {
    const { home, bin } = await sandbox(
      join("android", "platform-tools", "adb"),
    );

    const found = await resolveAdbBinary(bin, {
      HOME: home,
      PATH: "/nonexistent-bin",
    });

    expect(found.source).toBe("config");
    expect(found.bin).toBe(bin);

    await rm(home, { recursive: true, force: true });
  });

  test("a stale configured path falls through instead of refusing", async () => {
    const { home, bin } = await sandbox(
      join("Android", "Sdk", "platform-tools", "adb"),
    );

    const found = await resolveAdbBinary("/nope/adb", {
      HOME: home,
      PATH: "/nonexistent-bin",
    });

    expect(found.source).toBe("search");
    expect(found.bin).toBe(bin);
    expect(found.tried).toContain("/nope/adb");

    await rm(home, { recursive: true, force: true });
  });

  test("reports none, with everything it tried, when adb is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "portage-adb-empty-"));

    const found = await resolveAdbBinary("", {
      HOME: home,
      PATH: "/nonexistent-bin",
    });

    expect(found.bin).toBeNull();
    expect(found.source).toBe("none");
    expect(found.tried.length).toBeGreaterThan(0);

    await rm(home, { recursive: true, force: true });
  });
});

describe("folder markers", () => {
  // The rule both the Plan frame and the run pipeline consult. `.nomedia` is a
  // 0-byte marker on Android meaning "do not index this folder".
  test("recognises the marker files, in any case, at any depth", () => {
    for (const path of [
      "/sdcard/Movies/.nomedia",
      "/sdcard/Movies/DCIM/.NOMEDIA",
      "/sdcard/Movies/.DS_Store",
      "/sdcard/Movies/Thumbs.db",
      "/sdcard/Movies/desktop.ini",
      "/sdcard/Movies/sub/.directory",
    ]) {
      expect(isMarkerFile(path), path).toBe(true);
    }
  });

  test("does not mistake media for a marker", () => {
    for (const path of [
      "/sdcard/Movies/Frieren 07.mkv",
      "/sdcard/Movies/not-a-nomedia-file.mkv",
      "/sdcard/Movies/nomedia.mkv",
      "/sdcard/Movies/.nomedia.mkv",
      "/sdcard/Movies",
      "/sdcard/.nomedia/inside.mkv",
    ]) {
      expect(isMarkerFile(path), path).toBe(false);
    }
  });
});

// mulberry32. A failing seed replays the same inputs.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("bench record", () => {
  // Stat k (1 to 17) is 100 + k, so the 16th stat is 116 and column 19 must read 116.
  const diskstatsLine = (
    major: number,
    minor: number,
    name: string,
    base = 100,
  ) =>
    [
      major,
      minor,
      name,
      ...Array.from({ length: 17 }, (_, i) => base + i + 1),
    ].join(" ");
  const DISKSTATS = [
    diskstatsLine(8, 0, "sdb", 200),
    diskstatsLine(8, 1, "sdb1"),
  ].join("\n");

  const FUSE_LINE =
    "/dev/sdb1 /media/node/2TB fuseblk rw,nosuid,nodev,relatime,user_id=0,group_id=0,default_permissions,allow_other,blksize=4096 0 0";
  const NTFS3_LINE =
    "/dev/sdc1 /media/node/ntfs3drive ntfs3 rw,relatime,uid=1000 0 0";
  const MOUNTS = [
    "/dev/sda2 / ext4 rw,relatime 0 0",
    FUSE_LINE,
    NTFS3_LINE,
    "sshfs#host:/ /mnt/remote fuse.sshfs rw,nosuid,nodev 0 0",
    "/dev/sdd1 /media/node/2TB/local ext4 rw,relatime 0 0",
  ].join("\n");

  test("diskstats column 19 is the flush-requests-completed counter", () => {
    // Column 19 is the 16th statistic: three name columns, then stat 16.
    expect(parseDiskstatsFlush(DISKSTATS, "sdb1")).toBe(116);
    expect(parseDiskstatsFlush(DISKSTATS, "sdb")).toBe(216);
    expect(parseDiskstatsFlush(DISKSTATS, "sdb2")).toBeNull();
  });

  test("a fuseblk mount line gives the driver ntfs-3g", () => {
    expect(mountDriver(FUSE_LINE)).toBe("ntfs-3g");
    expect(mountDriver(NTFS3_LINE)).toBe("ntfs3");
    expect(mountDriver("/dev/sda2 / ext4 rw,relatime 0 0")).toBeNull();
  });

  test("the CI pin is read from bun-version in ci.yml", () => {
    const ci = readFileSync(
      join(import.meta.dir, "..", ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(readCiBunPin(ci)).toBe("1.4.4");
    expect(readCiBunPin("      bun-version: 1.4.5\n")).toBe("1.4.5");
    expect(readCiBunPin("      node-version: 20\n")).toBeNull();
  });

  test("a sysfs speed value is read as Mbit/s", () => {
    expect(parseLinkSpeed("480\n")).toBe(480);
    expect(parseLinkSpeed("5000\n")).toBe(5000);
    // sysfs writes -1 when the link speed is unknown. That is not a number to record.
    expect(parseLinkSpeed("-1\n")).toBeNull();
  });

  test("the mount guard accepts a root under a fuseblk or ntfs3 mount", () => {
    const fuse = mountGuard("/media/node/2TB/Downloads/bench", MOUNTS);
    expect(fuse.mountPoint).toBe("/media/node/2TB");
    expect(fuse.driver).toBe("ntfs-3g");
    expect(mountGuard("/media/node/2TB", MOUNTS).driver).toBe("ntfs-3g");
    expect(mountGuard("/media/node/ntfs3drive/x", MOUNTS).driver).toBe("ntfs3");
  });

  test("the mount guard refuses any other root", () => {
    // Nearest mount is "/" (ext4), so the fuseblk mount does not apply.
    expect(() => mountGuard("/home/node/Documents", MOUNTS)).toThrow();
    expect(() => mountGuard("/media/node", MOUNTS)).toThrow();
    // A prefix of a mount point is not inside it.
    expect(() => mountGuard("/media/node/2TBX/x", MOUNTS)).toThrow();
    // The nearest mount decides: ext4 nested inside fuseblk is refused.
    expect(() => mountGuard("/media/node/2TB/local/x", MOUNTS)).toThrow();
    expect(() => mountGuard("/mnt/remote/x", MOUNTS)).toThrow();
  });
});

describe("fixture guard", () => {
  // Loaded inside each test, so the bench record tests keep passing until
  // fixtures.ts exists.
  const load = () => import("../scripts/bench/fixtures.ts");
  type Fixtures = Awaited<ReturnType<typeof load>>;

  const SEEDS = 100;
  const STATES = ["empty", "manifest", "foreign"] as const;
  type RootState = (typeof STATES)[number];

  const exists = (path: string) =>
    lstat(path).then(
      () => true,
      () => false,
    );

  /** Plants a file outside every manifest, `depth` folders below `root`. */
  async function plantForeign(root: string, depth: number): Promise<string> {
    let dir = root;
    for (let i = 0; i < depth; i += 1) {
      dir = join(dir, `foreign${i}`);
      await mkdir(dir, { recursive: true });
    }
    const file = join(dir, "not-ours.txt");
    await writeFile(file, "keep me");
    return file;
  }

  /** Counts the folders of a chain. A level with two subfolders is an error. */
  async function chainDepth(dir: string): Promise<number> {
    let depth = 0;
    let current = dir;
    for (;;) {
      const subdirs = (await readdir(current, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory(),
      );
      const [only, ...rest] = subdirs;
      if (!only) return depth;
      if (rest.length > 0) {
        throw new Error(`the chain branches at depth ${depth}`);
      }
      current = join(current, only.name);
      depth += 1;
    }
  }

  async function runCase(
    fx: Fixtures,
    root: string,
    state: RootState,
    next: () => number,
  ): Promise<void> {
    const manifest: string[] = [];
    if (state !== "empty") {
      const kind = next() < 0.5 ? "deep" : "shallow";
      const files = 1 + Math.floor(next() * 4);
      manifest.push(...(await fx.buildFixture(root, kind, files)).manifest);
    }

    if (state === "foreign") {
      const foreign = await plantForeign(root, Math.floor(next() * 9));
      await expect(fx.cleanFixtures(root)).rejects.toThrow();
      for (const path of [...manifest, foreign]) {
        expect(await exists(path)).toBe(true);
      }
      return;
    }

    await fx.cleanFixtures(root);
    for (const path of manifest) {
      expect(await exists(path)).toBe(false);
    }
    expect(await readdir(root)).toEqual([]);
  }

  test("property: the guard deletes only manifest paths and refuses a foreign entry", async () => {
    const fx = await load();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const next = rng(seed);
      const state = STATES[Math.floor(next() * STATES.length)] ?? "empty";
      const root = await mkdtemp(join(tmpdir(), "fixture-guard-"));
      try {
        await runCase(fx, root, state, next);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`seed ${seed} (root ${state}): ${why}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 120_000);

  test("the deep fixture is one chain of exactly 462 segments", async () => {
    const fx = await load();
    const root = await mkdtemp(join(tmpdir(), "fixture-deep-"));
    try {
      const { dir } = await fx.buildFixture(root, "deep");
      expect(await chainDepth(dir)).toBe(462);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
describe("E1 verdict", () => {
  // Loaded inside each test, so the other blocks keep passing until
  // e1-flush.ts exists.
  const load = () => import("../scripts/bench/e1-flush.ts");

  type Reading = { before: number; after: number };
  type E1Runs = {
    // 0 is `sync -f`, 1a is "r", 1b is "r+", 2 is 1a then the directory.
    counter: {
      form0: Reading;
      form1a: Reading;
      form1b: Reading;
      form2: Reading;
    };
    flushMs: number;
    dirSyncMs: number;
  };

  const SEEDS = 100;
  // R1.12: 30000 + 1000 × ceil(size / 10000000).
  const deadlineMs = (size: number) =>
    30_000 + 1_000 * Math.ceil(size / 10_000_000);
  const FILE_DEADLINE = deadlineMs(300_000_000);
  const DIR_DEADLINE = deadlineMs(0);

  const still = (n = 100): Reading => ({ before: n, after: n });
  const moved = (n = 100): Reading => ({ before: n, after: n + 1 });
  const moves = (r: Reading) => r.after > r.before;

  const healthy = (): E1Runs => ({
    counter: {
      form0: still(),
      form1a: moved(),
      form1b: still(),
      form2: moved(),
    },
    flushMs: 1_200,
    dirSyncMs: 80,
  });

  test("E1 verdict: pass with open mode r when form 1a moves the counter", async () => {
    const { e1Verdict } = await load();
    expect(e1Verdict(healthy())).toEqual({ result: "pass", openMode: "r" });
  });

  test("E1 verdict: pass with open mode r+ when only form 1b moves the counter", async () => {
    const { e1Verdict } = await load();
    const runs = healthy();
    runs.counter = {
      form0: still(),
      form1a: still(),
      form1b: moved(),
      form2: still(),
    };
    expect(e1Verdict(runs)).toEqual({ result: "pass", openMode: "r+" });
  });

  test("E1 verdict: open mode r wins when both 1a and 1b move the counter", async () => {
    const { e1Verdict } = await load();
    const runs = healthy();
    runs.counter.form1b = moved();
    expect(e1Verdict(runs)).toEqual({ result: "pass", openMode: "r" });
  });

  test("E1 verdict: fail when form 0 moves but no fsync form does", async () => {
    const { e1Verdict } = await load();
    const runs = healthy();
    runs.counter = {
      form0: moved(),
      form1a: still(),
      form1b: still(),
      form2: still(),
    };
    expect(e1Verdict(runs)).toEqual({ result: "fail", openMode: null });
  });

  test("E1 verdict: fail when no form moves the counter", async () => {
    const { e1Verdict } = await load();
    const runs = healthy();
    runs.counter = {
      form0: still(),
      form1a: still(),
      form1b: still(),
      form2: still(),
    };
    expect(e1Verdict(runs)).toEqual({ result: "fail", openMode: null });
  });

  test("E1 verdict: fail when only form 2 moves the counter", async () => {
    // Pass needs 1a or 1b on its own. Form 2 alone is not enough.
    const { e1Verdict } = await load();
    const runs = healthy();
    runs.counter = {
      form0: still(),
      form1a: still(),
      form1b: still(),
      form2: moved(),
    };
    expect(e1Verdict(runs)).toEqual({ result: "fail", openMode: null });
  });

  test("E1 verdict: the open mode follows the counter even when timing fails", async () => {
    const { e1Verdict } = await load();
    const runs = healthy();
    runs.flushMs = FILE_DEADLINE + 1;
    expect(e1Verdict(runs)).toEqual({ result: "fail", openMode: "r" });
  });

  test("E1 verdict: pass at exactly the file and directory deadlines", async () => {
    const { e1Verdict } = await load();
    expect(FILE_DEADLINE).toBe(60_000);
    expect(DIR_DEADLINE).toBe(30_000);
    const runs = healthy();
    runs.flushMs = FILE_DEADLINE;
    runs.dirSyncMs = DIR_DEADLINE;
    expect(e1Verdict(runs).result).toBe("pass");
  });

  test("E1 verdict: fail one millisecond past the file flush deadline", async () => {
    const { e1Verdict } = await load();
    const runs = healthy();
    runs.flushMs = FILE_DEADLINE + 1;
    expect(e1Verdict(runs).result).toBe("fail");
  });

  test("E1 verdict: fail one millisecond past the directory sync deadline", async () => {
    const { e1Verdict } = await load();
    const runs = healthy();
    runs.dirSyncMs = DIR_DEADLINE + 1;
    expect(e1Verdict(runs).result).toBe("fail");
  });

  // Readings and times on both sides of each boundary, drawn from one seed.
  function randomRuns(next: () => number): E1Runs {
    const reading = (): Reading => {
      const before = Math.floor(next() * 1_000_000);
      const delta = next() < 0.5 ? 0 : 1 + Math.floor(next() * 3);
      return { before, after: before + delta };
    };
    const time = (deadline: number) => {
      const pick = next();
      if (pick < 0.15) return deadline;
      if (pick < 0.3) return deadline + 1;
      return Math.floor(next() * deadline * 1.5);
    };
    return {
      counter: {
        form0: reading(),
        form1a: reading(),
        form1b: reading(),
        form2: reading(),
      },
      flushMs: time(FILE_DEADLINE),
      dirSyncMs: time(DIR_DEADLINE),
    };
  }

  test("E1 verdict property: pass exactly when a mode moves and both times meet their deadlines", async () => {
    const { e1Verdict } = await load();
    let passes = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const runs = randomRuns(rng(seed));
      const expected =
        (moves(runs.counter.form1a) || moves(runs.counter.form1b)) &&
        runs.flushMs <= FILE_DEADLINE &&
        runs.dirSyncMs <= DIR_DEADLINE;
      passes += expected ? 1 : 0;
      try {
        expect(e1Verdict(runs).result).toBe(expected ? "pass" : "fail");
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`seed ${seed}: ${why}`);
      }
    }
    // Both outcomes must occur, or the property checks nothing useful.
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(SEEDS);
  });
});

describe("probe classifier", () => {
  // Loaded inside each test, so the other blocks keep passing until
  // src/util/probe.ts exists.
  const load = () => import("../src/util/probe.ts");
  type ProbeModule = Awaited<ReturnType<typeof load>>;

  const SEEDS = 100;
  // 50 ms, not the 3 s default (R2.2), so each timeout ends fast.
  const DEADLINE_MS = 50;
  // Consecutive timeouts that trip the breaker (R2.12).
  const TRIP_TIMEOUTS = 3;

  const KINDS = [
    "ENOENT",
    "EACCES",
    "EIO",
    "EINVAL",
    "random",
    "none",
  ] as const;
  const OUTCOMES = ["success", "error", "timeout", "refused"] as const;
  type Kind = (typeof KINDS)[number];
  type Outcome = (typeof OUTCOMES)[number];
  // Seeds 1 to CELLS walk each kind and outcome pair once. Later seeds draw.
  const CELLS = KINDS.length * OUTCOMES.length;

  /** An item of a fixed list. A bad index is a bug in the test. */
  function at<T>(items: readonly T[], index: number): T {
    const item = items[index];
    if (item === undefined) {
      throw new Error(`index ${index} is outside the list`);
    }
    return item;
  }

  /** An error with `code`, or with no code when `code` is undefined. */
  function fakeError(code: string | undefined): Error {
    const err = new Error(`fake ${code ?? "error"}`);
    if (code !== undefined) Object.assign(err, { code });
    return err;
  }

  /** Three to eight capital letters. A draw is never ENOENT. */
  function randomCode(next: () => number): string {
    for (;;) {
      const length = 3 + Math.floor(next() * 6);
      let code = "";
      for (let i = 0; i < length; i += 1) {
        code += String.fromCharCode(65 + Math.floor(next() * 26));
      }
      if (code !== "ENOENT") return code;
    }
  }

  function codeFor(kind: Kind, next: () => number): string | undefined {
    if (kind === "random") return randomCode(next);
    if (kind === "none") return undefined;
    return kind;
  }

  const stall = () => new Promise<never>(() => {});

  /** Runs one kind and outcome on its own root, and checks the answer. */
  async function checkOutcome(
    mod: ProbeModule,
    root: string,
    kind: Kind,
    outcome: Outcome,
    next: () => number,
  ): Promise<void> {
    const { probe, classifyError, breakerFor, resetDriveState } = mod;
    resetDriveState(root);
    const code = codeFor(kind, next);
    const value = Math.floor(next() * 1_000_000);

    if (outcome === "success") {
      const result = await probe(root, "check", async () => value, DEADLINE_MS);
      expect(result).toEqual({ kind: "ok", value });
    } else if (outcome === "error") {
      const err = fakeError(code);
      const result = await probe(
        root,
        "check",
        () => Promise.reject(err),
        DEADLINE_MS,
      );
      expect(result).toEqual(classifyError(err));
      if (code === "ENOENT") {
        expect(result).toEqual({ kind: "missing" });
      } else {
        expect(result).toMatchObject({
          kind: "unreadable",
          reason: "error",
          code: code ?? null,
        });
      }
    } else if (outcome === "timeout") {
      const result = await probe(root, "check", stall, DEADLINE_MS);
      expect(result).toMatchObject({ kind: "unreadable", reason: "timeout" });
    } else {
      for (let i = 0; i < TRIP_TIMEOUTS; i += 1) {
        await probe(root, "stall", stall, DEADLINE_MS);
      }
      expect(breakerFor(root).tripped).toBe(true);
      let ran = false;
      const result = await probe(
        root,
        "check",
        async () => {
          ran = true;
          return value;
        },
        DEADLINE_MS,
      );
      expect(result).toMatchObject({ kind: "unreadable", reason: "refused" });
      expect(ran).toBe(false);
    }
  }

  test("property: the probe classifier is honest for every code and outcome", async () => {
    const mod = await load();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const next = rng(seed);
      const cell = seed <= CELLS ? seed - 1 : Math.floor(next() * CELLS);
      const kind = at(KINDS, Math.floor(cell / OUTCOMES.length));
      const outcome = at(OUTCOMES, cell % OUTCOMES.length);
      try {
        await checkOutcome(mod, `/probe-property/${seed}`, kind, outcome, next);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`seed ${seed} (${kind}, ${outcome}): ${why}`);
      }
    }
  }, 60_000);

  test("probe resolves at its deadline when the child never exits", async () => {
    const { probe, breakerFor, resetDriveState, PROBE_TIMEOUT_MS } =
      await load();
    const root = "/probe-child/never-exits";
    resetDriveState(root);

    // A child that ignores its kill. Its exit settles only when `exit` runs.
    let settle!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      settle = resolve;
    });
    let killed = false;
    const child = {
      kill: () => {
        killed = true;
      },
      exit: (code: number) => settle(code),
    };

    const started = performance.now();
    const pending = probe(root, "child", () => exited, DEADLINE_MS);
    child.kill();
    const result = await pending;
    const elapsed = performance.now() - started;

    expect(killed).toBe(true);
    expect(result).toMatchObject({ kind: "unreadable", reason: "timeout" });
    // Resolved at the deadline: not early, and not at the 3 s default.
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 10);
    expect(elapsed).toBeLessThan(PROBE_TIMEOUT_MS);
    expect(breakerFor(root).consecutiveTimeouts).toBe(1);

    // The later exit changes no result and no breaker count.
    const returned = { ...result };
    child.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result).toEqual(returned);
    expect(breakerFor(root)).toMatchObject({
      consecutiveTimeouts: 1,
      tripped: false,
    });
  });

  test("probe accepts a null root", async () => {
    const { probe, runFlushCall, breakerFor, resetDriveState } = await load();
    const root = "/probe-null/archive";
    resetDriveState(root);

    // A flush stays pending on the archive root until the test releases it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let flushSettled = false;
    const flush = runFlushCall(root, "pending flush", 10_000, () => gate);
    void flush.then(() => {
      flushSettled = true;
    });

    try {
      // A null root reads nothing on the drive, so it waits for no flush.
      const quick = await probe(
        null,
        "rsync version",
        async () => "3.2.7",
        DEADLINE_MS,
      );
      expect(quick).toEqual({ kind: "ok", value: "3.2.7" });
      expect(flushSettled).toBe(false);

      // As many timeouts as trip a breaker. None counts for the archive root.
      for (let i = 0; i < TRIP_TIMEOUTS; i += 1) {
        const late = await probe(null, "stalled check", stall, DEADLINE_MS);
        expect(late).toMatchObject({ kind: "unreadable", reason: "timeout" });
      }
      const after = await probe(
        null,
        "after timeouts",
        async () => 42,
        DEADLINE_MS,
      );
      expect(after).toEqual({ kind: "ok", value: 42 });
      expect(breakerFor(root).consecutiveTimeouts).toBe(0);
      expect(breakerFor(root).tripped).toBe(false);
    } finally {
      release();
    }
    expect(await flush).toMatchObject({ kind: "ok" });
  }, 15_000);
});

describe("flush deadline", () => {
  // Loaded inside each test, so the other blocks keep passing until
  // src/util/durable.ts exists.
  const load = () => import("../src/util/durable.ts");

  const SEEDS = 100;

  // Half the draws sit on or one byte either side of a 10 MB step, where the
  // ceiling changes.
  function drawSize(next: () => number): number {
    if (next() < 0.5) {
      const step = Math.floor(next() * 200_000);
      const beside = Math.floor(next() * 3) - 1;
      return Math.max(0, step * 10_000_000 + beside);
    }
    return Math.floor(next() * 10 ** Math.floor(next() * 13));
  }

  // Feature: transfer-durability-and-fs-hardening, Property 7: The flush deadline is a function of size
  // **Validates: Requirements 1.12**
  test("property: the deadline is 30 s plus 1 s per 10 MB, and never falls as size grows", async () => {
    const { flushDeadlineMs } = await load();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const next = rng(seed);
      const sizes = Array.from({ length: 16 }, () => drawSize(next));
      sizes.sort((a, b) => a - b);
      try {
        let previous = -Infinity;
        for (const size of sizes) {
          const deadline = flushDeadlineMs(size);
          const formula = 30_000 + 1_000 * Math.ceil(size / 10_000_000);
          expect(deadline).toBe(formula);
          expect(deadline).toBeGreaterThanOrEqual(previous);
          previous = deadline;
        }
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`seed ${seed}: ${why}`);
      }
    }
  }, 60_000);

  test("flush deadline: 0 bytes gives 30 s", async () => {
    const { flushDeadlineMs } = await load();
    expect(flushDeadlineMs(0)).toBe(30_000);
  });

  test("flush deadline: 10,000,000 bytes gives 31 s", async () => {
    const { flushDeadlineMs } = await load();
    expect(flushDeadlineMs(10_000_000)).toBe(31_000);
  });

  test("flush deadline: 10,000,001 bytes gives 32 s", async () => {
    const { flushDeadlineMs } = await load();
    expect(flushDeadlineMs(10_000_001)).toBe(32_000);
  });
});

describe("E2 and E3 verdicts", () => {
  // Loaded inside each test, so the other blocks pass until the scripts exist.
  const loadE2 = () => import("../scripts/bench/e2-trash.ts");
  const loadE3 = () => import("../scripts/bench/e3-move-stat.ts");

  const pair = (ts: number[], helper: number[]) => ({ ts, helper });
  const fast = {
    deep: pair([10, 10, 10, 10, 10], [4, 4, 4, 4, 4]),
    shallow: pair([10, 10, 10, 10, 10], [10, 10, 10, 10, 10]),
  };

  test("E2 verdict: pass at deep ratio 2.0 and shallow ratio 1.10", async () => {
    const { e2Verdict } = await loadE2();
    const edge = {
      deep: pair([20, 20, 20], [10, 10, 10]),
      shallow: pair([100, 100, 100], [110, 110, 110]),
    };
    const v = e2Verdict(edge);
    expect(v.result).toBe("pass");
    expect(v.deepRatio).toBeCloseTo(2.0);
    expect(v.shallowRatio).toBeCloseTo(1.1);
  });

  test("E2 verdict: fail when the deep ratio is under 2.0", async () => {
    const { e2Verdict } = await loadE2();
    const v = e2Verdict({ ...fast, deep: pair([19, 19, 19], [10, 10, 10]) });
    expect(v.result).toBe("fail");
  });

  test("E2 verdict: fail when the shallow ratio is over 1.10", async () => {
    const { e2Verdict } = await loadE2();
    const v = e2Verdict({
      ...fast,
      shallow: pair([100, 100, 100], [111, 111, 111]),
    });
    expect(v.result).toBe("fail");
  });

  test("E2 verdict: uses the median, so one slow run does not decide", async () => {
    const { e2Verdict } = await loadE2();
    const v = e2Verdict({
      ...fast,
      deep: pair([10, 10, 10, 10, 10], [4, 4, 4, 900, 900]),
    });
    expect(v.result).toBe("pass");
  });

  test("E2 verdict: fail when there are no Helper samples", async () => {
    const { e2Verdict } = await loadE2();
    expect(e2Verdict({ ...fast, deep: pair([10], []) }).result).toBe("fail");
  });

  test("E3 verdict: move and stat are judged separately", async () => {
    const { e3Verdict } = await loadE3();
    const v = e3Verdict({
      move: fast,
      stat: { ...fast, deep: pair([10, 10, 10], [9, 9, 9]) },
    });
    expect(v.move.result).toBe("pass");
    expect(v.stat.result).toBe("fail");
    expect(v.result).toBe("fail");
  });

  test("E3 verdict: result is pass only when both operations pass", async () => {
    const { e3Verdict } = await loadE3();
    expect(e3Verdict({ move: fast, stat: fast }).result).toBe("pass");
  });
});

describe("recorded decisions", () => {
  // The constants copy the Phase 0 records. A re-run that changes a verdict
  // must change its constant too, and these tests catch the gap.
  const load = () => import("../src/util/durable.ts");
  const RESULTS = join(import.meta.dir, "..", "bench", "results");

  // Names start with the date, so the last sorted name is the newest. The
  // listing is not recursive, so superseded/ is skipped.
  async function newestVerdict(
    suffix: string,
  ): Promise<Record<string, unknown>> {
    const names = (await readdir(RESULTS, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name)
      .sort();
    const newest = names.at(-1);
    if (newest === undefined) {
      throw new Error(`no record matches bench/results/*${suffix}`);
    }
    const record = JSON.parse(readFileSync(join(RESULTS, newest), "utf8"));
    return record.verdict;
  }

  test("the newest E1 record has verdict pass", async () => {
    const verdict = await newestVerdict("-e1-flush.json");
    expect(verdict.result).toBe("pass");
  });

  test("FLUSH_OPEN_MODE matches the newest E1 record's open mode", async () => {
    const { FLUSH_OPEN_MODE } = await load();
    const verdict = await newestVerdict("-e1-flush.json");
    expect(verdict.openMode).toBe(FLUSH_OPEN_MODE);
  });

  test("the newest E4 record has verdict pass", async () => {
    const verdict = await newestVerdict("-e4-bun-sync.json");
    expect(verdict.result).toBe("pass");
  });

  test("DIRECTORY_SYNC_BRANCH matches the newest E4 record's branch", async () => {
    const { DIRECTORY_SYNC_BRANCH } = await load();
    const verdict = await newestVerdict("-e4-bun-sync.json");
    expect(verdict.directoryBranch).toBe(DIRECTORY_SYNC_BRANCH);
  });
});

describe("send shared helpers", () => {
  test("quoteShellArg lives in util/spawn and browse re-exports it", async () => {
    const spawn = (await import("../src/util/spawn.ts")) as Record<string, unknown>;
    const browse = (await import("../src/serve/browse.ts")) as Record<string, unknown>;
    expect(typeof spawn.quoteShellArg).toBe("function");
    expect(browse.quoteShellArg).toBe(spawn.quoteShellArg);
    const quote = spawn.quoteShellArg as (v: string) => string;
    expect(quote("/sdcard/It's here")).toBe("'/sdcard/It'\\''s here'");
  });

  test("realSpawn kills a sleeping child on abort and resolves", async () => {
    const { realSpawn } = await import("../src/util/spawn.ts");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const started = Date.now();
    const result = await realSpawn(["sleep", "30"], { signal: ctl.signal });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.code).not.toBe(0);
  });

  test("scannerWalk honours timeoutMs and kills a child that never exits", async () => {
    const { scannerWalk } = await import("../src/dedupe/scanner.ts");
    const dir = await mkdtemp(join(tmpdir(), "portage-walk-"));
    try {
      const fake = join(dir, "fake-scan");
      await writeFile(fake, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(fake, 0o755);
      const started = Date.now();
      const outcome = await scannerWalk(fake, [dir], [], 1, { timeoutMs: 50 }).then(
        () => "resolved",
        (err: Error) => err.message,
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(outcome).toContain("did not answer");

      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 50);
      const aborted = await scannerWalk(fake, [dir], [], 1, { signal: ctl.signal }).then(
        () => "resolved",
        (err: Error) => err.message,
      );
      expect(aborted).not.toBe("resolved");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("send spike guard", () => {
  test("refuses a folder holding a file the manifest does not list", () => {
    const r = guardFolder(["a.bin", "keep-me.jpg"], ["a.bin"]);
    expect(r.ok).toBe(false);
    expect(r.foreign).toEqual(["keep-me.jpg"]);
  });

  test("accepts an empty folder and a folder of manifest files only", () => {
    expect(guardFolder([], []).ok).toBe(true);
    expect(guardFolder(["a.bin", "b.bin"], ["b.bin", "a.bin", "c.bin"]).ok).toBe(true);
  });

  test("cleanup removes only manifest paths", () => {
    const removed: string[] = [];
    const out = cleanupManifest(["/p/a.bin", "/p/b.bin"], (p) => removed.push(p));
    expect(removed).toEqual(["/p/a.bin", "/p/b.bin"]);
    expect(out.failed).toEqual([]);
  });

  test("cleanup reports a path that would not go and keeps going", () => {
    const out = cleanupManifest(["/p/a", "/p/b"], (p) => {
      if (p === "/p/a") throw new Error("busy");
    });
    expect(out.removed).toEqual(["/p/b"]);
    expect(out.failed).toEqual(["/p/a"]);
  });

  test("the writer refuses a bad experiment name", () => {
    expect(() => writeSpikeRecord("../x", { result: "pass" }, {})).toThrow();
  });
});

describe("send S1 verdict", () => {
  const H = "a".repeat(64);
  const X = "b".repeat(64);
  const good = {
    phoneToHost: { sourceHash: H, receivedHash: H },
    hostToPhone: { sourceHash: H, receivedHash: H },
    control: { sourceHash: H, receivedHash: H },
    push: { sourceHash: H, receivedHash: H },
    renameOver: { ok: true },
    renameNoClobber: { ok: true },
  };

  test("passes only when both directions match", () => {
    const v = s1Verdict(good);
    expect(v.result).toBe("pass");
    expect(v.failedDirections).toEqual([]);
  });

  test("a failed direction carries both hashes", () => {
    const v = s1Verdict({ ...good, hostToPhone: { sourceHash: H, receivedHash: X } });
    expect(v.result).toBe("fail");
    expect(v.failedDirections).toEqual([
      { direction: "host-to-phone", sourceHash: H, receivedHash: X },
    ]);
    const both = s1Verdict({
      ...good,
      phoneToHost: { sourceHash: X, receivedHash: H },
      hostToPhone: { sourceHash: H, receivedHash: X },
    });
    expect(both.failedDirections.map((d) => d.direction)).toEqual([
      "phone-to-host",
      "host-to-phone",
    ]);
  });

  test("a missing hash is not equal", () => {
    const v = s1Verdict({ ...good, phoneToHost: { sourceHash: null, receivedHash: null } });
    expect(v.result).toBe("fail");
  });

  test("control, push and rename results do not change the verdict", () => {
    const v = s1Verdict({
      ...good,
      control: { sourceHash: H, receivedHash: X },
      push: { sourceHash: H, receivedHash: null },
      renameOver: { ok: false },
      renameNoClobber: { ok: false },
    });
    expect(v.result).toBe("pass");
  });
});

describe("send S2 verdict", () => {
  const run = {
    dirtyBeforeKb: 290_000,
    writebackBeforeKb: 0,
    dirtyAfterKb: 0,
    writebackAfterKb: 0,
    syncMs: 900,
  };
  const good = {
    syncExists: true,
    syncExit: 0,
    runs: [run, run, run, run, run],
    flushed: "yes" as const,
    measure: null,
  };

  test("passes when criteria 1, 2 and 4 are answered", () => {
    const v = s2Verdict(good);
    expect(v.result).toBe("pass");
    expect(v.ownerDecision).toBeNull();
  });

  test("a negative flush answer is a valid pass that goes to the owner", () => {
    const v = s2Verdict({ ...good, flushed: "no" });
    expect(v.result).toBe("pass");
    expect(v.ownerDecision).toBe("OI-4");
  });

  test("an undetermined flush answer is not a pass and names the owner decision", () => {
    const v = s2Verdict({ ...good, flushed: "undetermined" });
    expect(v.result).toBe("fail");
    expect(v.ownerDecision).toBe("OI-4");
  });

  test("criterion 1: sync existence and exit status must be stated", () => {
    expect(s2Verdict({ ...good, syncExists: null }).result).toBe("fail");
    expect(s2Verdict({ ...good, syncExit: null }).result).toBe("fail");
    // No sync command: no exit status to state.
    expect(
      s2Verdict({ ...good, syncExists: false, syncExit: null, flushed: "undetermined" }).result,
    ).toBe("fail");
  });

  test("criterion 2: every run needs sync time and meminfo, or a named measure", () => {
    expect(s2Verdict({ ...good, runs: [] }).result).toBe("fail");
    const missing = { ...run, dirtyBeforeKb: null, dirtyAfterKb: null };
    expect(s2Verdict({ ...good, runs: [missing] }).result).toBe("fail");
    expect(s2Verdict({ ...good, runs: [missing], measure: "sync wall time" }).result).toBe("pass");
    expect(s2Verdict({ ...good, runs: [{ ...run, syncMs: null }] }).result).toBe("fail");
  });
});

describe("send S3 verdict", () => {
  const H = "a".repeat(64);
  const X = "b".repeat(64);
  const ran = {
    adbVersion: "Android Debug Bridge version 1.0.41",
    helpNamesExecIn: true,
    helpNamesExecOut: true,
    execInRuns: true as boolean | null,
    sizeBytes: 400_000_000,
    hostHash: H as string | null,
    phoneHash: H as string | null,
    errorOutput: null as string | null,
  };

  test("passes when exec-in ran and the hashes are equal", () => {
    const v = s3Verdict(ran);
    expect(v.result).toBe("pass");
    expect(v.sizeBytes).toBe(400_000_000);
    expect(v.hashesEqual).toBe(true);
  });

  test("passes when exec-in is absent and the absence is recorded", () => {
    const v = s3Verdict({
      ...ran,
      execInRuns: false,
      phoneHash: null,
      errorOutput: "adb: unknown command exec-in",
    });
    expect(v.result).toBe("pass");
    expect(v.execInAbsent).toBe(true);
  });

  test("fails when exec-in ran and the hashes differ, or an absence has no error output", () => {
    expect(s3Verdict({ ...ran, phoneHash: X }).result).toBe("fail");
    expect(s3Verdict({ ...ran, phoneHash: null }).result).toBe("fail");
    expect(s3Verdict({ ...ran, execInRuns: false, errorOutput: null }).result).toBe("fail");
  });

  test("fails when criterion 1 or the file size is not recorded", () => {
    expect(s3Verdict({ ...ran, adbVersion: "" }).result).toBe("fail");
    expect(s3Verdict({ ...ran, execInRuns: null }).result).toBe("fail");
    expect(s3Verdict({ ...ran, sizeBytes: null as unknown as number }).result).toBe("fail");
  });
});

describe("send listing timing", () => {
  test("returns the longest wall time per size", () => {
    const out = summarizeListingTimes([
      { entries: 100, ms: 120 },
      { entries: 100, ms: 340 },
      { entries: 500, ms: 900 },
      { entries: 1000, ms: 1500 },
      { entries: 1000, ms: 1200 },
    ]);
    expect(out.map((s) => [s.entries, s.longestMs])).toEqual([
      [100, 340],
      [500, 900],
      [1000, 1500],
    ]);
  });

  test("flags a size above 3,000 ms, and not one at exactly 3,000 ms", () => {
    const out = summarizeListingTimes([
      { entries: 100, ms: 3000 },
      { entries: 500, ms: 3001 },
      { entries: 1000, ms: 10 },
    ]);
    expect(out.map((s) => s.above3000Ms)).toEqual([false, true, false]);
  });

  test("a size with no samples has no wall time and is not flagged", () => {
    const out = summarizeListingTimes([{ entries: 100, ms: 5 }]);
    expect(out[1]).toEqual({ entries: 500, longestMs: null, above3000Ms: false });
    expect(out[2]).toEqual({ entries: 1000, longestMs: null, above3000Ms: false });
  });

  test("sizes outside 100, 500 and 1,000 are ignored", () => {
    const out = summarizeListingTimes([{ entries: 7, ms: 99_999 }]);
    expect(out.every((s) => s.longestMs === null)).toBe(true);
  });
});

describe("destination check", () => {
  // Loaded per test, so the other blocks pass until these modules exist.
  const loadFs = () => import("../src/util/fs.ts");
  const loadRecovery = () => import("../src/index/recovery.ts");
  const loadProbe = () => import("../src/util/probe.ts");
  const DEADLINE_MS = 50;
  const ROOT = "/mnt/archive-destination-check";
  const NEVER = () => new Promise<never>(() => {});
  const DF_OK = "1B-blocks Avail\n1000000 900000\n";
  const UNREADABLE = "the destination could not be read; nothing was changed";

  type Run = {
    code: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  };
  const reply = (code: number, stdout: string): Promise<Run> =>
    Promise.resolve({ code, stdout, stderr: "", durationMs: 1 });
  /** A spawn that answers `findmnt` and `df` separately. */
  const fake =
    (findmnt: () => Promise<Run>, df: () => Promise<Run>) =>
    (cmd: string[]): Promise<Run> =>
      cmd[0] === "findmnt" ? findmnt() : df();
  const MOUNTED = () => reply(0, `ext4 rw,relatime ${ROOT}\n`);
  const DF = () => reply(0, DF_OK);

  async function reset(): Promise<void> {
    (await loadProbe()).resetDriveState();
  }

  test("readMount reads a mounted target with its type and options", async () => {
    const { readMount } = await loadFs();
    const state = await readMount(fake(MOUNTED, DF), ROOT, DEADLINE_MS);
    expect(state).toEqual({
      kind: "mounted",
      fsType: "ext4",
      options: "rw,relatime",
      target: ROOT,
    });
  });

  test("readMount unescapes spaces in the target", async () => {
    const { readMount } = await loadFs();
    const state = await readMount(
      fake(() => reply(0, "fuseblk rw,nosuid /mnt/My\\x20Drive\n"), DF),
      "/mnt/My Drive",
    );
    expect(state).toMatchObject({ kind: "mounted", target: "/mnt/My Drive" });
  });

  test("readMount: exit 1 with no output is not-mounted", async () => {
    const { readMount } = await loadFs();
    const state = await readMount(
      fake(() => reply(1, ""), DF),
      ROOT,
    );
    expect(state).toEqual({ kind: "not-mounted" });
  });

  test("readMount: a killed findmnt is unreadable, never not-mounted", async () => {
    const { readMount } = await loadFs();
    const killed = () =>
      Promise.resolve({
        code: 124,
        stdout: "",
        stderr: "",
        durationMs: 1,
        signal: "TIMEOUT",
      });
    expect((await readMount(fake(killed, DF), ROOT)).kind).toBe("unreadable");
    const failed = () => reply(2, "");
    expect((await readMount(fake(failed, DF), ROOT)).kind).toBe("unreadable");
  });

  test("a findmnt that never resolves is unreadable with reason timeout", async () => {
    await reset();
    const { probeDestination } = await loadRecovery();
    const probed = await probeDestination(fake(NEVER, DF), ROOT, DEADLINE_MS);
    expect(probed.mount).toMatchObject({ kind: "unreadable" });
    expect(JSON.stringify(probed.mount)).toContain("timeout");
    await reset();
  });

  test("a df that never resolves is unreadable, never zero free space", async () => {
    await reset();
    const { probeDestination, judgeDestination } = await loadRecovery();
    const probed = await probeDestination(
      fake(MOUNTED, NEVER),
      ROOT,
      DEADLINE_MS,
    );
    expect(probed.space.kind).toBe("unreadable");
    const verdict = judgeDestination(probed, 0, 0.02);
    expect(verdict.status).toBe("unreadable");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(UNREADABLE);
    await reset();
  });

  test("a timed-out findmnt gives status unreadable and the EH-13 text", async () => {
    await reset();
    const { checkDestination } = await loadRecovery();
    const verdict = await checkDestination(
      fake(NEVER, DF),
      ROOT,
      0,
      0.02,
      DEADLINE_MS,
    );
    expect(verdict.status).toBe("unreadable");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(UNREADABLE);
    expect(verdict.status).not.toBe("refused");
    await reset();
  });

  test("exit 1 with no output is refused as not mounted", async () => {
    await reset();
    const { checkDestination } = await loadRecovery();
    const verdict = await checkDestination(
      fake(() => reply(1, ""), DF),
      ROOT,
      0,
      0.02,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe("refused");
    expect(verdict.reason).toBe(
      `destination is not on a mounted filesystem: ${ROOT}`,
    );
    await reset();
  });

  test("a mount whose target is / is refused as not mounted", async () => {
    await reset();
    const { checkDestination, judgeDestination, probeDestination } =
      await loadRecovery();
    const onRoot = () => reply(0, "ext4 rw,relatime /\n");
    const verdict = await checkDestination(fake(onRoot, DF), ROOT, 0, 0.02);
    expect(verdict).toMatchObject({
      ok: false,
      status: "refused",
      reason: "the archive drive is not mounted",
    });
    // The run path reads and judges separately; it must refuse the same way.
    const probed = await probeDestination(fake(onRoot, DF), ROOT);
    expect(judgeDestination(probed, 0, 0.02, ROOT).status).toBe("refused");
    await reset();
  });

  test("a mount whose target is not / passes the root rule", async () => {
    await reset();
    const { checkDestination } = await loadRecovery();
    const verdict = await checkDestination(fake(MOUNTED, DF), ROOT, 0, 0.02);
    expect(verdict.ok).toBe(true);
    await reset();
  });

  test("a mounted destination with room is ok", async () => {
    await reset();
    const { checkDestination } = await loadRecovery();
    const verdict = await checkDestination(fake(MOUNTED, DF), ROOT, 1000, 0.02);
    expect(verdict).toMatchObject({
      ok: true,
      status: "ok",
      freeBytes: 900000,
    });
    await reset();
  });
});

describe("deadline checks", () => {
  // Loaded per test, so the other blocks pass until these exports exist.
  const loadProbe = () => import("../src/util/probe.ts");
  const loadDurable = () => import("../src/util/durable.ts");
  const loadDoctor = () => import("../src/serve/doctor.ts");
  const loadAdb = () => import("../src/xfer/adb.ts");
  const NEVER = () => new Promise<never>(() => {});
  const DEADLINE_MS = 50;

  test("formatDeadline writes seconds with up to two decimals", async () => {
    const { formatDeadline } = await loadProbe();
    expect(formatDeadline(3000)).toBe("3 s");
    expect(formatDeadline(50)).toBe("0.05 s");
    expect(formatDeadline(30_000)).toBe("30 s");
    expect(formatDeadline(1500)).toBe("1.5 s");
  });

  test("rsync --version that never resolves is failed, not absent", async () => {
    const { resetDriveState } = await loadProbe();
    const { RsyncTransport } = await loadAdb();
    resetDriveState();
    const transport = new RsyncTransport({
      bin: "rsync",
      port: 8022,
      user: "u",
      partialDir: "/tmp/p",
      spawn: NEVER,
      timeoutMs: DEADLINE_MS,
    } as ConstructorParameters<typeof RsyncTransport>[0]);
    expect(await transport.available("dev")).toEqual({
      kind: "failed",
      reason: "check failed: no answer within 0.05 s",
    });
    resetDriveState();
  });

  test("rsync check at the production deadline reads '3 s'", async () => {
    const { formatDeadline } = await loadProbe();
    expect(`check failed: no answer within ${formatDeadline(3000)}`).toBe(
      "check failed: no answer within 3 s",
    );
  });

  test("rsync check: a missing binary is absent and an answer is available", async () => {
    const { RsyncTransport } = await loadAdb();
    const make = (code: number) =>
      new RsyncTransport({
        bin: "rsync",
        port: 8022,
        user: "u",
        partialDir: "/tmp/p",
        spawn: async () => ({ code, stdout: "rsync 3", stderr: "", durationMs: 1 }),
      } as ConstructorParameters<typeof RsyncTransport>[0]);
    expect((await make(0).available("dev")).kind).toBe("available");
    expect((await make(127).available("dev")).kind).toBe("absent");
  });

  test("a Doctor flush that never resolves says 'check failed', never healthy", async () => {
    const { syncFileOnly } = await loadDurable();
    const { doctorFlushMessage } = await loadDoctor();
    const { formatDeadline } = await loadProbe();
    const { flushDeadlineMs } = await loadDurable();
    const outcome = await syncFileOnly("/tmp/never-synced", 0, {
      open: NEVER,
      deadlineMs: DEADLINE_MS,
    });
    expect(outcome.kind).toBe("timeout");
    const message = doctorFlushMessage(outcome);
    expect(message).toBe("check failed: no answer within 0.05 s");
    expect(message).not.toContain("healthy");
    expect(formatDeadline(flushDeadlineMs(0))).toBe("30 s");
  });

  test("neither check changes a breaker count", async () => {
    const { breakerFor, resetDriveState } = await loadProbe();
    const { syncFileOnly } = await loadDurable();
    const { RsyncTransport } = await loadAdb();
    resetDriveState();
    await syncFileOnly("/tmp/never-synced", 0, { open: NEVER, deadlineMs: 20 });
    await new RsyncTransport({
      bin: "rsync",
      port: 8022,
      user: "u",
      partialDir: "/tmp/p",
      spawn: NEVER,
      timeoutMs: 20,
    } as ConstructorParameters<typeof RsyncTransport>[0]).available("dev");
    expect(breakerFor("/tmp").consecutiveTimeouts).toBe(0);
    expect(breakerFor("/").consecutiveTimeouts).toBe(0);
    resetDriveState();
  });
});

describe("ci frozen check", () => {
  // The shell of design.md "CI changes"; ci.yml carries the same lines.
  const FROZEN = `
set -eu
range_start="$(./scripts/range-start.sh)"
base="$(git merge-base "$range_start" HEAD)"
changed="$(git diff --name-only "$base" HEAD -- src/scan)"
if [ -n "$changed" ]; then
  echo "::error::src/scan is frozen by the acceptance gate. Revert these committed changes:"
  echo "$changed"
  exit 1
fi
`;
  const ZEROS = "0".repeat(40);

  const git = (cwd: string, ...args: string[]): string => {
    const run = Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd },
    );
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim();
  };

  const commit = async (cwd: string, file: string, text: string): Promise<string> => {
    await mkdir(dirname(join(cwd, file)), { recursive: true });
    await writeFile(join(cwd, file), text);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", `change ${file}`);
    return git(cwd, "rev-parse", "HEAD");
  };

  // A repository with the script committed and origin/master at the first commit.
  const repo = async (): Promise<{ dir: string; first: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "portage-frozen-"));
    git(dir, "init", "-q", "-b", "master");
    await commit(dir, "scripts/range-start.sh", readFileSync("scripts/range-start.sh", "utf8"));
    chmodSync(join(dir, "scripts/range-start.sh"), 0o755);
    await commit(dir, "src/scan/a.ts", "a");
    const first = await commit(dir, "src/xfer/b.ts", "b");
    git(dir, "update-ref", "refs/remotes/origin/master", first);
    git(dir, "checkout", "-q", "-b", "feature");
    return { dir, first };
  };

  const sh = (dir: string, script: string, env: Record<string, string> = {}) => {
    const run = Bun.spawnSync(["bash", "-c", script], {
      cwd: dir,
      env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "", ...env },
    });
    return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString() };
  };

  test("a committed change to src/scan fails", async () => {
    const { dir } = await repo();
    try {
      await commit(dir, "src/scan/a.ts", "changed");
      const result = sh(dir, FROZEN);
      expect(result.code).toBe(1);
      expect(result.out).toContain("src/scan/a.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a committed change to src/xfer passes", async () => {
    const { dir } = await repo();
    try {
      await commit(dir, "src/xfer/b.ts", "changed");
      expect(sh(dir, FROZEN).code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a base that moved on is not blamed on the branch", async () => {
    const { dir } = await repo();
    try {
      await commit(dir, "src/xfer/b.ts", "branch work");
      git(dir, "checkout", "-q", "master");
      const tip = await commit(dir, "src/scan/a.ts", "master moved");
      git(dir, "checkout", "-q", "feature");
      expect(sh(dir, FROZEN, { BASE_SHA: tip }).code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("range-start.sh prints BASE_SHA first, then BEFORE, then the merge-base, then the root", async () => {
    const { dir, first } = await repo();
    try {
      const head = await commit(dir, "src/xfer/b.ts", "more");
      const start = (env: Record<string, string>) => sh(dir, "./scripts/range-start.sh", env).out;
      expect(start({ BASE_SHA: "aaa", BEFORE: "bbb" })).toBe("aaa");
      expect(start({ BEFORE: head })).toBe(head);
      expect(start({ BEFORE: ZEROS })).toBe(first);
      expect(start({})).toBe(first);
      git(dir, "update-ref", "-d", "refs/remotes/origin/master");
      expect(start({})).toBe(git(dir, "rev-list", "--max-parents=0", "HEAD"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("path name", () => {
  test("flushFile names the TypeScript path for its directory sync while the branch is B", async () => {
    const { DIRECTORY_SYNC_BRANCH, flushFile } = await import("../src/util/durable.ts");
    expect(DIRECTORY_SYNC_BRANCH).toBe("B");
    const dir = await mkdtemp(join(tmpdir(), "portage-flush-"));
    try {
      const file = join(dir, "a.bin");
      await writeFile(file, "x");
      const open = async () => ({ sync: async () => {}, close: async () => {} });

      const outcome = await flushFile(dir, file, 1, { open });

      expect(outcome.kind).toBe("ok");
      expect((outcome as { path?: string }).path).toBe("typescript");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const SPEC_DIR = join(import.meta.dir, "..", ".kiro", "specs", "transfer-durability-and-fs-hardening");

describe("appendix A rows", () => {
  const requirements = readFileSync(join(SPEC_DIR, "requirements.md"), "utf8");
  const row = (id: string) =>
    requirements.split("\n").find((line) => line.startsWith(`| ${id} |`)) ?? "";

  const expected: Array<[string, string[], string]> = [
    ["P17", ["src/plan/plan.ts 168"], "R2.2 (3 seconds)"],
    ["P18", ["src/serve/doctor.ts 162 and 244"], "R2.2 (3 seconds)"],
    ["P19", ["src/serve/doctor.ts 390 to 410"], "R2.2 (3 seconds)"],
    ["P20", ["src/xfer/engine.ts 374", "src/xfer/purge.ts (line 82"], "R2.2 (flush rule for the file's size)"],
  ];

  for (const [id, sites, deadline] of expected) {
    test(`${id} names its call site and deadline`, () => {
      const text = row(id);
      expect(text).not.toBe("");
      for (const site of sites) expect(text).toContain(site);
      expect(text).toContain(deadline);
    });
  }

  test("the Appendix A files no longer call the blocking reads (R2.6, R2.15)", () => {
    const files = [
      "src/index/recovery.ts",
      "src/plan/plan.ts",
      "src/serve/doctor.ts",
      "src/xfer/adb.ts",
      "src/xfer/engine.ts",
      "src/xfer/purge.ts",
      "src/dedupe/index.ts",
      "src/dedupe/trash.ts",
      "src/serve/dispatch.ts",
      "src/util/fs.ts",
    ];
    const blocking = /spawnSync|statSync|statSyncSafe|diskSpace\(/;
    for (const file of files) {
      const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join("\n");
      expect(code.match(blocking)?.[0] ?? null, file).toBeNull();
    }
  });
});

describe("exact messages", () => {
  const messages: Array<[string, string[]]> = [
    ["flush failed: the drive did not confirm the file was written", ["src/util/durable.ts"]],
    ["flush timed out after ", ["src/util/durable.ts"]],
    ["flush failed: the drive did not confirm the folder entry: ", ["src/util/durable.ts"]],
    [
      "flush skipped: an earlier flush of this folder failed; restart the Engine to retry: ",
      ["src/util/durable.ts"],
    ],
    ["the destination could not be read; nothing was changed", [
      "src/index/recovery.ts",
      "src/dedupe/index.ts",
      "src/xfer/adb.ts",
    ]],
    ["the archive drive stopped answering; restart the Engine after checking the drive", [
      // One constant, imported by engine.ts and doctor.ts.
      "src/util/probe.ts",
    ]],
    ["check failed: no answer within ", ["src/serve/doctor.ts", "src/xfer/adb.ts"]],
    ["the archive drive is not mounted", ["src/index/recovery.ts"]],
    ["drive copy unreadable", ["src/xfer/purge.ts", "src/serve/dispatch.ts"]],
    ["the mount check could not be read", ["src/serve/doctor.ts"]],
    ["the drive copy could not be read", ["src/xfer/engine.ts"]],
    ["the path could not be read; not transferred over", ["src/plan/plan.ts"]],
    ["the trash could not be read", ["src/dedupe/trash.ts"]],
  ];

  for (const [text, files] of messages) {
    test(`"${text}" appears in its source`, () => {
      const found = files.some((file) =>
        readFileSync(join(import.meta.dir, "..", file), "utf8").includes(text),
      );
      expect(found, `${text} in ${files.join(", ")}`).toBe(true);
    });
  }

  test("no unreadable-result text says missing, zero, or healthy", () => {
    for (const [text] of messages) {
      expect(text).not.toMatch(/missing|zero|healthy/);
    }
  });
});

describe("send record", () => {
  test("sendRecordPath follows XDG_STATE_HOME and falls back to ~/.local/state", async () => {
    const { sendRecordPath } = await import("../src/send/record.ts");
    expect(sendRecordPath({ XDG_STATE_HOME: "/x/state" }, "/home/u")).toBe(
      "/x/state/portage/send.db",
    );
    expect(sendRecordPath({}, "/home/u")).toBe(
      "/home/u/.local/state/portage/send.db",
    );
  });

  test("an unopenable record fails with the EH-18 text", async () => {
    const { SendRecord } = await import("../src/send/record.ts");
    const dir = await mkdtemp(join(tmpdir(), "send-record-"));
    try {
      const blocker = join(dir, "not-a-folder");
      await writeFile(blocker, "x");
      expect(() => SendRecord.open(join(blocker, "send.db"))).toThrow(
        /the send record cannot be opened/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a job left running is marked cancelled with 'engine stopped' on the next open", async () => {
    const { SendRecord } = await import("../src/send/record.ts");
    const dir = await mkdtemp(join(tmpdir(), "send-record-"));
    try {
      const path = join(dir, "send.db");
      const first = SendRecord.open(path);
      first.insertJob({
        send_id: "s-1",
        kind: "drive-to-phone",
        source_kind: "drive",
        source_label: "Movies",
        source_device_id: null,
        target_device_id: "dev-1",
        target_folder: "/sdcard/Movies",
        walker: "scanner",
        replace_included: 0,
        move_included: 0,
        files_planned: 1,
        bytes_planned: 10,
        state: "running",
        refusal: null,
        reason: null,
        started_at: 1,
        finished_at: null,
        folders_created: "[]",
        leftover_partials: "[]",
        host_temp_remaining: "[]",
        relays: "[]",
      });
      first.close();

      const second = SendRecord.open(path);
      expect(second.reconcileInterrupted(2)).toBe(1);
      const [job] = second.listJobs(10);
      expect(job?.state).toBe("cancelled");
      expect(job?.reason).toBe("engine stopped");
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("send transfer lock", () => {
  test("Feature: send-to-phone, Property 4: one transfer at a time across pull and send", async () => {
    const { TransferLock } = await import("../src/serve/transfer-lock.ts");
    for (let seed = 1; seed <= 100; seed++) {
      let s = seed;
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x80000000;
      };
      const lock = new TransferLock();
      const held: Array<{ kind: string; release(): void }> = [];
      const stale: Array<{ kind: string; release(): void }> = [];
      for (let step = 0; step < 200; step++) {
        if (rand() < 0.5) {
          const kind = rand() < 0.5 ? "pull" : "send";
          const got = lock.acquire(kind);
          if ("refused" in got) {
            expect(held.length, `seed ${seed}`).toBe(1);
            expect(got.holder, `seed ${seed}`).toBe(held[0]!.kind as never);
          } else {
            expect(held.length, `seed ${seed}`).toBe(0);
            held.push(got);
          }
        } else if (held.length > 0) {
          const lease = held.pop()!;
          lease.release();
          lease.release();
          stale.push(lease);
        }
        // A stale lease must not free a lease taken after it was released.
        if (stale.length > 0 && rand() < 0.3) stale[0]!.release();
        expect(lock.holder(), `seed ${seed}`).toBe(
          (held[0]?.kind ?? null) as never,
        );
      }
    }
  });
});

describe("send phone operations", () => {
  type Answer = (cmd: string[]) => Partial<{ code: number; stdout: string; stderr: string; signal: string }>;
  async function rig(answer: Answer) {
    const { Adb } = await import("../src/device/adb.ts");
    const calls: string[][] = [];
    const spawn = async (cmd: string[]) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "", durationMs: 0, ...answer(cmd) };
    };
    return { calls, adb: new Adb("adb", spawn) };
  }
  const shellCmd = (cmd: string[]) => cmd[cmd.length - 1] ?? "";

  test("sha256Phone is ok, missing, or unreadable, and a timeout is never a digest", async () => {
    const hash = "a".repeat(64);
    const ok = await rig(() => ({ stdout: `${hash}  /sdcard/f\r\n` }));
    expect(await ok.adb.sha256Phone("S", "/sdcard/f", 1000)).toEqual({ kind: "ok", sha256: hash });

    const gone = await rig(() => ({ code: 1, stderr: "sha256sum: /sdcard/f: No such file or directory" }));
    expect((await gone.adb.sha256Phone("S", "/sdcard/f", 1000)).kind).toBe("missing");

    const timeout = await rig(() => ({ code: 124, signal: "TIMEOUT", stdout: `${hash}  x` }));
    expect((await timeout.adb.sha256Phone("S", "/sdcard/f", 1000)).kind).toBe("unreadable");

    const failed = await rig(() => ({ code: 1, stderr: "Permission denied" }));
    expect((await failed.adb.sha256Phone("S", "/sdcard/f", 1000)).kind).toBe("unreadable");

    const noDigest = await rig(() => ({ stdout: "garbage" }));
    expect((await noDigest.adb.sha256Phone("S", "/sdcard/f", 1000)).kind).toBe("unreadable");

    const noTool = await rig(() => ({ code: 127, stderr: "sha256sum: not found" }));
    expect((await noTool.adb.sha256Phone("S", "/sdcard/f", 1000)).kind).toBe("unreadable");
  });

  test("syncPhone runs the device shell's sync, never the adb sync subcommand", async () => {
    const r = await rig(() => ({}));
    expect(await r.adb.syncPhone("S", 1000)).toEqual({ kind: "ok" });
    expect(r.calls[0]).toEqual(["adb", "-s", "S", "shell", "sync"]);
    expect(r.calls.some((c) => c[2] === "sync")).toBe(false);
  });

  test("renameOver uses mv -f to replace and mv -n to copy, then checks the target", async () => {
    const replace = await rig(() => ({}));
    await replace.adb.renameOver("S", "/sdcard/a.part", "/sdcard/a", true, 1000);
    expect(shellCmd(replace.calls[0]!)).toBe("mv -f '/sdcard/a.part' '/sdcard/a'");
    expect(replace.calls.length).toBeGreaterThanOrEqual(2);

    const copy = await rig(() => ({}));
    await copy.adb.renameOver("S", "/sdcard/a.part", "/sdcard/a", false, 1000);
    expect(shellCmd(copy.calls[0]!)).toBe("mv -n '/sdcard/a.part' '/sdcard/a'");
  });

  test("mkdirOne makes one level, with no -p, and quotes its path", async () => {
    const r = await rig(() => ({}));
    expect(await r.adb.mkdirOne("S", "/sdcard/It's", 1000)).toEqual({ kind: "created" });
    expect(shellCmd(r.calls[0]!)).toBe("mkdir '/sdcard/It'\\''s'");
    expect(shellCmd(r.calls[0]!)).not.toContain("-p");

    const exists = await rig(() => ({ code: 1, stderr: "mkdir: File exists" }));
    expect(await exists.adb.mkdirOne("S", "/sdcard/x", 1000)).toEqual({ kind: "exists" });
  });

  test("statPhonePath treats a shell that prints no word as unreadable", async () => {
    const file = await rig(() => ({ stdout: "file 12\r\n" }));
    expect(await file.adb.statPhonePath("S", "/sdcard/f", 1000)).toEqual({ kind: "file", size: 12 });
    const silent = await rig(() => ({ stdout: "" }));
    expect((await silent.adb.statPhonePath("S", "/sdcard/f", 1000)).kind).toBe("unreadable");
  });

  test("freeBytesAt reads the folder's own volume, not /sdcard", async () => {
    const r = await rig(() => ({
      stdout: "Filesystem 1K-blocks Used Available Use% Mounted\n/x 100 40 60 40% /storage/emulated/0\n",
    }));
    const free = await r.adb.freeBytesAt("S", "/storage/emulated/0/Movies", 1000);
    expect(shellCmd(r.calls[0]!)).toContain("'/storage/emulated/0/Movies'");
    expect(free).toEqual({ free: 60 * 1024, total: 100 * 1024 });
  });

  test("push has -Z and no --sync", async () => {
    const r = await rig(() => ({}));
    await r.adb.push("S", "/host/a", "/sdcard/a", 1000);
    expect(r.calls[0]).toContain("-Z");
    expect(r.calls[0]).not.toContain("--sync");
  });
});

describe("send listing", () => {
  test("Feature: send-to-phone, Property 34: a listing that is not complete is unreadable, and a long one is cut at 500", async () => {
    const { parseStrictListing } = await import("../src/device/adb.ts");
    const enc = new TextEncoder();
    const concat = (parts: Uint8Array[]) =>
      Uint8Array.from(parts.flatMap((p) => [...p]));
    const record = (type: string, size: string, path: string) =>
      enc.encode(`${type}\t${size}\t1700000000.5\t${path}\0`);
    const end = enc.encode("END\0");

    for (let seed = 1; seed <= 100; seed++) {
      let s = seed;
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x80000000;
      };
      const n = Math.floor(rand() * 800);
      const parts: Uint8Array[] = [];
      for (let i = 0; i < n; i++) {
        parts.push(record("f", String(10 + i), `/sdcard/d/f${i}.bin`));
      }

      const complete = parseStrictListing(concat([...parts, end]), 0);
      if (complete.kind !== "ok") throw new Error(`seed ${seed}: ${complete.kind}`);
      expect(complete.entries.length, `seed ${seed}`).toBe(Math.min(n, 500));
      expect(complete.truncated, `seed ${seed}`).toBe(n > 500);
      expect(complete.total, `seed ${seed}`).toBe(n);

      expect(parseStrictListing(concat(parts), 0).kind, `seed ${seed}`).toBe("unreadable");
      expect(parseStrictListing(concat([...parts, end]), 1).kind).toBe("unreadable");
      expect(parseStrictListing(concat([...parts, end]), 124).kind).toBe("unreadable");
      expect(
        parseStrictListing(concat([...parts, record("f", "x", "/bad"), end]), 0).kind,
      ).toBe("unreadable");
      expect(
        parseStrictListing(
          concat([enc.encode("f\t1\t1\t/x"), Uint8Array.of(0xff), enc.encode("\0"), end]),
          0,
        ).kind,
      ).toBe("unreadable");
    }

    const linked = parseStrictListing(
      concat([record("l", "0", "/sdcard/link"), record("f", "3", "/sdcard/real"), end]),
      0,
    );
    if (linked.kind !== "ok") throw new Error("a symbolic link is not a failure");
    expect(linked.entries.map((e) => e.path)).toEqual(["/sdcard/real"]);
    expect(JSON.stringify(linked)).toContain("symbolic link");
  });
});

describe("send exec-out stream", () => {
  test("execOutStream yields the phone's bytes unchanged and kill ends the child", async () => {
    const { Adb } = await import("../src/device/adb.ts");
    const { realSpawn } = await import("../src/util/spawn.ts");
    const dir = await mkdtemp(join(tmpdir(), "exec-out-"));
    try {
      const payload = Uint8Array.from([0x0d, 0x0a, 0x00, 0xff, 0x41, 0x0d, 0x0a]);
      await writeFile(join(dir, "payload.bin"), payload);
      const fake = join(dir, "adb");
      await writeFile(
        fake,
        `#!/bin/sh\nif [ "$5" = "sleep" ]; then exec sleep 30; fi\nexec cat "${join(dir, "payload.bin")}"\n`,
      );
      await Bun.$`chmod +x ${fake}`.quiet();
      const adb = new Adb(fake, realSpawn);

      const stream = await adb.execOutStream("S", "/sdcard/x");
      const bytes = new Uint8Array(await new Response(stream.stdout).arrayBuffer());
      expect([...bytes]).toEqual([...payload]);
      expect(await stream.exited).toBe(0);

      const sleeper = await adb.execOutStream("S", "sleep");
      const started = Date.now();
      sleeper.kill();
      const code = await sleeper.exited;
      expect(code).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("send archive mount", () => {
  test("Feature: send-to-phone, Property 6: the archive mount decides admission, and an unreadable mount is never healthy", async () => {
    const { judgeArchiveMount } = await import("../src/send/plan.ts");
    const { seededCases } = await import("./helpers.ts");
    seededCases(6, 150, (rng) => {
      const kind = rng.pick(["mounted", "not-mounted", "unreadable"] as const);
      const state =
        kind === "mounted"
          ? {
              kind,
              fsType: "ext4",
              options: rng.pick(["rw,relatime", "ro,relatime", "rw", "ro"]),
              target: rng.pick(["/", "/mnt/archive", "/media/x"]),
            }
          : kind === "not-mounted"
            ? { kind }
            : { kind, reason: "findmnt was killed" };
      const folder = rng.pick([
        "Movies",
        "Movies/Old",
        "Movies/.portage/x",
        "../etc",
        "Movies/../x",
        "/abs",
      ]);
      const segs = folder.split("/");
      const folderOk =
        !folder.startsWith("/") &&
        !segs.includes("..") &&
        !segs.includes(".portage");
      const j = judgeArchiveMount(state, "/mnt/archive", folder);
      if (kind === "unreadable") {
        expect(j.ok).toBe(false);
        expect(j.reason).toContain("could not be read");
        expect(j.reason).not.toContain("not mounted");
        return;
      }
      if (kind === "not-mounted") {
        expect(j.ok).toBe(false);
        expect(j.reason).toContain("not mounted");
        return;
      }
      const expected =
        state.target !== "/" &&
        !state.options.split(",").includes("ro") &&
        folderOk;
      expect(j.ok).toBe(expected);
    });
  });
});

describe("send free space", () => {
  test("Feature: send-to-phone, Property 13: free space gates for the phone and the host", async () => {
    const { judgeFreeSpace } = await import("../src/send/plan.ts");
    const { seededCases } = await import("./helpers.ts");
    seededCases(13, 150, (rng) => {
      const total = rng.int(1, 1000);
      const free = rng.int(0, total);
      const headroomFraction = rng.pick([0, 0.02, 0.1]);
      const bytesToWrite = rng.int(1, 1200);
      const j = judgeFreeSpace({ free, total, bytesToWrite, headroomFraction });
      const usable = free - Math.ceil(total * headroomFraction);
      const refused = bytesToWrite > usable;
      expect(j.ok).toBe(!refused);
      if (refused && !j.ok) {
        expect(j.shortfall).toBe(bytesToWrite - usable);
      }
    });
    const unknown = judgeFreeSpace({
      free: null,
      total: 100,
      bytesToWrite: 1,
      headroomFraction: 0,
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.ok ? "" : unknown.reason).toContain("could not be read");
  });
});

describe("send device identity", () => {
  test("Feature: send-to-phone, Property 3: device identity and phone choice", async () => {
    const { judgeDevices } = await import("../src/send/plan.ts");
    const { seededCases } = await import("./helpers.ts");
    seededCases(3, 150, (rng) => {
      const count = rng.int(1, 3);
      const phones = Array.from({ length: count }, (_, i) => ({
        id: `dev-${i}`,
        serial: `SER${i}`,
        model: "Pixel 10 Pro XL",
        state: rng.pick(["device", "unauthorized", "offline"]),
        serialno: rng.pick(["SER" + i, ""]),
      }));
      const kind = rng.pick(["drive-to-phone", "phone-to-phone"] as const);
      const targetDeviceId = rng.pick(["dev-0", "dev-1", "dev-9", ""]);
      const sourceDeviceId = rng.pick(["dev-0", "dev-1", null]);
      const request = { kind, sourceDeviceId, targetDeviceId };
      const j = judgeDevices(request, phones);

      if (kind === "drive-to-phone" && targetDeviceId === "") {
        expect(j.ok).toBe(true);
        expect(j.ok && j.target).toBeNull();
        return;
      }
      const target = phones.find((p) => p.id === targetDeviceId);
      if (!target) {
        expect(j.ok).toBe(false);
        return;
      }
      if (target.state !== "device") {
        expect(j.ok).toBe(false);
        return;
      }
      if (target.serialno === "") {
        expect(j.ok).toBe(false);
        expect(j.ok ? "" : j.reason).toContain("serial number");
        return;
      }
      if (kind === "phone-to-phone") {
        const ready = phones.filter(
          (p) => p.state === "device" && p.serialno !== "",
        );
        const ok =
          ready.length === 2 &&
          sourceDeviceId !== null &&
          sourceDeviceId !== targetDeviceId;
        expect(j.ok).toBe(ok);
        return;
      }
      expect(j.ok).toBe(true);
      expect(j.ok && j.target?.id).toBe(targetDeviceId);
    });
    const twins = judgeDevices(
      { kind: "drive-to-phone", sourceDeviceId: null, targetDeviceId: "a" },
      [
        { id: "a", serial: "S", model: "m", state: "device", serialno: "S" },
        { id: "b", serial: "S", model: "m", state: "device", serialno: "S" },
      ],
    );
    expect(twins.ok).toBe(false);
  });
});

describe("send target paths", () => {
  test("Feature: send-to-phone, Property 9: target paths stay inside the target folder", async () => {
    const { targetPathFor, missingFolderChain } = await import(
      "../src/send/plan.ts"
    );
    const { seededCases } = await import("./helpers.ts");
    const target = "/sdcard/Movies/Target";
    seededCases(9, 150, (rng) => {
      const sourceName = rng.pick(["Show", "Trip 2026", "a'b"]);
      const relSegs = Array.from({ length: rng.int(1, 4) }, () =>
        rng.pick(["x", "y", "z"]),
      );
      const relative = [...relSegs, "file.mkv"].join("/");
      const path = targetPathFor(target, sourceName, relative);
      expect(path).toBe(`${target}/${sourceName}/${relative}`);
      expect(path.startsWith(`${target}/`)).toBe(true);

      const dir = path.slice(0, path.lastIndexOf("/"));
      const chainSegs = dir.slice(target.length + 1).split("/");
      const k = rng.int(1, chainSegs.length);
      const existing = new Set<string>([target]);
      for (let i = 0; i < k; i++) {
        existing.add(`${target}/${chainSegs.slice(0, i + 1).join("/")}`);
      }
      const chain = missingFolderChain(dir, existing);
      const expected = chainSegs
        .slice(0, chainSegs.length)
        .map((_, i) => `${target}/${chainSegs.slice(0, i + 1).join("/")}`)
        .filter((p) => !existing.has(p));
      expect(chain).toEqual(expected);
      for (const folder of chain) {
        expect(folder.startsWith(`${target}/`)).toBe(true);
      }
    });
  });
});

describe("send skip rule", () => {
  test("Feature: send-to-phone, Property 10: a file is skipped only when both sides hash the same", async () => {
    const { judgePlanFile } = await import("../src/send/plan.ts");
    const { seededCases } = await import("./helpers.ts");
    seededCases(10, 150, (rng) => {
      const sourceSize = rng.int(1, 50);
      const targetSize = rng.pick([sourceSize, sourceSize + 1]);
      const same = rng.bool();
      let hashCalls = 0;
      const hashes = () => {
        hashCalls++;
        return { source: "aa", target: same ? "aa" : "bb" };
      };
      const j = judgePlanFile({
        sourceSize,
        target: { kind: "file", size: targetSize },
        replace: false,
        hashes,
      });
      if (targetSize !== sourceSize) {
        expect(hashCalls).toBe(0);
        expect(j.verdict).not.toBe("skip-already-there");
      } else {
        expect(hashCalls).toBe(1);
        expect(j.verdict).toBe(same ? "skip-already-there" : "skip-different-file");
      }
    });
    const missing = judgePlanFile({
      sourceSize: 3,
      target: { kind: "missing" },
      replace: false,
      hashes: () => {
        throw new Error("hashed a missing target");
      },
    });
    expect(missing.verdict).toBe("copy");
  });
});

describe("send replace rule", () => {
  test("Feature: send-to-phone, Property 11: a differing file is replaced only when the owner chose replace", async () => {
    const { judgePlanFile } = await import("../src/send/plan.ts");
    const { seededCases } = await import("./helpers.ts");
    seededCases(11, 100, (rng) => {
      const replace = rng.bool();
      const j = judgePlanFile({
        sourceSize: 5,
        target: { kind: "file", size: 5 },
        replace,
        hashes: () => ({ source: "aa", target: "bb" }),
      });
      if (replace) {
        expect(j.verdict).toBe("replace");
        expect(j.replaces).toEqual({ oldSize: 5, oldSha256: "bb" });
      } else {
        expect(j.verdict).toBe("skip-different-file");
        expect(j.replaces).toBeNull();
      }
    });
  });
});

describe("send names", () => {
  test("Feature: send-to-phone, Property 12: names keep their bytes, and case collisions are refused", async () => {
    const { nameVerdict } = await import("../src/send/plan.ts");
    const { quoteShellArg } = await import("../src/util/spawn.ts");
    const { seededCases } = await import("./helpers.ts");
    seededCases(12, 100, (rng) => {
      const names = Array.from({ length: rng.int(1, 4) }, () =>
        rng.text("aAbB .'[]\u00e9\u65e5\u0001\ufffd", 12),
      ).filter((n) => n.length > 0);
      if (rng.bool()) names.push("x".repeat(rng.int(200, 260)));
      const verdicts = nameVerdict(names);
      expect(verdicts.length).toBe(names.length);
      verdicts.forEach((v, i) => {
        const name = names[i] as string;
        expect(v.name).toBe(name);
        const bytes = new TextEncoder().encode(name).length;
        if (/[\u0000-\u001f\u007f\ufffd]/.test(name)) {
          expect(v.action).toBe("skip");
        } else if (bytes + 31 > 255) {
          expect(v.action).toBe("refuse");
          expect(v.reason).toContain("name too long for the phone");
        } else {
          const lower = name.toLowerCase();
          const collides = names.some(
            (other, j) =>
              j !== i &&
              other.toLowerCase() === lower &&
              !/[\u0000-\u001f\u007f\ufffd]/.test(other) &&
              new TextEncoder().encode(other).length + 31 <= 255,
          );
          expect(v.action).toBe(collides ? "refuse" : "keep");
          if (v.action === "keep") {
            const out = Bun.spawnSync([
              "sh",
              "-c",
              `printf '%s' ${quoteShellArg(name)}`,
            ]);
            expect(out.stdout.toString()).toBe(name);
          }
        }
      });
    });
  });
});

describe("send phone source skips", () => {
  test("Feature: send-to-phone, Property 36: zero-byte, in-flight, and recent phone files are skipped, and only those", async () => {
    const { judgeSourcePhoneFile } = await import("../src/send/plan.ts");
    const { IN_FLIGHT_SUFFIXES } = await import("../src/config/schema.ts");
    const { seededCases } = await import("./helpers.ts");
    const now = 1_800_000_000_000;
    seededCases(36, 150, (rng) => {
      const path = rng.pick([
        "/sdcard/a.jpg",
        "/sdcard/b.part",
        "/sdcard/c.TMP",
        "/sdcard/d.crdownload",
        "/sdcard/e.mp4.!ut",
      ]);
      const size = rng.pick([0, 1, 4096]);
      const quietSeconds = rng.pick([0, 60, 120]);
      const mtime = now / 1000 - rng.int(0, 300);
      const skip =
        size === 0 ||
        IN_FLIGHT_SUFFIXES.some((s) => path.toLowerCase().endsWith(s)) ||
        now / 1000 - mtime < quietSeconds;
      const got = judgeSourcePhoneFile({ path, size, mtime }, now, quietSeconds);
      expect(got.skip).toBe(skip);
    });
  });
});

describe("send source queue", () => {
  test("Feature: send-to-phone, Property 8: a source file is queued only when it was read and did not change", async () => {
    const { judgeSourceFile } = await import("../src/send/plan.ts");
    const { seededCases } = await import("./helpers.ts");
    seededCases(8, 120, (rng) => {
      const planned = rng.int(1, 100);
      const stat = rng.pick([
        { kind: "file", size: planned },
        { kind: "file", size: planned + 1 },
        { kind: "missing" },
        { kind: "unreadable", reason: "EACCES" },
        { kind: "folder" },
      ] as const);
      const j = judgeSourceFile(stat, planned);
      if (stat.kind === "missing") expect(j.verdict).toBe("missing-since-plan");
      else if (stat.kind === "unreadable" || stat.kind === "folder")
        expect(j.verdict).toBe("could-not-read-source");
      else if (stat.size !== planned) expect(j.verdict).toBe("refuse");
      else expect(j.verdict).toBe("copy");
    });
  });
});

describe("send request rules", () => {
  test("Feature: send-to-phone, Property 24: move is offered only for phone sources", async () => {
    const { judgeRequest } = await import("../src/send/plan.ts");
    const { ALWAYS_EXCLUDED_DIRS } = await import("../src/config/schema.ts");
    const { seededCases } = await import("./helpers.ts");
    const target = { deviceId: "dev-1", folder: "/sdcard/Movies" };
    seededCases(24, 150, (rng) => {
      const phone = rng.bool();
      const folder = rng.pick([
        "/sdcard/Download",
        "/storage/emulated/0/DCIM",
        "/sdcard/Download/",
        "/data/local",
        "/sdcard/../etc",
        "/sdcard/Android/data/app",
        "/sdcard2/x",
        "/sdcard//Download",
      ]);
      const move = rng.bool();
      const request = phone
        ? { source: { kind: "phone" as const, deviceId: "dev-2", folder }, target, replace: false, move }
        : { source: { kind: "drive" as const, folder: "Movies" }, target, replace: false, move };
      const j = judgeRequest(request);
      if (!phone && move) {
        expect(j.ok).toBe(false);
        return;
      }
      if (!phone) {
        expect(j.ok).toBe(true);
        return;
      }
      const norm = folder.replace(/\/+$/, "");
      const segs = norm.split("/");
      const inRoot =
        norm === "/sdcard" ||
        norm.startsWith("/sdcard/") ||
        norm === "/storage/emulated/0" ||
        norm.startsWith("/storage/emulated/0/");
      const hasDot = segs.includes("..");
      const hasEmpty = segs.slice(1).includes("");
      const excluded = ALWAYS_EXCLUDED_DIRS.some(
        (d) => norm.includes(`/${d}/`) || norm.endsWith(`/${d}`),
      );
      expect(j.ok).toBe(inRoot && !hasDot && !hasEmpty && !excluded);
    });
    const single = judgeRequest({
      source: { kind: "phone", deviceId: "dev-2", folder: "/sdcard/a.mp4" },
      target,
      replace: false,
      move: false,
      single: true,
    });
    expect(single.ok).toBe(true);
  });
});
