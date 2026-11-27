
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
import type { DestinationProbe } from "../src/index/recovery.ts";
import { diskSpaceAsync } from "../src/util/fs.ts";
import { realSpawn, type SpawnFn } from "../src/util/spawn.ts";

export interface TempDrive {
  root: string;
  stateDir: string;
  partialDir: string;
  trashDir: string;
  cleanup(): Promise<void>;
}

export async function makeTempDrive(
  prefix = "portage-test-",
): Promise<TempDrive> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const stateDir = join(root, ".portage");
  const partialDir = join(stateDir, "partial");
  const trashDir = join(stateDir, "trash");
  await Promise.all([
    Bun.write(join(stateDir, ".keep"), "").then(() => undefined),
    import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(partialDir, { recursive: true }),
        fs.mkdir(trashDir, { recursive: true }),
      ]),
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

/** The sha256 of the same content, computed the way a test asserts it. */
export function sha256OfBytes(sizeBytes: number, fill = 0x41): string {
  return new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(sizeBytes).fill(fill))
    .digest("hex");
}

/** Seconds since epoch, `n` seconds ago. */
export function secondsAgo(n: number): number {
  return Math.floor(Date.now() / 1000) - n;
}

/** A mounted destination at `/mnt/archive` with the real free space of `root`. */
export async function mountedProbe(root: string): Promise<DestinationProbe> {
  const space = await diskSpaceAsync(realSpawn, root);
  if (space === null) throw new Error(`df could not read ${root}`);
  return {
    mount: {
      kind: "mounted",
      fsType: "ext4",
      options: "rw,relatime",
      target: "/mnt/archive",
    },
    space: { kind: "ok", free: space.free, total: space.total },
  };
}

/** findmnt reports a mounted ext4 target; every other command is real. */
export const mountedSpawn: SpawnFn = (cmd, opts) =>
  cmd[0] === "findmnt"
    ? Promise.resolve({
        code: 0,
        stdout: "ext4 rw,relatime /mnt/archive\n",
        stderr: "",
        durationMs: 1,
      })
    : realSpawn(cmd, opts);

/**
 * Seeded case generator for the send properties. A failing case rethrows with
 * its seed, so the case can be replayed (Conventions: no property library, N3).
 */
export interface Rng {
  seed: number;
  int(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  bool(): boolean;
  text(alphabet: string, max: number): string;
}

export function seededCases(
  seed: number,
  n: number,
  body: (rng: Rng, index: number) => void,
): void {
  for (let index = 0; index < n; index++) {
    const caseSeed = seed * 100_003 + index;
    let s = caseSeed >>> 0 || 1;
    const next = () => {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      return s / 0x80000000;
    };
    const rng: Rng = {
      seed: caseSeed,
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      pick: (items) => items[Math.floor(next() * items.length)] as never,
      bool: () => next() < 0.5,
      text: (alphabet, max) => {
        const len = Math.floor(next() * (max + 1));
        let out = "";
        for (let i = 0; i < len; i++) {
          out += alphabet[Math.floor(next() * alphabet.length)];
        }
        return out;
      },
    };
    try {
      body(rng, index);
    } catch (err) {
      throw new Error(
        `property case failed: seed ${caseSeed} (index ${index}): ${String(err)}`,
      );
    }
  }
}

/** One phone call the send made, in order. */
export interface FakeCall {
  method: string;
  serial: string;
  path?: string;
  args: string[];
}

/** Scripted outcomes a test can set per method. Unset methods succeed. */
export type FakeOutcome =
  | "ok"
  | { exitCode: number }
  | "deadline"
  | "unplug"
  | "wrong-digest"
  | "missing-sentinel"
  | "byte-stall"
  | "removal-failure";

/** Records every phone call in order and answers from a script. */
export class FakeAdb {
  readonly calls: FakeCall[] = [];
  private readonly script = new Map<string, FakeOutcome>();

  setOutcome(method: string, outcome: FakeOutcome): void {
    this.script.set(method, outcome);
  }

  call(
    method: string,
    serial: string,
    path?: string,
    args: string[] = [],
  ): FakeOutcome {
    this.calls.push({ method, serial, path, args });
    return this.script.get(method) ?? "ok";
  }
}

/** Records archive reads, host temporary files, and relay handles on a fixed clock. */
export class FakeHost {
  readonly archiveReads: string[] = [];
  readonly tempFiles = new Set<string>();
  readonly relays = new Set<number>();
  private clock: number;

  constructor(startMs = 0) {
    this.clock = startMs;
  }

  now(): number {
    return this.clock;
  }

  advance(ms: number): void {
    this.clock += ms;
  }
}
