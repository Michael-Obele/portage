/**
 * An engine failure, as the three things an error band has to say: what
 * happened, what it means, what to do now.
 *
 * Deliberately import-free — the failure is recognised by its shape rather than
 * by `instanceof EngineFailure`, so this module stays pure and a test can drive
 * it with a plain object. `Error.message`, `kind`, `code` and `fix` are the four
 * fields `EngineFailure` carries; nothing else is read.
 */

export interface Band {
	/** The engine's own sentence, or the app's when there was no answer at all. */
	what: string;
	/** What that means for this screen. Written per screen, never generic. */
	means: string;
	/** The engine's own `fix` where it gave one. */
	todo: string;
	/** The engine's code, or `null`. Shown small, never alone. */
	code: number | null;
}

interface FailureLike {
	message: string;
	kind: string;
	fix: string;
	code: number;
}

function asFailure(error: unknown): FailureLike | null {
	if (typeof error !== "object" || error === null) return null;
	const record = error as Record<string, unknown>;
	const message = record["message"];
	if (typeof message !== "string") return null;
	return {
		message,
		kind: typeof record["kind"] === "string" ? record["kind"] : "engine",
		fix: typeof record["fix"] === "string" ? record["fix"] : "",
		code: typeof record["code"] === "number" ? record["code"] : 0,
	};
}

function meaningFor(kind: string, context: "plan" | "transfer"): string {
	const where = context === "plan" ? "the phone was never read" : "the run was not started";
	switch (kind) {
		case "timeout":
			return context === "plan"
				? "The engine did not answer in time. The phone walk may still be running, and nothing was copied."
				: "The engine did not answer in time. A request that arrives after the fact cannot change what has already happened.";
		case "offline":
			return `The engine is not running, so ${where}.`;
		case "protocol":
			return "The app and the engine disagree about the wire format, so their answers cannot be trusted.";
		default:
			return context === "plan"
				? "The engine refused the request. Nothing was copied and nothing on the phone changed."
				: "The engine refused the request. Nothing has been copied or deleted by it.";
	}
}

function todoFor(kind: string, fix: string, context: "plan" | "transfer"): string {
	if (fix.trim() !== "") return fix.trim();
	if (kind === "offline" || kind === "protocol") {
		return "Restart the engine, then try again.";
	}
	return context === "plan"
		? "Request the plan again. If it fails the same way, the reason is in Doctor."
		: "Try again once the engine is answering. Nothing was deleted, so nothing was lost.";
}

/** Build a band from anything a `send` rejected with. */
export function failureBand(error: unknown, context: "plan" | "transfer"): Band {
	const failure = asFailure(error);
	if (failure === null) {
		return {
			what:
				context === "plan"
					? "The plan request failed before the engine answered."
					: "The request failed before the engine answered.",
			means:
				context === "plan"
					? "The app could not get a plan, so what would be copied is unknown."
					: "The app could not reach the engine, so what the run is doing is unknown.",
			todo: "Restart the engine, then try again.",
			code: null,
		};
	}
	return {
		what: failure.message,
		means: meaningFor(failure.kind, context),
		todo: todoFor(failure.kind, failure.fix, context),
		code: failure.code === 0 ? null : failure.code,
	};
}
