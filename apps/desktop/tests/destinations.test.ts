import { describe, expect, test } from 'bun:test';

import { destinationRefusal } from '#lib/components/app/destinations.ts';
import type { Volume } from '#lib/engine/protocol.ts';

function volume(over: Partial<Volume> = {}): Volume {
	return {
		device: '/dev/sda1',
		label: null,
		mountPoint: '/media/node/2TB',
		fsType: 'ntfs',
		driver: 'fuseblk',
		totalBytes: 2_000_000_000_000,
		freeBytes: 400_000_000_000,
		removable: true,
		transport: 'usb',
		readOnly: false,
		isPortageDrive: true,
		...over
	};
}

describe('which volume may be the archive', () => {
	test('an ordinary writable external drive is allowed', () => {
		expect(destinationRefusal(volume())).toBeNull();
	});

	test('a second internal disk is allowed', () => {
		// The rule is about the boot/root filesystems, not about removable-ness.
		// Hiding an internal archive would be the app guessing at a setup.
		expect(destinationRefusal(volume({ mountPoint: '/data', removable: false }))).toBeNull();
	});

	test('the root filesystem is refused', () => {
		expect(destinationRefusal(volume({ mountPoint: '/' }))).toBe('root filesystem');
		expect(destinationRefusal(volume({ mountPoint: '/', removable: false }))).toBe(
			'root filesystem'
		);
	});

	test('the boot and EFI filesystems are refused, and so is anything under them', () => {
		for (const mountPoint of ['/boot', '/boot/efi', '/efi']) {
			expect(destinationRefusal(volume({ mountPoint }))).toBe('boot filesystem');
		}
	});

	test('a path that merely starts with the word boot is not the boot filesystem', () => {
		// `/bootleg` is not `/boot`: the check is a path boundary, not a prefix.
		expect(destinationRefusal(volume({ mountPoint: '/bootleg' }))).toBeNull();
	});

	test('a read-only mount is refused with its own reason', () => {
		expect(destinationRefusal(volume({ readOnly: true }))).toBe('read-only');
	});

	test('an unverified mount is refused, never treated as writable', () => {
		// A failed access check is `null`, which is a different answer from "no".
		expect(destinationRefusal(volume({ readOnly: null }))).toBe('access unknown');
	});

	test('a trailing slash does not turn the root into an ordinary path', () => {
		expect(destinationRefusal(volume({ mountPoint: '///' }))).toBe('root filesystem');
	});
});
