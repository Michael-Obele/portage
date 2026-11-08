/**
 * Every number the UI shows, rendered once.
 *
 * Two rules from `design.md` are load-bearing:
 *
 *  1. **Numbers carry units and are never rounded to a lie** — `8.1 GB`,
 *     `36.4 MB/s`, `3 min 42 s`, `ETA —`.
 *  2. **Tabular-safe: nothing pads a number inside the string.** A byte count
 *     that reflows while it counts is the cheapest tell that nobody looked, so
 *     alignment is CSS (`font-variant-numeric: tabular-nums`), never spaces.
 *
 * Pure, no imports: this is the module the formatter tests own.
 */

/** The em dash. One glyph for "there is no honest number yet". */
export const DASH = "—";

/**
 * A byte count the way the engine's own `formatBytes` renders it, so the CLI
 * and the app can never show a different number for the same file: base 1024,
 * one decimal below 100 units, a whole number above.
 */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return DASH;
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * A throughput, or `—`.
 *
 * The engine prints MB/s only; below 1 MB/s that rounds to `0.0 MB/s`, which is
 * a lie about a link that is still moving. KB/s fills that gap.
 */
export function formatRate(bytesPerSecond: number | null): string {
	if (
		bytesPerSecond === null ||
		!Number.isFinite(bytesPerSecond) ||
		bytesPerSecond <= 0
	) {
		return DASH;
	}
	if (bytesPerSecond < 1_000) return `${Math.round(bytesPerSecond)} B/s`;
	if (bytesPerSecond < 1_000_000) {
		return `${(bytesPerSecond / 1_000).toFixed(1)} KB/s`;
	}
	return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;
}

/**
 * A duration in words — `45 s`, `3 min 42 s`, `1 h 4 min` — or `—`.
 *
 * `null` is not zero: the engine leaves the ETA null until it can be honest,
 * and an unknown duration must not read as "instant".
 */
export function formatDuration(seconds: number | null): string {
	if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return DASH;
	const s = Math.round(seconds);
	if (s < 60) return `${s} s`;
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return sec > 0 ? `${h} h ${m} min ${sec} s` : `${h} h ${m} min`;
	return sec > 0 ? `${m} min ${sec} s` : `${m} min`;
}

/** `ETA 3 min 42 s`, or `ETA —` until the engine will vouch for a number. */
export function etaWords(seconds: number | null): string {
	return `ETA ${formatDuration(seconds)}`;
}

/** A 0..1 fraction as an integer percent. Never `42.0%`. */
export function formatPercent(fraction: number): string {
	if (!Number.isFinite(fraction)) return DASH;
	const clamped = Math.max(0, Math.min(1, fraction));
	return `${Math.round(clamped * 100)}%`;
}

/**
 * Shrink a filename in the middle, keeping the extension.
 *
 * The release tag and the extension are what a person scans for, so an even
 * split is wrong: reserve the extension first, then split what is left.
 */
export function truncateMiddle(name: string, max: number): string {
	if (max <= 1) return name.slice(0, Math.max(0, max));
	if (name.length <= max) return name;
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 && name.length - dot <= 9 ? name.slice(dot) : "";
	const keep = max - 1 - ext.length;
	if (keep < 2) return `${name.slice(0, max - 1)}…`;
	const head = Math.ceil(keep / 2);
	const tail = keep - head;
	const marker = name.length - ext.length;
	const middle = tail > 0 ? name.slice(marker - tail, marker) : "";
	return `${name.slice(0, head)}…${middle}${ext}`;
}

/** Shrink a path from the FRONT, so the filename survives. */
export function truncateFront(path: string, max: number): string {
	if (max <= 1) return path.slice(Math.max(0, path.length - Math.max(0, max)));
	if (path.length <= max) return path;
	return `…${path.slice(path.length - (max - 1))}`;
}

/** `1 file` / `3 files`. Used by every count in the copy. */
export function plural(n: number, singular: string, plural?: string): string {
	const word = n === 1 ? singular : (plural ?? `${singular}s`);
	return `${n} ${word}`;
}
