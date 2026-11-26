// Durable drive writes. A copy is durable only after its file and its folder
// are fsynced, so the ledger keeps every folder that still owes an fsync.
// Marks and poison last for the life of the process (DV-9): a failed fsync
// still blocks copies in a later run, and only a restart clears it.
import { copyFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { dirname, normPath } from "#lib/util/paths.ts";
import {
  BreakerRefusal,
  breakerFor,
  probe,
  runFlushCall,
  statDrive,
  type DriveCallOutcome,
} from "#lib/util/probe.ts";

// R1.12: 30 s plus 1 s for each 10 MB, rounded up.
export const FLUSH_BASE_MS = 30_000;
export const FLUSH_UNIT_BYTES = 10_000_000;
export const FLUSH_PER_UNIT_MS = 1_000;
// R1.13: a folder fsync has no size, so it gets the 30 s base alone.
export const DIR_FSYNC_DEADLINE_MS = 30_000;

// E1 record: bench/results/2026-11-26-e1-flush.json, verdict.openMode.
export const FLUSH_OPEN_MODE = "r" as const;
// E4 record: bench/results/2026-11-26-e4-bun-sync.json, verdict.directoryBranch.
export const DIRECTORY_SYNC_BRANCH = "B" as const;

/** R1.12. Zero bytes gets 30 s, and 10,000,001 bytes gets 32 s. */
export function flushDeadlineMs(size: number): number {
  return FLUSH_BASE_MS + FLUSH_PER_UNIT_MS * Math.ceil(size / FLUSH_UNIT_BYTES);
}

export interface DirtyMark {
  dir: string;
  depth: number;
  version: number;
  poisoned: string | null;
}

// Never reset, not even by resetLedgers, so a version is never reused.
let lastVersion = 0;

// NTFS treats two spellings of one folder as one, so keys fold case (paths.ts).
const folderKey = (path: string): string => normPath(resolve(path));
const depthOf = (path: string): number =>
  folderKey(path)
    .split("/")
    .filter((part) => part !== "").length;

export class DirtyLedger {
  readonly root: string;
  private readonly rootKey: string;
  private readonly marks = new Map<string, DirtyMark>();

  constructor(root: string) {
    this.root = resolve(root);
    this.rootKey = folderKey(root);
  }

  /** A folder gained an entry. Every mark gets a new version. */
  mark(dir: string): void {
    this.put(dir, this.marks.get(folderKey(dir))?.poisoned ?? null);
  }

  /** Every mark, deepest first, then by path. */
  snapshot(): DirtyMark[] {
    return [...this.marks.values()]
      .map((mark) => ({ ...mark }))
      .sort(
        (a, b) =>
          b.depth - a.depth || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0),
      );
  }

  /** Clears the mark only if it is unpoisoned and still has `version` (P2). */
  clearIfUnchanged(dir: string, version: number): boolean {
    const key = folderKey(dir);
    const mark = this.marks.get(key);
    if (
      mark === undefined ||
      mark.poisoned !== null ||
      mark.version !== version
    ) {
      return false;
    }
    this.marks.delete(key);
    return true;
  }

  /** Poisons `dir` for the life of the process (EH-4). The first reason stands. */
  poison(dir: string, reason: string): void {
    const mark = this.marks.get(folderKey(dir)) ?? this.put(dir, null);
    mark.poisoned ??= reason;
  }

  /** The nearest poisoned folder from `dir` up to the root, or null (EH-10). */
  chainPoison(dir: string): { dir: string; reason: string } | null {
    for (let cursor = resolve(dir); ; cursor = dirname(cursor)) {
      const mark = this.marks.get(folderKey(cursor));
      if (mark !== undefined && mark.poisoned !== null) {
        return { dir: mark.dir, reason: mark.poisoned };
      }
      if (folderKey(cursor) === this.rootKey || dirname(cursor) === cursor)
        return null;
    }
  }

  private put(dir: string, poisoned: string | null): DirtyMark {
    lastVersion += 1;
    const mark: DirtyMark = {
      dir: resolve(dir),
      depth: depthOf(dir),
      version: lastVersion,
      poisoned,
    };
    this.marks.set(folderKey(dir), mark);
    return mark;
  }
}

const ledgers = new Map<string, DirtyLedger>();

/** One ledger per root. Two spellings of one NTFS root share a ledger. */
export function ledgerFor(root: string): DirtyLedger {
  const key = folderKey(root);
  const found = ledgers.get(key);
  if (found !== undefined) return found;
  const ledger = new DirtyLedger(root);
  ledgers.set(key, ledger);
  return ledger;
}

/** Tests only. A restart already starts with empty ledgers. */
export function resetLedgers(): void {
  ledgers.clear();
}

export type EnsureDirOutcome =
  | { kind: "exists" }
  | { kind: "created"; created: string[] }
  | { kind: "failed"; reason: string };

const UNREADABLE = "the destination could not be read; nothing was changed";

/** Creates `dir` and its missing parents, never at or above `root` (R1.13). */
export async function ensureDirTracked(
  dir: string,
  root: string,
): Promise<EnsureDirOutcome> {
  const top = resolve(root);
  const target = resolve(dir);
  if (relative(folderKey(top), folderKey(target)).split(sep)[0] === "..") {
    return {
      kind: "failed",
      reason: `${dir} is outside the destination ${root}`,
    };
  }

  // Walks up one probe per level to the first folder that exists. Never past `top`.
  const missing: string[] = [];
  for (let cursor = target; ; cursor = dirname(cursor)) {
    const found = await statDrive(root, cursor);
    if (found.kind === "ok") {
      if (found.value.isDir) break;
      return { kind: "failed", reason: `${cursor} is a file, not a folder` };
    }
    if (found.kind === "unreadable")
      return { kind: "failed", reason: UNREADABLE };
    if (folderKey(cursor) === folderKey(top)) {
      return { kind: "failed", reason: `${top} does not exist` };
    }
    missing.unshift(cursor);
  }
  if (missing.length === 0) return { kind: "exists" };

  const ledger = ledgerFor(root);
  const created: string[] = [];
  for (const level of missing) {
    const parent = dirname(level);
    const made = await probe(root, `mkdir ${level}`, () => mkdir(level));
    if (made.kind === "ok") {
      ledger.mark(parent);
      created.push(level);
      continue;
    }
    // A timed-out mkdir can still finish, so its parent is marked too (EH-5).
    if (made.kind === "unreadable" && made.reason === "timeout") {
      ledger.mark(parent);
      return { kind: "failed", reason: made.message };
    }
    // Another call made this level, so this call does not list it in `created`.
    if (made.kind === "unreadable" && made.code === "EEXIST") continue;
    return {
      kind: "failed",
      reason:
        made.kind === "unreadable"
          ? made.message
          : `${level} could not be created`,
    };
  }
  return created.length > 0 ? { kind: "created", created } : { kind: "exists" };
}

/** The part of a file handle that a flush uses. */
export interface FlushHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type OpenFn = (path: string, mode: string) => Promise<FlushHandle>;

/** Test seams. `deadlineMs` replaces the size or folder deadline. */
export interface FlushDeps {
  open?: OpenFn;
  deadlineMs?: number;
}

/** DV-30. A timeout carries no reason: `flushReason` builds its text. */
export type FlushOutcome =
  | { kind: "ok" }
  | { kind: "failed"; reason: string; target: "file" | "dir"; path: string }
  | {
      kind: "timeout";
      deadlineMs: number;
      target: "file" | "dir";
      path: string;
    }
  | { kind: "refused"; reason: string };

// EH-13. Tests match these texts exactly.
const FILE_FAILED =
  "flush failed: the drive did not confirm the file was written";
const BREAKER_STOPPED =
  "the archive drive stopped answering; restart the Engine after checking the drive";
const folderFailed = (dir: string): string =>
  `flush failed: the drive did not confirm the folder entry: ${dir}`;
const folderSkipped = (dir: string): string =>
  `flush skipped: an earlier flush of this folder failed; restart the Engine to retry: ${dir}`;

const nodeOpen: OpenFn = (path, mode) => open(path, mode);

/** The EH-13 text for a flush that did not succeed. */
export function flushReason(
  outcome: Exclude<FlushOutcome, { kind: "ok" }>,
): string {
  if (outcome.kind === "timeout") {
    return `flush timed out after ${outcome.deadlineMs / 1000} s: ${outcome.path}`;
  }
  return outcome.reason;
}

// fsync, not datasync: R1.2 names it (DV-18). The handle closes even when sync throws.
async function syncPath(
  opener: OpenFn,
  path: string,
  mode: string,
): Promise<void> {
  const handle = await opener(path, mode);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Archive fsyncs go through here, so a probe on `root` waits for them (R2.13).
function fsyncCall(
  root: string,
  path: string,
  mode: string,
  deadlineMs: number,
  opener: OpenFn,
): Promise<DriveCallOutcome<void>> {
  return runFlushCall(root, `fsync ${path}`, deadlineMs, () =>
    syncPath(opener, path, mode),
  );
}

// A refused call never started, so it is not a drive failure (EH-3).
function outcomeOf(
  result: DriveCallOutcome<void>,
  target: "file" | "dir",
  path: string,
): FlushOutcome {
  if (result.kind === "ok") return { kind: "ok" };
  if (result.kind === "timeout") {
    return { kind: "timeout", deadlineMs: result.deadlineMs, target, path };
  }
  if (result.error instanceof BreakerRefusal) {
    return { kind: "refused", reason: BREAKER_STOPPED };
  }
  return {
    kind: "failed",
    reason: target === "file" ? FILE_FAILED : folderFailed(path),
    target,
    path,
  };
}

// Branch B opens a folder read-only, since Linux refuses a write open on one.
// Branch A has no working sync until the Helper fsync lands (task 4.24).
async function syncFolder(
  ledger: DirtyLedger,
  root: string,
  dir: string,
  deps: FlushDeps,
): Promise<FlushOutcome> {
  let outcome: FlushOutcome;
  if (DIRECTORY_SYNC_BRANCH !== "B") {
    outcome = {
      kind: "failed",
      reason: folderFailed(dir),
      target: "dir",
      path: dir,
    };
  } else {
    const result = await fsyncCall(
      root,
      dir,
      "r",
      deps.deadlineMs ?? DIR_FSYNC_DEADLINE_MS,
      deps.open ?? nodeOpen,
    );
    outcome = outcomeOf(result, "dir", dir);
  }
  // EH-4: a folder whose fsync failed or timed out stays poisoned until restart.
  if (outcome.kind === "failed" || outcome.kind === "timeout") {
    ledger.poison(dir, flushReason(outcome));
  }
  return outcome;
}

/**
 * R1.2, R1.3: fsync the file, then its folder, and nothing else. A copy beneath
 * a poisoned folder is refused before any drive call (EH-10).
 */
export async function flushFile(
  root: string,
  path: string,
  size: number,
  deps: FlushDeps = {},
): Promise<FlushOutcome> {
  const ledger = ledgerFor(root);
  const folder = dirname(path);
  const poisoned = ledger.chainPoison(folder);
  if (poisoned !== null) {
    return { kind: "refused", reason: folderSkipped(poisoned.dir) };
  }
  const file = outcomeOf(
    await fsyncCall(
      root,
      path,
      FLUSH_OPEN_MODE,
      deps.deadlineMs ?? flushDeadlineMs(size),
      deps.open ?? nodeOpen,
    ),
    "file",
    path,
  );
  if (file.kind !== "ok") return file;
  return syncFolder(ledger, root, folder, deps);
}

/**
 * R1.13, R1.15: fsync every dirty, unpoisoned folder under `root`, deepest first,
 * and stop at the first failure.
 */
export async function flushGate(
  root: string,
  copyDir: string,
  deps: FlushDeps = {},
): Promise<FlushOutcome> {
  const ledger = ledgerFor(root);
  // EH-3: a tripped breaker refuses the gate even when no folder is dirty.
  if (breakerFor(root).tripped) {
    return { kind: "refused", reason: BREAKER_STOPPED };
  }
  const blocked = (): FlushOutcome | null => {
    const poisoned = ledger.chainPoison(copyDir);
    return poisoned === null
      ? null
      : { kind: "refused", reason: folderSkipped(poisoned.dir) };
  };
  const early = blocked();
  if (early !== null) return early;

  // Deepest first: a parent's fsync commits its entry for a child, so the child syncs first.
  for (const mark of ledger.snapshot()) {
    if (mark.poisoned !== null) continue;
    const outcome = await syncFolder(ledger, root, mark.dir, deps);
    if (outcome.kind !== "ok") return outcome;
    // A mark bumped during the fsync stays, because its entry was not in that fsync.
    ledger.clearIfUnchanged(mark.dir, mark.version);
  }
  // A sync in the loop can poison a folder on this copy's chain (EH-10).
  return blocked() ?? { kind: "ok" };
}

/**
 * Doctor P15 only: fsync a file outside any archive root. It takes no ledger
 * and no breaker (DV-29), so it runs under probe with a null root. runFlushCall
 * would book its breaker on `root`.
 */
export async function syncFileOnly(
  path: string,
  size: number,
  deps: FlushDeps = {},
): Promise<FlushOutcome> {
  const deadlineMs = deps.deadlineMs ?? flushDeadlineMs(size);
  const opener = deps.open ?? nodeOpen;
  const result = await probe(
    null,
    `fsync ${path}`,
    () => syncPath(opener, path, FLUSH_OPEN_MODE),
    deadlineMs,
  );
  if (result.kind === "ok") return { kind: "ok" };
  if (result.kind === "unreadable" && result.reason === "timeout") {
    return { kind: "timeout", deadlineMs, target: "file", path };
  }
  return { kind: "failed", reason: FILE_FAILED, target: "file", path };
}

export type MoveOutcome =
  | { kind: "moved"; via: "rename" | "copy" }
  | { kind: "failed"; reason: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * R1.8, DV-23. A same-device move is one rename with no flush, so the source
 * folder is not fsynced after it (O-4, accepted). Only EXDEV copies, and the
 * source is removed after the copy's flush and gate both return ok.
 */
export async function moveFile(
  root: string,
  from: string,
  to: string,
  deps: { rename?: typeof rename } = {},
): Promise<MoveOutcome> {
  try {
    await (deps.rename ?? rename)(from, to);
    return { kind: "moved", via: "rename" };
  } catch (error) {
    // Only EXDEV means another device. Copying past any other error hides its cause.
    if ((error as { code?: unknown } | null)?.code !== "EXDEV") {
      return {
        kind: "failed",
        reason: `could not move ${from}; the source is kept: ${messageOf(error)}`,
      };
    }
  }

  try {
    await copyFile(from, to);
  } catch (error) {
    return {
      kind: "failed",
      reason: `could not copy ${from} to ${to}; the source is kept: ${messageOf(error)}`,
    };
  }
  // R1.12: the flush deadline follows the drive copy's size.
  const copy = await statDrive(root, to);
  if (copy.kind !== "ok") {
    return {
      kind: "failed",
      reason: `the copy at ${to} could not be checked; the source is kept`,
    };
  }
  const flushed = await flushFile(root, to, copy.value.size);
  if (flushed.kind !== "ok") {
    return { kind: "failed", reason: flushReason(flushed) };
  }
  const gated = await flushGate(root, dirname(to));
  if (gated.kind !== "ok") {
    return { kind: "failed", reason: flushReason(gated) };
  }
  // R1.8: the source goes only after both flushes return ok.
  try {
    await unlink(from);
  } catch (error) {
    return {
      kind: "failed",
      reason: `the copy at ${to} is flushed, but ${from} could not be removed: ${messageOf(error)}`,
    };
  }
  return { kind: "moved", via: "copy" };
}
