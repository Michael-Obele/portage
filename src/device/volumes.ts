/**
 * Volume discovery — the read-only half of `portage drives`.
 *
 * `lsblk --json` is the source of truth because it reports `RM` (removable) and
 * `TRAN` (usb/nvme), which `findmnt` alone cannot. Everything here READS; the
 * only place a drive is written to is `src/config/setup.ts`.
 */

import { join } from "node:path";
import { diskSpaceAsync, isDirectory, withTimeout } from "#lib/util/fs.ts";
import type { SpawnFn } from "#lib/util/spawn.ts";

/** One row of `lsblk` output, before any judgement about whether it is useful. */
export interface RawBlock {
  name: string;
  label: string | null;
  fstype: string | null;
  size: string;
  mountpoint: string | null;
  rm: boolean;
  tran: string | null;
  type: string;
}

/**
 * Filesystems that are never a destination: pseudo-filesystems and snap mounts.
 * Dropping them here (not in the command) is what keeps `portage drives`
 * honest — a user should never be offered `/run` as a place to archive to.
 */
export const JUNK_FILESYSTEMS: ReadonlySet<string> = new Set([
  "squashfs", "overlay", "tmpfs", "devtmpfs", "proc", "sysfs", "cgroup",
  "cgroup2", "autofs", "ramfs", "debugfs", "tracefs", "securityfs",
  "configfs", "fusectl", "mqueue", "hugetlbfs", "pstore", "bpf",
  "binfmt_misc", "nsfs", "efivarfs",
]);

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** How a block device is physically attached. `RM`/`TRAN` describe the LINK. */
export interface Link {
  rm: boolean;
  tran: string | null;
}

const UNPLUGGED: Link = { rm: false, tran: null };

/**
 * One node, with the link it inherits when it does not carry one itself.
 *
 * **`lsblk` reports `RM` and `TRAN` on the DISK row only.** A partition of a USB
 * drive prints `RM="0"` and `TRAN=""` even though the drive it lives on is
 * removable and connected over USB — verified against lsblk 2.39 with a real
 * USB disk: `/dev/sda` says `TRAN="usb"`, `/dev/sda1` says `TRAN=""`. Reading
 * the partition's own values made every external drive look internal, which is
 * the one fact this module exists to report. So a node that carries no link of
 * its own takes the one from the disk above it.
 */
function toBlock(node: Record<string, unknown>, inherited: Link): RawBlock {
  const mountpoints = Array.isArray(node.mountpoints) ? node.mountpoints : [];
  const firstArrayMount = mountpoints.find((m) => asString(m) !== null);
  const type = asString(node.type) ?? "";
  const own: Link = { rm: node.rm === true, tran: asString(node.tran) };
  // A disk states its own link. Anything else inherits FIELD BY FIELD: a node
  // that carries only half of one (a partition with `TRAN="usb"` and no `RM`)
  // must keep the half it has and take the half it lacks, not throw both away.
  const link: Link =
    type === "disk"
      ? own
      : { rm: own.rm || inherited.rm, tran: own.tran ?? inherited.tran };
  return {
    name: asString(node.name) ?? "",
    label: asString(node.label),
    fstype: asString(node.fstype),
    size: asString(node.size) ?? "",
    // `MOUNTPOINT` (with --output MOUNTPOINT) is a string|null; `MOUNTPOINTS` is
    // an array. Both appear across util-linux versions, so accept either.
    mountpoint: asString(node.mountpoint) ?? asString(firstArrayMount),
    rm: link.rm,
    tran: link.tran,
    type,
  };
}

/** Flatten `blockdevices` depth-first. Disks themselves have no mount point. */
export function parseLsblk(json: string): RawBlock[] {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return [];
  }
  const roots = (doc as { blockdevices?: unknown } | null)?.blockdevices;
  if (!Array.isArray(roots)) return [];

  const out: RawBlock[] = [];
  const walk = (nodes: unknown[], inherited: Link): void => {
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const record = node as Record<string, unknown>;
      const block = toBlock(record, inherited);
      out.push(block);
      // Children inherit what this node settled on, so a disk's link reaches
      // every partition under it (and a partition's own link wins if it has one).
      if (Array.isArray(record.children)) {
        walk(record.children, { rm: block.rm, tran: block.tran });
      }
    }
  };
  walk(roots, UNPLUGGED);
  return out;
}

/** A row worth showing: a real filesystem, mounted somewhere a person can use. */
export function isRealVolume(block: RawBlock): boolean {
  if (block.mountpoint === null) return false;
  if (block.fstype === null) return false;
  if (block.type === "loop" || block.name.startsWith("loop")) return false;
  if (JUNK_FILESYSTEMS.has(block.fstype)) return false;
  if (block.mountpoint.startsWith("/snap/")) return false;
  return true;
}

/** A mounted volume a person could choose as a destination. */
export interface Volume {
  /** `/dev/sda1` */
  device: string;
  /** Filesystem label, when it has one. */
  label: string | null;
  mountPoint: string;
  fsType: string;
  /** Human driver name: `ntfs3` (kernel) or `ntfs-3g` (FUSE). */
  driver: string;
  totalBytes: number;
  freeBytes: number;
  removable: boolean;
  /** `usb` / `nvme` / … from lsblk. */
  transport: string | null;
  /**
   * `true` when the live mount is read-only, `false` when it is writable, and
   * `null` when we could NOT verify it (`findmnt` failed, or reported no
   * options). Unknown is treated as a warning, never as "writable" — a
   * read-only NTFS mount is the classic failure this field exists to catch.
   */
  readOnly: boolean | null;
  /** A `.portage/` already exists under this mount. */
  isPortageDrive: boolean;
}

export const LSBLK_ARGS = [
  "lsblk", "--json", "--output",
  "NAME,LABEL,FSTYPE,SIZE,MOUNTPOINT,RM,TRAN,TYPE",
];

/** `fuseblk` is how ntfs-3g presents itself to the kernel; `ntfs3` is in-kernel. */
export function driverName(fsType: string): string {
  return fsType === "fuseblk" ? "ntfs-3g" : fsType;
}

/**
 * Probe for the state directory at the mount root, then one level in — which is
 * the usual shape, because the destination is typically `<drive>/Videos/$Anime`.
 * Never throws: a mount we cannot read is simply not a Portage drive.
 */
export async function isPortageDrive(mountPoint: string): Promise<boolean> {
  try {
    if (await isDirectory(join(mountPoint, ".portage"))) return true;
    const glob = new Bun.Glob("*/.portage");
    for await (const hit of glob.scan({
      cwd: mountPoint,
      dot: true,
      onlyFiles: false,
    })) {
      if (hit) return true;
    }
  } catch {
    /* unreadable mount */
  }
  return false;
}

/**
 * Read the live mount's driver and options, so a kernel-`ntfs3` mount is told
 * apart from a `fuseblk`/ntfs-3g one, and a read-only mount is visible rather
 * than silent. `lsblk` reports both as `ntfs`, so only `findmnt` knows. When
 * `findmnt` cannot answer, `readOnly` is `null` (unknown — never assumed
 * writable) and the caller falls back to the `lsblk` driver name.
 */
async function mountOptions(
  spawn: SpawnFn,
  mountPoint: string,
): Promise<{ driver: string | null; readOnly: boolean | null }> {
  const res = await spawn(
    ["findmnt", "-no", "FSTYPE,OPTIONS", "--target", mountPoint],
    { timeoutMs: 5_000 },
  );
  // Could not verify: fail closed and say so, rather than guessing "writable".
  if (res.code !== 0) return { driver: null, readOnly: null };
  // Output is `ntfs3 rw,relatime,uid=1000` — driver first, then the option list.
  const [fsType = "", optionList = ""] = res.stdout.trim().split(/\s+/, 2);
  return {
    driver: fsType ? driverName(fsType) : null,
    // No option list means findmnt told us nothing about the mount mode.
    readOnly: optionList ? optionList.split(",").includes("ro") : null,
  };
}

/** Injection points, so a unit test never reads a real mount. */
export interface ListVolumesOptions {
  /** Defaults to the real `.portage` probe. */
  isPortageDrive?: (mountPoint: string) => Promise<boolean>;
}

/** Every mounted volume worth offering, enriched for display and for safety. */
export async function listVolumes(
  spawn: SpawnFn,
  options: ListVolumesOptions = {},
): Promise<Volume[]> {
  const probePortage = options.isPortageDrive ?? isPortageDrive;
  const res = await spawn(LSBLK_ARGS, { timeoutMs: 10_000 });
  if (res.code !== 0) return [];

  const volumes: Volume[] = [];
  for (const block of parseLsblk(res.stdout)) {
    if (!isRealVolume(block)) continue;
    const mountPoint = block.mountpoint as string;
    const fsType = block.fstype as string;
    // Every probe here is BOUNDED. A wedged mount used to block the event loop
    // inside `spawnSync`, which meant `volumes.list` never answered and every
    // screen that reads a volume list hung with it — the app looked dead
    // because one drive was sick.
    const space = await diskSpaceAsync(spawn, mountPoint);
    const live = await mountOptions(spawn, mountPoint);
    volumes.push({
      device: `/dev/${block.name}`,
      label: block.label,
      mountPoint,
      fsType,
      driver: live.driver ?? driverName(fsType),
      totalBytes: space?.total ?? 0,
      freeBytes: space?.free ?? 0,
      removable: block.rm,
      transport: block.tran,
      readOnly: live.readOnly,
      // A glob walk on a hung mount never returns; treat it as "not a portage drive".
      isPortageDrive: await withTimeout(probePortage(mountPoint), 3_000, false),
    });
  }
  return volumes;
}
