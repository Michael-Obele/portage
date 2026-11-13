/**
 * The wire protocol, MIRRORED BY HAND from `src/serve/protocol.ts` in the repo
 * root.
 *
 * Deliberately hand-written: the engine is a separate Bun binary the app spawns
 * at runtime, not an import, so there is no shared package to keep the two in
 * step. A frame field that changes in `src/serve/protocol.ts` changes here in
 * the same commit. Nothing in this file prints; stdout is the wire.
 *
 * Rule from `architecture.md` that is load-bearing here too: `v` is the
 * protocol version, and two different versions must not be papered over.
 */

export const PROTOCOL_VERSION = 1;

// --- engine objects the payloads carry ---------------------------------------
//
// These mirror `src/config/schema.ts`, `src/device/*.ts`, `src/index/journal.ts`,
// `src/plan/plan.ts`, `src/scan/scan.ts`, `src/xfer/*.ts` and
// `src/tui/state.svelte.ts`. They are the ENGINE'S shapes; the app copies them
// so a payload can be typed without importing the engine's runtime.

export type DeleteSource = 'after-verify' | 'never' | 'prompt';
export type VerifyMode = 'standard' | 'paranoid';
export type TransportChoice = 'auto' | 'adb' | 'rsync';

export interface DeviceConfig {
	label: string;
	roots: string[];
	jobs?: number | undefined;
	exclude: string[];
}

export interface PortageConfig {
	dest_root: string;
	roots: string[];
	quiet_seconds: number;
	jobs: number;
	verify: VerifyMode;
	delete_source: DeleteSource;
	space_headroom: number;
	transport: TransportChoice;
	resume_threshold: number;
	forward_port: number;
	adb_path: string;
	theme: string;
	devices: Record<string, DeviceConfig>;
}

export type ConfigKey = keyof Omit<PortageConfig, 'devices'> | 'devices';

export type DeviceState = 'device' | 'offline' | 'unauthorized' | 'unknown';

export interface DeviceInfo {
	id: string;
	serial: string;
	state: DeviceState;
	model: string;
	android: string;
	unauthorized: boolean;
}

export interface Volume {
	device: string;
	label: string | null;
	mountPoint: string;
	fsType: string;
	driver: string;
	totalBytes: number;
	freeBytes: number;
	removable: boolean;
	transport: string | null;
	/** `null` when it could not be verified — never read as "writable". */
	readOnly: boolean | null;
	isPortageDrive: boolean;
}

export type TransferState =
	| 'eligible'
	| 'queued'
	| 'copying'
	| 'written'
	| 'verified'
	| 'source_deleted'
	| 'done'
	| 'failed'
	| 'skipped_excluded'
	| 'skipped_duplicate';

export interface TransferRow {
	id: number;
	run_id: number | null;
	device_id: string;
	src_path: string;
	dest_path: string;
	path_norm: string;
	size: number;
	src_mtime: number;
	state: TransferState;
	hash: string | null;
	hash_scope: 'full' | 'partial' | null;
	attempts: number;
	last_error: string | null;
	started_at: number | null;
	finished_at: number | null;
}

export interface RunRow {
	id: number;
	device_id: string | null;
	transport: string;
	started_at: number;
	finished_at: number | null;
	status: 'running' | 'done' | 'failed' | 'interrupted';
	bytes_total: number;
	bytes_done: number;
	files_total: number;
	files_done: number;
	files_failed: number;
}

export type Verdict =
	| 'new'
	| 'already-on-drive'
	| 'too-recent'
	| 'excluded'
	| 'in-flight'
	| 'duplicate-candidate'
	| 'empty';

export interface Candidate {
	deviceId: string;
	deviceLabel: string;
	serial: string;
	srcPath: string;
	root: string;
	relative: string;
	size: number;
	mtime: number;
	verdict: Verdict;
	reason: string;
}

export interface ArchiveHit {
	path: string;
	size: number;
	hash: string | null;
	relation: 'identical' | 'same-size' | 'collision';
	note: string;
}

export interface PlannedFile {
	candidate: Candidate;
	destPath: string;
	destNorm: string;
	matchesArchive?: ArchiveHit | null;
	alreadyTransferred: boolean;
	skipReason?: string;
	/** True when a person removed this file from the pull by hand. */
	excluded?: boolean;
	bytes: number;
}

export interface DestinationCheck {
	ok: boolean;
	reason?: string;
	fix?: string;
	freeBytes: number;
	totalBytes: number;
	usedFraction: number;
}

export interface PlanResult {
	destRoot: string;
	files: PlannedFile[];
	toTransfer: PlannedFile[];
	skipped: PlannedFile[];
	bytesTotal: number;
	bytesSkipped: number;
	/** The part of `bytesSkipped` removed by hand, so the count stays honest. */
	bytesExcluded: number;
	fileCount: number;
	/** Null when there is not enough throughput history to be honest about it. */
	etaSeconds: number | null;
	space: DestinationCheck;
	warnings: string[];
}

export interface EngineSummary {
	runId: number;
	transferred: number;
	verified: number;
	deleted: number;
	kept: number;
	failed: number;
	skipped: number;
	bytesMoved: number;
	durationMs: number;
	rateBps: number;
	failures: Array<{ srcPath: string; reason: string }>;
}

export interface FileEvent {
	type: 'start' | 'progress' | 'verified' | 'deleted' | 'failed' | 'skipped';
	file: PlannedFile;
	bytes?: number;
	total?: number;
	hash?: string;
	reason?: string;
}

export type PurgeProof = 'journal-hash' | 'recomputed-hash';

export interface PurgeCandidate {
	deviceId: string;
	serial: string;
	srcPath: string;
	destPath: string;
	size: number;
	proof: PurgeProof;
	hash: string;
}

export interface DupeMember {
	path: string;
	relative: string;
	size: number;
	mtime?: number | null;
	hash: string | null;
	score?: string | null;
	scoreReason?: string | null;
	keep: boolean;
	suspicious?: string | null;
}

export interface DupeGroup {
	id: number;
	tier: 1 | 2;
	reason: string;
	label: string | null;
	members: DupeMember[];
	reclaimableBytes: number;
}

// --- the view snapshot (`state` frames) --------------------------------------

export type RowState = 'queued' | 'copying' | 'done' | 'failed' | 'skipped' | 'duplicate';

export interface FileRow {
	/** Stable identity: the journal's own (deviceId, srcPath, size) key. */
	key: string;
	srcPath: string;
	destPath: string;
	size: number;
	bytes: number;
	state: RowState;
	reason: string;
	startedAt: number | null;
	lastProgressAt: number;
	onDrive: boolean;
}

export interface DeviceRow {
	id: string;
	model: string;
	android: string;
	ready: boolean;
	linkMbps: number | null;
	freeBytes: number | null;
}

export interface Overall {
	bytesDone: number;
	bytesTotal: number;
	filesDone: number;
	filesTotal: number;
	failed: number;
	skipped: number;
	rateBps: number;
	avgBps: number;
	smoothedBps: number;
	etaSeconds: number | null;
	samples: number;
	elapsedMs: number;
	jobs: number;
	paused: boolean;
}

export type ScreenName = 'dashboard' | 'dupes' | 'help' | 'confirm';

// --- the error shape ---------------------------------------------------------

/**
 * What a failure looks like on the wire. `fix` is always present so "no advice"
 * and "a missing key" cannot look the same.
 */
export interface EngineError {
	code: number;
	message: string;
	fix: string;
}

// --- commands (app -> engine) ------------------------------------------------

export interface CommandArgs {
	'volumes.list': Record<string, never>;
	'devices.list': Record<string, never>;

	'config.get': { key?: string | undefined };
	'config.set': { key: string; value: unknown };

	'status.get': { run?: number | null | undefined; limit?: number | undefined };

	doctor: { bench?: boolean | undefined };
	'db.export': { path: string };

	browse: { device?: string | undefined; path: string; depth?: number | undefined };

	scan: { device?: string | undefined; show?: string | undefined; since?: string | undefined };
	plan: {
		device?: string | undefined;
		show?: string | undefined;
		since?: string | undefined;
		jobs?: number | undefined;
		overwrite?: boolean | undefined;
		exclude?: string[] | undefined;
	};

	'pull.start': {
		device?: string | undefined;
		show?: string | undefined;
		since?: string | undefined;
		jobs?: number | undefined;
		exclude?: string[] | undefined;
		mode?: 'delete-after-verify' | 'keep' | undefined;
	};
	'pull.pause': Record<string, never>;
	'pull.resume': Record<string, never>;
	'pull.stop': Record<string, never>;

	'dupes.scan': { tier?: 1 | 2 | undefined; roots?: string[] | undefined };
	'dupes.apply': { scanId: string; keys: string[]; confirm?: string | undefined };

	'purge.plan': { verifyHash?: boolean | undefined };
	'purge.apply': { planId: string; keys: string[]; confirm?: string | undefined };

	shutdown: Record<string, never>;
}

export type CommandType = keyof CommandArgs;
export type ArgsFor<T extends CommandType> = CommandArgs[T];

/**
 * The keys each command's `answer.data` carries — the app's half of the wire
 * contract, and the ONLY place an answer's shape is written down.
 *
 * A command may answer with more than one shape (a refusal and an action), so
 * each entry is a list of key sets. `test/serve-contract.test.ts` runs the real
 * engine and fails when an answer's keys are not one of these, which is what
 * stops the app believing in a field the engine never sends. That is exactly
 * what broke a destination change: `config.get` answers with a key COUNT, and
 * the config itself travels in the `config` frame, so reading
 * `answer.sources.userPath` threw `undefined is not an object`.
 */
export const ANSWER_KEYS = {
	'volumes.list': [['count']],
	'devices.list': [['count', 'adbFound']],
	'config.get': [['keys'], ['key', 'value', 'origin']],
	'config.set': [['key', 'value', 'path']],
	'status.get': [['destRoot', 'runs', 'pending', 'recent']],
	'db.export': [['path']],
	browse: [['device', 'path', 'entries', 'total', 'truncated']],
	scan: [['devices', 'total', 'counts']],
	plan: [
		['fileCount', 'bytesTotal', 'bytesSkipped', 'skipped', 'spaceOk', 'warnings', 'jobsAtPullTime']
	],
	'pull.start': [['runId', 'mode', 'note']],
	'pull.pause': [['paused', 'effect']],
	'pull.resume': [['paused', 'effect']],
	'pull.stop': [['effect']],
	'dupes.scan': [['scanId', 'groups', 'keys', 'reclaimableBytes', 'trashDir']],
	'dupes.apply': [
		['needsConfirm', 'actionId', 'count', 'bytes', 'trashDir'],
		['moved', 'refused', 'bytesMoved', 'trashDir']
	],
	'purge.plan': [['planId', 'eligible', 'refused', 'bytesReclaimed']],
	'purge.apply': [
		['needsConfirm', 'actionId', 'count', 'bytes'],
		['deleted', 'failed']
	],
	doctor: [
		['checks', 'failed', 'exitCode'],
		['checks', 'exitCode', 'unreadable']
	],
	shutdown: [['stopping']]
} as const satisfies Record<CommandType, readonly (readonly string[])[]>;

/** One answer object a command can produce, with every field typed `unknown`. */
export type AnswerShape<Keys extends readonly string[]> = {
	[K in Keys[number]]: unknown;
};

/** Distributes over a command's declared shapes, so each stays separate. */
type OneOf<Keys> = Keys extends readonly string[] ? AnswerShape<Keys> : never;

/**
 * What `send` resolves with for a command.
 *
 * A union of the command's acceptable shapes, so a field that NO shape carries
 * is a type error at the call site rather than a runtime crash on the wire.
 */
export type AnswerFor<T extends CommandType> = OneOf<(typeof ANSWER_KEYS)[T][number]>;

/** One envelope per command. An unknown key is a rejected command, not a no-op. */
export interface Envelope<T extends CommandType = CommandType> {
	v: typeof PROTOCOL_VERSION;
	id: string;
	type: T;
	args?: ArgsFor<T> | undefined;
}

// --- frames (engine -> app) --------------------------------------------------

interface Head<T extends string> {
	v: number;
	type: T;
}

export interface ReadyFrame extends Head<'ready'> {
	protocolVersion: number;
	engineVersion: string;
	platform: string;
	adbFound: boolean;
	/** Absolute path of the binary the engine will use, or null. */
	adbPath: string | null;
	/** Why that binary: the config value, `PATH`, the SDK search, or nothing. */
	adbSource: AdbSource;
	destinationConfigured: boolean;
}

/** Mirrors `AdbSource` in `src/device/adb.ts`, plus the "found nothing" case. */
export type AdbSource = 'config' | 'path' | 'search' | 'none';

export type NoticeLevel = 'info' | 'warn' | 'error';
export type FrameLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface NoticeFrame extends Head<'notice'> {
	level: NoticeLevel;
	message: string;
}

export interface LogFrame extends Head<'log'> {
	level: FrameLogLevel;
	message: string;
}

export interface ConfigFrame extends Head<'config'> {
	config: PortageConfig;
	origins: Record<string, string>;
	sources: { userPath: string; drivePath: string | null };
}

export interface DevicesFrame extends Head<'devices'> {
	devices: DeviceInfo[];
}

export interface VolumesFrame extends Head<'volumes'> {
	volumes: Volume[];
}

export interface ScanFrame extends Head<'scan'> {
	candidates: Candidate[];
	counts: Record<Verdict, number>;
}

export interface PlanFrame extends Head<'plan'> {
	plan: PlanResult;
}

export interface StateFrame extends Head<'state'> {
	screen: ScreenName;
	rows: FileRow[];
	overall: Overall;
	devices: DeviceRow[];
	notice: string | null;
}

export interface RunFrame extends Head<'run'> {
	summary: EngineSummary;
}

export interface WireDupeMember {
	key: string;
	path: string;
	relative: string;
	size: number;
	hash: string | null;
	keep: boolean;
	score: string | null;
	scoreReason: string | null;
	suspicious: string | null;
}

export interface WireDupeGroup {
	id: number;
	tier: 1 | 2;
	reason: string;
	label: string | null;
	members: WireDupeMember[];
	reclaimableBytes: number;
}

export interface DupesFrame extends Head<'dupes'> {
	scanId: string;
	groups: WireDupeGroup[];
	tier1Count: number;
	tier2Count: number;
	reclaimableBytes: number;
	scannedFiles: number;
	scannedBytes: number;
	truncated: string[];
	unparsed: string[];
}

export interface WirePurgeCandidate {
	key: string;
	deviceId: string;
	serial: string;
	srcPath: string;
	destPath: string;
	size: number;
	proof: PurgeProof;
	hash: string;
}

export interface PurgePlanFrame extends Head<'purgePlan'> {
	planId: string;
	eligible: WirePurgeCandidate[];
	refused: Array<{ srcPath: string; reason: string }>;
	bytesReclaimed: number;
}

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
	status: DoctorStatus;
	label: string;
	value: string;
	fix: string | null;
}

export interface DoctorFrame extends Head<'doctor'> {
	ok: boolean;
	checks: DoctorCheck[];
}

export interface StatusFrame extends Head<'status'> {
	archive: { files: number; bytes: number };
	counts: Record<string, number>;
	pending: TransferRow[];
	runs: RunRow[];
	recent: TransferRow[];
}

export interface BrowseEntry {
	name: string;
	path: string;
	kind: 'dir' | 'file';
	/** Bytes for a file, null for a directory. Never a guessed size. */
	size: number | null;
	depth: number;
}

export interface BrowseFrame extends Head<'browse'> {
	path: string;
	depth: number;
	entries: BrowseEntry[];
	total: number;
	truncated: boolean;
}

/** Emitted BEFORE anything moves. `confirm` on the follow-up must equal `actionId`. */
export interface NeedsConfirmFrame extends Head<'needsConfirm'> {
	actionId: string;
	action: 'dupes.apply' | 'purge.apply';
	paths: string[];
	count: number;
	bytes: number;
	/** Where a move goes; null for a purge, which deletes rather than moves. */
	trashDir: string | null;
}

export interface AnswerFrame extends Head<'answer'> {
	id: string;
	ok: boolean;
	data?: unknown;
	error?: EngineError;
}

export interface ByeFrame extends Head<'bye'> {}

export type Frame =
	| ReadyFrame
	| NoticeFrame
	| LogFrame
	| ConfigFrame
	| DevicesFrame
	| VolumesFrame
	| ScanFrame
	| PlanFrame
	| StateFrame
	| RunFrame
	| DupesFrame
	| PurgePlanFrame
	| DoctorFrame
	| StatusFrame
	| BrowseFrame
	| NeedsConfirmFrame
	| AnswerFrame
	| ByeFrame;

export type FrameType = Frame['type'];

export type FramePayload<T extends Frame> = Omit<T, 'v' | 'type'>;

/** Everything except the error channel. */
export type NonAnswerFrame = Exclude<Frame, AnswerFrame>;
