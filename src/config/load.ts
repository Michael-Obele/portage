/**
 * Config resolution.
 *
 * Precedence, highest first:
 *   1. CLI flags
 *   2. env  (PORTAGE_*)
 *   3. drive config  (<dest_root>/.portage/config.toml — travels with the drive)
 *   4. user config  (~/.config/portage/config.toml)
 *   5. built-in defaults
 *
 * Layers 3 and 4 are merged shallowly per key, with `devices` merged one level
 * deep so a per-device table in the user config does not erase the drive's.
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import * as v from "valibot";

import { usageError } from "../util/errors.ts";
import {
  DEFAULT_CONFIG,
  PortageConfigSchema,
  STATE_DIR,
  CONFIG_FILENAME,
  CONFIG_KEYS,
  FIELD_SCHEMAS,
  type PortageConfig,
} from "./schema.ts";

export interface ConfigSources {
  userPath: string;
  drivePath: string | null;
}

export interface ResolvedConfig {
  config: PortageConfig;
  sources: ConfigSources;
  /** Where each final value came from — shown by `portage config`. */
  origins: Record<string, string>;
}



async function readToml(path: string, label: string): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw usageError(`cannot read ${label} config at ${path}`, "check file permissions");
  }
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (err) {
    throw usageError(
      `${label} config at ${path} is not valid TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Validate a full config object, turning any issue into a usage error. */
function parseConfig(raw: unknown, source: string): PortageConfig {
  const result = v.safeParse(PortageConfigSchema, raw);
  if (result.success) return result.output;
  const first = result.issues[0];
  const key = first?.path?.map((p) => String(p.key)).join(".") ?? "";
  throw usageError(
    `invalid config from ${source}${key ? ` at "${key}"` : ""}: ${first?.message ?? "unknown"}`,
    `known keys: ${CONFIG_KEYS.join(", ")}`,
  );
}

/** Merge `override` onto `base`, one level deep for `devices`. */
function mergeConfigs(
  base: PortageConfig,
  override: Record<string, unknown>,
  source: string,
): PortageConfig {
  const devices: Record<string, unknown> = {
    ...(base.devices as Record<string, unknown>),
    ...((override.devices as Record<string, unknown> | undefined) ?? {}),
  };
  return parseConfig({ ...base, ...override, devices }, source);
}

/**
 * Map `PORTAGE_*` environment variables onto config keys.
 *
 * The output is keyed by the **config key**, not the variable name — getting
 * that backwards produces an object of unknown keys that the schema silently
 * drops, which is exactly how an env override becomes a no-op nobody notices.
 */
function envOverrides(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const list = (v: string | undefined) =>
    v === undefined ? undefined : v.split(":").filter(Boolean);

  const map: Record<string, unknown> = {
    dest_root: env.PORTAGE_DEST_ROOT,
    roots: list(env.PORTAGE_ROOTS),
    quiet_seconds: num(env.PORTAGE_QUIET_SECONDS),
    jobs: num(env.PORTAGE_JOBS),
    verify: env.PORTAGE_VERIFY,
    delete_source: env.PORTAGE_DELETE_SOURCE,
    space_headroom: num(env.PORTAGE_SPACE_HEADROOM),
    transport: env.PORTAGE_TRANSPORT,
    resume_threshold: num(env.PORTAGE_RESUME_THRESHOLD),
    forward_port: num(env.PORTAGE_FORWARD_PORT),
    adb_path: env.PORTAGE_ADB_PATH,
    theme: env.PORTAGE_THEME,
  };

  for (const [key, value] of Object.entries(map)) {
    if (value === undefined) continue;
    if (typeof value === "number" && Number.isNaN(value)) continue;
    out[key] = value;
  }
  return out;
}

export interface LoadOptions {
  /** `--config <path>` — replaces the user config file entirely. */
  configPath?: string;
  /** `--dest-root <path>` — highest-precedence override for the destination. */
  destRoot?: string;
  /** `--device` / `--jobs` / `--transport` etc. */
  cliOverrides?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}

export async function loadConfig(opts: LoadOptions = {}): Promise<ResolvedConfig> {
  const env = opts.env ?? Bun.env;
  const origins: Record<string, string> = {};
  const home = Bun.env.HOME ?? ".";
  const userPath = opts.configPath ?? join(home, ".config", "portage", CONFIG_FILENAME);

  // --- layer 5: defaults -----------------------------------------------------
  let config = DEFAULT_CONFIG;
  for (const key of Object.keys(config)) origins[key] = "default";

  // --- layer 4: user config --------------------------------------------------
  const userRaw = await readToml(userPath, "user");
  if (userRaw) {
    config = mergeConfigs(config, userRaw, userPath);
    for (const key of Object.keys(userRaw)) origins[key] = userPath;
  }

  // --- layer 3: drive config -------------------------------------------------
  // Located by whatever `dest_root` is known so far, which is exactly the
  // chicken-and-egg this ordering resolves: the user config (or a flag) names
  // the drive, then the drive's own rules refine everything else.
  let drivePath: string | null = null;
  const probeRoot = opts.destRoot ?? config.dest_root;
  if (probeRoot) {
    const resolvedDrivePath = join(probeRoot, STATE_DIR, CONFIG_FILENAME);
    const driveRaw = await readToml(resolvedDrivePath, "drive");
    if (driveRaw) {
      drivePath = resolvedDrivePath;
      config = mergeConfigs(config, driveRaw, resolvedDrivePath);
      for (const key of Object.keys(driveRaw)) origins[key] = resolvedDrivePath;
    }
  }

  // --- layer 2: env ----------------------------------------------------------
  const envRaw = envOverrides(env);
  if (Object.keys(envRaw).length > 0) {
    config = parseConfig({ ...config, ...envRaw }, "environment");
    for (const key of Object.keys(envRaw)) origins[key] = "env";
  }

  // --- layer 1: CLI flags ----------------------------------------------------
  const cliRaw: Record<string, unknown> = { ...(opts.cliOverrides ?? {}) };
  if (opts.destRoot) cliRaw.dest_root = opts.destRoot;
  if (Object.keys(cliRaw).length > 0) {
    config = parseConfig({ ...config, ...cliRaw }, "command line");
    for (const key of Object.keys(cliRaw)) origins[key] = "flag";
  }

  return { config, sources: { userPath, drivePath }, origins };
}

/** Require a destination, or say exactly what to do about it. */
export function requireDestRoot(config: PortageConfig): string {
  if (!config.dest_root) {
    throw usageError(
      "no destination configured (dest_root is empty)",
      "set it once with: portage config set dest_root /media/<you>/<drive>/Videos/$Anime",
    );
  }
  return config.dest_root;
}

/** Write a config file, merging over whatever is already there. */
export async function writeConfigFile(path: string, values: Record<string, unknown>): Promise<void> {
  const existing = (await readToml(path, "user")) ?? {};
  const body = renderToml({ ...existing, ...values });
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, body);
}

/**
 * A tiny TOML writer for the flat config we actually support. Full TOML
 * serialisation is out of scope — portage's config is scalars, string arrays,
 * and one table of tables.
 */
function renderToml(value: Record<string, unknown>): string {
  const lines: string[] = ["# portage configuration", ""];
  const devices: Record<string, unknown> = {};

  for (const [key, v] of Object.entries(value)) {
    if (key === "devices") {
      Object.assign(devices, v as Record<string, unknown>);
      continue;
    }
    if (v === undefined) continue;
    lines.push(`${key} = ${renderValue(v)}`);
  }

  for (const [id, cfg] of Object.entries(devices)) {
    if (typeof cfg !== "object" || cfg === null) continue;
    lines.push("", `[devices.${quoteKey(id)}]`);
    for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
      if (v === undefined) continue;
      lines.push(`${k} = ${renderValue(v)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function quoteKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function renderValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(renderValue).join(", ")}]`;
  if (v && typeof v === "object") {
    return `{ ${Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${quoteKey(k)} = ${renderValue(val)}`)
      .join(", ")} }`;
  }
  return JSON.stringify(String(v));
}

/**
 * Validate one config value against its field schema.
 *
 * Used by `portage config set`, so a bad value is rejected before it is ever
 * written to disk rather than surfacing on the next run.
 */
export function coerceConfigValue(key: string, raw: string): unknown {
  const field = (FIELD_SCHEMAS as Record<string, v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>)[key];
  if (!field) {
    const suggestion = nearestKey(key);
    throw usageError(
      `unknown config key: ${key}`,
      suggestion
        ? `did you mean "${suggestion}"? known keys: ${CONFIG_KEYS.join(", ")}`
        : `known keys: ${CONFIG_KEYS.join(", ")}`,
    );
  }

  // Try the natural TOML-ish literal first, then fall back to a bare string.
  const candidates: unknown[] = [raw];
  if (/^-?\d+(\.\d+)?$/.test(raw)) candidates.push(Number(raw));
  if (raw === "true" || raw === "false") candidates.push(raw === "true");
  if (raw.startsWith("[")) {
    try {
      candidates.push(JSON.parse(raw) as unknown);
    } catch {
      /* not JSON */
    }
  }

  let lastMessage = "no attempt succeeded";
  for (const candidate of candidates) {
    const result = v.safeParse(field, candidate);
    if (result.success) return result.output;
    lastMessage = result.issues[0]?.message ?? lastMessage;
  }

  throw usageError(`invalid value for ${key}: ${raw}`, lastMessage);
}

/** Levenshtein distance — small inputs only, so the naive DP is fine. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[n]!;
}

/** The closest known config key, or null when nothing is close enough. */
export function nearestKey(input: string): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  // Two edits is generous enough for a typo and tight enough to be a suggestion.
  const threshold = Math.min(3, Math.ceil(input.length / 3) + 1);

  for (const key of CONFIG_KEYS) {
    const score = editDistance(input.toLowerCase(), key.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return bestScore <= threshold ? best : null;
}