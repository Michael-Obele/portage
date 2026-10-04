/**
 * Terminal cursor support.
 *
 * OpenTUI 0.5.14 has NO `CursorRenderable`. The cursor is a property of the
 * renderer, so "cursor support" means driving that property correctly rather
 * than adding a widget. The real API, read from the installed typings:
 *
 *   renderer.setCursorPosition(x, y, visible?)   // terminal cells
 *   renderer.setCursorStyle({ style, blinking, color, cursor })
 *   renderer.setCursorColor(color)
 *   renderer.getCursorState(): { x, y, visible, style, blinking, r, g, b, a }
 *   renderer.capabilities.explicit_cursor_positioning
 *
 * Three rules make this correct rather than decorative:
 *
 *   1. A full-screen TUI HIDES the cursor. A blinking block sitting in the
 *      middle of a progress dashboard is a bug, not a feature.
 *   2. It comes back only when the user is actually typing — that is, when the
 *      live-filter `InputRenderable` has focus. While an editor is focused,
 *      OpenTUI positions the cursor itself from the edit buffer, so this module
 *      MUST NOT fight it. Calling setCursorPosition on every tick would make the
 *      caret stutter, which is the classic bug here.
 *   3. It is restored on EVERY exit path: unmount, Ctrl-C, SIGTERM, an
 *      uncaught exception, an unhandled rejection. A terminal left without a
 *      cursor is a broken shell, and a CLI that does that is worse than no CLI.
 *
 * When `explicit_cursor_positioning` is false the terminal cannot be told where
 * the cursor is, so the honest behaviour is show/hide only, and `canPlace` is
 * false. We do not pretend otherwise.
 */
import type { CliRenderer } from "@opentui/core";

export type CursorStyleName = "block" | "line" | "underline" | "default";

export interface CursorPolicy {
  /** How the caret looks while the filter box has focus. */
  style: CursorStyleName;
  blinking: boolean;
}

export const DEFAULT_POLICY: CursorPolicy = { style: "line", blinking: true };

export class TerminalCursor {
  /** True once `restore()` has run, so teardown is idempotent. */
  private released = false;

  constructor(private readonly renderer: CliRenderer) {}

  /**
   * Can this terminal be told WHERE the cursor is, or only shown and hidden?
   * Null until capabilities have been probed (OpenTUI discovers them
   * asynchronously at startup), so treat null as "not yet".
   */
  get canPlace(): boolean {
    return this.renderer.capabilities?.explicit_cursor_positioning === true;
  }

  /**
   * Apply the policy.
   *
   * @param editorFocused  true when a text input owns the keyboard. OpenTUI then
   *   drives the cursor from the edit buffer and we only pick its STYLE.
   * @param placeAt        terminal cell coords, only used when we can place.
   */
  apply(editorFocused: boolean, placeAt?: { x: number; y: number }): void {
    if (this.released) return;
    const r = this.renderer;
    if (editorFocused) {
      r.setCursorStyle({ style: DEFAULT_POLICY.style, blinking: DEFAULT_POLICY.blinking });
      if (placeAt && this.canPlace) {
        r.setCursorPosition(placeAt.x, placeAt.y, true);
      } else {
        // Ask for visible without asserting a position we are not sure about.
        r.setCursorPosition(-1, -1, true);
      }
      return;
    }
    // No editor: hide. Position is irrelevant while hidden, and passing a stale
    // coordinate is how a hidden cursor ends up blinking in a corner.
    r.setCursorPosition(-1, -1, false);
  }

  /** Read the cursor back. Used by the acceptance run and the tests. */
  state(): { x: number; y: number; visible: boolean; style: CursorStyleName } {
    const s = this.renderer.getCursorState();
    return { x: s.x, y: s.y, visible: s.visible, style: s.style as CursorStyleName };
  }

  /**
   * Give the cursor back to the shell. Idempotent, and safe to call from a
   * signal handler after the renderer is already gone — every call is guarded.
   *
   * NOTE: the process-level guards (SIGINT / SIGTERM / uncaughtException /
   * unhandledRejection) live in renderer.svelte.ts as `installGuards`, because
   * they also need `unmount`. One implementation, not two — a signal path with
   * two copies is a signal path that will eventually only fix one.
   */
  restore(): void {
    if (this.released) return;
    this.released = true;
    try {
      if (this.renderer.isDestroyed) return;
      this.renderer.setCursorPosition(-1, -1, true);
      this.renderer.setCursorStyle({
        style: DEFAULT_POLICY.style,
        blinking: DEFAULT_POLICY.blinking,
      });
    } catch {
      // A renderer that is already torn down cannot be asked. The terminal is
      // restored by destroy() anyway; swallowing here is deliberate so a signal
      // handler never throws on its way out.
    }
  }
}