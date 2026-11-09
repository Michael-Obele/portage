/**
 * What the engine is: connection, the `ready` payload, config with its
 * per-key source, devices, volumes, notices and theme.
 *
 * Thin on purpose. Every number about a transfer lives in `run.svelte.ts`; this
 * module holds the things that exist whether or not a run is in flight, and it
 * is the only place the port is chosen (real engine or fixture replay).
 */
import { browser } from "$app/env";

import {
	EngineFailure,
	type EnginePort,
	type EngineStatus,
	type EngineSubscriptions,
	type PickFolderOptions,
} from "../engine/client.ts";
import { engine as realEngine } from "../engine/client.ts";
import {
	createMockEngine,
	describeScenario,
	readMockScenario,
	type MockScenario,
} from "../engine/mock.ts";
import type {
	DeviceInfo,
	Frame,
	NoticeLevel,
	PortageConfig,
	ReadyFrame,
	Volume,
} from "../engine/protocol.ts";

export type ConnectionStatus =
	| "connecting"
	| "connected"
	| "stopped"
	| "restarting"
	| "mock";

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "portage-theme";

/**
 * The sizes Appearance offers.
 *
 * The whole app is laid out in rem: the type tokens, the row heights, the
 * radii and every Tailwind spacing step. So one multiplier on the root font
 * size scales all of it together, and there is no second place to keep in
 * step. 200 % is the top of the range because `design.md` requires the app to
 * stay usable there; 90 % exists for a small screen.
 */
export const UI_SCALES = [0.9, 1, 1.15, 1.3, 1.5, 1.75, 2] as const;
export type UiScale = (typeof UI_SCALES)[number];
export const UI_SCALE_STORAGE_KEY = "portage-ui-scale";

/** A label for a size button: 1 → "100%", 1.15 → "115%". */
export function scalePercent(scale: number): string {
	return `${Math.round(scale * 100)}%`;
}

export interface NoticeAction {
	label: string;
	run(): void;
}

export interface Notice {
	id: number;
	level: NoticeLevel;
	message: string;
	/** One action, at most. A toast with two choices is a dialog. */
	action?: NoticeAction;
}

/** The shell shows three at a time; a fourth pushes the oldest out. */
export const MAX_NOTICES = 3;

/** Frames a late-mounted window replays, in the order that keeps them coherent. */
const HYDRATION_ORDER: readonly string[] = [
	"ready",
	"config",
	"devices",
	"volumes",
	"scan",
	"plan",
	"state",
	"run",
	"dupes",
	"purgePlan",
	"doctor",
	"status",
	"browse",
];

function readStoredTheme(): ThemeChoice {
	if (!browser) return "system";
	try {
		const stored = localStorage.getItem(THEME_STORAGE_KEY);
		return stored === "light" || stored === "dark" || stored === "system"
			? stored
			: "system";
	} catch {
		return "system";
	}
}

/** Anything that is not one of the offered steps falls back to 100 %. */
function readStoredScale(): UiScale {
	if (!browser) return 1;
	try {
		const stored = Number(localStorage.getItem(UI_SCALE_STORAGE_KEY));
		return UI_SCALES.find((step) => step === stored) ?? 1;
	} catch {
		return 1;
	}
}

class AppState {
	connection = $state<ConnectionStatus>("connecting");
	ready = $state<Omit<ReadyFrame, "v" | "type"> | null>(null);
	config = $state<PortageConfig | null>(null);
	/** Which layer won per config key: flag, env, drive, user or default. */
	origins = $state<Record<string, string>>({});
	userConfigPath = $state<string | null>(null);
	driveConfigPath = $state<string | null>(null);
	devices = $state<DeviceInfo[]>([]);
	volumes = $state<Volume[]>([]);
	notices = $state<Notice[]>([]);
	theme = $state<ThemeChoice>("system");
	/** Root font size multiplier; everything in the app is rem, so this is the size control. */
	uiScale = $state<UiScale>(1);
	/** The engine speaks a version this app does not. Fatal, and shown. */
	protocolMismatch = $state<number | null>(null);
	/** The last few stderr lines, so the banner can name the real reason. */
	stderrTail = $state<string[]>([]);
	/** Groups in the last duplicate scan. Drives the rail's count badge. */
	dupesGroups = $state(0);

	/** Non-null when the fixtures are driving instead of an engine. */
	mock = $state<MockScenario | null>(null);
	/** True when the engine answered `engine_status` at least once. */
	reachable = $state(false);

	#port: EnginePort = realEngine;
	#subscriptions: EngineSubscriptions | null = null;
	#observers: Array<(frame: Frame) => void> = [];
	#noticeId = 0;

	get port(): EnginePort {
		return this.#port;
	}

	/** `mock` when a fixture is driving, so the shell can say so plainly. */
	get usingMock(): boolean {
		return this.mock !== null;
	}

	/** True when there is nowhere to pull to yet. */
	get needsSetup(): boolean {
		return this.ready !== null && !this.ready.destinationConfigured;
	}

	// --- lifecycle -----------------------------------------------------------

	/**
	 * Choose the port, connect, and catch up on frames emitted before this
	 * window mounted. `search` is passed in rather than read from `location`, so
	 * this module stays callable from anywhere.
	 */
	async start(search = ""): Promise<void> {
		const scenario = browser ? readMockScenario(search) : null;
		if (scenario) {
			this.mock = scenario;
			this.#port = createMockEngine(scenario);
			this.connection = "mock";
			this.pushNotice("info", `Fixture: ${describeScenario(scenario)}. No engine is running.`);
		} else {
			this.#port = realEngine;
			this.connection = "connecting";
		}

		this.theme = readStoredTheme();
		this.uiScale = readStoredScale();
		this.applyTheme();
		this.applyUiScale();

		try {
			this.#subscriptions = await this.#port.connect({
				onFrame: (frame) => this.#dispatch(frame),
				onStderr: (line) => this.#noteStderr(line),
				onExit: (code) => this.#onExit(code),
				onProtocolMismatch: (found) => {
					this.protocolMismatch = found;
				},
			});
		} catch (error) {
			// A failed connect is a state, not a crash: without this the window
			// sat on "starting" forever and the reason never reached the screen.
			this.connection = this.mock ? "mock" : "stopped";
			this.reachable = false;
			this.pushNotice(
				"error",
				error instanceof EngineFailure ? error.message : "The engine could not be reached.",
				error instanceof EngineFailure && error.fix
					? { label: "Restart engine", run: () => void this.restartEngine() }
					: undefined,
			);
			return;
		}

		await this.hydrate();
	}

	/** Unregister the three listeners. Called from the shell's `$effect` cleanup. */
	async stop(): Promise<void> {
		const subscriptions = this.#subscriptions;
		this.#subscriptions = null;
		if (subscriptions) await subscriptions.close();
		this.connection = "stopped";
	}

	private async hydrate(): Promise<void> {
		let status: EngineStatus;
		try {
			status = await this.#port.status();
			this.reachable = true;
		} catch {
			this.reachable = false;
			this.connection = this.mock ? "mock" : "stopped";
			return;
		}

		if (status.running && this.connection !== "mock") this.connection = "connected";

		for (const type of HYDRATION_ORDER) {
			const last = status.last[type];
			if (last && typeof last === "object" && "type" in last) {
				this.applyFrame(last as Frame);
			}
		}
	}

	// --- frames --------------------------------------------------------------

	applyFrame(frame: Frame): void {
		switch (frame.type) {
			case "ready": {
				this.ready = {
					protocolVersion: frame.protocolVersion,
					engineVersion: frame.engineVersion,
					platform: frame.platform,
					adbFound: frame.adbFound,
					adbPath: frame.adbPath ?? null,
					adbSource: frame.adbSource ?? "none",
					destinationConfigured: frame.destinationConfigured,
				};
				if (this.connection !== "mock" && frame.protocolVersion !== undefined) {
					this.connection = "connected";
				}
				// A sidecar left over from an older build speaks an older version,
				// and one from before `serve` existed cannot even say `ready`. The
				// version is the cheapest tell, and saying it out loud is the
				// difference between "the engine is broken" and "rebuild it".
				if (this.mock === null && frame.engineVersion !== __APP_VERSION__) {
					this.pushNotice(
						"warn",
						`The engine is version ${frame.engineVersion} but this app is ${__APP_VERSION__}. Rebuild the sidecar so both halves match.`,
					);
				}
				return;
			}
			case "config": {
				this.config = frame.config;
				this.origins = frame.origins;
				this.userConfigPath = frame.sources.userPath;
				this.driveConfigPath = frame.sources.drivePath;
				return;
			}
			case "devices": {
				this.devices = frame.devices;
				return;
			}
			case "volumes": {
				this.volumes = frame.volumes;
				return;
			}
			case "notice": {
				this.pushNotice(frame.level, frame.message);
				return;
			}
			case "dupes": {
				this.dupesGroups = frame.groups.length;
				return;
			}
			default:
				return;
		}
	}

	/**
	 * Watch every frame alongside this module's own handling. The run store
	 * subscribes here rather than opening a second connection, so one window has
	 * exactly one set of Tauri listeners. Returns the unsubscribe.
	 */
	observeFrame(observer: (frame: Frame) => void): () => void {
		this.#observers = [...this.#observers, observer];
		return () => {
			this.#observers = this.#observers.filter((entry) => entry !== observer);
		};
	}

	#dispatch(frame: Frame): void {
		this.applyFrame(frame);
		for (const observer of this.#observers) observer(frame);
	}

	#noteStderr(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		this.stderrTail = [...this.stderrTail.slice(-4), trimmed];
	}

	#onExit(code: number | null): void {
		if (this.mock) return;
		this.connection = "stopped";
		this.reachable = false;
		this.pushNotice(
			"error",
			code === null
				? "The engine stopped."
				: `The engine stopped with exit code ${code}.`,
		);
	}

	// --- notices -------------------------------------------------------------

	pushNotice(level: NoticeLevel, message: string, action?: NoticeAction): void {
		const notice: Notice = action
			? { id: ++this.#noticeId, level, message, action }
			: { id: ++this.#noticeId, level, message };
		this.notices = [...this.notices, notice].slice(-MAX_NOTICES);
	}

	dismissNotice(id: number): void {
		this.notices = this.notices.filter((notice) => notice.id !== id);
	}

	// --- theme ---------------------------------------------------------------

	setTheme(choice: ThemeChoice): void {
		this.theme = choice;
		try {
			localStorage.setItem(THEME_STORAGE_KEY, choice);
		} catch {
			// A blocked localStorage must not stop the theme changing now.
		}
		this.applyTheme();
	}

	applyTheme(): void {
		if (!browser) return;
		const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
		const dark = this.theme === "dark" || (this.theme === "system" && prefersDark);
		document.documentElement.classList.toggle("dark", dark);
	}

	// --- size ----------------------------------------------------------------

	/**
	 * Set the multiplier and remember it.
	 *
	 * This is a property of this window, not of a drive, so it lives in
	 * localStorage beside the theme rather than in the engine's config. The
	 * engine never needs to know how big the text is.
	 */
	setUiScale(scale: UiScale): void {
		this.uiScale = scale;
		try {
			localStorage.setItem(UI_SCALE_STORAGE_KEY, String(scale));
		} catch {
			// A blocked localStorage must not stop the size changing now.
		}
		this.applyUiScale();
	}

	/** One step larger or smaller, clamped at both ends. For Ctrl + and Ctrl -. */
	nudgeScale(direction: 1 | -1): void {
		const index = UI_SCALES.indexOf(this.uiScale);
		const next = UI_SCALES.at(
			Math.min(UI_SCALES.length - 1, Math.max(0, index + direction)),
		);
		if (next !== undefined && next !== this.uiScale) this.setUiScale(next);
	}

	applyUiScale(): void {
		if (!browser) return;
		document.documentElement.style.setProperty("--ui-scale", String(this.uiScale));
	}

	// --- actions -------------------------------------------------------------

	/**
	 * Ask for the mounted volumes.
	 *
	 * The answer carries only a count: the volumes themselves arrive as a
	 * `volumes` frame, which `applyFrame` stores. Returning the FRAME's data as
	 * the list (as this used to) put `{count: 2}` into `app.volumes` and the list
	 * rendered nothing, which is exactly the kind of lie a typed generic hides.
	 */
	async loadVolumes(): Promise<Volume[]> {
		await this.#port.send("volumes.list");
		return this.volumes;
	}

	/** Same contract as `loadVolumes`: the `devices` frame carries the rows. */
	async loadDevices(): Promise<DeviceInfo[]> {
		await this.#port.send("devices.list");
		return this.devices;
	}

	/**
	 * Replace one phone's source roots, keeping the rest of its block.
	 *
	 * The engine writes the config file; the app never touches it. `config.set`
	 * takes the whole `devices` table, so the current one is read back and only
	 * this device's key is replaced.
	 */
	async setDeviceRoots(deviceId: string, roots: string[]): Promise<void> {
		const current = this.config?.devices ?? {};
		const existing = current[deviceId];
		const next = {
			...current,
			[deviceId]: {
				...existing,
				label: existing?.label ?? "",
				roots,
				exclude: existing?.exclude ?? [],
			},
		};
		await this.setConfig("devices", next);
	}

	async loadConfig(): Promise<PortageConfig | null> {
		const payload = await this.#port.send<
			"config.get",
			{
				config: PortageConfig;
				origins: Record<string, string>;
				sources: { userPath: string; drivePath: string | null };
			}
		>("config.get");
		this.config = payload.config;
		this.origins = payload.origins;
		this.userConfigPath = payload.sources.userPath;
		this.driveConfigPath = payload.sources.drivePath;
		return payload.config;
	}

	/** Set one key. The engine owns the file; the app never writes it. */
	async setConfig(key: string, value: unknown): Promise<void> {
		await this.#port.send("config.set", { key, value });
		await this.loadConfig();
	}

	async restartEngine(): Promise<void> {
		this.connection = "restarting";
		try {
			await this.#port.restart();
		} catch (error) {
			this.#onRestartFailure(error);
			return;
		}
		// Give the child a moment to write `ready`, then re-read the buffer.
		await new Promise((resolve) => setTimeout(resolve, 500));
		await this.hydrate();
	}

	async pickFolder(options?: PickFolderOptions): Promise<string | null> {
		return this.#port.pickFolder(options);
	}

	async revealPath(path: string): Promise<void> {
		await this.#port.revealPath(path);
	}

	#onRestartFailure(error: unknown): void {
		this.connection = "stopped";
		// Every error carries a reason. Dropping a plain `Error` (or a rejected
		// string from Tauri) in favour of a fixed sentence leaves the person with
		// nothing to act on, which is what "could not be restarted" was.
		const message =
			error instanceof Error && error.message.length > 0
				? error.message
				: "The engine could not be restarted.";
		this.pushNotice("error", message);
		if (error instanceof EngineFailure && error.fix.length > 0) {
			this.pushNotice("info", error.fix);
		}
	}
}

export const app = new AppState();
