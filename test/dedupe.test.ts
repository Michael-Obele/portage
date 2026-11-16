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

  test("a smaller RESOLUTION is a different release, not a fragment", async () => {
    // The bug this pins: a healthy 720p copy sat beside 1080p siblings and was
    // reported as truncated, because size alone was treated as evidence. On a
    // real drive that produced six false flags.
    const root = await drive();
    try {
      await put(root, "Anime/Show S1/Show S1 - E01 [1080p].mkv", 900_000);
      await put(root, "Anime/Show S1/Show S1 - E02 [1080p].mkv", 900_000);
      await put(root, "Anime/Show S1/Show S1 - E03 [720p].mkv", 300_000);
      const report = await scanDuplicates({ roots: [root] });
      expect(report.truncated).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the documented 89-vs-300 case is flagged (a 3.4x gap, not a 10x one)", async () => {
    // The field evidence in §6 rule 11, at its real ratio. A 10x gap passes any
    // naive rule; this one is what makes the leave-one-out median necessary.
    const root = await drive();
    try {
      await put(root, "Anime/Show.S01E13.1080p.WEB-DL.mkv", 89_000);
      await put(root, "Anime/Show.S01E17.1080p.WEB-DL.mkv", 300_000);
      const report = await scanDuplicates({ roots: [root] });
      expect(report.truncated).toContain("Anime/Show.S01E13.1080p.WEB-DL.mkv");
      expect(report.truncated).not.toContain("Anime/Show.S01E17.1080p.WEB-DL.mkv");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a resolution stated by the FOLDER still separates the classes", async () => {
    // `Show [720p]/Show - 01.mkv` is a normal anime-library shape; the files
    // name no resolution at all, so reading only the basename put them in one
    // bucket and flagged the 720p copy.
    const root = await drive();
    try {
      await put(root, "Anime/Show [1080p]/Show - 01.mkv", 300_000);
      await put(root, "Anime/Show [1080p]/Show - 02.mkv", 300_000);
      await put(root, "Anime/Show [720p]/Show - 01.mkv", 100_000);
      const report = await scanDuplicates({ roots: [root] });
      expect(report.truncated).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a fragment is never the keeper, even when its score wins", async () => {
    // The invariant, and the reason it cannot live only in the cross-scan
    // sweep: the 1080p file is the ONLY member of its resolution class, so
    // nothing ever compared it. It is a partial download at a third of the
    // 720p copy, and 1080p outranks 720p — so without this rule the complete
    // copy is the one offered for the trash.
    const root = await drive();
    try {
      const fragment = await put(root, "Anime/Show.S01E05.1080p.WEB-DL.mkv", 90_000);
      const complete = await put(root, "Anime/Show.S01E05.720p.WEB-DL.mkv", 300_000);
      const report = await scanDuplicates({ roots: [root], tier: 2 });
      const group = report.groups[0];
      expect(group).toBeDefined();
      const keeper = group?.members.find((m) => m.keep);
      expect(keeper?.path).toBe(complete);
      expect(group?.members.find((m) => m.path === fragment)?.keep).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("re-electing after a flag never promotes a sub-floor member", async () => {
    // The 1080p copy is flagged by the sweep (a 300 MB sibling in its class), so
    // the group re-elects. Its only remaining member is a 25 MB 720p copy at 28 %
    // of the group's largest — the old re-election took the next clean member in
    // array order and made THAT the keeper.
    const root = await drive();
    try {
      await put(root, "Show [1080p]/Show.S01E01.1080p.WEB-DL.mkv", 89_000);
      await put(root, "Show [1080p]/Show.S01E02.1080p.WEB-DL.mkv", 300_000);
      const tiny = await put(root, "Show [720p]/Show.S01E01.720p.WEB-DL.mkv", 25_000);
      const report = await scanDuplicates({ roots: [root], tier: 2 });
      expect(report.truncated).toContain("Show [1080p]/Show.S01E01.1080p.WEB-DL.mkv");
      for (const group of report.groups) {
        const keeper = group.members.find((m) => m.keep);
        expect(keeper?.path).not.toBe(tiny);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--no-auto proposes no keeper for a tier-2 group either", async () => {
    const root = await drive();
    try {
      await put(root, "Anime/Show.S01E05.1080p.WEB-DL.mkv", 300_000);
      await put(root, "Anime/Show.S01E05.1080p.BluRay.mkv", 320_000);
      const report = await scanDuplicates({ roots: [root], tier: 2, suggest: false });
      expect(report.groups).toHaveLength(1);
      expect(report.groups[0]?.members.filter((m) => m.keep)).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("two fragments cannot outvote one complete copy", async () => {
    const root = await drive();
    try {
      await put(root, "Anime/Show.S01E05.1080p.WEB-DL.a.mkv", 90_000);
      await put(root, "Anime/Show.S01E05.1080p.WEB-DL.b.mkv", 95_000);
      const complete = await put(root, "Anime/Show.S01E05.1080p.HDTV.mkv", 300_000);
      const report = await scanDuplicates({ roots: [root], tier: 2 });
      const keeper = report.groups[0]?.members.find((m) => m.keep);
      expect(keeper?.path).toBe(complete);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a legitimately small encode in a wide spread is not flagged", async () => {
    // The real case: one 1080p [Dual] season ran 144 MB — 378 MB. That is a
    // 2.6x spread of ordinary encodes, not damage, and the smallest file missed
    // a 50 % test by 53 KB. A fragment is a THIRD of a typical sibling or less.
    const root = await drive();
    try {
      // The same RATIOS at a thousandth of the bytes: only the ratios matter,
      // and writing 3.5 GB to exercise a comparison would be absurd.
      const sizes = [144, 192, 213, 249, 251, 276, 289, 294, 295, 301, 302, 341, 378];
      for (let i = 0; i < sizes.length; i += 1) {
        const episode = String(13 + i).padStart(2, "0");
        await put(
          root,
          `Anime/Fire Force S03/Fire Force S03 - E${episode} [Dual] 1080p.mkv`,
          (sizes[i] as number) * 1_000,
        );
      }
      const report = await scanDuplicates({ roots: [root] });
      expect(report.truncated).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a non-media file is never called a fragment of its media sibling", async () => {
    // A thumbnail beside its audio track shares a stem and is far smaller; it is
    // not an episode, so the truncation sweep must not look at it at all.
    const root = await drive();
    try {
      await put(root, "Audio/Talk [ABC].opus", 900_000);
      await put(root, "Audio/Talk [ABC].png", 30_000);
      const report = await scanDuplicates({ roots: [root] });
      expect(report.truncated).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a fragment WITHIN one resolution is still flagged", async () => {
    const root = await drive();
    try {
      await put(root, "Anime/Show S1/Show S1 - E01 [1080p].mkv", 900_000);
      await put(root, "Anime/Show S1/Show S1 - E02 [1080p].mkv", 90_000);
      const report = await scanDuplicates({ roots: [root] });
      expect(report.truncated).toContain("Anime/Show S1/Show S1 - E02 [1080p].mkv");
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
      expect(labels).toContain('S01E07 "Frieren"');
      // Two different episodes never meet, whatever their titles say.
      expect(labels.some((label) => (label ?? "").includes("S01E08"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an abbreviated title groups only with itself, never with a spelled-out name", async () => {
    const root = await drive();
    try {
      // `hrs` is Higehiro, and no parser can know that. What the cascade can do
      // is refuse to MERGE the two spellings — which is the only outcome that
      // could delete the wrong file. Grouping `hrs` with `hrs` is safe, and
      // leaving it out was throwing away real duplicates.
      await put(
        root,
        "Anime/hrs.s01e01.br720p.x264.400mb-pahe.in.mkv",
        400_000,
      );
      await put(root, "Anime/hrs.s01e01.1080p.x264.900mb.mkv", 900_000);
      await put(root, "Anime/Higehiro.S01E01.1080p.WEB-DL.mkv", 900_000);
      const report = await scanDuplicates({ roots: [root], tier: 2 });
      expect(report.groups).toHaveLength(1);
      const members = report.groups[0]?.members.map((m) => m.relative) ?? [];
      expect(members).toHaveLength(2);
      expect(members.every((path) => path.includes("hrs.s01e01"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the doc's own '- 07' filenames are read, not declared unparsed", async () => {
    const root = await drive();
    try {
      // docs/dedupe.md §4 quotes these filenames as the reason tier 2 must be
      // honest about what it cannot read. They are readable: a dash plus a
      // number is a well-formed absolute marker, and the old parser's failure
      // to see it (`parse-torrent-title` needs `S..E..` or `Ep..`) was the
      // limitation, not the truth.
      await put(root, "Anime/Frieren - 07 [1080p][SubsPlease].mkv", 400_000);
      await put(
        root,
        "Anime/Frieren - 07 [720p][TV][HorribleSubs].mkv",
        300_000,
      );
      await put(root, "Anime/Frieren - 08 [1080p][SubsPlease].mkv", 400_000);
      const report = await scanDuplicates({ roots: [root], tier: 2 });
      expect(report.groups).toHaveLength(1);
      expect(report.groups[0]?.members).toHaveLength(2);
      expect(report.unparsed).toHaveLength(0);
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

  test("a scan rooted at a FOLDER INSIDE the drive still moves the real file", async () => {
    // The regression: `relative` is relative to the scan root, so a report
    // rooted at `<drive>/sub` used to compute `<drive>/<relative>` as the
    // source and fail with ENOENT, one path segment short.
    const root = await drive();
    try {
      await put(root, "sub/a/photo.jpg", 4096, 0x41);
      await put(root, "sub/b/photo-copy.jpg", 4096, 0x41);
      const report = await scanDuplicates({ roots: [join(root, "sub")] });
      const target = report.groups[0]!.members.find((m) => !m.keep)!;

      const result = await applySelection(report, [target.path], {
        destRoot: root,
        now: Date.UTC(2026, 9, 3),
      });
      expect(result.refused).toHaveLength(0);
      expect(result.moved).toHaveLength(1);
      expect(result.moved[0]!.from).toBe(target.path);
      // Trash mirrors the path INSIDE the drive, so the `sub/` segment survives.
      expect(result.moved[0]!.to).toBe(
        join(root, ".portage/trash/2026-10-03", "sub", target.relative),
      );
      expect(await Bun.file(target.path).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a report member outside the drive is refused, not renamed", async () => {
    // §6 rule 6. Scanning an extra archive root outside dest_root reports it,
    // but applying must refuse it by name rather than fail with ENOENT.
    const root = await drive();
    const outside = await mkdtemp(join(tmpdir(), "portage-outside-"));
    try {
      await put(outside, "a/photo.jpg", 4096, 0x42);
      await put(outside, "b/photo-copy.jpg", 4096, 0x42);
      const report = await scanDuplicates({ roots: [outside] });
      const target = report.groups[0]!.members.find((m) => !m.keep)!;

      const result = await applySelection(report, [target.path], {
        destRoot: root,
      });
      expect(result.moved).toHaveLength(0);
      expect(result.refused[0]!.reason).toBe("outside dest_root");
      expect(await Bun.file(target.path).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
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
