/**
 * The Plan screen's filters, its intent and its row model — all pure, so the
 * screen holds only the parts that need reactivity.
 *
 * Two rules from `screens.md` shape this file:
 *
 *  1. **Verdicts are the engine's vocabulary.** `chipFor` maps a verdict onto
 *     the app's coarse state chip, and the row keeps the engine's own verdict
 *     word AND its own reason sentence untouched beside it. Nothing here
 *     softens `already-on-drive` into "already have it".
 *  2. **A filter that is silently dropped is a lie.** Every filter in force is
 *     turned into an argument the engine understands, and `filtersActive` is
 *     what lets the screen say "nothing matches these filters" instead of
 *     "nothing new" — two states that look identical and mean opposite things.
 *
 * No Svelte import: `bun test` can drive all of it with no compiler.
 */
import type {
	ArgsFor,
	DeviceInfo,
	PlanResult,
	PlannedFile,
	Verdict
} from '../../engine/protocol.ts';
import { plural } from '../../util/format.ts';

// --- filters ----------------------------------------------------------------

/** The time windows the UI offers. `all` sends no `since` at all. */
export type SinceWindow = 'all' | '1d' | '7d' | '30d';

export interface PlanFilters {
	/** A device id, or `''` for every ready device. */
	device: string;
	/** The `--show` text filter. Empty means no filter. */
	show: string;
	since: SinceWindow;
}

export const ALL_DEVICES = '';

export const SINCE_OPTIONS: ReadonlyArray<{ value: SinceWindow; label: string }> = [
	{ value: '1d', label: 'Modified in the last day' },
	{ value: '7d', label: 'Modified in the last week' },
	{ value: '30d', label: 'Modified in the last 30 days' },
	{ value: 'all', label: 'Any time' }
];

export function emptyFilters(): PlanFilters {
	return { device: ALL_DEVICES, show: '', since: 'all' };
}

/** True when anything is being filtered out, so "empty" and "filtered" differ. */
export function filtersActive(filters: PlanFilters): boolean {
	return filters.device !== ALL_DEVICES || filters.show.trim() !== '' || filters.since !== 'all';
}

/** One sentence naming the filters in force, for a table caption or a header. */
export function filtersSentence(filters: PlanFilters, deviceLabel?: string): string {
	const parts: string[] = [];
	if (filters.device !== ALL_DEVICES) parts.push(deviceLabel ?? filters.device);
	if (filters.show.trim() !== '') parts.push(`matching "${filters.show.trim()}"`);
	if (filters.since !== 'all') {
		const option = SINCE_OPTIONS.find((entry) => entry.value === filters.since);
		parts.push(option ? option.label.toLowerCase() : filters.since);
	}
	return parts.length === 0 ? 'no filter' : parts.join(', ');
}

/**
 * The filters as the engine's arguments.
 *
 * `exclude` is not a filter: it is the files a person removed by hand, and the
 * engine still plans them so the count and the table stay honest.
 */
export function planArgs(filters: PlanFilters, exclude: readonly string[] = []): ArgsFor<'plan'> {
	const args: ArgsFor<'plan'> = {};
	if (filters.device !== ALL_DEVICES) args.device = filters.device;
	const show = filters.show.trim();
	if (show !== '') args.show = show;
	if (filters.since !== 'all') args.since = filters.since;
	if (exclude.length > 0) args.exclude = [...exclude];
	return args;
}

// --- the pull intent --------------------------------------------------------

/** `delete-after-verify` deletes the phone copy; `keep` is copy-only. */
export type PullMode = 'delete-after-verify' | 'keep';

export interface PullIntent {
	device: string;
	show: string;
	since: SinceWindow;
	/** Source paths removed by hand; the run must not move them. */
	exclude: string[];
	mode: PullMode;
}

export function intentFrom(
	filters: PlanFilters,
	mode: PullMode,
	exclude: readonly string[] = []
): PullIntent {
	return {
		device: filters.device,
		show: filters.show.trim(),
		since: filters.since,
		exclude: [...exclude],
		mode
	};
}

/**
 * The intent as a query string.
 *
 * It travels in the URL rather than in a module-level cell, so the Transfer
 * screen can be reloaded, bookmarked and reached by keyboard without a second
 * hidden channel that only exists while a click is in flight.
 */
export function intentToSearch(intent: PullIntent): string {
	const params = new URLSearchParams();
	params.set('mode', intent.mode);
	if (intent.device !== ALL_DEVICES) params.set('device', intent.device);
	if (intent.show !== '') params.set('show', intent.show);
	if (intent.since !== 'all') params.set('since', intent.since);
	for (const path of intent.exclude) params.append('exclude', path);
	return `?${params.toString()}`;
}

function isSince(value: string | null): value is SinceWindow {
	return value === '1d' || value === '7d' || value === '30d' || value === 'all';
}

/**
 * Read an intent back out of a query string.
 *
 * `mode` is the marker: without it there is no intent, and `/transfer` visited
 * directly says "nothing to move" rather than inventing a run.
 */
export function parseIntent(search: string): PullIntent | null {
	const params = new URLSearchParams(search);
	const mode = params.get('mode');
	if (mode !== 'keep' && mode !== 'delete-after-verify') return null;
	const since = params.get('since');
	return {
		mode,
		device: params.get('device') ?? ALL_DEVICES,
		show: params.get('show') ?? '',
		since: isSince(since) ? since : 'all',
		exclude: params.getAll('exclude')
	};
}

/** The intent as a set of filters, for re-planning the same files on Transfer. */
export function filtersFromIntent(intent: PullIntent): PlanFilters {
	return {
		device: intent.device,
		show: intent.show,
		since: intent.since
	};
}

/** The same intent as a `pull.start` envelope. */
export function pullStartArgs(intent: PullIntent): ArgsFor<'pull.start'> {
	const args: ArgsFor<'pull.start'> = { mode: intent.mode };
	if (intent.device !== ALL_DEVICES) args.device = intent.device;
	if (intent.show !== '') args.show = intent.show;
	if (intent.since !== 'all') args.since = intent.since;
	if (intent.exclude.length > 0) args.exclude = [...intent.exclude];
	return args;
}

/** The intent in words, for the Transfer header. */
export function intentSentence(intent: PullIntent, deviceLabel?: string): string {
	const parts: string[] = [];
	parts.push(intent.device === ALL_DEVICES ? 'every ready device' : (deviceLabel ?? intent.device));
	if (intent.show !== '') parts.push(`matching "${intent.show}"`);
	if (intent.since !== 'all')
		parts.push(
			SINCE_OPTIONS.find((o) => o.value === intent.since)?.label.toLowerCase() ?? intent.since
		);
	if (intent.exclude.length > 0) {
		parts.push(`${plural(intent.exclude.length, 'file')} removed by hand`);
	}
	parts.push(
		intent.mode === 'keep'
			? 'copy only, the phone copy is kept'
			: 'delete the phone copy once the copy is verified'
	);
	return parts.join(' · ');
}

/** The label for a device picker entry: never just a serial if a name exists. */
export function deviceLabel(device: DeviceInfo): string {
	const name = device.model.trim() === '' ? device.id : device.model;
	return device.state === 'device' ? name : `${name} (${device.state})`;
}

// --- the row model ----------------------------------------------------------

/** The app's coarse states, as a subset of `StateChipState`. */
export type PlanChip = 'queued' | 'copying' | 'skipped' | 'duplicate' | 'excluded';

export interface PlanRow {
	key: string;
	/** The filename alone. The table truncates it in the middle. */
	name: string;
	srcPath: string;
	destPath: string;
	size: number;
	chip: PlanChip;
	/** The engine's verdict word, verbatim. */
	verdict: Verdict;
	/** The engine's sentence, verbatim. */
	reason: string;
	willTransfer: boolean;
	/** True when a copy of this file is already on the drive. */
	onDrive: boolean;
	/** True when a person removed this file from this pull. */
	excluded: boolean;
}

export function baseName(path: string): string {
	const cut = path.lastIndexOf('/');
	return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * The chip a verdict earns.
 *
 * `skipped` is the app's word for "the plan declined this file" and is true of
 * `excluded`, `too-recent`, `empty` and `already-on-drive` alike — which is why
 * the verdict column carries the engine's precise word next to it. `copying` is
 * used only for `in-flight`, which is what it literally means: the file is
 * being written by something else right now.
 */
export function chipFor(verdict: Verdict, willTransfer: boolean): PlanChip {
	if (willTransfer) return 'queued';
	switch (verdict) {
		case 'in-flight':
			return 'copying';
		case 'duplicate-candidate':
			return 'duplicate';
		default:
			return 'skipped';
	}
}

/**
 * The engine's own reason for a file, in preference order.
 *
 * `skipReason` is the plan's sentence about why it passed the file over; the
 * archive hit's note names the copy already on the drive; `candidate.reason` is
 * what the scan concluded. All three are the engine's words.
 */
export function reasonFor(file: PlannedFile): string {
	return (
		file.skipReason?.trim() || file.matchesArchive?.note.trim() || file.candidate.reason.trim()
	);
}

export function rowFrom(file: PlannedFile, willTransfer: boolean): PlanRow {
	const candidate = file.candidate;
	return {
		key: `${candidate.deviceId}\u0000${candidate.srcPath}\u0000${candidate.size}`,
		name: baseName(candidate.srcPath),
		srcPath: candidate.srcPath,
		destPath: file.destPath,
		size: willTransfer ? file.bytes : candidate.size,
		chip: file.excluded ? 'excluded' : chipFor(candidate.verdict, willTransfer),
		verdict: candidate.verdict,
		reason: reasonFor(file),
		willTransfer,
		onDrive: candidate.verdict === 'already-on-drive',
		excluded: file.excluded === true
	};
}

/**
 * One ordered list: what would move, then what would not.
 *
 * A single table, because the two halves are one answer — "here is the plan" —
 * and splitting them lets a person read the first half and miss the second.
 */
export function planRows(plan: PlanResult): PlanRow[] {
	return [
		...plan.toTransfer.map((file) => rowFrom(file, true)),
		...plan.skipped.map((file) => rowFrom(file, false))
	];
}
