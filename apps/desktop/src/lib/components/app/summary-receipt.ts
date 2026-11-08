/**
 * The run summary's numbers and its CLI text — pure, so the screen only
 * arranges them.
 *
 * Every figure comes out of the engine's own `EngineSummary`; none of them is
 * the UI's clock. Where two engine numbers are combined (`transferred + failed`
 * for the "20 of 23" headline) the combination is arithmetic on values the
 * engine sent, and the sentence says which two.
 */
import type { DeviceInfo, EngineSummary } from "../../engine/protocol.ts";
import { DASH, formatBytes, formatDuration, formatRate, plural } from "../../util/format.ts";
import { baseName } from "./plan-filters.ts";

export interface ReceiptHeadline {
	/** "23 files" or "20 of 23 files" — never a number the engine did not send. */
	files: string;
	bytes: string;
	duration: string;
	rate: string;
	/** The whole line, in the shape `screens.md` fixes. */
	sentence: string;
}

/**
 * The headline.
 *
 * `transferred + failed` is the number of files the run attempted, which is the
 * only denominator that makes "20 of 23" mean something. When nothing failed
 * there is no ratio to state and the headline is a plain count.
 */
export function receiptHeadline(summary: EngineSummary): ReceiptHeadline {
	const attempted = summary.transferred + summary.failed;
	const files =
		summary.failed > 0
			? `${summary.transferred} of ${attempted} files`
			: plural(summary.transferred, "file");
	const bytes = formatBytes(summary.bytesMoved);
	const duration = formatDuration(summary.durationMs / 1000);
	const rate = formatRate(summary.rateBps);
	return {
		files,
		bytes,
		duration,
		rate,
		sentence: `${files} · ${bytes} · ${duration} · ${rate} average`,
	};
}

export interface ReceiptFailure {
	key: string;
	srcPath: string;
	name: string;
	reason: string;
	/** The exact command line to run in a terminal. Never a fake Retry button. */
	command: string;
}

/**
 * Quote one argument for a shell.
 *
 * Release names carry spaces and square brackets, so an unquoted `--show` value
 * pastes into a terminal as four arguments and a glob. Single quotes make the
 * whole name one argument; an embedded single quote is closed, escaped and
 * reopened the usual way.
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The device a retry command should name.
 *
 * The run summary carries no device id, so the id comes from the devices the
 * engine last listed — and only when exactly one is ready. With none, or with
 * several, the command carries a visible `<id>` placeholder rather than a
 * guess: a command that runs against the wrong phone is worse than one that
 * does not run.
 */
export function retryDeviceId(devices: DeviceInfo[]): string | null {
	const ready = devices.filter((device) => device.state === "device");
	return ready.length === 1 ? (ready[0] as DeviceInfo).id : null;
}

/**
 * The command that retries one failed file.
 *
 * `portage retry` is not built (see G7 in the plan), so the app does not
 * pretend to retry. It hands over the command instead.
 */
export function retryCommand(
	failure: { srcPath: string },
	deviceId: string | null,
): string {
	const device = deviceId ?? "<id>";
	return `portage pull --device ${device} --show ${shellQuote(baseName(failure.srcPath))}`;
}

export function receiptFailures(
	summary: EngineSummary,
	deviceId: string | null,
): ReceiptFailure[] {
	return summary.failures.map((failure) => ({
		key: failure.srcPath,
		srcPath: failure.srcPath,
		name: baseName(failure.srcPath),
		// The engine's sentence, verbatim. An empty one is rendered as "no reason
		// given" by the screen, never filled in here.
		reason: failure.reason.trim(),
		command: retryCommand(failure, deviceId),
	}));
}

/** The proof row: five counters, all of them the engine's own fields. */
export interface ProofLine {
	verified: number;
	deleted: number;
	kept: number;
	failed: number;
	skipped: number;
}

export function proofLine(summary: EngineSummary): ProofLine {
	return {
		verified: summary.verified,
		deleted: summary.deleted,
		kept: summary.kept,
		failed: summary.failed,
		skipped: summary.skipped,
	};
}

/** True when the run had nothing to move at all. */
export function nothingMoved(summary: EngineSummary): boolean {
	return summary.transferred === 0 && summary.bytesMoved === 0;
}

/** One sentence naming what the proof counters do and do not establish. */
export function proofSentence(summary: EngineSummary): string {
	if (summary.deleted > 0) {
		return `${plural(summary.deleted, "phone copy", "phone copies")} deleted after the drive copy was verified.`;
	}
	if (summary.kept > 0 && summary.verified > 0) {
		return `Nothing was deleted from the phone: this run was copy-only, so ${plural(summary.kept, "phone copy", "phone copies")} stay where they are.`;
	}
	if (summary.verified > 0) {
		return `Nothing was deleted from the phone. The ${plural(summary.verified, "verified copy", "verified copies")} are on the drive.`;
	}
	return "Nothing was verified, so nothing was deleted.";
}
