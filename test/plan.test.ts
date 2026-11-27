/**
 * What the plan thinks is already on the drive.
 *
 * The journal is a convenience, not the source of truth. A drive that was
 * filled by another machine, or one whose `.portage/portage.db` was lost, still
 * has the files on it. Planning 46 GB of work that is already done is the exact
 * mistake `plan` exists to prevent, so the destination itself is checked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Journal } from "../src/index/journal.ts";
import { buildPlan, type PlanOptions } from "../src/plan/plan.ts";
import type { Candidate } from "../src/scan/scan.ts";
import {
  openJournal,
  makeTempDrive,
  secondsAgo,
  type TempDrive,
} from "./helpers.ts";

const SIZE = 4096;
const ROOT = "/sdcard/Download/Move";

let drive: TempDrive;
let journal: Journal;

beforeEach(async () => {
  drive = await makeTempDrive();
  journal = openJournal(drive);
});

afterEach(async () => {
  journal.close();
  await drive.cleanup();
});

function candidate(relative: string): Candidate {
  return {
    deviceId: "device",
    deviceLabel: "Pixel",
    serial: "serial",
    srcPath: `${ROOT}/${relative}`,
    root: ROOT,
    relative,
    size: SIZE,
    mtime: secondsAgo(3600),
    verdict: "new",
    reason: "not on the drive yet",
  };
}

function planFor(files: Candidate[], extra: Partial<PlanOptions> = {}) {
  const opts: PlanOptions = {
    destRoot: drive.root,
    journal,
    spaceHeadroom: 0,
    ...extra,
  };
  return buildPlan(files, opts);
}

describe("the plan reads the destination, not only the journal", () => {
  test("a file that is not on the drive yet is queued, under the same folder it has on the phone", () => {
    const relative = "Frieren/S01/ep01.mkv";
    const plan = planFor([candidate(relative)]);

    expect(plan.toTransfer).toHaveLength(1);
    expect(plan.bytesTotal).toBe(SIZE);
    // The phone's layout is preserved below the configured root.
    expect(plan.toTransfer[0]!.destPath).toBe(join(drive.root, relative));
  });

  test("a file already at the destination with the same size is skipped", async () => {
    const relative = "Frieren/S01/ep02.mkv";
    const destPath = join(drive.root, relative);
    await mkdir(dirname(destPath), { recursive: true });
    await Bun.write(destPath, new Uint8Array(SIZE));

    const plan = planFor([candidate(relative)]);

    expect(plan.toTransfer).toHaveLength(0);
    expect(plan.bytesTotal).toBe(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.skipReason).toContain("already on the drive");
  });

  test("an interrupted copy this journal knows about is queued, so it can resume", async () => {
    const relative = "Frieren/S01/ep03.mkv";
    const destPath = join(drive.root, relative);
    await mkdir(dirname(destPath), { recursive: true });
    await Bun.write(destPath, new Uint8Array(SIZE - 1));

    const file = candidate(relative);
    const runId = journal.startRun(file.deviceId, "adb");
    journal.upsertTransfer({
      runId,
      deviceId: file.deviceId,
      srcPath: file.srcPath,
      destPath,
      pathNorm: destPath.toLowerCase(),
      size: SIZE,
      srcMtime: file.mtime,
      state: "copying",
    });

    const plan = planFor([file]);

    expect(plan.toTransfer).toHaveLength(1);
  });

  test("a different-sized file that no run claims is a collision, not an overwrite", async () => {
    const relative = "Frieren/S01/ep04.mkv";
    const destPath = join(drive.root, relative);
    await mkdir(dirname(destPath), { recursive: true });
    await Bun.write(destPath, new Uint8Array(SIZE * 2));

    const plan = planFor([candidate(relative)]);

    expect(plan.toTransfer).toHaveLength(0);
    expect(plan.skipped[0]!.skipReason).toContain("collision");
    expect(plan.warnings.some((w) => w.includes("will not overwrite"))).toBe(
      true,
    );
  });

  test("a file this journal recorded as failed is retried, not trusted because the size matches", async () => {
    const relative = "Frieren/S01/ep05.mkv";
    const destPath = join(drive.root, relative);
    await mkdir(dirname(destPath), { recursive: true });
    await Bun.write(destPath, new Uint8Array(SIZE));

    const file = candidate(relative);
    const runId = journal.startRun(file.deviceId, "adb");
    const row = journal.upsertTransfer({
      runId,
      deviceId: file.deviceId,
      srcPath: file.srcPath,
      destPath,
      pathNorm: destPath.toLowerCase(),
      size: SIZE,
      srcMtime: file.mtime,
      state: "failed",
    });
    journal.setState(row.id, "failed", "verification failed: content mismatch");

    const plan = planFor([file]);

    expect(plan.toTransfer).toHaveLength(1);
  });

  test("every file in every folder is still accounted for", async () => {
    const relatives = [
      "A/one.mkv",
      "A/B/two.mkv",
      "A/B/C/three.mkv",
      "D/four.mkv",
    ];
    await Bun.write(
      join(drive.root, "A", "B", "two.mkv"),
      new Uint8Array(SIZE),
    );

    const plan = planFor(relatives.map(candidate));

    expect(plan.files).toHaveLength(4);
    expect(plan.toTransfer.map((f) => f.candidate.relative)).toEqual([
      "A/one.mkv",
      "A/B/C/three.mkv",
      "D/four.mkv",
    ]);
  });
});

describe("a file removed from the pull by hand", () => {
  test("is still planned, marked excluded, and never queued", () => {
    const keep = candidate("Frieren/S01/keep.mkv");
    const drop = candidate("Frieren/S01/drop.mkv");

    const plan = planFor([keep, drop], { exclude: new Set([drop.srcPath]) });

    expect(plan.toTransfer.map((f) => f.candidate.srcPath)).toEqual([
      keep.srcPath,
    ]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.excluded).toBe(true);
    expect(plan.skipped[0]!.skipReason).toContain("removed");
    expect(plan.bytesExcluded).toBe(SIZE);
    expect(plan.bytesSkipped).toBe(SIZE);
    expect(plan.bytesTotal).toBe(SIZE);
  });

  test("is not confused with a file that is already on the drive", () => {
    const drop = candidate("Frieren/S01/other.mkv");
    const plan = planFor([drop], { exclude: new Set([drop.srcPath]) });

    expect(plan.skipped[0]!.alreadyTransferred).toBe(false);
    expect(plan.skipped[0]!.excluded).toBe(true);
  });
});

describe("planner snapshot", () => {
  // Loaded per test, so the older blocks pass until these exports exist.
  const load = () => import("../src/plan/plan.ts");
  const NEVER = () => new Promise<never>(() => {});
  const DEADLINE_MS = 50;
  const UNREADABLE_SKIP = "the path could not be read; not transferred over";

  const MOUNTED = {
    mount: {
      kind: "mounted" as const,
      fsType: "ext4",
      options: "rw",
      target: "/mnt/archive",
    },
    space: { kind: "ok" as const, free: 1e12, total: 2e12 },
  };

  type Entry = import("../src/util/probe.ts").ProbeResult<{
    isFile: boolean;
    size: number;
  }>;
  const ok = (size: number, isFile = true): Entry => ({
    kind: "ok",
    value: { isFile, size },
  });
  const unreadable: Entry = {
    kind: "unreadable",
    reason: "error",
    code: "EIO",
    message: "I/O error",
  };

  async function planWith(files: Candidate[], onDisk: Map<string, Entry>) {
    const { buildPlan } = await load();
    return buildPlan(files, {
      destRoot: drive.root,
      journal,
      spaceHeadroom: 0,
      space: MOUNTED,
      onDisk,
    } as unknown as PlanOptions);
  }

  test("a stalled statDrive makes every path unreadable at the deadline", async () => {
    const { snapshotDestinations } = await load();
    const { probe, resetDriveState } = await import("../src/util/probe.ts");
    resetDriveState();
    try {
      const stalled = (root: string, path: string) =>
        probe(root, `stat ${path}`, NEVER, DEADLINE_MS);
      const paths = [join(drive.root, "a.mkv"), join(drive.root, "b.mkv")];
      const started = performance.now();
      const snap = await snapshotDestinations(drive.root, paths, stalled);
      expect(performance.now() - started).toBeLessThan(2000);
      for (const path of paths) {
        expect(snap.get(path)?.kind).toBe("unreadable");
      }
    } finally {
      resetDriveState();
    }
  });

  test("destinationsFor and snapshotDestinations read a real file", async () => {
    const { destinationsFor, snapshotDestinations } = await load();
    const relative = "Frieren/ep01.mkv";
    await mkdir(join(drive.root, "Frieren"), { recursive: true });
    await Bun.write(join(drive.root, relative), new Uint8Array(SIZE));
    const paths = destinationsFor(
      [candidate(relative), candidate("Frieren/ep02.mkv")],
      drive.root,
    );
    expect(paths).toEqual([
      join(drive.root, relative),
      join(drive.root, "Frieren/ep02.mkv"),
    ]);
    const snap = await snapshotDestinations(drive.root, paths);
    expect(snap.get(paths[0]!)).toEqual(ok(SIZE));
    expect(snap.get(paths[1]!)?.kind).toBe("missing");
  });

  test("an unreadable entry skips the file and never queues it", async () => {
    const relative = "Frieren/ep01.mkv";
    const dest = join(drive.root, relative);
    const plan = await planWith([candidate(relative)], new Map([[dest, unreadable]]));
    expect(plan.toTransfer).toHaveLength(0);
    expect(plan.skipped[0]?.skipReason).toBe(UNREADABLE_SKIP);
  });

  test("an entry absent from the map is skipped the same way", async () => {
    const plan = await planWith([candidate("Frieren/ep01.mkv")], new Map());
    expect(plan.toTransfer).toHaveLength(0);
    expect(plan.skipped[0]?.skipReason).toBe(UNREADABLE_SKIP);
  });

  test("a missing entry is planned for transfer", async () => {
    const relative = "Frieren/ep01.mkv";
    const dest = join(drive.root, relative);
    const plan = await planWith(
      [candidate(relative)],
      new Map<string, Entry>([[dest, { kind: "missing" }]]),
    );
    expect(plan.toTransfer).toHaveLength(1);
  });

  test("an ok file of the same size is skipped, a different size is a collision", async () => {
    const same = join(drive.root, "same.mkv");
    const other = join(drive.root, "other.mkv");
    const plan = await planWith(
      [candidate("same.mkv"), candidate("other.mkv")],
      new Map([
        [same, ok(SIZE)],
        [other, ok(SIZE * 2)],
      ]),
    );
    expect(plan.toTransfer).toHaveLength(0);
    expect(plan.skipped.find((f) => f.destPath === same)?.skipReason).toContain(
      "already on the drive",
    );
    expect(plan.skipped.find((f) => f.destPath === other)?.skipReason).toContain(
      "collision",
    );
  });

  test("buildPlan returns a value, not a promise", async () => {
    const plan = await planWith([], new Map());
    const { buildPlan } = await load();
    const direct = buildPlan([], {
      destRoot: drive.root,
      journal,
      spaceHeadroom: 0,
      space: MOUNTED,
      onDisk: new Map(),
    } as unknown as PlanOptions);
    expect(direct instanceof Promise).toBe(false);
    expect(plan.fileCount).toBe(0);
  });
});
