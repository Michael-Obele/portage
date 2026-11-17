/**
 * The Duplicates screen's rules: what arrives selected, what the footer counts,
 * and what the confirm sheet is allowed to claim.
 *
 * These are the assertions that keep the screen honest, so they are written
 * against the wire shapes rather than against the components: a key is the only
 * thing that may travel back, the default selection is every non-keeper, and the
 * report's own numbers are what a person reads.
 *
 * Deliberately imports nothing that needs a Svelte compiler.
 */
import { describe, expect, test } from 'bun:test';

import type {
	DupesFrame,
	NeedsConfirmFrame,
	WireDupeGroup,
	WireDupeMember
} from '#lib/engine/protocol.ts';
import { PROTOCOL_VERSION } from '#lib/engine/protocol.ts';
import {
	applySummary,
	clearKeys,
	confirmFacts,
	groupKeys,
	groupSelectionState,
	groupTotals,
	groupUnparsed,
	memberTone,
	scanSentence,
	selectKeys,
	selectedPaths,
	selectionFor,
	toggle
} from '#lib/components/app/dupes-view.ts';

function member(key: string, patch: Partial<WireDupeMember> = {}): WireDupeMember {
	return {
		key,
		path: `/media/node/2TB/Videos/Anime/Frieren/S01/${key}.mkv`,
		relative: `Frieren/S01/${key}.mkv`,
		size: 1000,
		hash: '9f2c1a77',
		keep: false,
		score: null,
		scoreReason: null,
		suspicious: null,
		...patch
	};
}

function group(
	id: number,
	members: WireDupeMember[],
	patch: Partial<WireDupeGroup> = {}
): WireDupeGroup {
	return {
		id,
		tier: 1,
		reason: 'byte-identical: same size and same sha256 over the whole file',
		label: null,
		members,
		reclaimableBytes: members
			.filter((entry) => !entry.keep)
			.reduce((sum, entry) => sum + entry.size, 0),
		...patch
	};
}

/** Two groups: one with a keeper, one whose only copy is flagged. */
function groups(): WireDupeGroup[] {
	return [
		group(1, [
			member('k0', { keep: true, size: 412_000_000 }),
			member('k1', { keep: false, size: 412_000_000 })
		]),
		group(
			2,
			[
				member('k2', { keep: true, size: 418_000_000 }),
				member('k3', { keep: false, size: 241_000_000, suspicious: 'truncated' })
			],
			{
				tier: 2,
				label: 'Frieren - 07',
				reason: 'same episode, different release — needs a human decision'
			}
		)
	];
}

function dupesFrame(patch: Partial<DupesFrame> = {}): DupesFrame {
	return {
		v: PROTOCOL_VERSION,
		type: 'dupes',
		scanId: 'scan-1',
		groups: groups(),
		tier1Count: 1,
		tier2Count: 1,
		reclaimableBytes: 653_000_000,
		scannedFiles: 3_412,
		scannedBytes: 1_402_000_000_000,
		truncated: ['Frieren/S01/k3.mkv'],
		unparsed: ['Frieren/Bonus/artwork.zip'],
		// The fixture claims the fast walker. A report without a walk summary
		// cannot tell a slow scan from a stuck one, so it is part of the shape.
		unreadableFiles: 0,
		io: {
			via: 'scanner',
			elapsedMs: 4_265,
			dirs: 4_602,
			errors: [],
			errorCount: 0,
			deepest: { relative: 'a/b/c.mkv', depth: 3 },
			depthLimited: 0,
			scannerError: null
		},
		...patch
	};
}

describe('selectionFor', () => {
	test('selects the redundant copies of byte-identical (tier 1) groups', () => {
		expect([...selectionFor(groups())].sort()).toEqual(['k1']);
	});

	test('leaves tier 2 unticked — a name match is a guess, not a duplicate', () => {
		// Tier 2 is "same episode, different release": those copies can differ in
		// subtitles, audio and resolution, so pre-ticking one is how a person
		// loses the only copy carrying their language.
		const selected = selectionFor(groups());
		const tier2 = groups().find((entry) => entry.tier === 2);
		expect(tier2).toBeDefined();
		for (const entry of tier2?.members ?? []) {
			expect(selected.has(entry.key)).toBe(false);
		}
	});

	test('leaves a keeper out but does not remove it from the group', () => {
		const selected = selectionFor(groups());
		expect(selected.has('k0')).toBe(false);
		expect(groups()[0]?.members.map((entry) => entry.key)).toEqual(['k0', 'k1']);
	});

	test('selects nothing when every member is a keeper', () => {
		const allKeep = [group(9, [member('k9', { keep: true })])];
		expect(selectionFor(allKeep).size).toBe(0);
	});

	test('is empty for an empty report', () => {
		expect(selectionFor([]).size).toBe(0);
	});
});

describe('groupUnparsed', () => {
	test('groups lines by their reason, biggest first', () => {
		const groups = groupUnparsed([
			'a.mkv — no episode number in the filename',
			'b.mkv — no episode number in the filename',
			'c.mkv — "01-12" is a range of episodes, not one episode',
			'd.mkv — no episode number in the filename'
		]);
		expect(groups).toHaveLength(2);
		expect(groups[0]?.reason).toBe('no episode number in the filename');
		expect(groups[0]?.count).toBe(3);
		expect(groups[0]?.examples).toEqual(['a.mkv', 'b.mkv', 'd.mkv']);
		expect(groups[1]?.count).toBe(1);
	});

	test('keeps only a few examples per reason', () => {
		const many = Array.from({ length: 9 }, (_, i) => `f${i}.mkv — no episode number in the filename`);
		const [only] = groupUnparsed(many);
		expect(only?.count).toBe(9);
		expect(only?.examples).toHaveLength(3);
	});

	test('splits at the LAST separator, so a real filename may contain one', () => {
		// This exact shape is on the archive: the path carries an em dash, the
		// reason never does. Splitting on the first cut the filename in half.
		const [only] = groupUnparsed([
			'Audio/Master your camera — My 5 tips! [id].webm — no episode number in the filename'
		]);
		expect(only?.examples).toEqual(['Audio/Master your camera — My 5 tips! [id].webm']);
		expect(only?.reason).toBe('no episode number in the filename');
	});

	test('a reason that contains a separator is still readable', () => {
		// The residual risk, pinned so it is a known shape rather than a surprise.
		const [only] = groupUnparsed(['x.mkv — modified 42s ago — wait 78s']);
		expect(only?.reason).toBe('wait 78s');
	});

	test('a line with no reason is still counted', () => {
		const [only] = groupUnparsed(['x.mkv']);
		expect(only?.reason).toBe('no reason given');
		expect(only?.count).toBe(1);
	});

	test('an empty report is empty', () => {
		expect(groupUnparsed([])).toEqual([]);
	});
});

describe('toggle', () => {
	test('adds a key that is not selected', () => {
		expect(toggle(new Set(['k1']), 'k0').has('k0')).toBe(true);
	});

	test('removes a key that is selected, so a keeper stays selectable over time', () => {
		expect(toggle(new Set(['k1']), 'k1').size).toBe(0);
	});

	test('returns a new set and never mutates the one it was given', () => {
		const before = new Set(['k1']);
		const after = toggle(before, 'k2');
		expect(after).not.toBe(before);
		expect([...before]).toEqual(['k1']);
		expect([...after].sort()).toEqual(['k1', 'k2']);
	});
});

describe('groupKeys, selectKeys and clearKeys', () => {
	test('groupKeys keeps report order', () => {
		expect(groupKeys(groups()[1] as WireDupeGroup)).toEqual(['k2', 'k3']);
	});

	test('selectKeys adds a whole group', () => {
		expect([...selectKeys(new Set(), ['k0', 'k1'])].sort()).toEqual(['k0', 'k1']);
	});

	test('clearKeys removes a whole group and leaves the rest', () => {
		expect([...clearKeys(new Set(['k0', 'k1', 'k2']), ['k0', 'k1'])]).toEqual(['k2']);
	});

	test('neither helper mutates its input', () => {
		const before = new Set(['k0']);
		selectKeys(before, ['k1']);
		clearKeys(before, ['k0']);
		expect([...before]).toEqual(['k0']);
	});
});

describe('groupSelectionState', () => {
	test('reports all, some and none', () => {
		const first = groups()[0] as WireDupeGroup;
		expect(groupSelectionState(first, new Set(['k0', 'k1']))).toBe('all');
		expect(groupSelectionState(first, new Set(['k1']))).toBe('some');
		expect(groupSelectionState(first, new Set())).toBe('none');
	});

	test('treats a group with no members as none, not all', () => {
		expect(groupSelectionState(group(9, []), new Set())).toBe('none');
	});
});

describe('groupTotals', () => {
	test('counts only selected members and sums their sizes', () => {
		expect(groupTotals(new Set(['k1']), groups())).toEqual({ count: 1, bytes: 412_000_000 });
	});

	test('sums across groups', () => {
		expect(groupTotals(new Set(['k1', 'k3']), groups())).toEqual({
			count: 2,
			bytes: 653_000_000
		});
	});

	test('a keeper can be counted when the person selects it', () => {
		expect(groupTotals(new Set(['k0']), groups())).toEqual({ count: 1, bytes: 412_000_000 });
	});

	test('ignores a key no group carries', () => {
		expect(groupTotals(new Set(['nope']), groups())).toEqual({ count: 0, bytes: 0 });
	});

	test('an empty selection is 0 files and 0 bytes, never NaN', () => {
		expect(groupTotals(new Set(), groups())).toEqual({ count: 0, bytes: 0 });
	});
});

describe('memberTone', () => {
	test('a keeper wears the kept chip', () => {
		expect(memberTone(member('k0', { keep: true }))).toBe('kept');
	});

	test('any other copy wears the duplicate chip', () => {
		expect(memberTone(member('k1'))).toBe('duplicate');
	});

	test('a flagged copy outranks its keep flag', () => {
		expect(memberTone(member('k2', { keep: true, suspicious: 'truncated' }))).toBe('skipped');
	});
});

describe('scanSentence', () => {
	test('names the files, the bytes, the groups and what could be freed', () => {
		const sentence = scanSentence(dupesFrame({ groups: [], reclaimableBytes: 0 }));
			expect(sentence).toContain('3,412 files');
		expect(sentence).toContain('1.3 TB');
		expect(sentence).toContain('0 groups');
		expect(sentence).toContain('0 B reclaimable');
	});

	test('counts the groups the frame carries, singular included', () => {
		const sentence = scanSentence(dupesFrame({ groups: [group(1, [member('k0')])] }));
		expect(sentence).toContain('1 group ·');
	});

	test('never rounds a byte count into a different unit', () => {
		expect(scanSentence(dupesFrame({ scannedBytes: 1024, reclaimableBytes: 2048 }))).toContain(
			'1.0 KB'
		);
	});
});

describe('confirmFacts', () => {
	const frame = (patch: Partial<NeedsConfirmFrame> = {}): NeedsConfirmFrame => ({
		v: PROTOCOL_VERSION,
		type: 'needsConfirm',
		actionId: 'scan-1',
		action: 'dupes.apply',
		paths: ['/media/node/2TB/Videos/Anime/Frieren/S01/k1.mkv'],
		count: 1,
		bytes: 412_000_000,
		trashDir: '/media/node/2TB/Videos/Anime/.portage/trash/2026-11-09',
		...patch
	});

	test("takes the engine's own paths, count, bytes and trash directory", () => {
		const facts = confirmFacts(frame(), groups(), new Set(['k1']));
		expect(facts.paths).toEqual(['/media/node/2TB/Videos/Anime/Frieren/S01/k1.mkv']);
		expect(facts.count).toBe(1);
		expect(facts.bytes).toBe(412_000_000);
		expect(facts.trashDir).toBe('/media/node/2TB/Videos/Anime/.portage/trash/2026-11-09');
	});

	test('falls back to the selection when a frame carries no paths at all', () => {
		const facts = confirmFacts(
			frame({ paths: [], count: 2, bytes: 0 }),
			groups(),
			new Set(['k1', 'k3'])
		);
		expect(facts.paths).toEqual(['Frieren/S01/k1.mkv', 'Frieren/S01/k3.mkv']);
		expect(facts.count).toBe(2);
		expect(facts.bytes).toBe(653_000_000);
	});

	test('a null trash directory is passed through, never invented', () => {
		expect(confirmFacts(frame({ trashDir: null }), groups(), new Set(['k1'])).trashDir).toBeNull();
	});
});

describe('applySummary', () => {
	test('reads the outcome from a success answer', () => {
		expect(
			applySummary({
				moved: ['/a', '/b'],
				refused: ['/c'],
				bytesMoved: 1_234,
				trashDir: '/trash/2026-11-09'
			})
		).toEqual({ moved: 2, refused: 1, bytesMoved: 1_234, trashDir: '/trash/2026-11-09' });
	});

	test('returns null when the engine asked for confirmation instead', () => {
		expect(
			applySummary({
				needsConfirm: true,
				actionId: 'scan-1',
				count: 2,
				bytes: 900,
				trashDir: '/trash/2026-11-09'
			})
		).toBeNull();
	});

	test('a field that is not a list counts as zero files, never NaN', () => {
		expect(
			applySummary({
				moved: 'two',
				refused: 3,
				bytesMoved: Number.NaN,
				trashDir: null
			})
		).toEqual({ moved: 0, refused: 3, bytesMoved: 0, trashDir: null });
	});
});

describe('selectedPaths', () => {
	test('returns relatives in report order, for display only', () => {
		expect(selectedPaths(new Set(['k3', 'k1']), groups())).toEqual([
			'Frieren/S01/k1.mkv',
			'Frieren/S01/k3.mkv'
		]);
	});
});
