/**
 * The drift sentence above the throughput chart.
 *
 * This exists because the chart used to restate the hero's instant and average
 * rate — from the LAST SAMPLE, which is up to a second older than the live
 * figure. Two different averages for the same run, 150 px apart, is a
 * contradiction a reader cannot resolve. What the chart can say that the hero
 * cannot is whether the rate is going the wrong way.
 */
import { describe, expect, test } from 'bun:test';

import { seriesDrift, type RateSample } from '../src/lib/components/app/transfer-series.ts';

function samples(averages: number[]): RateSample[] {
	return averages.map((average, index) => ({ t: index + 1, instant: average, average }));
}

describe('seriesDrift', () => {
	test('says so when there is nothing to compare', () => {
		expect(seriesDrift([])).toContain('Not enough samples');
		expect(seriesDrift(samples([10]))).toContain('Not enough samples');
	});

	test('finds a fall and names the size of it', () => {
		const sentence = seriesDrift(samples([100, 90, 50]));
		expect(sentence).toContain('Falling');
		expect(sentence).toContain('50 %');
	});

	test('finds a rise', () => {
		expect(seriesDrift(samples([50, 75, 100]))).toContain('Rising');
	});

	test('calls a small change steady rather than a trend', () => {
		expect(seriesDrift(samples([100, 101, 102]))).toContain('Steady');
	});

	test('ignores samples that have no average yet', () => {
		const series: RateSample[] = [
			{ t: 1, instant: null, average: null },
			{ t: 2, instant: 100, average: 100 },
			{ t: 3, instant: 50, average: 50 }
		];
		expect(seriesDrift(series)).toContain('Falling');
	});

	test('does not repeat the hero number when the first rate is unusable', () => {
		// The hero prints the live average; a fallback that printed it again is
		// exactly the duplication this function replaced.
		const sentence = seriesDrift(samples([0, 40, 80]));
		expect(sentence).not.toContain('80');
		expect(sentence).toContain('No starting rate');
	});
});
