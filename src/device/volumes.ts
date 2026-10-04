/**
 * Volume discovery — the read-only half of `portage drives`.
 *
 * `lsblk --json` is the source of truth because it reports `RM` (removable) and
 * `TRAN` (usb/nvme), which `findmnt` alone cannot. Everything here READS; the
 * only place a drive is written to is `src/config/setup.ts`.
 */

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

function toBlock(node: Record<string, unknown>): RawBlock {
  const mountpoints = Array.isArray(node.mountpoints) ? node.mountpoints : [];
  const firstArrayMount = mountpoints.find((m) => asString(m) !== null);
  return {
    name: asString(node.name) ?? "",
    label: asString(node.label),
    fstype: asString(node.fstype),
    size: asString(node.size) ?? "",
    // `MOUNTPOINT` (with --output MOUNTPOINT) is a string|null; `MOUNTPOINTS` is
    // an array. Both appear across util-linux versions, so accept either.
    mountpoint: asString(node.mountpoint) ?? asString(firstArrayMount),
    rm: node.rm === true,
    tran: asString(node.tran),
    type: asString(node.type) ?? "",
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
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (typeof node !== "object" || node === null) continue;
      const record = node as Record<string, unknown>;
      out.push(toBlock(record));
      if (Array.isArray(record.children)) walk(record.children);
    }
  };
  walk(roots);
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
