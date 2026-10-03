/**
 * `portage doctor` — the environment report.
 *
 * The design rule here is from the plan: **advice with a copy-pasteable
 * command beats prose**. Every ✗ or ⚠ line is followed by the exact thing to
 * type. "Consider using a faster cable" is useless at 11pm with a season
 * waiting; `→ try the C-to-C cable on a USB 3 port (this bus negotiated 480M)`
 * is actionable.
 */

import { Adb, isUsb2, maxLinkSpeed, parseLsusbTree, type DeviceInfo } from "../../device/adb.ts";
import { diskSpace, isDirectory, statSyncSafe } from "../../util/fs.ts";
import { formatBytes } from "../../util/paths.ts";
import type { Output } from "../../output/output.ts";
import type { ResolvedConfig } from "../../config/load.ts";
import { requireDestRoot } from "../../config/load.ts";
import { Journal } from "../../index/journal.ts";
import { preconditionError } from "../../util/errors.ts";
import { realSpawn } from "../../util/spawn.ts";

export interface DoctorContext {
  resolved: ResolvedConfig;
  adb: Adb | null;
  output: Output;
  /** Measure real throughput. Slow — opt in with `--bench`. */
  bench: boolean;
}

/** One line of the report: a mark, a label, a value, and an optional fix. */
interface Row {
  mark: "ok" | "warn" | "fail" | "info";
  label: string;
  value: string;
  fix?: string;
}

export async function doctor(ctx: DoctorContext): Promise<number> {
  const { output } = ctx;
  const rows: Row[] = [];

  // --- adb --------------------------------------------------------------------
  if (!ctx.adb) {
    rows.push({
      mark: "fail",
      label: "adb",
      value: "not found on PATH",
      fix: "install Android platform-tools, or set adb_path in config",
    });
    render(rows);
    output.fail("adb is required — nothing else can work without it");
    return 2;
  }

  rows.push({ mark: "ok", label: "adb", value: `${await ctx.adb.version()}  ${ctx.adb.bin}` });

  // --- devices ----------------------------------------------------------------
  const devices = await ctx.adb.devices();
  const usable = devices.filter((d) => d.state === "device");

  if (devices.length === 0) {
    rows.push({
      mark: "fail",
      label: "devices",
      value: "none attached",
      fix: "plug in a phone, enable USB debugging, and accept the RSA prompt on the device",
    });
  } else {
    rows.push({
      mark: usable.length > 0 ? "ok" : "warn",
      label: "devices",
      value: `${usable.length}/${devices.length} ready`,
    });
    for (const device of devices) {
      if (device.unauthorized) {
        rows.push({
          mark: "warn",
          label: `  ${device.model || device.serial}`,
          value: "unauthorized — the RSA prompt is waiting on the phone",
          fix: "unlock the phone and tap 'Always allow from this computer'",
        });
      }
    }
  }

  // --- link speed -------------------------------------------------------------
  const linkInfo = await probeLinkSpeed();
  if (linkInfo) {
    const max = maxLinkSpeed(linkInfo.speeds);
    const isUsb2Link = isUsb2(max);
    rows.push({
      mark: isUsb2Link ? "warn" : "ok",
      label: "usb link",
      value: `${max}M`,
      fix: isUsb2Link
        ? "a 480M link caps transfers near 35 MB/s — try the C-to-C cable in a USB 3 port"
        : undefined,
    });
  }

  // --- phone-side hasher ------------------------------------------------------
  for (const device of usable.slice(0, 1)) {
    const hasher = await ctx.adb.hasHasher(device.serial);
    rows.push({
      mark: hasher ? "ok" : "fail",
      label: "phone sha256sum",
      value: hasher ? "available" : "missing",
      fix: hasher
        ? undefined
        : "verification needs a phone-side hash; without it nothing can be deleted safely",
    });

    const free = await ctx.adb.deviceFreeBytes(device.serial);
    if (free !== null) {
      rows.push({
        mark: free > 5e9 ? "ok" : "warn",
        label: "phone free",
        value: formatBytes(free),
        fix: free <= 5e9 ? "the phone is nearly full — downloads will start failing" : undefined,
      });
    }
  }

  // --- destination ------------------------------------------------------------
  const destRoot = ctx.resolved.config.dest_root;
  if (!destRoot) {
    rows.push({
      mark: "warn",
      label: "destination",
      value: "not configured",
      fix: "portage config set dest_root /media/<you>/<drive>/Videos/$Anime",
    });
  } else if (!(await isDirectory(destRoot))) {
    rows.push({
      mark: "fail",
      label: "destination",
      value: `${destRoot} does not exist`,
      fix: "plug in the drive, or fix dest_root",
    });
  } else {
    const space = diskSpace(destRoot);
    const fstype = await probeFstype(destRoot);
    const readonly = await isReadOnly(destRoot);

    if (readonly) {
      rows.push({
        mark: "fail",
        label: "destination",
        value: `${destRoot} is mounted read-only`,
        fix: "NTFS dirty bit — unmount, run `sudo ntfsfix /dev/<partition>`, or eject cleanly from Windows",
      });
    } else {
      rows.push({ mark: "ok", label: "destination", value: `${destRoot}  (${fstype})` });
    }

    if (space) {
      const usedPct = space.total > 0 ? Math.round((1 - space.free / space.total) * 100) : 0;
      rows.push({
        mark: usedPct > 90 ? "warn" : "ok",
        label: "  free",
        value: `${formatBytes(space.free)} of ${formatBytes(space.total)} (${usedPct}% used)`,
        fix: usedPct > 90 ? "portage dupes  — reclaim space from duplicate groups" : undefined,
      });
    }

    // Journal
    try {
      const journal = Journal.open(destRoot);
      const archive = journal.countArchive();
      const states = journal.countByState();
      rows.push({
        mark: "ok",
        label: "journal",
        value: `${archive.files} files tracked, ${formatBytes(archive.bytes)}` +
          (states.failed ? `, ${states.failed} failed` : ""),
      });
      journal.close();
    } catch (err) {
      rows.push({
        mark: "warn",
        label: "journal",
        value: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
        fix: `portage db info  — inspect, or move ${destRoot}/.portage aside to start a new journal`,
      });
    }
  }

  // --- benchmark --------------------------------------------------------------
  if (ctx.bench) {
    const result = await benchmark(ctx.adb, usable[0]);
    rows.push({
      mark: "info",
      label: "throughput",
      value: result ?? "not measured — no device to write from",
    });
  } else {
    rows.push({ mark: "info", label: "throughput", value: "not measured — use `portage doctor --bench`" });
  }

  // --- render -----------------------------------------------------------------
  render(rows);

  const hasFailure = rows.some((r) => r.mark === "fail");
  if (hasFailure && usable.length === 0) {
    output.fail("no usable device — fix the ✗ lines above and re-run doctor");
    return 2;
  }
  return 0;

  function render(list: Row[]): void {
    if (ctx.output.mode === "json") {
      output.emitJson({
        ok: !list.some((r) => r.mark === "fail"),
        checks: list.map((r) => ({
          status: r.mark,
          label: r.label,
          value: r.value,
          fix: r.fix ?? null,
        })),
      });
      return;
    }
    output.heading("portage doctor");
    for (const row of list) {
      switch (row.mark) {
        case "ok":
          output.ok(`${row.label.padEnd(18)}${row.value}`);
          break;
        case "warn":
          output.warn(`${row.label.padEnd(18)}${row.value}`);
          break;
        case "fail":
          output.fail(`${row.label.padEnd(18)}${row.value}`);
          break;
        default:
          output.line(`  ${row.label.padEnd(18)}${row.value}`);
      }
      if (row.fix) output.bullet(`→ ${row.fix}`);
    }
  }
}

/** `lsusb -t` gives the negotiated speed per device — the fastest way to spot a USB 2 cable. */
async function probeLinkSpeed(): Promise<{ speeds: Map<string, number> } | null> {
  const res = await realSpawn(["lsusb", "-t"], { timeoutMs: 5_000 }).catch(() => null);
  if (!res || res.code !== 0) return null;
  return { speeds: parseLsusbTree(res.stdout) };
}

async function probeFstype(path: string): Promise<string> {
  const res = await realSpawn(["findmnt", "-no", "FSTYPE", "--target", path], {
    timeoutMs: 5_000,
  }).catch(() => null);
  if (!res || res.code !== 0) return "unknown filesystem";
  const fstype = res.stdout.trim();
  const driver = await realSpawn(["findmnt", "-no", "OPTIONS", "--target", path], {
    timeoutMs: 5_000,
  }).catch(() => null);
  const opts = driver?.stdout ?? "";
  const isFuse = opts.includes("fuseblk") || opts.includes("ntfs-3g");
  return isFuse ? `${fstype} via ntfs-3g (FUSE)` : fstype;
}

async function isReadOnly(path: string): Promise<boolean> {
  const res = await realSpawn(["findmnt", "-no", "OPTIONS", "--target", path], {
    timeoutMs: 5_000,
  }).catch(() => null);
  const opts = res?.stdout.trim() ?? "";
  return opts === "ro" || opts.startsWith("ro,");
}

/**
 * Measure real throughput, including the flush.
 *
 * The number adb reports is not the number that matters: roughly 25 % of a
 * job's wall time is writeback it has already called finished. So this writes,
 * syncs, and only then stops the clock.
 */
async function benchmark(adb: Adb, device: DeviceInfo | undefined): Promise<string | null> {
  if (!device) return null;

  const source = "/sdcard/Download/.portage-bench.bin";
  const sizeBytes = 256 * 1024 * 1024;

  // A file the user already downloaded would be better (no writes on the
  // phone), but we cannot assume one exists. /data/local/tmp is writable by
  // the shell user and never touches /sdcard.
  await adb.shell(device.serial, `dd if=/dev/zero of=/data/local/tmp/portage-bench.bin bs=1M count=256 2>/dev/null`);
  void source;

  const tmp = `/tmp/portage-bench-${process.pid}.bin`;
  const started = Bun.nanoseconds();

  const res = await adb.pull(device.serial, "/data/local/tmp/portage-bench.bin", tmp, false, undefined, 900_000);
  if (res.code !== 0) {
    await adb.shell(device.serial, "rm -f /data/local/tmp/portage-bench.bin");
    await Bun.$`rm -f ${tmp}`.quiet().nothrow();
    return `failed (adb pull exited ${res.code})`;
  }

  // The part adb does not count.
  const sync = Bun.spawnSync(["sync", "-f", tmp], { stdout: "ignore", stderr: "ignore" });
  void sync;

  const seconds = (Bun.nanoseconds() - started) / 1_000_000_000;
  const mbPerSec = sizeBytes / 1_000_000 / seconds;

  await adb.shell(device.serial, "rm -f /data/local/tmp/portage-bench.bin");
  await Bun.$`rm -f ${tmp}`.quiet().nothrow();

  return `${mbPerSec.toFixed(1)} MB/s over 256 MB (transfer + flush)`;
}

export { preconditionError, requireDestRoot, statSyncSafe };