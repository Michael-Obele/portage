import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  driverName,
  isPortageDrive,
  isRealVolume,
  listVolumes,
  parseLsblk,
} from "../src/device/volumes.ts";
import type { SpawnFn } from "../src/util/spawn.ts";

/** Shape matches `lsblk --json --output NAME,LABEL,FSTYPE,SIZE,MOUNTPOINT,RM,TRAN,TYPE`. */
export const LSBLK = JSON.stringify({
  blockdevices: [
    {
      name: "sda", label: null, fstype: null, size: "1.8T",
      mountpoint: null, rm: false, tran: "usb", type: "disk",
      children: [
        { name: "sda1", label: "2TB", fstype: "ntfs", size: "1.8T",
          mountpoint: "/media/node/2TB", rm: false, tran: "usb", type: "part" },
      ],
    },
    {
      name: "nvme0n1", label: null, fstype: null, size: "476.9G",
      mountpoint: null, rm: false, tran: "nvme", type: "disk",
      children: [
        { name: "nvme0n1p2", label: null, fstype: "ext4", size: "475G",
          mountpoint: "/", rm: false, tran: "nvme", type: "part" },
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
    const volumes = await listVolumes(fakeSpawn);
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
    const volumes = await listVolumes(ro);
    expect(volumes[0]!.readOnly).toBe(true);
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
