/**
 * Benchmark fixtures: a 462-folder chain and a shallow folder, each holding 4 KiB
 * files. Every created path goes in a manifest at the root. Cleanup deletes only
 * manifest paths, and refuses any root that holds an entry the manifest does not list (R4.12).
 */
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export type FixtureKind = "deep" | "shallow";

export const DEEP_SEGMENTS = 462;
export const FILE_COUNT = 1000;
export const FILE_BYTES = 4096;
export const MANIFEST = "fixtures-manifest.json";

// Fixed bytes. Content does not affect the timing, and a fixed value keeps runs comparable.
const PAYLOAD = Buffer.alloc(FILE_BYTES, 0x61);

const isMissing = (err: unknown): boolean =>
  (err as { code?: string }).code === "ENOENT";

// Manifest entries are data read from disk. Reject any that could leave the root.
function checkRel(rel: string): void {
  const bad =
    rel === MANIFEST ||
    rel.split("/").some((part) => part === "" || part === "." || part === "..");
  if (bad) throw new Error(`fixture manifest: bad entry "${rel}"`);
}

async function readManifest(root: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(root, MANIFEST), "utf8");
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const paths = (JSON.parse(text) as { paths?: unknown }).paths;
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) {
    throw new Error("fixture manifest: malformed");
  }
  for (const rel of paths as string[]) checkRel(rel);
  return paths as string[];
}

async function writeManifest(root: string, paths: string[]): Promise<void> {
  const body = { version: 1, paths };
  await writeFile(join(root, MANIFEST), `${JSON.stringify(body, null, 2)}\n`);
}

// Every entry under root, as a root-relative path. Symlinks are listed, not followed.
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [""];
  for (let rel = queue.pop(); rel !== undefined; rel = queue.pop()) {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      if (rel === "" && entry.name === MANIFEST) continue;
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      out.push(child);
      if (entry.isDirectory()) queue.push(child);
    }
  }
  return out;
}

// Returns the manifest paths. Rejects when the root holds any entry it does not list.
async function guard(root: string): Promise<string[]> {
  const listed = await readManifest(root);
  const known = new Set(listed);
  const foreign = (await walk(root)).filter((rel) => !known.has(rel));
  if (foreign.length > 0) {
    throw new Error(
      `refusing: ${foreign.length} entries under ${root} are not in the manifest; first is "${foreign[0]}"`,
    );
  }
  return listed;
}

/**
 * Builds one fixture under root and returns its folder and every path it created.
 * The 1,000 files sit in the deepest folder (O-18). Rejects if root holds a foreign entry.
 */
export async function buildFixture(
  rootArg: string,
  kind: FixtureKind,
  files = FILE_COUNT,
): Promise<{ dir: string; manifest: string[] }> {
  if (kind !== "deep" && kind !== "shallow") {
    throw new Error(`unknown fixture "${kind}"`);
  }
  if (!Number.isInteger(files) || files < 1) {
    throw new Error(`files must be a positive integer, got ${files}`);
  }
  const root = resolve(rootArg);
  await mkdir(root, { recursive: true });
  const listed = await guard(root);

  const created: string[] = [];
  try {
    // Non-recursive: fails with EEXIST rather than adopting an existing fixture.
    await mkdir(join(root, kind));
    created.push(kind);
    let parent: string = kind;
    if (kind === "deep") {
      for (let i = 0; i < DEEP_SEGMENTS; i += 1) {
        parent = `${parent}/d${i}`;
        await mkdir(join(root, parent));
        created.push(parent);
      }
    }
    for (let i = 0; i < files; i += 1) {
      const rel = `${parent}/f${String(i).padStart(4, "0")}.bin`;
      await writeFile(join(root, rel), PAYLOAD, { flag: "wx" });
      created.push(rel);
    }
  } finally {
    // Record what exists even after a partial failure, so cleanup can still reach it.
    if (created.length > 0) await writeManifest(root, [...listed, ...created]);
  }

  return {
    dir: join(root, kind),
    manifest: [...created, MANIFEST].map((rel) => join(root, rel)),
  };
}

/**
 * Deletes the manifest paths and the manifest, leaving root empty. Rejects, and
 * deletes nothing, when root holds an entry the manifest does not list.
 */
export async function cleanFixtures(rootArg: string): Promise<void> {
  const root = resolve(rootArg);
  const listed = await guard(root);
  // Deepest first, so each folder is empty when its turn comes.
  const ordered = [...new Set(listed)].sort(
    (a, b) => b.split("/").length - a.split("/").length,
  );
  for (const rel of ordered) {
    const abs = join(root, rel);
    let stat: Stats;
    try {
      stat = await lstat(abs);
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }
    if (stat.isDirectory()) await rmdir(abs);
    else await rm(abs);
  }
  await rm(join(root, MANIFEST), { force: true });
}
