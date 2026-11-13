/**
 * `source-folders.ts` decides what a phone's source list means, and that list
 * is the difference between a pull that copies something and a run that
 * reports success having copied nothing. The rules are small enough to pin
 * exactly here, including the sentence that has to appear when the list is
 * empty.
 *
 * Deliberately imports nothing that needs a Svelte compiler.
 */
import { describe, expect, test } from 'bun:test';

import type { BrowseEntry } from '../src/lib/engine/protocol.ts';
import {
	PHONE_ROOT,
	addRoot,
	breadcrumb,
	describeConsequence,
	dirEntries,
	joinPath,
	normalizePath,
	parentPath,
	removeRoot,
	replaceRoot,
	rootVerdict,
	rootsSentence
} from '../src/lib/components/app/source-folders.ts';

function entry(name: string, kind: 'dir' | 'file'): BrowseEntry {
	return {
		name,
		path: `${PHONE_ROOT}/${name}`,
		kind,
		size: kind === 'file' ? 1024 : null,
		depth: 1
	};
}

describe('normalizePath', () => {
	test('accepts a path with no leading slash', () => {
		expect(normalizePath('sdcard/DCIM')).toBe('/sdcard/DCIM');
	});

	test('drops doubled and trailing slashes', () => {
		expect(normalizePath('/sdcard//DCIM//')).toBe('/sdcard/DCIM');
	});

	test('keeps the filesystem root as a single slash', () => {
		expect(normalizePath('/')).toBe('/');
	});

	test('reads an empty path as the phone root', () => {
		expect(normalizePath('')).toBe(PHONE_ROOT);
		expect(normalizePath('   ')).toBe(PHONE_ROOT);
	});
});

describe('joinPath', () => {
	test('joins a folder under internal storage', () => {
		expect(joinPath('/sdcard', 'DCIM')).toBe('/sdcard/DCIM');
	});

	test('does not double the slash when the base already ends with one', () => {
		expect(joinPath('/sdcard/', 'DCIM')).toBe('/sdcard/DCIM');
		expect(joinPath('/sdcard//', 'DCIM')).toBe('/sdcard/DCIM');
	});

	test('returns the base when the name is empty', () => {
		expect(joinPath('/sdcard', '')).toBe('/sdcard');
		expect(joinPath('/sdcard/DCIM', '   ')).toBe('/sdcard/DCIM');
	});

	test('joins onto the filesystem root without producing //', () => {
		expect(joinPath('/', 'storage')).toBe('/storage');
	});
});

describe('parentPath', () => {
	test('walks one level up', () => {
		expect(parentPath('/sdcard/DCIM/Camera')).toBe('/sdcard/DCIM');
		expect(parentPath('/sdcard/DCIM')).toBe('/sdcard');
	});

	test('treats internal storage as its own parent, so Up disappears there', () => {
		expect(parentPath('/sdcard')).toBe('/sdcard');
		expect(parentPath('/sdcard/')).toBe('/sdcard');
	});

	test('never goes above the filesystem root', () => {
		expect(parentPath('/')).toBe('/');
		expect(parentPath('/storage')).toBe('/');
	});
});

describe('breadcrumb', () => {
	test('starts at internal storage with a readable label', () => {
		expect(breadcrumb('/sdcard')).toEqual([{ label: 'Internal storage', path: '/sdcard' }]);
	});

	test('adds one crumb per segment, each with the path that reaches it', () => {
		expect(breadcrumb('/sdcard/DCIM/Camera')).toEqual([
			{ label: 'Internal storage', path: '/sdcard' },
			{ label: 'DCIM', path: '/sdcard/DCIM' },
			{ label: 'Camera', path: '/sdcard/DCIM/Camera' }
		]);
	});

	test('never produces a doubled slash', () => {
		for (const crumb of breadcrumb('/sdcard//DCIM/')) {
			expect(crumb.path).not.toContain('//');
		}
	});
});

describe('dirEntries', () => {
	test('keeps folders and drops files', () => {
		const entries = [entry('DCIM', 'dir'), entry('IMG_0001.jpg', 'file')];
		expect(dirEntries(entries).map((each) => each.name)).toEqual(['DCIM']);
	});

	test('sorts case-insensitively', () => {
		const entries = [entry('download', 'dir'), entry('DCIM', 'dir'), entry('Android', 'dir')];
		expect(dirEntries(entries).map((each) => each.name)).toEqual(['Android', 'DCIM', 'download']);
	});

	test('leaves the frame’s own array untouched', () => {
		const entries = [entry('b', 'dir'), entry('A', 'dir')];
		dirEntries(entries);
		expect(entries.map((each) => each.name)).toEqual(['b', 'A']);
	});
});

describe('addRoot', () => {
	test('appends the new folder and keeps insertion order', () => {
		const roots = addRoot([], '/sdcard/DCIM');
		expect(roots).toEqual(['/sdcard/DCIM']);
		expect(addRoot(roots, '/sdcard/Music')).toEqual(['/sdcard/DCIM', '/sdcard/Music']);
	});

	test('returns the SAME array for a folder already listed', () => {
		const roots = ['/sdcard/DCIM'];
		expect(addRoot(roots, '/sdcard/DCIM')).toBe(roots);
		expect(addRoot(roots, '/sdcard/DCIM/')).toBe(roots);
	});

	test('returns the SAME array for a folder inside an existing root', () => {
		const roots = ['/sdcard/DCIM'];
		expect(addRoot(roots, '/sdcard/DCIM/Camera')).toBe(roots);
	});

	test('returns the SAME array for a folder that contains an existing root', () => {
		const roots = ['/sdcard/DCIM/Camera'];
		expect(addRoot(roots, '/sdcard/DCIM')).toBe(roots);
	});

	test('does not confuse a prefix with a parent folder', () => {
		const roots = ['/sdcard/DC'];
		expect(addRoot(roots, '/sdcard/DCIM')).toEqual(['/sdcard/DC', '/sdcard/DCIM']);
	});

	test('stores the normalized spelling', () => {
		expect(addRoot([], 'sdcard//DCIM/')).toEqual(['/sdcard/DCIM']);
	});
});

describe('removeRoot', () => {
	test('removes one folder and keeps the rest in order', () => {
		expect(removeRoot(['/sdcard/DCIM', '/sdcard/Music'], '/sdcard/DCIM')).toEqual([
			'/sdcard/Music'
		]);
	});

	test('matches the normalized spelling', () => {
		expect(removeRoot(['/sdcard/DCIM'], '/sdcard/DCIM/')).toEqual([]);
	});

	test('returns the SAME array when there is nothing to remove', () => {
		const roots = ['/sdcard/DCIM'];
		expect(removeRoot(roots, '/sdcard/Music')).toBe(roots);
	});
});

describe('rootsSentence', () => {
	test('says there are none yet', () => {
		expect(rootsSentence([])).toBe('no folders yet');
	});

	test('counts one and many', () => {
		expect(rootsSentence(['/sdcard/DCIM'])).toBe('1 folder');
		expect(rootsSentence(['/sdcard/DCIM', '/sdcard/Music'])).toBe('2 folders');
	});
});

describe('describeConsequence', () => {
	test('says copying nothing when there are no folders', () => {
		expect(describeConsequence([])).toBe('With no folders, a pull copies nothing.');
	});

	test('says what one folder means', () => {
		expect(describeConsequence(['/sdcard/DCIM'])).toBe(
			'A pull copies every file under this folder.'
		);
	});

	test('says what several folders mean', () => {
		expect(describeConsequence(['/sdcard/DCIM', '/sdcard/Music'])).toBe(
			'A pull copies every file under these 2 folders.'
		);
	});
});

describe('rootVerdict', () => {
	test('a folder outside every root is free', () => {
		expect(rootVerdict(['/sdcard/DCIM'], '/sdcard/Music')).toEqual({ kind: 'free' });
	});

	test('the same folder is already in the list', () => {
		expect(rootVerdict(['/sdcard/DCIM'], '/sdcard/DCIM/')).toEqual({ kind: 'already' });
	});

	test('a folder under an existing root is already covered', () => {
		expect(rootVerdict(['/sdcard/Download'], '/sdcard/Download/Move')).toEqual({
			kind: 'covered',
			by: '/sdcard/Download'
		});
	});

	test('a folder containing an existing root replaces it', () => {
		expect(rootVerdict(['/sdcard/Download/Move'], '/sdcard/Download')).toEqual({
			kind: 'replaces',
			roots: ['/sdcard/Download/Move']
		});
	});
});

describe('replaceRoot', () => {
	test('drops the narrower roots it contains and keeps the rest', () => {
		expect(replaceRoot(['/sdcard/Download/Move', '/sdcard/Music'], '/sdcard/Download')).toEqual([
			'/sdcard/Music',
			'/sdcard/Download'
		]);
	});

	test('never duplicates a folder already present', () => {
		expect(replaceRoot(['/sdcard/Download'], '/sdcard/Download')).toEqual(['/sdcard/Download']);
	});
});
