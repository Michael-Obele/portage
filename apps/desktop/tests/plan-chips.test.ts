/**
 * The chip a plan row wears.
 *
 * A plan is a proposal: nothing on that screen has been queued, so the chip
 * must not say "queued". These cases exist so that verb cannot quietly come
 * back — it is the screen's whole honesty claim that every word on it is true
 * before the run starts.
 */
import { describe, expect, test } from 'bun:test';

import { chipFor } from '../src/lib/components/app/plan-filters.ts';

describe('chipFor', () => {
	test('a prospective file reads as a future action, not a queued one', () => {
		expect(chipFor('new', true)).toBe('will-copy');
	});

	test('a skipped verdict reads as skipped whatever its reason', () => {
		expect(chipFor('already-on-drive', false)).toBe('skipped');
		expect(chipFor('too-recent', false)).toBe('skipped');
		expect(chipFor('empty', false)).toBe('skipped');
	});

	test('an in-flight file is the only thing called copying', () => {
		expect(chipFor('in-flight', false)).toBe('copying');
	});

	test('a duplicate candidate keeps its own word', () => {
		expect(chipFor('duplicate-candidate', false)).toBe('duplicate');
	});
});
