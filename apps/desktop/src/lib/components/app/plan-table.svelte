<script lang="ts">
	/**
	 * The plan, as one table: what would move and what would not.
	 *
	 * The name column truncates in the MIDDLE — the release tag and the file
	 * extension are what a person scans for, so an even split is wrong. The full
	 * name is on the cell's tooltip AND in the row detail underneath, because a
	 * tooltip is not reachable by keyboard.
	 */
	import { DASH, formatBytes, truncateFront, truncateMiddle } from '../../util/format.ts';
	import { cn } from '../../utils.ts';
	import { Button } from '../ui/button/index.js';
	import DataTable, { type TableColumn } from './data-table.svelte';
	import type { PlanRow } from './plan-filters.ts';
	import StateChip from './state-chip.svelte';
	import { CONTROL, IDENTIFIER, NUMERIC, ROW_NAME } from './tokens.ts';

	let {
		rows,
		loading,
		filtersSentence,
		selected,
		onactivate,
		onclear,
		onreveal,
		class: className
	}: {
		rows: PlanRow[];
		loading: boolean;
		/** Which filters produced this list, for the table's caption. */
		filtersSentence: string;
		selected: PlanRow | null;
		onactivate: (row: PlanRow | null) => void;
		onclear: () => void;
		onreveal: (path: string) => void;
		class?: string;
	} = $props();

	const COLUMNS: TableColumn[] = [
		{ key: 'state', label: 'State' },
		{ key: 'name', label: 'Name' },
		{ key: 'size', label: 'Size', numeric: true }
	];

	const caption = $derived(`Plan rows, ${filtersSentence}`);
	const filtered = $derived(filtersSentence !== 'no filter');

	function onKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		onactivate(null);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class={cn('flex min-h-0 flex-col', className)} onkeydown={onKeyDown}>
	<!-- A bounded height is what makes the sticky header stick and keeps 500 rows
	     from pushing the footer off the screen. dvh, not px, so 200 % zoom still
	     gets a scrollable table rather than a clipped one. -->
	<DataTable
		class="max-h-[62dvh]"
		columns={COLUMNS}
		{rows}
		rowKey={(row) => row.key}
		{caption}
		{filtered}
		{loading}
		skeletonRows={8}
		selectedKey={selected?.key ?? null}
		onactivated={(row) => onactivate(selected?.key === row.key ? null : row)}
	>
		{#snippet row(item)}
			<td role="gridcell" class="ps-3">
				<StateChip state={item.chip} />
			</td>
			<td role="gridcell" class="px-3">
				<span class={ROW_NAME} title={item.srcPath}>{truncateMiddle(item.name, 48)}</span>
				<span class="sr-only">{item.srcPath}</span>
			</td>
			<td role="gridcell" class={cn('px-3', NUMERIC)}>{formatBytes(item.size)}</td>
		{/snippet}

		{#snippet empty()}
			<p class="px-3 py-6 text-body text-muted-foreground">
				The engine planned no files and skipped none.
			</p>
		{/snippet}

		{#snippet filteredEmpty()}
			<div class="flex flex-col items-start gap-2 px-3 py-6">
				<p class="text-body text-foreground">Nothing matches these filters.</p>
				<p class="measure text-body text-muted-foreground">
					The engine planned nothing under {filtersSentence}. That is not the same as the phone
					holding nothing new — clear the filters to see the whole plan.
				</p>
				<Button class={CONTROL} size="sm" variant="outline" onclick={onclear}>Clear filters</Button>
			</div>
		{/snippet}
	</DataTable>

	{#if selected}
		<div
			data-row-detail
			class="mt-2 flex flex-col gap-2 rounded-[var(--radius-surface)] border border-border bg-card px-4 py-3"
		>
			<h3 class="text-label text-muted-foreground">Selected row</h3>
			<dl class="grid gap-x-6 gap-y-1 sm:grid-cols-2">
				<div class="flex min-w-0 flex-col">
					<dt class="text-caption text-muted-foreground">Name</dt>
					<dd class="font-mono text-label break-all text-foreground">{selected.name}</dd>
				</div>
				<div class="flex min-w-0 flex-col">
					<dt class="text-caption text-muted-foreground">Verdict</dt>
					<dd class="font-mono text-label text-foreground">{selected.verdict}</dd>
				</div>
				<div class="flex min-w-0 flex-col">
					<dt class="text-caption text-muted-foreground">On the phone</dt>
					<dd class="font-mono text-label break-all text-foreground">{selected.srcPath}</dd>
				</div>
				<div class="flex min-w-0 flex-col">
					<dt class="text-caption text-muted-foreground">Falls to</dt>
					<dd class="font-mono text-label break-all text-foreground">{selected.destPath}</dd>
				</div>
				<div class="flex min-w-0 flex-col sm:col-span-2">
					<dt class="text-caption text-muted-foreground">Why</dt>
					<dd class="text-body text-foreground">
						{selected.reason === '' ? DASH : selected.reason}
					</dd>
				</div>
			</dl>
			<div class="flex items-center gap-2">
				{#if selected.onDrive}
					<Button
						class={CONTROL}
						size="sm"
						variant="outline"
						onclick={() => onreveal(selected?.destPath ?? '')}
					>
						Show the drive copy
					</Button>
				{/if}
				<Button class={CONTROL} size="sm" variant="outline" onclick={() => onactivate(null)}>
					Close
				</Button>
			</div>
		</div>
	{/if}
</div>
