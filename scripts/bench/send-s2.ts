/**
 * Spike S2: does `sync` on the phone flush its storage, and how long does it take?
 * Run: bun scripts/bench/send-s2.ts <adb-serial>. Needs one phone; touches no other
 * device and no archive drive. Design §8.3, R2.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupManifest, guardFolder, run, writeSpikeRecord } from "./send-spike.ts";

export const SIZE_BYTES = 300_000_000;
const REPEATS = 5;
const FOLDER = "/sdcard/Download/portage-spike-S2";
const EXPERIMENT = "s2-sync";

export type Flushed = "yes" | "no" | "undetermined";
export type S2Run = {
  dirtyBeforeKb: number | null;
  writebackBeforeKb: number | null;
  dirtyAfterKb: number | null;
  writebackAfterKb: number | null;
  syncMs: number | null;
};
export type S2Record = {
  syncExists: boolean | null;
  syncExit: number | null;
  runs: S2Run[];
  flushed: Flushed;
  measure: string | null;
};

const meminfoKnown = (r: S2Run) =>
  [r.dirtyBeforeKb, r.writebackBeforeKb, r.dirtyAfterKb, r.writebackAfterKb].every(
    (v) => v !== null,
  );

// R2.5: criteria 1, 2 and 4 must be answered. "no" is a valid pass; it goes to the owner.
export function s2Verdict(record: S2Record) {
  const problems: string[] = [];
  if (record.syncExists === null) problems.push("criterion 1: sync existence not stated");
  else if (record.syncExists && record.syncExit === null)
    problems.push("criterion 1: sync exit status not stated");
  if (record.runs.length === 0) problems.push("criterion 2: no runs");
  for (const [i, r] of record.runs.entries()) {
    if (r.syncMs === null) problems.push(`criterion 2: run ${i + 1} has no sync time`);
    if (!meminfoKnown(r) && record.measure === null)
      problems.push(`criterion 2: run ${i + 1} has no meminfo values and no named measure`);
  }
  if (record.flushed === "undetermined") problems.push("criterion 4: flush undetermined");
  const pass = problems.length === 0;
  const ownerDecision = record.flushed === "yes" ? null : ("OI-4" as const);
  return {
    result: pass ? ("pass" as const) : ("fail" as const),
    pass,
    flushed: record.flushed,
    ownerDecision,
    problems,
  };
}

// Dirty+Writeback only proves a flush if there was something to flush. A run whose
// "before" was already near zero says nothing about sync (FUSE may write through).
export function judgeFlush(runs: S2Run[], sizeBytes: number): Flushed {
  if (runs.length === 0 || !runs.every(meminfoKnown)) return "undetermined";
  const kb = (r: S2Run) => ({
    before: r.dirtyBeforeKb! + r.writebackBeforeKb!,
    after: r.dirtyAfterKb! + r.writebackAfterKb!,
  });
  const floor = (sizeBytes / 1024) * 0.1;
  if (!runs.every((r) => kb(r).before >= floor)) return "undetermined";
  if (runs.every((r) => kb(r).after <= kb(r).before * 0.1)) return "yes";
  if (runs.every((r) => kb(r).after > kb(r).before * 0.5)) return "no";
  return "undetermined";
}

const kbOf = (text: string, key: string) => {
  const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
  return m ? Number(m[1]) : null;
};

async function main(serial: string) {
  const adb = (...a: string[]) => ["adb", "-s", serial, ...a];
  const sh = async (cmd: string) => {
    const r = await run(adb("shell", cmd));
    return { ...r, text: r.out.toString("utf8").trim() };
  };
  const meminfo = async () => {
    const t = (await sh("grep -E '^(Dirty|Writeback):' /proc/meminfo")).text;
    return { dirty: kbOf(t, "Dirty"), writeback: kbOf(t, "Writeback"), text: t };
  };

  const state = await run(adb("get-state"));
  if (state.out.toString().trim() !== "device") throw new Error(`phone ${serial} is not ready`);
  const prop = async (k: string) => (await sh(`getprop ${k}`)).text;
  const devices = [
    {
      id: serial,
      model: await prop("ro.product.model"),
      android: await prop("ro.build.version.release"),
    },
  ];
  const adbVersion = (await run(["adb", "version"])).out.toString().trim();

  const day = new Date().toISOString().slice(0, 10);
  const evidence = resolve(
    import.meta.dir, "..", "..", "bench", "evidence", "send-to-phone", `${day}-send-${EXPERIMENT}`,
  );
  mkdirSync(evidence, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "portage-s2-"));
  const manifest: string[] = [];
  const track = (name: string) => {
    manifest.push(name);
    writeFileSync(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
    return `${FOLDER}/${name}`;
  };

  let cleanup: { removed: string[]; failed: string[] } = { removed: [], failed: [] };
  let finished = false;
  const runs: S2Run[] = [];
  const log: unknown[] = [];
  let syncExists: boolean | null = null;
  let syncExit: number | null = null;
  let syncPath = "";
  try {
    await sh(`mkdir -p '${FOLDER}'`);
    const listing = (await sh(`ls -1A '${FOLDER}'`)).text.split("\n").filter(Boolean);
    const guard = guardFolder(listing, []);
    if (!guard.ok) throw new Error(`refusing: ${FOLDER} holds ${guard.foreign.join(", ")}`);

    const cv = await sh("command -v sync; echo rc=$?");
    syncExists = /rc=0\s*$/.test(cv.text);
    syncPath = cv.text.split("\n")[0] ?? "";

    const hostFile = join(work, "host.bin");
    const gen = await run(["sh", "-c", `head -c ${SIZE_BYTES} /dev/urandom > '${hostFile}'`]);
    if (gen.code !== 0) throw new Error("could not create the host file");

    for (let i = 1; i <= REPEATS; i++) {
      const target = track(`s2-${i}.bin`);
      const push = await run(adb("push", "-Z", hostFile, target));
      const before = await meminfo();
      const t0 = performance.now();
      const sy = await sh("sync; echo rc=$?");
      const syncMs = Math.round(performance.now() - t0);
      const rc = Number(sy.text.match(/rc=(\d+)/)?.[1] ?? NaN);
      if (Number.isFinite(rc)) syncExit = rc;
      const after = await meminfo();
      const size = (await sh(`stat -c %s '${target}'`)).text;
      runs.push({
        dirtyBeforeKb: before.dirty,
        writebackBeforeKb: before.writeback,
        dirtyAfterKb: after.dirty,
        writebackAfterKb: after.writeback,
        syncMs: Number.isFinite(rc) ? syncMs : null,
      });
      log.push({
        run: i, pushCode: push.code, pushMs: push.ms, phoneSize: size,
        before: before.text, after: after.text, sync: sy.text,
      });
      // R2.7: delete after each run.
      await sh(`rm -f '${target}'`);
    }
    finished = true;
  } finally {
    const phoneRm = (name: string) => {
      const r = Bun.spawnSync(adb("shell", `rm -rf '${FOLDER}/${name}'`));
      if (r.exitCode !== 0) throw new Error("rm failed");
    };
    cleanup = cleanupManifest([...manifest].reverse(), phoneRm);
    const rd = Bun.spawnSync(adb("shell", `rmdir '${FOLDER}'; ls -1A '${FOLDER}' 2>&1`));
    log.push({ cleanup, rmdir: rd.stdout.toString() });
    rmSync(work, { recursive: true, force: true });
  }
  if (!finished) throw new Error("S2 did not finish");

  const flushed = judgeFlush(runs, SIZE_BYTES);
  const known = runs.every(meminfoKnown);
  const record: S2Record = {
    syncExists,
    syncExit,
    runs,
    flushed,
    measure: known ? null : "sync exit status and wall time only; meminfo not reported",
  };
  writeFileSync(join(evidence, "raw.json"), JSON.stringify(log, null, 2));
  const verdict = s2Verdict(record);
  const path = writeSpikeRecord(EXPERIMENT, verdict, {
    ...record, syncPath, sizeBytes: SIZE_BYTES, repeats: REPEATS,
    flushRule:
      "yes: every run had Dirty+Writeback >= 10% of the file before sync and <= 10% of that after; " +
      "no: after > 50% of before in every run; otherwise undetermined. meminfo is phone-global, so background writes add noise.",
    adbVersion, devices,
    hostKernel: (await run(["uname", "-r"])).out.toString().trim(),
    bunVersion: Bun.version, cleanup, evidence,
  });
  console.log(`${verdict.result} flushed=${flushed} -> ${path}`);
}

if (import.meta.main) {
  const serial = process.argv[2];
  if (!serial) {
    console.error("usage: bun scripts/bench/send-s2.ts <adb-serial>");
    process.exit(2);
  }
  await main(serial);
}
