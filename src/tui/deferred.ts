/**
 * A promise the caller settles later.
 *
 * The TUI entry points are async but the UI is synchronous — a keypress cannot
 * await. This is how the screen hands its decision back to the entry: the screen
 * writes to a field, the entry settles the promise, and the `finally` block runs.
 *
 * Extracted rather than declared twice, because two copies of a one-liner is one
 * more place for the two to drift apart.
 */
export function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}
