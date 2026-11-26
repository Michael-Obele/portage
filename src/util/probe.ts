// The one wrapper for drive calls. Every call gets a deadline, so a stuck drive
// cannot hang the engine (R2.2). The breaker is per root, so one sick drive
// stops work on that root and no other (EH-3).
import { stat } from "node:fs/promises";

/** R2.2: deadline for one drive read. A probe waits longer only for flushes (EH-6). */
export const PROBE_TIMEOUT_MS = 3_000;

/** R2.12: consecutive deadline timeouts on one root that trip its breaker. */
export const BREAKER_LIMIT = 3;

export type ProbeResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "missing" }
  | {
      kind: "unreadable";
      reason: "timeout" | "error" | "refused";
      code: string | null;
      message: string;
    };

export interface DriveStat {
  isFile: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface BreakerState {
  consecutiveTimeouts: number;
  tripped: boolean;
}

export type DriveCallOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout"; deadlineMs: number };

function refusalText(label: string): string {
  return `${label}: refused, the drive stopped answering`;
}

/**
 * The `error` of a flush that a tripped breaker refused before it started.
 * DriveCallOutcome has no refused kind, so callers test for this class.
 */
export class BreakerRefusal extends Error {
  constructor(label: string) {
    super(refusalText(label));
    this.name = "BreakerRefusal";
  }
}

interface InFlight {
  /** Resolves once the call is decided: it returned, failed, or hit its deadline. */
  done: Promise<void>;
}

interface RootState {
  consecutiveTimeouts: number;
  tripped: boolean;
  inFlight: Set<InFlight>;
}

const roots = new Map<string, RootState>();

function stateFor(root: string): RootState {
  let state = roots.get(root);
  if (state === undefined) {
    state = { consecutiveTimeouts: 0, tripped: false, inFlight: new Set() };
    roots.set(root, state);
  }
  return state;
}

/** Read-only view for Doctor and the status frame. */
export function breakerFor(root: string): BreakerState {
  const { consecutiveTimeouts, tripped } = stateFor(root);
  return { consecutiveTimeouts, tripped };
}

/** Restart and tests only. A production Engine never resets a breaker (R2.12). */
export function resetDriveState(root?: string): void {
  if (root === undefined) roots.clear();
  else roots.delete(root);
}

/**
 * Races `call` against its deadline and books the outcome on `state`, if any.
 * A call that settles after its deadline has no effect: the race is already decided.
 */
async function attempt<T>(
  state: RootState | null,
  call: () => Promise<T>,
  deadlineMs: number,
): Promise<DriveCallOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DriveCallOutcome<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "timeout", deadlineMs }),
      deadlineMs,
    );
  });
  // The async wrapper turns a synchronous throw into a rejection.
  const returned = (async () => call())().then(
    (value): DriveCallOutcome<T> => ({ kind: "ok", value }),
    (error: unknown): DriveCallOutcome<T> => ({ kind: "error", error }),
  );
  const outcome = await Promise.race([returned, deadline]);
  clearTimeout(timer);
  if (state !== null) {
    if (outcome.kind === "timeout") {
      state.consecutiveTimeouts += 1;
      if (state.consecutiveTimeouts >= BREAKER_LIMIT) state.tripped = true;
    } else {
      // A call that returns, with a value or an error, is an answer (EH-3).
      state.consecutiveTimeouts = 0;
    }
  }
  return outcome;
}

/**
 * Runs one flush or directory fsync under its own deadline. While it is in
 * flight it is registered on `root`, so probes on that root wait for it (R2.13).
 */
export async function runFlushCall<T>(
  root: string,
  label: string,
  deadlineMs: number,
  call: () => Promise<T>,
): Promise<DriveCallOutcome<T>> {
  const state = stateFor(root);
  if (state.tripped) return { kind: "error", error: new BreakerRefusal(label) };
  const { promise: done, resolve: markDone } = Promise.withResolvers<void>();
  const entry: InFlight = { done };
  state.inFlight.add(entry);
  try {
    return await attempt(state, call, deadlineMs);
  } finally {
    state.inFlight.delete(entry);
    markDone();
  }
}

/**
 * One read under its own deadline (R2.2). A tripped breaker refuses it before
 * `task` starts. A null root reads nothing on the archive, so it waits for no
 * flush and counts toward no breaker.
 */
export async function probe<T>(
  root: string | null,
  label: string,
  task: () => Promise<T>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult<T>> {
  const state = root === null ? null : stateFor(root);
  if (state?.tripped) return refused(label);
  if (state !== null) {
    // Only flushes in flight now. A later flush must not extend this wait (O-6).
    await Promise.all([...state.inFlight].map((entry) => entry.done));
    // A flush that timed out during the wait can trip the breaker (EH-3).
    if (state.tripped) return refused(label);
  }
  return toProbeResult(await attempt(state, task, timeoutMs), label);
}

/**
 * Pure. ENOENT is `missing`. Any other error, or none, is `unreadable` with
 * its code (R2.5, R2.11).
 */
export function classifyError(
  err: unknown,
): Exclude<ProbeResult<never>, { kind: "ok" }> {
  const code = codeOf(err);
  if (code === "ENOENT") return { kind: "missing" };
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "unreadable", reason: "error", code, message };
}

/**
 * `stat` through the probe. Follows symlinks, as `statSafe` does. Starts no
 * child process (R2.6).
 */
export function statDrive(
  root: string,
  path: string,
  timeoutMs?: number,
): Promise<ProbeResult<DriveStat>> {
  return probe(
    root,
    `stat ${path}`,
    async () => {
      const s = await stat(path);
      return {
        isFile: s.isFile(),
        isDir: s.isDirectory(),
        size: s.size,
        mtimeMs: s.mtimeMs,
      };
    },
    timeoutMs,
  );
}

function codeOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  return typeof err.code === "string" ? err.code : null;
}

function refused(label: string): ProbeResult<never> {
  return {
    kind: "unreadable",
    reason: "refused",
    code: null,
    message: refusalText(label),
  };
}

function toProbeResult<T>(
  outcome: DriveCallOutcome<T>,
  label: string,
): ProbeResult<T> {
  if (outcome.kind === "ok") return { kind: "ok", value: outcome.value };
  if (outcome.kind === "error") return classifyError(outcome.error);
  return {
    kind: "unreadable",
    reason: "timeout",
    code: null,
    message: `${label}: no answer within ${outcome.deadlineMs} ms`,
  };
}
