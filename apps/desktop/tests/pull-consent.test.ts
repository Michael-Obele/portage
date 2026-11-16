/**
 * The one-time acknowledgement in front of a pull.
 *
 * The rule these cases protect: a pull deletes the phone copy, so the first one
 * is explained — and the explanation is asked exactly once, because asking every
 * week trains the word out of a person's attention.
 */
import { describe, expect, test } from 'bun:test';

import {
	PULL_CONSENT_KEY,
	consentGiven,
	recordConsent,
	type ConsentStore
} from '../src/lib/components/app/pull-consent.ts';

function fakeStore(
	initial: Record<string, string> = {}
): ConsentStore & { data: Record<string, string> } {
	const data = { ...initial };
	return {
		data,
		getItem: (key) => (key in data ? (data[key] as string) : null),
		setItem: (key, value) => {
			data[key] = value;
		}
	};
}

describe('pull consent', () => {
	test('an untouched store has not been acknowledged', () => {
		expect(consentGiven(fakeStore())).toBe(false);
	});

	test('recording it makes the next pull skip the question', () => {
		const store = fakeStore();
		recordConsent(store);
		expect(store.data[PULL_CONSENT_KEY]).toBeDefined();
		expect(consentGiven(store)).toBe(true);
	});

	test('a missing store asks again rather than assuming consent', () => {
		expect(consentGiven(null)).toBe(false);
		expect(() => recordConsent(null)).not.toThrow();
	});

	test('a store that throws on read is treated as not acknowledged', () => {
		const hostile: ConsentStore = {
			getItem() {
				throw new Error('blocked');
			},
			setItem() {}
		};
		expect(consentGiven(hostile)).toBe(false);
	});

	test('a store that throws on write does not break the pull', () => {
		const hostile: ConsentStore = {
			getItem: () => null,
			setItem() {
				throw new Error('quota');
			}
		};
		expect(() => recordConsent(hostile)).not.toThrow();
	});
});
