#!/usr/bin/env bun
/**
 * The TUI entry point.
 *
 * Responsibilities, in order:
 *   1. detect what the terminal can do (degrade.ts) and REFUSE to mount when it
 *      cannot — `--json`, a pipe, `--plain` and `TERM=dumb` never see an
 *      alternate screen;
 *   2. fall back to the PLAIN command in exactly those cases, which is what makes
 *      the gate true: every action is reachable without the TUI;
 *   3. mount the dashboard, wire the transfer, and restore the terminal on every
 *      exit path.
 *
 * The refusal in (1) is not a fallback to a lesser screen. It IS the degradation
 * ladder: `portage pull | cat` produces the plain output, byte for byte, with no
 * escape sequence in it.
 */
import { bool, parseArgs, sinceSeconds, str } from "#lib/cli/args.ts";
import { Adb } from "#lib/device/adb.ts";
import { loadConfig } from "#lib/config/load.ts";
import { createLogger, type LogLevel } from "#lib/util/log.ts";
import { describeError, ExitCode } from "#lib/util/errors.ts";
import { realSpawn } from "#lib/util/spawn.ts";
import { pull } from "#lib/cli/commands/pull.ts";
import { createOutput } from "#lib/output/output.ts";

import { detect, refusalReason } from "#lib/tui/degrade.ts";
import { OpenTuiRenderer } from "#lib/tui/renderer.svelte.ts";
import { TransferSink } from "#lib/tui/sink.ts";
import { view } from "#lib/tui/state.svelte.ts";
import { createControl, startPull } from "#lib/tui/runner.ts";
import { DashboardScreen } from "#lib/tui/screens/dashboard.ts";
import { deferred } from "#lib/tui/deferred.ts";

/** A promise the dashboard settles when the user actually wants out. */

/**
 * `portage tui [flags]` — mount the dashboard.
 *
 * When the terminal cannot take it, this runs `portage pull --plain` instead and
 * says why on stderr. The refusal is printed, not swallowed: a user who typed
 * `tui` and got a wall of plain lines deserves to know why.
 */
export async function tui(argv: readonly string[] = Bun.argv): Promise<number> {
  const args = parseArgs([...argv]);
  const caps = detect(argv);
  const plain = createOutput("plain");

  const level: LogLevel = bool(args.flags, "verbose")
    ? "verbose"
    : bool(args.flags, "quiet")
      ? "quiet"
      : "normal";
  const logger = createLogger(level);

  const resolved = await loadConfig({
    configPath: str(args.flags, "config") || undefined,
    destRoot: str(args.flags, "dest-root") || undefined,
    cliOverrides:
      args.flags.jobs !== undefined ? { jobs: Number(args.flags.jobs) } : {},
  });
  const adb = await Adb.create(realSpawn, resolved.config.adb_path);

  // --- THE LADDER. No TTY, --json, --plain or TERM=dumb: plain behaviour. ---
  const refusal = refusalReason(argv);
  if (!caps.tui || !adb) {
    const why = refusal ?? "adb is not available";
    process.stderr.write(
      `portage: no TUI (${why}) — falling back to plain output\n`,
    );
    return await pull({
      resolved,
      adb,
      output: plain,
      deviceFilter: str(args.flags, "device") || undefined,
      show: str(args.flags, "show") || undefined,
      sinceSeconds: sinceSeconds(args.flags),
      dryRun: bool(args.flags, "dry-run"),
      keepSource: bool(args.flags, "keep-source"),
      deleteSource: bool(args.flags, "delete-source"),
      verifyHash: bool(args.flags, "verify-hash"),
      jobs: args.flags.jobs !== undefined ? Number(args.flags.jobs) : undefined,
      logger,
    });
  }

  const sink = new TransferSink();
  const control = createControl();
  const screen = new DashboardScreen();
  const renderer = new OpenTuiRenderer(argv);
  const quit = deferred<number>();

  let finished = false;

  screen.onTogglePause = () => {
    if (control.isPaused()) {
      control.resume();
      sink.onNotice("resumed");
      return false;
    }
    control.pause();
    sink.onNotice("pausing after the file in flight");
    return true;
  };
  screen.onRequestDupes = () => {
    view.notice = "the duplicate review opens with `portage dupes`";
  };

  // The screen owns the quit confirmation (gate C3) — nothing is stopped without a
  // second confirmation that says what it will do. This handler only acts once
  // the screen has decided that the answer was yes.
  screen.onRequestQuit = (hard) => {
    if (finished) {
      // The run is already over. `q` just leaves, with the run's own exit code.
      quit.settle(ExitCode.success);
      return;
    }
    // Mid-transfer. `control.stop()` does NOT preemption — the engine checks it
    // between files, so the file in flight finishes and verifies. That is what
    // keeps the journal resumable.
    control.stop();
    quit.settle(ExitCode.interrupted);
    void hard;
  };

  renderer.guard();
  await renderer.mount(screen);

  // The 200 ms tick is the same clock the dashboard's rate and ETA run on.
  const ticker = setInterval(() => sink.tick(Date.now()), 200);

  try {
    const handle = await startPull(
      {
        adb,
        resolved,
        logger,
        deviceFilter: str(args.flags, "device") || undefined,
        show: str(args.flags, "show") || undefined,
        sinceSeconds: sinceSeconds(args.flags),
        jobs:
          args.flags.jobs !== undefined ? Number(args.flags.jobs) : undefined,
        keepSource: bool(args.flags, "keep-source"),
        deleteSource: bool(args.flags, "delete-source"),
        control,
      },
      sink,
    );

    const summary = await handle.summary;
    finished = true;
    control.resume();
    sink.onNotice(
      summary.failed > 0
        ? `${summary.failed} failed — q to quit`
        : "done — every transferred file verified against the phone. q to quit",
    );

    // Stay on screen. Yanking the alternate buffer the moment the run ends is
    // how a user misses the one line that says four files failed.
    const code = await quit.promise;
    return summary.failed > 0 && code === ExitCode.success
      ? ExitCode.transfer
      : code;
  } catch (err) {
    finished = true;
    const { message, fix } = describeError(err);
    sink.onNotice(fix ? `${message} → ${fix}` : message);
    // A precondition failure has nothing to wait for: no transfer is running,
    // so `q` is the only way out and the user needs to read the reason.
    const code = await quit.promise;
    return code === ExitCode.success ? ExitCode.precondition : code;
  } finally {
    clearInterval(ticker);
    renderer.unmount();
  }
}

// Running `bun run src/tui/main.svelte.ts` directly: mount and hold the screen.
if (import.meta.main) {
  process.exitCode = await tui(Bun.argv);
}
