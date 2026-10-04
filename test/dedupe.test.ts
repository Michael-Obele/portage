/**
 * The dedupe engine, asserted on.
 *
 * The first test is the one that matters most. docs/dedupe.md §6 rule 10:
 *
 *   "M5 acceptance includes hand-crafting a same-size-different-content pair and
 *    a same-episode pair, and confirming the first is NOT reported as identical
 *    and the second is NOT deleted. A dedupe tool that has never been shown a
 *    false positive is not yet trustworthy."
 *
 * A dedupe tool that has never been shown a false positive is not yet
 * trustworthy. So we show it one, deliberately.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySelection, scanDuplicates } from "../src/dedupe/index.ts";
import { sampleHash, sha256File } from "../src/util/hash.ts";
import { resolveInside } from "../src/util/paths.ts";

async function drive(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "portage-dedupe-"));
  await mkdir(join(root, "Anime"), { recursive: true });
  return root;
}

async function put(
  root: string,
  rel: string,
  bytes: number,
  fill = 0x41,
): Promise<string> {
  const path = join(root, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, new Uint8Array(bytes).fill(fill));
  return path;
}

describe("§6 rule 10 — the deliberate break", () => {
  test("same size, one byte different, is NOT identical", async () => {
    const root = await drive();
    try {
      const size = 1024 * 1024;
      const a = join(root, "Anime", "a.mkv");
      const b = join(root, "Anime", "b.mkv");
      const buf = new Uint8Array(size).fill(0x41);
      await Bun.write(a, buf);
      // Differ in exactly ONE byte, at 128 KiB — outside the first, middle and
      // last 64 KiB windows that sampleHash reads.
      const changed = new Uint8Array(buf);
      changed[128 * 1024] = 0x42;
      await Bun.write(b, changed);

      // The premise of the test, stated so a failure is unambiguous:
      expect((await sampleHash(a)) === (await sampleHash(b))).toBe(true);
      expect(await sha256File(a)).not.toBe(await sha256File(b));

      const report = await scanDuplicates({ roots: [root] });
      const paths = report.groups.flatMap((g) => g.members.map((m) => m.path));
      expect(paths).not.toContain(a);
      expect(paths).not.toContain(b);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("byte-identical files ARE tier 1, with a suggested keeper", async () => {
    const root = await drive();
    try {
      const a = await put(root, "Anime/Frieren S01/ep01.mkv", 4096);
      const b = await put(root, "Anime/Frieren S01/ep01 (copy).mkv", 4096);
      const report = await scanDuplicates({ roots: [root] });
      const g = report.groups.find((x) => x.tier === 1);
      expect(g).toBeDefined();
      const paths = g!.members.map((m) => m.path).sort();
      expect(paths).toEqual([a, b].sort());
      // Exactly one keeper, and it is advisory.
      expect(g!.members.filter((m) => m.keep).length).toBe(1);
      expect(report.reclaimableBytes).toBe(4096);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("§6 rule 11 — truncation is a problem, not a duplicate", () => {
  test("a fragment wearing an episode's name is flagged and never kept", async () => {
    const root = await drive();
    try {
      // 2000 is the same episode as 400000, at a tenth the size: exactly the
      // field evidence in §6 rule 11.
      const full = await put(root, "Anime/Heroes S1/s01e07.mkv", 400_000);
      const fragment = await put(
        root,
        "Anime/Heroes S1/s01e17.mkv",
        40_000,
        0x42,
      );
      const report = await scanDuplicates({ roots: [root] });
      expect(report.truncated).toContain("Anime/Heroes S1/s01e17.mkv");
      // And it is not proposed as anything to keep.
      for (const g of report.groups) {
        const m = g.members.find((x) => x.path === fragment);
        if (m) expect(m.keep).toBe(false);
        expect(g.members.some((x) => x.path === full && x.keep)).toBeTruthy();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("§5 — tier 2 groups what it can and never guesses the rest", () => {
  test("two releases of one episode group; two episodes do not", async () => {
    const root = await drive();
    try {
      await put(
        root,
        "Anime/Frieren.S01E07.1080p.WEB-DL.SubsPlease.mkv",
        400_000,
      );
      await put(root, "Anime/Frieren.S01E07.720p.TV.mkv", 300_000);
      await put(root, "Anime/Frieren.S01E08.1080p.WEB-DL.mkv", 400_000);
      const report = await scanDuplicates({ roots: [root], tier: 2 });
      const labels = report.groups.map((g) => g.label);
      expect(labels).toContain('S01E07 "frieren"');
      expect(labels).not.toContain('S01E08 "frieren"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an abbreviated title is left alone, never guessed", async () => {
    const root = await drive();
    try {
      // `hrs` is Higehiro. No parser can know that, so it must not be grouped.
      await put(
        root,
        "Anime/hrs.s01e01.br720p.x264.400mb-pahe.in.mkv",
        400_000,
      );
      await put(root, "Anime/hrs.s01e01.1080p.x264.900mb.mkv", 900_000);
      const report = await scanDuplicates({ roots: [root], tier: 2 });
      expect(report.groups).toHaveLength(0);
      expect(report.unparsed.length).toBeGreaterThan(0);
      expect(report.unparsed.join(" ")).toContain("abbreviation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the doc's own '- 07' filenames are reported unparsed, not grouped", async () => {
    const root = await drive();
    try {
      await put(root, "Anime/Frieren - 07 [1080p][SubsPlease].mkv", 400_000);
      await put(
        root,
        "Anime/Frieren - 07 [720p][TV][HorribleSubs].mkv",
        300_000,
      );
      const report = await scanDuplicates({ roots: [root], tier: 2 });
      // parse-torrent-title does not recognise a bare `- 07`. §5 says v1 prints
      // `unparsed` rather than guessing, so that is the correct outcome.
      expect(report.groups).toHaveLength(0);
      expect(report.unparsed.length).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("§6 rule 1 — the report moves nothing", () => {
  test("a full scan leaves every file exactly where it was", async () => {
    const root = await drive();
    try {
      const a = await put(root, "Anime/x.mkv", 4096);
      const b = await put(root, "Anime/y.mkv", 4096);
      await scanDuplicates({ roots: [root] });
      expect(await Bun.file(a).exists()).toBe(true);
      expect(await Bun.file(b).exists()).toBe(true);
      expect(await Bun.file(`${root}/.portage`).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("nothing moves without an explicit selection", async () => {
    const root = await drive();
    try {
      await put(root, "Anime/x.mkv", 4096);
      await put(root, "Anime/y.mkv", 4096);
      const report = await scanDuplicates({ roots: [root] });
      const result = await applySelection(report, [], { destRoot: root });
      expect(result.moved).toHaveLength(0);
      expect(await Bun.file(`${root}/Anime/y.mkv`).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("§6 rules 3, 5 and 6 — the apply path", () => {
  test("a selected file moves to the dated trash directory, keeping its path", async () => {
    const root = await drive();
    try {
      await put(root, "Anime/Frieren S01/ep01.mkv", 4096);
      await put(root, "Anime/Frieren S01/ep01 (copy).mkv", 4096);
      const report = await scanDuplicates({ roots: [root] });
      const target = report.groups[0]!.members.find((m) => !m.keep)!;

      const result = await applySelection(report, [target.path], {
        destRoot: root,
        now: Date.UTC(2026, 9, 3),
      });
      expect(result.refused).toHaveLength(0);
      expect(result.moved).toHaveLength(1);
      // `<destRoot>/.portage/trash/2026-10-03/<original relative path>`
      expect(result.moved[0]!.to).toBe(
        join(root, ".portage/trash/2026-10-03", target.relative),
      );
      // The keeper is untouched.
      expect(await Bun.file(target.path).exists()).toBe(false);
      expect(
        await Bun.file(
          report.groups[0]!.members.find((m) => m.keep)!.path,
        ).exists(),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the last copy of a file is never moved (rule 5)", async () => {
    const root = await drive();
    try {
      await put(root, "Anime/x.mkv", 4096);
      await put(root, "Anime/y.mkv", 4096);
      const report = await scanDuplicates({ roots: [root] });
      const all = report.groups[0]!.members.map((m) => m.path);
      const result = await applySelection(report, all, { destRoot: root });
      expect(result.moved).toHaveLength(0);
      expect(
        result.refused.some((r) => r.reason === "would remove the last copy"),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a path that is not in the report is refused", async () => {
    const root = await drive();
    try {
      await put(root, "Anime/x.mkv", 4096);
      await put(root, "Anime/y.mkv", 4096);
      const report = await scanDuplicates({ roots: [root] });
      const result = await applySelection(
        report,
        [`${root}/Anime/not-in-report.mkv`],
        { destRoot: root },
      );
      expect(result.moved).toHaveLength(0);
      expect(result.refused[0]!.reason).toBe("not part of the reviewed report");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolveInside refuses escapes, absolute paths and NUL bytes", () => {
    const root = "/media/node/2TB";
    expect(resolveInside(root, "Anime/a.mkv")).toBe(join(root, "Anime/a.mkv"));
    expect(resolveInside(root, "../escape.mkv")).toBeNull();
    expect(resolveInside(root, "Anime/../../etc/passwd")).toBeNull();
    expect(resolveInside(root, "/etc/passwd")).toBeNull();
    expect(resolveInside(root, "Anime/a\u0000b.mkv")).toBeNull();
  });
});

describe("§6 rule 4 — a keep boundary is never crossed", () => {
  test("keep.txt and *.important are never even candidates", async () => {
    const root = await drive();
    try {
      await put(root, "Anime/important.mkv.important", 4096);
      await put(root, "Anime/keep.txt", 100);
      await put(root, "Anime/normal.mkv", 4096);
      await put(root, "Anime/normal2.mkv", 4096);
      const report = await scanDuplicates({ roots: [root] });
      const seen = report.groups.flatMap((g) => g.members.map((m) => m.path));
      expect(seen.some((p) => p.includes("important"))).toBe(false);
      expect(seen.some((p) => p.endsWith("keep.txt"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("--json parity", () => {
  test("the report carries every number the screen shows", async () => {
    const root = await drive();
    try {
      await put(root, "Anime/x.mkv", 4096);
      await put(root, "Anime/y.mkv", 4096);
      const report = await scanDuplicates({ roots: [root] });
      expect(report.scannedFiles).toBe(2);
      expect(report.scannedBytes).toBe(8192);
      expect(report.tier1Count).toBe(1);
      expect(report.reclaimableBytes).toBe(4096);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
