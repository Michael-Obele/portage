/**
 * Tier 1 — byte-identical files.
 *
 * docs/dedupe.md §2 lays out three stages so a 2 TB scan never reads 2 TB:
 * group by size, sample-hash, then full-hash the survivors.
 *
 * ⚠ THE CORRECTNESS POINT, MEASURED NOT ASSUMED
 *
 * `sampleHash` reads the first, middle and last 64 KiB. Two 1 MiB files that
 * differ in exactly ONE byte at offset 128 KiB — outside all three windows —
 * produce an EQUAL sample hash and an UNEQUAL sha256.
 *
 * So the sample stage can only ever REJECT a non-duplicate. It can never
 * CONFIRM one. Stage 3 is not a performance optimisation; it is the guarantee.
 * An implementation that reports IDENTICAL on sample equality alone will
 * eventually delete a good copy, which is exactly the field failure in
 * docs/dedupe.md §6 rule 11.
 *
 * The confirmation a pair must pass is BOTH: equal size AND equal full hash.
 * Never size alone — two different episodes from the same encode can share a
 * size, and a size match is the false positive that destroys the good copy.
 */
import { sampleHash, sha256File } from "../util/hash.ts";

import type { DupeMember } from "./types.ts";

/** A file as discovered, before any hashing. */
export interface Candidate {
  path: string;
  relative: string;
  size: number;
  mtime: number | null;
}

/**
 * Scratch folders and anything that looks like a holding pen. A file here is a
 * worse keeper than the same file filed properly, which is why this ranks ABOVE
 * path length (docs/dedupe.md §2).
 */
const SCRATCH =
  /(^|\/)(_incoming|incoming|downloads?|download|dupe|dupes|tmp|temp)(\/|$)/i;

/**
 * Suggested keeper — ADVISORY ONLY, and always with its reason.
 *
 * Order, from docs/dedupe.md §2:
 *   1. the organised tree beats a scratch folder
 *   2. shorter path wins (fewer nested "copy of" folders)
 *   3. newer mtime wins (usually the better rip)
 *   4. lexicographic path, as a stable tie-break
 */
export function suggestKeeper(members: DupeMember[]): DupeMember | null {
  if (members.length === 0) return null;
  const ranked = [...members].sort((a, b) => {
    const aScratch = SCRATCH.test(a.relative) ? 1 : 0;
    const bScratch = SCRATCH.test(b.relative) ? 1 : 0;
    if (aScratch !== bScratch) return aScratch - bScratch;

    const depth = a.relative.split("/").length - b.relative.split("/").length;
    if (depth !== 0) return depth;
    if (a.relative.length !== b.relative.length)
      return a.relative.length - b.relative.length;

    const mtime = (b.mtime ?? 0) - (a.mtime ?? 0);
    if (mtime !== 0) return mtime;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return ranked[0] ?? null;
}

export function keeperReason(
  keeper: DupeMember,
  members: DupeMember[],
): string {
  if (SCRATCH.test(keeper.relative)) return "not in a scratch folder";
  const depth = keeper.relative.split("/").length;
  const shallowest = Math.min(
    ...members.map((m) => m.relative.split("/").length),
  );
  if (depth === shallowest) return "shallowest path";
  const newest = Math.max(...members.map((m) => m.mtime ?? 0));
  if ((keeper.mtime ?? 0) === newest) return "newest";
  return "preferred keeper";
}

/**
 * Flag a file that is far smaller than its siblings.
 *
 * §6 rule 11: a fragment wearing an episode's name. A member under half the
 * largest size in its own group is reported, and is never eligible to be the
 * keeper — because keeping the fragment is how you lose the show.
 */
export function markSuspicious(members: DupeMember[]): void {
  const largest = Math.max(...members.map((m) => m.size));
  for (const m of members) {
    m.suspicious = largest > 0 && m.size < largest / 2 ? "truncated" : null;
  }
}

/** Members eligible to be kept: not flagged as a problem. */
function eligibleForKeep(members: DupeMember[]): DupeMember[] {
  const clean = members.filter((m) => m.suspicious === null);
  // A group where every member is suspicious has no good keeper at all; fall
  // back to all of them rather than pretending the group is resolvable.
  return clean.length > 0 ? clean : members;
}

/** Hash every candidate fully. Separate so a test can drive the stages alone. */
export async function fullHashes(
  candidates: Candidate[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const c of candidates) out.set(c.path, await sha256File(c.path));
  return out;
}

/** Split an array into buckets keyed by `key`, dropping singletons. */
function buckets<T>(items: T[], key: (item: T) => string | null): T[][] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return [...map.values()].filter((g) => g.length > 1);
}

/**
 * The three stages. Returns groups of members that are byte-identical.
 *
 * @param onProgress called after each stage with a human-readable line, so the
 *   TUI can say what it is doing instead of looking hung for four minutes.
 */
export async function findByteIdentical(
  candidates: Candidate[],
  onProgress?: (message: string) => void,
): Promise<DupeMember[][]> {
  if (candidates.length === 0) return [];

  // Stage 1 — by size. Files of different sizes cannot be identical, and this
  // removes the vast majority of comparisons on its own.
  onProgress?.(`grouping ${candidates.length} files by size`);
  const bySize = buckets(candidates, (c) => String(c.size));
  const sized = bySize.flat();
  if (sized.length === 0) return [];

  // Stage 2 — sample hash. REJECTS ONLY; it can never confirm a duplicate.
  onProgress?.(`sampling ${sized.length} same-size files`);
  const withSample: Array<Candidate & { sample: string }> = [];
  for (const c of sized) {
    const s = await sampleHash(c.path);
    if (s !== null) withSample.push({ ...c, sample: s });
  }
  const bySample = buckets(withSample, (c) => c.sample);
  const sampled2 = bySample.flat();
  if (sampled2.length === 0) return [];

  // Stage 3 — full hash. THIS is what makes "identical" true.
  onProgress?.(`verifying ${sampled2.length} candidates byte for byte`);
  const hashes = await fullHashes(sampled2);

  const confirmed = buckets(
    sampled2.map((c) => ({ candidate: c, hash: hashes.get(c.path) ?? null })),
    (c) => c.hash,
  );

  const groups: DupeMember[][] = [];
  for (const group of confirmed) {
    const members = group.map<DupeMember>((c) => ({
      path: c.candidate.path,
      relative: c.candidate.relative,
      size: c.candidate.size,
      mtime: c.candidate.mtime,
      hash: c.hash,
      score: null,
      scoreReason: null,
      keep: false,
      suspicious: null,
    }));
    markSuspicious(members);
    const keeper = suggestKeeper(eligibleForKeep(members));
    if (keeper) {
      keeper.keep = true;
      keeper.score = "byte-identical";
      keeper.scoreReason = keeperReason(keeper, members);
    }
    groups.push(members);
  }
  return groups;
}
