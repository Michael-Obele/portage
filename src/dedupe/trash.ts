/**
 * The trash: inventory, and the app's only permanent delete.
 *
 * Moving a duplicate frees nothing on the same drive, so "reclaimable" needs this
 * second step. `emptyTrash` deletes only inside `<destRoot>/.portage/trash`,
 * never follows a symlink, and reports what it could not remove.
 */
/// <reference types="bun" />
import { lstat, rm } from "node:fs/promises";

import { STATE_DIR } from "#lib/config/schema.ts";
import { resolveInside } from "#lib/util/paths.ts";
import type { ExecPath } from "#lib/util/durable.ts";
import { statDrive } from "#lib/util/probe.ts";

import type { ScanIo } from "#lib/dedupe/scan-io.ts";

export interface TrashDay {
  /** The directory name the moves were filed under, `<YYYY-MM-DD>`. */
  date: string;
  /** Absolute path of that directory. */
  path: string;
  files: number;
  bytes: number;
}

export interface TrashStatus {
  /** `<destRoot>/.portage/trash` — the only directory this module may touch. */
  root: string;
  /** False when nothing has ever been moved to the trash on this drive. */
  exists: boolean;
  /** One row per day, oldest first. */
  days: TrashDay[];
  /** Files sitting directly in the trash root, outside any day folder. */
  looseFiles: number;
  looseBytes: number;
  /**
   * Their absolute paths.
   *
   * The counts alone used to be all there was, and they were folded into
   * `totalBytes` — so the panel promised bytes that `trash.empty` could not
   * reach: it only ever deleted DAY FOLDERS, and a loose file stayed forever
   * while the button kept saying it would free them.
   */
  loose: string[];
  totalFiles: number;
  totalBytes: number;
  /** Set when the trash root could not be read. Never means "no trash". */
  unreadable?: string;
}

/** Where moves land for one drive. The same string `dupes.scan` computes. */
export function trashRootFor(destRoot: string): string {
  // Deliberately NOT `normPath`: that lowercases, because it is the journal's
  // COMPARISON key. A lowercased path is a different path on a case-sensitive
  // filesystem, and this string is opened, walked and deleted from.
  return `${destRoot.replace(/\/+$/, "")}/${STATE_DIR}/trash`;
}

export function emptyTrashStatus(root: string): TrashStatus {
  return {
    root,
    exists: false,
    days: [],
    looseFiles: 0,
    looseBytes: 0,
    loose: [],
    totalFiles: 0,
    totalBytes: 0
  };
}

/**
 * Inventory the trash.
 *
 * Read-only, and cheap: the walker is the same one that walks the archive, so a
 * trash holding a thousand moved episodes costs milliseconds even when their
 * paths are deep.
 */
export async function readTrash(destRoot: string, io: ScanIo): Promise<TrashStatus> {
  const root = trashRootFor(destRoot);
  const status = emptyTrashStatus(root);

  // A stat, not `Bun.file(...).exists()`: the latter answers about FILES, and a
  // directory is not one — it reported "no trash" for a trash full of files.
  const info = await statDrive(destRoot, root);
  if (info.kind === "unreadable") {
    status.unreadable = "the trash could not be read";
    return status;
  }
  if (info.kind === "missing" || !info.value.isDir) return status;

  const walked = await io.walk([root], { minSize: 0 });
  status.exists = true;

  const days = new Map<string, TrashDay>();
  for (const candidate of walked.candidates) {
    const cut = candidate.relative.indexOf("/");
    if (cut === -1) {
      // A file outside a day folder. It is still ours to clean up, but it is not
      // a day, and saying so beats rounding it into one.
      status.looseFiles += 1;
      status.looseBytes += candidate.size;
      status.loose.push(candidate.path);
      continue;
    }
    const date = candidate.relative.slice(0, cut);
    const day = days.get(date) ?? {
      date,
      path: `${root}/${date}`,
      files: 0,
      bytes: 0
    };
    day.files += 1;
    day.bytes += candidate.size;
    days.set(date, day);
  }

  status.days = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  status.totalFiles = status.days.reduce((n, day) => n + day.files, status.looseFiles);
  status.totalBytes = status.days.reduce((n, day) => n + day.bytes, status.looseBytes);
  return status;
}

/** One target that could not be emptied, with the filesystem's own reason. */
export interface TrashRefusal {
  path: string;
  reason: string;
}

export interface EmptyResult {
  /** Day folders removed in full. */
  removedDays: number;
  /** Individual files (or loose entries) unlinked. */
  removedFiles: number;
  /** Bytes actually freed, counted from what was there before the delete. */
  bytesFreed: number;
  refused: TrashRefusal[];
  /** Which implementation deleted. `reason` says why it was not the Helper (R4.10, R4.13). */
  path: ExecPath;
  reason?: string;
}

const NO_HELPER =
  "the Helper delete is not built: its E2 gate has not passed";

/**
 * Permanently delete trash contents.
 *
 * @param targets absolute paths the CALLER already validated. Every one is
 *                re-validated here against the trash root, because a path that
 *                reaches this function has been through an IPC boundary and
 *                "the caller checked" is not a safety argument.
 * @param walk    used to count what is about to be freed, so `bytesFreed` is a
 *                measurement rather than an estimate.
 */
export async function emptyTrash(
  destRoot: string,
  targets: readonly string[],
  io: ScanIo
): Promise<EmptyResult> {
  const root = trashRootFor(destRoot);
  const result: EmptyResult = {
    removedDays: 0,
    removedFiles: 0,
    bytesFreed: 0,
    refused: [],
    path: 'typescript',
    reason: NO_HELPER
  };

  for (const target of targets) {
    // Containment, re-checked. `resolveInside` refuses `..`, an absolute path
    // and anything outside the root.
    const inside = resolveInside(root, target);
    if (inside === null || inside === root) {
      result.refused.push({
        path: target,
        reason: 'outside the trash directory, so it was not touched'
      });
      continue;
    }

    try {
      // `lstat`, not `stat`: a symlink in the trash is a link to delete, never a
      // directory to walk into. Following one is how a cleaner deletes a home
      // folder through a shortcut.
      const info = await lstat(inside).catch((err: unknown) => {
        // Already gone between the reading and the delete: nothing to do, and
        // calling that a refusal would tell a person a folder survived that
        // never existed. Any other failure is a real refusal.
        if ((err as { code?: string }).code === "ENOENT") return null;
        throw err;
      });
      if (info === null) continue;
      if (info.isSymbolicLink()) {
        await rm(inside, { force: true });
        result.removedFiles += 1;
        continue;
      }
      // A loose file: unlink it. It sits in the trash root, so deleting it is
      // the same act as deleting a day folder, and the panel counts its bytes.
      if (info.isFile()) {
        const bytes = info.size;
        await rm(inside, { force: true });
        result.removedFiles += 1;
        result.bytesFreed += bytes;
        continue;
      }
      if (!info.isDirectory()) {
        result.refused.push({ path: target, reason: 'not a folder or a file inside the trash' });
        continue;
      }

      const walked = await io.walk([inside], { minSize: 0 });
      const bytes = walked.candidates.reduce((total, candidate) => total + candidate.size, 0);
      const files = walked.candidates.length;

      // `rm -r` unlinks symlinks it meets rather than following them, which is
      // exactly what a trash clean-up needs.
      await rm(inside, { recursive: true, force: true });

      result.removedDays += 1;
      result.removedFiles += files;
      result.bytesFreed += bytes;
    } catch (err) {
      result.refused.push({
        path: target,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return result;
}
