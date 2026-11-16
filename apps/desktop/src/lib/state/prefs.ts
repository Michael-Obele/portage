/**
 * Where the app remembers what a person chose.
 *
 * The engine owns the library: the journal, the config, the run history. None of
 * that belongs here. What belongs here is the *shape of the next screen* — which
 * filter was in force, whether the drive-wide scan was selected, whether the
 * purge was re-reading both ends. Losing those on every tab switch was the bug
 * this module exists to fix, and losing them on a restart is the same bug with a
 * bigger blast radius.
 *
 * Why not the database:
 *
 *  - The engine's SQLite file is the LIBRARY. UI preferences are per-window, not
 *    per-drive, and writing them into the journal's database would mean the
 *    desktop app and the CLI disagreeing about what a config table is for.
 *  - `src/index` (the journal) is frozen by the project's own acceptance gate, so
 *    a new table there is not available anyway.
 *  - Tauri's own precedent is a small file: `tauri-plugin-window-state` persists
 *    window geometry to disk and never opens a database. `localStorage` is the
 *    same idea without a new dependency, and it is already how the theme and the
 *    UI scale are stored.
 *
 * Everything here is best-effort. A blocked or full store must never stop a
 * screen from working; it just means the choice is not remembered.
 */

/** The keys. Exported so a test can assert the exact names. */
export const PREF_KEYS = {
	/** `{ device, show, since }` — the Plan screen's filters. */
	planFilters: 'portage-plan-filters',
	/** `'configured' | 'drive'` — what a duplicate scan covers. */
	dupesScope: 'portage-dupes-scope',
	/** `boolean` — whether Purge re-reads both ends. */
	purgeVerify: 'portage-purge-verify',
	/** `'all' | 'problems'` — the Doctor's filter. */
	doctorFilter: 'portage-doctor-filter'
} as const;

/** The slice of `Storage` this module needs, so a test can fake it. */
export interface PrefStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** The webview's storage, or `null` when even reaching it throws. */
export function browserPrefs(): PrefStore | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/**
 * Read one preference, through a validator.
 *
 * The validator is the point: `localStorage` is shared with every past version
 * of the app, so a value written by an older build must be *rejected* rather
 * than trusted. A rejected value falls back to the default, which is always a
 * usable state — never an error.
 */
export function readPref<T>(
	store: PrefStore | null,
	key: string,
	validate: (value: unknown) => T | null,
	fallback: T
): T {
	if (store === null) return fallback;
	try {
		const raw = store.getItem(key);
		if (raw === null) return fallback;
		return validate(JSON.parse(raw)) ?? fallback;
	} catch {
		return fallback;
	}
}

/** Write one preference. A refused write leaves the screen working. */
export function writePref(store: PrefStore | null, key: string, value: unknown): void {
	if (store === null) return;
	try {
		store.setItem(key, JSON.stringify(value));
	} catch {
		/* blocked or full storage — the choice is not remembered, nothing breaks */
	}
}

// --- validators -------------------------------------------------------------
//
// Each one takes `unknown` and returns the value or `null`. They are deliberately
// narrow: a boolean is a boolean, a scope is one of two strings.

export function asBoolean(value: unknown): boolean | null {
	return typeof value === 'boolean' ? value : null;
}

export function asOneOf<T extends string>(allowed: readonly T[]) {
	return (value: unknown): T | null =>
		typeof value === 'string' && (allowed as readonly string[]).includes(value)
			? (value as T)
			: null;
}

/** `{ device: string, show: string, since: 'all'|'1d'|'7d'|'30d' }`, or `null`. */
export function asPlanFilters(value: unknown): {
	device: string;
	show: string;
	since: 'all' | '1d' | '7d' | '30d';
} | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	const device = record.device;
	const show = record.show;
	const since = record.since;
	if (typeof device !== 'string' || typeof show !== 'string') return null;
	if (since !== 'all' && since !== '1d' && since !== '7d' && since !== '30d') return null;
	return { device, show, since };
}
