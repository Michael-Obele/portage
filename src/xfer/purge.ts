/**
 * `portage purge` — the deferred deletion.
 *
 * This is the second half of `--keep-source`. It exists because "I might still
 * want it on my phone for a while and delete it when I want" is a real workflow
 * (Michael, 2026-10-03), and because a deferred deletion must still be
 * **provable** rather than remembered.
 *
 * The rule: a phone file is deleted only when its content is provably on the
 * drive — either the journal holds the hash from a run that verified it, or
 * `--verify-hash` recomputes both sides right now. Deleting a phone copy
 * because "a file with that name exists on the drive" is exactly the inference
 * that loses data, so that path does not exist.
 */

import type { Adb, DeviceInfo } from "../device/adb.ts";
import type { Journal } from "../index/journal.ts";
import { sha256File } from "../util/hash.ts";
import type { Transport } from "../xfer/transport.ts";

export interface PurgeCandidate {
  deviceId: string;
  serial: string;
  srcPath: string;
  destPath: string;
  size: number;
  /** The proof we are acting on. */
  proof: "journal-hash" | "recomputed-hash";
  hash: string;
}

export interface PurgePlan {
  eligible: PurgeCandidate[];
  /** Rows we refused to act on, with the reason. Never a silent skip. */
  refused: Array<{ srcPath: string; reason: string }>;
  bytesReclaimed: number;
}

export interface PurgeOptions {
  journal: Journal;
  transport: Transport;
  /** Recompute both hashes instead of trusting the journal. Slower, stronger. */
  verifyHash: boolean;
  /** Print what would go without deleting anything. */
  dryRun: boolean;
  /** Actually delete. Without this the function plans and changes nothing. */
  apply: boolean;
}

/**
 * Work out exactly which phone files are safe to delete.
 *
 * The important output is `refused`: a file with no proof is not quietly
 * skipped, it is reported with its reason. Silence would let someone believe
 * the purge cleaned everything when it cleaned nothing.
 */
export async function planPurge(
  devices: Map<string, DeviceInfo>,
  adb: Adb,
  opts: PurgeOptions,
): Promise<PurgePlan> {
  const eligible: PurgeCandidate[] = [];
  const refused: Array<{ srcPath: string; reason: string }> = [];

  for (const row of opts.journal.listPendingPurge()) {
    const device = devices.get(row.device_id);
    if (!device) {
      refused.push({
        srcPath: row.src_path,
        reason: `device ${row.device_id.slice(0, 8)}… is not attached`,
      });
      continue;
    }

    let hash = row.hash ?? "";
    let proof: PurgeCandidate["proof"] = "journal-hash";

    if (opts.verifyHash) {
      // Stronger: ask the phone and the drive, both, right now.
      const [remote, local] = await Promise.all([
        adb.hashRemote(device.serial, row.src_path),
        sha256File(row.dest_path),
      ]);
      if (!remote) {
        refused.push({ srcPath: row.src_path, reason: "phone-side hash unavailable" });
        continue;
      }
      if (!local) {
        refused.push({ srcPath: row.src_path, reason: "drive copy unreadable" });
        continue;
      }
      if (remote !== local) {
        refused.push({
          srcPath: row.src_path,
          reason: `content differs — phone ${remote.slice(0, 12)}…, drive ${local.slice(0, 12)}…`,
        });
        continue;
      }
      proof = "recomputed-hash";
      hash = local;
    } else if (!row.hash) {
      // No stored hash means this row was never verified to the standard the
      // journal promises. Refuse rather than assume.
      refused.push({
        srcPath: row.src_path,
        reason: "no stored hash for this file — re-run with --verify-hash",
      });
      continue;
    }

    eligible.push({
      deviceId: row.device_id,
      serial: device.serial,
      srcPath: row.src_path,
      destPath: row.dest_path,
      size: row.size,
      proof,
      hash,
    });
  }

  return {
    eligible,
    refused,
    bytesReclaimed: eligible.reduce((sum, c) => sum + c.size, 0),
  };
}

/**
 * Execute a purge plan.
 *
 * The drive copy is confirmed to still exist immediately before the delete —
 * the journal record can be stale, the filesystem cannot.
 */
export async function applyPurge(
  plan: PurgePlan,
  opts: PurgeOptions,
): Promise<{ deleted: number; failed: number }> {
  if (opts.dryRun || !opts.apply) return { deleted: 0, failed: 0 };

  let deleted = 0;
  let failed = 0;

  for (const candidate of plan.eligible) {
    if (!(await Bun.file(candidate.destPath).exists())) {
      opts.journal.event(
        "error",
        `purge refused: ${candidate.srcPath} — drive copy no longer exists`,
        undefined,
        { destPath: candidate.destPath },
      );
      failed++;
      continue;
    }

    const removed = await opts.transport.removeSource(candidate.serial, candidate.srcPath);
    if (removed) {
      deleted++;
      opts.journal.event("info", `purged from device: ${candidate.srcPath}`, undefined, {
        proof: candidate.proof,
      });
    } else {
      failed++;
    }
  }

  return { deleted, failed };
}