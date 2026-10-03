/**
 * `status`, `config`, `db` — the commands that read and inspect.
 *
 * `status` exists to answer one question without ceremony: what moved, what
 * failed, and what is sitting verified-but-not-deleted on a phone. The last
 * category is the one that silently disappears in most tools, and it is the
 * one you need to see after any `--keep-source` run.
 */

import { Journal } from "../../index/journal.ts";
import type { ResolvedConfig } from "../../config/load.ts";
import { requireDestRoot, coerceConfigValue, writeConfigFile } from "../../config/load.ts";
import { CONFIG_KEYS } from "../../config/schema.ts";
import { formatBytes, formatDuration } from "../../util/paths.ts";
import type { Output } from "../../output/output.ts";
import { usageError } from "../../util/errors.ts";

export async function status(ctx: {
  resolved: ResolvedConfig;
  output: Output;
  limit?: number;
}): Promise<number> {
  const destRoot = requireDestRoot(ctx.resolved.config);
  const journal = Journal.open(destRoot);

  try {
    const counts = journal.countByState();
    const runs = journal.listRuns(10);
    const pending = journal.listPendingPurge();
    const archive = journal.countArchive();
    const recent = journal.listRecent(ctx.limit ?? 25);

    if (ctx.output.mode === "json") {
      ctx.output.emitJson({
        archive,
        counts,
        pending_purge: pending.map((r) => ({
          src_path: r.src_path,
          dest_path: r.dest_path,
          size: r.size,
          verified_at: r.finished_at,
        })),
        runs,
        recent_transfers: recent,
      });
      return 0;
    }

    const o = ctx.output;
    o.heading("archive");
    o.kv("tracked files", `${archive.files}`);
    o.kv("tracked bytes", formatBytes(archive.bytes));
    o.line();

    if (Object.keys(counts).length > 0) {
      o.heading("transfer states");
      for (const [state, n] of Object.entries(counts).sort()) {
        o.line(`  ${state.padEnd(20)} ${n}`);
      }
      o.line();
    }

    // The category that matters most: proven on the drive, still on the phone.
    if (pending.length > 0) {
      o.heading("verified on the drive, still on the phone");
      for (const row of pending) {
        o.bullet(`${formatBytes(row.size).padStart(10)}  ${row.src_path}`);
      }
      o.line(`  → ${pending.length} file(s), ${formatBytes(pending.reduce((s, r) => s + r.size, 0))}`);
      o.bullet("run `portage purge` to remove them from the phone");
      o.line();
    }

    if (runs.length > 0) {
      o.heading("recent runs");
      o.table(
        runs.map((run) => [
          String(run.id),
          new Date(run.started_at).toISOString().slice(0, 16).replace("T", " "),
          run.transport,
          run.status,
          formatBytes(run.bytes_done),
          `${run.files_done}/${run.files_total}`,
          run.files_failed > 0 ? `${run.files_failed} failed` : "",
        ]),
      );
      o.line();
    }

    if (recent.length > 0) {
      o.heading("recent files");
      o.table(
        recent.map((row) => [
          row.state,
          formatBytes(row.size),
          row.src_path,
          row.last_error ?? "",
        ]),
      );
      o.line();
    }

    return 0;
  } finally {
    journal.close();
  }
}

export async function config(ctx: {
  resolved: ResolvedConfig;
  output: Output;
  positionals: string[];
  flags: Record<string, string | boolean>;
}): Promise<number> {
  const { resolved, output } = ctx;
  const action = ctx.positionals[0] ?? "show";

  switch (action) {
    case "get": {
      const key = ctx.positionals[1];
      if (!key) throw usageError("config get needs a key", `keys: ${CONFIG_KEYS.join(", ")}`);
      const value = (resolved.config as Record<string, unknown>)[key];
      if (value === undefined) {
        throw usageError(`unknown config key: ${key}`, `keys: ${CONFIG_KEYS.join(", ")}`);
      }
      output.line(typeof value === "string" ? value : JSON.stringify(value));
      return 0;
    }

    case "set": {
      const key = ctx.positionals[1];
      const raw = ctx.positionals[2];
      if (!key || raw === undefined) {
        throw usageError("config set needs a key and a value", "example: portage config set jobs 3");
      }
      const value = coerceConfigValue(key, raw);
      await writeConfigFile(resolved.sources.userPath, { [key]: value });
      output.ok(`${key} = ${JSON.stringify(value)} written to ${resolved.sources.userPath}`);
      return 0;
    }

    case "keys": {
      for (const key of CONFIG_KEYS) output.line(key);
      return 0;
    }

    default: {
      if (output.mode === "json") {
        output.emitJson({
          config: resolved.config,
          origins: resolved.origins,
          sources: resolved.sources,
        });
        return 0;
      }

      output.heading("configuration");
      output.kv("user config", resolved.sources.userPath);
      output.kv("drive config", resolved.sources.drivePath ?? "not found");
      output.line();

      const rows: string[][] = [];
      for (const [key, value] of Object.entries(resolved.config)) {
        const origin = resolved.origins[key] ?? "default";
        const short =
          origin === "default"
            ? "default"
            : origin === "flag"
              ? "flag"
              : origin === "env"
                ? "env"
                : origin.startsWith("/")
                  ? origin.endsWith(".toml")
                    ? origin.endsWith("config.toml") && origin === resolved.sources.userPath
                      ? "user"
                      : "drive"
                    : "user"
                  : origin;
        rows.push([
          key,
          typeof value === "object" ? JSON.stringify(value) : String(value),
          short,
        ]);
      }
      output.table(rows, ["key", "value", "from"]);
      output.line();
      output.line("  precedence: flags > env (PORTAGE_*) > drive config > user config > defaults");
      return 0;
    }
  }
}

export async function db(ctx: {
  resolved: ResolvedConfig;
  output: Output;
  positionals: string[];
  write: (path: string, content: string) => Promise<void>;
}): Promise<number> {
  const destRoot = requireDestRoot(ctx.resolved.config);
  const action = ctx.positionals[0] ?? "info";
  const journal = Journal.open(destRoot);

  try {
    switch (action) {
      case "info": {
        const archive = journal.countArchive();
        const counts = journal.countByState();
        if (ctx.output.mode === "json") {
          ctx.output.emitJson({ archive, counts, db: `${destRoot}/.portage/portage.db` });
          return 0;
        }
        ctx.output.heading("journal");
        ctx.output.kv("path", `${destRoot}/.portage/portage.db`);
        ctx.output.kv("archive files", String(archive.files));
        ctx.output.kv("archive bytes", formatBytes(archive.bytes));
        ctx.output.kv("transfer rows", String(Object.values(counts).reduce((a, b) => a + b, 0)));
        return 0;
      }

      case "vacuum": {
        journal.vacuum();
        ctx.output.ok("journal compacted");
        return 0;
      }

      case "export": {
        const target = ctx.positionals[1];
        if (!target) throw usageError("db export needs a path", "example: portage db export ./transfers.jsonl");
        const jsonl = journal.exportJSONL();
        await ctx.write(target, `${jsonl}\n`);
        ctx.output.ok(`wrote ${ctx.positionals.length - 1 ? target : target}`);
        return 0;
      }

      default:
        throw usageError(
          `unknown db action: ${action}`,
          "actions: info, vacuum, export <path>",
        );
    }
  } finally {
    journal.close();
  }
}

export { formatDuration };