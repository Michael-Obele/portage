/**
 * Filename → episode identity.
 *
 * The old tier 2 handed every name to `parse-torrent-title` and accepted what
 * came back. Measured on the real archive (`/media/node/2TB`, 7 567 video
 * files) that resolved **785 of them — 10 %**. The reasons were structural,
 * not corpus-specific: the parser's season/episode handler is
 * `/S[0-9]{1,2} ?E([0-9]{1,5})/i`, so `S01-E02` (a hyphen) matches nothing, and
 * its title rule truncates at the earliest handler match but ignores a match at
 * index 0, so `EP 03 - Danmachi S3` keeps `EP 03` in the title while a leading
 * `01.` yields no episode at all.
 *
 * This module is a CASCADE instead: several narrow strategies, tried in order of
 * precision, each saying which one matched and how confident it is. A strategy
 * that cannot establish an identity returns a REASON rather than a guess,
 * because docs/dedupe.md §5 is right that a wrong guess here merges two
 * different episodes and can delete one of them.
 *
 * Two rules are structural, not stylistic:
 *
 *  1. **Absolute numbering and season numbering are different namespaces.** An
 *     anime `44` is not `S01E44`. `season` stays `null` when nothing said what
 *     season it is — never `1`. (Sonarr keeps `EpisodeNumbers` and
 *     `AbsoluteEpisodeNumbers` as separate fields for the same reason, and its
 *     "no season found ⇒ season 1" default is documented as a guess that is
 *     wrong for a mid-series file.)
 *  2. **A number that differs kills a group.** Every documented false positive
 *     in this domain is a differing number: `S01E07` vs `S01E08`, absolute 44 vs
 *     `S01E44`, a re-cut season 3 vs 5. `titlesMatch` enforces it structurally
 *     rather than by threshold.
 */

// --- what counts as an episode of something --------------------------------

/**
 * Containers that can hold an episode. Tier 2 only ever considers these.
 *
 * Tier 1 (byte-identical) deliberately still considers every file — a duplicate
 * `.zip` is a duplicate — but asking whether `artwork.zip` has an episode number
 * is a question with no answer, and thousands of those were drowning the report.
 */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "mkv", "mp4", "avi", "m4v", "mov", "webm", "wmv", "flv", "mpg", "mpeg",
  "ogv", "ts", "m2ts", "mts", "vob", "3gp", "divx", "rmvb",
]);

export function isMediaFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return MEDIA_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * A file worth asking for an episode number.
 *
 * `.ts` means MPEG transport stream AND TypeScript. Scanning a folder that
 * happens to hold source code would otherwise report every `.ts` file as a
 * media file with no episode number. A transport stream is never 4 MB.
 */
const TS_STREAM_FLOOR = 4 * 1024 * 1024;

export function isMediaCandidate(name: string, size: number): boolean {
  if (!isMediaFile(name)) return false;
  if (name.toLowerCase().endsWith(".ts") && size < TS_STREAM_FLOOR) return false;
  return true;
}

/** The basename without its extension. */
export function stemOf(name: string): string {
  const slash = name.lastIndexOf("/");
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// --- the result -------------------------------------------------------------

/**
 * How an identity was established.
 *
 * `explicit` — the name itself said both season and episode (`S01E07`, `1x07`,
 * `Season 1 Episode 7`). Unambiguous by construction.
 * `inferred` — the name said the episode (`Ep 03`, `#12`, `- 07`, leading `01.`)
 * and the season came from the name or the folder, or was simply absent
 * (absolute numbering). Still safe to group on, because the episode must also
 * match exactly and the titles must match.
 */
export type Confidence = "explicit" | "inferred";

/** A language/audio flavour that makes two copies legitimately different. */
export type Variant = "dual" | "sub" | "dub" | "multi" | null;

export interface NameKey {
  /** The show name as read, trimmed of release noise. */
  show: string;
  /** `null` means ABSOLUTE — never coerced to 1. */
  season: number | null;
  episode: number;
  resolution: string | null;
  source: string | null;
  variant: Variant;
  confidence: Confidence;
  /** Which strategy matched, for the report and for tests. */
  via: string;
  /**
   * Whether the show name came from the FILENAME (`true`) or was borrowed from
   * the folder (`false`). Two borrowings never group with each other: a folder
   * is a statement about what lives in it, but `Kids/` and `Completed/` are
   * shelves, and two different shows' tag-only files inside one would otherwise
   * become one group.
   */
  titled: boolean;
  /**
   * Where the season came from. A season inferred from the folder must never
   * pair with one the name stated: `Show - 13` in `Show S2/` is absolute 13,
   * and grouping it with `Show.S02E13` is the classic absolute-vs-seasonal
   * mistake the module header forbids.
   */
  seasonSource: "name" | "folder" | "none";
  /** A declaimed region (`[US]`, `[UK]`), read before brackets are stripped. */
  region: string | null;
}

export interface NameOutcome {
  key: NameKey | null;
  /** Why it could not be placed. Shown verbatim to the person. */
  reason: string | null;
}

// --- vocabulary -------------------------------------------------------------

/** Higher wins. From docs/dedupe.md §4. */
const SOURCE_RANK: Record<string, number> = {
  bd: 5,
  "blu-ray": 5,
  bluray: 5,
  remux: 5,
  "web-dl": 4,
  webdl: 4,
  web: 3,
  webrip: 3,
  hdtv: 2,
  tv: 2,
  dvd: 1,
};

const RESOLUTION_RANK: Record<string, number> = {
  "2160p": 4, "4k": 4, uhd: 4,
  "1080p": 3, fhd: 3,
  "720p": 2, hd: 2,
  "480p": 1, "360p": 1, sd: 1,
};

/**
 * Tokens that are never part of a title.
 *
 * Deliberately conservative: dropping a word that IS the title merges two shows,
 * while keeping one that is not merely misses a duplicate. So this holds release
 * vocabulary only — no `us`/`uk` (they disambiguate a show), no numbers.
 */
const NOISE = new Set([
  "1080p", "720p", "2160p", "480p", "360p", "4k", "8k", "uhd", "fhd", "hd", "sd",
  "x264", "x265", "h264", "h265", "hevc", "avc", "av1", "10bit", "8bit", "hi10p",
  "aac", "aac2", "flac", "ddp", "dd", "dts", "atmos", "truehd", "opus", "mp3",
  "web", "webdl", "webrip", "web-dl", "bluray", "bdrip", "bd", "brrip", "hdtv",
  "dvdrip", "dvd", "remux", "cam", "hdcam", "ts", "raw", "tv",
  "sub", "subs", "subbed", "dub", "dubbed", "dual", "multi", "multi-audio",
  "complete", "batch", "proper", "repack", "rerip", "uncensored", "uncut",
  "amzn", "nf", "hulu", "dsnp", "atvp", "cr",
]);

/** Words that carry no identity when matching, per Sonarr's `NormalizeRegex`. */
const STOPWORDS = new Set(["a", "an", "the", "and", "or", "of"]);

/**
 * Extra words that may safely differ between two releases of one title.
 * A subset match is allowed only when everything the longer title adds is here,
 * so `Frieren` vs `Frieren Beyond Journey's End` stays a miss (right: that is a
 * different subtitle, and possibly a different cut) while
 * `Show` vs `Show Complete Series` matches.
 */
const GENERIC_EXTRA = new Set([
  "complete", "series", "collection", "edition", "extended",
  "uncensored", "uncut", "remastered", "full", "all", "seasons",
]);

/** Country/version markers a title must NOT gain or lose. */
const REGION = new Set(["us", "uk", "au", "ca", "nz", "ie", "za"]);

/**
 * The region a filename declares, read from the RAW name so a BRACKETED tag is
 * seen before `cleanTitle` deletes it.
 *
 * `The.Office.[US]` and `The.Office.[UK]` are two different series; once the
 * brackets are stripped both titles read "The Office" and nothing downstream
 * can tell them apart. So the tag is read here and carried as identity.
 */
export function regionFrom(text: string): string | null {
  const bracketed = text.match(/[[(]\s*(us|uk|au|ca|nz|ie|za)\s*[\])]/i);
  if (bracketed) return (bracketed[1] as string).toLowerCase();
  const bare = text.match(/(?:^|[\s._-])(us|uk|au|ca|nz|ie|za)(?=[\s._-]|$)/i);
  return bare ? (bare[1] as string).toLowerCase() : null;
}

/**
 * Folder names that describe a CONTAINER, not a show. A folder called
 * `Anime Singles` is a shelf, so it must never be used as a title — two
 * different shows in it would otherwise become one group.
 */
const GENERIC_FOLDER = new Set([
  "anime", "singles", "videos", "video", "downloads", "download", "movies",
  "movie", "tv", "series", "shows", "misc", "other", "media", "collections",
  "new", "old", "unsorted", "sorted", "watch", "to watch",
]);

// --- normalisation ----------------------------------------------------------

/**
 * The matching form of a title.
 *
 * Lowercase, accents folded, punctuation gone, articles dropped, digits kept.
 * Digits are kept because `86` and `8-6` must not collide, and because a title's
 * own number is identity (`9-1-1`, `3 Body Problem`).
 */
export function fingerprint(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['\u2019`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "" && !STOPWORDS.has(word))
    .join(" ");
}

function tokensOf(fp: string): string[] {
  return fp === "" ? [] : fp.split(" ");
}

/** Levenshtein distance, two rows. Titles are short; this is not a hot path. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length] as number;
}

/** Normalised similarity, 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/**
 * Whether two parsed titles are the same show.
 *
 * Order matters: the cheap certainties first, then the near misses, then the
 * guards that make "loose" safe.
 */
export function titlesMatch(a: string, b: string): boolean {
  const fa = fingerprint(a);
  const fb = fingerprint(b);
  if (fa === "" || fb === "") return false;
  if (fa === fb) return true;

  const ta = tokensOf(fa);
  const tb = tokensOf(fb);
  const setA = new Set(ta);
  const setB = new Set(tb);

  // A number that differs kills the match. `9-1-1` vs `9-1-1 Lone Star` and
  // `86` vs `86 Eighty Six` both survive; `Season 2` vs `Season 3` does not.
  const numbersA = ta.filter((t) => /^\d+$/.test(t)).sort().join(",");
  const numbersB = tb.filter((t) => /^\d+$/.test(t)).sort().join(",");
  if (numbersA !== numbersB) return false;

  const sameSet = ta.length === tb.length && ta.every((t) => setB.has(t));
  if (sameSet) return true;

  // Subset: one title is the other plus extra words. Allowed only when every
  // extra word is generic filler — never a region marker, never a number (the
  // numeric guard above already ran), never a meaningful word. The SMALLER
  // title must also carry something specific, or `Complete` would match
  // `Series`.
  const [smaller, larger] = ta.length <= tb.length ? [setA, setB] : [setB, setA];
  const extras = [...larger].filter((t) => !smaller.has(t));
  const smallerIsSpecific = [...smaller].some((t) => !GENERIC_EXTRA.has(t));
  if (extras.length > 0 && extras.length <= 3 && smallerIsSpecific) {
    if (extras.every((t) => GENERIC_EXTRA.has(t) && !REGION.has(t))) return true;
  }

  // A loud region marker on one side only is a different show: `The Office` and
  // `The Office US` are not duplicates, they are two series.
  const regionA = ta.filter((t) => REGION.has(t)).join(",");
  const regionB = tb.filter((t) => REGION.has(t)).join(",");
  if (regionA !== regionB) return false;

  // Typo / transliteration tolerance on the whole string.
  return similarity(fa, fb) >= 0.9;
}

// --- the cascade ------------------------------------------------------------

/** Separators that may appear between `S` and `E`, and before `E`. */
const SEASON_EPISODE = /\bS(\d{1,2})\s*[.\-_ ]?\s*E(\d{1,4})(?!\d)/i;
/**
 * `1x07` / `02x01`. Deliberately NO spaces around the `x`: with them allowed,
 * `DDP5 1 x265-GROUP` reads as "season 1, episode 265" and the real marker is
 * then the one that gets stripped from the title.
 */
const SEASON_X_EPISODE = /(?<![\dA-Za-z])(\d{1,2})[x\u00d7](\d{1,4})(?!\d)/i;
const SEASON_WORD_EPISODE =
  /\bseason\s*(\d{1,2})\s*[.\-_ ]\s*(?:episode|ep)\s*[.\-_ ]?(\d{1,4})(?!\d)/i;
const EPISODE_PREFIX =
  /(?<![A-Za-z])(?:episode|episodio|capitulo|cap|folge|bolum)\s*[.\-_ ]?\s*(\d{1,4})(?!\d)/i;
/** `Ep-04` / `EP 03` / `EP.1` — the commonest Telegram-anime prefix. */
const EPISODE_SHORT = /(?<![A-Za-z])ep\s*[.\-_ ]?\s*(\d{1,4})(?!\d)/i;
const HASH_EPISODE = /#\s*(\d{1,4})(?!\d)/;
const BARE_SEASON = /(?<![A-Za-z0-9])S\s*[-_. ]?\s*(\d{1,2})(?!\d)/i;
/** `Title - 07` / `Title - 07v2` / `Title - 07 [1080p]`. The DASH is required. */
const DASH_ABSOLUTE = /\s-\s*(\d{1,4})(?!\d)\s*(?:v\d)?\s*$/i;
const DASH_ABSOLUTE_BEFORE_TAG =
  /\s-\s*(\d{1,4})(?!\d)\s*(?:v\d)?\s*(?=\[|\()/i;
/** `01.Kiss X Sis` — a leading number with a DOT. The dot is the convention. */
const LEADING_NUMBER = /^(\d{2,3})\.\s*(?=\S)/;
/**
 * The same shape, but for REMOVING from a title — and deliberately stricter.
 *
 * `01.Kiss X Sis` is a marker; `3.Body.Problem` is a title that begins with a
 * number. Requiring two digits separates them, because the uploader convention
 * is zero-padded (`01.`, `02.`) while a title's number is bare.
 */
const LEADING_NUMBER_TITLE = /^(\d{2,3})\.\s*(?=\S)/;
/** `01-12`, `1~12`, `3 & 5` — a batch, never one episode. */
const EPISODE_RANGE = /(?<![\dA-Za-z])(\d{1,4})\s*[-~&]\s*(\d{1,4})(?!\d)/;

/** Resolutions are not episodes, even when they are three digits. */
const LOOKS_LIKE_RESOLUTION = new Set([480, 540, 576, 720, 1080, 1440, 2160, 4320]);

const RESOLUTION_TOKEN = /\b(2160p|1440p|1080p|720p|576p|480p|360p|4k|uhd|fhd)\b/i;
const SOURCE_TOKEN =
  /\b(web[- ]?dl|web[- ]?rip|webrip|web|blu[- ]?ray|bdrip|brrip|remux|hdtv|dvdrip|dvd)\b/i;

export function resolutionFrom(text: string): string | null {
  return text.match(RESOLUTION_TOKEN)?.[1]?.toLowerCase() ?? null;
}

function sourceFrom(text: string): string | null {
  const raw = text.match(SOURCE_TOKEN)?.[1]?.toLowerCase();
  if (!raw) return null;
  const normal = raw.replace(/\s+/g, "-").replace("webdl", "web-dl");
  return SOURCE_RANK[normal] ? normal : null;
}

/**
 * Which flavour of copy this is. `[Dual]` and `[Sub]` copies are both worth
 * owning, so they are part of the identity rather than a detail.
 */
function variantFrom(text: string): Variant {
  const lower = text.toLowerCase();
  if (/\bdual\b|\bdual[- ]?audio\b/.test(lower)) return "dual";
  if (/\bmulti\b|\bmulti[- ]?audio\b/.test(lower)) return "multi";
  if (/\bdub(?:bed)?\b/.test(lower)) return "dub";
  if (/\bsub(?:s|bed|title[s]?)?\b|\u232f/.test(lower)) return "sub";
  return null;
}

/**
 * A token that is a technical descriptor rather than a word.
 *
 * `DDP5.1`, `x265-GROUP`, `AAC2.0` all arrive glued together, so they survive a
 * plain word list and then poison the title. A poisoned title is not cosmetic:
 * the fingerprint guard says two titles match only when their NUMBERS match, so
 * one stray `5` from an audio spec silently stops two releases meeting.
 */
function isTechnicalToken(word: string): boolean {
  const lower = word.toLowerCase();
  if (NOISE.has(lower)) return true;
  if (/^(?:x|h)\.?26[45](?:[.\-].*)?$/.test(lower)) return true;
  if (/^(?:ddp?|aac|dts|ac3|eac3|flac|truehd|atmos|opus|mp3)\d*(?:[.\-]\d+)?$/.test(lower)) {
    return true;
  }
  if (/^\d{1,2}bit$/.test(lower)) return true;
  // A file size in the name (`900mb`, `1.2gb`) is a release note, not a word.
  if (/^\d+(?:\.\d+)?[mgk]b$/.test(lower)) return true;
  // A resolution glued to a word: `br720p`, `hd1080`, `BD.1080p`.
  if (/(?:2160p|1440p|1080p|720p|576p|480p|360p|4k)/.test(lower)) return true;
  // A timestamp / id is not a title word.
  if (/^\d{5,}$/.test(lower)) return true;
  if (/^s\d{1,2}$/i.test(word)) return true;
  if (/^v\d+$/i.test(word)) return true;
  return false;
}

/**
 * Strip everything that is not the title.
 *
 * Bracketed groups go entirely — release tags live there in the forms this
 * archive actually contains (`[@SoulSociety]`, `[1080p ⌯ Sub]`, `[ΛV]`), and a
 * bracket number is not an episode. `(2009)` and `(TV)` go too: a year is not
 * the title, and keeping it would stop `Show (2019)` matching `Show`.
 *
 * Marker removal here is generic rather than by remembered span, because the
 * span is found in a normalised copy (`EP.1` vs `EP 1`) and cannot be mapped
 * back reliably.
 */
export function cleanTitle(raw: string): string {
  let text = raw;
  text = text.replace(/https?:\/\/\S+/gi, " ");
  text = text.replace(/@[\w.\-]+/g, " ");
  text = text.replace(/\[[^\]]*\]/g, " ");
  text = text.replace(/\([^)]*\)/g, " ");
  text = text.replace(/[{}]/g, " ");
  // Leading `01.` is a marker, but the DOT is what makes it one; remove it
  // before dots become spaces. Two digits or more, so `3 Body Problem` keeps
  // its number.
  text = text.replace(LEADING_NUMBER_TITLE, " ");
  text = text.replace(/[_.]+/g, " ");
  text = text
    .replace(SEASON_EPISODE, " ")
    .replace(SEASON_X_EPISODE, " ")
    .replace(SEASON_WORD_EPISODE, " ")
    .replace(EPISODE_PREFIX, " ")
    .replace(EPISODE_SHORT, " ")
    .replace(HASH_EPISODE, " ")
    .replace(BARE_SEASON, " ")
    .replace(DASH_ABSOLUTE_BEFORE_TAG, " ")
    .replace(DASH_ABSOLUTE, " ")
    .replace(/[\u232f|]+/g, " ");

    // A spaced dash is NOT a title boundary.
    //
    // Splitting on it once read `Fate - Zero - 07` and `Fate - Stay Night - 07`
    // as two copies of "Fate" — two different shows, one group. The case it
    // was added for (`Show - 1x07 - Episode Title`) is already handled by
    // cutting the title at the marker, which leaves a trailing dash that the
    // token filter drops.

  const words = text
    .split(/\s+/)
    .map((word) => word.replace(/^[-–—]+|[-–—]+$/g, ""))
    .filter((word) => word !== "");

  const kept: string[] = [];
  // A digit run that FOLLOWS a technical token is part of it: `DDP5.1` arrives
  // as `DDP5` + `1`, and a stray `1` in a title is fatal — the fingerprint guard
  // requires two titles' numbers to match, so one orphaned digit quietly stops
  // two releases of the same show ever meeting.
  let afterTechnical = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string;
    const lower = word.toLowerCase();
    if (isTechnicalToken(word)) {
      afterTechnical = true;
      continue;
    }
    if (afterTechnical && /^\d{1,2}$/.test(word)) continue;
    afterTechnical = false;
    // `Season 2` as two words.
    if (lower === "season" && /^\d{1,2}$/.test(words[i + 1] ?? "")) {
      i += 1;
      continue;
    }
    // A bare episode marker left behind by an odd name.
    if (/^(ep|e)$/i.test(word) && /^\d{1,4}$/.test(words[i + 1] ?? "")) {
      i += 1;
      continue;
    }
    if (!/[\p{L}\p{N}]/u.test(word)) continue;
    kept.push(word);
  }

  // `Show - 1x07 - Episode Title` and `Chainsmoker Cat S01E07 - Chainsmoker Cat`
  // are handled above by splitting on the dash.
  // A bare 4-digit year is metadata: `Show.2019.S01E07` and `Show.S01E07` are
  // one show, and the number guard would otherwise refuse the match forever.
  // Only dropped when something else is left to be the title.
  const words2 = kept.filter(
    (word, index, all) => !(all.length > 1 && /^(19|20)\d{2}$/.test(word)),
  );
  return words2.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * A title worth grouping on.
 *
 * The old rule rejected anything that looked like a code, which threw away real
 * shows every uploader abbreviates the same way (`COTE`). An abbreviation is
 * only dangerous when it is INCONSISTENT, and consistency is what grouping
 * checks. So: any title with a letter is acceptable; what is not acceptable is
 * an empty title, or one that is only digits.
 */
export function isPlausibleTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  if (trimmed === "") return false;
  if (trimmed.length < 2) return false;
  // A title does not have to contain a letter. `9-1-1` and the anime `86` are
  // real shows, and rejecting them silently dropped whole series; Sonarr's own
  // title cleanup has the same `TryParse` escape hatch. What is rejected is a
  // bare NUMBER of arbitrary length, which is a timestamp or an id.
  if (
    !/\p{L}/u.test(trimmed) &&
    !/^\d{1,4}(?:-\d{1,4})+$/.test(trimmed) &&
    !/^\d{2,3}$/.test(trimmed)
  ) {
    return false;
  }
  return true;
}

/** A folder name that is a shelf rather than a show. */
function isGenericFolder(title: string): boolean {
  const tokens = fingerprint(title).split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => GENERIC_FOLDER.has(token));
}

/** Season declared by a folder name (`Black Clover S2`, `Season 3`, `S04`). */
function seasonFromFolder(folder: string): number | null {
  const direct = folder.match(/(?<![A-Za-z0-9])S\s*[-_. ]?\s*(\d{1,2})(?!\d)/i);
  if (direct) return Number(direct[1]);
  const word = folder.match(/\bseason\s*(\d{1,2})(?!\d)/i);
  if (word) return Number(word[1]);
  return null;
}

function saneEpisode(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (value < 0) return false;
  // 4 digits is a batch ceiling; beyond that it is a year, a size or a code.
  return value <= 1500;
}

/**
 * Read one filename.
 *
 * @param name   the file's basename, with or without its extension.
 * @param folder the containing folder, used only for the season and as a title
 *               hint. Never invents a season from nothing, and never used when
 *               the folder is a shelf (`Anime Singles`) rather than a show.
 */
export function parseMediaName(name: string, folder: string | null = null): NameOutcome {
  const stem = stemOf(name);
  const folderTitle = folder === null ? null : cleanTitle(folder);
  const usableFolder =
    folderTitle !== null && isPlausibleTitle(folderTitle) && !isGenericFolder(folderTitle)
      ? folderTitle
      : null;
  const folderSeason = folder === null ? null : seasonFromFolder(folder);

  // Markers are looked for in a form where `.` and `_` are separators, because
  // `S01.E02` and `EP.1` are the same notation as `S01 E02` and `EP 1`. The
  // replacement is one character for one character and whitespace is NOT
  // collapsed, so a match index here is also an index into `stem` — which is
  // what lets the title be cut at the marker below.
  const haystack = stem.replace(/[_.]/g, " ");

  const explicit = haystack.match(SEASON_EPISODE);
  const cross = haystack.match(SEASON_X_EPISODE);
  const worded = haystack.match(SEASON_WORD_EPISODE);
  const prefixed = haystack.match(EPISODE_PREFIX) ?? haystack.match(EPISODE_SHORT);
  const hashed = haystack.match(HASH_EPISODE);
  const range = haystack.match(EPISODE_RANGE);

  let episode: number | null = null;
  let season: number | null = null;
  let via = "";
  let confidence: Confidence = "inferred";
  /** Where the episode marker starts in `stem`, or -1 when there is none. */
  let markerAt = -1;
  /** The marker's own text, so what follows it can be inspected. */
  let markerText = "";

  if (explicit) {
    season = Number(explicit[1]);
    episode = Number(explicit[2]);
    via = "S..E..";
    confidence = "explicit";
    markerAt = explicit.index ?? -1;
    markerText = explicit[0];
  } else if (worded) {
    season = Number(worded[1]);
    episode = Number(worded[2]);
    via = "season + episode";
    confidence = "explicit";
    markerAt = worded.index ?? -1;
    markerText = worded[0];
  } else if (cross) {
    // `1920x1080` is a resolution, not season 1920 episode 1080; `1x265` is an
    // audio codec wearing a marker's clothes.
    const candidate = Number(cross[2]);
    const codec = candidate === 264 || candidate === 265 || candidate === 266;
    if (!LOOKS_LIKE_RESOLUTION.has(candidate) && !codec && Number(cross[1]) <= 30) {
      season = Number(cross[1]);
      episode = candidate;
      via = "NxNN";
      confidence = "explicit";
      markerAt = cross.index ?? -1;
      markerText = cross[0];
    }
  }

  if (episode === null && prefixed) {
    const value = Number(prefixed[1]);
    if (saneEpisode(value) && !LOOKS_LIKE_RESOLUTION.has(value)) {
      episode = value;
      via = "episode prefix";
      markerAt = prefixed.index ?? -1;
      markerText = prefixed[0];
    }
  }
  if (episode === null && hashed) {
    const value = Number(hashed[1]);
    if (saneEpisode(value) && !LOOKS_LIKE_RESOLUTION.has(value)) {
      episode = value;
      via = "#NN";
      markerAt = hashed.index ?? -1;
      markerText = hashed[0];
    }
  }

  // A range is a batch. Refusing it is the point: `01-12` is twelve episodes
  // wearing one name, and grouping it against a single episode is how a keeper
  // gets chosen for the wrong thing.
  if (episode === null && range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (low < high && high - low >= 1) {
      return {
        key: null,
        reason: `"${range[0]}" is a range of episodes, not one episode`,
      };
    }
  }

  if (episode === null) {
    const dashed = haystack.match(DASH_ABSOLUTE_BEFORE_TAG) ?? haystack.match(DASH_ABSOLUTE);
    if (dashed) {
      const value = Number(dashed[1]);
      if (saneEpisode(value) && !LOOKS_LIKE_RESOLUTION.has(value)) {
        episode = value;
        via = "dash number";
        markerAt = dashed.index ?? -1;
        markerText = dashed[0];
      }
    }
  }
  if (episode === null) {
    // The leading-number form is the weakest one, and the DOT is what makes it
    // a claim: `3 Body Problem` has a space and stays a title.
    const leading = stem.match(LEADING_NUMBER);
    if (leading) {
      const value = Number(leading[1]);
      if (saneEpisode(value) && !LOOKS_LIKE_RESOLUTION.has(value)) {
        episode = value;
        via = "leading number";
      }
    }
  }

  if (episode === null) {
    return { key: null, reason: "no episode number in the filename" };
  }

  // A marker is not the whole story: `S01E01-12` is a season pack and
  // `S01E07E08` is two episodes in one file. Refusing is the point — grouping a
  // batch against a single episode offers to trash twelve episodes as "the
  // duplicate". The tail is inspected because `EPISODE_RANGE` cannot see it: its
  // lookbehind rejects a digit that follows `E`.
  if (markerAt >= 0) {
    const after = haystack.slice(markerAt + markerText.length);
    // A second episode looks like `-12`, `~12`, `E08`, or a whole other
    // `S02E01`. A bare `S2` is NOT a second episode — it is the season token
    // that these names put after the episode prefix (`Ep-04 S2 Black Clover`).
    const moreEpisodes =
      // `-12`, `-E08`, `-EP.08`, `~12` — a second episode after a separator.
      /^\s*[-~&]\s*(?:[Ee][Pp]?\s*[.\-_ ]?\s*)?\d{1,4}/.test(after) ||
      // `E08`, `EP.08`, `E 08` — a second episode with no separator.
      /^\s*[Ee][Pp]?\s*[.\-_ ]?\s*\d{1,4}/.test(after) ||
      // A whole second `S02E01`.
      /^\s*S\d{1,2}\s*[.\-_ ]?\s*E\d{1,4}/i.test(after);
    if (moreEpisodes) {
      return {
        key: null,
        reason: `"${stem}" names more than one episode, so it is not a duplicate of any single episode`,
      };
    }
  }

  // Season: the name wins, the folder fills in, ABSOLUTE stays null.
  let seasonSource: NameKey["seasonSource"] = "none";
  if (season === null) {
    const bare = haystack.match(BARE_SEASON);
    if (bare) {
      season = Number(bare[1]);
      seasonSource = "name";
    } else if (folderSeason !== null) {
      season = folderSeason;
      seasonSource = "folder";
      via = `${via} + folder season`;
    }
  } else {
    seasonSource = "name";
  }

  // The title is what comes BEFORE the marker.
  //
  // This is the single most valuable rule in the file. Everything after an
  // episode marker is release metadata — group, resolution, codec, size — and
  // two releases of one episode share a title but never share that tail. Keeping
  // the tail is why `Frieren.S01E07...SubsPlease` and `Frieren.S01E07...TV`
  // became "Frieren SubsPlease" and "Frieren TV" and never grouped.
  //
  // A marker at index 0 (or a prefix that is only tags) says nothing, so those
  // fall back to cleaning the whole name, which is what handles
  // `EP 03 - Danmachi S3` and `[ΛV] Ep-04 S2 Black Clover`.
  let title = markerAt > 0 ? cleanTitle(stem.slice(0, markerAt)) : "";
  let titled = isPlausibleTitle(title);
  if (!titled) {
    title = cleanTitle(stem);
    titled = isPlausibleTitle(title);
  }
  if (!titled && usableFolder !== null) {
    title = usableFolder;
    titled = false;
    via = `${via} + folder title`;
  }
  if (!isPlausibleTitle(title)) {
    return {
      key: null,
      reason:
        title.trim() === ""
          ? "the filename has no show name left once tags are removed"
          : `"${title}" is not a show name`,
    };
  }

  return {
    key: {
      show: title,
      season,
      episode,
      resolution: resolutionFrom(stem),
      source: sourceFrom(stem),
      variant: variantFrom(stem),
      confidence,
      via,
      titled,
      seasonSource,
      region: regionFrom(stem),
    },
    reason: null,
  };
}

// --- grouping ---------------------------------------------------------------

/**
 * The grouping key: season + episode, never the title.
 *
 * The title is compared separately (and loosely) so that two releases of one
 * show can be recognised even when the strings differ. A season of `null` is
 * spelled ABSOLUTE so it can never collide with `S01`.
 *
 * The variant is deliberately NOT part of the key. A plain file and a `[Sub]`
 * file are usually the same thing, and keying on it would stop them meeting;
 * `variantsCompatible` refuses the comparison only when both sides ASK for a
 * different flavour.
 */
export function episodeKey(season: number | null, episode: number): string {
  const seasonPart = season === null ? "ABS" : `S${String(season).padStart(2, "0")}`;
  return `${seasonPart}E${String(episode).padStart(4, "0")}`;
}

/**
 * Whether two copies may be compared at all.
 *
 * `[Dual]` and `[Sub]` are both worth owning, so two explicit and DIFFERENT
 * variants are never grouped. An unstated variant is compatible with anything:
 * a plain name is not a claim about audio.
 */
export function variantsCompatible(a: Variant, b: Variant): boolean {
  return a === null || b === null || a === b;
}

export function describeEpisode(season: number | null, episode: number): string {
  const seasonPart = season === null ? "absolute" : `S${String(season).padStart(2, "0")}`;
  return `${seasonPart}E${String(episode).padStart(2, "0")}`;
}

export { RESOLUTION_RANK, SOURCE_RANK };
