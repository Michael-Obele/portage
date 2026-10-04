/**
 * The dashboard — `portage pull`.
 *
 * Four bands, top to bottom, matching docs/tui.md §3.1:
 *
 *   devices  one line per device: link speed, readiness, free space
 *   overall  bytes, percent, a 20-cell bar, elapsed, both rates, ETA, counts
 *   queue    state glyph, name, size, and a per-file bar for the moving ones
 *   keys     the always-visible key hints
 *
 * The queue is the ONLY part that scrolls, and it is the only focusable pane on
 * this screen. Do not invent focus where there is nothing to focus.
 *
 * COLOUR TWINS: every row carries a glyph AND a word, and selection is painted
 * as a background rather than a colour, so `NO_COLOR` costs the user nothing.
 *
 * Imports come from `../renderer.ts`, never from `@opentui/core` — see the seam
 * note there.
 */
import {
  BoxRenderable,
  InputRenderable,
  type KeyEvent,
  ScrollBoxRenderable,
  TextRenderable,
  MAX_ROWS,
  type Screen,
  type ScreenContext,
} from "../renderer.svelte.ts";
import { bindingRows, resolve } from "../input.ts";
import {
  deviceLine,
  frame,
  header1,
  header2,
  keysLine,
  rowText,
  view,
  type Capabilities,
  type FileRow,
} from "../state.svelte.ts";
import { glyphs } from "../theme.ts";

/** Rows shown in the confirmation prompt before it will act. */
const CONFIRM_LIMIT = 8;

export class DashboardScreen implements Screen {
  readonly name = "dashboard" as const;

  private top!: TextRenderable;
  private bottom!: TextRenderable;
  private deviceTexts: TextRenderable[] = [];
  private devicesText!: TextRenderable;
  private head1!: TextRenderable;
  private head2!: TextRenderable;
  private keys!: TextRenderable;
  private noticeText!: TextRenderable;

  private queue!: ScrollBoxRenderable;
  private rowTexts: TextRenderable[] = [];

  private filterBox!: BoxRenderable;
  private filterInput!: InputRenderable;

  private logBox!: BoxRenderable;
  private logText!: TextRenderable;

  private overlay!: BoxRenderable;
  private overlayText!: TextRenderable;

  private confirmBox!: BoxRenderable;
  private confirmText!: TextRenderable;

  /** The user asked for something this screen cannot do alone. */
  onRequestDupes: (() => void) | null = null;
  onRequestQuit: (hard: boolean) => void = () => {};
  /** Supplied by the runner so `space` reaches the engine, not just the view. */
  onTogglePause: (() => boolean) | null = null;
  /** Supplied by the runner; returns true when the retry was accepted. */
  onRetryFailed: (() => boolean) | null = null;

  build(parent: BoxRenderable, ctx: ScreenContext): void {
    const renderer = ctx.ctx;
    const C = ctx.colors;
    const pct = "100%" as const;
    // `wrapMode: "none"` on every text renderable. The padding maths already
    // fits each row to the width, but a single stray long token must never be
    // allowed to wrap and break the frame — gate E3 is about the frame, not
    // about the maths.
    //
    // An explicit height on every fixed band.
    //
    // Left to content measurement, a TextRenderable measuring zero puts the next
    // band on the same row and the two texts overwrite each other. `top` and the
    // devices band were landing on row 0 together for exactly this reason. One
    // number per band is cheaper than trusting measurement.
    const text = (id: string, extra: Record<string, unknown> = {}) =>
      new TextRenderable(renderer, {
        id,
        width: pct,
        wrapMode: "none",
        flexShrink: 0,
        ...extra,
      });
    const line = (id: string, extra: Record<string, unknown> = {}) =>
      text(id, { height: 1, ...extra });

    // --- frame edges
    this.top = line("d-top", { fg: C.dim });
    this.bottom = line("d-bottom", { fg: C.dim });

    // --- band 1: devices
    //
    // ONE renderable holding every device line, not a band of invisible
    // children. A BoxRenderable whose children are all `visible: false` measures
    // as zero height, so the next band lands on the same row and the two texts
    // overwrite each other — which is exactly what a percentage-height band did.
    // A single TextRenderable with newlines has an unambiguous height.
    this.devicesText = text("d-devices", { fg: C.text });

    // --- band 2: overall
    this.head1 = line("d-head1", { fg: C.text });
    this.head2 = line("d-head2", { fg: C.dim });

    // --- the live filter. Focused input is the ONLY place the cursor is shown.
    this.filterBox = new BoxRenderable(renderer, {
      id: "d-filter",
      width: pct,
      flexDirection: "row",
      gap: 1,
      visible: false,
    });
    this.filterInput = new InputRenderable(renderer, {
      id: "d-filter-input",
      flexGrow: 1,
      placeholder: "filter by path",
    });
    // Listen for `input`, not `change`. InputRenderable emits CHANGE on commit and
    // INPUT on every edit, so a `change` handler never sees what you are typing —
    // the filter silently stays empty while the box fills up in front of you.
    const onFilterEdit = () => {
      view.filter = this.filterInput.value;
      view.scrollTop = 0;
    };
    this.filterInput.on("input", onFilterEdit);
    this.filterInput.on("change", onFilterEdit);
    this.filterBox.add(
      new TextRenderable(renderer, {
        content: "filter",
        width: 6,
        fg: C.accent,
        wrapMode: "none",
      }),
    );
    this.filterBox.add(this.filterInput);

    // --- band 3: the queue. flexGrow:1 makes it the only band taking the slack,
    // so the frame itself never scrolls.
    this.queue = new ScrollBoxRenderable(renderer, {
      id: "d-queue",
      width: pct,
      flexGrow: 1,
      minHeight: 3,
      scrollY: true,
      scrollX: false,
    });
    this.rowTexts = [];

    // --- the event log pane (`l`). The data already exists:
    // Journal.recentEvents() is implemented and called from nowhere.
    this.logBox = new BoxRenderable(renderer, {
      id: "d-log",
      width: pct,
      height: 8,
      visible: false,
      border: true,
      borderColor: C.dim,
    });
    this.logText = text("d-log-text", { fg: C.dim });
    this.logBox.add(this.logText);

    // --- footer
    this.noticeText = line("d-notice", { fg: C.warn });
    this.keys = line("d-keys", { fg: C.dim });

    // --- overlays
    this.overlay = new BoxRenderable(renderer, {
      id: "d-overlay",
      width: pct,
      flexGrow: 1,
      visible: false,
      zIndex: 100,
      padding: 1,
    });
    this.overlayText = text("d-overlay-text", { fg: C.text, flexGrow: 1 });
    this.overlay.add(this.overlayText);

    this.confirmBox = new BoxRenderable(renderer, {
      id: "d-confirm",
      width: pct,
      height: 6,
      visible: false,
      zIndex: 110,
    });
    this.confirmText = text("d-confirm-text", { fg: C.warn, flexGrow: 1 });
    this.confirmBox.add(this.confirmText);

    // Order is the band order.
    parent.add(this.top);
    parent.add(this.devicesText);
    parent.add(this.head1);
    parent.add(this.head2);
    parent.add(this.filterBox);
    parent.add(this.queue);
    parent.add(this.logBox);
    parent.add(this.noticeText);
    parent.add(this.keys);
    parent.add(this.bottom);
    parent.add(this.overlay);
    parent.add(this.confirmBox);
  }

  paint(ctx: ScreenContext): void {
    const caps = ctx.caps;
    const size = ctx.size;
    const now = Date.now();
    const C = ctx.colors;

    const [top, bottom] = frame(
      caps,
      size,
      `portage  ${view.overall.filesTotal} files`,
    );
    this.top.content = top;
    this.bottom.content = bottom;

    // --- band 1: devices. Link speed first: a USB 2 cable must be visible at once.
    if (view.devices.length === 0) {
      this.devicesText.content = "";
    } else {
      this.devicesText.content = view.devices
        .map((d) => deviceLine(d, caps, size))
        .join("\n");
      const anyNotReady = view.devices.some((d) => !d.ready);
      this.devicesText.fg = anyNotReady ? C.warn : C.text;
    }

    // --- band 2: overall. The numbers obey docs/tui.md §5, not taste.
    this.head1.content = header1(caps, size);
    this.head2.content = header2(caps);

    // --- band 3: the queue
    const visible = this.visibleRows();
    const height = Math.max(3, caps.height - 13);
    this.rowWidth = caps.width;
    this.ensureRows(visible.length, ctx.ctx);
    this.clampScroll(visible, height);

    for (let i = 0; i < this.rowTexts.length; i++) {
      const row = visible[view.scrollTop + i];
      const t = this.rowTexts[i]!;
      t.visible = row !== undefined;
      if (!row) continue;
      const selected = view.rows[view.selected] === row;
      t.content = rowText(row, view.scrollTop + i, selected, caps, size, now);
      t.fg = this.colorFor(row, ctx);
      // Selection is a BACKGROUND, so it survives NO_COLOR and a monochrome
      // terminal. Colour alone would fail gate E2. TextRenderable spells it `bg`.
      t.bg = selected ? "#2c313a" : undefined;
    }

    this.queue.scrollTop = view.scrollTop;

    // --- footer
    this.keys.content = keysLine(caps);
    this.noticeText.content = view.notice ?? "";

    if (this.logBox.visible) {
      const lines = view.log
        .slice(-6)
        .map((e) => `${e.level.padEnd(5)} ${e.msg}`);
      this.logText.content = lines.join("\n") || "(no events)";
    }

    this.overlay.visible = view.screen === "help";
    if (this.overlay.visible) this.overlayText.content = this.helpText(caps);

    this.confirmBox.visible = view.confirm !== null;
    if (view.confirm) {
      // Size the box to its content. Without an explicit height it flexes and
      // the LAST line — the [y]/[n] prompt, the one thing a person needs to see —
      // is the line that gets clipped off the bottom.
      const lines = view.confirm.detail.length + 3; // title, blank, prompt
      this.confirmBox.height = lines;
      this.confirmText.content = this.confirmText_();
    }

    // THE RULE: mutating `.content` does not schedule a frame. Miss this and the
    // screen freezes while the state insists it changed.
    ctx.requestRender();
  }

  onKey(key: KeyEvent, ctx: ScreenContext): boolean {
    // 1. The filter owns the keyboard while it is open.
    if (view.filterActive) {
      if (key.name === "escape") {
        this.closeFilter(ctx);
        return true;
      }
      if (key.name === "enter") {
        view.filterActive = false;
        this.filterBox.visible = false;
        this.filterInput.blur();
        ctx.cursor.apply(false);
        ctx.requestRender();
        return true;
      }
      return true; // the Input consumes everything else
    }

    // The confirmation gate has priority over every other key. Nothing is deleted
    // or stopped without a second confirmation that NAMES what it will do.
    if (view.confirm) {
      if (key.name === "y" || key.name === "Y") {
        const action = view.confirm.action;
        view.confirm = null;
        if (action === "quit") {
          this.quitArmed = false;
          this.onRequestQuit(false);
        }
        ctx.requestRender();
        return true;
      }
      // "no" — the transfer keeps running and nothing moves.
      view.confirm = null;
      this.quitArmed = false;
      ctx.requestRender();
      return true;
    }

    // 3. Everything else goes through the one binding table.
    const action = resolve(key);
    if (!action) return false;

    switch (action) {
      case "quit":
        // A running transfer asks first, and answering no leaves it running
        // (gate C3). `Q` is the explicit "I meant to stop" and never asks.
        if (!this.quitArmed && this.transferRunning()) {
          this.quitArmed = true;
          view.confirm = {
            title: "A transfer is running. Stop after the file in flight?",
            detail: [
              "phone copies already deleted stay deleted",
              "the journal keeps everything not yet verified, and the next run resumes",
              "nothing else is written to the drive after this point",
            ],
            action: "quit",
          };
          ctx.requestRender();
          return true;
        }
        this.quitArmed = false;
        this.onRequestQuit(false);
        return true;
      case "quit-hard":
        this.onRequestQuit(true);
        return true;
      case "toggle-pause": {
        const paused = this.onTogglePause?.() ?? false;
        view.overall.paused = paused;
        ctx.requestRender();
        return true;
      }
      case "down":
        this.move(1, ctx);
        return true;
      case "up":
        this.move(-1, ctx);
        return true;
      case "page-down":
        this.move(10, ctx);
        return true;
      case "page-up":
        this.move(-10, ctx);
        return true;
      case "top":
        view.selected = 0;
        view.scrollTop = 0;
        ctx.requestRender();
        return true;
      case "bottom":
        view.selected = Math.max(0, view.rows.length - 1);
        ctx.requestRender();
        return true;
      case "help":
        view.screen = view.screen === "help" ? "dashboard" : "help";
        ctx.requestRender();
        return true;
      case "cancel":
        view.screen = "dashboard";
        ctx.requestRender();
        return true;
      case "toggle-filter":
        view.filterActive = true;
        this.filterBox.visible = true;
        // The `/` that opened the filter is dispatched to the input in the same
        // tick it focuses it, so it would land in the box as the first
        // character. Clear it rather than making the user backspace.
        this.filterInput.value = "";
        view.filter = "";
        this.filterInput.focus();
        // `focus()` marks the renderable; `focusRenderable` is what routes keys
        // to it. Both are needed — one without the other types nothing.
        ctx.ctx.focusRenderable(this.filterInput);
        // Cursor ON, because the user is typing. The only visible state.
        ctx.cursor.apply(true);
        ctx.requestRender();
        return true;
      case "toggle-log":
        this.logBox.visible = !this.logBox.visible;
        if (this.logBox.visible) this.loadLog();
        ctx.requestRender();
        return true;
      case "retry-failed":
        view.notice = this.onRetryFailed?.()
          ? "retrying the failed files"
          : "nothing to retry";
        ctx.requestRender();
        return true;
      case "open-dupes":
        this.onRequestDupes?.();
        return true;
      default:
        view.notice = `${action} is not wired yet`;
        ctx.requestRender();
        return true;
    }
  }

  dispose(ctx: ScreenContext): void {
    // Give the cursor back even if we unmounted while the filter was focused.
    ctx.cursor.apply(false);
  }

  // --- internals ------------------------------------------------------------

  private move(delta: number, ctx: ScreenContext): void {
    view.selected = Math.max(
      0,
      Math.min(view.rows.length - 1, view.selected + delta),
    );
    ctx.requestRender();
  }

  private closeFilter(ctx: ScreenContext): void {
    view.filterActive = false;
    view.filter = "";
    this.filterInput.value = "";
    this.filterBox.visible = false;
    this.filterInput.blur();
    ctx.ctx.blurRenderable(this.filterInput);
    ctx.cursor.apply(false);
    ctx.requestRender();
  }

  /** Is there still work in flight? Derived from state, never from a flag. */
  private transferRunning(): boolean {
    const o = view.overall;
    return o.filesTotal > o.filesDone + o.failed + o.skipped;
  }

  /** True while the quit prompt is up, so a confirmed `q` acts and a re-press
   * after "no" asks again. */
  private quitArmed = false;

  /**
   * Grow the pool of row renderables as the queue grows, up to MAX_ROWS.
   * A row renderable past the end is hidden rather than destroyed, because a
   * shrinking plan is rare and a churning Yoga tree is not free.
   *
   * `ctx.ctx` is the RenderContext every renderable is constructed with — a
   * ScrollBox is not one, and passing the box here is a type error for a reason.
   */
  private ensureRows(count: number, renderer: ScreenContext["ctx"]): void {
    const want = Math.min(MAX_ROWS, count);
    while (this.rowTexts.length < want) {
      const t = new TextRenderable(renderer, {
        id: `d-row-${this.rowTexts.length}`,
        // An explicit COLUMN COUNT, not "100%". Inside a ScrollBox the content
        // box is measured against its own children, so a percentage width
        // resolves against the viewport in a way that clips the tail of a long
        // row. The renderer's own width is known, so use it.
        width: this.rowWidth,
        wrapMode: "none",
      });
      t.visible = false;
      this.rowTexts.push(t);
      this.queue.add(t);
    }
    // Re-pin on resize so the rows track the terminal rather than lagging one
    // frame behind it.
    if (this.rowTexts[0] && this.rowTexts[0]!.width !== this.rowWidth) {
      for (const t of this.rowTexts) t.width = this.rowWidth;
    }
  }
  /** The width every row is pinned to. Set from the context at the top of paint. */
  private rowWidth = 100;

  private visibleRows(): FileRow[] {
    const needle = view.filter.trim().toLowerCase();
    if (!needle) return view.rows;
    return view.rows.filter(
      (r) =>
        r.srcPath.toLowerCase().includes(needle) ||
        r.destPath.toLowerCase().includes(needle),
    );
  }

  /**
   * Keep the selected row visible. A selection that scrolls off screen is the
   * most common TUI bug there is, so this runs after EVERY move, and the
   * selection is an index into `view.rows` while the scroll offset is an index
   * into the FILTERED list — so the two are related by identity, not by index.
   */
  private clampScroll(visible: FileRow[], height: number): void {
    const target = visible.indexOf(view.rows[view.selected]!);
    const idx = target >= 0 ? target : 0;
    if (idx < view.scrollTop) view.scrollTop = idx;
    if (idx >= view.scrollTop + height) view.scrollTop = idx - height + 1;
    const maxTop = Math.max(0, visible.length - height);
    view.scrollTop = Math.max(0, Math.min(view.scrollTop, maxTop));
  }

  private colorFor(row: FileRow, ctx: ScreenContext) {
    switch (row.state) {
      case "done":
        return ctx.colors.ok;
      case "copying":
        return ctx.colors.busy;
      case "failed":
        return ctx.colors.fail;
      case "skipped":
      case "duplicate":
        return ctx.colors.warn;
      default:
        return ctx.colors.text;
    }
  }

  private loadLog(): void {
    const from = view.log;
    view.log = from.slice(-200);
  }

  private confirmText_(): string {
    const c = view.confirm!;
    const shown = c.detail.slice(0, CONFIRM_LIMIT);
    const rest = c.detail.length - shown.length;
    return [
      c.title,
      ...shown.map((d) => `  ${d}`),
      ...(rest > 0 ? [`  … and ${rest} more`] : []),
      "",
      "[y] yes    [n] no",
    ].join("\n");
  }

  private helpText(caps: Capabilities): string {
    const g = glyphs(caps.unicode);
    void g;
    return [
      "portage — keys",
      "",
      ...bindingRows().map(([k, d]) => `  ${k.padEnd(10)} ${d}`),
      "",
      "  the mouse works too, but nothing needs it",
      "  [?] or [esc] closes this",
    ].join("\n");
  }
}
