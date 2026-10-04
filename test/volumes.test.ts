import { describe, expect, test } from "bun:test";
import { isRealVolume, parseLsblk } from "../src/device/volumes.ts";

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
