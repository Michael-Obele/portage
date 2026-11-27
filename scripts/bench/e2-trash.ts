/**
 * E2: trash deletion, Bun `rm` against the Rust `remove` candidate, on the deep
 * and shallow fixtures. Each run builds a fresh fixture and times only the removal.
 *
 * Usage: bun scripts/bench/e2-trash.ts <archive-root>
 */
import { mkdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BIN,
  RUNS,
  capabilityMs,
  cleanRunDir,
  df,
  gate,
  helper,
  newRunDir,
  orderFor,
  type Kind,
  type Samples,
  type Which,
} from "./fsbench.ts";
import { mountGuard, writeRecord } from "./record.ts";

export const e2Verdict = gate;

async function main(): Promise<void> {
  const dest = process.argv[2];
  if (!dest) throw new Error("usage: bun scripts/bench/e2-trash.ts <archive-root>");
  if (!(await Bun.file(BIN).exists())) {
    throw new Error("build the candidate first: cd crates/portage-scan && cargo build --release --example fsbench");
  }
  // Nothing may be written before the guard passes.
  const guard = mountGuard(dest);
  const dfStart = df(guard.root);
  const base = join(guard.root, ".portage", "bench", `e2-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(join(guard.root, ".portage", "bench"), { recursive: true });
  await mkdir(base);

  const samples: Samples = {
    deep: { ts: [], helper: [] },
    shallow: { ts: [], helper: [] },
  };
  const runs: Record<string, unknown>[] = [];
  try {
    for (let run = 1; run <= RUNS; run += 1) {
      for (const kind of ["deep", "shallow"] as Kind[]) {
        for (const which of orderFor(run) as Which[]) {
          const fx = await newRunDir(base, `r${run}-${which}-${kind}`, kind);
          const target = join(fx.dir, kind);
          let ms: number;
          let detail: Record<string, unknown> = {};
          if (which === "ts") {
            const start = performance.now();
            await rm(target, { recursive: true });
            ms = performance.now() - start;
          } else {
            const cap = await capabilityMs();
            const r = await helper(["remove", target]);
            ms = r.wallMs + cap;
            detail = { capabilityMs: cap, commandMs: r.wallMs, inProcessMs: r.json.ms };
          }
          samples[kind][which].push(ms);
          runs.push({ run, kind, which, ms, ...detail });
          console.error(`run ${run} ${kind} ${which} ${ms.toFixed(0)} ms`);
          await cleanRunDir(fx);
        }
      }
    }
  } finally {
    await rmdir(base).catch(() => {});
  }
  const dfEnd = df(guard.root);
  const verdict = {
    ...gate(samples),
    helper: "examples/fsbench.rs remove (std remove_dir_all); process start and a --help query included",
    samples,
  };
  const path = writeRecord("e2-trash", verdict, { runs, df: { start: dfStart.raw, end: dfEnd.raw } });
  console.log(path, JSON.stringify(verdict.result));
}

if (import.meta.main) {
  await main();
}
