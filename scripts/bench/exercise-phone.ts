/**
 * One small file over adb through the changed copy path, with the phone copy kept.
 *
 * Needs the phone. The script refuses to start when adb lists no device. It never
 * deletes on the phone: pull.start runs in "keep" mode, so no phone copy is removed
 * (R7.7, Notes N11).
 *
 * Usage: bun scripts/bench/exercise-phone.ts <archive-root> <show-name-on-phone>
 */
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { df } from "./fsbench.ts";
import { startEngine } from "./engine-driver.ts";
import { mountGuard, writeRecord } from "./record.ts";

const REQUIRED_STATES = ["copying", "written", "verified"] as const;

function phoneSerials(): string[] {
  const out = Bun.spawnSync(["adb", "devices"], { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder()
    .decode(out.stdout)
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[1] === "device")
    .map((cols) => cols[0] ?? "");
}

async function main(): Promise<void> {
  const [dest, show] = process.argv.slice(2);
  if (!dest || !show) {
    throw new Error("usage: bun scripts/bench/exercise-phone.ts <archive-root> <show-name-on-phone>");
  }
  const serials = phoneSerials();
  if (serials.length === 0) {
    throw new Error("refusing: adb lists no phone. Connect the phone with USB debugging on, then run again.");
  }

  const guard = mountGuard(dest);
  const dfStart = df(guard.root);
  const eng = await startEngine(guard.root);
  try {
    const answer = await eng.send("pull-1", "pull.start", { show, mode: "keep" });
    if (!answer.ok) throw new Error(`pull.start failed: ${answer.error?.message ?? "no reason"}`);

    const db = new Database(join(guard.root, ".portage", "portage.db"), { readonly: true });
    const rows = db
      .query("SELECT src_path, dest_path, size, state, hash, hash_scope, attempts, last_error FROM transfers WHERE src_path LIKE ? ORDER BY id")
      .all(`%${show}%`) as Array<{ state: string; hash: string | null; src_path: string }>;
    db.close();

    const states = rows.map((r) => r.state);
    const verified = rows.some((r) => r.state === "verified" && r.hash !== null);
    const movedThrough = REQUIRED_STATES.every((state) => states.includes(state));
    const pass = verified && movedThrough;

    const dfEnd = df(guard.root);
    const path = writeRecord(
      "phone-copy",
      {
        result: pass ? "pass" : "fail",
        expect: { states: [...REQUIRED_STATES], hashChecked: true, phoneDeleted: false },
        observed: { states, verified },
      },
      {
        serials,
        show,
        mode: "keep",
        journal: rows,
        df: { start: dfStart.raw, end: dfEnd.raw },
        engineAnswer: answer,
      },
    );
    console.log(path, pass ? "pass" : "fail");
    if (!pass) process.exitCode = 1;
  } finally {
    await eng.close();
  }
}

await main();
