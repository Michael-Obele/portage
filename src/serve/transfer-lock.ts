/**
 * One transfer at a time across pull and send (D21).
 *
 * Both write to the same phone and share its adb queue, so a second start is
 * refused with the holder's name rather than queued.
 */

export type TransferKind = "pull" | "send";

export interface Lease {
  readonly kind: TransferKind;
  release(): void;
}

export interface LockRefusal {
  refused: true;
  holder: TransferKind;
}

export class TransferLock {
  private current: { kind: TransferKind; token: object } | null = null;

  holder(): TransferKind | null {
    return this.current?.kind ?? null;
  }

  acquire(kind: TransferKind): Lease | LockRefusal {
    if (this.current) return { refused: true, holder: this.current.kind };
    const token = {};
    this.current = { kind, token };
    return {
      kind,
      release: () => {
        // The token stops a stale lease from freeing a newer one.
        if (this.current?.token === token) this.current = null;
      },
    };
  }
}
