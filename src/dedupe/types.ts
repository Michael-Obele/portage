/**
 * The duplicate report's vocabulary.
 *
 * Nothing in this file deletes anything. These are the shapes docs/dedupe.md
 * describes, and the review screen and `--json` render the same objects, so a
 * person and a script are looking at one report.
 */

/** One file inside a group. */
export interface DupeMember {
  /** Absolute path on the drive. */
  path: string;
  /** Path relative to the root it was found under. Preserved on the move. */
  relative: string;
  size: number;
  /** Seconds since epoch, or null when the filesystem did not say. */
  mtime: number | null;
  /** sha256, or null when the file could not be read. */
  hash: string | null;
  /**
   * Advisory score with its reason, e.g. "best source", "higher resolution".
   * NEVER applied without the person choosing it.
   */
  score: string | null;
  scoreReason: string | null;
  /** The suggested keeper. Advisory, and never the only thing that decides. */
  keep: boolean;
  /**
   * A problem found while examining this file — today only "truncated".
   *
   * docs/dedupe.md §6 rule 11: on real data, a Heroes S01 folder looked like a
   * duplicate of itself, but two files that matched by NAME did not match by
   * SIZE, and one of them was an 89 MB fragment wearing a 300 MB episode's name.
   * Deleting the "duplicate" folder the naive way would have kept the fragment
   * and destroyed the good copy. So truncation is reported as a PROBLEM, and a
   * truncated file is never eligible to be the keeper.
   */
  suspicious: string | null;
}

export interface DupeGroup {
  id: number;
  /** 1 = byte-identical, 2 = same episode, different release. */
  tier: 1 | 2;
  /** Why this group is suspected. Always shown; never left for the user to infer. */
  reason: string;
  /** `S01E07 "Frieren"` for tier 2, null for tier 1. */
  label: string | null;
  members: DupeMember[];
  /** Bytes that would be reclaimed by keeping exactly one member. */
  reclaimableBytes: number;
}

export interface DupeReport {
  groups: DupeGroup[];
  tier1Count: number;
  tier2Count: number;
  /** Bytes reclaimable if every group is resolved as suggested. */
  reclaimableBytes: number;
  scannedFiles: number;
  scannedBytes: number;
  /** Files that could not be parsed into an episode. Reported, never guessed. */
  unparsed: string[];
  /** Files flagged truncated. Reported as a problem, never as a duplicate. */
  truncated: string[];
}

/** Where a move went, so the answer can be printed and journalled. */
export interface AppliedMove {
  from: string;
  to: string;
  bytes: number;
}

export interface ApplyResult {
  moved: AppliedMove[];
  /** Every refusal, with the rule that refused it. Never a silent skip. */
  refused: Array<{ path: string; reason: string }>;
  bytesMoved: number;
}
