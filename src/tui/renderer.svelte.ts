/**
 * The Renderer interface and its OpenTUI implementation.
 *
 * NOTHING OUTSIDE THIS FILE IMPORTS `@opentui/core`. That is the whole point of
 * the seam (docs/tui.md §6, "the renderer is one directory"): the copy engine,
 * the journal and the duplicate engine never see it, and swapping it is a
 * directory rather than a refactor.
 *
 * The idea in one line: the renderable tree is the UI, the runes are the state,
 * and ONE `$effect` is the bridge between them.
 *
 * Two rules from docs/tui-impl/01-architecture.md that are not optional:
 *
 *   1. Call `requestRender()` after mutating content. Assigning `.content` does
 *      not schedule a frame on its own. Miss it and the screen freezes while
 *      your logs insist the state changed — the single most confusing bug in
 *      this codebase.
 *   2. ONE effect per screen, not one per row. An effect tracks whatever it
 *      reads; 200 effects is 200 subscriptions and a visibly slower update.
 */
import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  RGBA,
  createCliRenderer,
} from "@opentui/core";

import { TerminalCursor } from "./cursor.ts";
import { type Capabilities, detect, sizing, type Sizing } from "./degrade.ts";
import { type ScreenName } from "./state.svelte.ts";
import { palette, type Semantic } from "./theme.ts";

/**
 * The renderable classes, re-exported so screens can BUILD without ever naming
 * the package. A screen that writes `import { TextRenderable } from
 * "@opentui/core"` has leaked the renderer past the seam; a screen that writes
 * `import { TextRenderable } from "../renderer.ts"` has not. One import site,
 * one directory to swap.
 */
export {
  BoxRenderable,
  InputRenderable,
  RGBA,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";

/** The constructor argument every renderable takes. */
export type { CliRenderer, KeyEvent, RenderContext } from "@opentui/core";

/** Semantic name -> colour. undefined means "terminal default", which is how
 * NO_COLOR keeps the layout identical and loses only the ink. */
export type ResolvedPalette = Record<Semantic, RGBA | undefined>;

/** What a screen is handed. It cannot reach `@opentui/core` itself. */
export interface ScreenContext {
  /**
   * The render context every renderable is constructed with — in practice the
   * CliRenderer. Exposed here rather than imported by screens so the OpenTUI
   * import site stays inside this file.
   */
  ctx: CliRenderer;
  caps: Capabilities;
  size: Sizing;
  colors: ResolvedPalette;
  cursor: TerminalCursor;
  /** Ask for a frame. Every content mutation must be followed by this. */
  requestRender(): void;
  /** Re-read the terminal size and re-apply the degradation ladder (SIGWINCH). */
  refresh(): void;
}

export interface Screen {
  readonly name: ScreenName;
  /** Build the renderable tree under `parent`. Called once, on mount. */
  build(parent: BoxRenderable, ctx: ScreenContext): void;
  /**
   * Copy `$state` into the renderables, then call `ctx.requestRender()`.
   * Called on every state change AND on the 200 ms tick.
   */
  paint(ctx: ScreenContext): void;
  /** Return true when the key was handled and must not fall through. */
  onKey?(key: KeyEvent, ctx: ScreenContext): boolean;
  /** Release anything the screen owns. Called on unmount and on crash. */
  dispose?(ctx: ScreenContext): void;
}

export interface Renderer {
  mount(screen: Screen): Promise<void>;
  update(): void;
  unmount(): void;
}

/** How often the smoothly-moving numbers are recomputed (rate, elapsed).
 * Not per byte — the engine emits a transition per file; this only smooths. */
const TICK_MS = 200;

/** Hard cap on queue rows. Beyond this the screen says so rather than
 * allocating ten thousand renderables. */
export const MAX_ROWS = 2000;

export class OpenTuiRenderer implements Renderer {
  private cli!: CliRenderer;
  private cursor!: TerminalCursor;
  private root!: BoxRenderable;
  private screen: Screen | null = null;
  private ctx!: ScreenContext;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The `$effect.root` disposer returned when the bridge effect is created. */
  private bridge: (() => void) | null = null;
  private disposer: (() => void) | null = null;
  private mounted = false;

  /**
   * @param argv       the process argv, used by degrade.ts for the `--json` /
   *                   `--plain` rungs. Injected so a test can assert them.
   * @param injected   a pre-built renderer. Tests pass one from
   *                   `createTestRenderer` (@opentui/core/testing), which gives a
   *                   real screen buffer and mock keys. Production leaves it
   *               undefined and gets a real terminal.
   *
   * This injection point is the difference between a TUI you can assert on and a
   * TUI you can only squint at. Without it, every gate below would have to be
   * proven by reading screenshots.
   */
  constructor(
    private readonly argv: readonly string[] = Bun.argv,
    injected?: CliRenderer,
  ) {
    this.injected = injected;
  }
  private readonly injected?: CliRenderer;

  async mount(screen: Screen): Promise<void> {
    if (this.mounted) return;
    this.screen = screen;

    this.cli =
      this.injected ??
      // exitOnCtrlC:false is deliberate. OpenTUI owns Ctrl-C only if we let it,
      // and gate C4 wants the CLI's own SIGINT behaviour: the engine finishes the
      // file in flight, the journal stays resumable, the exit code is 5.
      (await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
        maxFps: 60,
        useMouse: true, // left on, but every action is reachable by keyboard alone
        screenMode: "alternate-screen",
        consoleMode: "disabled", // nothing may write into the frame
        openConsoleOnError: false,
        clearOnShutdown: true,
      }));

    this.cursor = new TerminalCursor(this.cli);

    const caps = detect(this.argv);
    this.ctx = this.makeContext(caps);

    // The root box takes its size from the RENDERER, never from degrade.detect().
    // detect() reads COLUMNS / process.stdout.columns, which is how we decide
    // whether to mount, but it is not the terminal's actual size: a test
    // renderer, a detached stdout and a resized terminal all disagree. A root
    // that is 80 wide inside a 100-wide buffer makes every child resolve
    // percentages against the wrong number, and Yoga then squeezes bands onto
    // the same row.
    this.root = new BoxRenderable(this.cli, {
      id: "portage-root",
      width: this.cli.width,
      height: this.cli.height,
      flexDirection: "column",
    });
    this.cli.root.add(this.root);

    // The cursor starts hidden: a full-screen dashboard must not blink.
    this.cursor.apply(false);

    // An explicit SIGWINCH handler, because the renderer only installs its own
    // when it owns process.stdout — and a test renderer or a detached stdout
    // still needs the ladder re-applied.
    this.cli.on("resize", (w: number, h: number) => {
      this.root.width = w;
      this.root.height = h;
      this.ctx.refresh();
      this.ctx.requestRender();
    });

    screen.build(this.root, this.ctx);
    this.mounted = true;

    // Paint once, SYNCHRONOUSLY, before any effect exists.
    //
    // Svelte effects are asynchronous: they run on a microtask. Waiting for the
    // bridge to fire would mean the first frame is blank until something else
    // happens to touch the state — which in a test never happens at all. The
    // first paint is not a special case, it is the only one that cannot be
    // deferred.
    screen.paint(this.ctx);
    this.cli.requestRender();

    // Input delivery lives here, with the rest of the @opentui/core knowledge.
    //
    // `_internalKeyInput.onInternal` rather than `keyInput.on`: the internal
    // handler runs BEFORE any focused renderable gets the key. That matters —
    // a focused InputRenderable consumes Escape (it is a normal editing key), so
    // the screen's own "escape closes the filter" branch would never fire if we
    // arrived second. A screen decides what an ACTION means; it never parses a
    // key, but it must get first refusal on one.
    //
    // The focused input ALSO receives these keys, which is deliberate: the box
    // has to type while the screen handles escape and enter.
    this.cli._internalKeyInput.onInternal("keypress", (key: KeyEvent) => {
      this.screen?.onKey?.(key, this.ctx);
    });

    // THE BRIDGE. One effect for the whole screen: it reads every piece of
    // state the screen paints, so any change repaints, and there is exactly one
    // subscription instead of one per row.
    this.bridge = $effect.root(() => {
      $effect(() => {
        this.screen?.paint(this.ctx);
      });
    });

    this.timer = setInterval(() => {
      this.ctx.requestRender();
      this.screen?.paint(this.ctx);
    }, TICK_MS);
  }

  /** The screen context, once mounted. Exposed so a screen's own key handling can
   * be driven directly in a test — the terminal's ESC-timeout behaviour is
   * OpenTUI's to test, not ours. */
  get context(): ScreenContext {
    return this.ctx;
  }

  /** Repaint now. Cheaper than remounting and keeps the terminal quiet. */
  update(): void {
    if (!this.mounted) return;
    this.screen?.paint(this.ctx);
    this.ctx.requestRender();
  }

  unmount(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bridge?.();
    this.bridge = null;
    try {
      this.screen?.dispose?.(this.ctx);
    } catch {
      /* the screen is going away; nothing useful to do */
    }
    this.screen = null;
    // Cursor FIRST, then the renderer: destroy() also resets terminal state, and
    // we want the caret visible in the main screen the user lands back in.
    this.cursor?.restore();
    try {
      this.cli?.destroy();
    } catch {
      /* already destroyed */
    }
    this.disposer?.();
    this.disposer = null;
    this.mounted = false;
  }

  /** Register exit-path handlers. Called by the entry, not by mount. */
  guard(): void {
    if (this.disposer) return;
    // Imported lazily to keep the import graph of this file obvious.
    this.disposer = installGuards(this.cursor, () => this.unmount());
  }

  private makeContext(caps: Capabilities): ScreenContext {
    const hexPalette = palette(caps.color);
    const colors = {} as ResolvedPalette;
    for (const key of Object.keys(hexPalette) as Semantic[]) {
      const hex = hexPalette[key];
      colors[key] = hex === undefined ? undefined : RGBA.fromHex(hex);
    }
    const self = this;

    // THE RENDERER IS THE AUTHORITY ON SIZE, not the environment.
    //
    // `degrade.detect()` reads COLUMNS / process.stdout.columns, which is right
    // BEFORE mounting (it is how we decide whether to mount at all) and wrong
    // afterwards. A test renderer, a resized terminal and a detached stdout all
    // disagree with it — and a screen that pads rows to the wrong width overflows,
    // gets clipped, and reads as a blank line. That is gate E3, and it is why
    // this reads the renderer's own size instead.
    let current: Capabilities = {
      ...caps,
      width: this.cli.width,
      height: this.cli.height,
    };

    return {
      ctx: this.cli,
      get caps() {
        return current;
      },
      size: sizing(current.width),
      colors,
      cursor: this.cursor,
      requestRender: () => self.cli?.requestRender(),
      refresh: () => {
        current = {
          ...current,
          width: self.cli.width,
          height: self.cli.height,
        };
        // Re-apply the ladder at the new width. This is what drops the per-file
        // bars below 80 columns and the box drawing below 60, live.
        this.ctx.size = sizing(current.width);
      },
    };
  }
}

/**
 * Every exit path restores the terminal. Kept here (not in cursor.ts) because it
 * needs `unmount`, and kept small because a handler that throws on its way out
 * is its own bug.
 */
function installGuards(
  cursor: TerminalCursor,
  unmount: () => void,
): () => void {
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    try {
      cursor.restore();
    } catch {
      /* renderer already gone */
    }
    try {
      unmount();
    } catch {
      /* ditto */
    }
  };
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);
  process.on("uncaughtException", (err) => {
    restore();
    process.stderr.write(
      `\nportage: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    restore();
    process.stderr.write(
      `\nportage: unhandled rejection: ${
        reason instanceof Error
          ? (reason.stack ?? reason.message)
          : String(reason)
      }\n`,
    );
    process.exit(1);
  });
  return () => {
    process.off("SIGINT", restore);
    process.off("SIGTERM", restore);
  };
}
