/**
 * The pending-action register: the safety spine, made concrete.
 *
 * THE RULE (architecture.md, D29): a path that will be deleted or moved NEVER
 * arrives from the caller. The engine issues opaque KEYS in its own result, and
 * only the engine can map a key back to a path — a path it already holds here.
 *
 * Consequences, all of them deliberate:
 *   - a buggy or compromised renderer cannot construct a delete set;
 *   - a selection that outlives its scan fails closed instead of moving a file
 *     the person never saw (hence the expiry);
 *   - the confirm sheet's paths and the paths acted on are the SAME strings,
 *     because both come from this record.
 *
 * Exported so a test can inspect the register directly, and so the register can
 * be injected rather than reachable only through a live scan.
 */
import type { DupeReport } from "#lib/dedupe/types.ts";
import type { TrashDay } from "#lib/dedupe/trash.ts";
import type { PurgePlan } from "#lib/xfer/purge.ts";

export type PendingKind = "dupes" | "purge" | "trash";

/** Ten minutes: long enough to read a confirm sheet, short enough to be stale. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export interface PendingEntry {
  /** Also the `scanId` / `planId` the caller must echo back as `confirm`. */
  id: string;
  kind: PendingKind;
  createdAt: number;
  expiresAt: number;
  /** key -> absolute path, both produced by the engine. Never a caller's string. */
  paths: Map<string, string>;
  /** key -> bytes, for the confirm sheet's per-key total. */
  sizes: Map<string, number>;
  /** Total bytes over every key in this record. */
  bytes: number;
  /** Where a move goes. Null for a purge, which deletes rather than moves. */
  trashDir: string | null;
  /** The destination root the keys were issued against. */
  destRoot: string;
  /** The engine object the dupes keys came from; apply re-validates against it. */
  report?: DupeReport;
  /** The engine object the purge keys came from. */
  plan?: PurgePlan;
  /**
   * The trash reading an empty call was issued against.
   *
   * Held here for the same reason a scan is: `trash.empty` must act on the day
   * folders the engine itself listed, not on a path the caller typed, and it must
   * refuse a folder that appeared after the person looked.
   */
  trashDays?: TrashDay[];
  /** Files sitting directly in the trash root — outside any day folder. */
  trashLoose?: string[];
}

/** What `insert` needs — the id, `createdAt` and `expiresAt` are the register's. */
export type PendingDraft = Omit<PendingEntry, "id" | "createdAt" | "expiresAt">;

export class PendingRegister {
  private readonly entries = new Map<string, PendingEntry>();

  constructor(
    private readonly ttlMs: number = PENDING_TTL_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  /** Issue a fresh id for a new record. The id is opaque: it is not a path. */
  insert(draft: PendingDraft): PendingEntry {
    const createdAt = this.now();
    // Expired records are dropped here as well as in `get`, because a caller
    // that only ever inserts (a screen polling `trash.status`) would otherwise
    // grow this map for the life of the engine.
    this.evictExpired(createdAt);
    const entry: PendingEntry = {
      ...draft,
      id: this.newId(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  /**
   * Drop ONE record.
   *
   * Never `clear()`. Emptying the trash used to wipe the whole register, which
   * also killed the duplicate scan the person was still working through — the
   * second pass over Duplicates then failed with "that duplicate scan is not
   * available any more".
   */
  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  private evictExpired(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }

  /**
   * Look one up. An expired record is dropped on sight and reported as absent —
   * a stale scan must fail closed, not act on paths nobody is looking at.
   */
  get(id: string): PendingEntry | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry;
  }

  /** Every key in a record, in issue order. Empty when the record is gone. */
  keys(id: string): string[] {
    return [...(this.get(id)?.paths.keys() ?? [])];
  }

  /** Rows held, expired ones included until they are next looked up. */
  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
