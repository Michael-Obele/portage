/**
 * The configuration schema.
 *
 * Two files matter:
 *   <drive>/.portage/config.toml — travels with the drive. Plug it into any
 *     machine with portage installed and the rules come with it. This is the
 *     one that decides *where things go*.
 *   ~/.config/portage/config.toml — machine-level defaults (adb path, ssh key,
 *     port range, TUI theme).
 *
 * Precedence, highest first: CLI flags → env (PORTAGE_*) → drive → user → defaults.
 *
 * Why valibot rather than zod: it is ~2 kB, validates a **plain object** in
 * place, and its `v.optional(schema, default)` gives each field its default at
 * the schema itself — so there is exactly one source of truth for the shape and
 * `portage config get` returns what `portage config set` wrote.
 */

import * as v from "valibot";

/** When a phone-side file may be deleted. The default matches the real workflow. */
export const DeleteSource = v.picklist(["after-verify", "never", "prompt"]);
export type DeleteSource = v.InferOutput<typeof DeleteSource>;

/** How hard we look before calling a drive copy good. */
export const VerifyMode = v.picklist(["standard", "paranoid"]);
export type VerifyMode = v.InferOutput<typeof VerifyMode>;

/** Which transport to try first. `auto` picks adb and falls back on failure. */
export const Transport = v.picklist(["auto", "adb", "rsync"]);
export type TransportChoice = v.InferOutput<typeof Transport>;

export const DeviceConfigSchema = v.object({
  /** Human label. Free to rename — the key is the device id, not this. */
  label: v.optional(v.string(), ""),
  /** Phone-side directories to walk. Per-device because the layouts differ. */
  roots: v.optional(v.array(v.string()), []),
  /** Overrides the global concurrency for this device (USB 2 cables need 1). */
  jobs: v.optional(v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8))), undefined),
  /** Paths under these prefixes are never scanned. */
  exclude: v.optional(v.array(v.string()), []),
});

export type DeviceConfig = v.InferOutput<typeof DeviceConfigSchema>;

/**
 * Every config field as a *value* schema, without the default wrapper.
 *
 * `portage config set <key> <value>` validates against this map, so a typo in
 * the key name is a usage error rather than a silently-ignored write.
 */
export const FIELD_SCHEMAS = {
  dest_root: v.string(),
  roots: v.array(v.string()),
  quiet_seconds: v.pipe(v.number(), v.integer(), v.minValue(0)),
  jobs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
  verify: VerifyMode,
  delete_source: DeleteSource,
  space_headroom: v.pipe(v.number(), v.minValue(0), v.maxValue(0.9)),
  transport: Transport,
  resume_threshold: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  forward_port: v.pipe(v.number(), v.integer(), v.minValue(1024), v.maxValue(65535)),
  adb_path: v.string(),
  theme: v.string(),
  devices: v.record(v.string(), DeviceConfigSchema),
} as const;

export type ConfigKey = keyof typeof FIELD_SCHEMAS;

/** Apply a default to a field schema without losing its inferred output type. */
const withDefault = <T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: T,
  fallback: v.InferOutput<T>,
) => v.optional(schema, fallback);

export const PortageConfigSchema = v.object({
  /** Where new files land. */
  dest_root: withDefault(FIELD_SCHEMAS.dest_root, ""),
  /** Extra archive roots a duplicate report should span. */
  roots: withDefault(FIELD_SCHEMAS.roots, []),
  /** A file whose mtime is within this many seconds is assumed to still be downloading. */
  quiet_seconds: withDefault(FIELD_SCHEMAS.quiet_seconds, 120),
  /** Concurrent transfer processes. 3 was measured as the knee on this hardware. */
  jobs: withDefault(FIELD_SCHEMAS.jobs, 3),
  verify: withDefault(FIELD_SCHEMAS.verify, "standard"),
  delete_source: withDefault(FIELD_SCHEMAS.delete_source, "after-verify"),
  /** Refuse to start a run that would leave less than this fraction free. */
  space_headroom: withDefault(FIELD_SCHEMAS.space_headroom, 0.02),
  transport: withDefault(FIELD_SCHEMAS.transport, "auto"),
  /** Resume a partial only past this fraction done — below it, re-pulling is faster. */
  resume_threshold: withDefault(FIELD_SCHEMAS.resume_threshold, 0.76),
  /** localhost port for `adb forward` when the rsync fallback is in use. */
  forward_port: withDefault(FIELD_SCHEMAS.forward_port, 8022),
  /** Absolute path to adb when it is not on PATH. */
  adb_path: withDefault(FIELD_SCHEMAS.adb_path, ""),
  theme: withDefault(FIELD_SCHEMAS.theme, "auto"),
  devices: withDefault(FIELD_SCHEMAS.devices, {}),
});

export type PortageConfig = v.InferOutput<typeof PortageConfigSchema>;

export const DEFAULT_CONFIG: PortageConfig = v.parse(PortageConfigSchema, {});

/** Every known config key, sorted — used for suggestions and `config` help. */
export const CONFIG_KEYS = Object.keys(FIELD_SCHEMAS).sort() as ConfigKey[];

/** The state directory Portage owns on the drive. */
export const STATE_DIR = ".portage";
export const DB_FILENAME = "portage.db";
export const EVENTS_FILENAME = "events.jsonl";
export const CONFIG_FILENAME = "config.toml";

/** Filenames that mean "a download is still in flight". */
export const IN_FLIGHT_SUFFIXES = [
  ".part",
  ".tmp",
  ".crdownload",
  ".!ut",
  ".download",
  ".opdownload",
];

/** Directory names never worth descending into. */
export const ALWAYS_EXCLUDED_DIRS = [
  "Android/data",
  "Android/obb",
  ".thumbnails",
  "DCIM/.thumbnails",
  ".Trash",
  ".Trash-1000",
  "$RECYCLE.BIN",
  "System Volume Information",
];