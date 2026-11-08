/**
 * The app's shared surface. Every later screen imports from here.
 *
 * Named exports only, so a screen's import list is grep-able and nothing is
 * pulled in by a barrel side effect.
 */
export { default as StateChip, type StateChipState } from './state-chip.svelte';
export { default as ProofStrip } from './proof-strip.svelte';
export { default as PageHeader } from './page-header.svelte';
export { default as EmptyState } from './empty-state.svelte';
export { default as ErrorBand } from './error-band.svelte';
export { default as SkeletonRows } from './skeleton-rows.svelte';
export { default as ToastHost } from './toast-host.svelte';
export { default as ConfirmSheet } from './confirm-sheet.svelte';
export { default as DataTable, type TableColumn } from './data-table.svelte';
export { default as KeyHint } from './key-hint.svelte';
export { default as PlaceholderScreen } from './placeholder-screen.svelte';

export { CONTROL, IDENTIFIER, NUMERIC, PROSE, ROW, ROW_NAME, SUNKEN, SURFACE } from './tokens.ts';
