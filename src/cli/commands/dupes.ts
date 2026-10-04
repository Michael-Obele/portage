/**
 * `portage dupes` — the report, and the deliberate action.
 *
 * Read-only by default. docs/dedupe.md §6 rule 1: nothing in this tool deletes
 * automatically, in either tier. There is no `--yes`. The report is free and
 * safe to run whenever; moving a file is an action that names exactly what goes.
 */
import { requireDestRoot } from "../../config/load.ts";
import type { ResolvedConfig } from "../../config/load.ts";
import { applySelection, scanDuplicates } from "../../dedupe/index.ts";
import type { DupeReport } from "../../dedupe/types.ts";
import { detect } from "../../tui/degrade.ts";
import type { Output } from "../../output/output.ts";
import { ExitCode, usageError } from "../../util/errors.ts";
import type { Logger } from "../../util/log.ts";
import { formatBytes } from "../../util/paths.ts";

export interface DupesContext {
  resolved: ResolvedConfig;
  output: Output;
  logger: Logger;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function tierOf(flags: Record<string, string | boolean>): 1 | 2 | undefined {
  const raw = flags.tier;
  if (raw === undefined || raw === false) return undefined;
  const n = Number(raw);
  if (n !== 1 && n !== 2)
    throw usageError(`--tier needs 1 or 2, got "${String(raw)}"`);
  return n;
}

/** The roots the report spans: `dest_root` plus any `roots` the config adds. */
function rootsFor(resolved: ResolvedConfig): string[] {
  const roots = new Set<string>();
  for (const r of resolved.config.roots) roots.add(r);
  roots.add(requireDestRoot(resolved.config));
  return [...roots];
}

/** The `--json` payload. A script and a person read the same report. */
function toJson(report: DupeReport) {
  return {
    scanned_files: report.scannedFiles,
    scanned_bytes: report.scannedBytes,
    tier1_groups: report.tier1Count,
    tier2_groups: report.tier2Count,
    reclaimable_bytes: report.reclaimableBytes,
    truncated: report.truncated,
    unparsed: report.unparsed,
    groups: report.groups.map((g) => ({
      id: g.id,
      tier: g.tier,
      reason: g.reason,
      label: g.label,
      reclaimable_bytes: g.reclaimableBytes,
      members: g.members.map((m) => ({
        path: m.path,
        size: m.size,
        hash: m.hash,
        keep: m.keep,
        score: m.score,
        score_reason: m.scoreReason,
        suspicious: m.suspicious,
      })),
    })),
  };
}

function render(report: DupeReport, o: Output): void {
  o.line();
  o.heading("duplicates");
  o.kv(
    "scanned",
    `${report.scannedFiles} files · ${formatBytes(report.scannedBytes)} across every configured root`,
  );
  o.kv(
    "groups",
    `${report.tier1Count} byte-identical · ${report.tier2Count} same-episode`,
  );
  // The payoff is stated BEFORE any action (§6 rule 8).
  o.kv("reclaimable", formatBytes(report.reclaimableBytes));
  o.line();

  if (report.groups.length === 0) {
    o.ok("no duplicate groups found");
    return;
  }

  for (const g of report.groups) {
    const head =
      g.tier === 1
        ? `TIER 1  byte-identical`
        : `TIER 2  ${g.label ?? "same episode"}`;
    o.line(`${head}   ·   ${formatBytes(g.reclaimableBytes)} reclaimable`);
    for (const m of g.members) {
      const marker = m.keep ? "keep" : "  x ";
      const note = m.suspicious ? `⚠ ${m.suspicious}` : (m.scoreReason ?? "");
      o.bullet(
        `${marker}  ${formatBytes(m.size).padStart(9)}  ${m.relative}${note ? `  (${note})` : ""}`,
      );
    }
    o.bullet(`        why: ${g.reason}`);
    o.line();
  }

  // Problems are reported as problems, never as duplicates.
  if (report.truncated.length > 0) {
    o.warn(
      `${report.truncated.length} file(s) look truncated and are never treated as duplicates:`,
    );
    for (const t of report.truncated) o.bullet(t);
    o.line();
  }
  if (report.unparsed.length > 0) {
    o.bullet(
      `${report.unparsed.length} filename(s) could not be placed — left alone, never guessed:`,
    );
    for (const u of report.unparsed.slice(0, 20)) o.bullet(u);
    if (report.unparsed.length > 20)
      o.bullet(`… and ${report.unparsed.length - 20} more`);
    o.line();
  }

  o.bullet("nothing has been moved. this report is read-only.");
  o.bullet("to move a group: `portage dupes --apply <path> …`");
}

export async function dupes(ctx: DupesContext): Promise<number> {
  const { output: o, resolved } = ctx;
  const roots = rootsFor(resolved);
  const tier = tierOf(ctx.flags);
  const dryRun = ctx.flags["dry-run"] === true;
  const destRoot = requireDestRoot(resolved.config);

  // The review screen mounts only when the terminal can take it. A pipe, --json,
  // --plain and TERM=dumb all fall through to the plain report below, which is
  // the same report over the same objects (gate B2: every action is reachable
  // without the TUI).
  const caps = detect();
  const review =
    caps.tui && ctx.flags.apply === undefined && ctx.flags.apply === false;
  if (review) {
    const { runDupesTui } = await import("../../tui/dupes.svelte.ts");
    return await runDupesTui({
      roots,
      tier,
      suggest: ctx.flags.auto !== false,
      destRoot,
    });
  }

  const report = await scanDuplicates({
    roots,
    tier,
    // `--no-auto` suppresses the suggestion. It still never deletes anything —
    // it only stops us naming a keeper.
    suggest: ctx.flags.auto !== false,
    onProgress: (m) => ctx.logger.debug(m),
  });

  const apply = ctx.flags.apply;
  if (apply === undefined || apply === false) {
    if (o.mode === "json") o.emitJson(toJson(report));
    else render(report, o);
    return 0;
  }

  // `--apply` takes an explicit list. There is no "apply everything", because a
  // blanket move is exactly the thing this screen exists to prevent.
  const selected = Array.isArray(apply)
    ? apply.map(String)
    : [String(apply), ...ctx.positionals];
  if (selected.length === 0) {
    throw usageError(
      "--apply needs the paths it should move",
      'for example: portage dupes --apply "Anime/Frieren/S01/ep01.mkv"',
    );
  }

  if (dryRun) {
    const result = await applySelection(report, selected, {
      destRoot: requireDestRoot(resolved.config),
      // Resolve-only: report what would move without moving it.
      trashRoot: `${requireDestRoot(resolved.config)}/.portage/trash/<date>`,
    });
    if (o.mode === "json") {
      o.emitJson({
        dry_run: true,
        ...toJson(report),
        would_move: result.moved,
        refused: result.refused,
      });
    } else {
      o.line();
      o.heading("dry run — nothing will be moved");
      for (const m of result.moved) o.bullet(`${m.from}  →  ${m.to}`);
      for (const r of result.refused) o.fail(`${r.path} — ${r.reason}`);
    }
    return result.refused.length > 0 ? ExitCode.transfer : 0;
  }

  const result = await applySelection(report, selected, {
    destRoot: requireDestRoot(resolved.config),
  });

  if (o.mode === "json") {
    o.emitJson({
      moved: result.moved,
      refused: result.refused,
      bytes_moved: result.bytesMoved,
      reclaimable_bytes: report.reclaimableBytes,
    });
  } else {
    o.line();
    o.heading("moved to trash");
    for (const m of result.moved) o.ok(`${m.from}  →  ${m.to}`);
    for (const r of result.refused) o.fail(`${r.path} — ${r.reason}`);
    o.kv(
      "moved",
      `${result.moved.length} files · ${formatBytes(result.bytesMoved)}`,
    );
    o.bullet("restore with `portage trash`");
  }
  return result.refused.length > 0 ? ExitCode.transfer : 0;
}
