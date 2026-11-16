/**
 * The acknowledgement in front of the first pull.
 *
 * A pull is the app's one irreversible promise: it copies, verifies, then
 * DELETES the phone copy. The Plan screen used to start that on a single click,
 * with the deletion stated only in a caption underneath the buttons — the
 * loudest button on the screen was the one whose least-evident consequence was
 * permanent. Purge and Duplicates already stand behind a typed word; the
 * operation that removes originals should not be the one exception.
 *
 * Asking every single time would be its own failure — a person who pulls weekly
 * learns to type the word without reading it, which is worse than not asking.
 * So: ask once, in full, and remember the answer. The store is the webview's
 * own; the engine never needs to know a UI preference, and a blocked store just
 * means the question is asked again rather than that the pull is blocked.
 */

/** The localStorage key. Exported so a test can assert the exact name. */
export const PULL_CONSENT_KEY = 'portage-pull-understood';

/** What the acknowledgement is written as. */
const REMEMBERED = 'yes';

/** The narrow slice of `Storage` this module needs, so a test can fake it. */
export interface ConsentStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** The webview's storage, or `null` when even reaching it throws. */
export function browserStore(): ConsentStore | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** Whether the person has already been shown what a pull does. */
export function consentGiven(store: ConsentStore | null): boolean {
	if (store === null) return false;
	try {
		return store.getItem(PULL_CONSENT_KEY) === REMEMBERED;
	} catch {
		return false;
	}
}

/**
 * Remember it. A store that refuses the write is not an error worth surfacing:
 * the consequence is only that the question is asked again next time.
 */
export function recordConsent(store: ConsentStore | null): void {
	if (store === null) return;
	try {
		store.setItem(PULL_CONSENT_KEY, REMEMBERED);
	} catch {
		/* blocked storage — ask again rather than block the pull */
	}
}
