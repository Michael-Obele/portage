/**
 * The module stores that outlive a route.
 *
 * Two claims are being pinned here, and both were real bugs:
 *
 *  1. A frame that arrives while its screen is unmounted is still captured —
 *     that is why routing lives at module scope instead of in `onMount`.
 *  2. A report is never silently kept across a scan that invalidated it. A new
 *     `dupes` report re-derives the selection; a new scope throws the report
 *     away, because its numbers describe roots that are no longer being scanned.
 */
import { describe, expect, test } from 'bun:test';

import type {
  DoctorFrame,
  DupesFrame,
  NeedsConfirmFrame,
  PlanResult,
  PurgePlanFrame
} from '#lib/engine/protocol.ts';
import { PROTOCOL_VERSION } from '#lib/engine/protocol.ts';
import { freshScreens, routeFrame } from '#lib/state/screens.svelte.ts';
import { PREF_KEYS, type PrefStore } from '#lib/state/prefs.ts';

function fakePrefs(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  const store: PrefStore & { data: Record<string, string> } = {
    data,
    getItem: (key) => (key in data ? (data[key] as string) : null),
    setItem: (key, value) => {
      data[key] = value;
    }
  };
  return store;
}

const planFrame = {
  v: PROTOCOL_VERSION,
  type: 'plan' as const,
  plan: { destRoot: '/media/node/2TB/Move', files: [], toTransfer: [], skipped: [] }
} as unknown as Parameters<typeof routeFrame>[0];

const dupesFrame = {
  v: PROTOCOL_VERSION,
  type: 'dupes' as const,
  scanId: 'scan-1',
  groups: [
    {
      id: 1,
      tier: 1,
      reason: 'byte-identical',
      label: null,
      members: [
        { key: 'k0', path: '/a', relative: 'a', size: 10, hash: 'h', keep: true, score: null, scoreReason: null, suspicious: null },
        { key: 'k1', path: '/b', relative: 'b', size: 10, hash: 'h', keep: false, score: null, scoreReason: null, suspicious: null }
      ],
      reclaimableBytes: 10
    },
    {
      id: 2,
      tier: 2,
      reason: 'same episode',
      label: 'S01E01 "x"',
      members: [
        { key: 'k2', path: '/c', relative: 'c', size: 5, hash: null, keep: true, score: null, scoreReason: null, suspicious: null },
        { key: 'k3', path: '/d', relative: 'd', size: 5, hash: null, keep: false, score: null, scoreReason: null, suspicious: null }
      ],
      reclaimableBytes: 5
    }
  ],
  tier1Count: 1,
  tier2Count: 1,
  reclaimableBytes: 15,
  scannedFiles: 2,
  scannedBytes: 20,
  truncated: [],
  unparsed: []
} as unknown as DupesFrame;

const purgeFrame = {
  v: PROTOCOL_VERSION,
  type: 'purgePlan' as const,
  planId: 'plan-1',
  eligible: [
    { key: 'p0', deviceId: 'd', serial: 's', srcPath: '/p0', destPath: '/d0', size: 1, proof: 'journal-hash', hash: 'h' }
  ],
  refused: [],
  bytesReclaimed: 1
} as unknown as PurgePlanFrame;

const doctorFrame = {
  v: PROTOCOL_VERSION,
  type: 'doctor' as const,
  ok: true,
  checks: []
} as unknown as DoctorFrame;

describe('frames are captured whichever screen is mounted', () => {
  test('a plan frame lands in the plan store', () => {
    const s = freshScreens();
    expect(s.plan.plan).toBeNull();
    routeFrame(planFrame, s);
    expect(s.plan.plan).not.toBeNull();
    expect(s.plan.requested).toBe(true);
  });

  test('a dupes frame lands in the dupes store with its default selection', () => {
    const s = freshScreens();
    routeFrame(dupesFrame, s);
    expect(s.dupes.scan?.scanId).toBe('scan-1');
    // Tier 1's redundant copy is ticked; tier 2's is not.
    expect([...s.dupes.selection]).toEqual(['k1']);
  });

  test('a purge plan stamps when it was made', () => {
    const s = freshScreens();
    s.purge.selection = new Set(['p0']);
    routeFrame(purgeFrame, s);
    expect(s.purge.plan?.planId).toBe('plan-1');
    expect(s.purge.plannedAt).toBeInstanceOf(Date);
    // A new plan invalidates any selection attached to the old one.
    expect(s.purge.selection.size).toBe(0);
  });

  test('a doctor frame lands in the doctor store', () => {
    const s = freshScreens();
    routeFrame(doctorFrame, s);
    expect(s.doctor.report).not.toBeNull();
  });

  test('needsConfirm opens the sheet on the screen that asked for it', () => {
    const s = freshScreens();
    const dupesConfirm = {
      v: PROTOCOL_VERSION,
      type: 'needsConfirm' as const,
      action: 'dupes.apply',
      paths: ['/b'],
      count: 1,
      bytes: 10,
      trashDir: '/trash'
    } as unknown as NeedsConfirmFrame;
    routeFrame(dupesConfirm, s);
    expect(s.dupes.sheetOpen).toBe(true);
    expect(s.purge.sheetOpen).toBe(false);

    const purgeConfirm = { ...dupesConfirm, action: 'purge.apply' } as unknown as NeedsConfirmFrame;
    routeFrame(purgeConfirm, s);
    expect(s.purge.sheetOpen).toBe(true);
  });

  test('an unrelated frame changes nothing', () => {
    const s = freshScreens();
    routeFrame({ v: PROTOCOL_VERSION, type: 'notice', level: 'info', message: 'hi' } as never, s);
    expect(s.plan.plan).toBeNull();
    expect(s.dupes.scan).toBeNull();
  });
});

describe('reports are invalidated, not silently kept', () => {
  test('a new scan replaces the selection rather than merging it', () => {
    const s = freshScreens();
    routeFrame(dupesFrame, s);
    s.dupes.selection = new Set(['k0', 'k1', 'k2', 'k3']);
    routeFrame(dupesFrame, s);
    expect([...s.dupes.selection]).toEqual(['k1']);
  });

  test('changing the scan scope throws the report away', () => {
    const s = freshScreens();
    routeFrame(dupesFrame, s);
    s.dupes.setScope('drive');
    expect(s.dupes.scope).toBe('drive');
    // The numbers described the configured roots, not the drive.
    expect(s.dupes.scan).toBeNull();
    expect(s.dupes.selection.size).toBe(0);
  });

  test('setting the scope it already has is a no-op', () => {
    const s = freshScreens();
    routeFrame(dupesFrame, s);
    s.dupes.setScope('configured');
    expect(s.dupes.scan).not.toBeNull();
  });
});

describe('preferences are remembered', () => {
  test('plan filters survive a rebuild of the store', () => {
    const prefs = fakePrefs();
    const first = freshScreens(prefs);
    first.plan.setFilters({ device: 'dev-1', show: 'frieren', since: '7d' });

    const second = freshScreens(prefs);
    expect(second.plan.filters).toEqual({ device: 'dev-1', show: 'frieren', since: '7d' });
    // The filter box starts with what is in force, not empty.
    expect(second.plan.showDraft).toBe('frieren');
  });

  test('the scan scope and the purge toggle survive a rebuild', () => {
    const prefs = fakePrefs();
    const first = freshScreens(prefs);
    first.dupes.setScope('drive');
    first.purge.setReRead(true);

    const second = freshScreens(prefs);
    expect(second.dupes.scope).toBe('drive');
    expect(second.purge.reRead).toBe(true);
    expect(prefs.data[PREF_KEYS.dupesScope]).toBe('"drive"');
  });

  test('the doctor filter survives a rebuild', () => {
    const prefs = fakePrefs();
    freshScreens(prefs).doctor.setFilter('problems');
    expect(freshScreens(prefs).doctor.filter).toBe('problems');
  });

  test('a report is NOT restored from disk — the engine id would be dead', () => {
    const prefs = fakePrefs();
    const first = freshScreens(prefs);
    routeFrame(dupesFrame, first);
    routeFrame(purgeFrame, first);
    // Nothing about a report is written; only the inputs are.
    const rebuilt = freshScreens(prefs);
    expect(rebuilt.dupes.scan).toBeNull();
    expect(rebuilt.purge.plan).toBeNull();
    expect(rebuilt.doctor.report).toBeNull();
    expect(rebuilt.plan.plan).toBeNull();
  });
});

describe('an engine restart invalidates its reports, not the preferences', () => {
  test('reset() drops every engine-owned report', () => {
    const prefs = fakePrefs();
    const s = freshScreens(prefs);
    routeFrame(planFrame, s);
    routeFrame(dupesFrame, s);
    routeFrame(purgeFrame, s);
    routeFrame(doctorFrame, s);
    s.dupes.sheetOpen = true;

    s.reset();

    expect(s.plan.plan).toBeNull();
    // `requested` goes back to false so the next visit asks again rather than
    // showing an empty screen forever.
    expect(s.plan.requested).toBe(false);
    expect(s.dupes.scan).toBeNull();
    expect(s.dupes.selection.size).toBe(0);
    expect(s.dupes.sheetOpen).toBe(false);
    expect(s.purge.plan).toBeNull();
    expect(s.purge.plannedAt).toBeNull();
    expect(s.doctor.report).toBeNull();
  });

  test('reset() keeps what a person chose, not what the engine said', () => {
    const prefs = fakePrefs();
    const s = freshScreens(prefs);
    s.plan.setFilters({ device: 'dev-1', show: 'frieren', since: '1d' });
    s.dupes.setScope('drive');
    s.purge.setReRead(true);
    s.doctor.setFilter('problems');

    s.reset();

    expect(s.plan.filters.show).toBe('frieren');
    expect(s.dupes.scope).toBe('drive');
    expect(s.purge.reRead).toBe(true);
    expect(s.doctor.filter).toBe('problems');
  });
});

describe('a URL cannot start a copy — only a click can', () => {
  test('a token minted by the Plan screen is consumed exactly once', () => {
    const s = freshScreens();
    s.transfer.request('?mode=keep');
    expect(s.transfer.takeIntent('?mode=keep')).toBe(true);
    // Second use of the same token must fail: a reload is not a second click.
    expect(s.transfer.takeIntent('?mode=keep')).toBe(false);
  });

  test('a URL that nobody asked for is not started', () => {
    const s = freshScreens();
    // No token at all: a bookmark, a reload, a Back button.
    expect(s.transfer.takeIntent('?mode=delete-after-verify')).toBe(false);
  });

  test('a token for one intent does not authorise another', () => {
    const s = freshScreens();
    s.transfer.request('?mode=keep');
    expect(s.transfer.takeIntent('?mode=delete-after-verify')).toBe(false);
    // The real token is still there, so the real navigation still works.
    expect(s.transfer.takeIntent('?mode=keep')).toBe(true);
  });

  test('a fixture may start without a token — it cannot copy anything', () => {
    const s = freshScreens();
    expect(s.transfer.takeIntent('?mode=keep', true)).toBe(true);
  });
});
