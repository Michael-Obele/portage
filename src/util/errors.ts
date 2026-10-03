/**
 * Typed errors and the exit-code contract.
 *
 * Scripts branch on these codes, so they are part of the public interface and
 * must not drift. Each code answers one question a caller actually asks:
 *
 *   0  success
 *   1  usage or config error        — "I typed it wrong"
 *   2  precondition failed          — "no device / no drive"
 *   3  transfer failure             — "some files failed"
 *   4  verification failure         — "nothing was deleted, treat the destination as suspect"
 *   5  interrupted                  — "stopped on a signal, re-run to resume"
 */

export const ExitCode = {
  success: 0,
  usage: 1,
  precondition: 2,
  transfer: 3,
  verification: 4,
  interrupted: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** A failure with a message meant for the user, not a stack trace. */
export class PortageError extends Error {
  readonly code: ExitCodeValue;
  /** Optional one-line fix shown under the message — advice with a command in it. */
  readonly fix?: string;

  constructor(code: ExitCodeValue, message: string, fix?: string) {
    super(message);
    this.name = "PortageError";
    this.code = code;
    if (fix !== undefined) this.fix = fix;
  }
}

/** Bad flags, bad config, bad arguments. */
export const usageError = (message: string, fix?: string) =>
  new PortageError(ExitCode.usage, message, fix);

/** Something the run needs is missing: no device attached, drive not mounted. */
export const preconditionError = (message: string, fix?: string) =>
  new PortageError(ExitCode.precondition, message, fix);

/** Verification did not pass. Never paired with a deletion. */
export const verificationError = (message: string, fix?: string) =>
  new PortageError(ExitCode.verification, message, fix);

/** Turn anything thrown into a user-facing line + exit code. */
export function describeError(err: unknown): { message: string; fix?: string; code: ExitCodeValue } {
  if (err instanceof PortageError) {
    return { message: err.message, fix: err.fix, code: err.code };
  }
  if (err instanceof Error) {
    return { message: err.message, code: ExitCode.usage };
  }
  return { message: String(err), code: ExitCode.usage };
}