/**
 * The adb adapter.
 *
 * Everything the tool knows about a phone goes through here. No command in
 * this file deletes anything — `removeDeviceFile` exists but is only reachable
 * from the explicit purge/delete step in the transfer engine, never as a side
 * effect of copying.
 */

import { join } from "node:path";

import {
  resolveBinary,
  stripCR,
  type RunResult,
  type SpawnFn,
} from "../util/spawn.ts";
import { sha1Hex } from "../util/hash.ts";
import { preconditionError } from "../util/errors.ts";

/**
 * Why a particular adb binary is being used.
 *
 * `doctor` prints this, because "found" and "found because we searched twelve
 * folders for you" are different facts about a machine.
 */
export type AdbSource = "config" | "path" | "search";

export interface AdbResolution {
  /** Absolute path of the binary, or null when nothing was found. */
  bin: string | null;
  source: AdbSource | "none";
  /** Every path that was tried, in order. `doctor` prints these on failure. */
  tried: string[];
}

/** SDK roots, the shape `<root>/platform-tools/adb`. */
function sdkRoots(env: Record<string, string | undefined>): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const local = env.LOCALAPPDATA ?? "";
  const roots = [
    env.ANDROID_HOME ?? "",
    env.ANDROID_SDK_ROOT ?? "",
    local ? join(local, "Android", "Sdk") : "",
    home ? join(home, "Android", "Sdk") : "",
    home ? join(home, "Android", "sdk") : "",
    home ? join(home, "android-sdk") : "",
    home ? join(home, "Library", "Android", "sdk") : "",
    "/usr/lib/android-sdk",
    "/usr/local/share/android-sdk",
    "/opt/android-sdk",
    "/opt/android-sdk-linux",
    "/snap/android-sdk/current",
  ];
  return roots.filter((root) => root.length > 0);
}

/** Directories that hold `adb` itself, for a platform-tools zip unzipped in place. */
function toolDirs(env: Record<string, string | undefined>): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const dirs = [
    home ? join(home, "android", "platform-tools") : "",
    home ? join(home, "Android", "platform-tools") : "",
    home ? join(home, "platform-tools") : "",
    home ? join(home, "Downloads", "platform-tools") : "",
    home ? join(home, ".local", "bin") : "",
  ];
  return dirs.filter((dir) => dir.length > 0);
}

/**
 * Every absolute path the resolver tries after `PATH`, in order.
 *
 * `PATH` alone is not enough for this app. A desktop launch inherits the
 * session PATH (`/usr/local/bin:/usr/bin:/bin` plus a few snap dirs) and never
 * reads a shell's rc file, so an SDK under `$HOME` is invisible to it even
 * though the same person's terminal finds adb without complaint. Nothing here
 * is assumed to exist: `Bun.which` decides, and this list is what a failure
 * reports.
 */
export function adbSearchPaths(
  env: Record<string, string | undefined> = Bun.env,
): string[] {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const paths = [
    ...sdkRoots(env).map((root) => join(root, "platform-tools", exe)),
    ...toolDirs(env).map((dir) => join(dir, exe)),
  ];
  return [...new Set(paths)];
}

/**
 * Find adb: the configured path, then `PATH`, then the usual SDK folders.
 *
 * A configured path that does not resolve is NOT fatal. It is reported (the
 * source becomes `path` or `search`), because refusing to run when a working
 * adb sits one directory over helps nobody. `doctor` is where a stale
 * `adb_path` gets called out.
 */
export async function resolveAdbBinary(
  configuredPath = "",
  env: Record<string, string | undefined> = Bun.env,
): Promise<AdbResolution> {
  const tried: string[] = [];

  if (configuredPath) {
    tried.push(configuredPath);
    const configured = await resolveBinary(configuredPath, configuredPath, env);
    if (configured) return { bin: configured, source: "config", tried };
  }

  const onPath = await resolveBinary("adb", "", env);
  if (onPath) return { bin: onPath, source: "path", tried };

  for (const candidate of adbSearchPaths(env)) {
    tried.push(candidate);
    const found = await resolveBinary(candidate, candidate, env);
    if (found) return { bin: candidate, source: "search", tried };
  }

  return { bin: null, source: "none", tried };
}

export interface DeviceInfo {
  /** Stable id: `sha1(ro.serialno)`. Never the serial itself, so the journal can be shared. */
  id: string;
  serial: string;
  state: "device" | "offline" | "unauthorized" | "unknown";
  model: string;
  android: string;
  /** `"unauthorized"` means the RSA prompt is still waiting on the phone. */
  unauthorized: boolean;
}

export interface DeviceFile {
  /** Path as it exists on the phone, e.g. `/sdcard/Movies/Frieren/S01/ep01.mkv`. */
  path: string;
  size: number;
  /** Seconds since epoch, as reported by the device. */
  mtime: number;
}

export class Adb {
  readonly bin: string;
  /** Where `bin` came from: the config value, `PATH`, or the SDK search. */
  readonly source: AdbSource;

  constructor(
    bin: string,
    private readonly spawn: SpawnFn,
    source: AdbSource = "path",
  ) {
    this.bin = bin;
    this.source = source;
  }

  /**
   * Build an adapter from the configured path, `PATH`, or the usual SDK
   * folders. Returns null only when none of them hold an adb.
   */
  static async create(
    spawn: SpawnFn,
    configuredPath = "",
  ): Promise<Adb | null> {
    const { bin, source } = await resolveAdbBinary(configuredPath);
    if (!bin) return null;
    return new Adb(bin, spawn, source === "none" ? "path" : source);
  }

  /** `adb version` — for `doctor`. */
  async version(): Promise<string> {
    const res = await this.spawn([this.bin, "version"], { timeoutMs: 10_000 });
    const m = /version\s+([0-9][^\s]*)/.exec(res.stdout);
    return m?.[1] ?? "unknown";
  }

  /** Every attached device, with model/Android version resolved. */
  async devices(): Promise<DeviceInfo[]> {
    const res = await this.spawn([this.bin, "devices", "-l"], {
      timeoutMs: 20_000,
    });
    if (res.code !== 0) return [];

    const out: DeviceInfo[] = [];
    for (const line of stripCR(res.stdout).split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("List of devices")) continue;
      const parts = t.split(/\s+/);
      const serial = parts[0];
      const state = parts[1];
      if (!serial || !state) continue;

      const model = /model:(\S+)/.exec(t)?.[1]?.replace(/_/g, " ") ?? "";
      // Only query the device when it is actually usable — `getprop` on an
      // unauthorized device just hangs.
      const usable = state === "device";
      const android = usable
        ? await this.getprop(serial, "ro.build.version.release")
        : "";
      const rawSerial = usable
        ? await this.getprop(serial, "ro.serialno")
        : serial;

      out.push({
        id: deviceId(serial, rawSerial),
        serial,
        state: state as DeviceInfo["state"],
        model,
        android,
        unauthorized: state === "unauthorized",
      });
    }
    return out;
  }

  /** One getprop value, or "" when the device is unreachable. */
  async getprop(serial: string, prop: string): Promise<string> {
    const res = await this.shell(serial, `getprop ${prop}`);
    return res.code === 0 ? stripCR(res.stdout).trim() : "";
  }

  /** Free bytes on the device's primary storage. */
  async deviceFreeBytes(serial: string): Promise<number | null> {
    const res = await this.shell(serial, "df -k /sdcard");
    if (res.code !== 0) return null;
    const line = stripCR(res.stdout).trim().split("\n").pop() ?? "";
    const cols = line.split(/\s+/);
    // Filesystem 1K-blocks Used Available Capacity Mounted-on
    const avail = Number(cols[cols.length - 3]);
    return Number.isFinite(avail) ? avail * 1024 : null;
  }

  /**
   * Run a shell command on the device.
   *
   * stdin is already /dev/null (see `realSpawn`), which is what stops `adb
   * shell` from eating our stdin inside a loop.
   */
  async shell(
    serial: string,
    command: string,
    timeoutMs = 30_000,
  ): Promise<RunResult> {
    return await this.spawn([this.bin, "-s", serial, "shell", command], {
      timeoutMs,
    });
  }

  /** Same as `shell` but with a PTY — needed to keep a long-lived process alive. */
  async shellTty(
    serial: string,
    command: string,
    timeoutMs = 30_000,
  ): Promise<RunResult> {
    return await this.spawn([this.bin, "-s", serial, "shell", "-t", command], {
      timeoutMs,
    });
  }

  /**
   * Walk a directory tree with one round trip.
   *
   * A single `find -printf` beats one `ls` per directory by orders of magnitude,
   * and it is the only way to avoid the trap where `ls -lS` reports every
   * directory as 4096 bytes.
   */
  async walk(
    serial: string,
    root: string,
    timeoutMs = 120_000,
  ): Promise<DeviceFile[]> {
    const cmd = `find '${root}' -type f -printf '%s\\t%T@\\t%p\\n'`;
    const res = await this.shell(serial, cmd, timeoutMs);
    if (res.code !== 0) return [];

    const files: DeviceFile[] = [];
    for (const line of stripCR(res.stdout).split("\n")) {
      if (!line.trim()) continue;
      const tab1 = line.indexOf("\t");
      if (tab1 === -1) continue;
      const tab2 = line.indexOf("\t", tab1 + 1);
      if (tab2 === -1) continue;

      const size = Number(line.slice(0, tab1));
      const mtime = Number(line.slice(tab1 + 1, tab2));
      const path = line.slice(tab2 + 1).trim();
      if (!Number.isFinite(size) || !path) continue;
      files.push({
        path,
        size,
        mtime: Number.isFinite(mtime) ? Math.floor(mtime) : 0,
      });
    }
    return files;
  }

  /** The device-side hash of a file. `sha256sum` is present in Android's toybox. */
  async hashRemote(serial: string, path: string): Promise<string | null> {
    const res = await this.shell(serial, `sha256sum '${path}'`, 300_000);
    if (res.code !== 0) return null;
    const first = stripCR(res.stdout).trim().split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{64}$/i.test(first) ? first.toLowerCase() : null;
  }

  /** Hasher availability — the Pixel ships sha256sum; older devices may not. */
  async hasHasher(serial: string): Promise<boolean> {
    const res = await this.shell(
      serial,
      "toybox 2>/dev/null | tr ' ' '\\n' | grep -x sha256sum",
    );
    return res.code === 0 && res.stdout.includes("sha256sum");
  }

  /**
   * Copy one file off the device.
   *
   * `adb pull` writes to a directory and keeps the basename, so callers pass
   * the directory and then look up the file by name.
   */
  async pull(
    serial: string,
    remotePath: string,
    destDir: string,
    preserveMtime = true,
    onProgress?: (chunk: string) => void,
    timeoutMs = 3_600_000,
  ): Promise<RunResult> {
    const args = [this.bin, "-s", serial, "pull"];
    if (preserveMtime) args.push("-a");
    args.push(remotePath, destDir);
    return await this.spawn(args, { timeoutMs, onStdout: onProgress });
  }

  /** Stream the tail of a file to stdout — the resume channel. */
  async execOutTail(
    serial: string,
    remotePath: string,
    skipBytes: number,
  ): Promise<ReturnType<typeof Bun.spawn>> {
    return Bun.spawn(
      [
        this.bin,
        "-s",
        serial,
        "exec-out",
        `tail -c +${skipBytes + 1} '${remotePath}'`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
  }

  /** Tunnel a device TCP port to localhost. Used by the rsync fallback. */
  async forward(
    serial: string,
    localPort: number,
    remotePort: number,
  ): Promise<boolean> {
    const res = await this.spawn(
      [
        this.bin,
        "-s",
        serial,
        "forward",
        `tcp:${localPort}`,
        `tcp:${remotePort}`,
      ],
      { timeoutMs: 10_000 },
    );
    return res.code === 0;
  }

  /** Remove forwarding rules this process created. */
  async forwardRemove(serial: string, localPort: number): Promise<void> {
    await this.spawn(
      [this.bin, "-s", serial, "forward", "--remove", `tcp:${localPort}`],
      {
        timeoutMs: 10_000,
      },
    );
  }

  /**
   * Delete a file from the device.
   *
   * Only ever called from the explicit deletion step, and only for a file that
   * was verified in this same run. Keeping it here — rather than letting
   * transports delete as they go — is what makes "nothing is deleted as a side
   * effect of copying" checkable.
   */
  async removeDeviceFile(serial: string, path: string): Promise<boolean> {
    const res = await this.shell(serial, `rm -f -- '${path}'`);
    return res.code === 0;
  }

  /** Does this exact path exist on the device? */
  async exists(serial: string, path: string): Promise<boolean> {
    const res = await this.shell(serial, `test -f '${path}'`);
    return res.code === 0;
  }

  /** Start Termux's sshd headlessly. Returns false when the build isn't debuggable. */
  async startSshd(serial: string): Promise<boolean> {
    const res = await this.shellTty(
      serial,
      "run-as com.termux files/usr/bin/bash -lic '" +
        "export PATH=/data/data/com.termux/files/usr/bin:$PATH; " +
        "export LD_PRELOAD=/data/data/com.termux/files/usr/lib/libtermux-exec.so; " +
        "pgrep -x sshd >/dev/null || sshd'",
      15_000,
    );
    return res.code === 0;
  }

  /** The Termux UID, needed to build an SSH user string. Empty when unavailable. */
  async termuxUser(serial: string): Promise<string> {
    const res = await this.shell(serial, "run-as com.termux id -u");
    return res.code === 0 ? stripCR(res.stdout).trim() : "";
  }
}

/** `sha1(ro.serialno)` — the journal key. Hashed so the DB is safe to share. */
export function deviceId(fallbackSerial: string, roSerial = ""): string {
  return sha1Hex(roSerial || fallbackSerial);
}

/**
 * Parse `lsusb -t` into a per-device speed map.
 *
 * The reason this exists: both the phone and the drive were enumerating on a
 * 480M (USB 2) bus, which meant the **cables** were the bottleneck, not the
 * ports. A tool that just reported "slow" would never find that.
 *
 * The tree format is:
 *   /:  Bus 02.Port 1: Dev 1, Class=root_hub, Driver=xhci_hcd/4p, 10000M
 *       |__ 1.1: Dev 2, If 0, Class=Hub, Driver=hub/4p, 5000M
 * so the device address is `port.addr` *before* the colon and the negotiated
 * speed is the last comma-separated field.
 */
export function parseLsusbTree(stdout: string): Map<string, number> {
  const speeds = new Map<string, number>();
  let bus: string | null = null;

  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r/g, "");

    // Real output is `/:  Bus 02.Port 1: Dev 1, …`; older builds print `Bus 02@1`.
    const busMatch = /Bus\s+(\d+)[.@]/.exec(line);
    if (busMatch?.[1]) {
      bus = busMatch[1];
      // The root hub's own speed is what proves a SuperSpeed port exists at
      // all, so it is recorded under `root` rather than skipped.
      const rootSpeed = /,\s*(\d+)M(?:\/|$|\s)/.exec(line);
      if (rootSpeed?.[1]) speeds.set(`${bus}:root`, Number(rootSpeed[1]));
      continue;
    }
    if (!bus) continue;

    // `|__ 1.1: Dev 2, If 0, …`
    const devMatch = /\|\__\s*(\d+)\.(\d+):\s*Dev\s+\d+/.exec(line);
    if (!devMatch) continue;

    // The speed is the trailing `NNNNM`, optionally followed by `/Np`.
    const speedMatch = /,\s*(\d+)M(?:\/|$|\s)/.exec(line);
    if (!speedMatch?.[1]) continue;

    speeds.set(`${bus}:${devMatch[1]}.${devMatch[2]}`, Number(speedMatch[1]));
  }
  return speeds;
}

/** The highest link speed present on any bus — used for the coarse warning. */
export function maxLinkSpeed(speeds: Map<string, number>): number {
  let max = 0;
  for (const v of speeds.values()) max = Math.max(max, v);
  return max;
}

export function isUsb2(speedMbit: number): boolean {
  return speedMbit > 0 && speedMbit <= 480;
}

/**
 * The ready devices a command may act on, honouring an optional filter.
 *
 * One implementation for the CLI and for `serve`: the filter matches an id
 * prefix, an exact serial, or a model substring, and a filter that matches
 * nothing is an error that lists what is attached — never an empty run. Two
 * copies of this drifted once already (different separators, different
 * formatting); the rule lives here now.
 */
export async function selectReady(
  adb: Adb,
  filter?: string,
): Promise<DeviceInfo[]> {
  const ready = (await adb.devices()).filter((d) => d.state === "device");
  if (ready.length === 0) {
    throw preconditionError(
      "no device is attached and authorised",
      "plug in a phone, enable USB debugging, and accept the RSA prompt",
    );
  }
  if (!filter) return ready;

  const matched = ready.filter(
    (d) =>
      d.id.startsWith(filter) ||
      d.serial === filter ||
      d.model.toLowerCase().includes(filter.toLowerCase()),
  );
  if (matched.length === 0) {
    const available = ready
      .map((d) => `  ${d.id.slice(0, 12)}…  ${d.model || d.serial}`)
      .join("\n");
    throw preconditionError(
      `no attached device matches "${filter}"`,
      `attached devices:\n${available}`,
    );
  }
  return matched;
}
