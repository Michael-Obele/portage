/**
 * Send types (design §4). Types only: no logic, and nothing imports `src/serve`.
 */

export type SendKind = "drive-to-phone" | "phone-to-phone";

export interface SendRequest {
  source:
    | { kind: "drive"; folder: string }
    | { kind: "phone"; deviceId: string; folder: string };
  target: { deviceId: string; folder: string };
  replace: boolean;
  move: boolean;
}

export type PlanVerdict =
  | "copy"
  | "replace"
  | "skip-already-there"
  | "skip-different-file"
  | "refuse"
  | "could-not-read-source"
  | "could-not-read-target"
  | "missing-since-plan";

export interface PlanFile {
  rowId: number;
  relative: string;
  sourcePath: string;
  targetPath: string;
  size: number;
  mtime: number | null;
  verdict: PlanVerdict;
  reason: string | null;
  relay: "push" | "stream" | "temp-file" | null;
  expectedSha256: string | null;
  replaces: { oldSize: number; oldSha256: string | null } | null;
  foldersToCreate: string[];
}

export interface PlanCounts {
  sourceFiles: number;
  toCopy: number;
  skipped: number;
  refused: number;
  notReadable: number;
}

export interface SendPlan {
  sendId: string;
  kind: SendKind;
  createdAt: number;
  expiresAt: number;
  source: {
    kind: "drive" | "phone";
    label: string;
    folder: string;
    deviceId: string | null;
    walker: "scanner" | "glob" | "phone-find";
  };
  target: {
    deviceId: string;
    model: string;
    folder: string;
    freeBytes: number | null;
    totalBytes: number | null;
    headroomBytes: number | null;
  };
  files: PlanFile[];
  counts: PlanCounts;
  bytesToWrite: number;
  bytesSkipped: number;
  moveIncluded: boolean;
  replaceIncluded: boolean;
  confirmWord: "copy" | "replace" | "move";
  linkSpeed: "not read";
  leftoverPartials: string[];
  folderCreates: string[];
  warnings: string[];
}

export type FinalState =
  | "verified-done"
  | "replaced"
  | "skipped-already-there"
  | "skipped-different-file"
  | "refused"
  | "could-not-read-source"
  | "could-not-read-target"
  | "missing-since-plan"
  | "failed"
  | "cancelled"
  | "not-started"
  | "copied-source-kept"
  | "in-place-not-confirmed";

export type WriteMethod =
  | "push"
  | "stream"
  | "temp-file-push"
  | "temp-file-shell-cat"
  | "none";

export interface FileResult {
  rowId: number;
  state: FinalState;
  reason: string | null;
  relay: "push" | "stream" | "temp-file" | "none";
  writeMethod: WriteMethod;
  bytesMoved: number;
  expectedSha256: string | null;
  targetSha256: string | null;
  hostSha256: string | null;
  finalSha256Fresh: string | null;
  sourceSha256Fresh: string | null;
  flushFirst: "flushed" | "failed" | "timeout" | "not-run";
  flushSecond: "flushed" | "failed" | "timeout" | "not-run";
  flushOutcome: "flushed" | "not-flushed" | "not-run";
  partialPath: string | null;
  partialRemoved: boolean | null;
  hostTempPath: string | null;
  hostTempRemoved: boolean | null;
  replacedOld: { size: number; sha256: string | null } | null;
  foldersCreated: string[];
  startedAt: number | null;
  finishedAt: number | null;
}

export type JobState =
  | "planning"
  | "planned"
  | "running"
  | "finished"
  | "cancelled"
  | "refused"
  | "expired";

export type PhoneCall =
  | { kind: "ok" }
  | { kind: "failed"; exitCode: number; reason: string }
  | { kind: "timeout"; deadlineMs: number }
  | { kind: "refused"; reason: string };

export type PhoneHash =
  | { kind: "ok"; sha256: string }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

export type PhoneStat =
  | { kind: "file"; size: number }
  | { kind: "folder" }
  | { kind: "other" }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

export interface PhoneEntry {
  path: string;
  kind: "file" | "folder";
  size: number;
  mtime: number;
}

export type ListingResult<T> =
  | {
      kind: "ok";
      entries: T[];
      truncated: boolean;
      total: number;
      skipped: { path: string; reason: string }[];
    }
  | { kind: "unreadable"; reason: string }
  | { kind: "missing" };
