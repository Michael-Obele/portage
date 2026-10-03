/**
 * The verification gate.
 *
 * These are the tests that matter most in the whole project, because they are
 * the only thing standing between a flaky cable and a lost episode. Every one
 * of them asserts a *negative*: that something did **not** happen.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Journal } from "../src/index/journal.ts";
import { reconcile } from "../src/index/recovery.ts";
import { runTransfer, type EngineOptions } from "../src/xfer/engine.ts";
import type { CopyOutcome, CopyRequest, Transport } from "../src/xfer/transport.ts";
import type { PlannedFile, PlanResult } from "../src/plan/plan.ts";
import { sha256File } from "../src/util/hash.ts";
import { silentLogger } from "../src/util/log.ts";
import { fakeDevice, makeTempDrive, sha256OfBytes, type TempDrive } from "./helpers.ts";

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
 */
function recordingTransport(
  behaviour: (req: CopyRequest) => CopyOutcome | Promise<CopyOutcome>,
): Transport & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    name: "adb",
    deleted,
    async available() {
      return true;
    },
    async copy(req) {
      return await behaviour(req);
    },
    async removeSource(_serial, srcPath) {
      deleted.push(srcPath);
      return true;
    },
  };
}

/** Behaviour: write `size` bytes of `fill`, report success. */
const copiesBytes = (size: number, fill = 0x41) => async (req: CopyRequest) => {
  await Bun.write(req.destPath, new Uint8Array(size).fill(fill));
  return { status: "copied", bytes: size } as const;
};

/** A fake phone that can be told to return a good or a bad hash. */
const phone = (hash: string | null) => ({
  hashRemote: async () => hash,
});

function plannedFile(srcPath: string, size: number, relative?: string): PlannedFile {
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
    destPath: join(drive.root, relative ?? srcPath.replace("/sdcard/Movies/", "")),
    destNorm: join(drive.root, relative ?? srcPath.replace("/sdcard/Movies/", "")).toLowerCase(),
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
    fileCount: files.length,
    etaSeconds: null,
    space: { ok: true, freeBytes: 1e12, totalBytes: 1e12, usedFraction: 0.1 },
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
    expect(journal.listRecent(1)[0]?.last_error).toContain("sha256sum unavailable");
  });

  test("a device that vanishes mid-run cannot be verified against", async () => {
    const size = 2048;
    const file = plannedFile("/sdcard/Movies/Frieren/ep05.mkv", size);
    const transport = recordingTransport(copiesBytes(size));

    // Empty device map: the phone went away between the copy and the hash.
    const summary = await runTransfer(planOf([file]), new Map(), engineFor(transport, phone("abc")));

    expect(summary.failed).toBe(1);
    expect(transport.deleted).toEqual([]);
    expect(journal.listRecent(1)[0]?.last_error).toContain("device disappeared");
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
      engineFor(transport, phone(sha256OfBytes(size)), { deleteSource: "never" }),
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
    const transport = recordingTransport(() => ({ status: "skipped", bytes: size }));

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
        engineFor(transport, phone(sha256OfBytes(size)), { deleteSource: mode }),
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
      const transport = recordingTransport(() => ({ status: "copied", bytes: file.bytes }));
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

    const report = await reconcile(journal, drive.partialDir);

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
    const report = await reconcile(journal, drive.partialDir);

    expect(report.missing).toBe(1);
    expect(journal.getTransfer(row.id)?.state).toBe("failed");
    expect(journal.getTransfer(row.id)?.last_error).toContain("missing");
  });

  test("an orphan partial is reported, never adopted", async () => {
    await Bun.write(join(drive.partialDir, "stranger.mkv"), "partial");

    const report = await reconcile(journal, drive.partialDir);

    expect(report.orphanPartials.length).toBeGreaterThan(0);
    expect(report.notes.join(" ")).toContain("no journal row");
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