/**
 * `type` -> handler, and the one-answer rule.
 *
 * EVERY command produces exactly ONE `answer` frame for its `id`, including on
 * throw. That single rule is what stops the UI having a spinner that never ends
 * — so it is enforced here, in one place, rather than trusted to fifteen
 * handlers.
 *
 * A handler returns the `data` for its answer, or throws. Throwing is the
 * failure channel: `describeError` turns it into a sentence plus a fix, and a
 * stack trace never reaches the wire.
 *
 * THE SAFETY SPINE lives in `dupes.apply` / `purge.apply`: they never accept a
 * path. They accept opaque keys the engine issued, look them up in the
 * pending-action register, and refuse the WHOLE call if any key is unknown —
 * there is no partial delete.
 */
import { join } from "node:path";
import * as v from "valibot";

import { Adb, type DeviceInfo } from "../device/adb.ts";
import { listVolumes } from "../device/volumes.ts";
import {
  coerceConfigValue,
  loadConfig,
  requireDestRoot,
  writeConfigFile,
  type ResolvedConfig,
} from "../config/load.ts";
import { CONFIG_KEYS, FIELD_SCHEMAS, STATE_DIR } from "../config/schema.ts";
import { Journal } from "../index/journal.ts";
import { buildPlan } from "../plan/plan.ts";
import { scanDevice, summarise, type Candidate } from "../scan/scan.ts";
import { AdbTransport } from "../xfer/adb.ts";
import { applyPurge, planPurge } from "../xfer/purge.ts";
import { applySelection, scanDuplicates } from "../dedupe/index.ts";
import type { Output } from "../output/output.ts";
import { doctor as doctorCommand } from "../cli/commands/doctor.ts";
import { db as dbCommand } from "../cli/commands/status.ts";
import { silentLogger, type Logger } from "../util/log.ts";
import { realSpawn } from "../util/spawn.ts";
import {
  describeError,
  preconditionError,
  usageError,
} from "../util/errors.ts";

import { BROWSE_LIMIT, browseLevel, browseTree, refuseMountPath } from "./browse.ts";
import type { Frames } from "./frames.ts";
import { PendingRegister } from "./pending.ts";
import { RunController, type PullRunArgs } from "./run.ts";
import {
  ArgsSchemas,
  COMMAND_TYPES,
  DoctorCheckSchema,
  EnvelopeSchema,
  isCommandType,
  type ArgsFor,
  type WireDupeGroup,
  type WireError,
} from "./protocol.ts";

/** What a caller sees when a line is not a command. */
export const COMMAND_HINT =
  'one JSON object per line, for example {"v":1,"id":"1","type":"volumes.list","args":{}}';

// --- the context ------------------------------------------------------------

export interface ServeContext {
  frames: Frames;
  pending: PendingRegister;
  runs: RunController;
  logger: Logger;
  /** Re-read per command, so a `config.set` takes effect on the next one. */
  resolveConfig(): Promise<ResolvedConfig>;
  /** adb, resolved once. Null when it is not installed. */
  adb(): Promise<Adb | null>;
}

export interface ContextInit {
  frames: Frames;
  pending?: PendingRegister;
  runs?: RunController;
  logger?: Logger;
  resolveConfig?: () => Promise<ResolvedConfig>;
  adb?: () => Promise<Adb | null>;
}

export function createContext(init: ContextInit): ServeContext {
  const resolveConfig =
    init.resolveConfig ?? (() => loadConfig().then((r) => r));

  let adbOnce: Promise<Adb | null> | null = null;
  const adb =
    init.adb ??
    (() => {
      adbOnce ??= (async () => {
        const resolved = await resolveConfig();
        return Adb.create(realSpawn, resolved.config.adb_path);
      })();
      return adbOnce;
    });

  return {
    frames: init.frames,
    pending: init.pending ?? new PendingRegister(),
    runs: init.runs ?? new RunController(init.frames),
    logger: init.logger ?? silentLogger,
    resolveConfig,
    adb,
  };
}

// --- shared helpers ---------------------------------------------------------

/**
 * Capture an `Output` instead of printing it.
 *
 * The CLI's `doctor`, `status` and `db` are written against `Output`; `serve`
 * reuses those functions rather than reimplementing their checks, and captures
 * their JSON payload instead of their prose. Nothing is written to stdout by
 * this object — the wire is untouched.
 */
export interface Capture {
  output: Output;
  /** Every `emitJson` payload, in order. */
  payloads: unknown[];
  /** Every prose line, kept so a caller can forward it as a `log` frame. */
  lines: string[];
}

export function captureOutput(): Capture {
  const payloads: unknown[] = [];
  const lines: string[] = [];
  const output: Output = {
    mode: "json",
    color: false,
    unicode: false,
    width: 120,
    emitJson: (value) => {
      payloads.push(value);
    },
    line: (text = "") => {
      lines.push(text);
    },
    heading: (text) => lines.push(text),
    kv: (key, value) => lines.push(`${key}: ${value}`),
    ok: (text) => lines.push(text),
    warn: (text) => lines.push(text),
    fail: (text) => lines.push(text),
    bullet: (text) => lines.push(text),
    table: (rows) => {
      for (const row of rows) lines.push(row.join("  "));
    },
  };
  return { output, payloads, lines };
}

/** The devices a command may act on, honouring an optional filter. */
async function selectReady(adb: Adb, filter?: string): Promise<DeviceInfo[]> {
  const all = await adb.devices();
  const ready = all.filter((d) => d.state === "device");
  if (ready.length === 0) {
    throw preconditionError(
      "no device is attached and authorised",
      "plug in a phone, enable USB debugging, and accept the RSA prompt",
    );
  }
  if (!filter) return ready;
  const matched = ready.filter(
    (d) =>
      d.id.startsWith(filter) ||
      d.serial === filter ||
      d.model.toLowerCase().includes(filter.toLowerCase()),
  );
  if (matched.length === 0) {
    const available = ready
      .map((d) => `${d.id.slice(0, 12)}…  ${d.model || d.serial}`)
      .join("; ");
    throw preconditionError(
      `no attached device matches "${filter}"`,
      `attached devices: ${available}`,
    );
  }
  return matched;
}

/** One device, for a command that only needs a shell (browsing). */
async function pickDevice(adb: Adb, filter?: string): Promise<DeviceInfo> {
  const ready = await selectReady(adb, filter);
  const first = ready[0];
  if (!first) {
    throw preconditionError("no device is attached and authorised");
  }
  return first;
}

async function requireAdb(ctx: ServeContext): Promise<Adb> {
  const adb = await ctx.adb();
  if (!adb) {
    throw preconditionError(
      "adb is not available",
      "install Android platform-tools, or set adb_path in config",
    );
  }
  return adb;
}

/**
 * Walk the selected devices and classify what comes back.
 *
 * Mirrors `gather()` in `src/cli/commands/scan.ts` and `src/tui/runner.ts` — the
 * same walk, the same rule that a device with no configured roots is skipped
 * rather than being an excuse to scan all of /sdcard.
 */
async function gatherCandidates(
  adb: Adb,
  resolved: ResolvedConfig,
  devices: DeviceInfo[],
): Promise<Candidate[]> {
  const { config } = resolved;
  const all: Candidate[] = [];
  for (const device of devices) {
    const deviceConfig = config.devices[device.id];
    const roots = deviceConfig?.roots ?? [];
    if (roots.length === 0) continue;
    const found = await scanDevice(adb, device, roots, {
      quietSeconds: config.quiet_seconds,
      deviceConfig,
    });
    all.push(...found);
  }
  return all;
}

/** `7d` / `36h` / `900`. Mirrors `src/cli/index.ts` (and the TUI's copy). */
function parseSince(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = /^(\d+)([smhdw]?)$/.exec(raw.trim());
  if (!match) {
    throw usageError(
      `since needs a value like 7d or 36h, got "${raw}"`,
      'try "7d", "36h", or a number of seconds',
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier =
    { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit] ?? 1;
  return amount * multiplier;
}

/**
 * Apply `show` / `since` to a scan.
 *
 * `scan` refuses to accept an argument it does nothing with: a silently ignored
 * filter is how someone concludes the phone is empty.
 */
function applyWindow(
  candidates: Candidate[],
  show: string | undefined,
  since: string | undefined,
): Candidate[] {
  const sinceSeconds = parseSince(since);
  if (!show && sinceSeconds === undefined) return candidates;
  const needle = show?.toLowerCase();
  const nowSeconds = Date.now() / 1000;
  return candidates.filter((candidate) => {
    if (needle && !candidate.srcPath.toLowerCase().includes(needle)) {
      return false;
    }
    if (sinceSeconds !== undefined && nowSeconds - candidate.mtime > sinceSeconds) {
      return false;
    }
    return true;
  });
}

/** The roots a duplicate report spans: `dest_root` plus any extra `roots`. */
function rootsFor(resolved: ResolvedConfig): string[] {
  const roots = new Set<string>();
  for (const root of resolved.config.roots) roots.add(root);
  roots.add(requireDestRoot(resolved.config));
  return [...roots];
}

/**
 * The advice for `overwrite`.
 *
 * The engine never overwrites: `matchArchive` reports a same-name/different-size
 * file as a collision and skips it, so a re-download can never replace an
 * archive copy. Saying so beats accepting a flag that does nothing.
 */
function refuseOverwrite(command: string): never {
  throw usageError(
    `${command}: overwrite is not supported`,
    "portage never replaces a file on the drive: a name collision is reported and skipped, so the archive copy is never overwritten",
  );
}

/** Validate one config value from the wire, reusing the CLI's coercion. */
function validateConfigValue(key: string, value: unknown): unknown {
  if (typeof value === "string") return coerceConfigValue(key, value);
  const field = (FIELD_SCHEMAS as Record<string, v.GenericSchema>)[key];
  if (field === undefined) {
    throw usageError(
      `unknown config key: ${key}`,
      `known keys: ${CONFIG_KEYS.join(", ")}`,
    );
  }
  const parsed = v.safeParse(field, value);
  if (!parsed.success) {
    throw usageError(
      `${key} is invalid: ${firstIssue(parsed.issues)}`,
      `known keys: ${CONFIG_KEYS.join(", ")}`,
    );
  }
  return parsed.output;
}

function firstIssue(issues: readonly v.BaseIssue<unknown>[]): string {
  const first = issues[0];
  if (!first) return "invalid";
  const path = first.path?.map((p) => String(p.key)).join(".") ?? "";
  return path ? `${path}: ${first.message}` : first.message;
}

/** The id a line claims, even when the rest of the line is junk. */
function idOfLine(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
      const value = (parsed as { id: unknown }).id;
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    /* not JSON — the caller gets the placeholder below */
  }
  return "?";
}

// --- the handlers -----------------------------------------------------------

/** Each handler is typed with the args ITS OWN schema produced. */
const handlerTable = {
  "volumes.list": async (_args: unknown, ctx: ServeContext) => {
    const volumes = await listVolumes(realSpawn);
    ctx.frames.volumes(volumes);
    return { count: volumes.length };
  },

  "devices.list": async (_args: unknown, ctx: ServeContext) => {
    const adb = await ctx.adb();
    // No adb is not an error here: the UI wants "no phones", not a failure.
    const devices = adb ? await adb.devices() : [];
    ctx.frames.devices(devices);
    return { count: devices.length, adbFound: adb !== null };
  },

  "config.get": async (
    args: ArgsFor<"config.get">,
    ctx: ServeContext,
  ) => {
    const resolved = await ctx.resolveConfig();
    if (args.key) {
      const known = (resolved.config as Record<string, unknown>)[args.key];
      if (known === undefined) {
        throw usageError(
          `unknown config key: ${args.key}`,
          `known keys: ${CONFIG_KEYS.join(", ")}`,
        );
      }
    }
    // The frame always carries the whole resolved config with its per-key
    // precedence; the answer echoes the single key when one was asked for.
    ctx.frames.config({
      config: resolved.config,
      origins: resolved.origins,
      sources: resolved.sources,
    });
    if (!args.key) return { keys: CONFIG_KEYS.length };
    return {
      key: args.key,
      value: (resolved.config as Record<string, unknown>)[args.key],
      origin: resolved.origins[args.key] ?? "default",
    };
  },

  "config.set": async (
    args: ArgsFor<"config.set">,
    ctx: ServeContext,
  ) => {
    const resolved = await ctx.resolveConfig();
    const value = validateConfigValue(args.key, args.value);
    await writeConfigFile(resolved.sources.userPath, { [args.key]: value });
    ctx.frames.notice(
      "info",
      `${args.key} = ${JSON.stringify(value)} written to ${resolved.sources.userPath}`,
    );
    // Re-read, so the frame shows what the NEXT command will see.
    const after = await ctx.resolveConfig();
    ctx.frames.config({
      config: after.config,
      origins: after.origins,
      sources: after.sources,
    });
    return { key: args.key, value, path: resolved.sources.userPath };
  },

  "status.get": async (
    args: ArgsFor<"status.get">,
    ctx: ServeContext,
  ) => {
    const resolved = await ctx.resolveConfig();
    const destRoot = requireDestRoot(resolved.config);
    const journal = Journal.open(destRoot, ctx.logger);
    try {
      const archive = journal.countArchive();
      const counts = journal.countByState();
      const pending = journal.listPendingPurge();
      const allRuns = journal.listRuns(10);
      const runs =
        typeof args.run === "number"
          ? allRuns.filter((run) => run.id === args.run)
          : allRuns;
      const recent = journal.listRecent(args.limit ?? 25);
      ctx.frames.status({ archive, counts, pending, runs, recent });
      return {
        destRoot,
        runs: runs.length,
        pending: pending.length,
        recent: recent.length,
      };
    } finally {
      journal.close();
    }
  },

  doctor: async (args: ArgsFor<"doctor">, ctx: ServeContext) => {
    const resolved = await ctx.resolveConfig();
    const adb = await ctx.adb();
    const capture = captureOutput();
    // Forward every prose line as a log frame — a doctor that printed a warning
    // the shell never sees is a doctor whose advice is lost.
    const code = await doctorCommand({
      resolved,
      adb,
      output: capture.output,
      bench: args.bench,
    });
    for (const line of capture.lines) ctx.frames.log("info", line);

    const shape = v.safeParse(
      v.strictObject({ ok: v.boolean(), checks: v.array(DoctorCheckSchema) }),
      capture.payloads.at(-1),
    );
    if (!shape.success) {
      ctx.frames.notice(
        "warn",
        "doctor produced a report this build cannot read — see the log frames",
      );
      ctx.frames.doctor({ ok: false, checks: [] });
      return { checks: 0, exitCode: code, unreadable: true };
    }
    ctx.frames.doctor(shape.output);
    return {
      checks: shape.output.checks.length,
      failed: shape.output.checks.filter((c) => c.status === "fail").length,
      exitCode: code,
    };
  },

  "db.export": async (
    args: ArgsFor<"db.export">,
    ctx: ServeContext,
  ) => {
    const resolved = await ctx.resolveConfig();
    const capture = captureOutput();
    await dbCommand({
      resolved,
      output: capture.output,
      positionals: ["export", args.path],
      write: async (path, content) => {
        await Bun.write(path, content);
      },
    });
    for (const line of capture.lines) ctx.frames.log("info", line);
    ctx.frames.notice("info", `journal exported to ${args.path}`);
    return { path: args.path };
  },

  browse: async (args: ArgsFor<"browse">, ctx: ServeContext) => {
    // Before adb: a desktop mount is the wrong input whether or not a phone is
    // connected, and the advice must not depend on one being plugged in.
    refuseMountPath(args.path);
    const adb = await requireAdb(ctx);
    const device = await pickDevice(adb, args.device);
    const depth = args.depth ?? 1;
    const result =
      depth > 1
        ? await browseTree(adb, device.serial, args.path, depth, BROWSE_LIMIT)
        : await browseLevel(adb, device.serial, args.path, BROWSE_LIMIT);
    ctx.frames.browse({
      path: args.path,
      depth,
      entries: result.entries,
      total: result.total,
      truncated: result.truncated,
    });
    return {
      device: device.id,
      path: args.path,
      entries: result.entries.length,
      total: result.total,
      truncated: result.truncated,
    };
  },

  scan: async (args: ArgsFor<"scan">, ctx: ServeContext) => {
    const adb = await requireAdb(ctx);
    const resolved = await ctx.resolveConfig();
    const devices = await selectReady(adb, args.device);
    const found = await gatherCandidates(adb, resolved, devices);
    const candidates = applyWindow(found, args.show, args.since);
    const counts = summarise(candidates);
    ctx.frames.scan({ candidates, counts });
    return {
      devices: devices.length,
      total: candidates.length,
      counts,
    };
  },

  plan: async (args: ArgsFor<"plan">, ctx: ServeContext) => {
    if (args.overwrite) refuseOverwrite("plan");
    const adb = await requireAdb(ctx);
    const resolved = await ctx.resolveConfig();
    const destRoot = requireDestRoot(resolved.config);
    const devices = await selectReady(adb, args.device);
    const candidates = await gatherCandidates(adb, resolved, devices);
    const journal = Journal.open(destRoot, ctx.logger);
    try {
      const plan = buildPlan(candidates, {
        destRoot,
        journal,
        spaceHeadroom: resolved.config.space_headroom,
        show: args.show,
        sinceSeconds: parseSince(args.since),
      });
      ctx.frames.plan(plan);
      return {
        fileCount: plan.fileCount,
        bytesTotal: plan.bytesTotal,
        bytesSkipped: plan.bytesSkipped,
        skipped: plan.skipped.length,
        spaceOk: plan.space.ok,
        warnings: plan.warnings.length,
        // jobs is a TRANSFER setting; a plan is read-only, so it is echoed
        // rather than applied, and the answer says as much.
        jobsAtPullTime: args.jobs ?? null,
      };
    } finally {
      journal.close();
    }
  },

  "pull.start": async (
    args: ArgsFor<"pull.start">,
    ctx: ServeContext,
  ) => {
    const adb = await requireAdb(ctx);
    const resolved = await ctx.resolveConfig();
    const mode = args.mode ?? "keep";
    const run: PullRunArgs = {
      adb,
      resolved,
      logger: ctx.logger,
      deviceFilter: args.device,
      show: args.show,
      sinceSeconds: parseSince(args.since),
      jobs: args.jobs,
      keepSource: mode === "keep",
      deleteSource: mode === "delete-after-verify",
    };
    const started = await ctx.runs.start(run);
    if (!started.ok) throw preconditionError(started.reason, started.fix);
    return {
      runId: started.runId,
      mode,
      note: "pause and stop take effect between files, never mid-file",
    };
  },

  "pull.pause": async (_args: unknown, ctx: ServeContext) => {
    const result = ctx.runs.pause();
    if (!result.ok) {
      throw preconditionError(
        "no transfer is running",
        "start one with pull.start",
      );
    }
    return { paused: true, effect: result.effect };
  },

  "pull.resume": async (_args: unknown, ctx: ServeContext) => {
    const result = ctx.runs.resume();
    if (!result.ok) {
      throw preconditionError(
        "no transfer is running",
        "start one with pull.start",
      );
    }
    return { paused: false, effect: result.effect };
  },

  "pull.stop": async (_args: unknown, ctx: ServeContext) => {
    const result = ctx.runs.stop();
    if (!result.ok) {
      throw preconditionError(
        "no transfer is running",
        "start one with pull.start",
      );
    }
    return { effect: result.effect };
  },

  "dupes.scan": async (args: ArgsFor<"dupes.scan">, ctx: ServeContext) => {
    const resolved = await ctx.resolveConfig();
    const destRoot = requireDestRoot(resolved.config);
    const roots =
      args.roots && args.roots.length > 0 ? args.roots : rootsFor(resolved);

    const report = await scanDuplicates({
      roots,
      tier: args.tier,
      suggest: true,
      onProgress: (message) => ctx.logger.debug(message),
    });

    // The trash directory is computed ONCE, here, and stored — so the sheet the
    // UI shows and the directory the move lands in are the same string.
    const trashDir = join(
      destRoot,
      STATE_DIR,
      "trash",
      new Date().toISOString().slice(0, 10),
    );

    const paths = new Map<string, string>();
    const sizes = new Map<string, number>();
    let index = 0;
    const groups: WireDupeGroup[] = report.groups.map((group) => ({
      id: group.id,
      tier: group.tier,
      reason: group.reason,
      label: group.label,
      reclaimableBytes: group.reclaimableBytes,
      members: group.members.map((member) => {
        // The key is the ONLY thing the UI may send back. It names no path.
        const key = `k${index++}`;
        paths.set(key, member.path);
        sizes.set(key, member.size);
        return {
          key,
          path: member.path,
          relative: member.relative,
          size: member.size,
          hash: member.hash,
          keep: member.keep,
          score: member.score,
          scoreReason: member.scoreReason,
          suspicious: member.suspicious,
        };
      }),
    }));

    const entry = ctx.pending.insert({
      kind: "dupes",
      paths,
      sizes,
      bytes: [...sizes.values()].reduce((total, n) => total + n, 0),
      trashDir,
      destRoot,
      report,
    });

    ctx.frames.dupes({
      scanId: entry.id,
      groups,
      tier1Count: report.tier1Count,
      tier2Count: report.tier2Count,
      reclaimableBytes: report.reclaimableBytes,
      scannedFiles: report.scannedFiles,
      scannedBytes: report.scannedBytes,
      truncated: report.truncated,
      unparsed: report.unparsed,
    });
    return {
      scanId: entry.id,
      groups: groups.length,
      keys: paths.size,
      reclaimableBytes: report.reclaimableBytes,
      trashDir,
    };
  },

  "dupes.apply": async (
    args: ArgsFor<"dupes.apply">,
    ctx: ServeContext,
  ) => {
    const entry = ctx.pending.get(args.scanId);
    if (!entry || entry.kind !== "dupes" || !entry.report) {
      throw preconditionError(
        "that duplicate scan is not available any more",
        "run dupes.scan again — a scan expires after 10 minutes, and a key from a scan nobody is looking at must never move a file",
      );
    }

    // ANY unknown key refuses the WHOLE call. Not a partial move: a selection
    // that half-exists is a selection the person never reviewed.
    const unknownKeys = args.keys.filter((key) => !entry.paths.has(key));
    if (unknownKeys.length > 0) {
      throw preconditionError(
        `refused: ${unknownKeys.length} key(s) are not part of this scan`,
        "the scan changed under you — run dupes.scan again and re-select; nothing was moved",
      );
    }

    const paths: string[] = [];
    for (const key of args.keys) {
      const path = entry.paths.get(key);
      if (path !== undefined) paths.push(path);
    }
    const bytes = args.keys.reduce(
      (total, key) => total + (entry.sizes.get(key) ?? 0),
      0,
    );

    // The confirm gate. Anything but this scan's own id answers with the sheet
    // again rather than acting — a mismatched confirm is a stale sheet.
    if (args.confirm !== entry.id) {
      ctx.frames.needsConfirm({
        actionId: entry.id,
        action: "dupes.apply",
        paths,
        count: paths.length,
        bytes,
        trashDir: entry.trashDir,
      });
      return {
        needsConfirm: true,
        actionId: entry.id,
        count: paths.length,
        bytes,
        trashDir: entry.trashDir,
      };
    }

    const result = await applySelection(entry.report, paths, {
      destRoot: entry.destRoot,
      ...(entry.trashDir ? { trashRoot: entry.trashDir } : {}),
    });
    ctx.frames.notice(
      result.refused.length > 0 ? "warn" : "info",
      `moved ${result.moved.length} file(s) to trash; ${result.refused.length} refused`,
    );
    return {
      moved: result.moved,
      refused: result.refused,
      bytesMoved: result.bytesMoved,
      trashDir: entry.trashDir,
    };
  },

  "purge.plan": async (
    args: ArgsFor<"purge.plan">,
    ctx: ServeContext,
  ) => {
    const adb = await requireAdb(ctx);
    const resolved = await ctx.resolveConfig();
    const destRoot = requireDestRoot(resolved.config);
    const devices = await selectReady(adb, undefined);
    const journal = Journal.open(destRoot, ctx.logger);
    try {
      const plan = await planPurge(
        new Map(devices.map((device) => [device.id, device])),
        adb,
        {
          journal,
          transport: new AdbTransport(adb),
          verifyHash: args.verifyHash,
          dryRun: true,
          apply: false,
        },
      );

      const paths = new Map<string, string>();
      const sizes = new Map<string, number>();
      const eligible = plan.eligible.map((candidate, index) => {
        const key = `k${index}`;
        paths.set(key, candidate.srcPath);
        sizes.set(key, candidate.size);
        return { key, ...candidate };
      });

      const entry = ctx.pending.insert({
        kind: "purge",
        paths,
        sizes,
        bytes: plan.bytesReclaimed,
        trashDir: null,
        destRoot,
        plan,
      });

      ctx.frames.purgePlan({
        planId: entry.id,
        eligible,
        refused: plan.refused,
        bytesReclaimed: plan.bytesReclaimed,
      });
      return {
        planId: entry.id,
        eligible: eligible.length,
        refused: plan.refused.length,
        bytesReclaimed: plan.bytesReclaimed,
      };
    } finally {
      journal.close();
    }
  },

  "purge.apply": async (
    args: ArgsFor<"purge.apply">,
    ctx: ServeContext,
  ) => {
    const entry = ctx.pending.get(args.planId);
    if (!entry || entry.kind !== "purge" || !entry.plan) {
      throw preconditionError(
        "that purge plan is not available any more",
        "run purge.plan again — a plan expires after 10 minutes, and a key from a plan nobody is looking at must never delete a file",
      );
    }

    const unknownKeys = args.keys.filter((key) => !entry.paths.has(key));
    if (unknownKeys.length > 0) {
      throw preconditionError(
        `refused: ${unknownKeys.length} key(s) are not part of this plan`,
        "run purge.plan again and re-select; nothing was deleted",
      );
    }

    const chosen = new Set<string>();
    for (const key of args.keys) {
      const path = entry.paths.get(key);
      if (path !== undefined) chosen.add(path);
    }
    const eligible = entry.plan.eligible.filter((c) => chosen.has(c.srcPath));
    const bytes = eligible.reduce((total, c) => total + c.size, 0);

    if (args.confirm !== entry.id) {
      ctx.frames.needsConfirm({
        actionId: entry.id,
        action: "purge.apply",
        paths: eligible.map((c) => c.srcPath),
        count: eligible.length,
        bytes,
        trashDir: null,
      });
      return { needsConfirm: true, actionId: entry.id, count: eligible.length, bytes };
    }

    // Everything above is a gate. The transport does not exist until all of
    // them have passed, so a refused call cannot reach the phone at all.
    const adb = await requireAdb(ctx);
    const journal = Journal.open(entry.destRoot, ctx.logger);
    try {
      const result = await applyPurge(
        { ...entry.plan, eligible },
        {
          journal,
          transport: new AdbTransport(adb),
          verifyHash: false,
          dryRun: false,
          apply: true,
        },
      );
      ctx.frames.notice(
        result.failed > 0 ? "warn" : "info",
        `purged ${result.deleted} file(s) from the phone; ${result.failed} refused`,
      );
      return { deleted: result.deleted, failed: result.failed };
    } finally {
      journal.close();
    }
  },

  shutdown: async (_args: unknown, ctx: ServeContext) => {
    // Drop the run without a terminal frame: the process is about to exit 0, and
    // writing `run` into a closing pipe would lose it anyway.
    ctx.runs.dispose();
    return { stopping: true };
  },
};

/**
 * A `Record` cannot carry per-key parameter types, so the table is viewed once
 * as an untyped handler. The args have already been validated against THIS
 * key's schema immediately before the call, which is the whole reason the cast
 * is safe.
 */
const HANDLERS = handlerTable as unknown as Record<
  string,
  (args: unknown, ctx: ServeContext) => Promise<unknown>
>;

// --- the answer, and the loop's entry point ---------------------------------

function answer(
  ctx: ServeContext,
  id: string,
  ok: boolean,
  data?: unknown,
  error?: WireError,
): void {
  ctx.frames.answer({
    id,
    ok,
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error }),
  });
}

/** A failure, with the fix, and never a stack. */
function answerError(ctx: ServeContext, id: string, err: unknown): void {
  const { message, fix, code } = describeError(err);
  answer(ctx, id, false, undefined, { code, message, fix: fix ?? "" });
}

export interface DispatchOutcome {
  /** True when the caller should write `bye` and exit 0. */
  stop: boolean;
}

/**
 * One line in, exactly one `answer` out.
 *
 * Every path through this function — junk, a bad envelope, an unknown type, bad
 * args, a thrown handler — ends at an `answer` frame. Never a stack trace, and
 * never silence.
 */
export async function dispatch(
  line: string,
  ctx: ServeContext,
): Promise<DispatchOutcome> {
  const raw = line.trim();
  const id = idOfLine(raw);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    answerError(
      ctx,
      id,
      usageError("that line is not JSON", COMMAND_HINT),
    );
    return { stop: false };
  }

  const envelope = v.safeParse(EnvelopeSchema, payload);
  if (!envelope.success) {
    answerError(
      ctx,
      id,
      usageError(
        `bad command envelope: ${firstIssue(envelope.issues)}`,
        COMMAND_HINT,
      ),
    );
    return { stop: false };
  }

  const type = envelope.output.type;
  if (!isCommandType(type)) {
    answerError(
      ctx,
      envelope.output.id,
      usageError(
        `unknown command: ${type}`,
        `try one of: ${COMMAND_TYPES.join(", ")}`,
      ),
    );
    return { stop: false };
  }

  const argsSchema = ArgsSchemas[type] as v.GenericSchema;
  const args = v.safeParse(argsSchema, envelope.output.args);
  if (!args.success) {
    answerError(
      ctx,
      envelope.output.id,
      usageError(`${type}: ${firstIssue(args.issues)}`, COMMAND_HINT),
    );
    return { stop: false };
  }

  const handler = HANDLERS[type];
  if (!handler) {
    answerError(
      ctx,
      envelope.output.id,
      usageError(
        `no handler for ${type}`,
        "this build has a hole in its command table — report it",
      ),
    );
    return { stop: false };
  }

  try {
    const data = await handler(args.output, ctx);
    answer(ctx, envelope.output.id, true, data);
  } catch (err) {
    answerError(ctx, envelope.output.id, err);
  }
  return { stop: type === "shutdown" };
}
