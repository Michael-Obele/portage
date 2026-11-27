/**
 * `portage doctor` — the environment report.
 *
 * The design rule here is from the plan: **advice with a copy-pasteable
 * command beats prose**. Every ✗ or ⚠ line is followed by the exact thing to
 * type. "Consider using a faster cable" is useless at 11pm with a season
 * waiting; `→ try the C-to-C cable on a USB 3 port (this bus negotiated 480M)`
 * is actionable.
 */

import {
  Adb,
  isUsb2,
  maxLinkSpeed,
  parseLsusbTree,
  type DeviceInfo,
} from "#lib/device/adb.ts";
import { diskSpaceAsync } from "#lib/util/fs.ts";
import { syncFileOnly, type FlushOutcome } from "#lib/util/durable.ts";
import {
  PROBE_TIMEOUT_MS,
  formatDeadline,
  probe as driveProbe,
  statDrive,
} from "#lib/util/probe.ts";
import { formatBytes } from "#lib/util/paths.ts";
import type { Output } from "#lib/output/output.ts";
import type { ResolvedConfig } from "#lib/config/load.ts";
import { ALWAYS_EXCLUDED_DIRS } from "#lib/config/schema.ts";
import { defaultScanIo } from "#lib/dedupe/scan-io.ts";
import { probeScanner, resolveScanner, scannerWalk } from "#lib/dedupe/scanner.ts";
import { readTrash } from "#lib/dedupe/trash.ts";

import { Journal } from "#lib/index/journal.ts";

import { realSpawn, type SpawnFn } from "#lib/util/spawn.ts";

export interface DoctorContext {
  resolved: ResolvedConfig;
  adb: Adb | null;
  output: Output;
  /** Measure real throughput. Slow — opt in with `--bench`. */
  bench: boolean;
  /** Test seams: a fake spawn and stat, and a shorter deadline. */
  deps?: {
    spawn?: SpawnFn;
    statDrive?: typeof statDrive;
    timeoutMs?: number;
  };
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
      mark: "warn",
      label: "adb",
      value: "not found on PATH or in an Android SDK folder",
      fix: "only transfers need adb — install Android platform-tools for those, or carry on with the drive",
    });
  } else {
    rows.push({
      mark: "ok",
      label: "adb",
      value: `${await ctx.adb.version()}  ${ctx.adb.bin}${
        ctx.adb.source === "search" ? "  (found by search, not on PATH)" : ""
      }`,
    });

    // A configured path that does not resolve is worth saying out loud: the
    // engine kept going with another adb, which is not what the config asked for.
    const configuredAdb = ctx.resolved.config.adb_path;
    if (configuredAdb && ctx.adb.source !== "config") {
      rows.push({
        mark: "warn",
        label: "adb_path",
        value: `${configuredAdb} is not an executable — ignored`,
        fix: `point adb_path at ${ctx.adb.bin}, or clear it and let the search run`,
      });
    }
  }

  // --- devices ----------------------------------------------------------------
  const devices = ctx.adb ? await ctx.adb.devices() : [];
  const usable = devices.filter((d) => d.state === "device");

  if (devices.length === 0) {
    rows.push({
      mark: "warn",
      label: "devices",
      value: ctx.adb ? "none attached" : "not checked — adb is not installed",
      fix: "a transfer needs one: plug in a phone, enable USB debugging, and accept the RSA prompt on the device",
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
  const phoneAdb = ctx.adb;
  for (const device of phoneAdb ? usable.slice(0, 1) : []) {
    if (!phoneAdb) break;
    const hasher = await phoneAdb.hasHasher(device.serial);
    rows.push({
      mark: hasher ? "ok" : "fail",
      label: "phone sha256sum",
      value: hasher ? "available" : "missing",
      fix: hasher
        ? undefined
        : "verification needs a phone-side hash; without it nothing can be deleted safely",
    });

    const free = await phoneAdb.deviceFreeBytes(device.serial);
    if (free !== null) {
      rows.push({
        mark: free > 5e9 ? "ok" : "warn",
        label: "phone free",
        value: formatBytes(free),
        fix:
          free <= 5e9
            ? "the phone is nearly full — downloads will start failing"
            : undefined,
      });
    }
  }

  // --- destination ------------------------------------------------------------
  const destRoot = ctx.resolved.config.dest_root;
  const spawn = ctx.deps?.spawn ?? realSpawn;
  const stat = ctx.deps?.statDrive ?? statDrive;
  const deadlineMs = ctx.deps?.timeoutMs ?? PROBE_TIMEOUT_MS;
  const destRead = destRoot ? await stat(destRoot, destRoot, deadlineMs) : null;
  if (!destRoot || destRead === null) {
    rows.push({
      mark: "warn",
      label: "destination",
      value: "not configured",
      fix: "portage config set dest_root /media/<you>/<drive>/Videos/$Anime",
    });
  } else if (destRead.kind === "unreadable") {
    rows.push({
      mark: "fail",
      label: "destination",
      value: `${destRoot}: the destination could not be read`,
      fix: "the drive did not answer — replug it, then run doctor again",
    });
  } else if (destRead.kind === "missing" || !destRead.value.isDir) {
    rows.push({
      mark: "fail",
      label: "destination",
      value: `${destRoot} does not exist`,
      fix: "plug in the drive, or fix dest_root",
    });
  } else {
    const read = await driveProbe(
      destRoot,
      "df",
      () => diskSpaceAsync(spawn, destRoot, deadlineMs),
      deadlineMs,
    );
    const space = read.kind === "ok" ? read.value : null;
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
      rows.push({
        mark: "ok",
        label: "destination",
        value: `${destRoot}  (${fstype})`,
      });
    }

    if (space) {
      const usedPct =
        space.total > 0 ? Math.round((1 - space.free / space.total) * 100) : 0;
      rows.push({
        mark: usedPct > 90 ? "warn" : "ok",
        label: "  free",
        value: `${formatBytes(space.free)} of ${formatBytes(space.total)} (${usedPct}% used)`,
        fix:
          usedPct > 90
            ? "portage dupes  — reclaim space from duplicate groups"
            : undefined,
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
        value:
          `${archive.files} files tracked, ${formatBytes(archive.bytes)}` +
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

  // --- the scanner ------------------------------------------------------------
  //
  // A scan's speed is a property of this machine, not of the drive's contents,
  // and the difference is 43x (178 s against 4 s on the real archive). So the
  // walker is a thing doctor checks, not a detail it assumes.
  const probe = await probeScanner();
  if (probe === null) {
    rows.push({
      mark: "warn",
      label: "scanner",
      value: "portage-scan not found — scans fall back to the slow built-in walker",
      fix: "cargo build --release --manifest-path crates/portage-scan/Cargo.toml   (bundled builds ship it)",
    });
  } else {
    rows.push({ mark: "ok", label: "scanner", value: `${probe.version}  ${probe.path}` });
  }

  // --- the archive's own walk -------------------------------------------------
  const driveReady =
    destRead?.kind === "ok" && destRead.value.isDir && destRoot !== "";
  if (destRead?.kind === "unreadable") {
    rows.push({
      mark: "warn",
      label: "walk",
      value: "the destination could not be read",
      fix: "the walk was skipped; replug the drive, then run doctor again",
    });
  } else if (driveReady && probe !== null) {
    const walked = await scannerWalk(probe.path, [destRoot], [
      ...ALWAYS_EXCLUDED_DIRS,
    ]).catch(() => null);
    if (walked === null) {
      rows.push({
        mark: "warn",
        label: "walk",
        value: "the scanner could not finish a walk of the destination",
        fix: "a mount that has stopped answering does this — replug the drive",
      });
    } else {
      rows.push({
        mark: "ok",
        label: "walk",
        value: `${walked.files.length} files in ${(walked.elapsedMs / 1000).toFixed(1)} s`,
      });
      if (walked.errorCount > 0) {
        const first = walked.errors[0];
        rows.push({
          mark: "warn",
          label: "  unreadable",
          value: `${walked.errorCount} path(s) — ${first ? `${first.path}: ${first.reason}` : "no detail"}`,
          fix: "an unreadable file cannot be a duplicate candidate; on NTFS this is usually a damaged sector",
        });
      }
      if (walked.depthLimited > 0) {
        rows.push({
          mark: "warn",
          label: "  too deep",
          value: `${walked.depthLimited} folder(s) were not descended`,
        });
      }
      // A path this deep is what makes a full-path walker quadratic on a FUSE
      // mount; the scanner copes, and knowing it exists explains the odd slow
      // tool that does not.
      if (walked.deepest !== null && walked.deepest.depth >= 64) {
        rows.push({
          mark: "warn",
          label: "  deep path",
          value: `${walked.deepest.depth} segments — ${walked.deepest.relative.slice(0, 80)}`,
          fix: "a path this deep is usually a symlink loop or a copy-of-copy folder; it slows every tool that resolves full paths",
        });
      }
    }
  }

  // --- the trash --------------------------------------------------------------
  if (driveReady) {
    const trash = await readTrash(destRoot, defaultScanIo()).catch(() => null);
    if (trash === null) {
      rows.push({ mark: "info", label: "trash", value: "could not be read" });
    } else if (trash.totalBytes > 0) {
      rows.push({
        mark: "warn",
        label: "trash",
        value: `${trash.totalFiles} files · ${formatBytes(trash.totalBytes)} — still on the drive`,
        fix: "Duplicates → Empty the trash. Moving a duplicate frees nothing until the trash is emptied",
      });
    } else {
      rows.push({ mark: "ok", label: "trash", value: "empty" });
    }
  }

  // --- benchmark --------------------------------------------------------------
  if (ctx.bench) {
    const result = ctx.adb ? await benchmark(ctx.adb, usable[0]) : null;
    rows.push({
      mark: "info",
      label: "throughput",
      value: result ?? "not measured — no device to write from",
    });
  } else {
    rows.push({
      mark: "info",
      label: "throughput",
      value: "not measured — use `portage doctor --bench`",
    });
  }

  // --- render -----------------------------------------------------------------
  render(rows);

  const hasFailure = rows.some((r) => r.mark === "fail");
  // A phone-less machine is a SUPPORTED state: tidying the archive drive needs
  // no device at all. So a failure only fails the exit code when it is about the
  // drive, or when a phone is actually attached and broken.
  const driveBroken = rows.some(
    (r) => r.mark === "fail" && (r.label.trim() === "destination" || r.label.trim() === "journal"),
  );
  if (driveBroken) {
    output.fail("the destination is not usable — fix the ✗ lines above and re-run doctor");
    return 2;
  }
  if (hasFailure && usable.length > 0) {
    output.fail("the phone is not ready — fix the ✗ lines above and re-run doctor");
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
async function probeLinkSpeed(): Promise<{
  speeds: Map<string, number>;
} | null> {
  const res = await realSpawn(["lsusb", "-t"], { timeoutMs: 5_000 }).catch(
    () => null,
  );
  if (!res || res.code !== 0) return null;
  return { speeds: parseLsusbTree(res.stdout) };
}

async function probeFstype(path: string): Promise<string> {
  const res = await realSpawn(["findmnt", "-no", "FSTYPE", "--target", path], {
    timeoutMs: 3_000,
  }).catch(() => null);
  if (!res || res.code !== 0) return "unknown filesystem";
  const fstype = res.stdout.trim();
  const driver = await realSpawn(
    ["findmnt", "-no", "OPTIONS", "--target", path],
    {
      timeoutMs: 3_000,
    },
  ).catch(() => null);
  const opts = driver?.stdout ?? "";
  const isFuse = opts.includes("fuseblk") || opts.includes("ntfs-3g");
  return isFuse ? `${fstype} via ntfs-3g (FUSE)` : fstype;
}

async function isReadOnly(path: string): Promise<boolean> {
  const res = await realSpawn(["findmnt", "-no", "OPTIONS", "--target", path], {
    timeoutMs: 3_000,
  }).catch(() => null);
  const opts = res?.stdout.trim() ?? "";
  return opts === "ro" || opts.startsWith("ro,");
}

/** Pure. A flush that got no answer is "check failed", never "healthy". */
export function doctorFlushMessage(outcome: FlushOutcome): string {
  switch (outcome.kind) {
    case "ok":
      return "the flush was confirmed";
    case "timeout":
      return `check failed: no answer within ${formatDeadline(outcome.deadlineMs)}`;
    default:
      return `check failed: ${outcome.reason}`;
  }
}

/**
 * Measure real throughput, including the flush.
 *
 * The number adb reports is not the number that matters: roughly 25 % of a
 * job's wall time is writeback it has already called finished. So this writes,
 * syncs, and only then stops the clock.
 */
async function benchmark(
  adb: Adb,
  device: DeviceInfo | undefined,
): Promise<string | null> {
  if (!device) return null;

  const source = "/sdcard/Download/.portage-bench.bin";
  const sizeBytes = 256 * 1024 * 1024;

  // A file the user already downloaded would be better (no writes on the
  // phone), but we cannot assume one exists. /data/local/tmp is writable by
  // the shell user and never touches /sdcard.
  await adb.shell(
    device.serial,
    `dd if=/dev/zero of=/data/local/tmp/portage-bench.bin bs=1M count=256 2>/dev/null`,
  );
  void source;

  const tmp = `/tmp/portage-bench-${process.pid}.bin`;
  const started = Bun.nanoseconds();

  const res = await adb.pull(
    device.serial,
    "/data/local/tmp/portage-bench.bin",
    tmp,
    false,
    undefined,
    900_000,
  );
  if (res.code !== 0) {
    await adb.shell(device.serial, "rm -f /data/local/tmp/portage-bench.bin");
    await Bun.$`rm -f ${tmp}`.quiet().nothrow();
    return `failed (adb pull exited ${res.code})`;
  }

  // The part adb does not count.
  const flushed = await syncFileOnly(tmp, sizeBytes);
  if (flushed.kind !== "ok") {
    await adb.shell(device.serial, "rm -f /data/local/tmp/portage-bench.bin");
    await Bun.$`rm -f ${tmp}`.quiet().nothrow();
    return doctorFlushMessage(flushed);
  }

  const seconds = (Bun.nanoseconds() - started) / 1_000_000_000;
  const mbPerSec = sizeBytes / 1_000_000 / seconds;

  await adb.shell(device.serial, "rm -f /data/local/tmp/portage-bench.bin");
  await Bun.$`rm -f ${tmp}`.quiet().nothrow();

  return `${mbPerSec.toFixed(1)} MB/s over 256 MB (transfer + flush)`;
}
