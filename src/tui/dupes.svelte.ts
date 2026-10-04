/**
 * `portage dupes` on a terminal.
 *
 * A sibling of the dashboard entry, not a special case inside it: scan the drive
 * into a report, mount the review, and let the person decide. Everything the
 * screen can do is also reachable from the plain command, which is what makes
 * gate B2 true rather than aspirational.
 *
 * Tier 1 arrives ticked, Tier 2 arrives unticked, and the footer names the
 * destination before Enter is pressed. The screen owns those rules; this file
 * only wires the scan and then waits.
 */
import { applySelection, scanDuplicates } from "../dedupe/index.ts";
import type { DupeReport } from "../dedupe/types.ts";
import { ExitCode } from "../util/errors.ts";
import { createLogger } from "../util/log.ts";

import { OpenTuiRenderer } from "./renderer.svelte.ts";
import { view } from "./state.svelte.ts";
import { DupesScreen, type DupesIntent } from "./screens/dupes.ts";
import { deferred } from "./deferred.ts";

export interface DupesTuiOptions {
  roots: string[];
  tier?: 1 | 2;
  suggest: boolean;
  destRoot: string;
}

/** Tier 1 pre-ticked, Tier 2 never. docs/dedupe.md §6 rule 1. */
function seedSelection(report: DupeReport): void {
  for (const group of report.groups) {
    for (const member of group.members) {
      // Tier 1 is byte-identical: the keeper is the one we keep, everything else
      // is genuinely the same bytes and safe to move.
      member.keep =
        group.tier === 1 && !member.suspicious && report.tier1Count > 0
          ? group.members.findIndex((m) => !m.suspicious) ===
            group.members.indexOf(member)
          : false;
    }
  }
}

export async function runDupesTui(opts: DupesTuiOptions): Promise<number> {
  const logger = createLogger("normal");
  const report = await scanDuplicates({
    roots: opts.roots,
    tier: opts.tier,
    suggest: opts.suggest,
    onProgress: (m) => logger.debug(m),
  });

  seedSelection(report);
  view.groups = report.groups;
  view.undo = [];
  view.selected = 0;
  view.scrollTop = 0;
  view.screen = "dupes";
  const date = new Date().toISOString().slice(0, 10);
  view.trashDir = `${opts.destRoot}/.portage/trash/${date}/`;
  view.trashBytes = report.groups.reduce(
    (n, g) =>
      n + g.members.filter((m) => m.keep).reduce((k, m) => k + m.size, 0),
    0,
  );
  if (report.unparsed.length > 0) {
    view.notice = `${report.unparsed.length} filename(s) could not be placed — left alone, never guessed`;
  }

  const renderer = new OpenTuiRenderer(Bun.argv);
  const screen = new DupesScreen();
  const done = deferred<DupesIntent>();
  renderer.guard();
  await renderer.mount(screen);

  // The screen sets `intent` and returns; we read it on the next frame.
  const poller = setInterval(() => {
    if (screen.intent.action !== "nothing") done.settle(screen.intent);
  }, 50);

  try {
    const intent = await done.promise;
    clearInterval(poller);
    if (intent.action === "quit") return ExitCode.success;

    // A second apply pass validates against the report, so a path that is no
    // longer part of it — or one that would remove the last copy — is refused
    // here rather than trusted from the screen.
    const result = await applySelection(report, intent.paths, {
      destRoot: opts.destRoot,
    });
    return result.refused.length > 0 ? ExitCode.transfer : ExitCode.success;
  } finally {
    clearInterval(poller);
    renderer.unmount();
  }
}
