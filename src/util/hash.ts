/**
 * Hashing, with `Bun.CryptoHasher`.
 *
 * `Bun.CryptoHasher` is the first-party hasher: it hashes incrementally into
 * native memory, so a 400 MB episode never materialises as a JS string or
 * Buffer. That matters here because the verification gate hashes every file
 * twice (once from the phone, once from the drive) before it will delete
 * anything.
 *
 * The phone side uses `adb shell sha256sum`; this is the local half of the
 * comparison. Both must produce the same hex digest — that is the entire proof.
 */

import { createHash } from "node:crypto";

/** sha1 of a short string — used for the device id (`sha1(ro.serialno)`). */
export function sha1Hex(input: string): string {
  return new Bun.CryptoHasher("sha1").update(input).digest("hex");
}

/** sha256 of a short string. */
export function sha256Hex(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

/** The `sha256sum` of a file on disk, or null when it cannot be read. */
export async function sha256File(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  const hasher = new Bun.CryptoHasher("sha256");
  try {
    // Stream it — a 600 MB episode must never be fully resident.
    const stream = file.stream();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) hasher.update(value);
    }
  } catch {
    return null;
  }
  return hasher.digest("hex");
}

/**
 * Sample hash: first, middle and last 64 KiB of a file.
 *
 * ⚠ It can REJECT a non-duplicate. It can NOT confirm one.
 *
 * The obvious reading — "identical files produce identical samples, so sampling
 * cannot create a false positive" — is wrong, and measurably so. Two 1 MiB files
 * differing in exactly ONE byte at offset 128 KiB, outside all three windows,
 * produce an EQUAL sample hash here and an UNEQUAL sha256. A caller that treats
 * sample equality as identity will eventually delete a good copy.
 *
 * So this is safe as a cheap first pass over a 2 TB archive — a few GB of reads
 * instead of 2 TB — precisely because it is only ever used to narrow the field
 * before a FULL hash confirms. Callers that skip the full hash are the bug.
 */
export async function sampleHash(
  path: string,
  windowBytes = 64 * 1024,
): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  let size: number;
  try {
    size = file.size;
  } catch {
    return null;
  }
  if (size === 0) return sha256Hex("");

  const offsets = new Set<number>([
    0,
    Math.max(0, Math.floor(size / 2) - Math.floor(windowBytes / 2)),
  ]);
  offsets.add(Math.max(0, size - windowBytes));

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(String(size));
  try {
    for (const offset of [...offsets].sort((a, b) => a - b)) {
      const slice = file.slice(offset, Math.min(offset + windowBytes, size));
      hasher.update(await slice.arrayBuffer());
    }
  } catch {
    return null;
  }
  return hasher.digest("hex");
}

/**
 * Hash a file with a plain Node algorithm name.
 *
 * Kept for the `--transport rsync` path, where we want to reproduce what rsync
 * computes (`xxh3`) rather than our own choice of algorithm.
 */
export function hashBuffer(algorithm: string, data: Uint8Array): string {
  return createHash(algorithm).update(data).digest("hex");
}
