/**
 * Spike helpers: the folder guard, manifest cleanup and the record writer.
 * A spike deletes only what it created and never replaces a committed record (R1.8, R17.8).
 */
import { writeRecord, type Verdict } from "./record.ts";

// A name in the folder that the manifest does not list was not made by the spike.
export function guardFolder(
  listing: string[],
  manifest: string[],
): { ok: boolean; foreign: string[] } {
  const mine = new Set(manifest);
  const foreign = listing.filter((n) => !mine.has(n));
  return { ok: foreign.length === 0, foreign };
}

// Walks the manifest and nothing else. A failed removal is reported, not thrown, so
// one stuck file does not leave the rest behind.
export function cleanupManifest(
  manifest: string[],
  remove: (path: string) => void,
): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const path of manifest) {
    try {
      remove(path);
      removed.push(path);
    } catch {
      failed.push(path);
    }
  }
  return { removed, failed };
}

// writeRecord's "wx" flag keeps an existing record. The name carries the send- prefix.
export function writeSpikeRecord(
  experiment: string,
  verdict: Verdict,
  raw: unknown,
): string {
  return writeRecord(`send-${experiment}`, verdict, raw, { noMount: true });
}

const STEP_TIMEOUT_MS = 600_000;

export type Out = { code: number | null; out: Buffer; err: string; ms: number };

export async function run(
  cmd: string[],
  io: { stdin?: Bun.BunFile; stdout?: Bun.BunFile } = {},
): Promise<Out> {
  const t0 = performance.now();
  const p = Bun.spawn(cmd, {
    stdin: io.stdin ?? "ignore",
    stdout: io.stdout ?? "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), STEP_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([
    io.stdout ? Promise.resolve(Buffer.alloc(0)) : new Response(p.stdout as ReadableStream).arrayBuffer().then(Buffer.from),
    new Response(p.stderr as ReadableStream).text(),
    p.exited,
  ]);
  clearTimeout(timer);
  return { code, out, err, ms: Math.round(performance.now() - t0) };
}
