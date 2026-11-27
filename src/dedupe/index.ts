/**
 * The duplicate engine.
 *
 * `scanDuplicates` is STRICTLY READ-ONLY. It walks roots, reports, and never
 * writes. `applySelection` is the only thing that moves a file, and it moves to
 * trash after validation — never deletes.
 *
 * Every §6 safety rule in docs/dedupe.md is enforced here, in code, and each one
 * has a test. A rule that is "usually true" is not a rule.
 */
import { ALWAYS_EXCLUDED_DIRS } from "#lib/config/schema.ts";
import { ensureDirTracked, moveFile } from "#lib/util/durable.ts";
import { statDrive } from "#lib/util/probe.ts";
import { dirname, localDayKey, normPath, resolveInside } from "#lib/util/paths.ts";

import {
  findByteIdentical,
  suggestKeeper,
  type Candidate,
} from "#lib/dedupe/tier1.ts";
import { RESOLUTION_RANK, isMediaCandidate, resolutionFrom } from "#lib/dedupe/naming.ts";
import { findSameEpisode } from "#lib/dedupe/tier2.ts";
import { defaultScanIo, resilientScanIo, type ScanIo, type WalkOutcome } from "#lib/dedupe/scan-io.ts";
import type {
  ApplyResult,
  DupeGroup,
  DupeMember,
  DupeReport,
} from "#lib/dedupe/types.ts";

export interface ScanOptions {
  /** Every root the report should span. `config.roots` plus `dest_root`. */
  roots: string[];
  /** 1 = byte-identical only, 2 = same episode only, undefined = both. */
  tier?: 1 | 2;
  /** Default true. `--no-auto` turns it off, but it never deletes anything. */
  suggest?: boolean;
  onProgress?: (message: string) => void;
  /**
   * How to reach the filesystem. Defaults to the Rust scanner when one is
   * installed, and the built-in walker otherwise. Injectable so a test can drive
   * either path without a binary on disk.
   */
  io?: ScanIo;
}

/** Never crossed, never considered. §6 rule 4. */
const KEEP_PATTERNS = [/(^|\/)keep\.txt$/i, /\.important$/i];

/**
 * How small is too small. §6 rule 11.
 *
 * A THIRD, not a half. Encodes of one series vary legitimately: on the real
 * drive one 1080p [Dual] season ran 144 MB — 378 MB, a 2.6× spread with no
 * damage anywhere in it, and the smallest file missed a 50 % test by 53 KB.
 * What this rule is looking for is a FRAGMENT, and a fragment is not 55 % of an
 * episode; it is a third of one or less (the field evidence in §6 rule 11 is
 * 89 MB against 300 MB).
 */
const TRUNCATED_FRACTION = 0.35;

/**
 * The same fraction, for the keeper rule. They are deliberately the same number
 * and deliberately separate names: one decides what to REPORT, the other what
 * to KEEP, and they may drift apart for good reasons.
 */
const KEEPER_SIZE_FLOOR = 0.35;

function isProtected(relative: string): boolean {
  return KEEP_PATTERNS.some((re) => re.test(relative));
}

/**
 * Walk every root, collecting media-sized files.
 *
 * `resolveInside` is the gate: a path that escapes its root (via `..`, an
 * absolute path, or a symlink) never becomes a candidate. That is §6 rule 6,
 * applied at DISCOVERY so a bad path cannot even reach the report.
 *
 * The walk lives behind `ScanIo`; what must not differ between walkers is the
 * keep-file filter.
 */
async function collect(
  roots: string[],
  io: ScanIo,
): Promise<WalkOutcome> {
  const outcome = await io.walk(roots);

  const candidates: Candidate[] = [];
  let bytes = 0;
  for (const candidate of outcome.candidates) {
    if (candidate.size === 0) continue;
    if (isProtected(candidate.relative)) continue;
    if (candidate.relative.split("/").some((s) => ALWAYS_EXCLUDED_DIRS.includes(s))) continue;
    candidates.push(candidate);
    bytes += candidate.size;
  }
  return { ...outcome, candidates, bytes };
}

function toGroup(
  members: DupeMember[],
  tier: 1 | 2,
  label: string | null,
  reason: string,
  id: number,
): DupeGroup {
  const keeper = members.find((m) => m.keep) ?? null;
  // Reclaimable is the total minus what one keeper costs. With no keeper — every
  // member flagged truncated — nothing is reclaimable, and saying so is honest.
  const reclaimable = keeper
    ? members.reduce((n, m) => n + m.size, 0) - keeper.size
    : 0;
  return { id, tier, reason, label, members, reclaimableBytes: reclaimable };
}

/**
 * Flag fragments across the WHOLE scan, not only inside a group.
 *
 * The field evidence in §6 rule 11 is not a duplicate at all: two files in the
 * same season folder, `hrs.s01e13` and `hrs.s01e17`, where the second was an
 * 89 MB fragment wearing a 300 MB episode's name. Those two are different
 * episodes, so they never form a group and a per-group check would never see
 * them. So we compare each file against its SHOW SIBLINGS: everything sharing
 * the name up to the first digit run (`hrs.s`, `Frieren.S01E`).
 *
 * **Siblings must be in the same QUALITY CLASS.** Size alone is not evidence of
 * a fragment: a 720p copy of an episode is legitimately less than half a 1080p
 * one, and comparing across resolutions flagged real files on a real drive. So
 * the comparison is `(show stem, resolution)`, and a file with no resolution in
 * its name is only compared with others that also state none.
 */
function showStem(relative: string): string {
  const parts = relative.split("/");
  const name = parts.pop() ?? relative;
  // The FOLDER is part of the identity. `Big Show/EP 01.mkv` and
  // `Tiny Show/EP 01.mkv` reduce to the same basename stem, and without this
  // one show's file was flagged as a fragment of another's.
  const folder = (parts.pop() ?? "").toLowerCase();
  const stem = name
    .replace(/\.[^.]+$/, "")
    // Resolution is a QUALITY CLASS, not part of the show's name: `FHD` and
    // `1080p` must land in the same bucket or a fragment wearing one spelling
    // is never compared with its siblings.
    .replace(RESOLUTION_WORD, "")
    .replace(/\s+/g, " ")
    // Stripping a token leaves its separator (`Show.02.720p` -> `Show.02.`), and
    // a trailing dot made a tagged file never meet its untagged siblings.
    .replace(/[._\-\s]+$/g, "")
    .trim();
  const cut = stem.search(/\d/);
  const head = (cut === -1 ? stem : stem.slice(0, cut)).toLowerCase();
  const tail =
    cut === -1 ? "" : stem.slice(cut).replace(/\d+/g, "#").toLowerCase();
  return `${folder}|${head}${tail}`.slice(0, 120);
}

/**
 * Any resolution spelling, so the stem does not depend on which one is used.
 *
 * No bare `hd`/`sd`: `SD Gundam` is a show and `HD` is a plausible folder, and
 * stripping them merged two real titles. The bracketed spellings that matter
 * (`1080p`, `720p`, `FHD`, `4k`…) are all unambiguous.
 */
const RESOLUTION_WORD = /\b(?:2160p|1440p|1080p|720p|576p|480p|360p|4k|uhd|fhd)\b/gi;

/** @returns the relatives flagged as truncated. */
export function flagTruncated(candidates: Candidate[]): Set<string> {
  const byStem = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const name = c.relative.split("/").pop() ?? c.relative;
    // Only media can be a truncated EPISODE. Without this, a thumbnail beside
    // its audio track was reported as a fragment of it.
    if (!isMediaCandidate(name, c.size)) continue;
    // Siblings are `(immediate folder + digit-normalised stem, resolution RANK)`.
    // `1080p` and `720p` are different releases, not different lengths of the
    // same one, and the resolution may be stated by the FOLDER (`Show [720p]/`)
    // rather than the file. The key is the RANK, so `FHD` and `1080p` meet.
    // The file's OWN tag first, the folder only as a fallback. Reading the
    // whole path left-to-right let a `720p/` shelf above the show override a
    // `1080p` filename, which put a 1080p file in the 720p class and flagged it.
    const resolution = resolutionFrom(name) ?? resolutionFrom(c.relative);
    const rank = resolution === null ? "unknown" : String(RESOLUTION_RANK[resolution] ?? resolution);
    const key = `${showStem(c.relative)}|${rank}`;
    const list = byStem.get(key);
    if (list) list.push(c);
    else byStem.set(key, [c]);
  }
  const flagged = new Set<string>();
  for (const group of byStem.values()) {
    // One file alone cannot be "truncated relative to its siblings".
    if (group.length < 2) continue;
    // LEAVE-ONE-OUT median, not the group's median.
    //
    // The group's own median is dragged by the file being judged, and with a
    // handful of siblings that is the difference between "a third of a typical
    // episode" and "a third of a typical episode that is not this one". Each
    // file is measured against its SIBLINGS; a group of two compares each to
    // the other, which is exactly the field case in §6 rule 11.
    for (const c of group) {
      const others = group
        .filter((other) => other !== c)
        .map((other) => other.size)
        .sort((a, b) => a - b);
      if (others.length === 0) continue;
      const median =
        others.length % 2 === 1
          ? (others[(others.length - 1) / 2] as number)
          : ((others[others.length / 2 - 1] as number) + (others[others.length / 2] as number)) / 2;
      if (median > 0 && c.size < median * TRUNCATED_FRACTION) flagged.add(c.path);
    }
  }
  return flagged;
}

/**
 * Choose the keeper of a group, or none.
 *
 * The floor is the whole point: inside a group every member is the SAME
 * episode, so size is meaningful evidence, and a member under a third of the
 * largest is a partial file that must never be proposed as the copy to keep.
 * When nothing clears the floor the group has no keeper at all — which is
 * honest, and makes `reclaimableBytes` zero rather than inviting a bad choice.
 */
function electKeeper(members: DupeMember[], suggest: boolean): void {
  for (const member of members) member.keep = false;
  if (!suggest) return;
  const largest = Math.max(...members.map((member) => member.size));
  const viable = members.filter(
    (member) => member.suspicious === null && (largest <= 0 || member.size >= largest * KEEPER_SIZE_FLOOR),
  );
  const best = [...viable].sort(
    (a, b) => b.size - a.size || (b.mtime ?? 0) - (a.mtime ?? 0) || (a.path < b.path ? -1 : 1),
  )[0];
  if (best) best.keep = true;
}

/** Read-only. See the header. */
export async function scanDuplicates(opts: ScanOptions): Promise<DupeReport> {
  const resilient = resilientScanIo(opts.io ?? defaultScanIo(), opts.onProgress);
  const io = resilient.io;
  const walked = await collect(opts.roots, io);
  const { candidates, bytes } = walked;
  const suggest = opts.suggest !== false;

  // Computed first, so the finding is reported even when it forms no group.
  const truncatedPaths = flagTruncated(candidates);
  const unparsed: string[] = [];
  const truncated: string[] = [];
  const groups: DupeGroup[] = [];
  let nextId = 1;
  let unreadableFiles = 0;

  if (opts.tier !== 2) {
    opts.onProgress?.("tier 1: looking for byte-identical files");
    const identical = await findByteIdentical(candidates, opts.onProgress, io);
    unreadableFiles += identical.unreadable;
    for (const members of identical.groups) {
      if (!suggest) members.forEach((m) => (m.keep = false));
      for (const m of members) {
        if (truncatedPaths.has(m.path)) m.suspicious = "truncated";
        // §6 rule 11: a truncated file is never the keeper.
        if (m.suspicious) m.keep = false;
        if (m.suspicious) truncated.push(m.relative);
      }
      const keeper = suggestKeeper(
        members.filter((m) => m.suspicious === null),
      );
      if (suggest && keeper) keeper.keep = true;
      groups.push(
        toGroup(
          members,
          1,
          null,
          "byte-identical: same size and same sha256 over the whole file",
          nextId++,
        ),
      );
    }
  }

  if (opts.tier !== 1) {
    opts.onProgress?.("tier 2: looking for the same episode in two releases");
    const seen = new Set(groups.flatMap((g) => g.members.map((m) => m.path)));
    const sameEpisode = await findSameEpisode(candidates, seen, opts.onProgress, suggest);
    // Only MEDIA files that could not be read as an episode land here. A parsed
    // file with no sibling is not a failure, and a `.zip` was never a candidate
    // for an episode number in the first place.
    unparsed.push(...sameEpisode.unparsed);
    for (const { members, label } of sameEpisode.groups) {
      for (const m of members) {
        if (truncatedPaths.has(m.path)) m.suspicious = "truncated";
        if (m.suspicious) truncated.push(m.relative);
      }
      // A truncated file is never the keeper (§6 rule 11), whatever scored well.
      //
      // The re-election goes through the floor instead of taking the next clean
      // member in array order: a flagged keeper's replacement is otherwise an
      // arbitrary member, and an 89 MB / 300 MB / 25 MB group was observed
      // promoting the 25 MB file to keeper at 28 % of the group's largest.
      // `findSameEpisode` already ranked by source and resolution, so only a
      // FLAGGED keeper is re-elected — this must not throw that ranking away.
      const chosen = members.find((member) => member.keep);
      if (chosen !== undefined && chosen.suspicious !== null) {
        electKeeper(members, suggest);
      }
      groups.push(
        toGroup(
          members,
          2,
          label,
          "same episode, different release — needs a human decision",
          nextId++,
        ),
      );
    }
  }

  // Every fragment found anywhere. A file that IS in a group is not a caveat,
  // and tier 2 has already reported the media it could not read.
  for (const c of candidates) {
    if (truncatedPaths.has(c.path) && !truncated.includes(c.relative)) {
      truncated.push(c.relative);
    }
  }

  return {
    groups,
    tier1Count: groups.filter((g) => g.tier === 1).length,
    tier2Count: groups.filter((g) => g.tier === 2).length,
    reclaimableBytes: groups.reduce((n, g) => n + g.reclaimableBytes, 0),
    scannedFiles: candidates.length,
    scannedBytes: bytes,
    unparsed,
    truncated,
    unreadableFiles,
    io: {
      // If either stage fell back, this scan was on the slow path, whatever the
      // walk itself managed.
      via: resilient.degraded ? "glob" : walked.via,
      elapsedMs: walked.elapsedMs,
      dirs: walked.dirs,
      errors: walked.errors,
      errorCount: walked.errorCount,
      deepest: walked.deepest,
      depthLimited: walked.depthLimited,
      scannerError: resilient.error ?? walked.scannerError,
    },
  };
}

export interface ApplyOptions {
  /** The drive being tidied. Nothing outside it may move. §6 rule 6. */
  destRoot: string;
  /** Where moves go. Defaults to `<destRoot>/.portage/trash/<YYYY-MM-DD>/`. */
  trashRoot?: string;
  now?: number;
}

/**
 * Move the selected files to trash. Never deletes. Never automatic.
 *
 * @param report  the report the selection came from — apply validates against
 *                it rather than trusting the caller's paths.
 * @param paths   the exact paths to move. Anything not present in the report is
 *                refused, so a stale or invented path cannot move a file.
 */
export async function applySelection(
  report: DupeReport,
  paths: Iterable<string>,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const result: ApplyResult = { moved: [], refused: [], bytesMoved: 0 };
  // Materialised once: the loop below consumes it, and the last-copy check
  // asks whether a path is in the selection. A generator would answer "no" to
  // every question after the first file, which turns a real move into a false
  // "would remove the last copy" refusal.
  const selected = [...paths];
  const known = new Map<string, DupeMember>();
  for (const g of report.groups)
    for (const m of g.members) known.set(m.path, m);

  const trashRoot =
    opts.trashRoot ??
    `${opts.destRoot}/.portage/trash/${localDayKey(new Date(opts.now ?? Date.now()))}`;

  for (const raw of selected) {
    const member = known.get(raw);
    if (!member) {
      result.refused.push({
        path: raw,
        reason: "not part of the reviewed report",
      });
      continue;
    }
    // §6 rule 4 — never cross a keep boundary.
    if (isProtected(member.relative)) {
      result.refused.push({ path: raw, reason: "marked keep" });
      continue;
    }
    // §6 rule 6 — nothing outside dest_root, ever.
    //
    // The containment check runs on the member's own absolute path, and the
    // result IS the source. `member.relative` is relative to the SCAN root,
    // which may be any folder inside the drive (or an extra archive root), so
    // `destRoot + relative` names a different file — or nothing at all. Real
    // evidence: scanning `/drive/sub` and applying refused with
    // `ENOENT: rename '/drive/b/photo-copy.jpg'`, one path segment short.
    const target = resolveInside(opts.destRoot, member.path);
    if (target === null) {
      result.refused.push({ path: raw, reason: "outside dest_root" });
      continue;
    }
    // Where it lands inside the trash mirrors where it sat inside the drive,
    // so two roots that share a relative path cannot collide.
    const insideDrive = target
      .slice(opts.destRoot.replace(/\/+$/, "").length)
      .replace(/^\/+/, "");
    // §6 rule 5 — never delete the last copy. Survivors are checked ON DISK: the
    // report is a snapshot, and a second apply on one scan moved the last copy
    // because the list still named a file that was already in the trash.
    const group = report.groups.find((g) =>
      g.members.some((m) => m.path === raw),
    );
    if (group) {
      let survivors = 0;
      let unreadable = false;
      for (const other of group.members) {
        if (other.path === raw) continue;
        if (pathsIncludes(selected, other.path)) continue;
        const seen = await statDrive(opts.destRoot, other.path);
        if (seen.kind === "ok") survivors += 1;
        else if (seen.kind === "unreadable") unreadable = true;
      }
      if (survivors === 0) {
        // A copy that could not be read may still exist: say so, not "last copy".
        result.refused.push({
          path: raw,
          reason: unreadable
            ? "the destination could not be read; nothing was changed"
            : "would remove the last copy",
        });
        continue;
      }
    }

    const to = resolveInside(trashRoot, insideDrive);
    if (to === null) {
      result.refused.push({
        path: raw,
        reason: "destination escapes the trash directory",
      });
      continue;
    }
    try {
      // Creates missing folders and marks their parents for the flush gate, so new
      // entries reach disk. A failure refuses the file and keeps its source (R1.8, R1.13).
      const dirOutcome = await ensureDirTracked(dirname(to), opts.destRoot);
      if (dirOutcome.kind === "failed") {
        result.refused.push({ path: raw, reason: dirOutcome.reason });
        continue;
      }
      const moveOutcome = await moveFile(opts.destRoot, target, to);
      if (moveOutcome.kind === "failed") {
        result.refused.push({ path: raw, reason: moveOutcome.reason });
        continue;
      }
      result.moved.push({ from: target, to, bytes: member.size });
      result.bytesMoved += member.size;
    } catch (err) {
      result.refused.push({
        path: raw,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

function pathsIncludes(paths: Iterable<string>, candidate: string): boolean {
  for (const p of paths) if (normPath(p) === normPath(candidate)) return true;
  return false;
}

export * from "#lib/dedupe/types.ts";
