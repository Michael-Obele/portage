/**
 * Read-only plan rules (design §3.2). Pure: each function judges its inputs
 * and touches no phone, host file, or archive.
 */

import { posix } from "node:path";

import { ALWAYS_EXCLUDED_DIRS } from "#lib/config/schema.ts";
import { isReadOnlyMount } from "#lib/index/recovery.ts";
import type { MountState } from "#lib/util/fs.ts";
import { looksInFlight, matchesExclude } from "#lib/scan/scan.ts";

import type { PlanVerdict, SendRequest } from "./types.ts";

/** Bytes a partial name adds to the basename (DD-4). */
const PARTIAL_OVERHEAD = 31;
const MAX_NAME_BYTES = 255;
/** Phone roots the send may read or write (OI-2). */
const PHONE_ROOTS = ["/sdcard", "/storage/emulated/0"];
const INVALID_NAME = /[\u0000-\u001f\u007f\ufffd]/;

export type Refusal = { ok: false; reason: string };
export type Judged = { ok: true } | Refusal;

/** Archive admission (R6.1, R6.2, EH-17). An unreadable mount is never "not mounted". */
export function judgeArchiveMount(
  state: MountState,
  root: string,
  folder: string,
): Judged {
  if (state.kind === "unreadable") {
    return { ok: false, reason: "the mount could not be read" };
  }
  if (state.kind === "not-mounted") {
    return { ok: false, reason: "the archive drive is not mounted" };
  }
  if (state.target === "/") {
    return { ok: false, reason: "the archive is on the root filesystem" };
  }
  if (isReadOnlyMount(state.options)) {
    return { ok: false, reason: `the archive is mounted read-only: ${root}` };
  }
  const segs = folder.split("/");
  if (folder.startsWith("/") || segs.includes("..")) {
    return { ok: false, reason: `folder is outside the archive: ${folder}` };
  }
  if (segs.includes(".portage")) {
    return { ok: false, reason: "folder is inside the .portage state folder" };
  }
  return { ok: true };
}

export type SpaceJudgement =
  | { ok: true }
  | { ok: false; reason: string; shortfall: number };

/** Free space against the bytes to write plus the headroom (R7.13, R7.14, D20). */
export function judgeFreeSpace(input: {
  free: number | null;
  total: number | null;
  bytesToWrite: number;
  headroomFraction: number;
}): SpaceJudgement {
  if (input.free === null || input.total === null) {
    return { ok: false, reason: "free space could not be read", shortfall: 0 };
  }
  const usable =
    input.free - Math.ceil(input.total * input.headroomFraction);
  if (input.bytesToWrite > usable) {
    const shortfall = input.bytesToWrite - usable;
    return {
      ok: false,
      reason: `the phone needs ${shortfall} more bytes`,
      shortfall,
    };
  }
  return { ok: true };
}

export interface PhoneIdentity {
  id: string;
  serial: string;
  model: string;
  state: string;
  serialno: string;
}

export interface DeviceRequest {
  kind: "drive-to-phone" | "phone-to-phone";
  sourceDeviceId: string | null;
  targetDeviceId: string;
}

export type DeviceJudgement =
  | { ok: true; target: PhoneIdentity | null }
  | { ok: false; reason: string };

/** Phone identity and choice (R5.1 to R5.6, EH-16). */
export function judgeDevices(
  request: DeviceRequest,
  phones: PhoneIdentity[],
): DeviceJudgement {
  for (const phone of phones) {
    const twin = phones.find(
      (other) =>
        other !== phone &&
        (other.id === phone.id || other.serial === phone.serial),
    );
    if (twin) {
      return {
        ok: false,
        reason: `two phones share the serial ${phone.serial}, so neither can be named safely`,
      };
    }
  }
  if (request.kind === "drive-to-phone" && request.targetDeviceId === "") {
    return { ok: true, target: null };
  }
  const target = phones.find((p) => p.id === request.targetDeviceId);
  if (!target) {
    return { ok: false, reason: "no phone with that id is connected" };
  }
  if (target.state !== "device") {
    const name = `${target.model} (serial ${target.serial})`;
    const fix =
      target.state === "unauthorized"
        ? ": accept the USB debugging prompt on the phone"
        : "";
    return {
      ok: false,
      reason: `phone not attached (state: ${target.state}) for ${name}${fix}`,
    };
  }
  if (target.serialno === "") {
    return {
      ok: false,
      reason: `this phone did not report its serial number, so it cannot be named safely: ${target.model}`,
    };
  }
  if (request.kind === "phone-to-phone") {
    const ready = phones.filter((p) => p.state === "device" && p.serialno !== "");
    if (ready.length !== 2) {
      return {
        ok: false,
        reason: "a phone-to-phone send needs exactly two ready phones",
      };
    }
    if (request.sourceDeviceId === null) {
      return { ok: false, reason: "a phone-to-phone send needs a source phone" };
    }
    if (request.sourceDeviceId === request.targetDeviceId) {
      return { ok: false, reason: "the source and the target are the same phone" };
    }
  }
  return { ok: true, target };
}

/** Target path: the target folder, the source folder's name (OI-7), then the relative path. */
export function targetPathFor(
  targetFolder: string,
  sourceName: string,
  relative: string,
): string {
  return `${targetFolder}/${sourceName}/${relative}`;
}

/** Folders missing between `path` and the nearest existing ancestor, shallowest first (DD-6). */
export function missingFolderChain(
  path: string,
  existing: ReadonlySet<string>,
): string[] {
  const chain: string[] = [];
  let current = path;
  while (!existing.has(current) && current !== "/" && current !== "") {
    chain.unshift(current);
    current = posix.dirname(current);
  }
  return chain;
}

export type TargetFact =
  | { kind: "missing" }
  | { kind: "folder" }
  | { kind: "unreadable" }
  | { kind: "file"; size: number };

export interface PlanFileInput {
  sourceSize: number;
  target: TargetFact;
  replace: boolean;
  /** Called only for a same-size file pair (R7.5, R7.7). */
  hashes: () => { source: string; target: string };
}

export interface PlanFileJudgement {
  verdict: PlanVerdict;
  reason: string | null;
  replaces: { oldSize: number; oldSha256: string | null } | null;
}

/** One file's verdict against its target (R7.5 to R7.7, R7.11, EH-30). */
export function judgePlanFile(input: PlanFileInput): PlanFileJudgement {
  const t = input.target;
  if (t.kind === "missing") {
    return { verdict: "copy", reason: null, replaces: null };
  }
  if (t.kind === "folder") {
    return { verdict: "refuse", reason: "a folder is at this path", replaces: null };
  }
  if (t.kind === "unreadable") {
    return {
      verdict: "could-not-read-target",
      reason: "the target could not be read",
      replaces: null,
    };
  }
  const differing = (oldSha256: string | null): PlanFileJudgement =>
    input.replace
      ? { verdict: "replace", reason: null, replaces: { oldSize: t.size, oldSha256 } }
      : {
          verdict: "skip-different-file",
          reason: "different file at this path",
          replaces: null,
        };
  if (t.size !== input.sourceSize) return differing(null);
  const h = input.hashes();
  if (h.source === h.target) {
    return { verdict: "skip-already-there", reason: "already there", replaces: null };
  }
  return differing(h.target);
}

export type SourceStat =
  | { kind: "file"; size: number }
  | { kind: "missing" }
  | { kind: "folder" }
  | { kind: "unreadable"; reason: string };

/** Source queue rule (R6.5, R6.6, R8.13, EH-23). Stats before any hash. */
export function judgeSourceFile(
  stat: SourceStat,
  plannedSize: number,
): { verdict: PlanVerdict; reason: string | null } {
  if (stat.kind === "missing") {
    return { verdict: "missing-since-plan", reason: "missing since the plan" };
  }
  if (stat.kind === "folder" || stat.kind === "unreadable") {
    return { verdict: "could-not-read-source", reason: "the source could not be read" };
  }
  if (stat.size !== plannedSize) {
    return { verdict: "refuse", reason: "changed since the plan" };
  }
  return { verdict: "copy", reason: null };
}

export interface NameVerdict {
  name: string;
  action: "keep" | "skip" | "refuse";
  reason: string | null;
}

/** Names keep their bytes (D27). Case collisions and long names are refused, never renamed. */
export function nameVerdict(names: string[]): NameVerdict[] {
  const enc = new TextEncoder();
  const first = names.map((name): NameVerdict => {
    if (INVALID_NAME.test(name)) {
      const reason = name.includes("\ufffd")
        ? "name is not valid text, so it is skipped"
        : "name has a control character, so it is skipped";
      return { name, action: "skip", reason };
    }
    if (enc.encode(name).length + PARTIAL_OVERHEAD > MAX_NAME_BYTES) {
      return { name, action: "refuse", reason: "name too long for the phone" };
    }
    return { name, action: "keep", reason: null };
  });
  const lowered = first
    .filter((v) => v.action === "keep")
    .map((v) => v.name.toLowerCase());
  return first.map((v) => {
    if (v.action !== "keep") return v;
    const collides =
      lowered.filter((l) => l === v.name.toLowerCase()).length > 1;
    return collides
      ? { ...v, action: "refuse", reason: "differs from another name only in case" }
      : v;
  });
}

/** Skip rule for a phone source file (R8.15, OI-10). Reads the scan's suffix list. */
export function judgeSourcePhoneFile(
  file: { path: string; size: number; mtime: number },
  nowMs: number,
  quietSeconds: number,
): { skip: boolean; reason: string | null } {
  if (file.size === 0) return { skip: true, reason: "zero bytes" };
  if (looksInFlight(file.path)) {
    return { skip: true, reason: "filename marks it as an unfinished download" };
  }
  if (nowMs / 1000 - file.mtime < quietSeconds) {
    return { skip: true, reason: "modified too recently" };
  }
  return { skip: false, reason: null };
}

/** The request's own rules (R8.10, OI-2, OI-9). A single file is accepted (OI-8). */
export function judgeRequest(request: SendRequest): Judged {
  if (request.source.kind === "drive") {
    const segs = request.source.folder.split("/");
    if (request.move) {
      return { ok: false, reason: "move is only offered for phone sources" };
    }
    if (segs.includes("..") || request.source.folder.startsWith("/")) {
      return { ok: false, reason: "the drive folder must be inside the archive" };
    }
    return { ok: true };
  }
  const phoneFolder = request.source.folder.replace(/\/+$/, "");
  const segs = phoneFolder.split("/");
  if (segs.includes("..") || segs.slice(1).includes("")) {
    return { ok: false, reason: "the phone path has an empty or .. segment" };
  }
  const inRoot = PHONE_ROOTS.some(
    (root) => phoneFolder === root || phoneFolder.startsWith(`${root}/`),
  );
  if (!inRoot) {
    return { ok: false, reason: "the phone path is outside the allowed folders" };
  }
  if (ALWAYS_EXCLUDED_DIRS.some((dir) => matchesExclude(phoneFolder, dir))) {
    return { ok: false, reason: "the phone path is on the never-scan list" };
  }
  return { ok: true };
}
