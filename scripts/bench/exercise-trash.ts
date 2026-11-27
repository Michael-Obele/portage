/**
 * Trash emptying on the archive drive, through the engine's own two-step confirm.
 *
 * Only one day folder is named: the one this run creates. The rest of the owner's
 * trash is never selected, and loose files are never selected. The folder name is
 * fresh, so a folder that already exists makes the run refuse.
 *
 * Usage: bun scripts/bench/exercise-trash.ts <archive-root>
 */
import { existsSync } from "node:fs";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { df } from "./fsbench.ts";
import { mountGuard, writeRecord } from "./record.ts";

const REPO = join(import.meta.dir, "..", "..");
const FILE_COUNT = 3;
const FILE_BYTES = 512 * 1024;
const BLOCK = 4096;

type Reply = { id: string; ok: boolean; data?: Record<string, unknown>; error?: { message: string } };

/** Sends commands one at a time and returns each answer by its id. */
async function engine(destRoot: string) {
  const proc = Bun.spawn(["bun", "src/serve/main.ts", "serve"], {
    cwd: REPO,
    env: { ...process.env, PORTAGE_DEST_ROOT: destRoot },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const pending: Reply[] = [];

  async function next(): Promise<Reply> {
    for (;;) {
      const hit = pending.shift();
      if (hit) return hit;
      const nl = buffered.indexOf("\n");
      if (nl >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as { type: string } & Reply;
        if (frame.type === "answer") pending.push(frame);
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("exercise-trash: the engine closed its output");
      buffered += decoder.decode(value, { stream: true });
    }
  }

  async function send(id: string, type: string, args: Record<string, unknown> = {}): Promise<Reply> {
    proc.stdin.write(`${JSON.stringify({ v: 1, id, type, args })}\n`);
    proc.stdin.flush();
    for (;;) {
      const reply = await next();
      if (reply.id === id) return reply;
    }
  }

  return {
    send,
    async close() {
      proc.kill();
      await proc.exited;
    },
  };
}

async function main(): Promise<void> {
  const dest = process.argv[2];
  if (!dest) throw new Error("usage: bun scripts/bench/exercise-trash.ts <archive-root>");

  const guard = mountGuard(dest);
  const trashRoot = join(guard.root, ".portage", "trash");
  const day = `exercise-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dayDir = join(trashRoot, day);
  if (existsSync(dayDir)) throw new Error(`refusing: ${dayDir} already exists`);

  const created: string[] = [];
  let removed = false;
  const dfBefore = df(guard.root);
  await mkdir(dayDir, { recursive: true });
  try {
    for (let i = 0; i < FILE_COUNT; i += 1) {
      const path = join(dayDir, `fixture-${i}.bin`);
      await writeFile(path, Buffer.alloc(FILE_BYTES, 0x61 + i));
      created.push(path);
    }
    const dfFixtures = df(guard.root);

    const eng = await engine(guard.root);
    try {
      const status = await eng.send("ts1", "trash.status");
      if (!status.ok || !status.data) throw new Error(`trash.status failed: ${status.error?.message ?? "no data"}`);
      const trashId = String(status.data.trashId);

      const asked = await eng.send("te1", "trash.empty", { trashId, days: [dayDir], loose: false });
      if (!asked.ok || !asked.data?.needsConfirm) {
        throw new Error(`trash.empty did not ask for confirmation: ${JSON.stringify(asked)}`);
      }

      const done = await eng.send("te2", "trash.empty", {
        trashId,
        days: [dayDir],
        loose: false,
        confirm: asked.data.actionId,
      });
      if (!done.ok || !done.data) throw new Error(`trash.empty failed: ${done.error?.message ?? "no data"}`);
      removed = true;

      const dfAfter = df(guard.root);
      const removedFiles = Number(done.data.removedFiles);
      const bytesFreed = Number(done.data.bytesFreed);
      const dfDelta = dfAfter.avail - dfFixtures.avail;
      const tolerance = removedFiles * BLOCK;
      const pass = removedFiles === FILE_COUNT && Math.abs(bytesFreed - dfDelta) <= tolerance;

      const path = writeRecord(
        "trash-run",
        {
          result: pass ? "pass" : "fail",
          tolerance: { rule: "one 4096-byte block per removed file (N10)", bytes: tolerance },
          engine: { removedFiles, bytesFreed, freeBytesBefore: done.data.freeBytesBefore, freeBytesAfter: done.data.freeBytesAfter },
          df: { deltaBytes: dfDelta },
        },
        {
          day,
          command: "trash.status, trash.empty (days: [this run's folder path]), then trash.empty with confirm",
          df: { before: dfBefore.raw, afterFixtures: dfFixtures.raw, afterEmpty: dfAfter.raw },
          reply: done.data,
        },
      );
      console.log(path, pass ? "pass" : "fail");
      if (!pass) process.exitCode = 1;
    } finally {
      await eng.close();
    }
  } finally {
    if (!removed) {
      // The engine did not empty the folder, so this run removes its own files.
      for (const path of created) await rm(path, { force: true });
      await rmdir(dayDir).catch(() => {});
    }
  }
}

await main();
