/**
 * The primary transport: plain `adb`, with no phone-side install at all.
 *
 * Measured on the real hardware (2026-10-03), this is the fastest path
 * available and it costs nothing to set up:
 *
 *   adb pull, as reported          35.5–36.0 MB/s
 *   durable rate (1 GB conv=fsync)  27.6 MB/s  ← the honest ceiling
 *   3 concurrent pulls             40.8 MB/s  → jobs = 3
 *   adb exec-out (resume channel)   7.6–8.6 MB/s
 *   phone-side sha256sum (400 MB)   1372 ms
 *
 * `adb pull` has no resume and no checksum, which is why the engine supplies
 * both: resume past `resumeThreshold` via `adb exec-out tail -c`, and verify by
 * comparing the phone's own `sha256sum` against the local hash.
 */

import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import type { Adb } from "#lib/device/adb.ts";
import { dirname } from "#lib/util/paths.ts";
import { realSpawn, type SpawnFn } from "#lib/util/spawn.ts";
import {
  formatDeadline,
  PROBE_TIMEOUT_MS,
  probe,
  statDrive,
} from "#lib/util/probe.ts";
import type {
  CopyOutcome,
  CopyRequest,
  Transport,
  TransportVerdict,
} from "#lib/xfer/transport.ts";

export class AdbTransport implements Transport {
  readonly name = "adb" as const;

  constructor(
    private readonly adb: Adb,
    /** Notified when a file needs its partial cleaned up (below threshold). */
    private readonly onRestart?: (path: string) => void,
  ) {}

  async available(_deviceId: string): Promise<TransportVerdict> {
    return this.adb !== null ? { kind: "available" } : { kind: "absent" };
  }

  /**
   * Copy one file, resuming when that is genuinely faster than starting over.
   *
   * The resume threshold is a measured constant, not a guess:
   *   resume costs bytes / 8.6 MB/s
   *   re-pull costs size / 35.5 MB/s
   * Break-even is at ~76 % complete. Below that, a fresh pull wins, and the
   * partial is deleted rather than left to rot.
   */
  async copy(req: CopyRequest): Promise<CopyOutcome> {
    const destDir = dirname(req.destPath);

    const resumeWorthIt =
      req.partialBytes > 0 &&
      // A file longer than the source cannot be a partial of it: appending
      // would overwrite its head with the tail. Leave it to fail verification.
      req.partialBytes < req.size &&
      req.partialBytes / req.size >= req.resumeThreshold;

    if (req.partialBytes > 0 && !resumeWorthIt) {
      // Too early to be worth resuming — a clean pull beats a slow tail.
      await rm(req.destPath, { force: true });
      this.onRestart?.(req.destPath);
    }

    try {
      if (resumeWorthIt) {
        const outcome = await this.resumeTail(req);
        if (outcome) return outcome;
      }

      const res = await this.adb.pull(
        req.serial,
        req.srcPath,
        destDir,
        true,
        undefined,
        Math.max(600_000, Math.ceil(req.size / 2_000_000)),
      );

      if (res.code !== 0) {
        return {
          status: "failed",
          reason: `adb pull exited ${res.code}: ${firstLine(res.stderr) || "unknown error"}`,
          code: res.code,
          // Exit 24 from adb means the source vanished — retrying is pointless.
          fatal: res.code === 24,
        };
      }

      const probed = await statDrive(req.root, req.destPath);
      if (probed.kind !== "ok") {
        return {
          status: "failed",
          reason:
            probed.kind === "missing"
              ? `adb pull reported success but ${req.destPath} does not exist`
              : "the destination could not be read; nothing was changed",
          code: res.code,
          fatal: false,
        };
      }
      const stat = probed.value;

      // No flush here: the engine flushes each copy before recording it (R1.1).
      req.onProgress?.(stat.size);
      return { status: "copied", bytes: stat.size };
    } catch (err) {
      return {
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
        code: -1,
        fatal: false,
      };
    }
  }

  /**
   * Append the tail of the remote file to a partial on disk.
   *
   * `tail -c +N` is 1-based, which is why the offset is `partialBytes + 1`.
   * Returns null when the append did not complete cleanly, so the caller falls
   * back to a full pull rather than silently accepting a short file.
   */
  private async resumeTail(req: CopyRequest): Promise<CopyOutcome | null> {
    const proc = await this.adb.execOutTail(
      req.serial,
      req.srcPath,
      req.partialBytes,
    );
    // `stdout: "pipe"` guarantees a stream; the union type does not know that.
    const stream = proc.stdout as ReadableStream<Uint8Array>;

    let written = req.partialBytes;
    // `r+` writes from an explicit offset, so the bytes already on disk survive.
    // `Bun.file().writer()` starts at offset 0 and silently overwrites the head
    // of the file it was meant to continue; every resume then failed its hash.
    const sink = createWriteStream(req.destPath, {
      flags: "r+",
      start: req.partialBytes,
    });
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (!sink.write(value)) await once(sink, "drain");
        written += value.byteLength;
        req.onProgress?.(written);
      }
      sink.end();
      await finished(sink);
    } catch {
      sink.destroy();
      await stream.cancel().catch(() => {});
      return null;
    }

    const exit = await proc.exited;
    if (exit !== 0) return null;

    // A resumed file that is still short means the device sent less than it
    // claimed. Treat it as a failure, not a success.
    if (written !== req.size) {
      return {
        status: "failed",
        reason: `resume produced ${written} bytes, expected ${req.size}`,
        code: 0,
        fatal: false,
      };
    }

    return { status: "copied", bytes: written };
  }

  async removeSource(serial: string, srcPath: string): Promise<boolean> {
    return await this.adb.removeDeviceFile(serial, srcPath);
  }
}

/**
 * The fallback transport: rsync over an `adb forward` tunnel into Termux.
 *
 * Kept because it provides rsync's checksum machinery and a real POSIX tree.
 * It is not the default because both ways of starting sshd headlessly were
 * measured and found blocked:
 *
 *   - `run-as com.termux` sshd lands in the `runas_app` SELinux domain and
 *     **cannot read /sdcard** at all
 *   - the `RUN_COMMAND` intent is refused: `Requires permission
 *     com.termux.permission.RUN_COMMAND`
 *
 * So a working sshd needs a manual tap in the Termux app, per device, per
 * session — which is a real price for a fallback that plain `adb` does not ask
 * for. `-c --checksum-choice=xxh3` is mandatory here for the same reason it is
 * everywhere else: without it rsync trusts size+mtime, skips a destination
 * that is corrupt but looks identical, and then deletes the source.
 */
export class RsyncTransport implements Transport {
  readonly name = "rsync" as const;

  constructor(
    private readonly opts: {
      bin: string;
      port: number;
      user: string;
      partialDir: string;
      spawn?: SpawnFn;
      timeoutMs?: number;
    },
  ) {}

  async available(_deviceId: string): Promise<TransportVerdict> {
    const spawn = this.opts.spawn ?? realSpawn;
    const timeoutMs = this.opts.timeoutMs ?? PROBE_TIMEOUT_MS;
    // Null root: this reads nothing on the archive, so it counts toward no breaker.
    const res = await probe(
      null,
      "rsync --version",
      () => spawn([this.opts.bin, "--version"], { timeoutMs }),
      timeoutMs,
    );
    if (res.kind === "ok") {
      if (res.value.code === 0) return { kind: "available" };
      if (res.value.code === 127) return { kind: "absent" };
      return {
        kind: "failed",
        reason: `rsync --version exited ${res.value.code}`,
      };
    }
    if (res.kind === "missing") return { kind: "absent" };
    if (res.reason === "timeout") {
      return {
        kind: "failed",
        reason: `check failed: no answer within ${formatDeadline(timeoutMs)}`,
      };
    }
    // Spawning a binary that does not exist throws ENOENT.
    if (res.code === "ENOENT") return { kind: "absent" };
    return { kind: "failed", reason: res.message };
  }

  async copy(req: CopyRequest): Promise<CopyOutcome> {
    const args = [
      this.opts.bin,
      "-a",
      "--no-inc-recursive",
      "--info=progress2",
      "--out-format=%i|%n|%l|%b",
      "-c",
      "--checksum-choice=xxh3",
      `--partial-dir=${this.opts.partialDir}`,
      "--exclude=*.part",
      "--exclude=*.tmp",
      "--exclude=*.crdownload",
      "--exclude=*/Android/data/*",
      "-e",
      // No `--remove-source-files`. Ever. See the T1 test in the plan.
      `ssh -p ${this.opts.port} -o Compression=no -o BatchMode=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=3`,
    ];

    const remoteDir = dirname(req.srcPath);
    args.push(
      `${this.opts.user}@127.0.0.1:${remoteDir}/`,
      `${dirname(req.destPath)}/`,
    );

    const res = await Bun.$`${this.opts.bin} ${args.join(" ")}`
      .quiet()
      .nothrow()
      .cwd(process.cwd());

    const exitCode = res.exitCode;
    if (exitCode !== 0) {
      return {
        status: "failed",
        reason: `rsync exited ${exitCode}`,
        code: exitCode ?? -1,
        fatal: false,
      };
    }

    const probed = await statDrive(req.root, req.destPath);
    if (probed.kind !== "ok") {
      return {
        status: "failed",
        reason:
          probed.kind === "missing"
            ? `rsync reported success but ${req.destPath} does not exist`
            : "the destination could not be read; nothing was changed",
        code: 0,
        fatal: false,
      };
    }
    const stat = probed.value;

    // No flush here: the engine flushes each copy before recording it (R1.1).
    return { status: "copied", bytes: stat.size };
  }

  async removeSource(_serial: string, srcPath: string): Promise<boolean> {
    const res =
      await Bun.$`ssh -p ${this.opts.port} -o BatchMode=yes ${this.opts.user}@127.0.0.1 rm -f -- ${srcPath}`
        .quiet()
        .nothrow();
    return res.exitCode === 0;
  }
}

/** First non-empty line of stderr, trimmed — for a one-line failure reason. */
function firstLine(s: string): string {
  return (
    s
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? ""
  );
}
