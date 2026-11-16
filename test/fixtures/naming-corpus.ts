/**
 * Real filenames from the archive this engine was built for.
 *
 * Captured from `/media/node/2TB` on 2026-11-16 — 7 567 video files — while the
 * old parser resolved only 785 of them (10 %). Every name here is one the old
 * implementation could not place, except where the note says otherwise.
 *
 * This is a fixture, not a wish list: the point of keeping the actual strings is
 * that a future simplification of the cascade has to keep reading the shapes a
 * real archive really contains, including the ugly ones a person would never
 * invent in a test (`[ΛV] Ep-04 S2`, `⌯ Sub`, `@Anime_Ryxu`, `01.Kiss X Sis`).
 *
 * `folder` is the containing folder, because on this archive the folder is
 * frequently the only place the show and the season are stated.
 */
export interface CorpusCase {
  name: string;
  folder: string | null;
  /** Expected identity, or `null` for a name that must stay unreadable. */
  expect: { show: string; season: number | null; episode: number } | null;
  /** Why an unreadable name is unreadable. */
  note?: string;
}

export const NAMING_CORPUS: CorpusCase[] = [
  // Telegram anime libraries: `[S01-E01]`, a hyphen between season and episode.
  { name: "[S01-E01] Another [720p] [Dual] [@SoulSociety].mkv", folder: "Another",
    expect: { show: "Another", season: 1, episode: 1 } },
  { name: "Erased [S01-E02] [720p] [Dual] [@SoulSocietyHQ].mkv", folder: "Erased",
    expect: { show: "Erased", season: 1, episode: 2 } },
  { name: "Erased [S01-E12] [720p] [Dual] [@SoulSocietyHQ].mkv", folder: "Erased",
    expect: { show: "Erased", season: 1, episode: 12 } },

  // `S2 E01` and `[S02 E03]`: a space between season and episode.
  { name: "S2 E01 - Black Clover [1080p ⌯ Sub] @Anime_Ryxu.mkv", folder: "Black Clover S2",
    expect: { show: "Black Clover", season: 2, episode: 1 } },
  { name: "[S02 E03] Black Clover [1080p ⌯ Sub] .mkv", folder: "Black Clover S2",
    expect: { show: "Black Clover", season: 2, episode: 3 } },
  { name: "[S01 E44] Bleach [1080p ⌯ Sub] .mkv", folder: "Bleach",
    expect: { show: "Bleach", season: 1, episode: 44 } },

  // `Ep-04`: an episode prefix with the season AFTER it.
  { name: "[ΛV] Ep-04 S2 Black Clover [Sub] [1080p].mkv", folder: "Black Clover S2",
    expect: { show: "Black Clover", season: 2, episode: 4 } },
  { name: "[S-1] [Ep-01] Good Luck Girl [Anime Clan].mkv", folder: "Good Luck Girl",
    expect: { show: "Good Luck Girl", season: 1, episode: 1 } },
  { name: "[S-1] [Ep-06] Good Luck Girl [Anime Clan].mkv", folder: "Good Luck Girl",
    expect: { show: "Good Luck Girl", season: 1, episode: 6 } },

  // An abbreviation every uploader of this show uses.
  { name: "COTE S04 E01 [1080p ⌯ Sub] @KellySxnpai_Tv.mkv", folder: "COTE S04",
    expect: { show: "COTE", season: 4, episode: 1 } },

  // A leading number with a dot, which is the Telegram convention.
  { name: "01.Kiss X Sis - @Anime_Wars.mkv", folder: "Kiss x Sis",
    expect: { show: "Kiss X Sis", season: null, episode: 1 } },
  { name: "06.Kiss X Sis - @Anime_Wars.mkv", folder: "Kiss x Sis",
    expect: { show: "Kiss X Sis", season: null, episode: 6 } },

  // `EP 03` prefix, season only at the end of the name.
  { name: "EP 03 - Danmachi S3.mkv", folder: "DanMachi S3",
    expect: { show: "Danmachi", season: 3, episode: 3 } },
  { name: "EP 12 - Danmachi S3.mkv", folder: "DanMachi S3",
    expect: { show: "Danmachi", season: 3, episode: 12 } },

  // `EP.1` plus a version and a timestamp, in a folder that IS the show.
  { name: "EP.1.v0.1701361513.1080p.mp4", folder: "DanMachi S3",
    expect: { show: "DanMachi", season: 3, episode: 1 } },
  { name: "EP.1.v0.1705318507.1080p.mp4", folder: "DanMachi S3",
    expect: { show: "DanMachi", season: 3, episode: 1 } },

  // The doc's own example: a dash and an absolute number, no season anywhere.
  { name: "Frieren - 07 [1080p][SubsPlease].mkv", folder: "Frieren",
    expect: { show: "Frieren", season: null, episode: 7 } },
  { name: "[SubsPlease] Frieren - 28 (1080p) [ABCD1234].mkv", folder: "Frieren",
    expect: { show: "Frieren", season: null, episode: 28 } },

  // Scene naming, which the old parser handled — kept so a rewrite cannot
  // regress the one shape that used to work.
  { name: "Show.Name.S01E07.1080p.WEB-DL.DDP5.1.x265-GROUP.mkv", folder: null,
    expect: { show: "Show Name", season: 1, episode: 7 } },
  { name: "Shameless.US.S01E01.1080p.WEB-DL.mkv", folder: null,
    expect: { show: "Shameless US", season: 1, episode: 1 } },
  { name: "The.Wheel.of.Time.S01E03.2160p.AMZN.WEB-DL.mkv", folder: null,
    expect: { show: "The Wheel of Time", season: 1, episode: 3 } },
  { name: "3.Body.Problem.S01E05.1080p.NF.WEB-DL.mkv", folder: null,
    expect: { show: "3 Body Problem", season: 1, episode: 5 } },
  { name: "9-1-1.S01E01.720p.HDTV.mkv", folder: null,
    expect: { show: "9-1-1", season: 1, episode: 1 } },

  // A title repeated after the marker.
  { name: "S01E07 - Chainsmoker Cat.mkv", folder: "Chainsmoker Cat",
    expect: { show: "Chainsmoker Cat", season: 1, episode: 7 } },

  // `1x07` with an episode title after it.
  { name: "Show Name - 1x07 - Episode Title.mkv", folder: null,
    expect: { show: "Show Name", season: 1, episode: 7 } },

  // The folder supplies the title when the filename is all tags.
  { name: "[Group] To Your Eternity - 04 [1080p].mkv", folder: "To Your Eternity",
    expect: { show: "To Your Eternity", season: null, episode: 4 } },

  // --- names that must stay unreadable -------------------------------------
  { name: "[OVA-1] Another [1080p] [Dual] [@SoulSociety].mkv", folder: "Another",
    expect: null, note: "an OVA marker is not an episode number" },
  { name: "Frieren 01-12 [1080p].mkv", folder: "Frieren",
    expect: null, note: "a range is a batch, not one episode" },
  { name: "Frieren 1080p.mkv", folder: "Frieren",
    expect: null, note: "a resolution is not an episode" },
  { name: "3 Body Problem.mkv", folder: null,
    expect: null, note: "a year-like title is not an episode" },
  { name: "Some Film (2019) 1080p.mkv", folder: "Films",
    expect: null, note: "no episode marker at all" }
];
