/**
 * The Rust scanner, held to the engine it replaced.
 *
 * Two things are being asserted, and they are different:
 *
 *  1. **Parity.** The scanner may be faster, but it must not see a different
 *     set of files or produce a different hash. A walker that misses a file
 *     makes a dedupe report quietly wrong, and a hash that differs makes two
 *     identical files look different (harmless) or two different files look
 *     identical (catastrophic). So both are compared against the JavaScript
 *     implementation on the same real tree.
 *  2. **The fallback.** A missing or broken binary must fall back to the
 *     built-in walker and SAY SO in the report, rather than failing the scan or
 *     silently costing three minutes.
 *
 * The parity tests need a built binary and skip without one, because CI builds
 * the engine without Rust. A skipped test here is visible; a silently different
 * walker is not.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanDuplicates } from "../src/dedupe/index.ts";
import { globIo, isExcludedRelative, scannerIo, type ScanIo } from "../src/dedupe/scan-io.ts";
import { resolveScanner, scannerCandidates } from "../src/dedupe/scanner.ts";
import { sampleHash, sha256File } from "../src/util/hash.ts";

const scanner = resolveScanner();

async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "portage-scan-io-"));
  const write = async (relative: string, bytes: number): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, new Uint8Array(bytes).fill(0x41));
  };
  await write("Videos/a.mkv", 128);
  await write("Videos/b.mkv", 128);
  await write("Videos/nested/c.mkv", 4096);
  await write("Videos/nested/deeper/d.mkv", 4096);
  await write("Backup/notes.txt", 64);
  // A MULTI-SEGMENT exclusion. The fallback walker used to test single path
  // segments against the list, so `Android/data` could never match and the two
  // walkers offered different files.
  await write("Android/data/com.app/cache.mkv", 1024);
  await write("Android/media/com.app/keep.mkv", 1024);
  // Empty: never a Portage candidate.
  await write("Backup/empty.txt", 0);
  // Hidden: skipped by both walkers.
  await write(".cache/hidden.mkv", 512);
  // Excluded by name: Portage's own state must never be scanned.
  await write(".portage/trash/2026-11-08/old.mkv", 256);
  await write("System Volume Information/tracking.log", 32);
  // A symlink is not a file and not a directory: it must not be followed.
  await symlink(join(root, "Videos/a.mkv"), join(root, "Backup/link.mkv")).catch(() => {});
  return root;
}

describe("scannerCandidates", () => {
  test("the environment override is tried first", () => {
    const before = Bun.env.PORTAGE_SCAN;
    try {
      Bun.env.PORTAGE_SCAN = "/opt/portage/portage-scan";
      expect(scannerCandidates()[0]).toBe("/opt/portage/portage-scan");
    } finally {
      if (before === undefined) delete Bun.env.PORTAGE_SCAN;
      else Bun.env.PORTAGE_SCAN = before;
    }
  });

  test("it looks next to the engine and in the crate's target directory", () => {
    const candidates = scannerCandidates();
    expect(candidates.some((path) => path.includes("crates/portage-scan/target"))).toBe(true);
    expect(candidates.some((path) => path.endsWith("/portage-scan"))).toBe(true);
  });
});

describe("isExcludedRelative", () => {
  const patterns = ["Android/data", ".portage", "System Volume Information"];

  test("a single-segment pattern matches a directory anywhere", () => {
    expect(isExcludedRelative(".portage/trash/2026-11-08/a.mkv", patterns)).toBe(true);
    expect(isExcludedRelative("System Volume Information/x.log", patterns)).toBe(true);
    expect(isExcludedRelative("Videos/.portage/a.mkv", patterns)).toBe(true);
  });

  test("a multi-segment pattern matches as a directory suffix", () => {
    expect(isExcludedRelative("Android/data/com.app/a.mkv", patterns)).toBe(true);
    expect(isExcludedRelative("sdcard/Android/data/a.mkv", patterns)).toBe(true);
    // Not the same pair, so not excluded.
    expect(isExcludedRelative("Android/media/com.app/a.mkv", patterns)).toBe(false);
    expect(isExcludedRelative("Android/datax/a.mkv", patterns)).toBe(false);
  });

  test("a file's own name never excludes it", () => {
    expect(isExcludedRelative(".portage", patterns)).toBe(false);
    expect(isExcludedRelative("Videos/Android/data.mkv", patterns)).toBe(false);
  });
});

describe("the walkers", () => {
  test.skipIf(scanner === null)("agree on every file the scan would consider", async () => {
    const root = await tree();
    try {
      const fromScanner = await scannerIo().walk([root]);
      const fromGlob = await globIo().walk([root]);

      const key = (candidate: { relative: string; size: number }): string =>
        `${candidate.relative}|${candidate.size}`;
      const scannerSet = fromScanner.candidates.map(key).sort();
      const globSet = fromGlob.candidates.map(key).sort();

      expect(scannerSet).toEqual(globSet);
      expect(fromScanner.bytes).toBe(fromGlob.bytes);
      // And the exclusions actually excluded something, so the test is not
      // passing on two empty lists.
      expect(scannerSet.some((entry) => entry.includes("Android/data"))).toBe(false);
      expect(scannerSet.some((entry) => entry.includes("Android/media"))).toBe(true);
      expect(scannerSet).toHaveLength(6);
      expect(scannerSet.some((entry) => entry.includes(".cache"))).toBe(false);
      expect(scannerSet.some((entry) => entry.includes(".portage"))).toBe(false);
      expect(scannerSet.some((entry) => entry.includes("System Volume Information"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(scanner === null)("report the deepest path, which is what makes a walk slow", async () => {
    const root = await tree();
    try {
      const walked = await scannerIo().walk([root]);
      expect(walked.deepest).not.toBeNull();
      expect(walked.deepest?.depth).toBeGreaterThanOrEqual(4);
      // The invariant that matters is that `depth` IS the segment count — which
      // file wins a tie is traversal order, not a promise.
      expect(walked.deepest?.relative.split('/').length).toBe(walked.deepest?.depth);
      expect(walked.deepest?.relative).not.toContain('Android/data');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the digesters", () => {
  test.skipIf(scanner === null)(
    "the full digest is the same sha256 the engine computes",
    async () => {
      const root = await tree();
      try {
        const io = scannerIo();
        const candidates = (await io.walk([root])).candidates;
        const digests = await io.digests(candidates, "full");
        for (const candidate of candidates) {
          expect(digests.get(candidate.path)).toBe(await sha256File(candidate.path));
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000
  );

  test.skipIf(scanner === null)(
    "the sample digest is the same one the engine computes, byte for byte",
    async () => {
      const root = await tree();
      try {
        const io = scannerIo();
        const candidates = (await io.walk([root])).candidates;
        const samples = await io.digests(candidates, "sample");
        for (const candidate of candidates) {
          expect(samples.get(candidate.path)).toBe(await sampleHash(candidate.path));
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000
  );

  test.skipIf(scanner === null)("a file larger than one read window hashes identically", async () => {
    const root = await mkdtemp(join(tmpdir(), "portage-scan-big-"));
    try {
      // 3 MiB: more than the 1 MiB read buffer and far more than the 64 KiB
      // sample windows, so both code paths are exercised.
      const path = join(root, "big.mkv");
      const bytes = new Uint8Array(3 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
      await writeFile(path, bytes);

      const io = scannerIo();
      const candidates = (await io.walk([root])).candidates;
      const full = await io.digests(candidates, "full");
      const sample = await io.digests(candidates, "sample");
      expect(full.get(path)).toBe(await sha256File(path));
      expect(sample.get(path)).toBe(await sampleHash(path));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a scanner that will not run", () => {
  const broken: ScanIo = {
    via: "scanner",
    async walk() {
      throw new Error("the fast scanner could not be found");
    },
    async digests() {
      throw new Error("the fast scanner could not be found");
    }
  };

  test("the scan falls back to the built-in walker instead of failing", async () => {
    const root = await tree();
    try {
      const report = await scanDuplicates({ roots: [root], io: broken });
      // The fallback found both real duplicate pairs: a/b at 128 bytes and the
      // two 4 KiB files under nested/.
      expect(report.tier1Count).toBe(2);
      expect(report.io?.via).toBe("glob");
      expect(report.io?.scannerError).toContain("could not be found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a report always says which walker ran", async () => {
    const root = await tree();
    try {
      const report = await scanDuplicates({ roots: [root], io: globIo() });
      expect(report.io?.via).toBe("glob");
      expect(report.io?.scannerError).toBeNull();
      expect(report.io?.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(scanner !== null)("with no binary installed, the default is the built-in walker", async () => {
    const root = await tree();
    try {
      const report = await scanDuplicates({ roots: [root] });
      expect(report.io?.via).toBe("glob");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
