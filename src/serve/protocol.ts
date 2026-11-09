/**
 * The wire protocol: one JSON object per line, both directions.
 *
 * Everything above this file is a view. This file is the contract, and two
 * rules from `architecture.md` are load-bearing:
 *
 *  1. `v` is the protocol version. A mismatch is a fatal handshake error, not
 *     something to paper over.
 *  2. Validation is STRICT. An unknown key in a command rejects the command; it
 *     is never a silently dropped field. A typo must not become a no-op.
 *
 * The payloads are the ENGINE'S OWN objects (`Candidate`, `PlanResult`,
 * `Volume`, `EngineSummary`, the view's `FileRow`/`Overall`/`DeviceRow`). They
 * are imported and referenced, never restated: `enginePayload` keeps the fields
 * in exactly one place while still giving every frame a schema. Restating them
 * here is how the app and the engine drift apart.
 *
 * Nothing in this file prints. stdout is the wire.
 */
import * as v from "valibot";

import type { PortageConfig } from "../config/schema.ts";
import type { DeviceInfo } from "../device/adb.ts";
import type { Volume } from "../device/volumes.ts";
import type { RunRow, TransferRow } from "../index/journal.ts";
import type { PlanResult } from "../plan/plan.ts";
import type { Candidate, Verdict } from "../scan/scan.ts";
import type {
  DeviceRow,
  FileRow,
  Overall,
  ScreenName,
} from "../tui/state.svelte.ts";
import type { EngineSummary, FileEvent } from "../xfer/engine.ts";
import type { PurgeCandidate } from "../xfer/purge.ts";

export const PROTOCOL_VERSION = 1;

/**
 * A payload whose shape IS an engine type.
 *
 * The schema exists so every frame can be parsed and validated as a whole; the
 * FIELDS live in the engine and are imported, so a renamed field in the engine
 * changes the frame's type here instead of silently diverging from it.
 */
export function enginePayload<T>(label: string) {
  return v.custom<T>(() => true, label);
}

// --- the error shape --------------------------------------------------------

/**
 * What a failure looks like on the wire.
 *
 * `fix` is the one line a person can act on ("plug in a phone and accept the RSA
 * prompt"), and it is always present — an empty string when there is nothing to
 * suggest, because a missing key and "no advice" must not look the same to a
 * renderer. A stack trace never travels here.
 */
export const ErrorShapeSchema = v.strictObject({
  code: v.number(),
  message: v.string(),
  fix: v.string(),
});
export type WireError = v.InferOutput<typeof ErrorShapeSchema>;

// --- the envelope (UI -> engine) --------------------------------------------

/** The one envelope every command uses. Extra keys are a rejected command. */
export const EnvelopeSchema = v.strictObject({
  v: v.literal(PROTOCOL_VERSION),
  id: v.pipe(v.string(), v.minLength(1, "every command needs an id")),
  type: v.pipe(v.string(), v.minLength(1, "every command needs a type")),
  args: v.optional(v.unknown(), {}),
});
export type Envelope = v.InferOutput<typeof EnvelopeSchema>;

/** `{}` for the commands that take nothing. Still strict: `{}` or nothing. */
const EmptyArgs = v.strictObject({});

const sinceSchema = v.optional(v.string());
const deviceFilterSchema = v.optional(v.string());
const jobsSchema = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
);

/**
 * Every command's `args`.
 *
 * The keys here ARE the command list. A type absent from this map is answered
 * with `ok: false` and the list of what exists, so a typo from the UI is
 * readable rather than a hang.
 */
export const ArgsSchemas = {
  "volumes.list": EmptyArgs,
  "devices.list": EmptyArgs,

  "config.get": v.strictObject({ key: v.optional(v.string()) }),
  "config.set": v.strictObject({
    key: v.pipe(v.string(), v.minLength(1, "config.set needs a key")),
    value: v.unknown(),
  }),

  "status.get": v.strictObject({
    run: v.optional(v.nullable(v.number())),
    limit: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
    ),
  }),

  doctor: v.strictObject({ bench: v.optional(v.boolean(), false) }),
  "db.export": v.strictObject({
    path: v.pipe(v.string(), v.minLength(1, "db.export needs a path")),
  }),

  browse: v.strictObject({
    device: deviceFilterSchema,
    path: v.pipe(v.string(), v.minLength(1, "browse needs a path")),
    depth: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4)),
      1,
    ),
  }),

  scan: v.strictObject({
    device: deviceFilterSchema,
    show: v.optional(v.string()),
    since: sinceSchema,
  }),
  plan: v.strictObject({
    device: deviceFilterSchema,
    show: v.optional(v.string()),
    since: sinceSchema,
    jobs: jobsSchema,
    overwrite: v.optional(v.boolean(), false),
  }),

  "pull.start": v.strictObject({
    device: deviceFilterSchema,
    show: v.optional(v.string()),
    since: sinceSchema,
    jobs: jobsSchema,
    // The mode names the deletion decision, which is the only thing that
    // differs between "copy and keep" and "copy then delete after proof".
    mode: v.optional(
      v.union([v.literal("delete-after-verify"), v.literal("keep")]),
      "keep",
    ),
  }),
  "pull.pause": EmptyArgs,
  "pull.resume": EmptyArgs,
  "pull.stop": EmptyArgs,

  "dupes.scan": v.strictObject({
    tier: v.optional(v.union([v.literal(1), v.literal(2)])),
    roots: v.optional(v.array(v.string())),
  }),
  "dupes.apply": v.strictObject({
    scanId: v.pipe(v.string(), v.minLength(1, "dupes.apply needs a scanId")),
    keys: v.pipe(
      v.array(v.string()),
      v.minLength(1, "dupes.apply needs at least one key"),
    ),
    confirm: v.optional(v.string()),
  }),

  "purge.plan": v.strictObject({ verifyHash: v.optional(v.boolean(), false) }),
  "purge.apply": v.strictObject({
    planId: v.pipe(v.string(), v.minLength(1, "purge.apply needs a planId")),
    keys: v.pipe(
      v.array(v.string()),
      v.minLength(1, "purge.apply needs at least one key"),
    ),
    confirm: v.optional(v.string()),
  }),

  shutdown: EmptyArgs,
} as const;

export type CommandType = keyof typeof ArgsSchemas;
export const COMMAND_TYPES = Object.keys(ArgsSchemas) as CommandType[];

export function isCommandType(type: string): type is CommandType {
  return Object.hasOwn(ArgsSchemas, type);
}

/** The validated `args` for one command. Handlers are typed from this. */
export type ArgsFor<T extends CommandType> = v.InferOutput<
  (typeof ArgsSchemas)[T]
>;

// --- frames (engine -> UI) --------------------------------------------------

/** The fixed head of every frame. One place, so no writer can forget `v`. */
function frameHeader<T extends string>(type: T) {
  return {
    v: v.literal(PROTOCOL_VERSION),
    type: v.literal(type),
  };
}

/** Once, at startup. Everything the shell needs to decide what to draw. */
export const ReadyFrameSchema = v.strictObject({
  ...frameHeader("ready"),
  protocolVersion: v.number(),
  engineVersion: v.string(),
  platform: v.string(),
  adbFound: v.boolean(),
  /** Absolute path of the binary that will be used, or null. */
  adbPath: v.nullable(v.string()),
  /** Why that binary: the config value, `PATH`, the SDK search, or nothing. */
  adbSource: v.picklist(["config", "path", "search", "none"]),
  destinationConfigured: v.boolean(),
});

export const NoticeLevels = ["info", "warn", "error"] as const;
export const LogLevels = ["debug", "info", "warn", "error"] as const;
export type NoticeLevel = (typeof NoticeLevels)[number];
export type FrameLogLevel = (typeof LogLevels)[number];

/** A human sentence for the toast strip, with a level. */
export const NoticeFrameSchema = v.strictObject({
  ...frameHeader("notice"),
  level: v.picklist(NoticeLevels),
  message: v.string(),
});

/** Diagnostics worth keeping. NEVER the primary error channel. */
export const LogFrameSchema = v.strictObject({
  ...frameHeader("log"),
  level: v.picklist(LogLevels),
  message: v.string(),
});

/** The resolved config plus the precedence source per key. */
export const ConfigFrameSchema = v.strictObject({
  ...frameHeader("config"),
  config: enginePayload<PortageConfig>("PortageConfig"),
  origins: enginePayload<Record<string, string>>("config origins"),
  sources: v.strictObject({
    userPath: v.string(),
    drivePath: v.nullable(v.string()),
  }),
});

export const DevicesFrameSchema = v.strictObject({
  ...frameHeader("devices"),
  devices: enginePayload<DeviceInfo[]>("DeviceInfo[]"),
});

export const VolumesFrameSchema = v.strictObject({
  ...frameHeader("volumes"),
  volumes: enginePayload<Volume[]>("Volume[]"),
});

/** Candidates with verdict + reason, and the summary counts. */
export const ScanFrameSchema = v.strictObject({
  ...frameHeader("scan"),
  candidates: enginePayload<Candidate[]>("Candidate[]"),
  counts: enginePayload<Record<Verdict, number>>("verdict counts"),
});

export const PlanFrameSchema = v.strictObject({
  ...frameHeader("plan"),
  plan: enginePayload<PlanResult>("PlanResult"),
});

/** A full snapshot of the run view. `v`/`type` plus `snapshot()`. */
export const StateFrameSchema = v.strictObject({
  ...frameHeader("state"),
  screen: enginePayload<ScreenName>("ScreenName"),
  rows: enginePayload<FileRow[]>("FileRow[]"),
  overall: enginePayload<Overall>("Overall"),
  devices: enginePayload<DeviceRow[]>("DeviceRow[]"),
  notice: v.nullable(v.string()),
});
export type StatePayload = Omit<
  v.InferOutput<typeof StateFrameSchema>,
  "v" | "type"
>;

/** Once, at the end of a run: the engine's own summary. */
export const RunFrameSchema = v.strictObject({
  ...frameHeader("run"),
  summary: enginePayload<EngineSummary>("EngineSummary"),
});

/**
 * The duplicate report, with an opaque KEY per member.
 *
 * `key` is the whole point: the UI sends keys back, never paths, so a buggy or
 * compromised renderer cannot construct a delete set. The engine maps keys to
 * the paths it already holds in its pending-action register.
 */
export const WireDupeMemberSchema = v.strictObject({
  key: v.string(),
  path: v.string(),
  relative: v.string(),
  size: v.number(),
  hash: v.nullable(v.string()),
  keep: v.boolean(),
  score: v.nullable(v.string()),
  scoreReason: v.nullable(v.string()),
  suspicious: v.nullable(v.string()),
});
export type WireDupeMember = v.InferOutput<typeof WireDupeMemberSchema>;

export const WireDupeGroupSchema = v.strictObject({
  id: v.number(),
  tier: v.union([v.literal(1), v.literal(2)]),
  reason: v.string(),
  label: v.nullable(v.string()),
  members: v.array(WireDupeMemberSchema),
  reclaimableBytes: v.number(),
});
export type WireDupeGroup = v.InferOutput<typeof WireDupeGroupSchema>;

export const DupesFrameSchema = v.strictObject({
  ...frameHeader("dupes"),
  scanId: v.string(),
  groups: v.array(WireDupeGroupSchema),
  tier1Count: v.number(),
  tier2Count: v.number(),
  reclaimableBytes: v.number(),
  scannedFiles: v.number(),
  scannedBytes: v.number(),
  truncated: v.array(v.string()),
  unparsed: v.array(v.string()),
});

/** Purge candidates with their proof, and a key per candidate. */
export const WirePurgeCandidateSchema = v.strictObject({
  key: v.string(),
  deviceId: v.string(),
  serial: v.string(),
  srcPath: v.string(),
  destPath: v.string(),
  size: v.number(),
  proof: v.picklist(["journal-hash", "recomputed-hash"]),
  hash: v.string(),
});
export type WirePurgeCandidate = v.InferOutput<
  typeof WirePurgeCandidateSchema
>;

/** Compile-time drift guard: the wire candidate must still BE a PurgeCandidate. */
type Extends<A extends B, B> = true;
type _PurgeCandidatePin = Extends<WirePurgeCandidate, PurgeCandidate>;

export const PurgePlanFrameSchema = v.strictObject({
  ...frameHeader("purgePlan"),
  planId: v.string(),
  eligible: v.array(WirePurgeCandidateSchema),
  refused: v.array(v.strictObject({ srcPath: v.string(), reason: v.string() })),
  bytesReclaimed: v.number(),
});

export const DoctorCheckSchema = v.strictObject({
  status: v.picklist(["ok", "warn", "fail", "info"]),
  label: v.string(),
  value: v.string(),
  fix: v.nullable(v.string()),
});
export type DoctorCheck = v.InferOutput<typeof DoctorCheckSchema>;

export const DoctorFrameSchema = v.strictObject({
  ...frameHeader("doctor"),
  ok: v.boolean(),
  checks: v.array(DoctorCheckSchema),
});

export const StatusFrameSchema = v.strictObject({
  ...frameHeader("status"),
  archive: v.strictObject({ files: v.number(), bytes: v.number() }),
  counts: v.record(v.string(), v.number()),
  pending: enginePayload<TransferRow[]>("pending purge rows"),
  runs: enginePayload<RunRow[]>("RunRow[]"),
  recent: enginePayload<TransferRow[]>("TransferRow[]"),
});

export const BrowseEntrySchema = v.strictObject({
  name: v.string(),
  path: v.string(),
  kind: v.picklist(["dir", "file"]),
  /** Bytes for a file, null for a directory. Never a guessed size. */
  size: v.nullable(v.number()),
  /** 0 for the level itself, 1 for its children. */
  depth: v.number(),
});
export type BrowseEntry = v.InferOutput<typeof BrowseEntrySchema>;

export const BrowseFrameSchema = v.strictObject({
  ...frameHeader("browse"),
  path: v.string(),
  depth: v.number(),
  entries: v.array(BrowseEntrySchema),
  total: v.number(),
  truncated: v.boolean(),
});

/**
 * The confirmation gate. Emitted BEFORE anything moves.
 *
 * `actionId` is the id of the engine result the keys came from, and `confirm`
 * on the follow-up call must equal it. The paths here are the engine's own
 * strings, so what the sheet shows and what moves are the same list.
 */
export const NeedsConfirmFrameSchema = v.strictObject({
  ...frameHeader("needsConfirm"),
  actionId: v.string(),
  action: v.picklist(["dupes.apply", "purge.apply"]),
  paths: v.array(v.string()),
  count: v.number(),
  bytes: v.number(),
  /** Where a move goes; null for a purge, which deletes rather than moves. */
  trashDir: v.nullable(v.string()),
});

/** Exactly one per command id, always — including on failure. */
export const AnswerFrameSchema = v.strictObject({
  ...frameHeader("answer"),
  id: v.string(),
  ok: v.boolean(),
  data: v.optional(v.unknown()),
  error: v.optional(ErrorShapeSchema),
});

/** Terminal frame: the process exits 0 after this. */
export const ByeFrameSchema = v.strictObject({ ...frameHeader("bye") });

export const FRAME_SCHEMAS = {
  ready: ReadyFrameSchema,
  notice: NoticeFrameSchema,
  log: LogFrameSchema,
  config: ConfigFrameSchema,
  devices: DevicesFrameSchema,
  volumes: VolumesFrameSchema,
  scan: ScanFrameSchema,
  plan: PlanFrameSchema,
  state: StateFrameSchema,
  run: RunFrameSchema,
  dupes: DupesFrameSchema,
  purgePlan: PurgePlanFrameSchema,
  doctor: DoctorFrameSchema,
  status: StatusFrameSchema,
  browse: BrowseFrameSchema,
  needsConfirm: NeedsConfirmFrameSchema,
  answer: AnswerFrameSchema,
  bye: ByeFrameSchema,
} as const;

export type FrameType = keyof typeof FRAME_SCHEMAS;

/** The union of every frame, derived from the schemas by name. */
export type WireFrame = {
  [K in FrameType]: v.InferOutput<(typeof FRAME_SCHEMAS)[K]>;
}[FrameType];

/**
 * Parse a frame off the wire, dispatching on its `type`.
 *
 * Used by the tests and by any future replay harness. A frame whose type is not
 * in the table is an explicit failure, not a silent pass.
 */
export function parseFrame(
  value: unknown,
): { ok: true; frame: WireFrame } | { ok: false; issues: string[] } {
  const type =
    typeof value === "object" && value !== null && "type" in value
      ? String((value as { type: unknown }).type)
      : "";
  const schema = (FRAME_SCHEMAS as Record<string, unknown>)[type];
  if (schema === undefined) {
    return { ok: false, issues: [`unknown frame type: "${type}"`] };
  }
  const result = v.safeParse(schema as v.GenericSchema, value);
  if (!result.success) {
    return {
      ok: false,
      issues: result.issues.map(
        (i) =>
          `${i.path?.map((p) => String(p.key)).join(".") ?? ""}: ${i.message}`,
      ),
    };
  }
  return { ok: true, frame: result.output as WireFrame };
}

/** Human line for a transfer event. `log` frames use it; nothing else does. */
export function describeFileEvent(event: FileEvent): string {
  switch (event.type) {
    case "start":
      return `start ${event.file.candidate.srcPath}`;
    case "progress":
      return `progress ${event.bytes}/${event.total} ${event.file.candidate.srcPath}`;
    case "verified":
      return `verified ${event.file.destPath}`;
    case "deleted":
      return `deleted the phone copy of ${event.file.candidate.srcPath}`;
    case "failed":
      return `failed ${event.file.candidate.srcPath}: ${event.reason}`;
    case "skipped":
      return `skipped ${event.file.candidate.srcPath}: ${event.reason}`;
  }
}

// --- frame payloads, for the writers ----------------------------------------
//
// The `v`/`type` head of a frame is the writer's job, so a writer takes the
// payload only. Deriving these means a writer cannot invent a field the schema
// would reject, and a schema change updates the writer's signature for free.

export type ReadyFramePayload = Omit<
  v.InferOutput<typeof ReadyFrameSchema>,
  "v" | "type"
>;
export type ConfigFramePayload = Omit<
  v.InferOutput<typeof ConfigFrameSchema>,
  "v" | "type"
>;
export type ScanFramePayload = Omit<
  v.InferOutput<typeof ScanFrameSchema>,
  "v" | "type"
>;
export type DupesFramePayload = Omit<
  v.InferOutput<typeof DupesFrameSchema>,
  "v" | "type"
>;
export type PurgePlanFramePayload = Omit<
  v.InferOutput<typeof PurgePlanFrameSchema>,
  "v" | "type"
>;
export type DoctorFramePayload = Omit<
  v.InferOutput<typeof DoctorFrameSchema>,
  "v" | "type"
>;
export type StatusFramePayload = Omit<
  v.InferOutput<typeof StatusFrameSchema>,
  "v" | "type"
>;
export type BrowseFramePayload = Omit<
  v.InferOutput<typeof BrowseFrameSchema>,
  "v" | "type"
>;
export type NeedsConfirmFramePayload = Omit<
  v.InferOutput<typeof NeedsConfirmFrameSchema>,
  "v" | "type"
>;
export type AnswerFramePayload = Omit<
  v.InferOutput<typeof AnswerFrameSchema>,
  "v" | "type"
>;
