/**
 * Argument parsing.
 *
 * Hand-rolled rather than a framework, because the surface is small and the
 * failure messages matter more than the parser: "unknown flag `--jbs`" with a
 * suggestion beats a stack trace from a library.
 *
 * Supports `--flag`, `--flag=value`, `--flag value`, `--no-flag`, and short
 * aliases. Everything after a bare `--` is a positional.
 */

import { usageError } from "../util/errors.ts";

export interface ParsedArgs {
  command: string | null;
  subcommand: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const ALIASES: Record<string, string> = {
  v: "verbose",
  q: "quiet",
  j: "jobs",
  d: "device",
  n: "dry-run",
  h: "help",
  V: "version",
  r: "retries",
};

/** Flags that take a value. Anything else is boolean. */
const VALUE_FLAGS = new Set([
  "config",
  "dest-root",
  "device",
  "jobs",
  "show",
  "since",
  "transport",
  "season",
  "config-set",
  "config-get",
  "tier",
  "forward-port",
  "quiet-seconds",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let i = 0;
  let sawTerminator = false;

  while (i < argv.length) {
    const arg = argv[i] ?? "";

    if (sawTerminator) {
      positionals.push(arg);
      i++;
      continue;
    }

    if (arg === "--") {
      sawTerminator = true;
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      let body = arg.slice(2);
      let value: string | undefined;

      const eq = body.indexOf("=");
      if (eq !== -1) {
        value = body.slice(eq + 1);
        body = body.slice(0, eq);
      }

      // `--no-tui` and friends.
      let negated = false;
      if (body.startsWith("no-")) {
        negated = true;
        body = body.slice(3);
      }

      const key = ALIASES[body] ?? body;

      if (value === undefined && VALUE_FLAGS.has(key)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          throw usageError(
            `--${body} needs a value`,
            `example: --${body} <value>`,
          );
        }
        value = next;
        i++;
      }

      if (negated) {
        flags[key] = false;
      } else if (value !== undefined) {
        flags[key] = value;
      } else {
        flags[key] = true;
      }
      i++;
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) {
      const short = arg.slice(1);
      for (const ch of short) {
        const key = ALIASES[ch] ?? ch;
        if (VALUE_FLAGS.has(key)) {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith("-")) {
            throw usageError(`-${ch} needs a value`, `example: -${ch} <value>`);
          }
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
      i++;
      continue;
    }

    positionals.push(arg);
    i++;
  }

  return {
    command: positionals[0] ?? null,
    subcommand: positionals[1] ?? null,
    positionals: positionals.slice(1),
    flags,
  };
}

/** Read a flag as a string, or fall back. */
export function str(
  flags: ParsedArgs["flags"],
  key: string,
  fallback = "",
): string {
  const v = flags[key];
  return typeof v === "string" ? v : fallback;
}

/** Read a flag as a boolean. `--no-x` sets it to false. */
export function bool(
  flags: ParsedArgs["flags"],
  key: string,
  fallback = false,
): boolean {
  const v = flags[key];
  return typeof v === "boolean" ? v : fallback;
}

/** Read a flag as an integer, erroring clearly on a bad value. */
export function int(
  flags: ParsedArgs["flags"],
  key: string,
  fallback: number,
): number {
  const v = flags[key];
  if (typeof v !== "string") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw usageError(`--${key} must be a number, got "${v}"`);
  }
  return n;
}
