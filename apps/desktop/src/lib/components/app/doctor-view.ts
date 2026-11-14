/**
 * Doctor — the machine's report card, as values rather than pixels.
 *
 * The engine owns the checks and the wording: `doctor` forwards every prose line
 * it printed as a `log` frame and then one `doctor` frame carrying
 * `{ok, checks[]}`, where each check is `{status, label, value, fix}` and `fix`
 * is a copy-pasteable command or `null`.
 *
 * Two rules this module keeps:
 *
 *  - Severity is SLICED, never re-judged. The engine's `fail` is the only source
 *    of a failure, and a check the engine never ran cannot be shown as passing.
 *  - The default view puts problems first. A report is read to find what is
 *    wrong, and a wall of green is the fastest way to hide the one red line.
 */
import { plural } from '../../util/format.ts';
import type { DoctorCheck, DoctorFrame, DoctorStatus } from '../../engine/protocol.ts';

export type DoctorFilter = 'all' | 'problems';

/** Low sorts first. `ok` last: the answers come after the questions. */
const RANK: Record<DoctorStatus, number> = { fail: 0, warn: 1, info: 2, ok: 3 };

/** Problems in the sense the person means: anything asking for attention. */
export function isProblem(check: DoctorCheck): boolean {
	return check.status === 'fail' || check.status === 'warn';
}

export function problemCount(checks: readonly DoctorCheck[]): number {
	return checks.filter(isProblem).length;
}

/**
 * Everything the "Not OK" filter shows: anything that is not a pass, including
 * the rows the engine could not judge. The badge and the filtered list must
 * agree, or the badge is a number about nothing.
 */
export function notOkCount(checks: readonly DoctorCheck[]): number {
	return checks.filter((check) => check.status !== 'ok').length;
}

export function failureCount(checks: readonly DoctorCheck[]): number {
	return checks.filter((check) => check.status === 'fail').length;
}

export function passedCount(checks: readonly DoctorCheck[]): number {
	return checks.filter((check) => check.status === 'ok').length;
}

/**
 * The checks to render, most urgent first.
 *
 * `problems` keeps `info` too: an `info` row is the engine saying "I could not
 * judge this", and hiding it under a filter called "problems" would be a claim
 * the engine never made.
 */
export function visibleChecks(
	checks: readonly DoctorCheck[],
	filter: DoctorFilter
): DoctorCheck[] {
	const ordered = [...checks].sort((a, b) => RANK[a.status] - RANK[b.status]);
	if (filter === 'all') return ordered;
	return ordered.filter((check) => check.status !== 'ok');
}

export interface DoctorVerdict {
	word: string;
	detail: string;
}

/** One sentence for the header, derived from the checks and never from `ok`. */
export function doctorVerdict(frame: DoctorFrame | null): DoctorVerdict {
	if (frame === null) return { word: 'not run', detail: 'nothing has been checked yet' };
	// An empty check list is what the engine emits when the report could not be
	// read. Calling that "all 0 checks passed" is the one claim this screen must
	// never make.
	if (frame.checks.length === 0) {
		return {
			word: 'no report',
			detail: 'the engine answered, but this build can read none of its checks'
		};
	}
	const failed = failureCount(frame.checks);
	const problems = problemCount(frame.checks);
	const passed = passedCount(frame.checks);
	// `info` is the engine saying "I could not judge this". It is not a pass.
	const unmeasured = frame.checks.filter((check) => check.status === 'info').length;
	if (failed > 0) {
		return {
			word: 'needs attention',
			detail: `${failed} of ${frame.checks.length} checks failed`
		};
	}
	if (problems > 0) {
		return {
			word: 'worth a look',
			detail: `${problems} of ${frame.checks.length} checks raised something`
		};
	}
	if (unmeasured > 0) {
		return {
			word: 'all clear',
			detail: `${plural(passed, 'check')} passed · ${unmeasured} not measured`
		};
	}
	return { word: 'all clear', detail: `all ${frame.checks.length} checks passed` };
}

/** True when the row carries a fix worth showing at all. */
export function hasFix(check: DoctorCheck): boolean {
	return check.fix !== null && check.fix.trim() !== '';
}

/**
 * True when the fix is something to TYPE, rather than advice to read.
 *
 * The engine writes both: `mkdir -p '/media/node/2TB/.portage/partial'` and
 * "A USB 3 port and cable move about 10x the bytes. Not required." Both belong
 * on the screen, but only the first belongs behind a button called Copy — a
 * clipboard full of prose pasted into a shell is a worse outcome than no
 * button. Multi-line fixes are always treated as snippets.
 */
export function fixIsCommand(check: DoctorCheck): boolean {
	if (!hasFix(check) || check.fix === null) return false;
	const fix = check.fix.trim();
	if (fix.includes('\n')) return true;
	// A sentence, not an invocation.
	if (/\.\s*$/.test(fix)) return false;
	return COMMAND_WORDS.test(fix);
}

/**
 * The first word of a shell invocation this app would ever print. Deliberately
 * a whitelist: a false negative costs a copy button, and a false positive puts
 * advice on the clipboard dressed as a command.
 */
const COMMAND_WORDS =
	/(^|[\s'"(])(mkdir|cp|mv|rm|ln|chmod|chown|sudo|adb|bash|sh|zsh|export|apt|apt-get|pacman|dnf|yum|brew|mount|umount|systemctl|portage|xxhsum|fallocate|truncate|touch|stat|df|du|lsblk|blkid|findmnt|dosfsck|ntfsfix|udisksctl|pkexec|usbmuxd|udevadm)\b/;

/**
 * The engine's own `ok` can disagree with its own rows when a report could not
 * be read at all. Say so instead of showing a cheerful zero.
 */
export function unreadable(frame: DoctorFrame): boolean {
	return frame.checks.length === 0;
}
