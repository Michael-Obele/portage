/**
 * What this terminal can do — detected once, read everywhere.
 *
 * The ladder already exists in src/output/output.ts for the plain renderer. The
 * TUI slots into it rather than replacing it. Each rung is independent and they
 * stack (docs/tui-impl/05-degradation.md):
 *
 *   --json                 machine output, no TUI at all
 *   !process.stdout.isTTY  plain behaviour, no TUI
 *   --plain                no colour, no cursor control, no alternate screen
 *   NO_COLOR               no colour; glyphs and layout stay
 *   TERM=dumb              no colour, no cursor control
 *   LANG not UTF-8         ASCII glyphs instead of `v > . D x # -`
 *   width < 80/60/50       drop bars / box drawing / truncate names to 30
 *
 * Screens read `caps` and NEVER re-derive it. Re-deriving is how a narrow
 * terminal ends up with a 20-cell bar inside a wrapped frame.
 */

export interface Capabilities {
  /** The only true when every condition allows a full-screen mount. */
  tui: boolean;
  color: boolean;
  unicode: boolean;
  width: number;
  height: number;
}

/**
 * Why the TUI did not mount, or null when it did.
 * The plain renderer prints this, so `portage pull | cat` explains itself
 * instead of silently losing the dashboard.
 */
export function refusalReason(argv: readonly string[]): string | null {
  if (argv.includes("--json")) return "--json";
  if (argv.includes("--plain")) return "--plain";
  if (!process.stdout.isTTY) return "stdout is not a terminal";
  if (Bun.env.TERM === "dumb") return "TERM=dumb";
  return null;
}

export function detect(argv: readonly string[] = Bun.argv): Capabilities {
  const tty = Boolean(process.stdout.isTTY);
  const dumb = Bun.env.TERM === "dumb";
  const reason = refusalReason(argv);
  const color = tty && !dumb && !Bun.env.NO_COLOR && !argv.includes("--plain");
  // UTF-8 check. LANG is the reliable one; TERM is a weak fallback (mirrors
  // detectUnicode() in src/output/output.ts so both renderers agree).
  const lang = Bun.env.LANG ?? Bun.env.LC_ALL ?? "";
  const unicode =
    tty && !dumb && /UTF-?8/i.test(lang)
      ? true
      : tty && !dumb && !lang && /UTF/i.test(Bun.env.TERM ?? "");
  return {
    tui: reason === null,
    color,
    unicode,
    width: Number(Bun.env.COLUMNS) || process.stdout.columns || 80,
    height: process.stdout.rows || 24,
  };
}

/** Cells in the overall bar. Fixed: a bar that changes width as the terminal
 * resizes reads as a different number, which is a lie. */
export const BAR_CELLS = 20;

/** What the current width allows. Dropped in this exact order. */
export interface Sizing {
  /** Per-file progress bars cost ~14 columns each. Below 80 they go. */
  bars: boolean;
  /** Box drawing below 60 falls back to plain spacing. */
  box: boolean;
  /** Names truncate in the MIDDLE below 50, so the extension and the release
   * tag survive — those are the parts a human scans for. */
  nameMax: number;
}

export function sizing(width: number): Sizing {
  return {
    bars: width >= 80,
    box: width >= 60,
    nameMax: width < 50 ? 30 : Number.POSITIVE_INFINITY,
  };
}