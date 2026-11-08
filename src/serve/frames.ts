/**
 * The frame writers.
 *
 * One function per frame type, and each writes exactly ONE JSON line. The sink
 * is injected through `connect`, so a test can capture the wire with no
 * process, no window and no phone — and so this module has no opinion about
 * whether it is talking to a pipe or to an array in a test.
 *
 * Nothing here prints. stdout IS the protocol; a stray debug print in this
 * directory would corrupt a frame rather than log something.
 */
import { view, type DeviceRow, type FileRow, type Overall } from "../tui/state.svelte.ts";
import type { PortageConfig } from "../config/schema.ts";
import type { DeviceInfo } from "../device/adb.ts";
import type { Volume } from "../device/volumes.ts";
import type { PlanResult } from "../plan/plan.ts";
import type { EngineSummary } from "../xfer/engine.ts";

import {
  PROTOCOL_VERSION,
  type AnswerFramePayload,
  type BrowseFramePayload,
  type ConfigFramePayload,
  type DoctorFramePayload,
  type DupesFramePayload,
  type FrameLogLevel,
  type NeedsConfirmFramePayload,
  type NoticeLevel,
  type PurgePlanFramePayload,
  type ReadyFramePayload,
  type ScanFramePayload,
  type StatePayload,
  type StatusFramePayload,
} from "./protocol.ts";

/** Where a frame line goes. `process.stdout.write` in the real loop. */
export type Sink = (line: string) => void;

/**
 * A full snapshot of the run view, ready for a `state` frame.
 *
 * This is a MAP, not a JSON.stringify of the proxy: every field is copied by
 * value so the frame is a plain object that cannot mutate after it is written,
 * and the key set is exactly the view's own — nothing invented, nothing
 * dropped. The GUI derives nothing; if a number is not here, it does not exist.
 */
export function snapshot(): StatePayload {
  return {
    screen: view.screen,
    rows: view.rows.map((row: FileRow) => ({ ...row })),
    overall: { ...view.overall } as Overall,
    devices: view.devices.map((device: DeviceRow) => ({ ...device })),
    notice: view.notice,
  };
}

/** The fixed head of every frame. Mirrors `frameHeader` in protocol.ts. */
function head<T extends string>(type: T): { v: number; type: T } {
  return { v: PROTOCOL_VERSION, type };
}

export interface Frames {
  /** Raw line writer — the escape hatch for tests and for future frame types. */
  raw(frame: unknown): void;

  ready(payload: ReadyFramePayload): void;
  notice(level: NoticeLevel, message: string): void;
  log(level: FrameLogLevel, message: string): void;
  config(payload: ConfigFramePayload): void;
  devices(devices: DeviceInfo[]): void;
  volumes(volumes: Volume[]): void;
  scan(payload: ScanFramePayload): void;
  plan(plan: PlanResult): void;
  /** Serialises the live `view`. Takes no argument: the view is the argument. */
  state(): void;
  run(summary: EngineSummary): void;
  dupes(payload: DupesFramePayload): void;
  purgePlan(payload: PurgePlanFramePayload): void;
  doctor(payload: DoctorFramePayload): void;
  status(payload: StatusFramePayload): void;
  browse(payload: BrowseFramePayload): void;
  needsConfirm(payload: NeedsConfirmFramePayload): void;
  answer(payload: AnswerFramePayload): void;
  bye(): void;
}

/** Bind the writers to a sink. One call, one line, no buffering. */
export function connect(sink: Sink): Frames {
  const write = (frame: unknown): void => {
    sink(`${JSON.stringify(frame)}\n`);
  };

  return {
    raw: write,

    ready: (payload) => write({ ...head("ready"), ...payload }),
    notice: (level, message) => write({ ...head("notice"), level, message }),
    log: (level, message) => write({ ...head("log"), level, message }),

    config: (payload) => write({ ...head("config"), ...payload }),
    devices: (devices) => write({ ...head("devices"), devices }),
    volumes: (volumes) => write({ ...head("volumes"), volumes }),

    scan: (payload) => write({ ...head("scan"), ...payload }),
    plan: (plan) => write({ ...head("plan"), plan }),

    state: () => write({ ...head("state"), ...snapshot() }),
    run: (summary) => write({ ...head("run"), summary }),

    dupes: (payload) => write({ ...head("dupes"), ...payload }),
    purgePlan: (payload) => write({ ...head("purgePlan"), ...payload }),
    doctor: (payload) => write({ ...head("doctor"), ...payload }),
    status: (payload) => write({ ...head("status"), ...payload }),
    browse: (payload) => write({ ...head("browse"), ...payload }),
    needsConfirm: (payload) => write({ ...head("needsConfirm"), ...payload }),

    answer: (payload) => write({ ...head("answer"), ...payload }),
    bye: () => write({ ...head("bye") }),
  };
}
