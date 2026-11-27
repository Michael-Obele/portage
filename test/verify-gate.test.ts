/**
 * The verification gate.
 *
 * These are the tests that matter most in the whole project, because they are
 * the only thing standing between a flaky cable and a lost episode. Every one
 * of them asserts a *negative*: that something did **not** happen.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { Journal } from "../src/index/journal.ts";
import {
  checkDestination,
  isReadOnlyMount,
  reconcile,
} from "../src/index/recovery.ts";
import { runTransfer, type EngineOptions } from "../src/xfer/engine.ts";
import type {
  CopyOutcome,
  CopyRequest,
  Transport,
} from "../src/xfer/transport.ts";
import type { PlannedFile, PlanResult } from "../src/plan/plan.ts";
import { sha256File } from "../src/util/hash.ts";
import { silentLogger } from "../src/util/log.ts";
import {
  fakeDevice,
  makeTempDrive,
  mountedSpawn,
  sha256OfBytes,
  type TempDrive,
} from "./helpers.ts";

let drive: TempDrive;
let journal: Journal;

beforeEach(async () => {
  drive = await makeTempDrive();
  journal = Journal.open(drive.root);
});

afterEach(async () => {
  journal.close();
  await drive.cleanup();
});

/**
 * A transport harness that records what it was asked to delete.
 *
 * The behaviour callback is fully responsible for what lands on disk — this
 * harness deliberately does NOT write a "correct" file afterwards, because a
 * harness that normalises the output would silently hide every truncation and
 * corruption bug the tests exist to find.
 *
 * With `events`, each copy and each delete is also logged in call order.
 */
function recordingTransport(
  behaviour: (req: CopyRequest) => CopyOutcome | Promise<CopyOutcome>,
  events?: string[],
): Transport & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    name: "adb",
    deleted,
    async available() {
      return { kind: "available" };
    },
    async copy(req) {
      events?.push("copy");
      return await behaviour(req);
    },
    async removeSource(_serial, srcPath) {
      events?.push("delete");
      deleted.push(srcPath);
      return true;
    },
  };
}

/** Behaviour: write `size` bytes of `fill`, report success. */
const copiesBytes =
  (size: number, fill = 0x41) =>
  async (req: CopyRequest) => {
    await Bun.write(req.destPath, new Uint8Array(size).fill(fill));
    return { status: "copied", bytes: size } as const;
  };

/** A fake phone that can be told to return a good or a bad hash. */
const phone = (hash: string | null) => ({
  hashRemote: async () => hash,
});

function plannedFile(
  srcPath: string,
  size: number,
  relative?: string,
): PlannedFile {
  const device = fakeDevice();
  return {
    candidate: {
      deviceId: device.id,
      deviceLabel: device.model,
      serial: device.serial,
      srcPath,
      root: "/sdcard/Movies",
      relative: relative ?? srcPath.replace("/sdcard/Movies/", ""),
      size,
      mtime: 1_700_000_000,
      verdict: "new",
      reason: "",
    },
    destPath: join(
      drive.root,
      relative ?? srcPath.replace("/sdcard/Movies/", ""),
    ),
    destNorm: join(
      drive.root,
      relative ?? srcPath.replace("/sdcard/Movies/", ""),
    ).toLowerCase(),
    alreadyTransferred: false,
    bytes: size,
  };
}

function planOf(files: PlannedFile[]): PlanResult {
  return {
    destRoot: drive.root,
    files,
    toTransfer: files,
    skipped: [],
    bytesTotal: files.reduce((s, f) => s + f.bytes, 0),
    bytesSkipped: 0,
    bytesExcluded: 0,
    fileCount: files.length,
    etaSeconds: null,
    space: {
      ok: true,
      status: "ok",
      freeBytes: 1e12,
      totalBytes: 1e12,
      usedFraction: 0.1,
    },
    warnings: [],
  };
}

function engineFor(
  transport: Transport,
  adb: { hashRemote: (serial: string, path: string) => Promise<string | null> },
  overrides: Partial<EngineOptions> = {},
): EngineOptions {
  return {
    journal,
    transport,
    adb,
    root: drive.root,
    partialDir: drive.partialDir,
    jobs: 1,
    verify: "standard",
    deleteSource: "after-verify",
    resumeThreshold: 0.76,
    logger: silentLogger,
    dryRun: false,
    ...overrides,
  };
}

describe("the verification gate", () => {
  test("a good file verifies and is then deleted from the phone", async () => {
    const size = 4096;
    const file = plannedFile("/sdcard/Movies/Frieren/ep01.mkv", size);
    const transport = recordingTransport(copiesBytes(size));

    const summary = await runTransfer(
      planOf([file]),
      new Map([[file.candidate.deviceId, fakeDevice()]]),
      engineFor(transport, phone(sha256OfBytes(size))),
    );

    expect(summary.verified).toBe(1);
    expect(summary.deleted).toBe(1);
    expect(transport.deleted).toEqual([file.candidate.srcPath]);

    const row = journal.listRecent(1)[0];
    expect(row?.state).toBe("done");
    expect(row?.hash).toBe(sha256OfBytes(size));
  });

  test("a destination whose content does not match is NOT deleted from the phone", async () => {
    const size = 4096;
    const file = plannedFile("/sdcard/Movies/Frieren/ep02.mkv", size);

    // The copy "succeeds" — same size, same filename, wrong bytes. This is the
    // exact scenario that made rsync's --remove-source-files delete the only
    // good copy in the T1 test.
    const transport = recordingTransport(async (req) => {
      await Bun.write(req.destPath, new Uint8Array(req.size).fill(0x42));
      return { status: "copied", bytes: req.size };
    });

    const summary = await runTransfer(
      planOf([file]),
      new Map([[file.candidate.deviceId, fakeDevice()]]),
      engineFor(transport, phone(sha256OfBytes(size, 0x41))),
    );

    expect(summary.failed).toBe(1);
    expect(summary.verified).toBe(0);
    // The single most important assertion in this file.
    expect(transport.deleted).toEqual([]);

    const row = journal.listRecent(1)[0];
    expect(row?.state).toBe("failed");
    expect(row?.last_error).toContain("content mismatch");
  });

  test("a size mismatch fails before a single hash is computed", async () => {
    const file = plannedFile("/sdcard/Movies/Frieren/ep03.mkv", 4096);
    let hashCalls = 0;

    const transport = recordingTransport(async (req) => {
      // Short write — the same shape as a truncated adb pull.
      await Bun.write(req.destPath, new Uint8Array(req.size - 10).fill(0x41));
      return { status: "copied", bytes: req.size - 10 };
    });

    const summary = await runTransfer(
      planOf([file]),
      new Map([[file.candidate.deviceId, fakeDevice()]]),
      engineFor(transport, {
        hashRemote: async () => {
          hashCalls++;
          return sha256OfBytes(4096);
        },
      }),
    );

    expect(summary.failed).toBe(1);
    expect(hashCalls).toBe(0);
    expect(transport.deleted).toEqual([]);
    expect(journal.listRecent(1)[0]?.last_error).toContain("size mismatch");
  });

  test("an unavailable phone-side hash is a failure, never a pass", async () => {
    const size = 2048;
    const file = plannedFile("/sdcard/Movies/Frieren/ep04.mkv", size);
    const transport = recordingTransport(copiesBytes(size));

    const summary = await runTransfer(
      planOf([file]),
      new Map([[file.candidate.deviceId, fakeDevice()]]),
      engineFor(transport, phone(null)), // device has no sha256sum
    );

    expect(summary.verified).toBe(0);
    expect(transport.deleted).toEqual([]);
    expect(journal.listRecent(1)[0]?.last_error).toContain(
      "sha256sum unavailable",
    );
  });

  test("a device that vanishes mid-run cannot be verified against", async () => {
    const size = 2048;
    const file = plannedFile("/sdcard/Movies/Frieren/ep05.mkv", size);
    const transport = recordingTransport(copiesBytes(size));

    // Empty device map: the phone went away between the copy and the hash.
    const summary = await runTransfer(
      planOf([file]),
      new Map(),
      engineFor(transport, phone("abc")),
    );

    expect(summary.failed).toBe(1);
    expect(transport.deleted).toEqual([]);
    expect(journal.listRecent(1)[0]?.last_error).toContain(
      "device disappeared",
    );
  });

  test("a failed copy is never deleted and is recorded with a reason", async () => {
    const file = plannedFile("/sdcard/Movies/Frieren/ep06.mkv", 4096);
    const transport = recordingTransport(() => ({
      status: "failed",
      reason: "adb pull exited 1: interrupted",
      code: 1,
      fatal: false,
    }));

    const summary = await runTransfer(
      planOf([file]),
      new Map([[file.candidate.deviceId, fakeDevice()]]),
      engineFor(transport, phone("abc")),
    );

    expect(summary.failed).toBe(1);
    expect(transport.deleted).toEqual([]);
    expect(journal.listRecent(1)[0]?.state).toBe("failed");
    expect(journal.listRecent(1)[0]?.last_error).toContain("interrupted");
  });
});

describe("deletion is a separate step", () => {
  test("--keep-source verifies but never deletes, and leaves the row purgeable", async () => {
    const size = 1024;
    const file = plannedFile("/sdcard/Movies/Frieren/ep07.mkv", size);
    const transport = recordingTransport(copiesBytes(size));

    const summary = await runTransfer(
      planOf([file]),
      new Map([[file.candidate.deviceId, fakeDevice()]]),
      engineFor(transport, phone(sha256OfBytes(size)), {
        deleteSource: "never",
      }),
    );

    expect(summary.verified).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(summary.kept).toBe(1);
    expect(transport.deleted).toEqual([]);

    // The deferred deletion must be *visible*, not forgotten.
    const pending = journal.listPendingPurge();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.src_path).toBe(file.candidate.srcPath);
  });

  test("a skipped file is never a delete candidate", async () => {
    const size = 1024;
    const file = plannedFile("/sdcard/Movies/Frieren/ep08.mkv", size);
    const transport = recordingTransport(() => ({
      status: "skipped",
      bytes: size,
    }));

    const summary = await runTransfer(
      planOf([file]),
      new Map([[file.candidate.deviceId, fakeDevice()]]),
      engineFor(transport, phone(sha256OfBytes(size))),
    );

    expect(summary.skipped).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(transport.deleted).toEqual([]);
    expect(journal.listRecent(1)[0]?.state).toBe("skipped_duplicate");
  });
});

describe("the journal is idempotent", () => {
  test("re-running the same file updates its row rather than duplicating it", async () => {
    const size = 512;
    const file = plannedFile("/sdcard/Movies/Frieren/ep09.mkv", size);
    const deviceMap = new Map([[file.candidate.deviceId, fakeDevice()]]);

    for (const mode of ["after-verify", "never"] as const) {
      const transport = recordingTransport(copiesBytes(size));
      await runTransfer(
        planOf([file]),
        deviceMap,
        engineFor(transport, phone(sha256OfBytes(size)), {
          deleteSource: mode,
        }),
      );
    }

    // UNIQUE(device_id, src_path, size, mtime) is what makes this true: a second
    // run of the same file updates the row rather than adding another.
    expect(journal.listRecent(10).length).toBe(1);

    // `countByState` reports the row's *current* state, not a history — so the
    // single row now rests at `verified`, which is exactly the state
    // `portage purge` looks for. A keep-source run is not a silent no-op.
    expect(journal.countByState().verified).toBe(1);
    expect(journal.countByState().done ?? 0).toBe(0);
  });

  test("a re-download with a different size is a different row", async () => {
    const a = plannedFile("/sdcard/Movies/Frieren/ep10.mkv", 512);
    const b = plannedFile("/sdcard/Movies/Frieren/ep10.mkv", 600);
    const deviceMap = new Map([[a.candidate.deviceId, fakeDevice()]]);

    for (const file of [a, b]) {
      const transport = recordingTransport(() => ({
        status: "copied",
        bytes: file.bytes,
      }));
      await runTransfer(
        planOf([file]),
        deviceMap,
        engineFor(transport, phone(null), { deleteSource: "never" }),
      );
    }

    // Two distinct transfers, because the content genuinely differs.
    expect(journal.listRecent(10).length).toBe(2);
  });
});

describe("crash recovery", () => {
  test("a row stuck in `copying` becomes failed(interrupted), never silently resumed", async () => {
    journal.upsertTransfer({
      runId: null,
      deviceId: fakeDevice().id,
      srcPath: "/sdcard/Movies/Frieren/ep11.mkv",
      destPath: join(drive.root, "Frieren/ep11.mkv"),
      pathNorm: join(drive.root, "frieren/ep11.mkv").toLowerCase(),
      size: 1024,
      srcMtime: 1_700_000_000,
      state: "copying",
    });

    const report = await reconcile(journal, drive.partialDir, drive.root);

    expect(report.interrupted).toBe(1);
    const row = journal.listRecent(1)[0];
    expect(row?.state).toBe("failed");
    expect(row?.last_error).toContain("interrupted");
  });

  test("a verified row whose destination vanished is failed(missing)", async () => {
    const row = journal.upsertTransfer({
      runId: null,
      deviceId: fakeDevice().id,
      srcPath: "/sdcard/Movies/Frieren/ep12.mkv",
      destPath: join(drive.root, "Frieren/ep12.mkv"),
      pathNorm: join(drive.root, "frieren/ep12.mkv").toLowerCase(),
      size: 1024,
      srcMtime: 1_700_000_000,
      state: "verified",
    });
    journal.setHash(row.id, sha256OfBytes(1024), "full");

    // The destination does not exist — the drive lost the file.
    const report = await reconcile(journal, drive.partialDir, drive.root);

    expect(report.missing).toBe(1);
    expect(journal.getTransfer(row.id)?.state).toBe("failed");
    expect(journal.getTransfer(row.id)?.last_error).toContain("missing");
  });

  test("an orphan partial is reported, never adopted", async () => {
    await Bun.write(join(drive.partialDir, "stranger.mkv"), "partial");

    const report = await reconcile(journal, drive.partialDir, drive.root);

    expect(report.orphanPartials.length).toBeGreaterThan(0);
    expect(report.notes.join(" ")).toContain("no journal row");
  });
});

describe("reconcile three-way", () => {
  function verifiedRow(destPath: string) {
    const row = journal.upsertTransfer({
      runId: null,
      deviceId: fakeDevice().id,
      srcPath: "/sdcard/Movies/Frieren/ep20.mkv",
      destPath,
      pathNorm: destPath.toLowerCase(),
      size: 1024,
      srcMtime: 1_700_000_000,
      state: "verified",
    });
    journal.setHash(row.id, sha256OfBytes(1024), "full");
    return row;
  }

  test("a path under a regular file is unreadable, and the row stays verified", async () => {
    await Bun.write(join(drive.root, "plain"), "x");
    const dest = join(drive.root, "plain", "ep20.mkv");
    const row = verifiedRow(dest);

    const report = await reconcile(journal, drive.partialDir, drive.root);

    expect(report.unreadable).toContain(dest);
    expect(report.missing).toBe(0);
    expect(journal.getTransfer(row.id)?.state).toBe("verified");
  });

  test("a missing destination is still failed with missing", async () => {
    const row = verifiedRow(join(drive.root, "Frieren/ep20.mkv"));

    const report = await reconcile(journal, drive.partialDir, drive.root);

    expect(report.missing).toBe(1);
    expect(report.unreadable).toEqual([]);
    expect(journal.getTransfer(row.id)?.state).toBe("failed");
    expect(journal.getTransfer(row.id)?.last_error).toContain("missing");
  });

  test("an unreadable partial is listed as unreadable, not as an orphan", async () => {
    const loop = join(drive.partialDir, "loop.mkv");
    symlinkSync("loop.mkv", loop); // stat gives ELOOP, which is not ENOENT

    const report = await reconcile(journal, drive.partialDir, drive.root);

    expect(report.unreadable).toContain(loop);
    expect(report.orphanPartials).not.toContain(loop);
  });
});

describe("destination pre-flight", () => {
  // Mount options are a comma-separated list. `errors=remount-ro` is how a
  // read-write ext4 mount says "remount me read-only after an error", and a
  // substring test for `ro,` reads that as a read-only mount. GitHub's
  // runners use exactly that option on /tmp.
  test("remount-ro is not a read-only mount", () => {
    expect(isReadOnlyMount("rw,relatime,errors=remount-ro")).toBe(false);
  });

  test("an ro token is read-only", () => {
    expect(isReadOnlyMount("ro,relatime")).toBe(true);
    expect(isReadOnlyMount("rw,ro")).toBe(true);
    expect(isReadOnlyMount("ro")).toBe(true);
  });

  // The headroom is a margin for the bytes a run will write. A plan that
  // copies nothing writes nothing, so the reserve must not apply to it: at the
  // maximum allowed headroom (0.9) the old arithmetic answered "need 0 bytes,
  // short by N" on any drive that was not nearly empty.
  test("an empty plan is never refused for lack of space", async () => {
    const verdict = await checkDestination(mountedSpawn, drive.root, 0, 0.9);

    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBeUndefined();
  });

  test("a plan that cannot fit is still refused", async () => {
    const verdict = await checkDestination(
      mountedSpawn,
      drive.root,
      Number.MAX_SAFE_INTEGER,
      0.02,
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("not enough space");
    expect(verdict.fix).toContain("dupes");
  });
});

describe("hashing", () => {
  test("streaming sha256 matches the whole-buffer hash", async () => {
    const size = 300_000; // deliberately bigger than one write chunk
    const path = join(drive.root, "big.bin");
    await Bun.write(path, new Uint8Array(size).fill(0x7a));

    expect(await sha256File(path)).toBe(sha256OfBytes(size, 0x7a));
  });

  test("a missing file hashes to null rather than throwing", async () => {
    expect(await sha256File(join(drive.root, "nope.bin"))).toBeNull();
  });
});

describe("dirty ledger", () => {
  // Not a top-level import: until durable.ts exists, the file's other blocks must still run.
  const loadDurable = () => import("../src/util/durable.ts");
  const ROOT = "/archive";
  const SEEDS = 100;
  const LETTERS = ["a", "b", "c"];

  type Hits = { removed: number; bumped: number; poisoned: number };
  type Durable = Awaited<ReturnType<typeof loadDurable>>;

  // mulberry32, as in units.test.ts. A failing seed replays the same sequence.
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

  async function runSequence(
    { ledgerFor, resetLedgers }: Durable,
    seed: number,
    hits: Hits,
  ): Promise<void> {
    resetLedgers();
    const ledger = ledgerFor(ROOT);
    const next = rng(seed);
    const pick = <T>(items: readonly T[]): T =>
      items[Math.floor(next() * items.length)] as T;

    // Nested folders, so the deepest-first order has parents and children to sort.
    const depth = new Map<string, number>();
    while (depth.size < 8) {
      const segments = 1 + Math.floor(next() * 3);
      const dir = join(
        ROOT,
        ...Array.from({ length: segments }, () => pick(LETTERS)),
      );
      depth.set(dir, segments);
    }
    const dirs = [...depth.keys()];

    // Every mark call gets a new stamp. A mark re-created after a clear is a new
    // mark, so an old snapshot must not clear it, even if a version number repeats.
    const marks = new Map<string, { stamp: number; poisoned: boolean }>();
    const taken: Array<Map<string, { version: number; stamp: number }>> = [];
    let stamp = 0;

    const deepestFirst = (x: string, y: string) =>
      (depth.get(y) ?? 0) - (depth.get(x) ?? 0) || (x < y ? -1 : x > y ? 1 : 0);
    const checkListing = () => {
      const listed = ledger.snapshot();
      expect(listed.map((m) => m.dir)).toEqual(
        [...marks.keys()].sort(deepestFirst),
      );
      return listed;
    };

    const steps = 5 + Math.floor(next() * 40);
    for (let step = 0; step < steps; step += 1) {
      const roll = next();
      if (roll < 0.35) {
        const dir = pick(dirs);
        ledger.mark(dir);
        stamp += 1;
        marks.set(dir, { stamp, poisoned: marks.get(dir)?.poisoned ?? false });
      } else if (roll < 0.55) {
        const seen = new Map<string, { version: number; stamp: number }>();
        for (const m of checkListing()) {
          seen.set(m.dir, {
            version: m.version,
            stamp: marks.get(m.dir)?.stamp ?? -1,
          });
        }
        taken.push(seen);
      } else if (roll < 0.85) {
        const earlier = taken.filter((s) => s.size > 0);
        if (earlier.length === 0) continue;
        // The flush gate clears with a version it read earlier, so the test does the same.
        const [dir, seen] = pick([...pick(earlier)]);
        const current = marks.get(dir);
        const removable =
          current !== undefined &&
          !current.poisoned &&
          current.stamp === seen.stamp;
        expect(ledger.clearIfUnchanged(dir, seen.version)).toBe(removable);
        if (removable) {
          marks.delete(dir);
          hits.removed += 1;
        } else if (current?.poisoned) {
          hits.poisoned += 1;
        } else if (current !== undefined) {
          hits.bumped += 1;
        }
      } else {
        if (marks.size === 0) continue;
        const [dir, mark] = pick([...marks]);
        ledger.poison(dir, `fsync failed at step ${step}`);
        mark.poisoned = true;
      }
    }
    checkListing();
  }

  // Feature: transfer-durability-and-fs-hardening, Property 2: The ledger clears only unchanged marks
  // **Validates: Requirements 1.13, 1.15**
  test("Property 2: clears only unchanged marks, over seeded sequences", async () => {
    const durable = await loadDurable();
    const hits: Hits = { removed: 0, bumped: 0, poisoned: 0 };
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      try {
        await runSequence(durable, seed, hits);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(`seed ${seed}: ${why}`);
      }
    }
    // Each outcome must occur, or the property checks nothing useful.
    expect(hits.removed).toBeGreaterThan(0);
    expect(hits.bumped).toBeGreaterThan(0);
    expect(hits.poisoned).toBeGreaterThan(0);
  });

  test("a mark bumped after a snapshot survives a clear with the snapshot's version", async () => {
    const { ledgerFor, resetLedgers } = await loadDurable();
    resetLedgers();
    const ledger = ledgerFor(ROOT);
    const dir = join(ROOT, "a");
    ledger.mark(dir);
    const [seen] = ledger.snapshot();
    ledger.mark(dir);
    expect(ledger.clearIfUnchanged(dir, seen!.version)).toBe(false);
    expect(ledger.snapshot().map((m) => m.dir)).toEqual([dir]);
  });

  test("a poisoned mark is never cleared and still poisons the folders below it", async () => {
    const { ledgerFor, resetLedgers } = await loadDurable();
    resetLedgers();
    const ledger = ledgerFor(ROOT);
    const dir = join(ROOT, "a");
    ledger.mark(dir);
    const [seen] = ledger.snapshot();
    ledger.poison(dir, "fsync failed");
    expect(ledger.clearIfUnchanged(dir, seen!.version)).toBe(false);
    expect(ledger.snapshot().map((m) => m.dir)).toEqual([dir]);
    expect(ledger.chainPoison(join(dir, "child"))?.dir).toBe(dir);
  });
});

describe("breaker", () => {
  // Dynamic, so the file's other blocks still load while the module is missing.
  const loadProbe = () => import("../src/util/probe.ts");
  type Probe = Awaited<ReturnType<typeof loadProbe>>;
  type Outcome = "ok" | "error" | "timeout";
  type Hits = { tripped: number; resets: number; refused: number };

  const ROOT = "/archive";
  const DEADLINE_MS = 50;
  const SEEDS = 100;
  const never = () => new Promise<never>(() => {});
  const failsWith = (code: string) => async (): Promise<never> => {
    throw Object.assign(new Error(code), { code });
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  // Same generator as the dirty ledger block. A sibling describe cannot share it.
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

  async function runBreakerSequence(
    probeModule: Probe,
    seed: number,
    hits: Hits,
  ): Promise<void> {
    const { BREAKER_LIMIT, breakerFor, probe, runFlushCall } = probeModule;
    const root = `${ROOT}/seed-${seed}`;
    const next = rng(seed);
    const steps = 4 + Math.floor(next() * 9);
    let count = 0;
    let tripped = false;

    for (let step = 0; step < steps; step += 1) {
      const viaProbe = next() < 0.5;
      const roll = next();
      const outcome: Outcome =
        roll < 0.35 ? "ok" : roll < 0.6 ? "error" : "timeout";
      const code = next() < 0.5 ? "ENOENT" : "EIO";

      let started = false;
      const task = async (): Promise<string> => {
        started = true;
        if (outcome === "ok") return "value";
        if (outcome === "error") throw Object.assign(new Error(code), { code });
        // Never settles, so the deadline ends the call.
        return await never();
      };

      if (tripped) {
        if (viaProbe) {
          expect(await probe(root, "stat", task, DEADLINE_MS)).toMatchObject({
            kind: "unreadable",
            reason: "refused",
          });
        } else {
          expect(
            (await runFlushCall(root, "flush", DEADLINE_MS, task)).kind,
          ).not.toBe("ok");
        }
        expect(started).toBe(false);
        expect(breakerFor(root).tripped).toBe(true);
        hits.refused += 1;
        continue;
      }

      if (viaProbe) {
        const result = await probe(root, "stat", task, DEADLINE_MS);
        expect(started).toBe(true);
        if (outcome === "ok") {
          expect(result).toMatchObject({ kind: "ok", value: "value" });
        } else if (outcome === "error") {
          expect(result).toMatchObject(
            code === "ENOENT"
              ? { kind: "missing" }
              : { kind: "unreadable", reason: "error" },
          );
        } else {
          expect(result).toMatchObject({
            kind: "unreadable",
            reason: "timeout",
          });
        }
      } else {
        const result = await runFlushCall(root, "flush", DEADLINE_MS, task);
        expect(started).toBe(true);
        if (outcome === "ok") {
          expect(result).toMatchObject({ kind: "ok", value: "value" });
        } else if (outcome === "error") {
          expect(result).toMatchObject({ kind: "error" });
        } else {
          expect(result).toMatchObject({
            kind: "timeout",
            deadlineMs: DEADLINE_MS,
          });
        }
      }

      if (outcome === "timeout") {
        count += 1;
        if (count >= BREAKER_LIMIT) {
          tripped = true;
          hits.tripped += 1;
        }
      } else {
        if (count > 0) hits.resets += 1;
        count = 0;
      }
      const state = breakerFor(root);
      expect(state.consecutiveTimeouts).toBe(count);
      expect(state.tripped).toBe(tripped);
    }
  }

  // Feature: transfer-durability-and-fs-hardening, Property 8: The breaker trips on three consecutive timeouts
  // **Validates: Requirements 2.12, 2.13**
  test("Property 8: the breaker trips and resets as the outcomes dictate, over seeded sequences", async () => {
    const probeModule = await loadProbe();
    probeModule.resetDriveState();
    const hits: Hits = { tripped: 0, resets: 0, refused: 0 };
    // Seeds run together on separate roots, so the 50 ms timeouts do not add up in sequence.
    await Promise.all(
      Array.from({ length: SEEDS }, (_, i) => i + 1).map(async (seed) => {
        try {
          await runBreakerSequence(probeModule, seed, hits);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          throw new Error(`seed ${seed}: ${why}`);
        }
      }),
    );
    // Each outcome must occur, or the property checks nothing useful.
    expect(hits.tripped).toBeGreaterThan(0);
    expect(hits.resets).toBeGreaterThan(0);
    expect(hits.refused).toBeGreaterThan(0);
  });

  test("the breaker trips on the third consecutive timeout, whichever call made it", async () => {
    const { BREAKER_LIMIT, breakerFor, probe, resetDriveState, runFlushCall } =
      await loadProbe();
    resetDriveState();
    const root = `${ROOT}/trip`;
    expect(BREAKER_LIMIT).toBe(3);

    await probe(root, "stat", never, DEADLINE_MS);
    await runFlushCall(root, "flush", DEADLINE_MS, never);
    expect(breakerFor(root)).toMatchObject({
      consecutiveTimeouts: 2,
      tripped: false,
    });

    // The third call still runs and times out. The trip is recorded after it.
    const third = await probe(root, "stat", never, DEADLINE_MS);
    expect(third).toMatchObject({ kind: "unreadable", reason: "timeout" });
    expect(breakerFor(root)).toMatchObject({
      consecutiveTimeouts: 3,
      tripped: true,
    });
  });

  test("a success or an error resets the count", async () => {
    const { breakerFor, probe, resetDriveState, runFlushCall } =
      await loadProbe();
    resetDriveState();
    const root = `${ROOT}/reset`;
    const stall = () => probe(root, "stat", never, DEADLINE_MS);

    await stall();
    await stall();
    await probe(root, "stat", async () => "value", DEADLINE_MS);
    await stall();
    await stall();
    // Without the reset, the first timeout after the success would have tripped the breaker.
    expect(breakerFor(root)).toMatchObject({
      consecutiveTimeouts: 2,
      tripped: false,
    });

    await probe(root, "stat", failsWith("ENOENT"), DEADLINE_MS);
    await stall();
    await stall();
    expect(breakerFor(root)).toMatchObject({
      consecutiveTimeouts: 2,
      tripped: false,
    });

    await runFlushCall(root, "flush", DEADLINE_MS, failsWith("EIO"));
    await stall();
    expect(breakerFor(root)).toMatchObject({
      consecutiveTimeouts: 1,
      tripped: false,
    });
  });

  test("a tripped breaker refuses further work without starting it", async () => {
    const { breakerFor, probe, resetDriveState, runFlushCall } =
      await loadProbe();
    resetDriveState();
    const root = `${ROOT}/refuse`;
    for (let i = 0; i < 3; i += 1) {
      await probe(root, "stat", never, DEADLINE_MS);
    }
    expect(breakerFor(root).tripped).toBe(true);

    let probeStarted = false;
    const probed = await probe(
      root,
      "stat",
      async () => {
        probeStarted = true;
        return "value";
      },
      DEADLINE_MS,
    );
    expect(probed).toMatchObject({ kind: "unreadable", reason: "refused" });
    expect(probeStarted).toBe(false);

    let flushStarted = false;
    const flushed = await runFlushCall(root, "flush", DEADLINE_MS, async () => {
      flushStarted = true;
      return "value";
    });
    expect(flushed.kind).not.toBe("ok");
    expect(flushStarted).toBe(false);
    expect(breakerFor(root).tripped).toBe(true);
  });

  test("a probe waits for a flush that is pending when it starts", async () => {
    const { PROBE_TIMEOUT_MS, probe, resetDriveState, runFlushCall } =
      await loadProbe();
    resetDriveState();
    const root = `${ROOT}/wait`;

    const startedAt = performance.now();
    const flush = runFlushCall(root, "flush", DEADLINE_MS, never);
    const result = await probe(root, "stat", never, DEADLINE_MS);
    const elapsed = performance.now() - startedAt;

    expect(result).toMatchObject({ kind: "unreadable", reason: "timeout" });
    // The flush ends at its 50 ms deadline, and then the probe runs its own 50 ms.
    expect(elapsed).toBeGreaterThanOrEqual(2 * DEADLINE_MS - 10);
    // Far below the 3-second default, so the probe used its 50 ms deadline.
    expect(elapsed).toBeLessThan(PROBE_TIMEOUT_MS);
    expect((await flush).kind).toBe("timeout");
  });

  test("a flush that starts after the probe does not extend its wait", async () => {
    const { probe, resetDriveState, runFlushCall } = await loadProbe();
    resetDriveState();
    const root = `${ROOT}/later`;

    const first = runFlushCall(root, "flush", DEADLINE_MS, never);
    let laterSettled = false;
    const probed = probe(root, "stat", async () => "value", DEADLINE_MS).then(
      (result) => ({ result, laterSettledAtResult: laterSettled }),
    );
    // Starts after the probe and before the first flush reaches its deadline.
    await sleep(40);
    const later = runFlushCall(root, "flush", DEADLINE_MS, never).then((o) => {
      laterSettled = true;
      return o;
    });

    const { result, laterSettledAtResult } = await probed;
    expect(result).toMatchObject({ kind: "ok" });
    expect(laterSettledAtResult).toBe(false);
    expect((await first).kind).toBe("timeout");
    expect((await later).kind).toBe("timeout");
  });
});

describe("durable drive copy", () => {
  // R1.2, R1.3, R1.7, R1.8 and R1.13, with the EH-13 texts.
  // Dynamic imports keep the other blocks loading while durable.ts is missing.
  const loadDurable = () => import("../src/util/durable.ts");
  const loadProbe = () => import("../src/util/probe.ts");
  const fsp = () => import("node:fs/promises");

  const crossDevice = async (): Promise<never> => {
    throw Object.assign(new Error("EXDEV: cross-device link not permitted"), {
      code: "EXDEV",
    });
  };

  async function putFile(
    folder: string,
    name: string,
    text: string,
  ): Promise<string> {
    await (await fsp()).mkdir(folder, { recursive: true });
    const path = join(folder, name);
    await Bun.write(path, text);
    return path;
  }

  async function exists(path: string): Promise<boolean> {
    const { stat } = await fsp();
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  test("flushFile makes exactly two fsync calls, the file and then its folder", async () => {
    const { FLUSH_OPEN_MODE, flushFile } = await loadDurable();
    const folder = join(drive.root, "Frieren");
    const file = await putFile(folder, "ep01.mkv", "episode");
    // `open` is the seam: a recording handle replaces fs.promises.open.
    const events: string[] = [];
    const open = async (path: string, mode: string) => {
      events.push(`open ${mode} ${path}`);
      return {
        sync: async () => {
          events.push(`sync ${path}`);
        },
        close: async () => {
          events.push(`close ${path}`);
        },
      };
    };

    expect(await flushFile(drive.root, file, 7, { open })).toEqual({
      kind: "ok",
    });
    // Linux does not open a directory for writing, so the folder opens with "r".
    expect(events).toEqual([
      `open ${FLUSH_OPEN_MODE} ${file}`,
      `sync ${file}`,
      `close ${file}`,
      `open r ${folder}`,
      `sync ${folder}`,
      `close ${folder}`,
    ]);
  });

  test("ensureDirTracked creates a deep folder top-down and reports created", async () => {
    const { ensureDirTracked } = await loadDurable();
    const { stat } = await fsp();
    const top = join(drive.root, "one");
    const middle = join(top, "two");
    const deep = join(middle, "three");

    expect(await ensureDirTracked(deep, drive.root)).toEqual({
      kind: "created",
      created: [top, middle, deep],
    });
    expect((await stat(deep)).isDirectory()).toBe(true);
  });

  test("two concurrent calls on one folder give one created and one exists", async () => {
    const { ensureDirTracked } = await loadDurable();
    // One missing level, so only one mkdir can succeed. A deeper path can split
    // its levels between the two calls.
    const dir = join(drive.root, "one");

    const outcomes = await Promise.all([
      ensureDirTracked(dir, drive.root),
      ensureDirTracked(dir, drive.root),
    ]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["created", "exists"]);
  });

  test("flushGate refuses a copy beneath a poisoned folder and accepts one elsewhere", async () => {
    const { flushGate, ledgerFor } = await loadDurable();
    const { mkdir } = await fsp();
    const poisoned = join(drive.root, "a");
    const beneath = join(poisoned, "b");
    const elsewhere = join(drive.root, "c");
    await mkdir(beneath, { recursive: true });
    await mkdir(elsewhere);

    const ledger = ledgerFor(drive.root);
    ledger.mark(poisoned);
    ledger.poison(poisoned, "fsync failed");
    ledger.mark(elsewhere);

    expect(await flushGate(drive.root, beneath)).toEqual({
      kind: "refused",
      reason: `flush skipped: an earlier flush of this folder failed; restart the Engine to retry: ${poisoned}`,
    });
    expect(await flushGate(drive.root, elsewhere)).toEqual({ kind: "ok" });
  });

  test("a cross-device move flushes and gates the copy before it unlinks the source", async () => {
    const { ledgerFor, moveFile } = await loadDurable();
    const from = await putFile(join(drive.root, "from"), "clip.bin", "episode");
    const toDir = join(drive.root, "to");
    await (await fsp()).mkdir(toDir);
    const to = join(toDir, "clip.bin");
    ledgerFor(drive.root).mark(toDir);

    expect(
      await moveFile(drive.root, from, to, { rename: crossDevice }),
    ).toEqual({ kind: "moved", via: "copy" });
    expect(await Bun.file(to).text()).toBe("episode");
    expect(await exists(from)).toBe(false);
    // The gate clears a folder's mark only after its fsync succeeds.
    expect(
      ledgerFor(drive.root)
        .snapshot()
        .map((m) => m.dir),
    ).not.toContain(toDir);
  });

  test("a failed flush keeps the source of a cross-device move", async () => {
    const { ledgerFor, moveFile } = await loadDurable();
    const from = await putFile(join(drive.root, "from"), "clip.bin", "episode");
    const toDir = join(drive.root, "to");
    await (await fsp()).mkdir(toDir);
    // A poisoned folder makes the gate refuse the copy, which fails the move's flush.
    const ledger = ledgerFor(drive.root);
    ledger.mark(toDir);
    ledger.poison(toDir, "fsync failed");

    const outcome = await moveFile(drive.root, from, join(toDir, "clip.bin"), {
      rename: crossDevice,
    });
    expect(outcome.kind).toBe("failed");
    expect(await Bun.file(from).text()).toBe("episode");
  });

  test("a failed file flush reports the EH-13 text, matched exactly", async () => {
    const { flushFile } = await loadDurable();
    const folder = join(drive.root, "Frieren");
    const file = await putFile(folder, "ep02.mkv", "episode");
    const open = async (path: string) => ({
      sync: async () => {
        if (path === file) {
          throw Object.assign(new Error("EIO: input/output error"), {
            code: "EIO",
          });
        }
      },
      close: async () => {},
    });

    expect(await flushFile(drive.root, file, 7, { open })).toEqual({
      kind: "failed",
      reason: "flush failed: the drive did not confirm the file was written",
      target: "file",
      path: file,
    });
  });

  test("a stalled flush does not block a status request", async () => {
    const { flushFile } = await loadDurable();
    const { probe } = await loadProbe();
    const file = await putFile(
      join(drive.root, "Frieren"),
      "ep03.mkv",
      "episode",
    );
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let flushed = false;
    const flush = flushFile(drive.root, file, 7, {
      open: async () => {
        await gate;
        return { sync: async () => {}, close: async () => {} };
      },
    }).then((outcome) => {
      flushed = true;
      return outcome;
    });

    // A status answer passes a null root, so it waits for no flush (R1.7).
    expect(await probe(null, "status", async () => "idle")).toEqual({
      kind: "ok",
      value: "idle",
    });
    expect(flushed).toBe(false);

    release();
    expect(await flush).toEqual({ kind: "ok" });
  });
});

describe("durability order", () => {
  // Property 1 (design.md, Per-file order, steps 3 to 9). The engine takes its
  // flush functions through the optional `durability` argument of runTransfer
  // (tasks.md Notes N4). The fakes replace them, so durable.ts never loads.
  type Durability = Pick<
    typeof import("../src/util/durable.ts"),
    "flushFile" | "flushGate"
  >;
  type Flush = Awaited<ReturnType<Durability["flushFile"]>>;
  type Outcome = "ok" | "failed" | "timeout";
  type Copy = {
    relative: string;
    fileFlush: Outcome;
    dirFlush: Outcome;
    gate: Outcome;
    hashMatches: boolean;
  };

  const SEEDS = 100;
  const SIZE = 4096;
  const FILE_DEADLINE_MS = 31_000; // flushDeadlineMs(4096), R1.12
  const GATE_DEADLINE_MS = 30_000; // DIR_FSYNC_DEADLINE_MS, R1.13
  const ENDINGS = [
    "file failed",
    "file timeout",
    "dir failed",
    "dir timeout",
    "gate failed",
    "gate timeout",
    "deleted",
    "hash mismatch",
  ];

  // Same generator as the blocks above. Each describe keeps its own copy.
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

  // Each seed draws 1 to 4 copies, each with an outcome per flush call.
  function drawCopies(seed: number): Copy[] {
    const next = rng(seed);
    const outcome = (): Outcome => {
      const roll = next();
      return roll < 0.6 ? "ok" : roll < 0.8 ? "failed" : "timeout";
    };
    const count = 1 + Math.floor(next() * 4);
    return Array.from({ length: count }, (_, index) => ({
      relative: `seed-${seed}/copy-${index}/ep.mkv`,
      fileFlush: outcome(),
      dirFlush: outcome(),
      gate: outcome(),
      hashMatches: next() < 0.8,
    }));
  }

  // The events one copy produces, in order. A flush that is not ok stops the copy.
  function expectedEvents(copy: Copy): string[] {
    const events = ["copy", "file flush"];
    if (copy.fileFlush !== "ok") return events;
    events.push("directory flush");
    if (copy.dirFlush !== "ok") return events;
    events.push("gate");
    if (copy.gate !== "ok") return events;
    events.push("written", "hash");
    if (copy.hashMatches) events.push("delete");
    return events;
  }

  const wasDeleted = (copy: Copy): boolean =>
    copy.fileFlush === "ok" &&
    copy.dirFlush === "ok" &&
    copy.gate === "ok" &&
    copy.hashMatches;

  // The first flush that is not ok ends the copy. Otherwise the hash decides.
  function endingOf(copy: Copy): string {
    const flushes: Array<[string, Outcome]> = [
      ["file", copy.fileFlush],
      ["dir", copy.dirFlush],
      ["gate", copy.gate],
    ];
    const stop = flushes.find(([, outcome]) => outcome !== "ok");
    if (stop) return `${stop[0]} ${stop[1]}`;
    return copy.hashMatches ? "deleted" : "hash mismatch";
  }

  // FlushOutcome shapes (DV-30). The failure text is EH-13.
  function badFlush(
    outcome: Exclude<Outcome, "ok">,
    target: "file" | "dir",
    path: string,
    deadlineMs: number,
  ): Flush {
    if (outcome === "timeout") {
      return { kind: "timeout", deadlineMs, target, path };
    }
    const reason =
      target === "file"
        ? "flush failed: the drive did not confirm the file was written"
        : `flush failed: the drive did not confirm the folder entry: ${path}`;
    return { kind: "failed", reason, target, path };
  }

  // Runs the copies as one transfer with fake flushes, and returns the call log.
  async function runCopies(copies: Copy[]) {
    const events: string[] = [];
    const byFile = new Map<string, Copy>();
    const byDir = new Map<string, Copy>();
    const phoneHash = new Map<string, string>();
    const files = copies.map((copy) => {
      const file = plannedFile(
        `/sdcard/Movies/${copy.relative}`,
        SIZE,
        copy.relative,
      );
      byFile.set(file.destPath, copy);
      byDir.set(dirname(file.destPath), copy);
      // The drive copy holds 0x41 bytes, so a phone hash of 0x42 must fail.
      phoneHash.set(
        file.candidate.srcPath,
        sha256OfBytes(SIZE, copy.hashMatches ? 0x41 : 0x42),
      );
      return file;
    });

    const device = fakeDevice();
    const transport = recordingTransport(copiesBytes(SIZE), events);
    const adb = {
      hashRemote: async (_serial: string, srcPath: string) => {
        events.push("hash");
        return phoneHash.get(srcPath) ?? null;
      },
    };
    const durability: Durability = {
      flushFile: async (_root: string, path: string) => {
        events.push("file flush");
        const copy = byFile.get(path)!;
        if (copy.fileFlush !== "ok") {
          return badFlush(copy.fileFlush, "file", path, FILE_DEADLINE_MS);
        }
        events.push("directory flush");
        const dir = dirname(path);
        if (copy.dirFlush !== "ok") {
          return badFlush(copy.dirFlush, "dir", dir, FILE_DEADLINE_MS);
        }
        return { kind: "ok" };
      },
      flushGate: async (_root: string, dir: string) => {
        events.push("gate");
        const copy = byDir.get(dir)!;
        return copy.gate === "ok"
          ? { kind: "ok" }
          : badFlush(copy.gate, "dir", dir, GATE_DEADLINE_MS);
      },
    };

    // Only the journal sets `written`, so a spy on it logs that step.
    const setState = journal.setState.bind(journal);
    const spy = spyOn(journal, "setState").mockImplementation(
      (id, state, error) => {
        if (state === "written") events.push("written");
        setState(id, state, error);
      },
    );
    try {
      const summary = await runTransfer(
        planOf(files),
        new Map([[device.id, device]]),
        engineFor(transport, adb),
        durability,
      );
      return { events, transport, files, summary };
    } finally {
      spy.mockRestore();
    }
  }

  // One seed's copies must match the model for events, deletions, counts, and rows.
  async function checkSeed(
    seed: number,
    hits: Map<string, number>,
  ): Promise<void> {
    const copies = drawCopies(seed);
    const { events, transport, files, summary } = await runCopies(copies);

    expect(events).toEqual(copies.flatMap(expectedEvents));
    expect(transport.deleted).toEqual(
      files
        .filter((_, i) => wasDeleted(copies[i]!))
        .map((file) => file.candidate.srcPath),
    );
    expect(summary.deleted).toBe(copies.filter(wasDeleted).length);
    expect(summary.failed).toBe(copies.filter((c) => !wasDeleted(c)).length);
    files.forEach((file, i) => {
      const row = journal.findTransfer(
        file.candidate.deviceId,
        file.candidate.srcPath,
        file.candidate.size,
        file.candidate.mtime,
      );
      expect(row?.state).toBe(wasDeleted(copies[i]!) ? "done" : "failed");
    });
    for (const copy of copies) {
      const ending = endingOf(copy);
      hits.set(ending, (hits.get(ending) ?? 0) + 1);
    }
  }

  // R2.6: runs `run` under spies on both spawn functions, and returns what it started.
  async function spawnsDuring<T>(
    run: () => Promise<T>,
  ): Promise<{ result: T; spawned: unknown[] }> {
    const spawn = spyOn(Bun, "spawn");
    const spawnSync = spyOn(Bun, "spawnSync");
    try {
      const result = await run();
      return {
        result,
        spawned: [...spawn.mock.calls, ...spawnSync.mock.calls],
      };
    } finally {
      spawn.mockRestore();
      spawnSync.mockRestore();
    }
  }

  test("one copy runs file flush, directory flush, gate, written, hash, delete, in that order", async () => {
    const copy: Copy = {
      relative: "fixed/ep01.mkv",
      fileFlush: "ok",
      dirFlush: "ok",
      gate: "ok",
      hashMatches: true,
    };
    const { result, spawned } = await spawnsDuring(() => runCopies([copy]));
    const { events, transport, summary } = result;

    expect(events).toEqual([
      "copy",
      "file flush",
      "directory flush",
      "gate",
      "written",
      "hash",
      "delete",
    ]);
    expect(transport.deleted).toEqual(["/sdcard/Movies/fixed/ep01.mkv"]);
    expect(summary.deleted).toBe(1);
    expect(spawned).toEqual([]);
  });

  // Feature: transfer-durability-and-fs-hardening, Property 1: Ordering of durability steps
  // **Validates: Requirements 1.1, 1.4, 1.6, 1.9, 2.6**
  test("Property 1: written and delete follow the flushes and the hash, over seeded copy sequences", async () => {
    const hits = new Map<string, number>();
    const { spawned } = await spawnsDuring(async () => {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        try {
          await checkSeed(seed, hits);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          throw new Error(`seed ${seed}: ${why}`);
        }
      }
    });
    // Each ending must occur, or the property checks nothing useful.
    expect([...hits.keys()].sort()).toEqual([...ENDINGS].sort());
    expect(spawned).toEqual([]);
  });
});
