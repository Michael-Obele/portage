/**
 * Doctor on the archive drive, then on an empty folder that is not a mount (R2.14).
 *
 * The second run points the engine at a fresh folder through PORTAGE_DEST_ROOT,
 * so the owner's config file is never written. The folder is removed afterwards.
 *
 * Usage: bun scripts/bench/exercise-doctor.ts <archive-root>
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startEngine } from "./engine-driver.ts";
import { mountGuard, writeRecord } from "./record.ts";

const NOT_MOUNTED = "the archive drive is not mounted";

type Row = { mark: string; label: string; value: string; fix?: string };

async function doctorRows(destRoot: string): Promise<Row[]> {
  const eng = await startEngine(destRoot);
  try {
    const answer = await eng.send("doctor-1", "doctor", {});
    const frame = eng.frames.find((f) => f.type === "doctor");
    if (!answer.ok || !frame) {
      throw new Error(`doctor failed: ${answer.error?.message ?? "no doctor frame"}`);
    }
    return frame.checks as Row[];
  } finally {
    await eng.close();
  }
}

async function main(): Promise<void> {
  const dest = process.argv[2];
  if (!dest) throw new Error("usage: bun scripts/bench/exercise-doctor.ts <archive-root>");

  const guard = mountGuard(dest);
  const mounted = await doctorRows(guard.root);
  const mountedDest = mounted.filter((row) => row.label === "destination");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const empty = join(homedir(), `portage-doctor-exercise-${stamp}`);
  if (existsSync(empty)) throw new Error(`refusing: ${empty} already exists`);
  mkdirSync(empty);
  try {
    const unmounted = await doctorRows(empty);
    const unmountedDest = unmounted.filter((row) => row.label === "destination");
    const everything = JSON.stringify(unmounted);
    const pass = JSON.stringify(unmountedDest).includes(NOT_MOUNTED) && !/healthy/i.test(everything);

    const path = writeRecord(
      "doctor-check",
      {
        result: pass ? "pass" : "fail",
        expect: { unmountedDestination: NOT_MOUNTED, neverSays: "healthy" },
        observed: { unmountedDestination: unmountedDest },
      },
      {
        mountedRun: { root: guard.root, destination: mountedDest, checks: mounted },
        unmountedRun: { root: empty, checks: unmounted },
      },
    );
    console.log(path, pass ? "pass" : "fail");
    if (!pass) process.exitCode = 1;
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

await main();
