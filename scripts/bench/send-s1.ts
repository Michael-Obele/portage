/**
 * Spike S1: are bytes unchanged through `adb exec-out cat` and `adb shell -T cat`?
 * Run: bun scripts/bench/send-s1.ts <adb-serial>. Needs one phone; touches no other
 * device and no archive drive. Design §8.2, R1.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupManifest, guardFolder, run, writeSpikeRecord } from "./send-spike.ts";

export const SIZE_BYTES = 400_000_000;
const FOLDER = "/sdcard/Download/portage-spike-S1";
const EXPERIMENT = "s1-binary-stream";

export type HashPair = { sourceHash: string | null; receivedHash: string | null };
export type S1Runs = {
  phoneToHost: HashPair;
  hostToPhone: HashPair;
  control: HashPair;
  push: HashPair;
  renameOver: { ok: boolean };
  renameNoClobber: { ok: boolean };
};

const equal = (p: HashPair) => p.sourceHash !== null && p.sourceHash === p.receivedHash;

// R1.5: only the two stream directions decide. The rest is evidence.
export function s1Verdict(runs: S1Runs) {
  const failedDirections = (
    [
      ["phone-to-host", runs.phoneToHost],
      ["host-to-phone", runs.hostToPhone],
    ] as const
  )
    .filter(([, p]) => !equal(p))
    .map(([direction, p]) => ({
      direction,
      sourceHash: p.sourceHash,
      receivedHash: p.receivedHash,
    }));
  const pass = failedDirections.length === 0;
  return { result: pass ? ("pass" as const) : ("fail" as const), pass, failedDirections };
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

  const day = new Date().toISOString().slice(0, 10);
  const evidence = resolve(
    import.meta.dir, "..", "..", "bench", "evidence", "send-to-phone", `${day}-send-${EXPERIMENT}`,
  );
  mkdirSync(evidence, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "portage-s1-"));
  const wallMs: Record<string, number> = {};
  const log: Record<string, unknown> = {};

  // The manifest is written before each phone file exists, so a crash still shows
  // what to clean (R1.8).
  const manifest: string[] = [];
  const track = (name: string) => {
    manifest.push(name);
    writeFileSync(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
    return `${FOLDER}/${name}`;
  };

  let cleanup: { removed: string[]; failed: string[] } = { removed: [], failed: [] };
  let runs: S1Runs | null = null;
  const extras: Record<string, unknown> = {};
  try {
    await sh(`mkdir -p '${FOLDER}'`);
    const listing = (await sh(`ls -1A '${FOLDER}'`)).text.split("\n").filter(Boolean);
    const guard = guardFolder(listing, []);
    if (!guard.ok) throw new Error(`refusing: ${FOLDER} holds ${guard.foreign.join(", ")}`);

    // 1
    const hostFile = join(work, "host.bin");
    const gen = await run(["sh", "-c", `head -c ${SIZE_BYTES} /dev/urandom > '${hostFile}'`]);
    if (gen.code !== 0) throw new Error("could not create the host file");
    const hostHash = (await run(["sha256sum", hostFile])).out.toString().slice(0, 64);

    // 5 first: it also seeds the phone-side source file for step 2.
    const seed = track("push.bin");
    const push = await run(adb("push", "-Z", hostFile, seed));
    wallMs.push = push.ms;
    log.push = { code: push.code, stdout: push.out.toString(), stderr: push.err };
    extras.pushProgress = {
      stderrBytes: push.err.length,
      stdoutBytes: push.out.length,
      note: "adb run with stdout and stderr both as pipes",
    };
    const pushHash = await phoneHash(seed);

    // 2
    const back = join(work, "back.bin");
    const sourceHash = await phoneHash(seed);
    const exo = await run(adb("exec-out", "cat", seed), { stdout: Bun.file(back) });
    wallMs.phoneToHost = exo.ms;
    log.phoneToHost = { code: exo.code, stderr: exo.err };
    const backHash = (await run(["sha256sum", back])).out.toString().slice(0, 64) || null;

    // 3
    const toPhone = track("stream.bin");
    const wr = await run(adb("shell", "-T", `cat > '${toPhone}'`), { stdin: Bun.file(hostFile) });
    wallMs.hostToPhone = wr.ms;
    log.hostToPhone = { code: wr.code, stderr: wr.err };
    const streamHash = await phoneHash(toPhone);

    // 4
    const ctl = track("control.bin");
    const cr = await run(adb("shell", `cat > '${ctl}'`), { stdin: Bun.file(hostFile) });
    wallMs.control = cr.ms;
    log.control = { code: cr.code, stderr: cr.err };
    const ctlHash = await phoneHash(ctl);

    // 6: small files, the rename is metadata. mv -n leaves the partial in place.
    const oldH = (await sh("printf old | sha256sum")).text.slice(0, 64);
    const newH = (await sh("printf new | sha256sum")).text.slice(0, 64);
    const ov = track("over-final"), ovp = track("over.part");
    await sh(`printf old > '${ov}'; printf new > '${ovp}'`);
    const mvf = await sh(`mv -f '${ovp}' '${ov}'; echo "rc=$?"; ls '${ovp}' 2>&1`);
    const ovHash = await phoneHash(ov);
    const nc = track("noclobber-final"), ncp = track("noclobber.part");
    await sh(`printf old > '${nc}'; printf new > '${ncp}'`);
    const mvn = await sh(`mv -n '${ncp}' '${nc}'; echo "rc=$?"; ls '${ncp}' 2>&1`);
    const ncHash = await phoneHash(nc);
    extras.renameOver = {
      finalHash: ovHash, expected: newH, output: mvf.text, partialRemoved: !/over\.part$/m.test(mvf.text.split("\n").slice(1).join("\n")),
    };
    extras.renameNoClobber = {
      finalHash: ncHash, expected: oldH, output: mvn.text, partialRemoved: !/noclobber\.part$/m.test(mvn.text.split("\n").slice(1).join("\n")),
    };

    // 7
    const w = track("writable.tmp");
    const w2 = `${FOLDER}/writable.renamed`;
    manifest.push("writable.renamed");
    const wc = await sh(`echo x > '${w}'; echo create=$?; mv '${w}' '${w2}'; echo rename=$?; rm '${w2}'; echo remove=$?`);
    extras.folderWritable = { output: wc.text, ok: /create=0\s+rename=0\s+remove=0/.test(wc.text) };

    // 8
    const names = ["sp ace", "ta\tb", "new\nline", "é.txt"];
    track("names");
    const mk = [
      `mkdir '${FOLDER}/names'`,
      `cd '${FOLDER}/names'`,
      `touch 'sp ace' "$(printf 'ta\\tb')" "$(printf 'new\\nline')" 'é.txt'`,
    ].join(" && ");
    const mkr = await sh(mk);
    const fr = await run(adb("exec-out", `find '${FOLDER}/names' -type f -printf '%f\\0'`));
    const got = fr.out.toString("utf8").split("\0").filter((s) => s !== "");
    extras.listingNul = {
      mkOutput: mkr.text, findCode: fr.code, findStderr: fr.err, got, expected: names,
      ok: names.every((n) => got.includes(n)) && got.length === names.length,
    };

    runs = {
      phoneToHost: { sourceHash, receivedHash: backHash },
      hostToPhone: { sourceHash: hostHash, receivedHash: streamHash },
      control: { sourceHash: hostHash, receivedHash: ctlHash },
      push: { sourceHash: hostHash, receivedHash: pushHash },
      renameOver: { ok: ovHash === newH },
      renameNoClobber: { ok: ncHash === oldH },
    };
    Object.assign(extras, { hostFileHash: hostHash });
  } finally {
    // 10: manifest paths only. The folder itself goes last and only if empty.
    const phoneRm = (name: string) => {
      const r = Bun.spawnSync(adb("shell", `rm -rf '${FOLDER}/${name}'`));
      if (r.exitCode !== 0) throw new Error("rm failed");
    };
    cleanup = cleanupManifest([...manifest].reverse(), phoneRm);
    const rd = Bun.spawnSync(adb("shell", `rmdir '${FOLDER}'; ls -1A '${FOLDER}' 2>&1`));
    log.cleanup = { ...cleanup, rmdir: rd.stdout.toString() };
    rmSync(work, { recursive: true, force: true });
  }
  if (runs === null) throw new Error("S1 did not finish");

  writeFileSync(join(evidence, "raw.json"), JSON.stringify({ log, extras, wallMs }, null, 2));
  const verdict = s1Verdict(runs);
  const path = writeSpikeRecord(EXPERIMENT, verdict, {
    ...runs, ...extras, sizeBytes: SIZE_BYTES, adbVersion, devices, wallMs,
    hostKernel: (await run(["uname", "-r"])).out.toString().trim(),
    bunVersion: Bun.version, cleanup, evidence,
  });
  console.log(`${verdict.result} -> ${path}`);
}

if (import.meta.main) {
  const serial = process.argv[2];
  if (!serial) {
    console.error("usage: bun scripts/bench/send-s1.ts <adb-serial>");
    process.exit(2);
  }
  await main(serial);
}
