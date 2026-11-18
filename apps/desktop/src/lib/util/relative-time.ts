/**
 * Relative time and calendar days, on `Intl` — no date library.
 *
 * `Intl.RelativeTimeFormat` is Baseline since 2020 and present in the shipped
 * WebKitGTK; date-fns/dayjs would still leave the wording ("left", "ago") to us.
 * The thresholds below are the only opinionated part, and they never overstate
 * elapsed time. See AGENTS.md.
 */
/** Noon-to-noon-ish boundaries, in milliseconds. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How a relative phrase is spelled. `long` is "5 minutes ago", `narrow` "5m ago". */
export type RelativeStyle = 'long' | 'short' | 'narrow';

const formatters = new Map<string, Intl.RelativeTimeFormat | null>();

function formatter(style: RelativeStyle, locale?: string): Intl.RelativeTimeFormat | null {
	if (typeof Intl.RelativeTimeFormat !== 'function') return null;
	const key = `${style}\u0000${locale ?? ''}`;
	const cached = formatters.get(key);
	if (cached !== undefined) return cached;
	const made = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style });
	formatters.set(key, made);
	return made;
}

/**
 * The unit a gap is best described in, and how many of it.
 *
 * The cutoffs are the interesting part, and they are chosen so a phrase never
 * claims MORE time than passed: 59 minutes stays "59 minutes ago" rather than
 * rounding up to an unhedged "1 hour ago", and 1 h 59 min stays "1 hour" for the
 * same reason. Sub-hour units round (a person does not want "43.7 minutes"),
 * larger ones floor.
 *
 * Anything within 36 hours is "yesterday"/"tomorrow" rather than "1 day ago",
 * because a person means the calendar, not a 24-hour count.
 */
function pick(diffMs: number): [Intl.RelativeTimeFormatUnit, number] {
	const magnitude = Math.abs(diffMs);
	const sign = diffMs < 0 ? -1 : 1;
	// A rounded zero would render as "now"/"in 0 seconds"; a real gap says 1.
	const atLeastOne = (value: number): number => (value === 0 ? sign : value);

	if (magnitude < 10_000) {
		// A clock that disagrees with itself by a couple of seconds is not news.
		// "in 5 seconds" is technically true and reads like a bug report.
		return ['second', 0];
	}
	if (magnitude < 45_000) return ['second', atLeastOne(Math.round(diffMs / 1000))];
	if (magnitude < HOUR) {
		// Clamped at 59 so "60 minutes ago" can never appear; 59.9 minutes reads
		// as 59, and a full hour takes the next branch.
		return ['minute', sign * Math.min(59, Math.max(1, Math.round(magnitude / MINUTE)))];
	}
	if (magnitude < 22 * HOUR) {
		return ['hour', sign * Math.max(1, Math.floor(magnitude / HOUR))];
	}
	if (magnitude < 36 * HOUR) return ['day', sign];
	if (magnitude < 26 * DAY) return ['day', atLeastOne(Math.round(diffMs / DAY))];
	if (magnitude < 45 * DAY) return ['month', sign];
	if (magnitude < 320 * DAY) return ['month', atLeastOne(Math.round(diffMs / (30 * DAY)))];
	return ['year', atLeastOne(Math.round(diffMs / (365 * DAY)))];
}

/**
 * `just now`, `5 minutes ago`, `yesterday`, `in 10 minutes`.
 *
 * One function for both directions on purpose: a timestamp slightly in the
 * future (clock skew between the engine and the window) must read as "in 2
 * minutes", not as "2 minutes ago".
 */
export function relativeTime(
	atMs: number,
	nowMs: number = Date.now(),
	options: { style?: RelativeStyle; locale?: string } = {}
): string {
	if (!Number.isFinite(atMs)) return '';
	const diff = atMs - nowMs;
	const [unit, value] = pick(diff);
	const formatterFor = formatter(options.style ?? 'long', options.locale);
	if (formatterFor === null) {
		// No Intl.RelativeTimeFormat: say the number rather than nothing.
		const seconds = Math.round(diff / 1000);
		return seconds < 0 ? `${-seconds}s ago` : `in ${seconds}s`;
	}
	return formatterFor.format(value, unit);
}

/**
 * The age of a PAST event, never negative.
 *
 * `now` is a ticking clock, so it can lag the instant it is describing by up to
 * one tick — which rendered a just-finished scan as "in 19 seconds".
 */
export function ageOf(
	atMs: number,
	nowMs: number,
	options: { style?: RelativeStyle; locale?: string } = {}
): string {
	return relativeTime(atMs, Math.max(nowMs, atMs), options);
}

/**
 * A local calendar day as `YYYY-MM-DD`.
 *
 * NOT `toISOString().slice(0, 10)`: that is the UTC day, and this machine runs
 * at UTC+1, so a file moved to the trash at 00:30 local was filed under
 * YESTERDAY. The trash folder is a date a person can recognise, so it has to be
 * the date on THEIR calendar.
 */
export function localDayKey(date: Date = new Date()): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * How old a `YYYY-MM-DD` folder is: `today`, `yesterday`, `3 days ago`.
 *
 * Parsed as LOCAL midnight, so "yesterday" means the day before on this
 * calendar. A key that is not a date is returned unchanged — a folder someone
 * renamed by hand should be shown, not silently dropped.
 */
export function dayAge(
	dayKey: string,
	nowMs: number = Date.now(),
	options: { style?: RelativeStyle; locale?: string } = {}
): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
	if (match === null) return dayKey;
	const [, year, month, day] = match as unknown as [string, string, string, string];
	const startOfDay = new Date(Number(year), Number(month) - 1, Number(day)).getTime();
	if (!Number.isFinite(startOfDay)) return dayKey;
	const today = new Date(nowMs);
	const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
	// Count CALENDAR days, not elapsed hours: 23:59 to 00:01 is "yesterday", not
	// "0 days ago".
	const days = Math.round((startOfDay - startOfToday) / DAY);
	if (days === 0) return 'today';
	return relativeTime(startOfDay, startOfToday, { style: options.style, locale: options.locale });
}
