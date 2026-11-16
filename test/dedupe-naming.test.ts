/**
 * Reading real filenames.
 *
 * Every case below is a filename that exists on the archive this engine was
 * built for (`/media/node/2TB`), not an invented one. The old parser placed
 * 785 of that archive's 7 567 video files — 10 % — and these are the shapes it
 * could not read. They are here so a future "simplification" of the cascade
 * fails a test instead of quietly losing the archive again.
 *
 * The last two blocks are the ones that matter for safety: a number that
 * differs must never match, and an explicit audio/language variant must never
 * be merged.
 */
import { describe, expect, test } from "bun:test";

import {
  cleanTitle,
  episodeKey,
  fingerprint,
  isMediaFile,
  parseMediaName,
  similarity,
  titlesMatch,
  variantsCompatible,
} from "../src/dedupe/naming.ts";
import { NAMING_CORPUS } from "./fixtures/naming-corpus.ts";
import { sameShow } from "../src/dedupe/tier2.ts";

/** Parse and assert success, so a null key fails with the filename in view. */
function parsed(name: string, folder: string | null = null) {
  const { key, reason } = parseMediaName(name, folder);
  if (!key) throw new Error(`${name} did not parse: ${reason}`);
  return key;
}

describe("episode notations found on the archive", () => {
  test("S01-E02 — a hyphen between season and episode", () => {
    const key = parsed("Erased [S01-E02] [720p] [Dual] [@SoulSocietyHQ].mkv", "Erased");
    expect(key.season).toBe(1);
    expect(key.episode).toBe(2);
    expect(key.show).toBe("Erased");
    expect(key.variant).toBe("dual");
    expect(key.resolution).toBe("720p");
    expect(key.confidence).toBe("explicit");
  });

  test("S2 E01 — a space between season and episode", () => {
    const key = parsed(
      "S2 E01 - Black Clover [1080p ⌯ Sub] @Anime_Ryxu.mkv",
      "Black Clover S2",
    );
    expect(key.season).toBe(2);
    expect(key.episode).toBe(1);
    expect(key.show).toBe("Black Clover");
    expect(key.variant).toBe("sub");
  });

  test("[S02 E03] — the marker inside brackets still counts", () => {
    const key = parsed("[S02 E03] Black Clover [1080p ⌯ Sub] .mkv", "Black Clover S2");
    expect(key.season).toBe(2);
    expect(key.episode).toBe(3);
    expect(key.show).toBe("Black Clover");
  });

  test("Ep-04 — an episode prefix, with the season after it", () => {
    const key = parsed("[ΛV] Ep-04 S2 Black Clover [Sub] [1080p].mkv", "Black Clover S2");
    expect(key.episode).toBe(4);
    expect(key.season).toBe(2);
    expect(key.show).toBe("Black Clover");
  });

  test("[S-1] [Ep-01] — season and episode in separate brackets", () => {
    const key = parsed("[S-1] [Ep-01] Good Luck Girl [Anime Clan].mkv", "Good Luck Girl");
    expect(key.season).toBe(1);
    expect(key.episode).toBe(1);
    expect(key.show).toBe("Good Luck Girl");
  });

  test("COTE S04 E01 — an abbreviated show name is still groupable", () => {
    const key = parsed("COTE S04 E01 [1080p ⌯ Sub] @KellySxnpai_Tv.mkv", "COTE S04");
    expect(key.season).toBe(4);
    expect(key.episode).toBe(1);
    expect(key.show).toBe("COTE");
  });

  test("01.Kiss X Sis — a leading number with a dot", () => {
    const key = parsed("01.Kiss X Sis - @Anime_Wars.mkv", "Kiss x Sis");
    expect(key.episode).toBe(1);
    expect(key.season).toBeNull();
    expect(key.show).toBe("Kiss X Sis");
  });

  test("EP 03 - Danmachi S3 — prefix marker, trailing season", () => {
    const key = parsed("EP 03 - Danmachi S3.mkv", "DanMachi S3");
    expect(key.episode).toBe(3);
    expect(key.season).toBe(3);
    expect(key.show).toBe("Danmachi");
  });

  test("EP.1.v0.1701361513 — a dot-separated prefix and a version", () => {
    const key = parsed("EP.1.v0.1701361513.1080p.mp4", "DanMachi S3");
    expect(key.episode).toBe(1);
    // The folder is the show; the stem has nothing usable left in it.
    expect(key.show).toBe("DanMachi");
    expect(key.season).toBe(3);
  });

  test("Title - 07 — a dash-delimited absolute number", () => {
    const key = parsed("Frieren - 07 [1080p][SubsPlease].mkv", "Frieren");
    expect(key.episode).toBe(7);
    expect(key.season).toBeNull();
    expect(key.show).toBe("Frieren");
  });

  test("Title - 28 (1080p) — dash before a bracket", () => {
    const key = parsed("[SubsPlease] Frieren - 28 (1080p) [ABCD1234].mkv", "Frieren");
    expect(key.episode).toBe(28);
    expect(key.show).toBe("Frieren");
  });

  test("scene naming — dots, source, audio and group", () => {
    const key = parsed("Show.Name.S01E07.1080p.WEB-DL.DDP5.1.x265-GROUP.mkv");
    expect(key.season).toBe(1);
    expect(key.episode).toBe(7);
    // `DDP5.1` must not leave a stray `1` in the title.
    expect(key.show).toBe("Show Name");
    expect(key.source).toBe("web-dl");
  });

  test("a repeated title after the marker is folded once", () => {
    const key = parsed("S01E07 - Chainsmoker Cat.mkv", "Chainsmoker Cat");
    expect(key.show).toBe("Chainsmoker Cat");
    expect(key.season).toBe(1);
    expect(key.episode).toBe(7);
  });

  test("1x07 — the cross notation", () => {
    const key = parsed("Show Name - 1x07 - Episode Title.mkv");
    expect(key.season).toBe(1);
    expect(key.episode).toBe(7);
    expect(key.show).toBe("Show Name");
  });

  test("a title that is itself a number survives", () => {
    const key = parsed("9-1-1 S01E01.mkv");
    expect(key.show).toBe("9-1-1");
    expect(key.episode).toBe(1);
  });
});

describe("the season comes from the folder when the name omits it", () => {
  test("a bare absolute number takes the folder's season", () => {
    const key = parsed("Frieren - 12.mkv", "Frieren S02");
    expect(key.season).toBe(2);
    expect(key.episode).toBe(12);
  });

  test("with no folder and no season the number stays ABSOLUTE", () => {
    const key = parsed("Frieren - 12.mkv");
    expect(key.season).toBeNull();
    expect(episodeKey(key.season, key.episode)).toBe("ABSE0012");
  });

  test("absolute and season numbering never share a key", () => {
    const absolute = parsed("Frieren - 44.mkv");
    const seasonal = parsed("Frieren S01E44.mkv");
    expect(episodeKey(absolute.season, absolute.episode)).not.toBe(
      episodeKey(seasonal.season, seasonal.episode),
    );
  });
});

describe("refusals are specific, never guesses", () => {
  test("a batch range is not one episode", () => {
    const { key, reason } = parseMediaName("Frieren 01-12 [1080p].mkv");
    expect(key).toBeNull();
    expect(reason).toContain("range of episodes");
  });

  test("a file with no episode number says so", () => {
    const { key, reason } = parseMediaName("Some Film (2019) 1080p.mkv");
    expect(key).toBeNull();
    expect(reason).toContain("no episode number");
  });

  test("a name that is all tags does not invent a title", () => {
    const { key, reason } = parseMediaName("[Group] EP.1 1080p.mkv", "Anime Singles");
    expect(key).toBeNull();
    expect(reason).toContain("no show name");
  });

  test("a resolution is never read as an episode", () => {
    expect(parseMediaName("Show 1080p.mkv").key).toBeNull();
    expect(parseMediaName("Show 720.mkv").key).toBeNull();
  });

  test("a year in a title is not an episode", () => {
    expect(parseMediaName("3 Body Problem.mkv").key).toBeNull();
  });

  test("the folder is never used as a title when it is a shelf", () => {
    const { key } = parseMediaName("[Group] EP.1 1080p.mkv", "Anime Singles");
    expect(key).toBeNull();
  });
});

describe("titles matching — loose, but never across a number", () => {
  test("identical titles match", () => {
    expect(titlesMatch("Frieren", "Frieren")).toBe(true);
  });

  test("case, punctuation and articles are ignored", () => {
    expect(titlesMatch("The Wheel of Time", "wheel of time")).toBe(true);
    expect(titlesMatch("Kiss X Sis", "kiss x sis")).toBe(true);
  });

  test("a generic suffix may differ", () => {
    expect(titlesMatch("Show", "Show Complete Series")).toBe(true);
  });

  test("a spin-off subtitle does NOT match", () => {
    expect(titlesMatch("Frieren", "Frieren Beyond Journey's End")).toBe(false);
  });

  test("a region marker is identity, not noise", () => {
    // The Office and The Office US are two different series.
    expect(titlesMatch("The Office", "The Office US")).toBe(false);
  });

  test("a differing number kills the match", () => {
    expect(titlesMatch("Season 2", "Season 3")).toBe(false);
    expect(titlesMatch("9-1-1", "9-1-1 Lone Star")).toBe(false);
  });

  test("a long title tolerates one typo, a short one does not", () => {
    expect(titlesMatch("Generator Rex", "Generator Rexx")).toBe(true);
    expect(titlesMatch("Bleach", "Bleah")).toBe(false);
  });

  test("similarity is symmetric and bounded", () => {
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
    expect(similarity("abc", "abd")).toBeCloseTo(similarity("abd", "abc"), 10);
  });
});

describe("variants are identity", () => {
  test("a dual-audio copy never groups with a subtitled one", () => {
    expect(variantsCompatible("dual", "sub")).toBe(false);
    expect(variantsCompatible("dual", "dub")).toBe(false);
  });

  test("an unstated variant is compatible with anything", () => {
    expect(variantsCompatible(null, "sub")).toBe(true);
    expect(variantsCompatible("sub", null)).toBe(true);
    expect(variantsCompatible(null, null)).toBe(true);
  });
});

describe("the small pieces", () => {
  test("only video containers are asked for an episode", () => {
    expect(isMediaFile("a.mkv")).toBe(true);
    expect(isMediaFile("a.MP4")).toBe(true);
    expect(isMediaFile("artwork.zip")).toBe(false);
    expect(isMediaFile("notes")).toBe(false);
  });

  test("cleanTitle strips release noise but keeps title numbers", () => {
    expect(cleanTitle("Frieren - 07 [1080p][SubsPlease]")).toBe("Frieren");
    expect(cleanTitle("3 Body Problem 1080p")).toBe("3 Body Problem");
    expect(cleanTitle("86 S01E01 1080p")).toBe("86");
  });

  test("fingerprint drops articles and punctuation, keeps digits", () => {
    expect(fingerprint("The  Office (US)")).toBe("office us");
    expect(fingerprint("9-1-1")).toBe("9 1 1");
  });
});

describe("the real archive corpus", () => {  test("every name the old parser could not place is placed now", () => {
    const unreadable = NAMING_CORPUS.filter((entry) => entry.expect === null);
    const readable = NAMING_CORPUS.filter((entry) => entry.expect !== null);
    const failures: string[] = [];
    for (const entry of readable) {
      const { key, reason } = parseMediaName(entry.name, entry.folder);
      if (!key) {
        failures.push(`${entry.name} -> ${reason}`);
        continue;
      }
      const want = entry.expect;
      if (
        want &&
        (key.show !== want.show ||
          key.season !== want.season ||
          key.episode !== want.episode)
      ) {
        failures.push(
          `${entry.name} -> ${key.show} ${key.season}/${key.episode}, wanted ${want.show} ${want.season}/${want.episode}`,
        );
      }
    }
    expect(failures).toEqual([]);
    // The corpus is worth having only if it is mostly names that used to fail.
    expect(readable.length).toBeGreaterThanOrEqual(25);
    expect(unreadable.length).toBeGreaterThan(0);
  });

  test("the unreadable ones stay unreadable, for the stated reason", () => {
    for (const entry of NAMING_CORPUS) {
      if (entry.expect !== null) continue;
      const { key, reason } = parseMediaName(entry.name, entry.folder);
      expect(`${entry.name}: ${key === null ? "unreadable" : "PARSED"}`).toBe(
        `${entry.name}: unreadable`,
      );
      expect(reason).not.toBeNull();
    }
  });
});

/**
 * The four ways a "loose" matcher can merge two different things, each of which
 * a review reproduced against real filenames. Every case here is a group that
 * would have been shown to a person as "same episode, different release" on a
 * screen whose confirm sheet moves one of them to the trash.
 */
describe("loose matching never merges two different things", () => {
  const key = (name: string, folder: string | null = null) => {
    const { key: parsed } = parseMediaName(name, folder);
    if (!parsed) throw new Error(`${name} did not parse`);
    return parsed;
  };

  test("a batch or multi-episode name is refused, not read as episode 1", () => {
    // `S01E01-12` is a season pack; `S01E07E08` is two episodes in one file.
    const pack = parseMediaName("Frieren.S01E01-12.1080p.mkv");
    expect(pack.key).toBeNull();
    expect(pack.reason).toContain("more than one episode");

    const double = parseMediaName("Show.S01E07E08.1080p.mkv");
    expect(double.key).toBeNull();
    expect(double.reason).toContain("more than one episode");
  });

  test("a region variant is a different series", () => {
    expect(
      sameShow(
        key("The.Office.S01E01.mkv", "The Office"),
        key("The.Office.UK.S01E01.mkv", "The Office"),
      ),
    ).toBe(false);
  });

  test("a spin-off in the same folder is a different series", () => {
    expect(
      sameShow(key("Fate.S01E01.mkv", "Fate"), key("Fate.Zero.S01E01.mkv", "Fate")),
    ).toBe(false);
  });

  test("two titles borrowed from a shelf folder are two guesses, not a match", () => {
    // `Kids` is not on any denylist; the guard is structural, not a list.
    expect(
      sameShow(key("[A] EP.1 1080p.mkv", "Kids"), key("[B] EP.1 1080p.mkv", "Kids")),
    ).toBe(false);
  });

  test("a folder season never pairs with a season the name stated", () => {
    // `- 13` in `S2/` might be absolute 13 (= S02E01) or the 13th of season 2.
    expect(
      sameShow(
        key("Black.Clover.-.13.mkv", "Black Clover S2"),
        key("Black.Clover.S02E13.mkv", "Black Clover S2"),
      ),
    ).toBe(false);
  });

  test("two explicit releases of one episode still group", () => {
    // The guards must not be so tight that the feature disappears.
    expect(
      sameShow(
        key("Frieren.S01E07.1080p.WEB-DL.mkv", "Frieren"),
        key("[SubsPlease] Frieren S01E07 (1080p).mkv", "Frieren"),
      ),
    ).toBe(true);
  });
});
