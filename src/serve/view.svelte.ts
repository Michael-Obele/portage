/**
 * The runes state the screens read — the single source of truth for the view.
 *
 * THE ENGINE WRITES INTO `view`; THE BRIDGE READS IT. Nothing else writes.
 *
 * Why `.svelte.ts`: Svelte 5 compiles runes only in files whose name carries the
 * `.svelte.` infix, because the compiler needs to know the module is allowed to
 * contain them. See scripts/svelte-loader.ts.
 *
 * The types below mirror the engine's own vocabulary exactly, because the TUI is
 * a VIEW:
 *   Candidate   (src/scan/scan.ts)   -> what the phone has
 *   PlannedFile (src/plan/plan.ts)  -> where it is going
 *   FileEvent   (src/xfer/engine.ts) -> the transitions as they happen
 *   EngineSummary (engine.ts)       -> the end-of-run totals
 * Nothing here invents a number the engine does not already emit; where the
 * engine emits nothing live (there is no onOverall — see sink.ts), we derive it
 * and say so.
 */

// --- ETA honesty ------------------------------------------------------------
//
// docs/tui.md §5. These are not style, they are the specification:
// an ETA built on 200 ms of data is a lie, so before we have 3 samples AND
// 30 MB moved we render `—` and emit `eta_seconds: null`.
export const ETA_MIN_SAMPLES = 3;
export const ETA_MIN_BYTES = 30_000_000;
/** EWMA alpha. High enough to react to a dying cable, low enough not to twitch. */
export const EWMA_ALPHA = 0.3;
/** A `copying` row with no byte progress for this long says `stalled N s`
 * instead of freezing a bar at a silently wrong percentage. */
export const STALL_MS = 10_000;

/** Per-file state. A deliberately small union: the glyph set is finite and
 * every one of these has a text twin, so a monochrome terminal loses nothing. */
export type RowState =
  "queued" | "copying" | "done" | "failed" | "skipped" | "duplicate";

export interface FileRow {
  /** Stable identity across events. The engine has no index, so this is the
   * (deviceId, srcPath, size) tuple — exactly the key the journal itself uses. */
  key: string;
  srcPath: string;
  destPath: string;
  size: number;
  /** Bytes moved so far for THIS file. From FileEvent `progress`. */
  bytes: number;
  state: RowState;
  /** Why it failed or was skipped. Never bare — a row always says. */
  reason: string;
  startedAt: number | null;
  /** Last time this row's byte count moved. Drives the stalled readout. */
  lastProgressAt: number;
  /** True when the archive already holds this file (the `2x` marker). */
  onDrive: boolean;
}

export interface DeviceRow {
  id: string;
  model: string;
  android: string;
  ready: boolean;
  /** USB link speed in Mbps (5000 / 480), or null when it could not be read. */
  linkMbps: number | null;
  freeBytes: number | null;
}

export interface Overall {
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  failed: number;
  skipped: number;
  /** Instantaneous, 1 s window, EWMA-smoothed. This is what tells you the
   * cable is dying. */
  rateBps: number;
  /** Whole-run average. */
  avgBps: number;
  /** EWMA of the whole-run average. THIS is what the ETA uses, because a
   * single noisy sample must not move the finish line. */
  smoothedBps: number;
  etaSeconds: number | null;
  samples: number;
  elapsedMs: number;
  jobs: number;
  paused: boolean;
}

export type ScreenName = "dashboard" | "dupes" | "help" | "confirm";

export interface LogEntry {
  at: number;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
}

// The view holds the ENGINE's objects, not a copy of them: a hand-written mirror
// here drifted once already and lost fields the screens exist to show.
//
// This is the WIRE's run model now — the TUI that first owned it is gone, and
// the fields that only it used (selection, scroll, filter, the confirm gate, the
// duplicate-review stack) went with it. `screen` stays because it is still part
// of the `state` frame the desktop receives.

export const view = $state({
  screen: "dashboard" as ScreenName,

  devices: [] as DeviceRow[],
  rows: [] as FileRow[],
  // `as Overall`, not `satisfies Overall`. Under `satisfies` the literal keeps
  // `paused: false` as the type `false`, so assigning a real boolean later is a
  // compile error — and the first thing anyone does is pause a transfer.
  overall: {
    bytesDone: 0,
    bytesTotal: 0,
    filesDone: 0,
    filesTotal: 0,
    failed: 0,
    skipped: 0,
    rateBps: 0,
    avgBps: 0,
    smoothedBps: 0,
    etaSeconds: null as number | null,
    samples: 0,
    elapsedMs: 0,
    jobs: 1,
    paused: false,
  } as Overall,

  // The notice channel. NEVER console.log while a screen is mounted — it writes
  // into the frame and corrupts it (gate B4).
  notice: null as string | null,
});

// --- lookups ----------------------------------------------------------------

export function rowIndexByKey(key: string): number {
  return view.rows.findIndex((r) => r.key === key);
}

/**
 * The ETA, or null when it would not be honest.
 * Exported so `--json` and the screen call the SAME function — gate D4.
 */
export function honestEta(
  bytesDone: number,
  bytesTotal: number,
  smoothedBps: number,
  samples: number,
): number | null {
  if (samples < ETA_MIN_SAMPLES) return null;
  if (bytesDone < ETA_MIN_BYTES) return null;
  if (smoothedBps <= 0) return null;
  const remaining = bytesTotal - bytesDone;
  if (remaining <= 0) return 0;
  return Math.round(remaining / smoothedBps);
}
