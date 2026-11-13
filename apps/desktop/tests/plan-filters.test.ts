/**
 * The pull intent is the channel that carries a removal from Plan to Transfer.
 *
 * It travels in the URL, so this file pins the round trip: a file removed by
 * hand must still be excluded after a reload, and the key must be absent (not
 * an empty array) when nothing was removed.
 */
import { describe, expect, test } from 'bun:test';

import {
	emptyFilters,
	filtersFromIntent,
	intentFrom,
	intentToSearch,
	parseIntent,
	planArgs,
	pullStartArgs
} from '../src/lib/components/app/plan-filters.ts';

describe('the pull intent', () => {
	test('carries removals through the URL, exactly', () => {
		const intent = intentFrom(emptyFilters(), 'keep', [
			'/sdcard/Download/Move/a.mkv',
			'/sdcard/Download/Move/b.mkv'
		]);

		const back = parseIntent(intentToSearch(intent));

		expect(back?.exclude).toEqual(intent.exclude);
		expect(back?.mode).toBe('keep');
	});

	test('sends removals to both plan and pull.start', () => {
		const intent = intentFrom(emptyFilters(), 'delete-after-verify', ['/sdcard/x.mkv']);

		expect(planArgs(filtersFromIntent(intent), intent.exclude)).toEqual({
			exclude: ['/sdcard/x.mkv']
		});
		expect(pullStartArgs(intent)).toEqual({
			mode: 'delete-after-verify',
			exclude: ['/sdcard/x.mkv']
		});
	});

	test('omits the key entirely when nothing was removed', () => {
		const intent = intentFrom(emptyFilters(), 'keep');

		expect(planArgs(filtersFromIntent(intent), intent.exclude)).toEqual({});
		expect(pullStartArgs(intent)).toEqual({ mode: 'keep' });
		expect(intentToSearch(intent)).toBe('?mode=keep');
	});
});
