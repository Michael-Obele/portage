/**
 * Drives the engine over its JSON line protocol for the bench exercises.
 *
 * The engine reads its destination from PORTAGE_DEST_ROOT, so a run can point it
 * at another folder without touching the owner's config file.
 */
import { join } from "node:path";

export type Frame = { type: string; id?: string; ok?: boolean; data?: Record<string, unknown>; error?: { message: string } } & Record<string, unknown>;

const REPO = join(import.meta.dir, "..", "..");

export async function startEngine(destRoot: string) {
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
  const frames: Frame[] = [];

  // Reads one line of output, or null when the engine has closed its stdout.
  async function readLine(): Promise<string | null> {
    for (;;) {
      const nl = buffered.indexOf("\n");
      if (nl >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line.trim()) return line;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffered += decoder.decode(value, { stream: true });
    }
  }

  return {
    frames,
    /** Sends one command and returns its answer frame. Other frames are kept in `frames`. */
    async send(id: string, type: string, args: Record<string, unknown> = {}): Promise<Frame> {
      proc.stdin.write(`${JSON.stringify({ v: 1, id, type, args })}\n`);
      proc.stdin.flush();
      for (;;) {
        const line = await readLine();
        if (line === null) throw new Error(`engine closed before answering ${type}`);
        const frame = JSON.parse(line) as Frame;
        if (frame.type === "answer" && frame.id === id) return frame;
        frames.push(frame);
      }
    },
    async close() {
      proc.kill();
      await proc.exited;
    },
  };
}
