/**
 * Browsing the phone.
 *
 * One level, or a depth-limited tree, from `adb shell find`. The quoting is the
 * apull script's `sq()` — single-quote, with an embedded quote written as
 * `'\''` — because that quoting is already tested against real filenames with
 * spaces, brackets and apostrophes, and inventing a second scheme here is how a
 * browser silently lists the wrong directory.
 *
 * Paths are ALWAYS the paths adb sees. A path that looks like the desktop's
 * MTP/GVFS mount is refused with the same advice `docs/apull.md` gives, because
 * handing that mount to adb is the single most common "failed to stat remote
 * object" mistake.
 */
import type { Adb } from "../device/adb.ts";
import { stripCR } from "../util/spawn.ts";
import { basename } from "../util/paths.ts";
import { preconditionError, usageError } from "../util/errors.ts";
import type { BrowseEntry } from "./protocol.ts";

/** Entries returned for one call. Beyond this the frame says it truncated. */
export const BROWSE_LIMIT = 500;

/** The advice from `docs/apull.md` → Troubleshooting, verbatim in substance. */
export const MOUNT_FIX =
  "browse talks to the phone through adb, so give it a path adb sees: " +
  "/sdcard/Download, not the MTP/GVFS mount your file manager shows. " +
  "Browse /sdcard to find the real path";

/**
 * Single-quote one argument for the device's shell.
 *
 * Mirrors `sq()` in scripts/apull.sh: wrap in single quotes, and write an
 * embedded single quote as `'\''` so the shell sees one literal quote.
 */
export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Is this a file-manager mount rather than a phone path?
 *
 * Covers the decoded GVFS shape (`/run/user/1000/gvfs/mtp:host=…`), the `mtp:`
 * scheme a file manager hands out, and a `%3A` remnant left over from a path
 * that was URL-encoded and then partly decoded.
 */
export function isMountPath(path: string): boolean {
  return (
    /(^|\/)gvfs(\/|$)/.test(path) ||
    /^mtp:/i.test(path) ||
    /mtp:host=/i.test(path) ||
    path.includes("%3A")
  );
}

/** Refuse a mount path before a single adb call. Throws a usage error. */
export function refuseMountPath(path: string): void {
  if (isMountPath(path)) {
    throw usageError(
      `"${path}" is a desktop mount, not a path on the phone`,
      MOUNT_FIX,
    );
  }
}

export interface BrowseResult {
  entries: BrowseEntry[];
  /** How many entries this level/tree really has, before the cap. */
  total: number;
  truncated: boolean;
}

/** C locale order, so the listing does not depend on the machine's locale. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function cap(
  entries: BrowseEntry[],
  total: number,
  limit: number,
): BrowseResult {
  return {
    entries: entries.slice(0, limit),
    total,
    truncated: total > limit,
  };
}

/**
 * One directory level: directories first, then files, each name-sorted.
 *
 * `-H` is required, exactly as in apull: `/sdcard` is a symlink to
 * `/storage/self/primary`, and without `-H` find lists the link itself.
 */
export async function browseLevel(
  adb: Adb,
  serial: string,
  path: string,
  limit = BROWSE_LIMIT,
): Promise<BrowseResult> {
  refuseMountPath(path);
  const q = quoteShellArg(path);

  const [dirs, files] = await Promise.all([
    adb.shell(serial, `find -H ${q} -maxdepth 1 -mindepth 1 -type d -printf '%f\\n'`),
    adb.shell(
      serial,
      `find -H ${q} -maxdepth 1 -mindepth 1 -type f -printf '%s\\t%f\\n'`,
    ),
  ]);

  const dirNames = parseNames(dirs.stdout).sort(byCodeUnit);
  const fileRows = parseSizeAndName(files.stdout).sort((a, b) =>
    byCodeUnit(a.name, b.name),
  );

  if (dirs.code !== 0 && files.code !== 0 && dirNames.length === 0 && fileRows.length === 0) {
    throw preconditionError(
      `${path} could not be listed on the device`,
      "check the path spelling, unlock the phone, and confirm adb sees the device",
    );
  }

  const entries: BrowseEntry[] = [
    ...dirNames.map((name) => ({
      name,
      path: joinDevice(path, name),
      kind: "dir" as const,
      size: null,
      depth: 1,
    })),
    ...fileRows.map((row) => ({
      name: row.name,
      path: joinDevice(path, row.name),
      kind: "file" as const,
      size: row.size,
      depth: 1,
    })),
  ];

  return cap(entries, entries.length, limit);
}

/**
 * A depth-limited tree under `path`.
 *
 * The root itself is not an entry — the frame carries it as `path` — so what
 * comes back is exactly the descendants, each with its depth and, for a file,
 * its size on the device.
 */
export async function browseTree(
  adb: Adb,
  serial: string,
  path: string,
  depth: number,
  limit = BROWSE_LIMIT,
): Promise<BrowseResult> {
  refuseMountPath(path);
  const q = quoteShellArg(path);
  const maxDepth = Math.max(1, Math.min(depth, 4));
  const res = await adb.shell(
    serial,
    `find -H ${q} -maxdepth ${maxDepth} \\( -type d -printf '%p/\\n' -o -type f -printf '%s\\t%p\\n' \\)`,
  );

  const lines = stripCR(res.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const entries: BrowseEntry[] = [];
  for (const line of lines) {
    const isDir = line.endsWith("/");
    const body = isDir ? line.slice(0, -1) : line;
    const tab = isDir ? -1 : body.indexOf("\t");
    const size = tab === -1 ? null : Number(body.slice(0, tab));
    const full = tab === -1 ? body : body.slice(tab + 1);
    if (!full || full === path) continue;

    const relative = full.startsWith(`${path}/`)
      ? full.slice(path.length + 1)
      : full.replace(/^\//, "");
    const segments = relative.split("/").filter(Boolean);
    entries.push({
      name: basename(full) || full,
      path: full,
      kind: isDir ? "dir" : "file",
      size: size !== null && Number.isFinite(size) ? size : null,
      depth: segments.length,
    });
  }

  if (res.code !== 0 && entries.length === 0) {
    throw preconditionError(
      `${path} could not be walked on the device`,
      "check the path spelling, unlock the phone, and confirm adb sees the device",
    );
  }

  entries.sort((a, b) => byCodeUnit(a.path, b.path));
  return cap(entries, entries.length, limit);
}

/** Join a device path the way the device spells it (always forward slashes). */
function joinDevice(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/** `-printf '%f\n'` output: one name per line. */
function parseNames(stdout: string): string[] {
  return stripCR(stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** `-printf '%s\t%f\n'` output: size, a tab, then the name. */
function parseSizeAndName(stdout: string): Array<{ size: number; name: string }> {
  const out: Array<{ size: number; name: string }> = [];
  for (const line of stripCR(stdout).split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const size = Number(line.slice(0, tab));
    const name = line.slice(tab + 1).trim();
    if (!name || !Number.isFinite(size)) continue;
    out.push({ size, name });
  }
  return out;
}
