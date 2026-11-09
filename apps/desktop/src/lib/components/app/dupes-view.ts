/**
 * The Duplicates screen's selection rules and its copy — pure, so `bun test`
 * can drive every one of them with no compiler.
 *
 * Three rules shape this file, and they come from the wire contract rather than
 * from taste:
 *
 *  1. **A key, never a path.** The engine issues one opaque key per member
 *     (`k0..kN`) for the life of a scan and refuses the WHOLE call for a key it
 *     did not issue, so a selection is a set of keys and a path is only ever
 *     display text.
 *  2. **The report travels in the `dupes` FRAME.** `dupes.scan`'s ANSWER is a
 *     tally (`{scanId, groups, keys, reclaimableBytes, trashDir}`), so every
 *     number a person reads comes from the frame. Reading the report out of the
 *     answer is exactly the mistake that once crashed a screen.
 *  3. **The engine's words are not softened.** `reason`, `scoreReason` and
 *     `suspicious` are shown verbatim by the screen; nothing here rewrites
 *     them into friendlier copy.
 *
 * No Svelte import: `bun test` can drive all of it with no compiler.
 */
import type {
	AnswerFor,
	DupesFrame,
	NeedsConfirmFrame,
	WireDupeGroup,
	WireDupeMember
} from '../../engine/protocol.ts';
import { formatBytes, plural } from '../../util/format.ts';

// --- the member chip --------------------------------------------------------

/**
 * What a member row's chip says.
 *
 * A subset of `StateChipState`, declared here rather than imported from the
 * component so this module stays free of anything Svelte-shaped.
 */
export type MemberTone = 'kept' | 'duplicate' | 'skipped';

/**
 * A member's chip.
 *
 * `suspicious` outranks `keep`: the engine never keeps a file it flagged, and a
 * member that somehow does wear both is a problem first (the row prints the
 * engine's own word beside the chip).
 */
export function memberTone(member: WireDupeMember): MemberTone {
	if (member.suspicious !== null) return 'skipped';
	return member.keep ? 'kept' : 'duplicate';
}

// --- selection --------------------------------------------------------------

/**
 * The default selection: every copy the engine did NOT pick as the keeper.
 *
 * The keeper arrives with `keep: true` and is deliberately left out, so the
 * obvious action is one click. It is still selectable — the engine's suggestion
 * is a suggestion, and the person may disagree.
 */
export function selectionFor(groups: readonly WireDupeGroup[]): Set<string> {
	const selected = new Set<string>();
	for (const group of groups) {
		for (const member of group.members) {
			if (!member.keep) selected.add(member.key);
		}
	}
	return selected;
}

/** Toggle one key. Returns a NEW set, so a `$state` replacement is a real change. */
export function toggle(selection: ReadonlySet<string>, key: string): Set<string> {
	const next = new Set(selection);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

/** Every key in one group, in report order. */
export function groupKeys(group: WireDupeGroup): string[] {
	return group.members.map((member) => member.key);
}

/** A group's keys added to the selection (its "Select all"). */
export function selectKeys(selection: ReadonlySet<string>, keys: readonly string[]): Set<string> {
	return new Set([...selection, ...keys]);
}

/** A group's keys removed from the selection (its "Clear"). */
export function clearKeys(selection: ReadonlySet<string>, keys: readonly string[]): Set<string> {
	const next = new Set(selection);
	for (const key of keys) next.delete(key);
	return next;
}

/** Whether a group is fully, partly or not at all selected. */
export type GroupSelection = 'all' | 'some' | 'none';

export function groupSelectionState(
	group: WireDupeGroup,
	selection: ReadonlySet<string>
): GroupSelection {
	if (group.members.length === 0) return 'none';
	let chosen = 0;
	for (const member of group.members) {
		if (selection.has(member.key)) chosen += 1;
	}
	if (chosen === 0) return 'none';
	return chosen === group.members.length ? 'all' : 'some';
}

// --- the totals -------------------------------------------------------------

export interface Totals {
	count: number;
	bytes: number;
}

/** What the current selection would move: the footer's count and byte total. */
export function groupTotals(
	selection: ReadonlySet<string>,
	groups: readonly WireDupeGroup[]
): Totals {
	let count = 0;
	let bytes = 0;
	for (const group of groups) {
		for (const member of group.members) {
			if (!selection.has(member.key)) continue;
			count += 1;
			bytes += member.size;
		}
	}
	return { count, bytes };
}

/** The display paths behind a selection, in report order. Never sent back. */
export function selectedPaths(
	selection: ReadonlySet<string>,
	groups: readonly WireDupeGroup[]
): string[] {
	const paths: string[] = [];
	for (const group of groups) {
		for (const member of group.members) {
			if (selection.has(member.key)) paths.push(member.relative);
		}
	}
	return paths;
}

/** The selected members' own byte total, from the frame's members. */
export function selectedBytes(
	selection: ReadonlySet<string>,
	groups: readonly WireDupeGroup[]
): number {
	return groupTotals(selection, groups).bytes;
}

// --- copy -------------------------------------------------------------------

/**
 * What the scan covered and what it found — one sentence, no soft numbers.
 *
 * Used as the header summary once a scan exists and as the body of the
 * "no duplicates found" state, so the count a person reads is always the
 * frame's own count.
 */
export function scanSentence(frame: DupesFrame): string {
	const files = plural(frame.scannedFiles, 'file');
	const bytes = formatBytes(frame.scannedBytes);
	const groups = plural(frame.groups.length, 'group');
	const reclaimable = formatBytes(frame.reclaimableBytes);
	return `Scanned ${files} · ${bytes}: ${groups} · ${reclaimable} reclaimable.`;
}

// --- the confirm round-trip -------------------------------------------------

export interface ConfirmFacts {
	paths: string[];
	count: number;
	bytes: number;
	trashDir: string | null;
}

/**
 * What the confirm sheet shows.
 *
 * The `needsConfirm` FRAME is the source: it is written BEFORE the answer and
 * carries the engine's own path list, so what the sheet names and what moves
 * are the same strings.
 *
 * The fallback exists for one honest reason: a fixture (or a future engine)
 * that can only return counts would otherwise produce a sheet reading "0 B"
 * over a real selection. The engine's numbers win whenever it sends them, and
 * the selection is only ever a *display* fallback — the request still carries
 * keys, never paths.
 */
export function confirmFacts(
	frame: NeedsConfirmFrame,
	groups: readonly WireDupeGroup[],
	selection: ReadonlySet<string>
): ConfirmFacts {
	const fallbackPaths = selectedPaths(selection, groups);
	return {
		paths: frame.paths.length > 0 ? frame.paths : fallbackPaths,
		count: frame.count > 0 ? frame.count : fallbackPaths.length,
		bytes: frame.bytes > 0 ? frame.bytes : selectedBytes(selection, groups),
		trashDir: frame.trashDir
	};
}

export interface ApplySummary {
	moved: number;
	refused: number;
	bytesMoved: number;
	trashDir: string | null;
}

function countOf(value: unknown): number {
	if (Array.isArray(value)) return value.length;
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The success answer, or `null` when the engine asked for confirmation instead.
 *
 * `dupes.apply` answers with one of two shapes: the confirm request
 * (`needsConfirm`) or the outcome (`moved`/`refused`/`bytesMoved`). The answer's
 * fields are typed `unknown` on the wire, so each is read defensively — a
 * missing array is zero files, never `NaN` in the copy.
 */
export function applySummary(answer: AnswerFor<'dupes.apply'>): ApplySummary | null {
	const record: Record<string, unknown> = { ...answer };
	if ('needsConfirm' in record) return null;
	return {
		moved: countOf(record['moved']),
		refused: countOf(record['refused']),
		bytesMoved: countOf(record['bytesMoved']),
		trashDir: typeof record['trashDir'] === 'string' ? record['trashDir'] : null
	};
}
