/**
 * Fixture replay behind `EnginePort`, so every screen and every state can be
 * screenshotted with no engine, no phone and no drive.
 *
 * Selected by a query param — `/dev/kit?mock=run-failed` — which is the only
 * way in. Nothing here is random: the one source of variation is a seeded
 * generator, so two runs of the same scenario produce the same pixels.
 *
 * The fixtures use the repo's own example names (Frieren on a 2 TB drive,
 * `Pixel 10 Pro XL`, `/sdcard/Download/Anime`) rather than placeholder lorem,
 * because a screenshot with "file1.mkv" in it proves nothing about the layout.
 */
import {
	PROTOCOL_VERSION,
	type ArgsFor,
	type Candidate,
	type CommandType,
	type DeviceInfo,
	type DoctorFrame,
	type DupesFrame,
	type FileRow,
	type Frame,
	type Overall,
	type PlanResult,
	type PortageConfig,
	type PurgePlanFrame,
	type StateFrame,
	type Volume,
} from "./protocol.ts";
import {
	type EngineHandlers,
	type EnginePort,
	type EngineStatus,
	type EngineSubscriptions,
	type PickFolderOptions,
} from "./client.ts";

export type MockScenario =
	| "fresh"
	| "run"
	| "run-failed"
	| "plan"
	| "dupes"
	| "purge"
	| "doctor";

export const MOCK_PARAM = "mock";

export const MOCK_SCENARIOS: readonly MockScenario[] = [
	"fresh",
	"run",
	"run-failed",
	"plan",
	"dupes",
	"purge",
	"doctor",
];

/** The scenario named in a query string, or null when there is not one. */
export function readMockScenario(search: string): MockScenario | null {
	const params = new URLSearchParams(search);
	const wanted = params.get(MOCK_PARAM);
	if (wanted === null) return null;
	return (MOCK_SCENARIOS as readonly string[]).includes(wanted)
		? (wanted as MockScenario)
		: null;
}

/** A one-line description, for the banner the mock puts on screen. */
export function describeScenario(scenario: MockScenario): string {
	switch (scenario) {
		case "fresh":
			return "never configured";
		case "run":
			return "run in progress, one stalled file";
		case "run-failed":
			return "run with one failure";
		case "plan":
			return "plan with skipped rows";
		case "dupes":
			return "duplicate groups, one truncated file";
		case "purge":
			return "purge plan with an unproven row";
		case "doctor":
			return "doctor with one failing check";
	}
}

// --- the fixtures ------------------------------------------------------------

const SERIAL = "fakeserial";
const DEVICE_ID = "pixel-10-pro-xl";
const DRIVE = "/media/node/2TB";
const DEST_ROOT = `${DRIVE}/Videos/$Anime`;
const PHONE_ROOT = "/sdcard/Download/Anime";
const CONNECT_AT = Date.now();

export function mockConfig(): PortageConfig {
	return {
		dest_root: DEST_ROOT,
		roots: [PHONE_ROOT],
		quiet_seconds: 120,
		jobs: 3,
		verify: "standard",
		delete_source: "after-verify",
		space_headroom: 0.02,
		transport: "auto",
		resume_threshold: 0.76,
		forward_port: 8022,
		adb_path: "",
		theme: "auto",
		devices: {
			[DEVICE_ID]: { label: "Pixel 10 Pro XL", roots: [PHONE_ROOT], exclude: [] },
		},
	};
}

export function mockDevices(): DeviceInfo[] {
	return [
		{
			id: DEVICE_ID,
			serial: SERIAL,
			state: "device",
			model: "Pixel 10 Pro XL",
			android: "17",
			unauthorized: false,
		},
	];
}

export function mockVolumes(): Volume[] {
	return [
		{
			device: "/dev/sda1",
			label: "2TB",
			mountPoint: DRIVE,
			fsType: "ntfs3",
			driver: "ntfs3 (kernel)",
			totalBytes: 2_000_398_934_016,
			freeBytes: 611_486_875_648,
			removable: true,
			transport: "usb",
			readOnly: false,
			isPortageDrive: true,
		},
		{
			device: "/dev/sdb1",
			label: "OLD BACKUP",
			mountPoint: "/media/node/OLD BACKUP",
			fsType: "ntfs",
			driver: "ntfs-3g (FUSE)",
			totalBytes: 500_107_862_016,
			freeBytes: 12_884_901_888,
			removable: true,
			transport: "usb",
			readOnly: true,
			isPortageDrive: false,
		},
	];
}

function candidate(
	name: string,
	size: number,
	verdict: Candidate["verdict"],
	reason: string,
	relative = name,
): Candidate {
	return {
		deviceId: DEVICE_ID,
		deviceLabel: "Pixel 10 Pro XL",
		serial: SERIAL,
		srcPath: `${PHONE_ROOT}/${relative}`,
		root: PHONE_ROOT,
		relative,
		size,
		mtime: Math.floor(CONNECT_AT / 1000) - 86_400,
		verdict,
		reason,
	};
}

interface Episode {
	name: string;
	size: number;
}

/** Twelve real-looking episodes; sizes are the repo's own example figures. */
const EPISODES: Episode[] = [
	{ name: "[SubsPlease] Frieren - 01 (1080p) [F1A2B3C4].mkv", size: 412_000_000 },
	{ name: "[SubsPlease] Frieren - 02 (1080p) [A1B2C3D4].mkv", size: 398_000_000 },
	{ name: "[SubsPlease] Frieren - 03 (1080p) [B2C3D4E5].mkv", size: 421_000_000 },
	{ name: "[SubsPlease] Frieren - 04 (1080p) [C3D4E5F6].mkv", size: 405_000_000 },
	{ name: "[SubsPlease] Frieren - 05 (1080p) [D4E5F6A7].mkv", size: 433_000_000 },
	{ name: "[SubsPlease] Frieren - 06 (1080p) [E5F6A7B8].mkv", size: 410_000_000 },
	{ name: "[SubsPlease] Frieren - 07 (1080p) [F6A7B8C9].mkv", size: 418_000_000 },
	{ name: "[SubsPlease] Frieren - 08 (1080p) [A7B8C9D0].mkv", size: 402_000_000 },
	{ name: "[SubsPlease] Frieren - 09 (1080p) [B8C9D0E1].mkv", size: 427_000_000 },
	{ name: "[SubsPlease] Frieren - 10 (1080p) [C9D0E1F2].mkv", size: 414_000_000 },
	{ name: "[SubsPlease] Frieren - 11 (1080p) [D0E1F2A3].mkv", size: 409_000_000 },
	{ name: "[SubsPlease] Frieren - 12 (1080p) [E1F2A3B4].mkv", size: 436_000_000 },
];

function rowFor(episode: Episode, index: number): FileRow {
	const key = `${DEVICE_ID} ${PHONE_ROOT}/${episode.name} ${episode.size}`;
	return {
		key,
		srcPath: `${PHONE_ROOT}/${episode.name}`,
		destPath: `${DEST_ROOT}/Frieren/S01/${episode.name}`,
		size: episode.size,
		bytes: 0,
		state: "queued",
		reason: "",
		startedAt: null,
		lastProgressAt: CONNECT_AT,
		onDrive: index % 5 === 4,
	};
}

/** Ticks are 500 ms, so ~20 s of transfer, which is enough to watch. */
const TICK_MS = 500;
const TICKS_TO_COPY = 8;

export interface RunFixtureOptions {
	/** Index of the file that goes to 100 % and then stops for good. */
	stallIndex?: number;
	/** Index of the file that fails, and the engine's reason for it. */
	failIndex?: number;
	failReason?: string;
}

/** One deterministic snapshot of the run at `tick`. */
export function runStateFrame(tick: number, opts: RunFixtureOptions = {}): StateFrame {
	const rows = EPISODES.map((episode, index) => {
		const row = rowFor(episode, index);
		const start = index * 2;
		const end = start + TICKS_TO_COPY;
		if (tick < start) return row;

		row.startedAt = CONNECT_AT + start * TICK_MS;
		if (index === opts.stallIndex) {
			// Frozen 13 s ago, so the row reads "stalled 13 s" on every tick.
			row.state = "copying";
			row.bytes = Math.round(episode.size * 0.62);
			row.lastProgressAt = CONNECT_AT - 13_000;
			return row;
		}
		if (index === opts.failIndex && tick >= end) {
			row.state = "failed";
			row.reason = opts.failReason ?? "device offline mid-file";
			row.bytes = Math.round(episode.size * 0.41);
			row.lastProgressAt = CONNECT_AT + end * TICK_MS;
			return row;
		}
		if (tick >= end + 1) {
			row.state = "done";
			row.bytes = episode.size;
			row.lastProgressAt = CONNECT_AT + (end + 1) * TICK_MS;
			return row;
		}
		row.state = "copying";
		row.bytes = Math.round(episode.size * Math.min(1, (tick - start) / TICKS_TO_COPY));
		row.lastProgressAt = CONNECT_AT + tick * TICK_MS;
		return row;
	});

	const done = rows.filter((r) => r.state === "done");
	const failed = rows.filter((r) => r.state === "failed");
	const bytesDone = rows.reduce((sum, r) => sum + r.bytes, 0);
	const bytesTotal = EPISODES.reduce((sum, e) => sum + e.size, 0);
	const elapsedMs = tick * TICK_MS;
	const avgBps = elapsedMs > 0 ? (bytesDone / elapsedMs) * 1000 : 0;

	const overall: Overall = {
		bytesDone,
		bytesTotal,
		filesDone: done.length,
		filesTotal: EPISODES.length,
		failed: failed.length,
		skipped: 0,
		rateBps: tick === 0 ? 0 : 36_900_000,
		avgBps,
		smoothedBps: avgBps,
		// Null until the engine will vouch for it — and here it never quite does.
		etaSeconds: tick > 6 && avgBps > 0 ? Math.round((bytesTotal - bytesDone) / avgBps) : null,
		samples: tick,
		elapsedMs,
		jobs: 3,
		paused: false,
	};

	return {
		v: PROTOCOL_VERSION,
		type: "state",
		screen: "dashboard",
		rows,
		overall,
		devices: [
			{
				id: DEVICE_ID,
				model: "Pixel 10 Pro XL",
				android: "17",
				ready: true,
				linkMbps: 480,
				freeBytes: 41_246_720_000,
			},
		],
		notice: null,
	};
}

const SKIPPED: Array<{ name: string; size: number; verdict: Candidate["verdict"]; reason: string }> = [
	{
		name: "[SubsPlease] Frieren - 01 (1080p) [F1A2B3C4].mkv",
		size: 412_000_000,
		verdict: "already-on-drive",
		reason: "identical hash already in the journal",
	},
	{
		name: "[SubsPlease] Frieren - 02 (1080p) [A1B2C3D4].mkv",
		size: 398_000_000,
		verdict: "already-on-drive",
		reason: "same size and hash on the drive",
	},
	{
		name: "[SubsPlease] Frieren - 13 (1080p) [F2A3B4C5].mkv.part",
		size: 128_000_000,
		verdict: "in-flight",
		reason: "still downloading (.part)",
	},
	{
		name: ".nomedia",
		size: 0,
		verdict: "excluded",
		reason: "matched the exclude list",
	},
	{
		name: "[SubsPlease] Frieren - 03 (1080p) [B2C3D4E5].mkv",
		size: 421_000_000,
		verdict: "too-recent",
		reason: "modified 12 s ago; quiet window is 120 s",
	},
];

export function mockPlan(): PlanResult {
	const toTransfer = EPISODES.slice(2, 12).map((episode) => ({
		candidate: candidate(
			episode.name,
			episode.size,
			"new",
			"nothing on the drive matches",
			`Frieren/S01/${episode.name}`,
		),
		destPath: `${DEST_ROOT}/Frieren/S01/${episode.name}`,
		destNorm: `frieren/s01/${episode.name.toLowerCase()}`,
		matchesArchive: null,
		alreadyTransferred: false,
		bytes: episode.size,
	}));

	const skipped = SKIPPED.map((entry) => ({
		candidate: candidate(entry.name, entry.size, entry.verdict, entry.reason, entry.name),
		destPath: `${DEST_ROOT}/Frieren/S01/${entry.name}`,
		destNorm: `frieren/s01/${entry.name.toLowerCase()}`,
		matchesArchive:
			entry.verdict === "already-on-drive"
				? {
						path: `${DEST_ROOT}/Frieren/S01/${entry.name}`,
						size: entry.size,
						hash: "9f2c1a77b0e4d3c8a1f6be2094d7c3155ae8b642f0c93d1a",
						relation: "identical" as const,
						note: "identical copy already on the drive",
					}
				: null,
		alreadyTransferred: entry.verdict === "already-on-drive",
		skipReason: entry.reason,
		bytes: 0,
	}));

	const bytesTotal = toTransfer.reduce((sum, f) => sum + f.bytes, 0);
	const bytesSkipped = skipped.reduce((sum, f) => sum + f.candidate.size, 0);

	return {
		destRoot: DEST_ROOT,
		files: [...toTransfer, ...skipped],
		toTransfer,
		skipped,
		bytesTotal,
		bytesSkipped,
		fileCount: toTransfer.length + skipped.length,
		etaSeconds: 138,
		space: {
			ok: true,
			freeBytes: 611_486_875_648,
			totalBytes: 2_000_398_934_016,
			usedFraction: 0.31,
		},
		warnings: [],
	};
}

export function mockDupes(): DupesFrame {
	const base = `${DEST_ROOT}/Frieren/S01`;
	const group = (
		id: number,
		tier: 1 | 2,
		label: string,
		reason: string,
		members: Array<{ name: string; relative: string; size: number; keep: boolean; suspicious?: string }>,
	): DupesFrame["groups"][number] => ({
		id,
		tier,
		reason,
		label,
		reclaimableBytes: members.filter((m) => !m.keep).reduce((sum, m) => sum + m.size, 0),
		members: members.map((m, index) => ({
			key: `d${id}-${index}`,
			path: `${base}/${m.name}`,
			relative: m.relative,
			size: m.size,
			hash: m.suspicious ? null : "9f2c1a77b0e4d3c8a1f6be2094d7c3155ae8b642f0c93d1a",
			keep: m.keep,
			score: m.keep ? "1080p" : null,
			scoreReason: m.keep ? "highest resolution in the group" : null,
			suspicious: m.suspicious ?? null,
		})),
	});

	return {
		v: PROTOCOL_VERSION,
		type: "dupes",
		scanId: "scan-2026-11-08-01",
		groups: [
			group(1, 1, "Frieren - 01", "byte-identical", [
				{
					name: "[SubsPlease] Frieren - 01 (1080p) [F1A2B3C4].mkv",
					relative: "Frieren/S01/[SubsPlease] Frieren - 01 (1080p) [F1A2B3C4].mkv",
					size: 412_000_000,
					keep: true,
				},
				{
					name: "[SubsPlease] Frieren - 01 (1080p) [F1A2B3C4] (1).mkv",
					relative: "Frieren/S01/[SubsPlease] Frieren - 01 (1080p) [F1A2B3C4] (1).mkv",
					size: 412_000_000,
					keep: false,
				},
			]),
			group(2, 1, "Frieren - 04", "byte-identical", [
				{
					name: "[SubsPlease] Frieren - 04 (1080p) [C3D4E5F6].mkv",
					relative: "Frieren/S01/[SubsPlease] Frieren - 04 (1080p) [C3D4E5F6].mkv",
					size: 405_000_000,
					keep: true,
				},
				{
					name: "[SubsPlease] Frieren - 04 (1080p) [C3D4E5F6].mkv.part",
					relative: "Frieren/S01/[SubsPlease] Frieren - 04 (1080p) [C3D4E5F6].mkv.part",
					size: 118_000_000,
					keep: false,
					suspicious: "truncated",
				},
			]),
			group(3, 2, "Frieren - 07", "same episode, different release", [
				{
					name: "[SubsPlease] Frieren - 07 (1080p) [F6A7B8C9].mkv",
					relative: "Frieren/S01/[SubsPlease] Frieren - 07 (1080p) [F6A7B8C9].mkv",
					size: 418_000_000,
					keep: true,
				},
				{
					name: "[Erai-raws] Frieren - 07 [720p][Multiple Subtitle].mkv",
					relative: "Frieren/S01/[Erai-raws] Frieren - 07 [720p][Multiple Subtitle].mkv",
					size: 241_000_000,
					keep: false,
				},
			]),
		],
		tier1Count: 2,
		tier2Count: 1,
		reclaimableBytes: 1_176_000_000,
		scannedFiles: 3_412,
		scannedBytes: 1_402_000_000_000,
		truncated: [
			`${base}/[SubsPlease] Frieren - 04 (1080p) [C3D4E5F6].mkv.part`,
		],
		unparsed: [`${base}/Bonus/OST [FLAC].7z`, `${base}/Bonus/artwork.zip`],
	};
}

export function mockPurgePlan(): PurgePlanFrame {
	const base = `${PHONE_ROOT}/Frieren/S01`;
	return {
		v: PROTOCOL_VERSION,
		type: "purgePlan",
		planId: "purge-2026-11-08-01",
		eligible: [
			{
				key: "p0",
				deviceId: DEVICE_ID,
				serial: SERIAL,
				srcPath: `${base}/[SubsPlease] Frieren - 01 (1080p) [F1A2B3C4].mkv`,
				destPath: `${DEST_ROOT}/Frieren/S01/[SubsPlease] Frieren - 01 (1080p) [F1A2B3C4].mkv`,
				size: 412_000_000,
				proof: "journal-hash",
				hash: "9f2c1a77b0e4d3c8a1f6be2094d7c3155ae8b642f0c93d1a",
			},
			{
				key: "p1",
				deviceId: DEVICE_ID,
				serial: SERIAL,
				srcPath: `${base}/[SubsPlease] Frieren - 02 (1080p) [A1B2C3D4].mkv`,
				destPath: `${DEST_ROOT}/Frieren/S01/[SubsPlease] Frieren - 02 (1080p) [A1B2C3D4].mkv`,
				size: 398_000_000,
				proof: "recomputed-hash",
				hash: "3c8d1f0a92b47e65d4c1a8f30b7e29516dfa4c83b0e19a72",
			},
			{
				key: "p2",
				deviceId: DEVICE_ID,
				serial: SERIAL,
				srcPath: `${base}/[SubsPlease] Frieren - 03 (1080p) [B2C3D4E5].mkv`,
				destPath: `${DEST_ROOT}/Frieren/S01/[SubsPlease] Frieren - 03 (1080p) [B2C3D4E5].mkv`,
				size: 421_000_000,
				proof: "journal-hash",
				hash: "7a1e93b2c0d54f86e1a79c3b5d028f46b9e1c7a35d0f8426",
			},
		],
		refused: [
			{
				srcPath: `${base}/[SubsPlease] Frieren - 05 (1080p) [D4E5F6A7].mkv`,
				reason: "the drive copy has no recorded hash, and it has not been re-read",
			},
			{
				srcPath: `${base}/[SubsPlease] Frieren - 06 (1080p) [E5F6A7B8].mkv`,
				reason: "the drive copy is missing",
			},
		],
		bytesReclaimed: 1_231_000_000,
	};
}

export function mockDoctor(): DoctorFrame {
	return {
		v: PROTOCOL_VERSION,
		type: "doctor",
		ok: false,
		checks: [
			{ status: "ok", label: "adb", value: "Android Debug Bridge version 1.0.41", fix: null },
			{ status: "ok", label: "phone", value: "Pixel 10 Pro XL · Android 17 · authorized", fix: null },
			{
				status: "warn",
				label: "link speed",
				value: "480 Mb/s — USB 2",
				fix: "A USB 3 port and cable move about 10x the bytes. Not required.",
			},
			{ status: "ok", label: "drive filesystem", value: "ntfs3 (kernel) on /dev/sda1", fix: null },
			{ status: "ok", label: "drive writable", value: "yes", fix: null },
			{
				status: "ok",
				label: "free space",
				value: "569 GB free · 3.1 GB planned",
				fix: null,
			},
			{ status: "ok", label: "journal", value: "portage.db readable · 1 402 rows", fix: null },
			{ status: "ok", label: "phone free space", value: "38.4 GB free", fix: null },
			{
				status: "fail",
				label: "resume directory",
				value: "missing: /media/node/2TB/.portage/partial",
				fix: "mkdir -p '/media/node/2TB/.portage/partial'",
			},
		],
	};
}

function frame<T extends Frame["type"]>(type: T, payload: object): Frame {
	return { v: PROTOCOL_VERSION, type, ...payload } as Frame;
}

// --- the port ----------------------------------------------------------------

interface MockTimers {
	stop(): void;
}

class MockEngine implements EnginePort {
	readonly kind = "mock" as const;

	private handlers: EngineHandlers | null = null;
	private timers: MockTimers | null = null;
	private tick = 0;

	constructor(private readonly scenario: MockScenario) {}

	async connect(handlers: EngineHandlers): Promise<EngineSubscriptions> {
		this.handlers = handlers;
		// Deterministic order, delivered on the next tick so a caller can finish
		// mounting before the first frame lands.
		queueMicrotask(() => this.prelude());

		return {
			close: async () => {
				this.timers?.stop();
				this.timers = null;
				this.handlers = null;
			},
		};
	}

	async send<T extends CommandType, R = unknown>(
		type: T,
		_args?: ArgsFor<T>,
		_timeoutMs?: number,
	): Promise<R> {
		await Promise.resolve();
		return this.answerFor(type) as R;
	}

	async status(): Promise<EngineStatus> {
		// The real engine keeps the last frame of each type. This fixture used to
		// return an EMPTY `ready`, which overwrote a complete one in the app and
		// made every screen read `adbFound: undefined` as "nothing found".
		return { running: true, last: { ready: frame("ready", this.readyPayload()) } };
	}

	async restart(): Promise<void> {
		this.tick = 0;
		this.prelude();
	}

	async pickFolder(_options?: PickFolderOptions): Promise<string | null> {
		return `${DEST_ROOT}/Frieren`;
	}

	async revealPath(_path: string): Promise<void> {
		// Nothing to reveal in a fixture run.
	}

	private emit(value: Frame): void {
		this.handlers?.onFrame(value);
	}

	private answerFor(type: string): unknown {
		switch (type) {
			case "volumes.list":
				return mockVolumes();
			case "devices.list":
				return mockDevices();
			case "config.get":
				return {
					config: mockConfig(),
					origins: { jobs: "drive config", dest_root: "drive config" },
					sources: { userPath: "/home/node/.config/portage/config.toml", drivePath: `${DRIVE}/.portage/config.toml` },
				};
			case "scan":
				return { candidates: [], counts: {} };
			case "plan":
				return { plan: mockPlan() };
			case "dupes.scan":
				return mockDupes();
			case "purge.plan":
				return mockPurgePlan();
			case "doctor":
				return mockDoctor();
			case "status.get":
				return { archive: { files: 1_402, bytes: 1_402_000_000_000 }, counts: {}, pending: [], runs: [], recent: [] };
			case "pull.start":
				this.startRun();
				return { ok: true, runId: "run-2026-11-08-01" };
			case "pull.pause":
				return { ok: true, effect: "pausing between files" };
			case "pull.resume":
				return { ok: true, effect: "resumed" };
			case "pull.stop":
				return { ok: true, effect: "finishing the file in flight, then stopping" };
			case "shutdown":
				return {};
			default:
				return {};
		}
	}

	/** The `ready` payload, from the scenario. Used at connect and by `status`. */
	private readyPayload() {
		return {
			protocolVersion: PROTOCOL_VERSION,
			engineVersion: "0.1.0-mock",
			platform: "linux",
			adbFound: true,
			adbPath: "/usr/local/bin/adb",
			adbSource: "path" as const,
			destinationConfigured: this.scenario !== "fresh",
		};
	}

	private prelude(): void {
		const configured = this.scenario !== "fresh";

		this.emit(frame("ready", this.readyPayload()));

		if (!configured) return;

		this.emit(
			frame("config", {
				config: mockConfig(),
				origins: { jobs: "drive config" },
				sources: { userPath: "/home/node/.config/portage/config.toml", drivePath: `${DRIVE}/.portage/config.toml` },
			}),
		);
		this.emit(frame("devices", { devices: mockDevices() }));
		this.emit(frame("volumes", { volumes: mockVolumes() }));

		switch (this.scenario) {
			case "plan":
				this.emit(frame("plan", { plan: mockPlan() }));
				return;
			case "dupes":
				this.emit(frame("dupes", mockDupes()));
				return;
			case "purge":
				this.emit(frame("purgePlan", mockPurgePlan()));
				return;
			case "doctor":
				this.emit(frame("doctor", mockDoctor()));
				return;
			case "run":
			case "run-failed":
				this.startRun();
				return;
			default:
				return;
		}
	}

	private startRun(): void {
		this.timers?.stop();
		this.tick = 0;

		const opts: RunFixtureOptions =
			this.scenario === "run-failed"
				? { failIndex: 5, failReason: "device offline mid-file" }
				: { stallIndex: 3 };

		const push = (): void => {
			this.emit(runStateFrame(this.tick, opts));
			this.tick += 1;
		};
		push();

		const handle = setInterval(push, TICK_MS);
		this.timers = { stop: () => clearInterval(handle) };
	}
}

export function createMockEngine(scenario: MockScenario): EnginePort {
	return new MockEngine(scenario);
}
