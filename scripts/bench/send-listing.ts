/**
 * M-listing: wall time of a strict phone listing and a single stat, for OI-1.
 * Run: bun scripts/bench/send-listing.ts <adb-serial>. Needs one phone; touches no
 * other device and no archive drive. Design §8.8. It has no pass rule.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupManifest, guardFolder, run, writeSpikeRecord } from "./send-spike.ts";

const FOLDER = "/sdcard/Download/portage-spike-listing";
const EXPERIMENT = "m-listing";
const SIZES = [100, 500, 1000] as const;
const REPEATS = 5;
const DEADLINE_MS = 3000;
const SENTINEL = "__PORTAGE_END__";

export type ListingSample = { entries: number; ms: number };

export function summarizeListingTimes(samples: ListingSample[]) {
  return SIZES.map((entries) => {
    const ms = samples.filter((s) => s.entries === entries).map((s) => s.ms);
    const longestMs = ms.length ? Math.max(...ms) : null;
    return { entries, longestMs, above3000Ms: longestMs !== null && longestMs > DEADLINE_MS };
  });
}

async function main(serial: string) {
  const adb = (...a: string[]) => ["adb", "-s", serial, ...a];
  const sh = async (cmd: string) => {
    const r = await run(adb("shell", cmd));
    return { ...r, text: r.out.toString("utf8").trim() };
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
  const manifest: string[] = [];
  const track = (name: string) => {
    manifest.push(name);
    writeFileSync(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
    return `${FOLDER}/${name}`;
  };

  let cleanup: { removed: string[]; failed: string[] } = { removed: [], failed: [] };
  const listing: (ListingSample & { counted: number; complete: boolean })[] = [];
  const stat: { entries: number; ms: number; ok: boolean }[] = [];
  const baseline: number[] = [];
  let finished = false;
  try {
    await sh(`mkdir -p '${FOLDER}'`);
    const present = (await sh(`ls -1A '${FOLDER}'`)).text.split("\n").filter(Boolean);
    const guard = guardFolder(present, []);
    if (!guard.ok) throw new Error(`refusing: ${FOLDER} holds ${guard.foreign.join(", ")}`);

    // The adb round trip alone, so a listing time can be split from it.
    for (let i = 0; i < REPEATS; i++) baseline.push((await run(adb("shell", "true"))).ms);

    for (const n of SIZES) {
      const dir = track(`n${n}`);
      const mk = await sh(
        `mkdir '${dir}' && cd '${dir}' && i=0 && while [ $i -lt ${n} ]; do : > "f$i"; i=$((i+1)); done; echo made=$?`,
      );
      if (!/made=0/.test(mk.text)) throw new Error(`could not create ${n} entries: ${mk.text}`);
      for (let i = 0; i < REPEATS; i++) {
        const r = await run(
          adb("exec-out", `find -H '${dir}' -mindepth 1 -maxdepth 1 -printf '%y %f\\0'; echo '${SENTINEL}'`),
        );
        const text = r.out.toString("utf8");
        const complete = text.trimEnd().endsWith(SENTINEL);
        const counted = text.split("\0").filter((s) => s && !s.includes(SENTINEL)).length;
        listing.push({ entries: n, ms: r.ms, counted, complete });
      }
      for (let i = 0; i < REPEATS; i++) {
        const r = await run(adb("exec-out", `stat -c '%F %s' '${dir}/f${n - 1}'`));
        stat.push({ entries: n, ms: r.ms, ok: r.code === 0 && r.out.length > 0 });
      }
    }
    finished = true;
  } finally {
    const phoneRm = (name: string) => {
      const r = Bun.spawnSync(adb("shell", `rm -rf '${FOLDER}/${name}'`));
      if (r.exitCode !== 0) throw new Error("rm failed");
    };
    cleanup = cleanupManifest([...manifest].reverse(), phoneRm);
    const rd = Bun.spawnSync(adb("shell", `rmdir '${FOLDER}'; ls -1A '${FOLDER}' 2>&1`));
    writeFileSync(
      join(evidence, "raw.json"),
      JSON.stringify({ listing, stat, baseline, cleanup, rmdir: rd.stdout.toString() }, null, 2),
    );
  }
  if (!finished) throw new Error("M-listing did not finish");

  const summary = summarizeListingTimes(listing);
  const statLongest = Math.max(...stat.map((s) => s.ms));
  const path = writeSpikeRecord(
    EXPERIMENT,
    { result: "pass", note: "measurement only, no pass rule", summary },
    {
      summary, repeats: REPEATS, deadlineMs: DEADLINE_MS, listing, stat,
      statLongestMs: statLongest, adbRoundTripMs: baseline,
      command: `find -H <dir> -mindepth 1 -maxdepth 1 -printf '%y %f\\0'; echo ${SENTINEL}`,
      adbVersion, devices,
      hostKernel: (await run(["uname", "-r"])).out.toString().trim(),
      bunVersion: Bun.version, cleanup, evidence,
    },
  );
  console.log(JSON.stringify(summary), `stat max ${statLongest} ms -> ${path}`);
}

if (import.meta.main) {
  const serial = process.argv[2];
  if (!serial) {
    console.error("usage: bun scripts/bench/send-listing.ts <adb-serial>");
    process.exit(2);
  }
  await main(serial);
}
