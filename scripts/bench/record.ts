/**
 * Bench record: the mount guard, the sysfs and procfs parsers, and the JSON writer.
 *
 * A number is citable only with the host, commit, mount and device it came from
 * (R7.1). The device and link values are read at run time, because the archive
 * has been on /dev/sda1 and on /dev/sdb1 (DV-2).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { cpus, hostname, release, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const RESULTS = join(REPO, "bench", "results");
// Module load is the run start. Each harness script imports this module first.
const STARTED_AT = new Date().toISOString();

export type Driver = "ntfs-3g" | "ntfs3";
export type Verdict = { result: "pass" | "fail" } & Record<string, unknown>;
export type MountGuard = {
  root: string;
  mountPoint: string;
  driver: Driver;
  line: string;
  source: string;
};

// Set by mountGuard. writeRecord refuses to run without it, so no record describes
// a drive that was never checked.
let guarded: MountGuard | null = null;

function fields(line: string): string[] {
  return line.trim().split(/\s+/);
}

// /proc/mounts octal-escapes space, tab, newline and backslash in paths.
function unescapeMount(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) =>
    String.fromCharCode(parseInt(oct, 8)),
  );
}

// fstype is the third field of a /proc/mounts line.
export function mountDriver(mountLine: string): Driver | null {
  const fstype = fields(mountLine)[2];
  if (fstype === "fuseblk") return "ntfs-3g";
  if (fstype === "ntfs3") return "ntfs3";
  return null;
}

// Column 19 is the 16th statistic (flush requests completed) after three name columns.
export function parseDiskstatsFlush(
  diskstats: string,
  device: string,
): number | null {
  const want = device.replace(/^\/dev\//, "");
  for (const line of diskstats.split("\n")) {
    const f = fields(line);
    if (f[2] !== want) continue;
    const flush = f[18];
    return flush !== undefined && /^\d+$/.test(flush) ? Number(flush) : null;
  }
  return null;
}

// Matches the pin on its own line, so a key such as bun-version-file is not read.
export function readCiBunPin(ciYaml: string): string | null {
  const m = ciYaml.match(/^\s*bun-version:\s*["']?(\d+(?:\.\d+)*)["']?\s*$/m);
  return m?.[1] ?? null;
}

// sysfs writes -1 when the link speed is unknown. That is not a speed to record.
export function parseLinkSpeed(sysfsText: string): number | null {
  const t = sysfsText.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

// Resolves symlinks in the nearest existing ancestor. Otherwise a link could move
// a root that does not exist yet onto another filesystem.
function resolveRoot(root: string): string {
  let abs = resolve(root);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(abs), ...rest);
    } catch {
      const parent = dirname(abs);
      if (parent === abs) return resolve(root);
      rest.unshift(basename(abs));
      abs = parent;
    }
  }
}

// Returns the mount that holds root. The longest mount point wins. A later line
// for the same point wins too, because it is the one the kernel shows.
export function mountGuard(root: string, mountsText?: string): MountGuard {
  const text = mountsText ?? readFileSync("/proc/mounts", "utf8");
  const target = resolveRoot(root);
  let best: { mountPoint: string; line: string } | null = null;
  for (const line of text.split("\n")) {
    const rawPoint = fields(line)[1];
    if (rawPoint === undefined) continue;
    const point = unescapeMount(rawPoint);
    const prefix = point.endsWith("/") ? point : `${point}/`;
    if (target !== point && !target.startsWith(prefix)) continue;
    if (!best || point.length >= best.mountPoint.length) {
      best = { mountPoint: point, line };
    }
  }
  if (best === null) {
    throw new Error(`mount guard: no mount holds ${target}`);
  }
  const driver = mountDriver(best.line);
  if (driver === null) {
    const fstype = fields(best.line)[2] ?? "unknown";
    throw new Error(
      `mount guard: ${target} is on ${fstype} at ${best.mountPoint}; ` +
        "refusing to run unless the mount is fuseblk (ntfs-3g) or ntfs3",
    );
  }
  guarded = {
    root: target,
    mountPoint: best.mountPoint,
    driver,
    line: best.line,
    source: fields(best.line)[0] ?? "",
  };
  return guarded;
}

// Reads a sysfs or procfs file, or returns null when it is absent.
function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function git(args: string[]): string | null {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "ignore",
  });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : null;
}

function findmnt(root: string): string | null {
  try {
    const r = Bun.spawnSync(
      ["findmnt", "-no", "SOURCE,FSTYPE,OPTIONS", "--target", root],
      { stdout: "pipe", stderr: "ignore" },
    );
    return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : null;
  } catch {
    return null;
  }
}

// A partition's sysfs entry sits inside its disk's directory, so its parent is the
// disk. Null when sysfs has no entry: guessing from the name could name the wrong disk.
export function diskOf(partition: string): string | null {
  const sys = `/sys/class/block/${partition}`;
  if (!existsSync(sys)) return null;
  if (!existsSync(join(sys, "partition"))) return partition;
  return basename(dirname(realpathSync(sys)));
}

// Walks up from the disk to the USB device, named bus-port (3-4). Its interface
// (3-4:1.0) has a colon and no speed file, so the name pattern skips it.
function usbOf(
  disk: string,
): { port: string; speedMbit: number | null } | null {
  let dir: string;
  try {
    dir = realpathSync(`/sys/block/${disk}`);
  } catch {
    return null;
  }
  for (
    let d = dir;
    d !== "/" && d.startsWith("/sys/devices/");
    d = dirname(d)
  ) {
    const name = basename(d);
    if (/^\d+-[\d.]+$/.test(name)) {
      const speed = read(join(d, "speed"));
      return {
        port: name,
        speedMbit: speed === null ? null : parseLinkSpeed(speed),
      };
    }
  }
  return null;
}

function commitState(): { sha: string | null; dirty: boolean | null } {
  const status = git(["status", "--porcelain"]);
  return {
    sha: git(["rev-parse", "HEAD"]),
    dirty: status === null ? null : status !== "",
  };
}

function blockState(source: string) {
  const disk = diskOf(basename(source));
  const at = (rel: string) =>
    disk === null ? null : read(`/sys/block/${disk}/${rel}`);
  const rotational = at("queue/rotational");
  return {
    device: { partition: source, disk: disk === null ? null : `/dev/${disk}` },
    usb: disk === null ? null : usbOf(disk),
    block: {
      disk: disk === null ? null : `/dev/${disk}`,
      rotational: rotational === null ? null : rotational === "1",
      writeCache: at("queue/write_cache"),
      model: at("device/model"),
    },
  };
}

// Writes bench/results/YYYY-MM-DD-<experiment>.json. The day is the UTC day of the
// run start, the same day the record's startedAt field shows.
export function writeRecord(
  experiment: string,
  verdict: Verdict,
  raw: unknown,
  // A phone spike has no archive mount. The caller owns the claim that none applies.
  opts: { noMount?: boolean } = {},
): string {
  if (guarded === null && !opts.noMount) {
    throw new Error("writeRecord: run mountGuard on the destination first");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(experiment)) {
    throw new Error(`writeRecord: bad experiment name "${experiment}"`);
  }
  if (verdict.result !== "pass" && verdict.result !== "fail") {
    throw new Error('writeRecord: verdict.result must be "pass" or "fail"');
  }
  const record = {
    experiment,
    startedAt: STARTED_AT,
    finishedAt: new Date().toISOString(),
    commit: commitState(),
    host: {
      hostname: hostname(),
      cpu: cpus()[0]?.model ?? null,
      memoryBytes: totalmem(),
    },
    kernel: release(),
    bun: {
      version: Bun.version,
      ciPin: readCiBunPin(
        readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8"),
      ),
    },
    ...(guarded === null || opts.noMount
      ? {}
      : {
          mount: {
            root: guarded.root,
            mountPoint: guarded.mountPoint,
            line: guarded.line,
            findmnt: findmnt(guarded.root),
          },
          driver: guarded.driver,
          ...blockState(guarded.source),
        }),
    verdict,
    raw,
  };
  mkdirSync(RESULTS, { recursive: true });
  const path = join(RESULTS, `${STARTED_AT.slice(0, 10)}-${experiment}.json`);
  // "wx" refuses to replace a record that may already be committed.
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  return path;
}
