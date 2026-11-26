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
