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

import { Adb, selectReady, type DeviceInfo } from "#lib/device/adb.ts";
import { listVolumes } from "#lib/device/volumes.ts";
import {
  coerceConfigValue,
  loadConfig,
  requireDestRoot,
  writeConfigFile,
  type ResolvedConfig,
} from "#lib/config/load.ts";
import { CONFIG_KEYS, FIELD_SCHEMAS, STATE_DIR } from "#lib/config/schema.ts";
import { Journal } from "#lib/index/journal.ts";
import { isMarkerFile, localDayKey } from "#lib/util/paths.ts";
import { probeDestination } from "#lib/index/recovery.ts";
import {
  buildPlan,
  destinationsFor,
  snapshotDestinations,
  type PlanResult,
} from "#lib/plan/plan.ts";
import { scanDevice, summarise, type Candidate } from "#lib/scan/scan.ts";
import { AdbTransport } from "#lib/xfer/adb.ts";
import { applyPurge, planPurge, type PurgePlan } from "#lib/xfer/purge.ts";
import { applySelection, scanDuplicates } from "#lib/dedupe/index.ts";
import { defaultScanIo, resilientScanIo } from "#lib/dedupe/scan-io.ts";
import { emptyTrash, readTrash } from "#lib/dedupe/trash.ts";
import { diskSpaceAsync, type DiskSpace } from "#lib/util/fs.ts";
import { PROBE_TIMEOUT_MS, breakerFor, probe, statDrive } from "#lib/util/probe.ts";
import type { Output } from "#lib/output/output.ts";
import { doctor as doctorCommand } from "#lib/serve/doctor.ts";
import { db as dbCommand } from "#lib/serve/db.ts";
import { silentLogger, type Logger } from "#lib/util/log.ts";
import { realSpawn, type SpawnFn } from "#lib/util/spawn.ts";
import {
  describeError,
  preconditionError,
  usageError,
} from "#lib/util/errors.ts";

import {
  BROWSE_LIMIT,
  browseLevel,
  browseTree,
  refuseMountPath,
} from "#lib/serve/browse.ts";
import type { Frames } from "#lib/serve/frames.ts";
import { PendingRegister } from "#lib/serve/pending.ts";
import { RunController, type PullRunArgs } from "#lib/serve/run.ts";
import {
  ArgsSchemas,
  COMMAND_TYPES,
  DoctorCheckSchema,
  EnvelopeSchema,
  isCommandType,
  type ArgsFor,
  type WireDupeGroup,
  type WireError,
} from "#lib/serve/protocol.ts";

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
  /** Test seam: the child-process spawner for drive reads. */
  spawn?: SpawnFn;
  /** Test seam: the deadline for one drive read. */
  probeTimeoutMs?: number;
}

export interface ContextInit {
  frames: Frames;
  pending?: PendingRegister;
  runs?: RunController;
  logger?: Logger;
  resolveConfig?: () => Promise<ResolvedConfig>;
  adb?: () => Promise<Adb | null>;
  spawn?: SpawnFn;
  probeTimeoutMs?: number;
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
    ...(init.spawn ? { spawn: init.spawn } : {}),
    ...(init.probeTimeoutMs ? { probeTimeoutMs: init.probeTimeoutMs } : {}),
  };
}

/**
 * Free space under its own deadline. `space: null` means df answered but could
 * not say; `ok: false` means the drive did not answer at all (R2.2).
 */
async function readFreeSpace(
  ctx: ServeContext,
  root: string,
): Promise<{ ok: true; space: DiskSpace | null } | { ok: false }> {
  const spawn = ctx.spawn ?? realSpawn;
  const deadlineMs = ctx.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  // A killed df must read as a timeout, not as "no number".
  const strict: SpawnFn = async (cmd, opts) => {
    const res = await spawn(cmd, opts);
    if (res.signal === "TIMEOUT") throw new Error("df timed out");
    return res;
  };
  const read = await probe(
    root,
    `df ${root}`,
    () => diskSpaceAsync(strict, root, deadlineMs),
    deadlineMs,
  );
  return read.kind === "ok" ? { ok: true, space: read.value } : { ok: false };
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

interface GatherResult {
  candidates: Candidate[];
  /** One entry per device that was skipped for having no source folders. */
  warnings: string[];
}

/**
 * Walk the selected devices and classify what comes back.
 *
 * Mirrors `gather()` in `src/cli/commands/scan.ts` and `src/tui/runner.ts` — the
 * same walk, the same rule that a device with no configured roots is skipped
 * rather than being an excuse to scan all of /sdcard.
 *
 * A skipped device is still skipped — but no longer SILENTLY. It comes back as
 * a warning, because "copied nothing" reported as success is the one answer a
 * pull must never give.
 */
async function gatherCandidates(
  adb: Adb,
  resolved: ResolvedConfig,
  devices: DeviceInfo[],
): Promise<GatherResult> {
  const { config } = resolved;
  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  for (const device of devices) {
    const deviceConfig = config.devices[device.id];
    const roots = deviceConfig?.roots ?? [];
    if (roots.length === 0) {
      warnings.push(
        `${device.model || device.serial}: no source folders are configured, so nothing on it will be copied. Add a folder on the Home screen (Phone folders).`,
      );
      continue;
    }
    const found = await scanDevice(adb, device, roots, {
      quietSeconds: config.quiet_seconds,
      deviceConfig,
    });
    candidates.push(...found.map(withoutMarkers));
  }
  return { candidates, warnings };
}

/**
 * Re-label a marker file so it is REPORTED as skipped rather than silently
 * dropped. Silence would make the plan's counts disagree with the phone.
 */
function withoutMarkers(candidate: Candidate): Candidate {
  if (!isMarkerFile(candidate.srcPath)) return candidate;
  if (candidate.verdict === "excluded") return candidate;
  return {
    ...candidate,
    verdict: "excluded",
    reason: "a folder marker, not media",
  };
}

/**
 * A plan is only as fresh as the filesystem it describes.
 *
 * `planPurge` trusts the journal's stored hash unless `verifyHash` is set, so a
 * drive copy deleted by hand since the transfer would still be offered for
 * deletion, and the plan would describe a file that no longer exists. The check
 * is one local `exists()` per candidate. It costs microseconds and reads the
 * local disk, so it cannot lie about it.
 *
 * Anything whose drive copy is gone is REFUSED, not dropped. A silent removal
 * would make the plan's counts disagree with what the person is looking at, and
 * "why is this file not in the list?" deserves an answer.
 *
 * The phone side is not checked here: `adb` has no cheap batch stat on this
 * path, and a file that has genuinely gone from the phone fails harmlessly at
 * `applyPurge`. `verifyHash: true` does check it, by re-reading both ends.
 */
export async function withFreshDriveCopies(
  plan: PurgePlan,
  root: string,
  deps: { statDrive?: typeof statDrive } = {},
): Promise<PurgePlan> {
  const stat = deps.statDrive ?? statDrive;
  const eligible: PurgePlan["eligible"] = [];
  const refused = [...plan.refused];
  for (const candidate of plan.eligible) {
    const seen = await stat(root, candidate.destPath);
    let reason: string | null = null;
    if (seen.kind === "missing") {
      reason = "the drive copy is gone — nothing was deleted";
    } else if (seen.kind === "unreadable") {
      reason = "drive copy unreadable";
    } else if (!seen.value.isFile) {
      reason = "the drive copy is not a file — nothing was deleted";
    }
    if (reason === null) eligible.push(candidate);
    else refused.push({ srcPath: candidate.srcPath, reason });
  }
  return {
    eligible,
    refused,
    bytesReclaimed: eligible.reduce((sum, candidate) => sum + candidate.size, 0),
  };
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
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit] ?? 1;
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
    if (
      sinceSeconds !== undefined &&
      nowSeconds - candidate.mtime > sinceSeconds
    ) {
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

  "config.get": async (args: ArgsFor<"config.get">, ctx: ServeContext) => {
    const resolved = await ctx.resolveConfig();
    if (args.key !== undefined) {
      // `Object.hasOwn`, not a lookup: `__proto__` and `toString` are on every
      // object, so a lookup answers for keys the config does not have — and an
      // answer with no value in it is exactly what the wire must never carry.
      if (!Object.hasOwn(resolved.config, args.key)) {
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

  "config.set": async (args: ArgsFor<"config.set">, ctx: ServeContext) => {
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

  "status.get": async (args: ArgsFor<"status.get">, ctx: ServeContext) => {
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
      ctx.frames.status({
        archive,
        counts,
        pending,
        runs,
        recent,
        ...(breakerFor(destRoot).tripped ? { driveUnreadable: true } : {}),
      });
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

  "db.export": async (args: ArgsFor<"db.export">, ctx: ServeContext) => {
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
    const gathered = await gatherCandidates(adb, resolved, devices);
    const candidates = applyWindow(gathered.candidates, args.show, args.since);
    // A scan frame has no warning field and its shape is the app's contract, so
    // a skipped device goes to the log channel — the one place it is not lost.
    for (const warning of gathered.warnings) ctx.logger.warn(warning);
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
    const gathered = await gatherCandidates(adb, resolved, devices);
    const journal = Journal.open(destRoot, ctx.logger);
    try {
      const [onDisk, space] = await Promise.all([
        snapshotDestinations(
          destRoot,
          destinationsFor(gathered.candidates, destRoot),
        ),
        probeDestination(realSpawn, destRoot),
      ]);
      const planned = buildPlan(gathered.candidates, {
        destRoot,
        journal,
        spaceHeadroom: resolved.config.space_headroom,
        show: args.show,
        sinceSeconds: parseSince(args.since),
        exclude: new Set(args.exclude ?? []),
        space,
        onDisk,
      });
      // `buildPlan` only ever sees the candidates it was handed, so a device
      // that contributed none is invisible to it. The gather warnings are the
      // other half of the picture, and they ride in a COPY of the plan: the
      // plan object is the frame, and the frame has to say why it is empty.
      const plan: PlanResult = {
        ...planned,
        warnings: [...planned.warnings, ...gathered.warnings],
      };
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

  "pull.start": async (args: ArgsFor<"pull.start">, ctx: ServeContext) => {
    const adb = await requireAdb(ctx);
    const resolved = await ctx.resolveConfig();
    // A config check — no scan, no journal, no run. A device with no source
    // folders has nothing to copy, and a run that "succeeds" having copied
    // nothing is worse than a refusal. ONE configured device is enough: a run
    // that legitimately finds no NEW files must still start, because resume and
    // journal reconciliation live inside it.
    const devices = await selectReady(adb, args.device);
    const anyRoots = devices.some(
      (device) => (resolved.config.devices[device.id]?.roots ?? []).length > 0,
    );
    if (!anyRoots) {
      throw preconditionError(
        "no source folders are configured, so there is nothing to copy",
        "add at least one folder on the Home screen (Phone folders), then start the pull again",
      );
    }
    const mode = args.mode ?? "keep";
    const run: PullRunArgs = {
      adb,
      resolved,
      logger: ctx.logger,
      deviceFilter: args.device,
      show: args.show,
      sinceSeconds: parseSince(args.since),
      jobs: args.jobs,
      exclude: args.exclude,
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
      // Progress goes on the WIRE, not just a debug log: a whole-drive scan can
      // run for hours and cannot be cancelled mid-command.
      onProgress: (message) => {
        ctx.logger.debug(message);
        ctx.frames.log("info", message);
      },
    });

    // The trash directory is computed ONCE, here, and stored — so the sheet the
    // UI shows and the directory the move lands in are the same string.
    const trashDir = join(
      destRoot,
      STATE_DIR,
      "trash",
      localDayKey(),
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
      unreadableFiles: report.unreadableFiles ?? 0,
      // Which walker ran, and how long it took. `via: "glob"` is the honest
      // explanation for a scan that took three minutes. `scanDuplicates` always
      // sets `io`; the fallback exists only so a hand-built report cannot crash
      // the wire, and it SAYS it does not know rather than blaming a walker.
      io: report.io ?? {
        via: "glob",
        elapsedMs: 0,
        dirs: 0,
        errors: [],
        errorCount: 0,
        deepest: null,
        depthLimited: 0,
        scannerError: "this report did not say which walker ran",
      },
    });
    return {
      scanId: entry.id,
      groups: groups.length,
      keys: paths.size,
      reclaimableBytes: report.reclaimableBytes,
      trashDir,
    };
  },

  "dupes.apply": async (args: ArgsFor<"dupes.apply">, ctx: ServeContext) => {
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

  "purge.plan": async (args: ArgsFor<"purge.plan">, ctx: ServeContext) => {
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
          root: destRoot,
        },
      );

      const fresh = await withFreshDriveCopies(plan, destRoot);
      plan.eligible = fresh.eligible;
      plan.refused = fresh.refused;
      plan.bytesReclaimed = fresh.bytesReclaimed;

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

  "purge.apply": async (args: ArgsFor<"purge.apply">, ctx: ServeContext) => {
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
      return {
        needsConfirm: true,
        actionId: entry.id,
        count: eligible.length,
        bytes,
      };
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
          root: entry.destRoot,
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

  /**
   * What the DRIVE's trash is still holding.
   *
   * This is the missing half of "reclaimable": `dupes.apply` moves a duplicate
   * to `.portage/trash/<date>/`, and on the same drive that frees nothing. The
   * number this returns is the space that is actually waiting to be freed, so a
   * screen can stop implying a move is a reclaim.
   */
  "trash.status": async (_args: unknown, ctx: ServeContext) => {
    const resolved = await ctx.resolveConfig();
    const destRoot = requireDestRoot(resolved.config);
    // The scanner is what makes this cheap, and a broken one must not turn a
    // read-only inventory into a refusal: `resilientScanIo` falls back and says
    // nothing, because a trash reading is not worth a failure band.
    const status = await readTrash(destRoot, resilientScanIo(defaultScanIo()).io);

    const entry = ctx.pending.insert({
      kind: "trash",
      paths: new Map(),
      sizes: new Map(),
      bytes: status.totalBytes,
      trashDir: status.root,
      destRoot,
      trashDays: status.days,
      trashLoose: status.loose,
    });

    ctx.frames.trash({
      trashId: entry.id,
      root: status.root,
      exists: status.exists,
      days: status.days,
      looseFiles: status.looseFiles,
      looseBytes: status.looseBytes,
      totalFiles: status.totalFiles,
      totalBytes: status.totalBytes,
    });

    const read = await readFreeSpace(ctx, destRoot);
    const space = read.ok ? read.space : null;
    return {
      trashId: entry.id,
      root: status.root,
      // `dayCount`, not `days`: the frame's `days` is a LIST, and one key
      // meaning a count in the answer and a list in the frame is how the next
      // change gets it wrong.
      dayCount: status.days.length,
      totalFiles: status.totalFiles,
      totalBytes: status.totalBytes,
      // Null means "the filesystem would not say", never zero.
      freeBytes: space?.free ?? null,
    };
  },

  /**
   * Permanently delete the trash. THE one irreversible delete in this app.
   *
   * The same spine as every other destructive call: the day folders come from a
   * pending record the engine issued, the whole call is refused if any requested
   * folder is not in that record, and `confirm` must equal the record id. A
   * mismatched confirm re-asks rather than acting.
   */
  "trash.empty": async (args: ArgsFor<"trash.empty">, ctx: ServeContext) => {
    const entry = ctx.pending.get(args.trashId);
    if (!entry || entry.kind !== "trash") {
      throw preconditionError(
        "that trash reading is not available any more",
        "run trash.status again — a reading expires after 10 minutes, and folders listed before a delete must not be deleted after one",
      );
    }

    const known = entry.trashDays ?? [];
    const loose = entry.trashLoose ?? [];
    // Omitted `days` means the whole trash; an array (even empty) means exactly
    // those days, so `{ days: [], loose: true }` addresses the loose files.
    const wholeTrash = args.days === undefined;
    const wantedDays = args.days ?? [];
    const wanted = wholeTrash ? known.map((day) => day.path) : wantedDays;
    const unknown = wanted.filter((path) => !known.some((day) => day.path === path));
    if (unknown.length > 0) {
      throw preconditionError(
        `refused: ${unknown.length} folder(s) are not part of this reading`,
        "run trash.status again and pick again; nothing was deleted",
      );
    }

    // Loose files are only in scope when they were asked for: the whole trash, or
    // an explicit `loose: true`. Emptying one day must not take them.
    const takeLoose = wholeTrash || args.loose === true;
    if (wanted.length === 0 && !takeLoose) {
      throw preconditionError(
        "refused: nothing was chosen to empty",
        "pick a day folder, or leave the choice out to empty the whole trash",
      );
    }
    const storedDays = known.filter((day) => wanted.includes(day.path));
    const storedCount = storedDays.reduce((total, day) => total + day.files, 0) + (takeLoose ? loose.length : 0);
    const storedBytes =
      storedDays.reduce((total, day) => total + day.bytes, 0) +
      (takeLoose ? Math.max(0, entry.bytes - known.reduce((total, day) => total + day.bytes, 0)) : 0);

    // Act on a FRESH reading: a folder deleted by name also takes anything moved
    // into it after the sheet was shown, so a changed reading re-asks.
    const io = resilientScanIo(defaultScanIo()).io;
    const fresh = await readTrash(entry.destRoot, io);
    const freshDays = fresh.days.filter((day) => wanted.includes(day.path));
    const freshCount = freshDays.reduce((total, day) => total + day.files, 0) + (takeLoose ? fresh.looseFiles : 0);
    const freshBytes = freshDays.reduce((total, day) => total + day.bytes, 0) + (takeLoose ? fresh.looseBytes : 0);
    const targets = [...freshDays.map((day) => day.path), ...(takeLoose ? fresh.loose : [])];

    const stale = freshCount !== storedCount || freshBytes !== storedBytes;
    if (args.confirm !== entry.id || stale) {
      // Keep the record truthful for the confirm that follows.
      entry.trashDays = fresh.days;
      entry.trashLoose = fresh.loose;
      entry.bytes = fresh.totalBytes;
      ctx.frames.needsConfirm({
        actionId: entry.id,
        action: "trash.empty",
        // The DAY FOLDERS (and loose files), not every file: a trash can hold
        // thousands of files, and a sheet is a decision aid, not a log.
        paths: targets,
        count: freshCount,
        bytes: freshBytes,
        trashDir: entry.trashDir,
      });
      return {
        needsConfirm: true,
        actionId: entry.id,
        count: freshCount,
        bytes: freshBytes,
        trashDir: entry.trashDir,
      };
    }

    // Refuse before deleting anything: a drive that cannot report its space is
    // not one to delete from.
    const before = await readFreeSpace(ctx, entry.destRoot);
    if (!before.ok) {
      throw preconditionError(
        "the destination could not be read; nothing was changed",
        "check the archive drive, then run trash.status again",
      );
    }
    const result = await emptyTrash(entry.destRoot, targets, io);
    // Already deleted: an unanswered read here is reported as unknown.
    const afterRead = await readFreeSpace(ctx, entry.destRoot);
    const after = afterRead.ok ? afterRead.space : null;

    ctx.frames.notice(
      result.refused.length > 0 ? "warn" : "info",
      `emptied ${result.removedDays} day folder(s): ${result.removedFiles} file(s), ${result.bytesFreed} byte(s) freed`,
    );

    // Drop THIS record only. `clear()` also wiped the duplicate scan the person
    // was still working through, so the second move on the screen failed with
    // "that duplicate scan is not available any more".
    ctx.pending.delete(entry.id);

    return {
      removedDays: result.removedDays,
      removedFiles: result.removedFiles,
      bytesFreed: result.bytesFreed,
      refused: result.refused,
      freeBytesBefore: before.space?.free ?? null,
      freeBytesAfter: after?.free ?? null,
      // R4.10: the path that ran, and why the Helper did not run.
      path: result.path,
      reason: result.reason ?? null,
    };
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
    answerError(ctx, id, usageError("that line is not JSON", COMMAND_HINT));
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
