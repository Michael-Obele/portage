/**
 * E3: cross-folder move and survivor stat. TypeScript `rename` and `stat` against
 * the Rust `move` (renameat with two handles) and one group `stat`. The stat
 * covers the files where they sit before the move, which is where a survivor
 * check looks. Cleanup removes only the names the run created.
 *
 * Usage: bun scripts/bench/e3-move-stat.ts <archive-root>
 */
import { mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BIN,
  FILES,
  RUNS,
  capabilityMs,
  cleanRunDir,
  df,
  gate,
  helper,
  names,
  newRunDir,
  orderFor,
  type Gate,
  type Kind,
  type Pair,
  type Samples,
  type Which,
} from "./fsbench.ts";
import { mountGuard, writeRecord } from "./record.ts";

export type E3Verdict = {
  result: "pass" | "fail";
  move: Gate;
  stat: Gate;
};

// The top-level result is pass only when both operations pass, so a reader of
// `result` alone never reads a half gate as open.
export function e3Verdict(s: { move: Samples; stat: Samples }): E3Verdict {
  const move = gate(s.move);
  const stat = gate(s.stat);
  const both = move.result === "pass" && stat.result === "pass";
  return { result: both ? "pass" : "fail", move, stat };
}

const empty = (): Samples => ({
  deep: { ts: [], helper: [] } as Pair,
  shallow: { ts: [], helper: [] } as Pair,
});

async function main(): Promise<void> {
  const dest = process.argv[2];
  if (!dest) throw new Error("usage: bun scripts/bench/e3-move-stat.ts <archive-root>");
  if (!(await Bun.file(BIN).exists())) {
    throw new Error("build the candidate first: cd crates/portage-scan && cargo build --release --example fsbench");
  }
  const guard = mountGuard(dest);
  const dfStart = df(guard.root);
  const base = join(guard.root, ".portage", "bench", `e3-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(join(guard.root, ".portage", "bench"), { recursive: true });
  await mkdir(base);

  const samples = { move: empty(), stat: empty() };
  const runs: Record<string, unknown>[] = [];
  const list = names(FILES);
  try {
    for (let run = 1; run <= RUNS; run += 1) {
      for (const kind of ["deep", "shallow"] as Kind[]) {
        for (const which of orderFor(run) as Which[]) {
          const fx = await newRunDir(base, `r${run}-${which}-${kind}`, kind);
          const day = join(fx.dir, "day");
          await mkdir(day);
          let statMs: number;
          let moveMs: number;
          let detail: Record<string, unknown> = {};
          if (which === "ts") {
            let start = performance.now();
            for (const n of list) await stat(join(fx.leaf, n));
            statMs = performance.now() - start;
            start = performance.now();
            for (const n of list) await rename(join(fx.leaf, n), join(day, n));
            moveMs = performance.now() - start;
          } else {
            const cap = await capabilityMs();
            const s = await helper(["stat", fx.leaf, "--files", String(FILES)]);
            if (s.json.found !== FILES) throw new Error(`stat found ${String(s.json.found)} of ${FILES}`);
            const cap2 = await capabilityMs();
            const m = await helper(["move", fx.leaf, day, "--files", String(FILES)]);
            statMs = s.wallMs + cap;
            moveMs = m.wallMs + cap2;
            detail = { statInProcessMs: s.json.ms, moveInProcessMs: m.json.ms, capabilityMs: [cap, cap2] };
          }
          const moved = (await readdir(day)).length;
          if (moved !== FILES) throw new Error(`${which} ${kind}: ${moved} of ${FILES} files moved`);
          samples.stat[kind][which].push(statMs);
          samples.move[kind][which].push(moveMs);
          runs.push({ run, kind, which, statMs, moveMs, ...detail });
          console.error(`run ${run} ${kind} ${which} stat ${statMs.toFixed(0)} ms move ${moveMs.toFixed(0)} ms`);
          for (const n of list) await rm(join(day, n));
          await rmdir(day);
          await cleanRunDir(fx);
        }
      }
    }
  } finally {
    await rmdir(base).catch(() => {});
  }
  const dfEnd = df(guard.root);
  const verdict = { ...e3Verdict(samples), samples };
  const path = writeRecord("e3-move-stat", verdict, { runs, df: { start: dfStart.raw, end: dfEnd.raw } });
  console.log(path, JSON.stringify(verdict.result));
}

if (import.meta.main) {
  await main();
}
