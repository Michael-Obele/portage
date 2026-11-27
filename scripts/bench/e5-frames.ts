/**
 * E5: what remember_frame costs against the legacy Value path, for one 33,000-file
 * dupes frame. Runs the ignored Rust test and writes its numbers as a record.
 *
 * Usage: bun scripts/bench/e5-frames.ts
 *
 * No archive drive is written, so no mount guard runs. E5 decides nothing (R5.6).
 */
import { join } from "node:path";
import { writeRecord } from "./record.ts";

const REPO = join(import.meta.dir, "..", "..");
const CRATE = join(REPO, "apps", "desktop", "src-tauri");

type Sample = { run: number; impl: string; ms: number; hwmBeforeKb: number; hwmAfterKb: number };

function parse(stdout: string): { frameBytes: number; samples: Sample[] } {
  let frameBytes: number | null = null;
  const samples: Sample[] = [];
  for (const line of stdout.split("\n")) {
    const frame = line.match(/^E5 frame_bytes=(\d+)$/);
    if (frame) frameBytes = Number(frame[1]);
    const run = line.match(
      /^E5 run=(\d+) impl=(\w+) ms=([\d.]+) hwm_before_kb=(\d+) hwm_after_kb=(\d+)/,
    );
    if (run) {
      samples.push({
        run: Number(run[1]),
        impl: run[2] ?? "",
        ms: Number(run[3]),
        hwmBeforeKb: Number(run[4]),
        hwmAfterKb: Number(run[5]),
      });
    }
  }
  if (frameBytes === null) throw new Error("e5: no frame_bytes line in the test output");
  if (samples.length !== 10) throw new Error(`e5: expected 10 timed runs, got ${samples.length}`);
  return { frameBytes, samples };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const proc = Bun.spawnSync(
  ["cargo", "test", "--", "--ignored", "remember_frame_bench", "--nocapture"],
  { cwd: CRATE, stdout: "pipe", stderr: "pipe" },
);
const stdout = new TextDecoder().decode(proc.stdout);
if (proc.exitCode !== 0) {
  throw new Error(`e5: cargo test failed (${proc.exitCode}):\n${new TextDecoder().decode(proc.stderr)}`);
}

const { frameBytes, samples } = parse(stdout);
const medians = Object.fromEntries(
  ["remember_frame", "legacy_value"].map((impl) => [
    impl,
    median(samples.filter((s) => s.impl === impl).map((s) => s.ms)),
  ]),
);

const path = writeRecord(
  "e5-frames",
  { result: "pass", decides: "nothing" },
  {
    scope: "remember path only, not the whole app",
    frameBytes,
    frame: "33,000 dupes entries from a fixed seed (0x5EED_E5)",
    shell: "apps/desktop/src-tauri, cargo test -- --ignored remember_frame_bench",
    medianMs: medians,
    samples,
    note:
      "VmHWM is a process peak that never falls. The remember run goes first in each pair, so later legacy readings start from its peak.",
  },
  { noMount: true },
);
console.log(path, JSON.stringify(medians));
