#!/usr/bin/env bun
/**
 * portage — move a phone's downloads onto an archive drive, safely.
 *
 * The entry point does four things and delegates everything else:
 *   1. parse argv
 *   2. resolve config (flags > env > drive > user > defaults)
 *   3. build the shared context (adb, output, logger)
 *   4. dispatch, then translate any error into the documented exit code
 *
 * Exit codes are part of the interface — scripts branch on them:
 *   0 success · 1 usage/config · 2 precondition · 3 transfer · 4 verification · 5 interrupted
 */

import { bool, int, parseArgs, str } from "./args.ts";
import { Adb } from "../device/adb.ts";
import { loadConfig, requireDestRoot } from "../config/load.ts";
import { CONFIG_KEYS } from "../config/schema.ts";
import { createOutput, type OutputMode } from "../output/output.ts";
import { createLogger, type LogLevel } from "../util/log.ts";
import { describeError, ExitCode, usageError } from "../util/errors.ts";
import { realSpawn } from "../util/spawn.ts";
import { doctor } from "./commands/doctor.ts";
import { plan, scan } from "./commands/scan.ts";
import { pull, purge, requestStop } from "./commands/pull.ts";
import { config, db, status } from "./commands/status.ts";

const VERSION = "0.1.0";

const COMMANDS = [
  [
    "doctor",
    "environment + device + drive report, with a fix for every problem",
  ],
  ["devices", "attached devices and their configured roots"],
  ["scan", "every file on the phone with an eligibility verdict (read-only)"],
  ["plan", "what `pull` would do: files, bytes, skips and why"],
  ["pull", "the real thing — verified transfer, deletion only after proof"],
  ["status", "journal view: runs, per-file state, what is still on the phone"],
  ["purge", "delete phone copies that are proven to be on the drive"],
  ["config", "get | set | keys — and the precedence chain that resolved them"],
  ["db", "info | vacuum | export — journal maintenance"],
] as const;

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  const args = parseArgs(argv);

  if (bool(args.flags, "version")) {
    process.stdout.write(`portage ${VERSION}\n`);
    return 0;
  }

  if (!args.command || bool(args.flags, "help")) {
    printHelp(args.command);
    return args.command && COMMANDS.some(([c]) => c === args.command)
      ? 0
      : args.command
        ? 1
        : 0;
  }

  // --- shared context --------------------------------------------------------
  const mode: OutputMode = bool(args.flags, "json")
    ? "json"
    : bool(args.flags, "plain") || !process.stdout.isTTY
      ? "plain"
      : "tty";

  const level: LogLevel = bool(args.flags, "verbose")
    ? "verbose"
    : bool(args.flags, "quiet")
      ? "quiet"
      : "normal";

  const output = createOutput(mode);
  const logger = createLogger(level);

  const cliOverrides: Record<string, unknown> = {};
  if (args.flags.jobs !== undefined)
    cliOverrides.jobs = int(args.flags, "jobs", 3);
  if (args.flags.transport !== undefined)
    cliOverrides.transport = str(args.flags, "transport");
  if (args.flags.quiet !== false && args.flags["quiet-seconds"] !== undefined) {
    cliOverrides.quiet_seconds = int(args.flags, "quiet-seconds", 120);
  }

  const resolved = await loadConfig({
    configPath: str(args.flags, "config") || undefined,
    destRoot: str(args.flags, "dest-root") || undefined,
    cliOverrides,
  });

  const adb = await Adb.create(realSpawn, resolved.config.adb_path);

  // --- signal handling -------------------------------------------------------
  // A `Ctrl-C` must leave the journal resumable and the terminal usable, so the
  // handler only sets a flag; the engine checks it between files.
  process.on("SIGINT", () => {
    if (!bool(args.flags, "plain", true)) process.stderr.write("\n");
    process.stderr.write(
      "\ninterrupted — finishing the current file, then stopping\n",
    );
    requestStop();
  });
  process.on("SIGTERM", requestStop);

  // --- dispatch --------------------------------------------------------------
  switch (args.command) {
    case "doctor":
      return await doctor({
        resolved,
        adb,
        output,
        bench: bool(args.flags, "bench"),
      });

    case "devices":
      return await devices({ resolved, adb, output });

    case "scan":
      return await scan({
        resolved,
        adb,
        output,
        deviceFilter: str(args.flags, "device") || undefined,
        show: str(args.flags, "show") || undefined,
        sinceSeconds: sinceSeconds(args.flags),
      });

    case "plan":
      return await plan({
        resolved,
        adb,
        output,
        deviceFilter: str(args.flags, "device") || undefined,
        show: str(args.flags, "show") || undefined,
        sinceSeconds: sinceSeconds(args.flags),
      });

    case "pull":
      return await pull({
        resolved,
        adb,
        output,
        logger,
        deviceFilter: str(args.flags, "device") || undefined,
        show: str(args.flags, "show") || undefined,
        sinceSeconds: sinceSeconds(args.flags),
        dryRun: bool(args.flags, "dry-run"),
        keepSource: bool(args.flags, "keep-source"),
        deleteSource: bool(args.flags, "delete-source"),
        verifyHash: bool(args.flags, "verify-hash"),
        jobs:
          args.flags.jobs !== undefined
            ? int(args.flags, "jobs", 3)
            : undefined,
      });

    case "purge":
      return await purge({
        resolved,
        adb,
        output,
        logger,
        dryRun: bool(args.flags, "dry-run"),
        verifyHash: bool(args.flags, "verify-hash"),
        keepSource: false,
        deleteSource: false,
      });

    case "status":
      return await status({
        resolved,
        output,
        limit: int(args.flags, "limit", 25),
      });

    case "config":
      return await config({
        resolved,
        output,
        positionals: args.positionals,
        flags: args.flags,
      });

    case "db":
      return await db({
        resolved,
        output,
        positionals: args.positionals,
        write: async (path, content) => {
          await Bun.write(path, content);
        },
      });

    default:
      throw usageError(
        `unknown command: ${args.command}`,
        `try one of: ${COMMANDS.map(([c]) => c).join(", ")}`,
      );
  }
}

/** `--since 7d` / `--since 36h` / `--since 900` (seconds). */
function sinceSeconds(
  flags: Record<string, string | boolean>,
): number | undefined {
  const raw = str(flags, "since");
  if (!raw) return undefined;
  const match = /^(\d+)([smhdw]?)$/.exec(raw.trim());
  if (!match) {
    throw usageError(`--since needs a value like 7d or 36h, got "${raw}"`);
  }
  const n = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit] ?? 1;
  return n * multiplier;
}

async function devices(ctx: {
  resolved: Awaited<ReturnType<typeof loadConfig>>;
  adb: Adb | null;
  output: ReturnType<typeof createOutput>;
}): Promise<number> {
  if (!ctx.adb) {
    throw usageError("adb is not available", "install Android platform-tools");
  }
  const all = await ctx.adb.devices();

  if (ctx.output.mode === "json") {
    ctx.output.emitJson({ devices: all });
    return 0;
  }

  const o = ctx.output;
  if (all.length === 0) {
    o.warn("no devices attached");
    return 2;
  }

  const roots = new Map<string, string[]>();
  for (const [id, cfg] of Object.entries(ctx.resolved.config.devices)) {
    roots.set(id, cfg.roots);
  }

  o.table(
    all.map((d) => [
      d.state,
      d.id.slice(0, 12),
      d.model || "—",
      d.android || "—",
      (roots.get(d.id) ?? []).length.toString(),
    ]),
    ["state", "id", "model", "android", "roots"],
  );
  o.line();
  o.line(
    "  the id is sha1(ro.serialno) — it is the key in the config, not the serial number",
  );
  return all.some((d) => d.state === "device") ? 0 : 2;
}

function printHelp(command: string | null): void {
  if (command) {
    const known = COMMANDS.find(([c]) => c === command);
    if (known) {
      process.stdout.write(`portage ${known[0]} — ${known[1]}\n`);
      return;
    }
  }

  process.stdout
    .write(`portage ${VERSION} — move a phone's downloads onto an archive drive, safely

USAGE
  portage <command> [flags]

COMMANDS
${COMMANDS.map(([name, desc]) => `  ${name.padEnd(10)} ${desc}`).join("\n")}

GLOBAL FLAGS
  --plain            no colour, no cursor control (default when piped)
  --json             machine-readable output
  --verbose          debug logging on stderr
  --quiet            errors only
  --config <path>    use a different config file
  --dest-root <path> override the destination for this run
  --version, --help

pull / scan / plan
  --device <id>      restrict to one device (id, serial, or model substring)
  --show <text>      only files whose path contains <text>
  --since 7d         only files modified within the window
  --jobs N           concurrent transfers (default 3)
  --keep-source      copy only; never delete the phone copy
  --delete-source    copy, then delete after verification
  --dry-run          show what would happen; change nothing

purge
  --dry-run          list what would go; delete nothing
  --verify-hash      recompute both hashes now instead of using the stored one

Not built yet: dupes, dedupe, trash, verify, retry, --organize.

config keys
  ${CONFIG_KEYS.join(", ")}
`);
}

try {
  process.exitCode = await main();
} catch (err) {
  const { message, fix, code } = describeError(err);
  process.stderr.write(`\n✗ ${message}\n`);
  if (fix) process.stderr.write(`  → ${fix}\n`);
  process.exitCode = code;
}

export { ExitCode, requireDestRoot };
