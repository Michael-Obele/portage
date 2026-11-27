/**
 * Scan exclusion on the archive drive: an Android/data path is left out of a
 * dupes scan, and a MyAndroid/data path with the same tail is kept (R3.3).
 *
 * The fixtures are identical pairs, so both members of a pair land in one
 * duplicate group. A pair under Android/data must not appear in any group.
 *
 * Usage: bun scripts/bench/exercise-scan.ts <archive-root>
 */
import { existsSync } from "node:fs";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { df } from "./fsbench.ts";
import { mountGuard, writeRecord } from "./record.ts";

const REPO = join(import.meta.dir, "..", "..");
const BODY_EXCLUDED = "excluded fixture\n".repeat(128);
const BODY_KEPT = "kept fixture\n".repeat(128);

type Pair = { dir: string; names: string[]; body: string };

async function runScan(
  root: string,
  destRoot: string,
): Promise<Array<{ path: string }>> {
  const proc = Bun.spawn(["bun", "src/serve/main.ts", "serve"], {
    cwd: REPO,
    env: { ...process.env, PORTAGE_DEST_ROOT: destRoot },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const command = { v: 1, id: "exercise-scan", type: "dupes.scan", args: { roots: [root], tier: 1 } };
  proc.stdin.write(`${JSON.stringify(command)}\n`);
  proc.stdin.flush();

  const members: Array<{ path: string }> = [];
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + 240_000;
  let done = false;
  for await (const chunk of proc.stdout) {
    buffered += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame.type === "dupes") {
        for (const group of (frame.groups as Array<{ members: Array<{ path: string }> }>) ?? []) {
          members.push(...group.members);
        }
        done = true;
        break;
      }
    }
    if (done || Date.now() > deadline) break;
  }
  proc.kill();
  await proc.exited;
  if (!done) throw new Error("exercise-scan: the engine sent no dupes frame");
  return members;
}

async function main(): Promise<void> {
  const dest = process.argv[2];
  if (!dest) throw new Error("usage: bun scripts/bench/exercise-scan.ts <archive-root>");

  const guard = mountGuard(dest);
  const dfStart = df(guard.root);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exercise = join(guard.root, ".portage", "exercise", `scan-${stamp}`);

  const pairs: Pair[] = [
    { dir: join(exercise, "Videos", "Android", "data", "com.app"), names: ["cache.mkv", "cache-copy.mkv"], body: BODY_EXCLUDED },
    { dir: join(exercise, "Videos", "MyAndroid", "data", "com.app"), names: ["keep.mkv", "keep-copy.mkv"], body: BODY_KEPT },
  ];
  // A fresh folder holds no entry this run did not write, so cleanup cannot touch another file.
  if (existsSync(exercise)) throw new Error(`refusing: ${exercise} already exists`);
  const created: string[] = [];
  try {
    for (const pair of pairs) {
      await mkdir(pair.dir, { recursive: true });
      for (const name of pair.names) {
        const path = join(pair.dir, name);
        await writeFile(path, pair.body);
        created.push(path);
      }
    }

    const members = await runScan(join(exercise, "Videos"), guard.root);
    const listed = members.map((m) => m.path);
    const excludedSeen = listed.filter((p) => p.includes("/Videos/Android/data/"));
    const keptSeen = listed.filter((p) => p.includes("/Videos/MyAndroid/data/"));
    const pass = excludedSeen.length === 0 && keptSeen.length === pairs[1]!.names.length;

    const dfEnd = df(guard.root);
    const path = writeRecord(
      "scan-exclusion",
      {
        result: pass ? "pass" : "fail",
        expect: {
          absent: "Videos/Android/data/com.app/*",
          listed: "Videos/MyAndroid/data/com.app/*",
        },
        observed: { excludedSeen, keptSeen },
      },
      {
        exercise,
        walker: "dupes.scan through src/serve/main.ts (scanner helper when dist/portage-scan is present)",
        members: listed,
        df: { start: dfStart.raw, end: dfEnd.raw },
      },
    );
    console.log(path, pass ? "pass" : "fail");
    if (!pass) process.exitCode = 1;
  } finally {
    // Remove only what this run created.
    for (const path of created) await rm(path, { force: true });
    for (const dir of [
      join(exercise, "Videos", "Android", "data", "com.app"),
      join(exercise, "Videos", "Android", "data"),
      join(exercise, "Videos", "Android"),
      join(exercise, "Videos", "MyAndroid", "data", "com.app"),
      join(exercise, "Videos", "MyAndroid", "data"),
      join(exercise, "Videos", "MyAndroid"),
      join(exercise, "Videos"),
      exercise,
      join(guard.root, ".portage", "exercise"),
    ]) {
      await rmdir(dir).catch(() => {});
    }
  }
}

await main();
