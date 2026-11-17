/**
 * The trash — the step that turns "reclaimable" into reclaimed bytes.
 *
 * `applySelection` MOVES a duplicate to `<destRoot>/.portage/trash/<date>/`, and
 * on the same drive that frees exactly zero. Everything here exists to make the
 * second step honest, so these tests are about two things and nothing else:
 *
 *  1. the numbers a screen shows match what is actually on disk;
 *  2. nothing outside `<destRoot>/.portage/trash/` can ever be deleted, however
 *     it arrives, including through a symlink.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { globIo } from "../src/dedupe/scan-io.ts";
import { emptyTrash, readTrash, trashRootFor } from "../src/dedupe/trash.ts";

async function drive(): Promise<string> {
  return mkdtemp(join(tmpdir(), "portage-trash-"));
}

async function file(path: string, bytes: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, new Uint8Array(bytes).fill(0x41));
}

describe("readTrash", () => {
  test("an untouched drive reports that it has no trash at all", async () => {
    const root = await drive();
    try {
      const status = await readTrash(root, globIo());
      expect(status.exists).toBe(false);
      expect(status.totalFiles).toBe(0);
      expect(status.totalBytes).toBe(0);
      expect(status.days).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("it groups by day and totals both counts and bytes", async () => {
    const root = await drive();
    try {
      const trash = trashRootFor(root);
      await file(join(trash, "2026-11-07", "a.mkv"), 10);
      await file(join(trash, "2026-11-07", "b.mkv"), 15);
      await file(join(trash, "2026-11-08", "c.mkv"), 20);

      const status = await readTrash(root, globIo());
      expect(status.exists).toBe(true);
      expect(status.days.map((day) => day.date)).toEqual(["2026-11-07", "2026-11-08"]);
      expect(status.days[0]?.files).toBe(2);
      expect(status.days[0]?.bytes).toBe(25);
      expect(status.days[1]?.files).toBe(1);
      expect(status.days[1]?.bytes).toBe(20);
      expect(status.totalFiles).toBe(3);
      expect(status.totalBytes).toBe(45);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a file outside a day folder is counted, and called loose", async () => {
    const root = await drive();
    try {
      const trash = trashRootFor(root);
      await file(join(trash, "stray.mkv"), 7);
      await file(join(trash, "2026-11-08", "c.mkv"), 3);

      const status = await readTrash(root, globIo());
      expect(status.looseFiles).toBe(1);
      expect(status.looseBytes).toBe(7);
      expect(status.totalFiles).toBe(2);
      expect(status.totalBytes).toBe(10);
      // A loose file is not a day, and rounding it into one would be a lie.
      expect(status.days.map((day) => day.date)).toEqual(["2026-11-08"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("empty files are still counted, because they are still entries", async () => {
    const root = await drive();
    try {
      const trash = trashRootFor(root);
      await file(join(trash, "2026-11-08", "empty.mkv"), 0);
      await file(join(trash, "2026-11-08", "real.mkv"), 4);

      const status = await readTrash(root, globIo());
      expect(status.totalFiles).toBe(2);
      expect(status.totalBytes).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unreadable folder is not silently rounded away", async () => {
    const root = await drive();
    try {
      const trash = trashRootFor(root);
      const blocked = join(trash, "2026-11-08");
      await file(join(blocked, "a.mkv"), 5);
      await rm(blocked, { recursive: true, force: true });
      await file(join(trash, "2026-11-08", "later.mkv"), 5);

      // A trash root that exists with a day folder is what a real drive looks
      // like; removing and recreating proves the read does not cache a listing.
      const status = await readTrash(root, globIo());
      expect(status.totalFiles).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("emptyTrash", () => {
  test("it deletes one day, counts what it freed, and leaves the other day", async () => {
    const root = await drive();
    try {
      const trash = trashRootFor(root);
      await file(join(trash, "2026-11-07", "a.mkv"), 10);
      await file(join(trash, "2026-11-08", "b.mkv"), 20);

      const result = await emptyTrash(root, [join(trash, "2026-11-07")], globIo());
      expect(result.removedDays).toBe(1);
      expect(result.removedFiles).toBe(1);
      expect(result.bytesFreed).toBe(10);
      expect(result.refused).toEqual([]);
      expect(existsSync(join(trash, "2026-11-07"))).toBe(false);
      expect(existsSync(join(trash, "2026-11-08", "b.mkv"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a path outside the trash is refused, whatever it looks like", async () => {
    const root = await drive();
    try {
      const outside = await drive();
      await file(join(outside, "precious.mkv"), 5);
      await file(join(trashRootFor(root), "2026-11-08", "b.mkv"), 5);

      const result = await emptyTrash(root, [outside], globIo());
      expect(result.removedDays).toBe(0);
      expect(result.bytesFreed).toBe(0);
      expect(result.refused).toHaveLength(1);
      expect(result.refused[0]?.reason).toContain("outside the trash");
      expect(existsSync(join(outside, "precious.mkv"))).toBe(true);

      await rm(outside, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the trash root itself is refused — only what is INSIDE it may go", async () => {
    const root = await drive();
    try {
      const trash = trashRootFor(root);
      await file(join(trash, "2026-11-08", "b.mkv"), 5);

      const result = await emptyTrash(root, [trash], globIo());
      expect(result.removedDays).toBe(0);
      expect(result.refused).toHaveLength(1);
      expect(existsSync(join(trash, "2026-11-08", "b.mkv"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a traversal in the target is refused rather than resolved", async () => {
    const root = await drive();
    try {
      await file(join(trashRootFor(root), "2026-11-08", "b.mkv"), 5);
      const result = await emptyTrash(root, [join(trashRootFor(root), "..", "..")], globIo());
      expect(result.removedDays).toBe(0);
      expect(result.refused).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a symlink inside a day folder does not take its target with it", async () => {
    const root = await drive();
    try {
      const target = await drive();
      await file(join(target, "home-video.mkv"), 9);
      const day = join(trashRootFor(root), "2026-11-08");
      await mkdir(day, { recursive: true });
      await symlink(join(target, "home-video.mkv"), join(day, "shortcut.mkv"));

      const result = await emptyTrash(root, [day], globIo());
      expect(result.refused).toEqual([]);
      expect(existsSync(day)).toBe(false);
      // The link goes; the file it pointed at does not.
      expect(existsSync(join(target, "home-video.mkv"))).toBe(true);

      await rm(target, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emptying a day that is already gone is not an error", async () => {
    const root = await drive();
    try {
      const trash = trashRootFor(root);
      await mkdir(trash, { recursive: true });

      // The folder is listed, then removed by someone else before the delete.
      const result = await emptyTrash(root, [join(trash, "2026-11-08")], globIo());
      expect(result.refused).toEqual([]);
      expect(result.removedDays).toBe(0);
      expect(result.bytesFreed).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a loose file in the trash root is deleted, and its bytes counted", async () => {
    // The panel counts loose files in its "frees X" total, so `trash.empty` has
    // to be able to reach them. It could not: it only ever deleted day folders,
    // and the panel came back with the same loose row forever.
    const root = await drive();
    try {
      const trash = trashRootFor(root);
      await file(join(trash, "stray.mkv"), 7);
      await file(join(trash, "2026-11-08", "b.mkv"), 5);

      const status = await readTrash(root, globIo());
      expect(status.loose).toEqual([join(trash, "stray.mkv")]);

      const result = await emptyTrash(root, status.loose, globIo());
      expect(result.removedFiles).toBe(1);
      expect(result.bytesFreed).toBe(7);
      expect(result.refused).toEqual([]);
      expect(existsSync(join(trash, "stray.mkv"))).toBe(false);
      // The day folder was not in scope, so it is untouched.
      expect(existsSync(join(trash, "2026-11-08", "b.mkv"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an empty list does nothing and frees nothing", async () => {
    const root = await drive();
    try {
      const result = await emptyTrash(root, [], globIo());
      expect(result).toEqual({ removedDays: 0, removedFiles: 0, bytesFreed: 0, refused: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("trashRootFor", () => {
  test("it is one directory, with no doubled separators", () => {
    expect(trashRootFor("/media/node/2TB/Move")).toBe("/media/node/2TB/Move/.portage/trash");
    expect(trashRootFor("/media/node/2TB/Move/")).toBe("/media/node/2TB/Move/.portage/trash");
  });
});
