/**
 * Logging that respects --quiet/--verbose and never pollutes a TTY view.
 *
 * The TUI renderer owns stdout while it is mounted. These helpers write to
 * **stderr** so a stray log line can never corrupt a rendered frame.
 */

export type LogLevel = "silent" | "quiet" | "normal" | "verbose";

export interface Logger {
  level: LogLevel;
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** Raw stdout for command output — the only thing that owns stdout. */
  out(msg: string): void;
}

const PREFIX = "portage";

export function createLogger(level: LogLevel): Logger {
  const write = (stream: "out" | "err", msg: string) => {
    const text = `${msg}\n`;
    if (stream === "err") process.stderr.write(text);
    else process.stdout.write(text);
  };

  return {
    level,
    debug: (msg) => {
      if (level === "verbose") write("err", `  ${msg}`);
    },
    info: (msg) => {
      if (level === "normal" || level === "verbose") write("err", msg);
    },
    warn: (msg) => {
      if (level !== "silent" && level !== "quiet") write("err", `⚠ ${msg}`);
    },
    error: (msg) => {
      if (level !== "silent") write("err", `✗ ${msg}`);
    },
    out: (msg) => write("out", msg),
  };
}

/** A logger that discards everything — used by tests. */
export const silentLogger: Logger = {
  level: "silent",
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  out: () => {},
};

export { PREFIX };
