/**
 * The phone folders a pull copies from, as values rather than pixels.
 *
 * The engine reads each device's sources from `config.devices[<id>].roots` and
 * never guesses one: an empty list makes a plan empty and a run report success
 * having copied nothing. So the arithmetic that stands between a person and a
 * working pull lives here — why a folder already covered by another cannot be
 * added twice, what the trail to it reads as, and the sentence that says what
 * an empty list costs.
 *
 * No Svelte import: `bun test` drives every rule here directly.
 */
import type { BrowseEntry } from '../../engine/protocol.ts';
import { plural } from '../../util/format.ts';

/**
 * As high as the browser goes.
 *
 * `/sdcard` is what a person calls internal storage; it is a symlink to
 * `/storage/self/primary`, and browsing above it would show paths that are not
 * folders a pull should ever be pointed at.
 */
export const PHONE_ROOT = '/sdcard';

/** The root is not a folder name, so its crumb needs a word of its own. */
const ROOT_LABEL = 'Internal storage';

export interface Crumb {
	label: string;
	path: string;
}

/**
 * One spelling of a phone path: leading slash, no doubled and no trailing
 * slash. An empty string means the phone root, because a person who has not
 * chosen a folder yet is looking at it.
 */
export function normalizePath(path: string): string {
	const trimmed = path.trim();
	if (trimmed === '') return PHONE_ROOT;
	const joined = `/${trimmed}`.replace(/\/+/g, '/');
	if (joined === '/') return '/';
	return joined.replace(/\/+$/, '');
}

/** `${base}/${name}`, never `//` and never `/name` for an empty name. */
export function joinPath(base: string, name: string): string {
	const left = normalizePath(base);
	const right = name.trim().replace(/^\/+|\/+$/g, '');
	if (right === '') return left;
	return left === '/' ? `/${right}` : `${left}/${right}`;
}

/**
 * The folder above this one — except at the top of the phone, where `/sdcard`
 * is its own parent, which is what hides the "Up" button there.
 */
export function parentPath(path: string): string {
	const clean = normalizePath(path);
	if (clean === PHONE_ROOT) return PHONE_ROOT;
	const cut = clean.lastIndexOf('/');
	if (cut <= 0) return '/';
	return clean.slice(0, cut);
}

/** The trail from internal storage down to `path`, outermost first. */
export function breadcrumb(path: string): Crumb[] {
	const clean = normalizePath(path);
	const insidePhone = clean === PHONE_ROOT || clean.startsWith(`${PHONE_ROOT}/`);

	const crumbs: Crumb[] = [];
	let current = '';
	let segments: string[];

	if (insidePhone) {
		crumbs.push({ label: ROOT_LABEL, path: PHONE_ROOT });
		current = PHONE_ROOT;
		segments = clean.slice(PHONE_ROOT.length).split('/');
	} else {
		// A card some builds mount outside internal storage still gets a trail,
		// or the browser would show a path it cannot explain.
		crumbs.push({ label: 'Phone storage', path: '/' });
		segments = clean.split('/');
	}

	for (const segment of segments) {
		if (segment === '') continue;
		current = joinPath(current === '' ? '/' : current, segment);
		crumbs.push({ label: segment, path: current });
	}

	return crumbs;
}

/** Case-insensitive by name, with a stable fallback for names that differ only in case. */
function byName(a: BrowseEntry, b: BrowseEntry): number {
	const left = a.name.toLowerCase();
	const right = b.name.toLowerCase();
	if (left !== right) return left < right ? -1 : 1;
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Folders only, in the order a person scans a list. The input is not touched. */
export function dirEntries(entries: readonly BrowseEntry[]): BrowseEntry[] {
	return entries.filter((entry) => entry.kind === 'dir').sort(byName);
}

/** A path boundary, so `/sdcard/DCIM` is not read as living inside `/sdcard/DC`. */
export function isInside(child: string, parent: string): boolean {
	return parent === '/' ? child !== '/' : child.startsWith(`${parent}/`);
}

/**
 * Add one folder, or hand back the SAME array.
 *
 * Same array because "already covered" is a message, not a change: adding a
 * folder under an existing root copies nothing new, and adding a folder that
 * already contains one would replace a narrow choice with a broad one the
 * person did not ask for. Identity is the signal, so the caller never has to
 * re-derive the rule.
 */
export function addRoot(roots: string[], path: string): string[] {
	const clean = normalizePath(path);
	const covered = roots.some((root) => {
		const existing = normalizePath(root);
		return existing === clean || isInside(clean, existing) || isInside(existing, clean);
	});
	return covered ? roots : [...roots, clean];
}

/**
 * What adding `path` would do to the list, in one place.
 *
 * Four answers, and the last one is why this exists: picking `/sdcard/Download`
 * when `/sdcard/Download/Move` is configured is a person saying "all of it",
 * not a mistake. Refusing it dead-ends the dialog; offering the replacement
 * keeps the intent and says what changes.
 */
export type RootVerdict =
	| { kind: 'free' }
	| { kind: 'already' }
	| { kind: 'covered'; by: string }
	| { kind: 'replaces'; roots: string[] };

export function rootVerdict(roots: readonly string[], path: string): RootVerdict {
	const clean = normalizePath(path);
	if (roots.some((root) => normalizePath(root) === clean)) return { kind: 'already' };

	const wider = roots.find((root) => isInside(clean, normalizePath(root)));
	if (wider !== undefined) return { kind: 'covered', by: normalizePath(wider) };

	const narrower = roots.filter((root) => isInside(normalizePath(root), clean));
	if (narrower.length > 0) return { kind: 'replaces', roots: narrower };
	return { kind: 'free' };
}

/** Add `path`, dropping the narrower roots it already contains. */
export function replaceRoot(roots: string[], path: string): string[] {
	const clean = normalizePath(path);
	const kept = roots.filter((root) => {
		const existing = normalizePath(root);
		return existing !== clean && !isInside(existing, clean);
	});
	return [...kept, clean];
}

/** Remove one folder by the same spelling, keeping the order of the rest. */
export function removeRoot(roots: string[], path: string): string[] {
	const clean = normalizePath(path);
	const next = roots.filter((root) => normalizePath(root) !== clean);
	return next.length === roots.length ? roots : next;
}

/** A count for the list header: `no folders yet`, `1 folder`, `2 folders`. */
export function rootsSentence(roots: readonly string[]): string {
	return roots.length === 0 ? 'no folders yet' : plural(roots.length, 'folder');
}

/**
 * What the configured folders mean for the next pull, in one sentence.
 *
 * The empty case is the most important sentence in the app today: the engine
 * copies nothing without roots, so a run that "succeeds" would be a lie about
 * work that never started.
 */
export function describeConsequence(roots: readonly string[]): string {
	if (roots.length === 0) return 'With no folders, a pull copies nothing.';
	if (roots.length === 1) return 'A pull copies every file under this folder.';
	return `A pull copies every file under these ${roots.length} folders.`;
}
