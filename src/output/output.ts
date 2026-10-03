/**
 * Output.
 *
 * Three shapes for every command, and the data behind them is identical:
 *
 *   --json    machine-readable. Scripts read this.
 *   --plain   no colour, no box drawing, no cursor games. Pipes read this.
 *   (default) a terminal gets colour; a pipe does not.
 *
 * The honesty rules from the TUI spec apply here too, because a script reading
 * a number deserves the same truth as a person watching a bar: an ETA built on
 * one sample is emitted as `null`, never as a confident guess.
 */

import {
  formatBytes,
  formatDuration,
  formatRate,
  truncateMiddle,
} from "../util/paths.ts";
import { formatDuration as fmtDuration } from "../util/paths.ts";

export type OutputMode = "tty" | "plain" | "json";

export interface Output {
  mode: OutputMode;
  color: boolean;
  unicode: boolean;
  width: number;
  /** Structured payload, emitted verbatim by `--json`. */
  emitJson(value: unknown): void;
  line(text?: string): void;
  heading(text: string): void;
  kv(key: string, value: string): void;
  ok(text: string): void;
  warn(text: string): void;
  fail(text: string): void;
  bullet(text: string): void;
  table(rows: string[][], headers?: string[]): void;
}

const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

/** Terminal width, clamped to something sane. */
function detectWidth(): number {
  const cols = Bun.env.COLUMNS ? Number(Bun.env.COLUMNS) : 0;
  if (Number.isFinite(cols) && cols > 0) return cols;
  const explicit = process.stdout.columns ?? 0;
  return explicit > 0 ? explicit : 100;
}

/** Can this terminal render the glyph set we want? */
function detectUnicode(): boolean {
  const lang = Bun.env.LANG ?? Bun.env.LC_ALL ?? "";
  if (!lang) return false;
  if (/UTF-?8/i.test(lang)) return true;
  return /UTF/i.test(Bun.env.TERM ?? "") && lang !== "";
}

export function createOutput(mode: OutputMode, width?: number): Output {
  const color = mode === "tty" && !Bun.env.NO_COLOR && Bun.env.TERM !== "dumb";
  const unicode = mode === "tty" && detectUnicode();
  const cols = width ?? detectWidth();

  const paint = (code: string, text: string) =>
    color ? `${code}${text}${RESET}` : text;
  const glyph = (unicodeSet: string, asciiSet: string) =>
    unicode ? unicodeSet : asciiSet;

  const write = (s: string) => process.stdout.write(`${s}\n`);

  return {
    mode,
    color,
    unicode,
    width: cols,

    emitJson(value) {
      write(JSON.stringify(value, null, 2));
    },

    line(text = "") {
      write(text);
    },

    heading(text) {
      write(paint(BOLD, text));
    },

    kv(key, value) {
      const padded = `${key}:`.padEnd(18);
      write(`  ${paint(DIM, padded)} ${value}`);
    },

    ok(text) {
      write(`${paint(GREEN, glyph("✓", ">"))} ${text}`);
    },

    warn(text) {
      write(`${paint(YELLOW, glyph("⚠", "!"))} ${text}`);
    },

    fail(text) {
      write(`${paint(RED, glyph("✗", "x"))} ${text}`);
    },

    bullet(text) {
      write(`  ${paint(DIM, glyph("·", "-"))} ${text}`);
    },

    table(rows, headers) {
      const all = headers ? [headers, ...rows] : rows;
      if (all.length === 0) return;

      const widths: number[] = [];
      for (const row of all) {
        row.forEach((cell, i) => {
          widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
        });
      }

      all.forEach((row, index) => {
        const line = row
          .map((cell, i) => {
            const w = widths[i] ?? 0;
            // The last column absorbs the slack rather than padding to a fixed
            // width, so long paths do not get chopped mid-name.
            return i === row.length - 1 ? cell : padVisible(cell, w);
          })
          .join("  ")
          .replace(/\s+$/, "");
        write(index === 0 && headers ? paint(BOLD, line) : line);
        if (index === 0 && headers)
          write(paint(DIM, "─".repeat(Math.min(cols, visibleLength(line)))));
      });
    },
  };
}

/** Rough width that ignores ANSI escapes. */
function visibleLength(s: string): number {
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function padVisible(s: string, width: number): string {
  const pad = width - visibleLength(s);
  return pad > 0 ? `${s}${" ".repeat(pad)}` : s;
}

export {
  formatBytes,
  formatDuration,
  formatRate,
  truncateMiddle,
  fmtDuration,
  BOLD,
  DIM,
  GREEN,
  YELLOW,
  RED,
};
