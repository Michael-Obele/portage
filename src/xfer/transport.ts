/**
 * The transport interface.
 *
 * Two implementations — `adb` (primary) and `rsync` (fallback) — behind one
 * contract. The engine, the state machine, and the verification gate know
 * nothing about which one is running, which is why swapping them is a config
 * value rather than a rewrite.
 */

import type { Adb } from "../device/adb.ts";

export interface CopyRequest {
  serial: string;
  /** Device-side path. */
  srcPath: string;
  /** Absolute destination path on the drive. */
  destPath: string;
  /** Bytes already on disk at `destPath` from a previous attempt, if any. */
  partialBytes: number;
  /** Total expected size. */
  size: number;
  /** Resume only past this fraction done; below it, re-copying is faster. */
  resumeThreshold: number;
  /** Where interrupted files live, on the destination filesystem. */
  partialDir: string;
  onProgress?: (bytesDone: number) => void;
}

export type CopyOutcome =
  /** Transferred (or resumed) cleanly. Not yet verified. */
  | { status: "copied"; bytes: number }
  /** Nothing to do — the destination already had the content. */
  | { status: "skipped"; bytes: number }
  /** Failed. `fatal: false` means "retry the whole file is reasonable". */
  | { status: "failed"; reason: string; code: number; fatal: boolean };

export interface Transport {
  readonly name: "adb" | "rsync";
  /** Can this transport actually serve this device right now? */
  available(deviceId: string): Promise<boolean>;
  copy(req: CopyRequest): Promise<CopyOutcome>;
  /**
   * Delete the phone copy.
   *
   * Only ever called by the explicit delete step, never by `copy`. Keeping it
   * on the interface but out of `copy` is what makes "deleting is not a side
   * effect of copying" a structural property rather than a promise.
   */
  removeSource(serial: string, srcPath: string): Promise<boolean>;
}

export type { Adb };