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
import { ALWAYS_EXCLUDED_DIRS } from "../config/schema.ts";
import { ensureDir, moveFile, statSafe } from "../util/fs.ts";
import { dirname, normPath, resolveInside } from "../util/paths.ts";

import {
  findByteIdentical,
  markSuspicious,
  suggestKeeper,
  type Candidate,
} from "./tier1.ts";
import { findSameEpisode, parseEpisode } from "./tier2.ts";
import type {
  ApplyResult,
  DupeGroup,
  DupeMember,
  DupeReport,
} from "./types.ts";

export interface ScanOptions {
  /** Every root the report should span. `config.roots` plus `dest_root`. */
  roots: string[];
  /** 1 = byte-identical only, 2 = same episode only, undefined = both. */
  tier?: 1 | 2;
  /** Default true. `--no-auto` turns it off, but it never deletes anything. */
  suggest?: boolean;
  onProgress?: (message: string) => void;
}

/** Never crossed, never considered. §6 rule 4. */
const KEEP_PATTERNS = [/(^|\/)keep\.txt$/i, /\.important$/i];

/** How small is too small. §6 rule 11. */
const TRUNCATED_FRACTION = 0.5;

function isProtected(relative: string): boolean {
  return KEEP_PATTERNS.some((re) => re.test(relative));
}

async function statOf(
  path: string,
): Promise<{ size: number; mtime: number | null } | null> {
  // `statSafe`, not Bun.file().stat(): the latter's typings have no
  // lastModified, and it throws on a dangling path rather than returning null.
  const st = await statSafe(path);
  if (!st) return null;
  return {
    size: st.size,
    mtime: st.mtimeMs > 0 ? Math.round(st.mtimeMs / 1000) : null,
  };
}

/**
 * Walk every root, collecting media-sized files.
 *
 * `resolveInside` is the gate: a path that escapes its root (via `..`, an
 * absolute path, or a symlink) never becomes a candidate. That is §6 rule 6,
 * applied at DISCOVERY so a bad path cannot even reach the report.
 */
async function collect(
  roots: string[],
): Promise<{ candidates: Candidate[]; bytes: number }> {
  const candidates: Candidate[] = [];
  let bytes = 0;

  for (const root of roots) {
    const glob = new Bun.Glob("**/*");
    for await (const relative of glob.scan({
      cwd: root,
      dot: false,
      followSymlinks: false,
    })) {
      if (!relative || relative.endsWith("/")) continue;
      const segments = relative.split("/");
      if (segments.some((s) => ALWAYS_EXCLUDED_DIRS.includes(s))) continue;
      if (isProtected(relative)) continue;

      const absolute = resolveInside(root, relative);
      if (absolute === null) continue; // §6 rule 6

      const stat = await statOf(absolute);
      if (!stat || stat.size === 0) continue;

      candidates.push({
        path: absolute,
        relative,
        size: stat.size,
        mtime: stat.mtime,
      });
      bytes += stat.size;
    }
  }
  return { candidates, bytes };
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
 */
function showStem(relative: string): string {
  const name = relative.split("/").pop() ?? relative;
  const stem = name.replace(/\.[^.]+$/, "");
  const cut = stem.search(/\d/);
  const head = (cut === -1 ? stem : stem.slice(0, cut)).toLowerCase();
  const tail =
    cut === -1 ? "" : stem.slice(cut).replace(/\d+/g, "#").toLowerCase();
  return `${head}${tail}`.slice(0, 40);
}

/** @returns the relatives flagged as truncated. */
export function flagTruncated(candidates: Candidate[]): Set<string> {
  const byStem = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const stem = showStem(c.relative);
    const list = byStem.get(stem);
    if (list) list.push(c);
    else byStem.set(stem, [c]);
  }
  const flagged = new Set<string>();
  for (const group of byStem.values()) {
    // One file alone cannot be "truncated relative to its siblings".
    if (group.length < 2) continue;
    const largest = Math.max(...group.map((c) => c.size));
    if (largest <= 0) continue;
    for (const c of group) {
      if (c.size < largest * TRUNCATED_FRACTION) flagged.add(c.path);
    }
  }
  return flagged;
}

/** Read-only. See the header. */
export async function scanDuplicates(opts: ScanOptions): Promise<DupeReport> {
  const { candidates, bytes } = await collect(opts.roots);
  const suggest = opts.suggest !== false;

  // Computed first, so the finding is reported even when it forms no group.
  const truncatedPaths = flagTruncated(candidates);
  const unparsed: string[] = [];
  const truncated: string[] = [];
  const groups: DupeGroup[] = [];
  let nextId = 1;

  if (opts.tier !== 2) {
    opts.onProgress?.("tier 1: looking for byte-identical files");
    for (const members of await findByteIdentical(
      candidates,
      opts.onProgress,
    )) {
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
    for (const { members, label } of await findSameEpisode(
      candidates,
      seen,
      opts.onProgress,
    )) {
      for (const m of members) {
        if (truncatedPaths.has(m.path)) m.suspicious = "truncated";
        if (m.suspicious) truncated.push(m.relative);
      }
      // A truncated file is never the keeper (§6 rule 11), whatever scored well.
      if (suggest) {
        const current = members.find((m) => m.keep);
        if (current?.suspicious) {
          current.keep = false;
          const clean = members.find((m) => !m.suspicious);
          if (clean) clean.keep = true;
        }
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

  // Everything the parser could not place, and every fragment found anywhere.
  const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.path)));
  for (const c of candidates) {
    if (truncatedPaths.has(c.path) && !truncated.includes(c.relative)) {
      truncated.push(c.relative);
    }
    if (grouped.has(c.path)) continue;
    const { reason } = await parseEpisode(c.path.split("/").pop() ?? c.path);
    if (reason) unparsed.push(`${c.relative} — ${reason}`);
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
  const known = new Map<string, DupeMember>();
  for (const g of report.groups)
    for (const m of g.members) known.set(m.path, m);

  const trashRoot =
    opts.trashRoot ??
    `${opts.destRoot}/.portage/trash/${new Date(opts.now ?? Date.now()).toISOString().slice(0, 10)}`;

  for (const raw of paths) {
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
    const target = resolveInside(opts.destRoot, member.relative);
    if (target === null) {
      result.refused.push({ path: raw, reason: "outside dest_root" });
      continue;
    }
    // §6 rule 5 — never delete the last copy of anything.
    const group = report.groups.find((g) =>
      g.members.some((m) => m.path === raw),
    );
    if (group) {
      const survivors = group.members.filter(
        (m) => m.path !== raw && !pathsIncludes(paths, m.path),
      );
      if (survivors.length === 0) {
        result.refused.push({
          path: raw,
          reason: "would remove the last copy",
        });
        continue;
      }
    }

    const to = resolveInside(trashRoot, member.relative);
    if (to === null) {
      result.refused.push({
        path: raw,
        reason: "destination escapes the trash directory",
      });
      continue;
    }
    try {
      await ensureDir(dirname(to));
      await moveFile(target, to);
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

export { suggestKeeper };
export * from "./types.ts";
