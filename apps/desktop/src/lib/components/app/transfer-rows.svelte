<script lang="ts">
	/**
	 * The files, one row each.
	 *
	 * The chip sequence is the product's claim made visible: queued → copying →
	 * verifying → verified. `verifying` is derived locally (the bar is full and
	 * no `verified` event has arrived) and is not an engine state — it is the
	 * window in which a person is most likely to pull the cable out, so it is
	 * named rather than left blank.
	 *
	 * A stalled row says its own seconds on the row itself: the number is the
	 * diagnosis, and putting it behind a click is what makes someone wait.
	 */
	import { DASH, formatBytes, truncateMiddle } from '../../util/format.ts';
	import { cn } from '../../utils.ts';
	import DataTable, { type TableColumn } from './data-table.svelte';
	import StateChip from './state-chip.svelte';
	import * as Table from '../ui/table/index.js';
	import { IDENTIFIER, NUMERIC, ROW_NAME } from './tokens.ts';
	import type { RowView } from './transfer-series.ts';

	let {
		rows,
		loading,
		class: className
	}: {
		rows: RowView[];
		loading: boolean;
		class?: string;
	} = $props();

	const COLUMNS: TableColumn[] = [
		{ key: 'state', label: 'State' },
		{ key: 'name', label: 'Name' },
		{ key: 'size', label: 'Size', numeric: true },
		{ key: 'progress', label: 'Progress' },
		{ key: 'why', label: 'Why' }
	];

	const caption = $derived(
		loading && rows.length === 0
			? 'Run rows, building the plan'
			: `Run rows, ${rows.length} in this run`
	);
</script>

<DataTable
	class={cn('max-h-[55dvh]', className)}
	columns={COLUMNS}
	{rows}
	rowKey={(row) => row.key}
	{caption}
	{loading}
	skeletonRows={6}
>
	{#snippet row(item)}
		<Table.Cell role="gridcell">
			<StateChip state={item.chip} />
		</Table.Cell>
		<Table.Cell role="gridcell">
			<span class="flex min-w-0 flex-col">
				<span class={ROW_NAME} title={item.srcPath}>{truncateMiddle(item.name, 48)}</span>
				<span class={cn(IDENTIFIER, 'truncate text-muted-foreground')} title={item.destPath}>
					{truncateMiddle(item.destPath, 64)}
				</span>
			</span>
		</Table.Cell>
		<Table.Cell role="gridcell" class={NUMERIC}>
			{formatBytes(item.bytes)} / {formatBytes(item.size)}
		</Table.Cell>
		<Table.Cell role="gridcell">
			<div class="flex items-center gap-2">
				<!-- The bar is the picture; the percent beside it is the reading. -->
				<div class="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden="true">
					<div
						class="h-full rounded-full bg-foreground"
						style="width: {item.fraction * 100}%"
					></div>
				</div>
				<span class={cn('text-label text-muted-foreground', NUMERIC)}>{item.percent}</span>
				{#if item.stalledSeconds > 0}
					<span class="text-label whitespace-nowrap text-state-failed">
						stalled {item.stalledSeconds} s
					</span>
				{/if}
			</div>
		</Table.Cell>
		<Table.Cell role="gridcell">
			<span class="block truncate text-body text-muted-foreground" title={item.reason}>
				{item.reason === '' ? DASH : item.reason}
			</span>
		</Table.Cell>
	{/snippet}

	{#snippet empty()}
		<p class="px-3 py-6 text-body text-muted-foreground">
			The engine has not sent any rows for this run yet.
		</p>
	{/snippet}
</DataTable>
