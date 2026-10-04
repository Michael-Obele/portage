/**
 * Semantic colour names and the glyph set.
 *
 * Two rules from docs/tui.md §6 that this module exists to enforce:
 *
 *   1. The palette is SEMANTIC (ok / busy / warn / fail / dim / text / accent),
 *      never "green" or "#00ff00" scattered through a screen.
 *   2. Every semantic colour has a TEXT TWIN. A monochrome terminal loses
 *      nothing because the state is always glyph PLUS word.
 *
 * ARCHITECTURE (docs/tui-impl/01-architecture.md): this file does NOT import
 * @opentui/core. It holds names and hex values only; renderer.ts is the single
 * file that knows what an RGBA is. That is what keeps "swap the renderer" a
 * directory rather than a refactor.
 *
 * When colour is off, `palette()` returns undefined for every name. The
 * renderer paints undefined as the terminal default, so the layout is
 * byte-identical and only the ink disappears — which is what NO_COLOR must mean.
 */

export type Semantic =
  | "ok"
  | "busy"
  | "warn"
  | "fail"
  | "dim"
  | "text"
  | "accent"
  | "barFull"
  | "barEmpty";

/** A One Dark-ish palette. Values are hex strings. */
const HEX: Record<Semantic, string> = {
  ok: "#98c379",
  busy: "#61afef",
  warn: "#e5c07b",
  fail: "#e06c75",
  dim: "#5c6370",
  text: "#abb2bf",
  accent: "#c678dd",
  barFull: "#61afef",
  barEmpty: "#3e4451",
};

/** Hex string when colour is allowed, undefined when it is not. */
export type Palette = Record<Semantic, string | undefined>;

export function palette(color: boolean): Palette {
  const out = {} as Palette;
  for (const key of Object.keys(HEX) as Semantic[]) {
    out[key] = color ? HEX[key] : undefined;
  }
  return out;
}

// --- glyphs -----------------------------------------------------------------

/**
 * Glyph PLUS word, always. `LANG=C` gets the ASCII column; the word column is
 * identical, so nothing is carried by colour or by shape alone.
 */
export const GLYPH = {
  unicode: {
    done: "✓",
    copying: "▶",
    queued: "·",
    duplicate: "⤍",
    failed: "✗",
    paused: "⏸",
    barFull: "▓",
    barEmpty: "░",
    warn: "⚠",
  },
  ascii: {
    done: "v",
    copying: ">",
    queued: ".",
    duplicate: "D",
    failed: "x",
    paused: "||",
    barFull: "#",
    barEmpty: "-",
    warn: "!",
  },
} as const;

export function glyphs(unicode: boolean) {
  return unicode ? GLYPH.unicode : GLYPH.ascii;
}

/** Box drawing characters, dropped below 60 columns. */
export function boxChars(unicode: boolean) {
  return unicode
    ? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", ml: "├", mr: "┤" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", ml: "+", mr: "+" };
}