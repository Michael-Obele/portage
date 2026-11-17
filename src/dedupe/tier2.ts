/**
 * Tier 2 — same episode, different release.
 *
 * docs/dedupe.md §4 and §5. The short version of §5 is the whole point of this
 * file: on real data Tier 2 is a CANDIDATE GENERATOR, not an answer, because
 * release-group abbreviations cannot be resolved to a title by any parser. So
 * everything here refuses to guess, and says what it could not do.
 *
 * WHAT CHANGED, AND WHY (measured on the real archive)
 *
 * This file used to hand every name to `parse-torrent-title` and take what came
 * back. On `/media/node/2TB` — 7 567 video files — that placed **785 of them,
 * 10 %**. The parser's season/episode handler does not accept a separator before
 * the `E` (`S01-E02` is invisible to it), and its title rule ignores a match at
 * index 0, so `EP 03 - Danmachi S3` kept `EP 03` as the title. Reading a real
 * archive is what makes those two lines visible; no fixture would have.
 *
 * So parsing now lives in `naming.ts` as an ordered cascade, and this file does
 * the one thing that cannot be done per-file: decide whether two DIFFERENT
 * names are the same episode. That is the loose part, and it is deliberately
 * narrow:
 *
 *  - the season and episode must be equal, exactly, as numbers;
 *  - the titles are compared with `titlesMatch`, which refuses when a number
 *    differs and refuses when a region marker differs;
 *  - every member of a group must match every other member (a CLIQUE). dupeGuru
 *    discards a non-clique match rather than emitting overlapping groups, and it
 *    is right: a group is only safe if the pairwise claim holds for all of it;
 *  - a `Dual` copy and a `Sub` copy are never grouped against each other, because
 *    owning both is a choice a person makes.
 */
import { basename } from "#lib/util/paths.ts";

import type { Candidate } from "#lib/dedupe/tier1.ts";
import type { DupeMember } from "#lib/dedupe/types.ts";
import {
  describeEpisode,
  episodeKey,
  fingerprint,
  isMediaCandidate,
  parseMediaName,
  titlesMatch,
  variantsCompatible,
  RESOLUTION_RANK,
  SOURCE_RANK,
  type NameKey,
  type Variant,
} from "#lib/dedupe/naming.ts";

/** The identity of one episode, as read from a filename and its folder. */
export type EpisodeKey = NameKey;

export interface ParseOutcome {
  key: NameKey | null;
  /** Why it could not be grouped. Reported to the user, never swallowed. */
  reason: string | null;
}

/**
 * Parse one filename into an episode key, or explain why it could not be.
 *
 * Kept `async` because the old implementation loaded a parser lazily and every
 * caller awaits it; the cascade itself is pure and synchronous.
 */
export async function parseEpisode(
  name: string,
  folder: string | null = null,
): Promise<ParseOutcome> {
  return parseMediaName(name, folder);
}

/** The folder a relative path sits in, or `null` at the root. */
export function folderOf(relative: string): string | null {
  const slash = relative.lastIndexOf("/");
  if (slash <= 0) return null;
  const folder = relative.slice(0, slash);
  const last = folder.slice(folder.lastIndexOf("/") + 1);
  return last === "" ? null : last;
}

/** The grouping key. Season + episode only — variant is compared, not keyed. */
export function groupKey(key: NameKey): string {
  return episodeKey(key.season, key.episode);
}

export function groupLabel(key: NameKey): string {
  return `${describeEpisode(key.season, key.episode)} "${key.show}"`;
}

/**
 * Score one member. Advisory, and always paired with its reason.
 *
 * Order from §4: source rank, then higher resolution, then the larger file,
 * then newer mtime.
 */
export function scoreMember(member: DupeMember, key: NameKey | null): void {
  const resolutions = key?.resolution ? RESOLUTION_RANK[key.resolution] : undefined;
  const sources = key?.source ? SOURCE_RANK[key.source] : undefined;
  const reasons: string[] = [];
  if (key?.source && sources) reasons.push(`best source (${key.source})`);
  else if (key?.resolution && resolutions) reasons.push(`${key.resolution}`);
  member.score = reasons[0] ?? null;
  member.scoreReason = reasons.join("; ") || null;
}

/** Compare two members; the higher score wins. Ties break on size, then mtime. */
function betterThan(
  a: DupeMember,
  b: DupeMember,
  keys: Map<string, NameKey | null>,
): number {
  const rank = (m: DupeMember) => {
    const k = keys.get(m.path) ?? null;
    return (
      (k?.source ? (SOURCE_RANK[k.source] ?? 0) : 0) * 10 +
      (k?.resolution ? (RESOLUTION_RANK[k.resolution] ?? 0) : 0)
    );
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return rb - ra;
  if (a.size !== b.size) return b.size - a.size;
  return (b.mtime ?? 0) - (a.mtime ?? 0);
}

/**
 * How much smaller than the largest copy in its own group a file may be before
 * it stops being a candidate keeper. A third: the field evidence in
 * docs/dedupe.md §6 rule 11 is 89 MB against 300 MB.
 */
const KEEPER_SIZE_FLOOR = 0.35;

/** One parsed file, kept together with the candidate it came from. */
interface Parsed {
  candidate: Candidate;
  key: NameKey;
}

/**
 * Whether two parsed files may sit in the same group.
 *
 * Exported for tests: this is the whole "loose" claim, and it has to be
 * reviewable on its own.
 *
 * Three guards sit ABOVE `titlesMatch`, and each closes a false positive a real
 * archive produced:
 *
 *  1. **A different explicit flavour is a different file.** `[Dual]` and `[Sub]`
 *     copies are both worth owning.
 *  2. **The season must come from the same place.** `Show - 13` inside
 *     `Show S2/` is ambiguous — absolute 13, or the thirteenth of season 2? — and
 *     pairing it with `Show.S02E13` picks an answer. When one side inferred the
 *     season from a folder and the other was told it by the filename, the group
 *     is refused.
 *  3. **Two borrowed titles are two guesses.** A filename with no show name of
 *     its own borrows the folder's, and a folder is only as specific as its
 *     name: `Kids/` and `Completed/` are shelves, so two different shows' tag-
 *     only files inside one would otherwise become one group. The same rule
 *     costs a genuine group (two encodes of one `EP.1` in a show folder) and
 *     that is the correct trade — a missed group is a report, a wrong group is
 *     a deletion.
 *
 * A folder-token "second chance" used to live here and was removed: it let
 * `The Office` group with `The Office UK`, and `Fate` with `Fate Zero`, by
 * matching a single shared word while skipping the number and region guards
 * entirely.
 */
export function sameShow(a: NameKey, b: NameKey): boolean {
  if (!variantsCompatible(a.variant, b.variant)) return false;
  // A declared region is identity. `The.Office.[US]` and `The.Office.[UK]` read
  // as one title once their brackets are stripped, so the tag has to be
  // compared before that happens.
  if (a.region !== b.region) return false;
  if (a.seasonSource !== b.seasonSource) return false;
  if (!a.titled && !b.titled) return false;
  return titlesMatch(a.show, b.show);
}

/**
 * Group candidates by episode.
 *
 * @param excluded paths already reported as byte-identical (tier 1). A file that
 *   is an exact duplicate belongs in tier 1, not in both.
 */
export async function findSameEpisode(
  candidates: Candidate[],
  excluded: Set<string>,
  onProgress?: (message: string) => void,
  /** `false` = `--no-auto`: report the group, propose no keeper. */
  suggest = true,
): Promise<{
  groups: Array<{ members: DupeMember[]; label: string }>;
  unparsed: string[];
}> {
  // Only files that could hold an episode are asked to prove one. Everything
  // else was being reported as "could not be parsed", which is a question the
  // file never asked.
  const pool = candidates.filter(
    (c) => !excluded.has(c.path) && isMediaCandidate(basename(c.path), c.size),
  );
  if (pool.length === 0) return { groups: [], unparsed: [] };

  onProgress?.(`reading ${pool.length} filenames for an episode`);

  const keys = new Map<string, NameKey | null>();
  const unparsed: string[] = [];
  const buckets = new Map<string, Parsed[]>();

  for (const candidate of pool) {
    const name = basename(candidate.path);
    const { key, reason } = await parseEpisode(name, folderOf(candidate.relative));
    keys.set(candidate.path, key);
    if (!key) {
      if (reason) unparsed.push(`${candidate.relative} — ${reason}`);
      continue;
    }
    const bucketKey = groupKey(key);
    const list = buckets.get(bucketKey);
    const parsed: Parsed = { candidate, key };
    if (list) list.push(parsed);
    else buckets.set(bucketKey, [parsed]);
  }

  const groups: Array<{ members: DupeMember[]; label: string }> = [];

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;

    // Greedy cliques, not connected components: a member joins only when it
    // matches EVERY member already in the group. Transitive closure would let
    // A–B and B–C imply A–C, and a group that is not a clique is a group that
    // can delete something it never compared.
    const used = new Set<number>();
    for (let i = 0; i < bucket.length; i += 1) {
      if (used.has(i)) continue;
      const seed = bucket[i] as Parsed;
      const component: Parsed[] = [seed];
      for (let j = i + 1; j < bucket.length; j += 1) {
        if (used.has(j)) continue;
        const other = bucket[j] as Parsed;
        if (component.every((member) => sameShow(member.key, other.key))) {
          component.push(other);
        }
      }
      if (component.length < 2) continue;
      for (let j = 0; j < bucket.length; j += 1) {
        if (component.includes(bucket[j] as Parsed)) used.add(j);
      }

      const members = component.map<DupeMember>((entry) => ({
        path: entry.candidate.path,
        relative: entry.candidate.relative,
        size: entry.candidate.size,
        mtime: entry.candidate.mtime,
        hash: null,
        score: null,
        scoreReason: null,
        keep: false,
        suspicious: null,
      }));

      /**
       * A fragment may never be the keeper — whatever its score says.
       *
       * This is the §6 rule 11 invariant, and it has to live HERE rather than
       * only in the cross-scan truncation sweep: that sweep compares each file
       * with its show siblings, so a fragment that is the only member of its
       * quality class is never compared with anything, escapes the flag, and
       * would otherwise win the keeper vote on source rank. The group is the
       * same episode, so size comparison inside it is meaningful: a member at a
       * third of the largest is a partial file.
       */
      const largest = Math.max(...members.map((member) => member.size));
      const viable =
        largest > 0
          ? members.filter((member) => member.size >= largest * KEEPER_SIZE_FLOOR)
          : members;
      // The largest member always clears the floor, so `viable` is never empty.
      const ranked = [...viable].sort((a, b) => betterThan(a, b, keys));
      const keeper = suggest ? ranked[0] : undefined;
      if (keeper) {
        keeper.keep = true;
        scoreMember(keeper, keys.get(keeper.path) ?? null);
        // Explain the choice in the user's terms, not a score.
        keeper.scoreReason = [
          keeper.score ?? "preferred copy",
          "advisory — you decide",
        ].join("; ");
      }
      for (const member of members) {
        if (!member.keep) scoreMember(member, keys.get(member.path) ?? null);
      }

      const labelKey = (component[0] as Parsed).key;
      groups.push({ members, label: groupLabel(labelKey) });
    }
  }

  // A parsed file that ended up in no group is not a failure — it is a file
  // with no sibling. Only a file that could not be READ as an episode is
  // reported, and that distinction is the difference between six thousand
  // noise lines and a list a person can act on.
  return { groups, unparsed };
}

export { fingerprint, type Variant };
