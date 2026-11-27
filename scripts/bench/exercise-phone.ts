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
    const startedAt = Date.now();
    const answer = await eng.send("pull-1", "pull.start", { show, mode: "keep" });
    if (!answer.ok) throw new Error(`pull.start failed: ${answer.error?.message ?? "no reason"}`);

    // pull.start returns before the run ends. Wait for this run's journal row to close.
    const db = new Database(join(guard.root, ".portage", "portage.db"), { readonly: true });
    let run: { id: number; status: string } | null = null;
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      run = db
        .query<{ id: number; status: string }, [number]>(
          "SELECT id, status FROM runs WHERE started_at >= ? ORDER BY id DESC LIMIT 1",
        )
        .get(startedAt) ?? null;
      if (run && run.status !== "running") break;
      await Bun.sleep(2000);
    }
    if (!run || run.status === "running") throw new Error("exercise-phone: the run did not finish in 30 minutes");

    const rows = db
      .query<{ src_path: string; dest_path: string; size: number; state: string; hash: string | null; hash_scope: string | null; attempts: number; last_error: string | null }, [number, string]>(
        "SELECT src_path, dest_path, size, state, hash, hash_scope, attempts, last_error FROM transfers WHERE run_id = ? AND src_path LIKE ? ORDER BY id",
      )
      .all(run.id, `%${show}%`);
    db.close();

    // The journal keeps one state per row, so intermediate states are not observable here.
    // The check is the final state plus a full-file hash.
    const states = rows.map((r) => r.state);
    const pass = rows.length > 0 && rows.every((r) => r.state === "verified" && r.hash_scope === "full" && r.hash !== null);

    const dfEnd = df(guard.root);
    const path = writeRecord(
      "phone-copy",
      {
        result: pass ? "pass" : "fail",
        expect: { finalState: "verified", hashScope: "full", phoneDeleted: false },
        observed: { run: run.id, status: run.status, states },
        transitionsObserved: false,
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
