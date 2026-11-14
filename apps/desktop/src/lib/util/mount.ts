/**
 * Path containment, in one place.
 *
 * `startsWith` alone is not containment: `/media/x/2TB2` starts with
 * `/media/x/2TB`, so a drive would take its neighbour's access as its own and
 * a read-only mount could pass for writable. A mount point is a directory, and
 * a sibling sharing its prefix is a different volume.
 *
 * There were three copies of this rule (Home, Plan, the folder picker) because
 * each screen grew its own. Three copies of a correctness rule is how the next
 * fix lands in one of them and not the others.
 */

/**
 * True when `child` is `parent`, or sits underneath it.
 *
 * `parent === '/'` covers everything, because `/` is the parent of every path.
 * An empty parent matches nothing rather than everything: a volume whose mount
 * point could not be read must not silently contain the whole filesystem.
 */
export function isInsideMount(child: string, parent: string): boolean {
	if (parent === '') return false;
	if (parent === '/') return child.startsWith('/');
	// A mount point is a directory. A trailing slash is the same directory.
	const root = parent.replace(/\/+$/, '');
	return child === root || child.startsWith(`${root}/`);
}
