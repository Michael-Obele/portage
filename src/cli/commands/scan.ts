/**
 * `scan` and `plan` — the two read-only commands.
 *
 * They share almost everything, because the difference between "what is on the
 * phone" and "what would `pull` do" is the destination and the space check.
 * Kept in one file because splitting them would mean two places to keep the
 * eligibility rules in sync, and a rule that exists twice is a rule that will
 * drift.
 */

import { join } from "node:path";

import { Adb, type DeviceInfo } from "../../device/adb.ts";
import type { ResolvedConfig } from "../../config/load.ts";
import { requireDestRoot } from "../../config/load.ts";
import { Journal } from "../../index/journal.ts";
import { scanDevice, summarise, type Candidate } from "../../scan/scan.ts";
import { buildPlan, planSummary, type PlanResult } from "../../plan/plan.ts";
import { ensureStateDirs } from "../../util/fs.ts";
import { formatBytes, formatDuration } from "../../util/paths.ts";
import type { Output } from "../../output/output.ts";
import { preconditionError } from "../../util/errors.ts";

export interface ScanContext {
  resolved: ResolvedConfig;
  adb: Adb | null;
  output: Output;
  deviceFilter?: string;
  show?: string;
  sinceSeconds?: number;
}

/** Resolve devices to scan, honouring `--device`. */
async function selectDevices(adb: Adb, filter?: string): Promise<DeviceInfo[]> {
  const all = await adb.devices();
  const ready = all.filter((d) => d.state === "device");

  if (ready.length === 0) {
    throw preconditionError(
      "no device is attached and authorised",
      "plug in a phone, enable USB debugging, and accept the RSA prompt",
    );
  }

  if (!filter) return ready;

  const matched = ready.filter(
    (d) => d.id.startsWith(filter) || d.serial === filter || d.model.toLowerCase().includes(filter.toLowerCase()),
  );
  if (matched.length === 0) {
    const available = ready.map((d) => `  ${d.id.slice(0, 12)}…  ${d.model || d.serial}`).join("\n");
    throw preconditionError(`no attached device matches "${filter}"`, `attached devices:\n${available}`);
  }
  return matched;
}

/** Walk every selected device and classify what comes back. */
async function gather(ctx: ScanContext): Promise<{ devices: DeviceInfo[]; candidates: Candidate[] }> {
  if (!ctx.adb) throw preconditionError("adb is not available");
  const { config } = ctx.resolved;
  const devices = await selectDevices(ctx.adb, ctx.deviceFilter);

  const all: Candidate[] = [];
  for (const device of devices) {
    const deviceConfig = config.devices[device.id];
    const roots = deviceConfig?.roots ?? [];
    if (roots.length === 0) {
      // A device with no configured roots is not an error — it is simply not
      // set up yet. Say so rather than silently scanning /sdcard.
      continue;
    }
    const found = await scanDevice(ctx.adb, device, roots, {
      quietSeconds: config.quiet_seconds,
      deviceConfig,
    });
    all.push(...found);
  }

  return { devices, candidates: all };
}

export async function scan(ctx: ScanContext): Promise<number> {
  const { devices, candidates } = await gather(ctx);
  const counts = summarise(candidates);

  if (ctx.output.mode === "json") {
    ctx.output.emitJson({
      devices: devices.map((d) => ({ id: d.id, model: d.model, serial: d.serial })),
      counts,
      total: candidates.length,
      files: candidates.map((c) => ({
        device: c.deviceLabel,
        path: c.srcPath,
        size: c.size,
        mtime: c.mtime,
        verdict: c.verdict,
        reason: c.reason,
      })),
    });
    return 0;
  }

  const o = ctx.output;
  for (const device of devices) {
    const roots = ctx.resolved.config.devices[device.id]?.roots ?? [];
    if (roots.length === 0) {
      o.warn(`${device.model || device.serial}: no roots configured — nothing scanned`);
      continue;
    }
    o.heading(`${device.model || device.serial}  (${roots.length} root${roots.length === 1 ? "" : "s"})`);
    for (const r of roots) o.bullet(r);
    const mine = candidates.filter((c) => c.deviceId === device.id);
    for (const c of mine.filter((c) => c.verdict !== "new")) {
      o.line(`  ${c.verdict.padEnd(20)} ${c.srcPath}`);
      o.bullet(c.reason);
    }
    const fresh = mine.filter((c) => c.verdict === "new");
    o.line(
      `  → ${fresh.length} new file${fresh.length === 1 ? "" : "s"}, ` +
        `${formatBytes(fresh.reduce((s, c) => s + c.size, 0))}`,
    );
    o.line();
  }

  o.heading("summary");
  for (const [verdict, n] of Object.entries(counts)) {
    if (n > 0) o.line(`  ${verdict.padEnd(22)} ${n}`);
  }
  o.line();
  o.line(`  ${counts.new} new · run \`portage plan\` to see what would move`);
  return 0;
}

export async function plan(ctx: ScanContext): Promise<number> {
  const destRoot = requireDestRoot(ctx.resolved.config);
  const { candidates } = await gather(ctx);

  const journal = Journal.open(destRoot);
  try {
    const result = buildPlan(candidates, {
      destRoot,
      journal,
      spaceHeadroom: ctx.resolved.config.space_headroom,
      show: ctx.show,
      sinceSeconds: ctx.sinceSeconds,
    });
    return renderPlan(result, ctx.output);
  } finally {
    journal.close();
  }
}

function renderPlan(result: PlanResult, o: Output): number {
  if (o.mode === "json") {
    o.emitJson({
      dest_root: result.destRoot,
      files: result.fileCount,
      bytes_total: result.bytesTotal,
      bytes_skipped: result.bytesSkipped,
      eta_seconds: result.etaSeconds,
      space: result.space,
      warnings: result.warnings,
      transfer: result.toTransfer.map((f) => ({
        from: f.candidate.srcPath,
        to: f.destPath,
        size: f.bytes,
        device: f.candidate.deviceLabel,
      })),
      skipped: result.skipped.map((f) => ({
        from: f.candidate.srcPath,
        to: f.destPath,
        size: f.candidate.size,
        reason: f.skipReason ?? "already on the drive",
      })),
    });
    return result.space.ok ? 0 : 2;
  }

  o.heading("plan");
  o.kv("destination", result.destRoot);
  o.kv("to transfer", `${result.fileCount} files · ${formatBytes(result.bytesTotal)}`);
  o.kv("already have", `${result.skipped.length} files · ${formatBytes(result.bytesSkipped)}`);
  o.kv("eta", result.etaSeconds === null ? "— (no throughput history yet)" : formatDuration(result.etaSeconds));
  o.kv("free after", formatBytes(result.space.freeBytes - result.bytesTotal));
  o.line();

  if (result.toTransfer.length > 0) {
    o.heading("moving");
    o.table(
      result.toTransfer.map((f) => [
        f.candidate.deviceLabel,
        formatBytes(f.bytes),
        f.candidate.srcPath,
        "→",
        f.destPath,
      ]),
    );
    o.line();
  }

  if (result.skipped.length > 0) {
    o.heading("not being transferred");
    for (const f of result.skipped.slice(0, 20)) {
      o.bullet(`${f.candidate.srcPath} ${formatBytes(f.candidate.size)} — ${f.skipReason ?? "already on the drive"}`);
    }
    if (result.skipped.length > 20) {
      o.bullet(`… and ${result.skipped.length - 20} more`);
    }
    o.line();
  }

  for (const warning of result.warnings) o.warn(warning);
  if (!result.space.ok && result.space.fix) o.bullet(`→ ${result.space.fix}`);

  o.line();
  o.line(`  ${planSummary(result)}`);
  if (result.space.ok && result.fileCount > 0) {
    o.line(`  run \`portage pull\` to move them, or \`portage pull --dry-run\` to watch the plan happen`);
  }

  return result.space.ok ? 0 : 2;
}

export { ensureStateDirs, join };