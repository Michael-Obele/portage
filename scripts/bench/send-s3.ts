/**
 * Spike S3: does `adb exec-in` exist in this build and move bytes unchanged?
 * Run: bun scripts/bench/send-s3.ts <adb-serial>. Needs one phone; touches no other
 * device and no archive drive. Design §8.4, R3.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupManifest, guardFolder, run, writeSpikeRecord } from "./send-spike.ts";

export const SIZE_BYTES = 400_000_000;
const FOLDER = "/sdcard/Download/portage-spike-S3";
const EXPERIMENT = "s3-exec-in";

export type S3Record = {
  adbVersion: string;
  helpNamesExecIn: boolean | null;
  helpNamesExecOut: boolean | null;
  execInRuns: boolean | null;
  sizeBytes: number;
  hostHash: string | null;
  phoneHash: string | null;
  errorOutput: string | null;
};

// R3.6: criterion 1 answered, and equal hashes or a recorded absence.
export function s3Verdict(r: S3Record) {
  const problems: string[] = [];
  if (!r.adbVersion) problems.push("criterion 1: adb version missing");
  if (r.execInRuns === null) problems.push("criterion 1: exec-in run state missing");
  if (r.helpNamesExecIn === null || r.helpNamesExecOut === null)
    problems.push("criterion 1: adb help lines missing");
  if (typeof r.sizeBytes !== "number" || !(r.sizeBytes > 0))
    problems.push("R3.5: file size missing");
  const hashesEqual = r.hostHash !== null && r.hostHash === r.phoneHash;
  const execInAbsent = r.execInRuns === false && !!r.errorOutput;
  if (r.execInRuns === true && !hashesEqual) problems.push("criterion 2: hashes not equal");
  if (r.execInRuns === false && !execInAbsent)
    problems.push("criterion 3: absence has no error output");
  const pass = problems.length === 0;
  return {
    result: pass ? ("pass" as const) : ("fail" as const),
    pass,
    hashesEqual,
    execInAbsent,
    sizeBytes: r.sizeBytes,
    problems,
  };
}

async function main(serial: string) {
  const adb = (...a: string[]) => ["adb", "-s", serial, ...a];
  const sh = async (cmd: string) => {
    const r = await run(adb("shell", cmd));
    return { ...r, text: r.out.toString("utf8").trim() };
  };
  const phoneHash = async (path: string) => {
    const r = await sh(`sha256sum '${path}'`);
    return /^[0-9a-f]{64}/.test(r.text) ? r.text.slice(0, 64) : null;
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
  const help = await run(["adb", "help"]);
  const helpText = `${help.out.toString()}\n${help.err}`;
  const helpLines = helpText.split("\n").filter((l) => /exec-(in|out)/.test(l));

  const day = new Date().toISOString().slice(0, 10);
  const evidence = resolve(
    import.meta.dir, "..", "..", "bench", "evidence", "send-to-phone", `${day}-send-${EXPERIMENT}`,
  );
  mkdirSync(evidence, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "portage-s3-"));
  const manifest: string[] = [];
  const track = (name: string) => {
    manifest.push(name);
    writeFileSync(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
    return `${FOLDER}/${name}`;
  };

  let cleanup: { removed: string[]; failed: string[] } = { removed: [], failed: [] };
  let record: S3Record | null = null;
  let execIn: unknown = null;
  try {
    await sh(`mkdir -p '${FOLDER}'`);
    const listing = (await sh(`ls -1A '${FOLDER}'`)).text.split("\n").filter(Boolean);
    const guard = guardFolder(listing, []);
    if (!guard.ok) throw new Error(`refusing: ${FOLDER} holds ${guard.foreign.join(", ")}`);

    const hostFile = join(work, "host.bin");
    const gen = await run(["sh", "-c", `head -c ${SIZE_BYTES} /dev/urandom > '${hostFile}'`]);
    if (gen.code !== 0) throw new Error("could not create the host file");
    const hostHash = (await run(["sha256sum", hostFile])).out.toString().slice(0, 64);

    const target = track("exec-in.bin");
    const r = await run(adb("exec-in", `cat > '${target}'`), { stdin: Bun.file(hostFile) });
    // "absent" is the adb client refusing the command, not a transfer failing midway.
    const unknown = /unknown command|not found|unsupported/i.test(r.err) || r.code === 127;
    const phone = unknown ? null : await phoneHash(target);
    const phoneBytes = (await sh(`stat -c %s '${target}' 2>&1`)).text;
    execIn = { code: r.code, ms: r.ms, stderr: r.err, stdout: r.out.toString(), phoneBytes };
    record = {
      adbVersion,
      helpNamesExecIn: helpLines.some((l) => /exec-in/.test(l)),
      helpNamesExecOut: helpLines.some((l) => /exec-out/.test(l)),
      execInRuns: !unknown && r.code === 0,
      sizeBytes: SIZE_BYTES,
      hostHash,
      phoneHash: phone,
      errorOutput: r.code === 0 && !unknown ? null : r.err || `exit ${r.code}`,
    };
  } finally {
    const phoneRm = (name: string) => {
      const r = Bun.spawnSync(adb("shell", `rm -rf '${FOLDER}/${name}'`));
      if (r.exitCode !== 0) throw new Error("rm failed");
    };
    cleanup = cleanupManifest([...manifest].reverse(), phoneRm);
    const rd = Bun.spawnSync(adb("shell", `rmdir '${FOLDER}'; ls -1A '${FOLDER}' 2>&1`));
    writeFileSync(
      join(evidence, "raw.json"),
      JSON.stringify({ execIn, helpLines, cleanup, rmdir: rd.stdout.toString() }, null, 2),
    );
    rmSync(work, { recursive: true, force: true });
  }
  if (record === null) throw new Error("S3 did not finish");

  const verdict = s3Verdict(record);
  const path = writeSpikeRecord(EXPERIMENT, verdict, {
    ...record, helpLines, execIn,
    apullPhoneToPhone: record.execInRuns
      ? "exec-in exists in this build; the exec-in tar -x path of scripts/apull.sh can run (C26). Checked here with cat at 400 MB, not tar."
      : "exec-in is absent from this build; the phone-to-phone path of scripts/apull.sh (exec-in tar -x, C26) cannot run.",
    devices,
    hostKernel: (await run(["uname", "-r"])).out.toString().trim(),
    bunVersion: Bun.version, cleanup, evidence,
  });
  console.log(`${verdict.result} -> ${path}`);
}

if (import.meta.main) {
  const serial = process.argv[2];
  if (!serial) {
    console.error("usage: bun scripts/bench/send-s3.ts <adb-serial>");
    process.exit(2);
  }
  await main(serial);
}
