/**
 * Test helpers: a journal on a temp drive, and a fake device.
 *
 * Every test runs against a real SQLite file on a real filesystem, because the
 * behaviour that matters most here — WAL on an NTFS-via-FUSE mount, partial
 * files surviving a crash, `path_norm` collisions — only shows up on a disk.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Journal } from "../src/index/journal.ts";
import type { DeviceInfo } from "../src/device/adb.ts";
import { deviceId } from "../src/device/adb.ts";

export interface TempDrive {
  root: string;
  stateDir: string;
  partialDir: string;
  trashDir: string;
  cleanup(): Promise<void>;
}

export async function makeTempDrive(prefix = "portage-test-"): Promise<TempDrive> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const stateDir = join(root, ".portage");
  const partialDir = join(stateDir, "partial");
  const trashDir = join(stateDir, "trash");
  await Promise.all([
    Bun.write(join(stateDir, ".keep"), "").then(() => undefined),
    import("node:fs/promises").then((fs) =>
      Promise.all([fs.mkdir(partialDir, { recursive: true }), fs.mkdir(trashDir, { recursive: true })]),
    ),
  ]);

  return {
    root,
    stateDir,
    partialDir,
    trashDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** A journal opened on a temp drive, with a guaranteed close. */
export function openJournal(drive: TempDrive): Journal {
  return Journal.open(drive.root);
}

export function fakeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  const serial = overrides.serial ?? "fakeserial";
  return {
    id: deviceId(serial),
    serial,
    state: "device",
    model: "Pixel 10 Pro XL",
    android: "17",
    unauthorized: false,
    ...overrides,
  };
}

/** A file with deterministic content, for hash comparisons. */
export async function writeFixture(path: string, sizeBytes: number, fill = 0x41): Promise<string> {
  await Bun.write(path, new Uint8Array(sizeBytes).fill(fill));
  return path;
}

/** The sha256 of the same content, computed the way a test asserts it. */
export function sha256OfBytes(sizeBytes: number, fill = 0x41): string {
  return new Bun.CryptoHasher("sha256").update(new Uint8Array(sizeBytes).fill(fill)).digest("hex");
}

/** Seconds since epoch, `n` seconds ago. */
export function secondsAgo(n: number): number {
  return Math.floor(Date.now() / 1000) - n;
}