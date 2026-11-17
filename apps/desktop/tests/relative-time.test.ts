/**
 * Relative time — the thresholds, pinned.
 *
 * The value of using `Intl.RelativeTimeFormat` is that the WORDS are not ours.
 * The value of this file is that the UNIT CHOICE is: 59 minutes must not read as
 * "1 hour", 30 hours must read as "yesterday", and a timestamp a minute in the
 * future must not read as "ago".
 *
 * The locale is pinned to `en` so the assertions are about the thresholds rather
 * than about whatever locale CI happens to run in.
 */
import { describe, expect, test } from 'bun:test';

import { dayAge, localDayKey, relativeTime } from '#lib/util/relative-time.ts';

const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const past = (ms: number): string => relativeTime(NOW - ms, NOW, { locale: 'en' });
const future = (ms: number): string => relativeTime(NOW + ms, NOW, { locale: 'en' });

describe('relativeTime', () => {
	test('the last few seconds are "now", not "0 seconds ago"', () => {
		expect(past(0)).toBe('now');
		expect(past(5 * SECOND)).toBe('now');
		expect(future(5 * SECOND)).toBe('now');
	});
	test('seconds, then minutes, at the 45-second boundary', () => {
		expect(past(30 * SECOND)).toBe('30 seconds ago');
		expect(past(44 * SECOND)).toBe('44 seconds ago');
		// 44.5 s and up rounds to a full minute, and says so.
		expect(past(46 * SECOND)).toBe('1 minute ago');
	});

	test('minutes stay minutes right up to the hour', () => {
		expect(past(5 * MINUTE)).toBe('5 minutes ago');
		expect(past(44 * MINUTE)).toBe('44 minutes ago');
		// 59 is still 59. Rounding it to an unhedged "1 hour ago" would claim
		// more time passed than did.
		expect(past(59 * MINUTE)).toBe('59 minutes ago');
	});

	test('an hour is an hour, and larger units never round up', () => {
		expect(past(60 * MINUTE)).toBe('1 hour ago');
		expect(past(90 * MINUTE)).toBe('1 hour ago');
		expect(past(3 * HOUR)).toBe('3 hours ago');
		expect(past(20 * HOUR)).toBe('20 hours ago');
	});

	test('a day and a half is "yesterday", because a person means the calendar', () => {
		expect(past(23 * HOUR)).toBe('yesterday');
		expect(past(30 * HOUR)).toBe('yesterday');
	});

	test('days, months and years after that', () => {
		expect(past(3 * DAY)).toBe('3 days ago');
		expect(past(40 * DAY)).toBe('last month');
		expect(past(400 * DAY)).toBe('last year');
	});

	test('the future reads as "in …", so clock skew cannot invert a claim', () => {
		expect(future(2 * MINUTE)).toBe('in 2 minutes');
		expect(future(10 * MINUTE)).toBe('in 10 minutes');
		expect(future(3 * DAY)).toBe('in 3 days');
	});

	test('the narrow style is what a dense row gets', () => {
		expect(relativeTime(NOW - 5 * MINUTE, NOW, { locale: 'en', style: 'narrow' })).toBe('5m ago');
		expect(relativeTime(NOW - 3 * HOUR, NOW, { locale: 'en', style: 'narrow' })).toBe('3h ago');
	});

	test('a non-finite timestamp renders nothing rather than "Invalid Date"', () => {
		expect(relativeTime(Number.NaN, NOW)).toBe('');
		expect(relativeTime(Number.POSITIVE_INFINITY, NOW)).toBe('');
	});
});

describe('localDayKey', () => {
	test('it is a YYYY-MM-DD key', () => {
		expect(localDayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
		expect(localDayKey(new Date(2026, 11, 31))).toBe('2026-12-31');
	});

	test('it uses the LOCAL calendar, not the UTC one', () => {
		// 00:30 on the 17th, local time. Any offset at all makes these differ, and
		// on this machine (UTC+1) the UTC key is the 16th — the trash folder bug.
		const moment = new Date(2026, 10, 17, 0, 30);
		const expected = [
			moment.getFullYear(),
			String(moment.getMonth() + 1).padStart(2, '0'),
			String(moment.getDate()).padStart(2, '0')
		].join('-');
		expect(localDayKey(moment)).toBe(expected);
		if (moment.getTimezoneOffset() !== 0) {
			expect(localDayKey(moment)).not.toBe(moment.toISOString().slice(0, 10));
		}
	});
});

describe('dayAge', () => {
	const today = new Date(2026, 10, 17, 12, 0, 0).getTime();

	test('today has a word, because "0 days ago" is not one', () => {
		expect(dayAge('2026-11-17', today, { locale: 'en' })).toBe('today');
	});

	test('the day before is yesterday, whatever the clock says', () => {
		expect(dayAge('2026-11-16', today, { locale: 'en' })).toBe('yesterday');
		// Counted by CALENDAR day: at 00:30 on the 17th the 16th is yesterday,
		// even though barely any time has passed.
		const justAfterMidnight = new Date(2026, 10, 17, 0, 30).getTime();
		expect(dayAge('2026-11-16', justAfterMidnight, { locale: 'en' })).toBe('yesterday');
	});

	test('older folders count calendar days', () => {
		expect(dayAge('2026-11-14', today, { locale: 'en' })).toBe('3 days ago');
		expect(dayAge('2026-10-18', today, { locale: 'en' })).toBe('last month');
	});

	test('a folder that is not a date is shown, not hidden', () => {
		expect(dayAge('hand-sorted', today)).toBe('hand-sorted');
		expect(dayAge('', today)).toBe('');
	});
});
