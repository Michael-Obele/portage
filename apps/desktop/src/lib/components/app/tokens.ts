/**
 * The class strings the design document fixes, in one place.
 *
 * shadcn's `sera` style is a template: `rounded-none`, uppercase labels, 14 px
 * body. `design.md` disagrees on all three, so every call site overrides the
 * same way. Repeating the override in twelve files is how one of them ends up
 * different, which is the tell this whole token layer exists to avoid.
 */

/** A control: one of the two radii, sentence case, 13 px. */
export const CONTROL =
	"rounded-[var(--radius-control)] normal-case tracking-normal font-medium text-body";

/** A raised surface: the ladder's second step, drawn with a border. */
export const SURFACE =
	"rounded-[var(--radius-surface)] border border-border bg-card text-card-foreground";

/** The sunken step: table zebra, inset wells, disabled fill. */
export const SUNKEN = "bg-muted";

/** Numbers that can change get their alignment from CSS, never from padding. */
export const NUMERIC = "text-right tabular-nums font-mono";

/** A row in a dense list. 32 px comfortable; the compact preference is 28 px. */
export const ROW = "row-h border-b border-border last:border-b-0";

/** Prose stops at 68 characters. Tables may use the full width. */
export const PROSE = "measure text-body text-muted-foreground";

/** What the eye should land on first in a row: the name, not the chrome. */
export const ROW_NAME = "truncate text-body text-foreground";

/** Identifiers — paths, hashes — are mono so they can be compared by eye. */
export const IDENTIFIER = "font-mono text-label";
