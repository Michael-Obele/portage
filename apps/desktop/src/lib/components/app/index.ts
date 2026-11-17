/**
 * The app's shared surface. Every later screen imports from here.
 *
 * Named exports only, so a screen's import list is grep-able and nothing is
 * pulled in by a barrel side effect.
 */
export { default as StateChip, type StateChipState } from '#lib/components/app/state-chip.svelte';
export { default as ProofStrip } from '#lib/components/app/proof-strip.svelte';
export { default as PageHeader } from '#lib/components/app/page-header.svelte';
export { default as EmptyState } from '#lib/components/app/empty-state.svelte';
export { default as ErrorBand } from '#lib/components/app/error-band.svelte';
export { default as SkeletonRows } from '#lib/components/app/skeleton-rows.svelte';
export { default as ToastHost } from '#lib/components/app/toast-host.svelte';
export { default as ConfirmSheet } from '#lib/components/app/confirm-sheet.svelte';
export { default as DataTable, type TableColumn } from '#lib/components/app/data-table.svelte';
export { default as KeyHint } from '#lib/components/app/key-hint.svelte';
export { default as PlaceholderScreen } from '#lib/components/app/placeholder-screen.svelte';
export { default as SourceFolders } from '#lib/components/app/source-folders.svelte';

export { CONTROL, PROSE, SURFACE } from '#lib/components/app/tokens.ts';
