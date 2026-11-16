/**
 * Purge — the phone copies the drive already holds, as values rather than
 * pixels.
 *
 * What may be deleted is the ENGINE'S decision, never this screen's. `purge.plan`
 * returns a candidate per file it can vouch for (a `journal-hash` from the
 * recorded transfer, or a `recomputed-hash` when it had to re-read both ends)
 * plus a refused list with a reason per path. The screen only arranges that
 * answer and lets a person narrow it.
 *
 * Two rules this module exists to keep:
 *
 *  - A selection is a set of OPAQUE KEYS, never paths. The engine refuses the
 *    whole call on an unknown key rather than deleting part of a set nobody
 *    reviewed, so the app must never have to reconstruct one.
 *  - Nothing is selected until a person selects it. Reclaiming space is this
 *    screen's job; deciding that a specific file leaves the phone is the
 *    person's. There is one click to take all of them, and it is a click.
 */
import type { NeedsConfirmFrame, PurgePlanFrame, WirePurgeCandidate } from '../../engine/protocol.ts';

export interface PurgeTotals {
	count: number;
	bytes: number;
}

/** What the current selection actually is, read off the plan and not stored. */
export function totalsFor(
	selection: ReadonlySet<string>,
	eligible: readonly WirePurgeCandidate[]
): PurgeTotals {
	let count = 0;
	let bytes = 0;
	for (const candidate of eligible) {
		if (!selection.has(candidate.key)) continue;
		count += 1;
		bytes += candidate.size;
	}
	return { count, bytes };
}

/** Every key the plan offers. The caller decides whether to apply it. */
export function allKeys(eligible: readonly WirePurgeCandidate[]): Set<string> {
	return new Set(eligible.map((candidate) => candidate.key));
}

/** Replaced, never mutated: a mutated Set is a state change the UI cannot see. */
export function toggleKey(selection: ReadonlySet<string>, key: string): Set<string> {
	const next = new Set(selection);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

export interface PurgeFacts {
	paths: string[];
	count: number;
	bytes: number;
	trashDir: string | null;
}

/**
 * The sheet's facts, preferring the engine's own list.
 *
 * The `needsConfirm` frame carries the paths the engine is about to act on, and
 * the sheet must show exactly those. Only when a fixture sends an empty list do
 * the selection's own paths stand in, and they are for DISPLAY — the keys are
 * still what is sent.
 */
export function confirmFacts(
	frame: NeedsConfirmFrame,
	plan: PurgePlanFrame,
	selection: ReadonlySet<string>
): PurgeFacts {
	const chosen = plan.eligible.filter((candidate) => selection.has(candidate.key));
	const totals = totalsFor(selection, plan.eligible);
	return {
		paths: frame.paths.length > 0 ? frame.paths : chosen.map((candidate) => candidate.srcPath),
		count: frame.count > 0 ? frame.count : totals.count,
		bytes: frame.bytes > 0 ? frame.bytes : totals.bytes,
		trashDir: frame.trashDir
	};
}

/** The one line under the title. `null` means no plan has been made yet. */
export function planSentence(plan: PurgePlanFrame | null): string {
	if (plan === null) {
		return 'Finds files on the phone that a verified copy on the drive already covers. Nothing is deleted until you pick a file and confirm it.';
	}
	if (plan.eligible.length === 0) {
		return plan.refused.length === 0
			? 'Every file on the phone is still waiting for its copy. Nothing here is safe to delete yet.'
			: 'No file could be vouched for, so nothing here can be deleted. The refusals below say why.';
	}
	return `The drive already holds a verified copy of ${plan.eligible.length === 1 ? 'this file' : 'these files'}. Deleting them frees the phone and leaves the drive untouched.`;
}

/**
 * How the engine proved the drive copy, in words a person can act on.
 *
 * "recorded hash" and "re-read hash" are the engine's mechanism, not the
 * person's question. The question is "was this checked, and when?" — so say
 * that. The distinction still matters and is still visible.
 */
export function proofWord(candidate: WirePurgeCandidate): string {
	return candidate.proof === 'journal-hash' ? 'checked when copied' : 'checked just now';
}

/** Why a route is worth showing in the refused list, in one phrase. */
export function refusalSentence(reason: string): string {
	const trimmed = reason.trim();
	if (trimmed === '') return 'no reason given';
	// The engine's reasons are already sentences; keep them verbatim.
	return trimmed;
}

export interface PurgeOutcome {
	deleted: number;
	failed: number;
}

function countOf(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * What `purge.apply` actually did, or `null` when it asked for confirmation
 * instead of acting.
 *
 * The wire treats every answer field as `unknown` on purpose — the key table is
 * a shape contract, not a payload type — so this is the one place a purge answer
 * is narrowed.
 */
export function purgeOutcome(answer: unknown): PurgeOutcome | null {
	if (typeof answer !== 'object' || answer === null) return null;
	const record: Record<string, unknown> = { ...answer };
	if ('needsConfirm' in record) return null;
	return { deleted: countOf(record['deleted']), failed: countOf(record['failed']) };
}
