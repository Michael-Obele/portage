/**
 * `portage serve` — the engine's fourth entry point.
 *
 * One JSON command per line on stdin, one JSON frame per line on stdout. No
 * flags, no TTY behaviour, no colours: stdout IS the wire, so a single stray
 * debug print anywhere under `src/serve/` would corrupt a frame. Diagnostics go
 * to stderr, which the shell forwards separately.
 *
 * The loop's job is small and absolute: read a line, answer it exactly once,
 * never die. Everything interesting lives in `dispatch.ts`.
 *
 * This is ADDITIVE (D38). The CLI, the TUI, `--json` and every exit code are
 * unchanged; `serve` is a fourth way into the same functions.
 */
import type { Adb } from "../device/adb.ts";
import type { ResolvedConfig } from "../config/load.ts";
import { silentLogger, type Logger } from "../util/log.ts";

import {
  createContext,
  dispatch,
  type DispatchOutcome,
  type ServeContext,
} from "./dispatch.ts";
import { connect, type Frames, type Sink } from "./frames.ts";
import { PendingRegister } from "./pending.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { RunController } from "./run.ts";

export interface ServeOptions {
  /** Lines to consume. Defaults to stdin; tests pass an array. */
  lines?: Iterable<string> | AsyncIterable<string>;
  /** Where frames go. Defaults to stdout; tests pass an array collector. */
  sink?: Sink;
  pending?: PendingRegister;
  runs?: RunController;
  logger?: Logger;
  /** The engine's version, handed in by the CLI so it is never hardcoded here. */
  engineVersion?: string;
  resolveConfig?: () => Promise<ResolvedConfig>;
  adb?: () => Promise<Adb | null>;
}

/** Trimming a CRLF wire, not the line's content. */
function stripCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * stdin, one line at a time.
 *
 * Chunked, not `Bun.stdin.text()`: the wire is request/response, so reading to
 * EOF before answering the first command would deadlock every single request.
 */
async function* stdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  try {
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        yield stripCR(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) yield stripCR(buffer);
  } finally {
    // `shutdown` stops the loop without waiting for EOF, and a stdin stream
    // that is still open keeps the event loop alive: the process wrote `bye`,
    // returned 0, and then never ended. Cancelling the read is what ends it.
    await reader.cancel().catch(() => undefined);
  }
}

/** Build the context and the frame writers, then announce readiness. */
async function boot(
  opts: ServeOptions,
): Promise<{ ctx: ServeContext; frames: Frames; runs: RunController }> {
  const sink: Sink = opts.sink ?? ((line: string) => process.stdout.write(line));
  const frames = connect(sink);
  const runs = opts.runs ?? new RunController(frames);
  const ctx = createContext({
    frames,
    pending: opts.pending ?? new PendingRegister(),
    runs,
    logger: opts.logger ?? silentLogger,
    ...(opts.resolveConfig ? { resolveConfig: opts.resolveConfig } : {}),
    ...(opts.adb ? { adb: opts.adb } : {}),
  });
  return { ctx, frames, runs };
}

/**
 * Run the loop. Resolves with the process exit code.
 *
 * `ready` is written first and unconditionally: a shell that never sees it would
 * sit on a starting screen forever with no error, which is the exact failure a
 * last-frame buffer in the shell exists to prevent. A config error is therefore
 * reported as a `log` frame plus `destinationConfigured: false`, not as silence.
 */
export async function serve(opts: ServeOptions = {}): Promise<number> {
  const { ctx, frames, runs } = await boot(opts);

  let destinationConfigured = false;
  try {
    const resolved = await ctx.resolveConfig();
    destinationConfigured = Boolean(resolved.config.dest_root);
  } catch (err) {
    frames.log(
      "error",
      `config could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const adb = await ctx.adb().catch(() => null);

  frames.ready({
    protocolVersion: PROTOCOL_VERSION,
    engineVersion: opts.engineVersion ?? "unknown",
    platform: `${process.platform} ${process.arch}`,
    adbFound: adb !== null,
    adbPath: adb?.bin ?? null,
    adbSource: adb?.source ?? "none",
    destinationConfigured,
  });

  // An unhandled rejection must not end the loop. stderr only — stdout is the
  // wire, and a diagnostic written there would be read as a frame.
  const onRejection = (reason: unknown): void => {
    process.stderr.write(
      `portage serve: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`,
    );
  };
  process.on("unhandledRejection", onRejection);

  try {
    const lines = opts.lines ?? stdinLines();
    for await (const line of lines) {
      let outcome: DispatchOutcome;
      try {
        outcome = await dispatch(line, ctx);
      } catch (err) {
        // `dispatch` answers for every failure, so reaching this line is a bug
        // in the loop's own plumbing. Say so, and keep reading.
        frames.log(
          "error",
          `dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (outcome.stop) {
        frames.bye();
        runs.dispose();
        return 0;
      }
    }
    return 0;
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}
