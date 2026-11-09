/**
 * The engine transport. THE ONLY MODULE THAT IMPORTS `@tauri-apps/api` — the
 * mock, the state layer and every component talk to `EnginePort`, not to Tauri.
 *
 * Rust is a forwarder: one stdout line becomes an `engine://frame` event
 * verbatim, stderr becomes `engine://stderr`, the child ending becomes
 * `engine://exit`, and `engine_send` writes exactly one line to the child's
 * stdin. There is no request/response channel on the Rust side, so this module
 * owns the correlation: it stamps every command with an `id`, and the matching
 * `answer` frame settles the promise. A command whose answer never comes must
 * produce a sentence, not a spinner forever.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import {
	PROTOCOL_VERSION,
	type AnswerFrame,
	type ArgsFor,
	type CommandType,
	type Envelope,
	type EngineError,
	type Frame,
} from "./protocol.ts";

/** Event names, mirrored from `src-tauri/src/engine.rs`. */
export const EVENT_FRAME = "engine://frame";
export const EVENT_STDERR = "engine://stderr";
export const EVENT_EXIT = "engine://exit";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const SLOW_TIMEOUT_MS = 10 * 60_000;

/**
 * Commands that walk a phone or re-hash both sides. Thirty seconds is generous
 * for a config key and absurd for a scan of 3 000 files, so these get their own
 * budget rather than making every other request wait longer for a failure.
 */
export const SLOW_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>([
	"scan",
	"plan",
	"dupes.scan",
	"purge.plan",
	"doctor",
]);

export function defaultTimeout(type: CommandType): number {
	return SLOW_COMMANDS.has(type) ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/** Why a request did not come back, in a shape a screen can render. */
export type FailureKind = "timeout" | "engine" | "offline" | "protocol";

/**
 * A rejected request. It carries the engine's own three parts — what happened,
 * what it means, what to do — because that is what the error band renders.
 */
export class EngineFailure extends Error {
	readonly kind: FailureKind;
	readonly code: number;
	readonly fix: string;

	constructor(kind: FailureKind, message: string, code = 0, fix = "") {
		super(message);
		this.name = "EngineFailure";
		this.kind = kind;
		this.code = code;
		this.fix = fix;
	}
}

export interface EngineStatus {
	running: boolean;
	/** The last frame of each type, so a late-mounted window can catch up. */
	last: Record<string, unknown>;
}

export interface EngineHandlers {
	onFrame(frame: Frame): void;
	onStderr?(line: string): void;
	onExit?(code: number | null): void;
	/** A stdout line that was not a frame. Diagnostics, never a crash. */
	onMalformed?(line: string): void;
	/** The engine speaks a different protocol version than this app. */
	onProtocolMismatch?(found: number, expected: number): void;
}

export interface EngineSubscriptions {
	close(): Promise<void>;
}

export interface PickFolderOptions {
	title?: string;
	defaultPath?: string;
}

/**
 * The seam every screen uses. `client.ts` and `mock.ts` both satisfy it, so a
 * screenshot run can exercise every state with no engine and no phone.
 */
export interface EnginePort {
	readonly kind: "engine" | "mock";
	connect(handlers: EngineHandlers): Promise<EngineSubscriptions>;
	send<T extends CommandType, R = unknown>(
		type: T,
		args?: ArgsFor<T>,
		timeoutMs?: number,
	): Promise<R>;
	status(): Promise<EngineStatus>;
	restart(): Promise<void>;
	pickFolder(options?: PickFolderOptions): Promise<string | null>;
	revealPath(path: string): Promise<void>;
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: unknown): void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * True inside the Tauri window, false in a plain browser tab.
 *
 * The distinction matters because `http://localhost:5174` serves the UI with no
 * engine behind it. Every command path has to say that, or the person debugging
 * it sees a dead end.
 */
function inDesktopShell(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The one sentence a browser tab gets, from every entry point. */
function noShellFailure(): EngineFailure {
	return new EngineFailure(
		"offline",
		"This window is not running inside the desktop shell, so there is no engine to talk to.",
		0,
		"Open the app with `bun x tauri dev`, or add ?mock=<scenario> to the URL to view a fixture.",
	);
}

function failureFrom(error: EngineError | undefined): EngineFailure {
	if (!error) {
		return new EngineFailure(
			"engine",
			"The engine refused the command without saying why.",
			0,
			"Restart the engine, then try again.",
		);
	}
	return new EngineFailure("engine", error.message, error.code, error.fix);
}

class TauriEngine implements EnginePort {
	readonly kind = "engine" as const;

	private readonly pending = new Map<string, Pending>();
	private counter = 0;
	private handlers: EngineHandlers | null = null;
	private subscriptions: EngineSubscriptions | null = null;

	/**
	 * Register the three listeners. Idempotent on purpose: a second mount
	 * replaces the handler set rather than registering a duplicate listener,
	 * which would settle every answer twice.
	 */
	async connect(handlers: EngineHandlers): Promise<EngineSubscriptions> {
		this.handlers = handlers;
		if (this.subscriptions) return this.subscriptions;

		// Outside the Tauri shell there is no IPC bridge, and `listen()` fails
		// deep inside the API with `cannot read 'transformCallback'`. That is an
		// unreadable error for a state the app can name exactly, and it used to
		// leave the window on "starting" forever. Say what is true instead.
		if (!inDesktopShell()) throw noShellFailure();

		const unlisten: UnlistenFn[] = await Promise.all([
			listen<string>(EVENT_FRAME, (event) =>
				this.onFrameLine(String(event.payload), handlers),
			),
			listen<string>(EVENT_STDERR, (event) =>
				this.handlers?.onStderr?.(String(event.payload).trimEnd()),
			),
			listen<number | null>(EVENT_EXIT, (event) =>
				this.handlers?.onExit?.(event.payload ?? null),
			),
		]);

		const subscriptions: EngineSubscriptions = {
			close: async () => {
				for (const off of unlisten) off();
				this.subscriptions = null;
				this.failEverything(
					new EngineFailure(
						"offline",
						"The engine connection closed, so no request could finish.",
						0,
						"Restart the engine, then try again.",
					),
				);
			},
		};
		this.subscriptions = subscriptions;
		return subscriptions;
	}

	async send<T extends CommandType, R = unknown>(
		type: T,
		args?: ArgsFor<T>,
		timeoutMs?: number,
	): Promise<R> {
		const id = `req-${++this.counter}`;
		const ms = timeoutMs ?? defaultTimeout(type);
		const seconds = Math.round(ms / 1000);

		const answer = new Promise<R>((resolve, reject) => {
			const timer = setTimeout(() => {
				// Delete FIRST: a late answer must not resolve a request the
				// person has already been told failed.
				if (this.pending.delete(id)) {
					reject(
						new EngineFailure(
							"timeout",
							`The engine did not answer ${type} within ${seconds} s.`,
							0,
							"It may still be working. Check the phone is connected, then try again.",
						),
					);
				}
			}, ms);
			this.pending.set(id, {
				resolve: (value) => resolve(value as R),
				reject,
				timer,
			});
		});

		const envelope: Envelope =
			args === undefined
				? { v: PROTOCOL_VERSION, id, type }
				: { v: PROTOCOL_VERSION, id, type, args };

		try {
			await invoke("engine_send", { line: JSON.stringify(envelope) });
		} catch {
			const entry = this.pending.get(id);
			if (entry) {
				this.pending.delete(id);
				clearTimeout(entry.timer);
				entry.reject(
					new EngineFailure(
						"offline",
						`The engine is not running, so ${type} was not sent.`,
						0,
						"Use Restart engine, then try again.",
					),
				);
			}
		}

		return answer;
	}

	async status(): Promise<EngineStatus> {
		return invoke<EngineStatus>("engine_status");
	}

	async restart(): Promise<void> {
		// A browser tab has no `invoke` at all, so the raw failure here is
		// `cannot read properties of undefined`, which is what the person saw as
		// "the engine could not be restarted". Name the actual state instead.
		if (!inDesktopShell()) throw noShellFailure();
		try {
			await invoke("engine_restart");
		} catch (error) {
			// `engine_restart` rejects with the Rust side's own sentence, and that
			// sentence is the only place the reason exists: a sidecar that is not
			// there, a file busy because a rebuild replaced it, a shell that is
			// already shutting down. Replacing it with a generic message is how
			// "the engine could not be restarted" became a dead end.
			throw new EngineFailure(
				"offline",
				typeof error === "string" && error.trim().length > 0
					? error.trim()
					: "The shell refused to restart the engine.",
				0,
				"Rebuild the engine sidecar, then reopen Portage.",
			);
		}
	}

	async pickFolder(options: PickFolderOptions = {}): Promise<string | null> {
		if (!inDesktopShell()) throw noShellFailure();
		const picked = await open({
			directory: true,
			multiple: false,
			title: options.title ?? "Choose a folder",
			...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
		});
		return typeof picked === "string" ? picked : null;
	}

	async revealPath(path: string): Promise<void> {
		if (!inDesktopShell()) throw noShellFailure();
		await revealItemInDir(path);
	}

	private onFrameLine(raw: string, handlers: EngineHandlers): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			handlers.onMalformed?.(raw);
			return;
		}

		const frame = parsed as Frame;
		if (typeof frame?.type !== "string") {
			handlers.onMalformed?.(raw);
			return;
		}

		if (frame.v !== PROTOCOL_VERSION) {
			handlers.onProtocolMismatch?.(Number(frame.v), PROTOCOL_VERSION);
		}

		// Settle before delivering, so a throwing screen handler cannot leave a
		// request hanging.
		if (frame.type === "answer") this.settle(frame);
		handlers.onFrame(frame);
	}

	private settle(frame: AnswerFrame): void {
		const entry = this.pending.get(frame.id);
		if (!entry) return; // an answer to a request already timed out
		this.pending.delete(frame.id);
		clearTimeout(entry.timer);
		if (frame.ok) entry.resolve(frame.data);
		else entry.reject(failureFrom(frame.error));
	}

	private failEverything(error: EngineFailure): void {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}
}

export const engine: EnginePort = new TauriEngine();

/** A fresh client, for tests and for a second window. */
export function createEngineClient(): EnginePort {
	return new TauriEngine();
}
