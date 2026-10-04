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
  | "queued"
  | "copying"
  | "done"
  | "failed"
  | "skipped"
  | "duplicate";

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

// The view holds the ENGINE's objects, not a copy of them. A hand-written mirror
// here drifted once already — it was missing `suspicious` and `scoreReason`, the
// two fields the review screen exists to show.

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

  // Selection + scroll are view state, not engine state: nothing on the drive
  // knows which row you are looking at.
  selected: 0,
  scrollTop: 0,

  // The notice channel. NEVER console.log while a screen is mounted — it writes
  // into the frame and corrupts it (gate B4).
  notice: null as string | null,
  log: [] as LogEntry[],

  // Live search. Focused input drives the terminal cursor (see cursor.ts).
  filter: "",
  filterActive: false,

  // The confirmation gate. Nothing is deleted without one that names the files.
  confirm: null as { title: string; detail: string[]; action: string } | null,

  groups: [] as DupeGroup[],
  /** Where the marked files are going. Shown in the footer BEFORE Enter. */
  trashDir: "",
  trashBytes: 0,
  /** Undo stack of TOGGLES, not of files (docs/tui-impl/03-screens.md). */
  undo: [] as Array<{ groupId: number; path: string; keep: boolean }>,
});

// --- lookups ----------------------------------------------------------------

export function rowIndexByKey(key: string): number {
  return view.rows.findIndex((r) => r.key === key);
}

/** EWMA. One place, so the screen and the JSON can never disagree. */
export function ewma(
  previous: number,
  sample: number,
  alpha = EWMA_ALPHA,
): number {
  if (previous <= 0) return sample;
  return alpha * sample + (1 - alpha) * previous;
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

/** Milliseconds this row has been frozen mid-copy, or 0 when it is moving. */
export function stalledFor(row: FileRow, now: number): number {
  if (row.state !== "copying" || row.startedAt === null) return 0;
  const since = now - Math.max(row.lastProgressAt, row.startedAt);
  return since >= STALL_MS ? since : 0;
}

// --- text -------------------------------------------------------------------
//
// These are the functions docs/tui.md §2.2 imports. They are pure: they read
// state and return a string, and the bridge copies the result into a
// TextRenderable's `.content`. One $effect per screen, not one per row.

import {
  formatBytes,
  formatDuration,
  formatRate,
  truncateMiddle,
} from "../util/paths.ts";
import type { DupeGroup, DupeMember } from "../dedupe/types.ts";

// The view holds the ENGINE's objects, not a copy: a hand-written mirror here
// drifted once already, missing `suspicious` and `scoreReason` — the two fields
// the review screen exists to show.
export type DuplicateGroup = DupeGroup;
export type DuplicateMember = DupeMember;

import { BAR_CELLS, type Capabilities, type Sizing } from "./degrade.ts";
import { boxChars, glyphs, type Palette } from "./theme.ts";

/** `██████████████░░░░░░` — fixed BAR_CELLS wide so it never misleads. */
export function bar(
  fraction: number,
  caps: Capabilities,
  size: Sizing,
  cells = BAR_CELLS,
): string {
  if (!size.bars) return "";
  const g = glyphs(caps.unicode);
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const full = Math.round(f * cells);
  return g.barFull.repeat(full) + g.barEmpty.repeat(cells - full);
}

/** The devices band. Link speed first: a USB 2 cable must be visible at once. */
export function deviceLine(
  d: DeviceRow,
  caps: Capabilities,
  size: Sizing,
): string {
  const link =
    d.linkMbps === null
      ? "usb ?"
      : d.linkMbps >= 1000
        ? `usb ${(d.linkMbps / 1000).toFixed(0)} Gb/s`
        : `usb ${d.linkMbps} Mb/s`;
  const free =
    d.freeBytes === null ? "" : ` · ${formatBytes(d.freeBytes)} free`;
  const nameMax = Number.isFinite(size.nameMax) ? size.nameMax : 40;
  const name = truncateMiddle(d.model || d.id, nameMax);
  return `${d.ready ? "●" : "○"} ${name.padEnd(nameMax)} ${link.padEnd(12)} ${d.ready ? "ready" : "not ready"}${free}`;
}

/** Band 1: bytes, percent, the overall bar, elapsed. */
export function header1(caps: Capabilities, size: Sizing): string {
  const o = view.overall;
  const pct =
    o.bytesTotal > 0 ? Math.floor((o.bytesDone / o.bytesTotal) * 100) : 0;
  const g = glyphs(caps.unicode);
  const label = o.paused ? `${g.paused} paused` : "Pulling";
  const left = `${label}  ${formatBytes(o.bytesDone)} / ${formatBytes(o.bytesTotal)}`;
  const pctText = `${String(pct).padStart(3)}%`;
  const elapsed = formatDuration(Math.floor(o.elapsedMs / 1000));
  const tail = `${pctText}   ${elapsed}`;
  const cells = bar(
    o.bytesTotal > 0 ? o.bytesDone / o.bytesTotal : 0,
    caps,
    size,
  );
  if (!cells) return `${left}  ${tail}`;
  // Pad to the available width minus the fixed tail so the frame never wraps.
  const room = Math.max(
    1,
    caps.width - left.length - tail.length - cells.length - 4,
  );
  return `${left}  ${cells}  ${" ".repeat(room)}${tail}`;
}

/**
 * Band 2: instantaneous AND average throughput, both labelled, the ETA, and
 * the file/job counts. The ETA reads `—` until it can be honest.
 */
export function header2(caps: Capabilities): string {
  const o = view.overall;
  const eta = o.etaSeconds === null ? "—" : formatDuration(o.etaSeconds);
  return (
    `          ▲ ${formatRate(o.rateBps || null)} · avg ${formatRate(o.avgBps || null)}` +
    ` · ETA ${eta} · ${o.filesDone}/${o.filesTotal} files` +
    ` · ${o.jobs} job${o.jobs === 1 ? "" : "s"}`
  );
}

/** The words that must never be colour alone. */
const STATE_WORD: Record<RowState, string> = {
  queued: "queued",
  copying: "copying",
  done: "done",
  failed: "failed",
  skipped: "skipped",
  duplicate: "duplicate",
};

const STATE_GLYPH: Record<RowState, keyof ReturnType<typeof glyphs>> = {
  queued: "queued",
  copying: "copying",
  done: "done",
  failed: "failed",
  skipped: "failed",
  duplicate: "duplicate",
};

/**
 * One queue row: glyph + word + name + size + per-file bar.
 * Below 80 columns the bar is dropped rather than wrapped (gate E3).
 *
 * The name is padded INTO the space the rest of the line leaves, and clamped to
 * it. Padding to a fixed column and hoping the tail fits is how a long filename
 * shoves the size off the edge — and a row that wraps is a broken frame.
 */
export function rowText(
  row: FileRow,
  index: number,
  selected: boolean,
  caps: Capabilities,
  size: Sizing,
  now: number,
): string {
  const g = glyphs(caps.unicode);
  const marker = selected ? "›" : " ";
  const glyph = g[STATE_GLYPH[row.state]];
  const word = STATE_WORD[row.state];

  let tail: string;
  const stall = stalledFor(row, now);
  if (row.state === "failed" && row.reason) tail = row.reason;
  else if (stall > 0) tail = `stalled ${Math.floor(stall / 1000)} s`;
  else if (row.state === "duplicate") tail = "2×";
  else tail = formatBytes(row.size);

  const cells =
    size.bars && row.state === "copying"
      ? bar(row.size > 0 ? row.bytes / row.size : 0, caps, size, 6)
      : "";
  const dupe = row.onDrive ? " 2×" : "";
  const prefix = `${marker}${glyph} ${word.padEnd(9)} `;
  const barPart = cells ? ` ${cells}` : "";
  const suffix = `${barPart}${dupe}  ${tail}`;

  // Columns actually available for the name.
  const room = Math.max(1, caps.width - prefix.length - suffix.length);
  const raw = row.srcPath.split("/").pop() ?? row.srcPath;
  const nameLimit = Number.isFinite(size.nameMax)
    ? Math.min(size.nameMax, room)
    : room;
  // truncateMiddle already keeps the extension, which is what a human scans for.
  const name = truncateMiddle(raw, nameLimit);

  return `${prefix}${" ".repeat(Math.max(0, room - name.length))}${name}${suffix}`;
}

/** Band 4: the always-visible key hints. */
export function keysLine(caps: Capabilities): string {
  const o = view.overall;
  const pause = o.paused ? "space resume" : "space pause";
  return `${pause} · j/k scroll · r retry · d dupes · / filter · l log · ? help · q quit`;
}

/** The frame edges. Plain spacing below 60 columns, never mid-frame wrapping. */
export function frame(
  caps: Capabilities,
  size: Sizing,
  title: string,
): [string, string] {
  const bc = boxChars(caps.unicode);
  if (!size.box) return ["", ""];
  const inner = Math.max(1, caps.width - 2);
  const head = `${bc.tl}${bc.h} ${title} `;
  const top = head + bc.h.repeat(Math.max(0, inner - head.length - 1)) + bc.tr;
  const bottom = bc.bl + bc.h.repeat(inner) + bc.br;
  return [top, bottom];
}

export type { Capabilities, Sizing, Palette };
