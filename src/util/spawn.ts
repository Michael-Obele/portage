/**
 * The one place that spawns processes.
 *
 * Every transport adapter takes an injectable spawn, which is what lets the
 * whole state machine be tested against **fake `adb` and `rsync` scripts** — no
 * phone, no drive, in CI. The fixtures are deliberately broken (one dies at
 * 60 %, one lies about its exit code, one returns a bad checksum) because a
 * happy-path-only test proves nothing about a tool whose whole job is not
 * deleting your files.
 *
 * stdin is always `"ignore"` (i.e. /dev/null). That is not incidental: `adb
 * shell` inherits our stdin, so inside a loop it swallows the rest of the input
 * and the loop silently reads nothing.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Wall-clock duration in ms, measured around the whole spawn. */
  durationMs: number;
  /** Signal that killed the process, if any. */
  signal?: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Hard cap. Default 120 s — long enough for a phone-side walk, short enough to not hang. */
  timeoutMs?: number;
  /** Called with stdout once the process exits. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Called once the process starts, with the handle for abort/kill. */
  onStart?: (proc: Bun.Subprocess) => void;
}

export type SpawnFn = (
  cmd: string[],
  opts?: RunOptions,
) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 120_000;

/** Shared subprocess killer used by both the signal path and the timeout path. */
function terminate(proc: Bun.Subprocess): void {
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

export const realSpawn: SpawnFn = async (cmd, opts = {}) => {
  const started = Bun.nanoseconds();
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...Bun.env, ...opts.env } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  opts.onStart?.(proc);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(proc);
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // Drain both pipes concurrently — reading one to completion first would
  // deadlock as soon as the other filled its pipe buffer.
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);

  // Replay the text to the listeners: we buffered for simplicity, and the
  // consumers (progress parsers) only need chunk ordering, which is preserved.
  if (opts.onStdout && stdout) opts.onStdout(stdout);
  if (opts.onStderr && stderr) opts.onStderr(stderr);

  const result: RunResult = {
    code: timedOut ? 124 : (exit ?? 0),
    stdout,
    stderr,
    durationMs: (Bun.nanoseconds() - started) / 1_000_000,
  };
  if (timedOut) result.signal = "TIMEOUT";
  return result;
};

/** Strip the `\r` that every Android shell command emits over adb. */
export function stripCR(s: string): string {
  return s.replace(/\r/g, "");
}

/** True when an executable resolves on PATH. */
export async function commandExists(cmd: string): Promise<boolean> {
  return (await Bun.which(cmd)) !== null;
}

/** Resolve an executable to an absolute path, honouring a config override. */
export async function resolveBinary(cmd: string, configuredPath = ""): Promise<string | null> {
  if (configuredPath) {
    try {
      await Bun.which(configuredPath);
      return configuredPath;
    } catch {
      return null;
    }
  }
  return await Bun.which(cmd);
}