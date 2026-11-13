<script lang="ts">
	/**
	 * The plan, as one table: what would move and what would not.
	 *
	 * The name column truncates in the MIDDLE — the release tag and the file
	 * extension are what a person scans for, so an even split is wrong. The full
	 * name is on the cell's tooltip AND in the row detail, because a tooltip is
	 * not reachable by keyboard.
	 *
	 * The detail is a panel BESIDE the table on a wide window and ABOVE it on a
	 * narrow one. It used to sit below a 62dvh scroll box, which put it off the
	 * screen: clicking a row looked like it did nothing.
	 */
	import { DASH, formatBytes, truncateMiddle } from '../../util/format.ts';
	import { cn } from '../../utils.ts';
	import { Button } from '../ui/button/index.js';
	import * as Card from '../ui/card/index.js';
	import { ScrollArea } from '../ui/scroll-area/index.js';
	import * as Table from '../ui/table/index.js';
	import CopyButton from './copy-button.svelte';
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
		onremove,
		onrestore,
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
		/** Drop the row from this pull; the engine plans it as `removed`. */
		onremove: (row: PlanRow) => void;
		/** Put a removed row back into this pull. */
		onrestore: (row: PlanRow) => void;
		class?: string;
	} = $props();

	const COLUMNS: TableColumn[] = [
		{ key: 'state', label: 'State' },
		{ key: 'name', label: 'Name' },
		{ key: 'size', label: 'Size', numeric: true }
	];

	const caption = $derived(`Plan rows, ${filtersSentence}`);
	const filtered = $derived(filtersSentence !== 'no filter');

	/**
	 * The selected row as it exists in the CURRENT plan.
	 *
	 * Removing a row re-plans, which replaces every object in `rows`. Looking the
	 * row up by key keeps the panel showing the new chip and reason instead of
	 * the stale object the click was made on.
	 */
	const current = $derived(
		selected === null ? null : (rows.find((row) => row.key === selected.key) ?? selected)
	);

	function onKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		onactivate(null);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class={cn('flex min-h-0 flex-col gap-2 lg:flex-row lg:items-start', className)}
	onkeydown={onKeyDown}
>
	<!-- A bounded height is what makes the sticky header stick and keeps 500 rows
	     from pushing the action bar off the screen. dvh, not px, so 200 % zoom
	     still gets a scrollable table rather than a clipped one. -->
	<div class="order-2 flex min-h-0 min-w-0 flex-1 flex-col lg:order-1">
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
				<Table.Cell role="gridcell">
					<StateChip state={item.chip} />
				</Table.Cell>
				<Table.Cell role="gridcell">
					<span class={ROW_NAME} title={item.srcPath}>{truncateMiddle(item.name, 48)}</span>
					<span class="sr-only">{item.srcPath}</span>
				</Table.Cell>
				<Table.Cell role="gridcell" class={NUMERIC}>{formatBytes(item.size)}</Table.Cell>
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
					<Button class={CONTROL} size="sm" variant="outline" onclick={onclear}
						>Clear filters</Button
					>
				</div>
			{/snippet}
		</DataTable>
	</div>

	{#if current}
		{@const row = current}
		<Card.Root
			data-row-detail
			class="order-1 w-full gap-2 border border-border text-[length:var(--text-body)] shadow-none ring-0 lg:order-2 lg:max-h-[62dvh] lg:w-80 lg:shrink-0"
		>
			<Card.Header class="px-4">
				<Card.Title
					class="text-[length:var(--text-label)] font-medium tracking-normal text-muted-foreground normal-case"
				>
					Selected row
				</Card.Title>
			</Card.Header>

			<Card.Content class="flex min-h-0 flex-1 flex-col">
				<ScrollArea type="auto" class="min-h-0 flex-1 pr-1">
					<dl class="flex flex-col gap-3 pb-1">
						<div class="flex min-w-0 flex-col">
							<dt class="text-caption text-muted-foreground">Name</dt>
							<dd class="font-mono text-label break-all text-foreground">{row.name}</dd>
						</div>
						<div class="flex min-w-0 flex-col">
							<dt class="text-caption text-muted-foreground">Verdict</dt>
							<dd class="font-mono text-label text-foreground">{row.verdict}</dd>
						</div>
						<div class="flex min-w-0 flex-col">
							<dt class="text-caption text-muted-foreground">On the phone</dt>
							<dd class="flex items-start gap-1">
								<span class={cn('min-w-0 break-all text-foreground', IDENTIFIER)}
									>{row.srcPath}</span
								>
								<CopyButton value={row.srcPath} label="Copy the phone path" />
							</dd>
						</div>
						<div class="flex min-w-0 flex-col">
							<dt class="text-caption text-muted-foreground">Falls to</dt>
							<dd class="flex items-start gap-1">
								<span class={cn('min-w-0 break-all text-foreground', IDENTIFIER)}
									>{row.destPath}</span
								>
								<CopyButton value={row.destPath} label="Copy the drive path" />
							</dd>
						</div>
						<div class="flex min-w-0 flex-col">
							<dt class="text-caption text-muted-foreground">Why</dt>
							<dd class="text-body text-foreground">{row.reason === '' ? DASH : row.reason}</dd>
						</div>
					</dl>
				</ScrollArea>
			</Card.Content>

			<Card.Footer class="flex-wrap gap-2 border-t px-4">
				{#if row.excluded}
					<Button class={CONTROL} size="sm" onclick={() => onrestore(row)}
						>Put back in the pull</Button
					>
				{:else if row.willTransfer}
					<Button class={CONTROL} size="sm" variant="outline" onclick={() => onremove(row)}>
						Remove from this pull
					</Button>
				{/if}
				{#if row.onDrive}
					<Button
						class={CONTROL}
						size="sm"
						variant="outline"
						onclick={() => onreveal(row.destPath)}
					>
						Show the drive copy
					</Button>
				{/if}
				<Button class={CONTROL} size="sm" variant="ghost" onclick={() => onactivate(null)}
					>Close</Button
				>
			</Card.Footer>
		</Card.Root>
	{/if}
</div>
