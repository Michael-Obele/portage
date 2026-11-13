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

	/**
	 * The panel's own scroll box, kept so the field list can be rewound.
	 *
	 * The card is not rebuilt when the selection changes — same DOM node, new
	 * text — so a panel left scrolled on a long row opened the next row part
	 * way down, with its NAME already clipped off the top. Selecting a row is
	 * the moment to read from the beginning.
	 */
	let detailViewport = $state<HTMLElement | null>(null);
	$effect(() => {
		const key = selected?.key;
		if (key === undefined) return;
		detailViewport?.scrollTo({ top: 0 });
	});

	/**
	 * Escape reaches the panel from wherever focus is.
	 *
	 * The handler used to sit on the wrapper, which only sees a key pressed
	 * inside it — and after a pointer click the focus is on the row, then on
	 * `body` as soon as anything else is clicked, so the one key the panel
	 * advertises did nothing. A dialog still wins: bits-ui traps focus inside
	 * it, so a focused element inside `[role="dialog"]` means an overlay owns
	 * Escape, and a field keeps its own.
	 */
	function onWindowKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		if (current === null) return;
		const target = event.target;
		if (target instanceof HTMLElement) {
			const tag = target.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
				return;
			}
		}
		if (document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')) return;
		event.preventDefault();
		onactivate(null);
	}
</script>

<svelte:window onkeydown={onWindowKeyDown} />

<div class={cn('flex min-h-0 flex-1 flex-col gap-2 lg:flex-row', className)}>
	<!-- The table IS the scroll region on this screen. It grows into whatever
	     height the page has left, rather than taking a 62dvh cap and pushing
	     its own bottom past the window — which used to leave two nested
	     scrollers and a page that scrolled when the table ran out.

	     The `min-h-48` floor sits on the TABLE column, not on this wrapper:
	     stacked (below lg) the detail card comes first and would otherwise eat
	     the whole column, leaving a table with a 0 px viewport. A floor on the
	     column keeps about six rows on screen and lets the page scroll instead
	     when the window is genuinely too short for every band. -->
	<div class="order-2 flex min-h-48 min-w-0 flex-1 flex-col lg:order-1">
		<DataTable
			fill
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
				<!-- `w-full max-w-0` is what keeps the table inside its box. A
				     `nowrap` string has a min-content width equal to the whole
				     string, so without a zero maximum the longest name sets the
				     column width and pushes Size off the right edge — measured at
				     a 1024 px window: 658 px of table in a 424 px viewport, a
				     horizontal scrollbar, and every size hidden behind it. -->
				<Table.Cell role="gridcell" class="w-full max-w-0">
					<span class={cn(ROW_NAME, 'block')} title={item.srcPath}
						>{truncateMiddle(item.name, 48)}</span
					>
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
		<!-- `size="sm"` is not decoration. The default card spends 32 px of
		     padding top and bottom plus a 32 px gap on a panel that is only as
		     tall as the table beside it — 29 % of its height on chrome, which at
		     a 700 px window left room for the name and nothing else.

		     `lg:min-h-64` is the card's half of the same floor the table column
		     takes. Without it, a short window (or a screen that also shows an
		     empty state) squashed the card to a 66 px sliver: the header and the
		     action row, clipped, with nothing between them and the buttons out of
		     reach behind the card's `overflow-hidden`. A floor means the panel
		     stays legible and the page scrolls instead, which is honest about
		     the height it needs. -->
		<Card.Root
			data-row-detail
			size="sm"
			class="order-1 w-full shrink-0 gap-2 border border-border text-(length:--text-body) shadow-none ring-0 lg:order-2 lg:min-h-64 lg:w-80"
		>
			<Card.Header class="px-4">
				<Card.Title
					class="text-(length:--text-label) font-medium tracking-normal text-muted-foreground normal-case"
				>
					Selected row
				</Card.Title>
			</Card.Header>

			<Card.Content class="flex min-h-0 flex-1 flex-col">
				<!-- Stacked, this card has no height of its own: a `flex-1` child
				     of an auto-height column collapses to nothing, and the whole
				     panel read as a title with a sliver under it. So the field
				     list gets a height in dvh while stacked — the page scrolls
				     below lg anyway — and goes back to filling the card beside
				     the table, where the card's own height is definite. -->
				<ScrollArea
					bind:viewportRef={detailViewport}
					type="auto"
					class="h-[38dvh] min-h-0 pr-1 lg:h-auto lg:flex-1"
				>
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
