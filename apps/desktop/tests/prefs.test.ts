/**
 * Reading and writing the app's own preferences.
 *
 * The rules being pinned: a value written by an older build is REJECTED rather
 * than trusted, and a blocked or full store never breaks a screen — it only
 * means the choice is not remembered.
 */
import { describe, expect, test } from 'bun:test';

import {
  PREF_KEYS,
  asBoolean,
  asOneOf,
  asPlanFilters,
  readPref,
  writePref,
  type PrefStore
} from '../src/lib/state/prefs.ts';

function fakeStore(initial: Record<string, string> = {}) {
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

describe('readPref', () => {
  test('a missing key falls back without touching the store', () => {
    expect(readPref(fakeStore(), 'nope', asBoolean, true)).toBe(true);
  });

  test('a round trip returns what was written', () => {
    const store = fakeStore();
    writePref(store, 'k', { a: 1 });
    expect(readPref(store, 'k', (v) => (typeof v === 'object' ? v : null), null)).toEqual({ a: 1 });
  });

  test('a corrupt value falls back instead of throwing', () => {
    expect(readPref(fakeStore({ k: '{not json' }), 'k', asBoolean, false)).toBe(false);
  });

  test('a value from an older build is rejected by the validator', () => {
    // A boolean where a scope string is expected must not become the scope.
    expect(readPref(fakeStore({ k: 'true' }), 'k', asOneOf(['configured', 'drive']), 'configured')).toBe(
      'configured'
    );
  });

  test('a null store falls back', () => {
    expect(readPref(null, 'k', asBoolean, false)).toBe(false);
  });

  test('a store that throws on read falls back', () => {
    const hostile: PrefStore = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {}
    };
    expect(readPref(hostile, 'k', asBoolean, false)).toBe(false);
  });
});

describe('writePref', () => {
  test('a store that throws on write does not break the caller', () => {
    const hostile: PrefStore = {
      getItem: () => null,
      setItem() {
        throw new Error('quota');
      }
    };
    expect(() => writePref(hostile, 'k', 1)).not.toThrow();
  });

  test('a null store is a no-op', () => {
    expect(() => writePref(null, 'k', 1)).not.toThrow();
  });
});

describe('validators', () => {
  test('asBoolean accepts only booleans', () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean('true')).toBeNull();
    expect(asBoolean(1)).toBeNull();
  });

  test('asOneOf accepts only its own members', () => {
    const scope = asOneOf(['configured', 'drive']);
    expect(scope('drive')).toBe('drive');
    expect(scope('whole')).toBeNull();
    expect(scope(null)).toBeNull();
  });

  test('asPlanFilters needs every field to be valid', () => {
    expect(asPlanFilters({ device: '', show: '', since: 'all' })).toEqual({
      device: '',
      show: '',
      since: 'all'
    });
    expect(asPlanFilters({ device: '', show: '', since: 'forever' })).toBeNull();
    expect(asPlanFilters({ device: 1, show: '', since: 'all' })).toBeNull();
    expect(asPlanFilters(null)).toBeNull();
    expect(asPlanFilters('nope')).toBeNull();
  });

  test('the keys are stable strings, spelled once', () => {
    expect(PREF_KEYS.planFilters).toBe('portage-plan-filters');
    expect(PREF_KEYS.dupesScope).toBe('portage-dupes-scope');
    expect(PREF_KEYS.purgeVerify).toBe('portage-purge-verify');
    expect(PREF_KEYS.doctorFilter).toBe('portage-doctor-filter');
  });
});
