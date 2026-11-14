/**
 * Which mounted volumes may be the archive.
 *
 * The drives list offers a `Use` button per volume. Without a rule it offered
 * one for `/` and for `/boot/efi`, which is one click away from pointing a
 * verified-copy tool — one with a delete-source mode — at the root filesystem.
 *
 * The rule is deliberately NARROW. It refuses the boot filesystem and the root
 * mount, plus anything it knows to be read-only or cannot vouch for. It says
 * nothing about internal vs removable: a second internal disk mounted at
 * `/data` is a perfectly good archive, and hiding it would be this module
 * guessing at someone's setup.
 *
 * `null` means "this is a legitimate choice"; a sentence means "here is why it
 * is not". Refused volumes keep their row and lose their button — hiding the
 * row would leave a person wondering where their disk went.
 */
import type { Volume } from '../../engine/protocol.ts';

const BOOT_PATHS = ['/boot', '/efi', '/boot/efi'];

export function destinationRefusal(volume: Volume): string | null {
	// A failed access check is never read as writable. `null` means the engine
	// could not tell, which is a different answer from "no".
	if (volume.readOnly === true) return 'read-only';
	if (volume.readOnly === null) return 'access unknown';

	const mount = volume.mountPoint.replace(/\/+$/, '') || '/';
	if (mount === '/') return 'root filesystem';
	if (BOOT_PATHS.some((path) => mount === path || mount.startsWith(`${path}/`))) {
		return 'boot filesystem';
	}
	return null;
}
