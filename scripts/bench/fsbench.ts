/**
 * Shared parts of E2 and E3: the gate arithmetic, the Rust candidate runner, and
 * per-run fixtures built one segment at a time (a full-path build of 1,000 files
 * on a 462-segment chain costs about half a second per file on ntfs-3g).
 */
import { mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
export const BIN = join(
  REPO,
  "crates",
  "portage-scan",
  "target",
  "release",
  "examples",
  "fsbench",
);
export const FILES = 1000;
export const RUNS = 5;
export const DEEP_SEGMENTS = 462;
export type Kind = "deep" | "shallow";
export type Which = "ts" | "helper";
export type Pair = { ts: number[]; helper: number[] };
export type Samples = { deep: Pair; shallow: Pair };
export type Gate = {
  result: "pass" | "fail";
  deepRatio: number | null;
  shallowRatio: number | null;
};

// R4.1 thresholds.
const DEEP_MIN = 2.0;
const SHALLOW_MAX = 1.1;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

// Deep: TypeScript over Helper. Shallow: Helper over TypeScript. No Helper samples is a fail.
export function gate(samples: Samples): Gate {
  const d = [median(samples.deep.ts), median(samples.deep.helper)];
  const s = [median(samples.shallow.ts), median(samples.shallow.helper)];
  const [dTs, dHelper] = d;
  const [sTs, sHelper] = s;
  const deepRatio = dTs != null && dHelper ? dTs / dHelper : null;
  const shallowRatio = sTs && sHelper != null ? sHelper / sTs : null;
  const pass =
    deepRatio !== null &&
    shallowRatio !== null &&
    deepRatio >= DEEP_MIN &&
    shallowRatio <= SHALLOW_MAX;
  return { result: pass ? "pass" : "fail", deepRatio, shallowRatio };
}

// Odd runs go TypeScript first, even runs Helper first (design: E2 protocol).
export const orderFor = (run: number): Which[] =>
  run % 2 === 1 ? ["ts", "helper"] : ["helper", "ts"];

export function df(path: string): { raw: string; avail: number } {
  const r = Bun.spawnSync(["df", "-B1", path], { stdout: "pipe", stderr: "pipe" });
  const text = new TextDecoder().decode(r.stdout);
  const avail = Number(text.trim().split("\n").at(-1)?.trim().split(/\s+/)[3]);
  if (r.exitCode !== 0 || !Number.isFinite(avail)) throw new Error(`df failed for ${path}`);
  return { raw: text, avail };
}

export type HelperRun = { wallMs: number; json: Record<string, unknown> };

export async function helper(args: string[]): Promise<HelperRun> {
  const start = performance.now();
  const p = Bun.spawn([BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const wallMs = performance.now() - start;
  if (code !== 0) throw new Error(`fsbench ${args[0]} exited ${code}: ${err.trim()}`);
  return { wallMs, json: JSON.parse(out.trim().split("\n").at(-1) ?? "{}") };
}

// DV-16: the Helper is asked what it can do before each command. --help is the
// stand-in with the same process start, so its wall time is added to each Helper sample.
export const capabilityMs = async (): Promise<number> => {
  const start = performance.now();
  await Bun.spawn([BIN, "--help"], { stdout: "ignore" }).exited;
  return performance.now() - start;
};

export const names = (files = FILES): string[] =>
  Array.from({ length: files }, (_, i) => `f${String(i).padStart(4, "0")}.bin`);

export type RunDir = { dir: string; leaf: string; kind: Kind };

// One run folder per fixture. Its manifest names what the generator makes, which is
// all that cleanup may remove.
export async function newRunDir(base: string, label: string, kind: Kind): Promise<RunDir> {
  const dir = join(base, label);
  await mkdir(dir);
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ kind, segments: kind === "deep" ? DEEP_SEGMENTS : 0, files: FILES }),
  );
  await helper(["build", dir, kind, "--files", String(FILES)]);
  const chain = kind === "deep" ? Array.from({ length: DEEP_SEGMENTS }, (_, i) => `d${i}`) : [];
  return { dir, kind, leaf: join(dir, kind, ...chain) };
}

// Removes a run folder after checking it holds only what the manifest allows:
// the manifest, the kind folder, and optionally the day folder. Whatever is
// inside the kind folder is the generated chain, and the Helper removes it.
export async function cleanRunDir(run: RunDir): Promise<void> {
  const allowed = new Set(["manifest.json", run.kind, "day"]);
  const present = await readdir(run.dir);
  const extra = present.filter((n) => !allowed.has(n));
  if (extra.length > 0) throw new Error(`refusing: ${run.dir} holds ${extra[0]}`);
  if (present.includes(run.kind)) await helper(["remove", join(run.dir, run.kind)]);
  await rm(join(run.dir, "manifest.json"));
  await rmdir(run.dir);
}
