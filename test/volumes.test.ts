import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diskSpaceAsync,
  withTimeout,
} from "../src/util/fs.ts";
import {
  driverName,
  isPortageDrive,
  isRealVolume,
  listVolumes,
  parseLsblk,
} from "../src/device/volumes.ts";
import type { SpawnFn } from "../src/util/spawn.ts";

/**
 * Shape matches `lsblk --json --output NAME,LABEL,FSTYPE,SIZE,MOUNTPOINT,RM,TRAN,TYPE`.
 *
 * The partitions deliberately carry `rm: false, tran: ""` — which is what real
 * lsblk prints for them, even on a USB drive. Only the DISK row says how the
 * hardware is attached.
 */
export const LSBLK = JSON.stringify({
  blockdevices: [
    {
      name: "sda", label: null, fstype: null, size: "1.8T",
      mountpoint: null, rm: false, tran: "usb", type: "disk",
      children: [
        { name: "sda1", label: "2TB", fstype: "ntfs", size: "1.8T",
          mountpoint: "/media/node/2TB", rm: false, tran: "", type: "part" },
      ],
    },
    {
      name: "nvme0n1", label: null, fstype: null, size: "476.9G",
      mountpoint: null, rm: false, tran: "nvme", type: "disk",
      children: [
        { name: "nvme0n1p2", label: null, fstype: "ext4", size: "475G",
          mountpoint: "/", rm: false, tran: "", type: "part" },
      ],
    },
    { name: "loop3", label: null, fstype: "squashfs", size: "64M",
      mountpoint: "/snap/core/1", rm: false, tran: null, type: "loop" },
    { name: "tmpfs", label: null, fstype: "tmpfs", size: "7.7G",
      mountpoint: "/run", rm: false, tran: null, type: "loop" },
    { name: "sdb1", label: "BACKUP", fstype: "exfat", size: "119.2G",
      mountpoint: null, rm: true, tran: "usb", type: "part" },
  ],
});

describe("lsblk parsing", () => {
  test("flattens disks and their children depth-first", () => {
    const rows = parseLsblk(LSBLK);
    expect(rows.map((r) => r.name)).toEqual([
      "sda", "sda1", "nvme0n1", "nvme0n1p2", "loop3", "tmpfs", "sdb1",
    ]);
  });

  test("keeps only real mounted filesystems", () => {
    const real = parseLsblk(LSBLK).filter(isRealVolume);
    expect(real.map((r) => r.name)).toEqual(["sda1", "nvme0n1p2"]);
  });

  test("a partition inherits the disk's transport and removability", () => {
    // The bug this pins: partitions print no `TRAN` of their own, so a USB
    // drive was reported as internal with no transport at all.
    const rows = parseLsblk(LSBLK);
    const usb = rows.find((r) => r.name === "sda1")!;
    expect(usb.tran).toBe("usb");
    expect(usb.rm).toBe(false);

    const internal = rows.find((r) => r.name === "nvme0n1p2")!;
    expect(internal.tran).toBe("nvme");
  });

  test("a removable disk's partition inherits removability", () => {
    const doc = JSON.stringify({
      blockdevices: [
        {
          name: "sdc", label: null, fstype: null, size: "32G",
          mountpoint: null, rm: true, tran: "usb", type: "disk",
          children: [
            { name: "sdc1", label: null, fstype: "vfat", size: "32G",
              mountpoint: "/media/node/STICK", rm: false, tran: "", type: "part" },
          ],
        },
      ],
    });
    const part = parseLsblk(doc).find((r) => r.name === "sdc1")!;
    expect(part.rm).toBe(true);
    expect(part.tran).toBe("usb");
  });

  test("a partition that states its own link keeps it", () => {
    const doc = JSON.stringify({
      blockdevices: [
        {
          name: "sdd", label: null, fstype: null, size: "1T",
          mountpoint: null, rm: false, tran: "sata", type: "disk",
          children: [
            { name: "sdd1", label: null, fstype: "ext4", size: "1T",
              mountpoint: "/data", rm: true, tran: "usb", type: "part" },
          ],
        },
      ],
    });
    const part = parseLsblk(doc).find((r) => r.name === "sdd1")!;
    expect(part.rm).toBe(true);
    expect(part.tran).toBe("usb");
  });

  test("inheritance is field by field, not all or nothing", () => {
    // A node carrying HALF a link must keep the half it has and take the half it
    // lacks. An all-or-nothing rule read `{rm:false, tran:"usb"}` as "has its
    // own link" and dropped the parent's `rm`, reporting a removable stick as
    // internal — the same class of bug this whole change fixes.
    const doc = JSON.stringify({
      blockdevices: [
        {
          name: "sde", label: null, fstype: null, size: "64G",
          mountpoint: null, rm: true, tran: "usb", type: "disk",
          children: [
            { name: "sde1", label: null, fstype: "exfat", size: "64G",
              mountpoint: "/media/node/A", rm: false, tran: "usb", type: "part" },
            { name: "sde2", label: null, fstype: "exfat", size: "1G",
              mountpoint: "/media/node/B", rm: true, tran: "", type: "part" },
          ],
        },
      ],
    });
    const rows = parseLsblk(doc);
    const halfTransport = rows.find((r) => r.name === "sde1")!;
    expect(halfTransport.tran).toBe("usb");
    expect(halfTransport.rm).toBe(true);

    const halfRemovable = rows.find((r) => r.name === "sde2")!;
    expect(halfRemovable.rm).toBe(true);
    expect(halfRemovable.tran).toBe("usb");
  });

  test("a broken or empty document yields no rows instead of throwing", () => {
    expect(parseLsblk("not json")).toEqual([]);
    expect(parseLsblk("{}")).toEqual([]);
    expect(parseLsblk("null")).toEqual([]);
  });

  test("accepts the MOUNTPOINTS array form as well as MOUNTPOINT", () => {
    const doc = JSON.stringify({
      blockdevices: [
        { name: "sdc1", label: "X", fstype: "exfat", size: "1G",
          mountpoints: [null, "/media/node/X"], rm: true, tran: "usb", type: "part" },
      ],
    });
    expect(parseLsblk(doc)[0]!.mountpoint).toBe("/media/node/X");
  });
});

const fakeSpawn: SpawnFn = async (cmd) => {
  if (cmd[0] === "lsblk") return { code: 0, stdout: LSBLK, stderr: "", durationMs: 1 };
  if (cmd[0] === "findmnt")
    return { code: 0, stdout: "ntfs3 rw,relatime\n", stderr: "", durationMs: 1 };
  return { code: 1, stdout: "", stderr: "", durationMs: 1 };
};

describe("volume enrichment", () => {
  test("fuseblk is reported as the ntfs-3g driver", () => {
    expect(driverName("fuseblk")).toBe("ntfs-3g");
    expect(driverName("ntfs3")).toBe("ntfs3");
    expect(driverName("ext4")).toBe("ext4");
  });

  test("listVolumes keeps only real volumes and reads the mount options", async () => {
    const volumes = await listVolumes(fakeSpawn, { isPortageDrive: async () => false });
    expect(volumes.map((v) => v.mountPoint)).toEqual(["/media/node/2TB", "/"]);
    expect(volumes[0]!.driver).toBe("ntfs3");
    expect(volumes[0]!.readOnly).toBe(false);
    expect(volumes[0]!.removable).toBe(false);
    expect(volumes[0]!.transport).toBe("usb");
    expect(volumes[0]!.device).toBe("/dev/sda1");
  });

  test("a read-only mount is reported as read-only", async () => {
    const ro: SpawnFn = async (cmd) =>
      cmd[0] === "lsblk"
        ? { code: 0, stdout: LSBLK, stderr: "", durationMs: 1 }
        : { code: 0, stdout: "ntfs3 ro,nosuid\n", stderr: "", durationMs: 1 };
    const volumes = await listVolumes(ro, { isPortageDrive: async () => false });
    expect(volumes[0]!.readOnly).toBe(true);
  });

  test("a findmnt failure reports unknown readOnly and keeps the lsblk driver", async () => {
    // findmnt dies (e.g. the path is not on a mounted filesystem). We must not
    // guess "writable" — a read-only NTFS mount would be offered as writable.
    const blind: SpawnFn = async (cmd) =>
      cmd[0] === "lsblk"
        ? { code: 0, stdout: LSBLK, stderr: "", durationMs: 1 }
        : { code: 1, stdout: "", stderr: "not mounted", durationMs: 1 };
    const volumes = await listVolumes(blind, { isPortageDrive: async () => false });
    expect(volumes[0]!.readOnly).toBeNull();
    expect(volumes[0]!.driver).toBe("ntfs");
  });

  test("a blank findmnt options field reports unknown readOnly", async () => {
    const blank: SpawnFn = async (cmd) =>
      cmd[0] === "lsblk"
        ? { code: 0, stdout: LSBLK, stderr: "", durationMs: 1 }
        : { code: 0, stdout: "ntfs3\n", stderr: "", durationMs: 1 };
    const volumes = await listVolumes(blank);
    expect(volumes[0]!.readOnly).toBeNull();
    expect(volumes[0]!.driver).toBe("ntfs3");
  });

  test("disk space is reported as non-negative numbers", async () => {
    // `diskSpace` shells out to the real `df` for a path that does not exist in
    // tests, so assert shape, not exact values.
    const volumes = await listVolumes(fakeSpawn);
    for (const v of volumes) {
      expect(typeof v.totalBytes).toBe("number");
      expect(typeof v.freeBytes).toBe("number");
      expect(v.totalBytes).toBeGreaterThanOrEqual(0);
      expect(v.freeBytes).toBeGreaterThanOrEqual(0);
    }
  });

  test("a missing lsblk yields no volumes rather than throwing", async () => {
    const dead: SpawnFn = async () => ({ code: 127, stdout: "", stderr: "not found", durationMs: 1 });
    expect(await listVolumes(dead)).toEqual([]);
  });

  test("finds .portage at the mount root or one level in", async () => {
    const root = await mkdtemp(join(tmpdir(), "portage-vol-"));
    await mkdir(join(root, "Anime", ".portage"), { recursive: true });
    expect(await isPortageDrive(root)).toBe(true);
    expect(await isPortageDrive(join(root, "nope"))).toBe(false);
  });
});

describe("bounded probes", () => {
  test("withTimeout returns the fallback instead of waiting", async () => {
    const never = new Promise<string>(() => {});
    const started = Date.now();
    const value = await withTimeout(never, 40, "fallback");
    expect(value).toBe("fallback");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("withTimeout passes a fast result through", async () => {
    expect(await withTimeout(Promise.resolve("fast"), 1_000, "fallback")).toBe("fast");
  });

  test("diskSpaceAsync parses df, and a failed df is null not zero", async () => {
    // `df -B1 --output=size,avail` prints TWO columns, header first.
    const ok = async () => ({ code: 0, stdout: "  Size   Avail\n   100      60\n", stderr: "", durationMs: 1 });
    expect(await diskSpaceAsync(ok, "/x")).toEqual({ total: 100, free: 60 });

    const bad = async () => ({ code: 1, stdout: "", stderr: "", durationMs: 1 });
    expect(await diskSpaceAsync(bad, "/x")).toBeNull();
  });
});
