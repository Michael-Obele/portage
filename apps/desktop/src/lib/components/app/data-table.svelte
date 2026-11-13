<script lang="ts" module>
	/** One column: a key for the `{#each}`, a visible label, and its alignment. */
	export interface TableColumn {
		key: string;
		label: string;
		/** Right-aligned tabular numerals. Never a padded string. */
		numeric?: boolean;
		class?: string;
	}
</script>

<script lang="ts" generics="T">
	/**
	 * The table every dense screen is built on.
	 *
	 * It owns the four things a screen must not get wrong and would, four times
	 * over: real table semantics with `<th scope>` and a caption, a sticky
	 * header, keyboard-navigable rows, and the difference between "nothing here"
	 * and "nothing matches the filter".
	 *
	 * The caller renders the cells, because a cell is screen-specific. The
	 * caller does not render the row element, because that is where the
	 * accessibility and the navigation live.
	 */
	import type { Snippet } from 'svelte';
	import { cn } from '../../utils.ts';
	import { ScrollArea } from '../ui/scroll-area/index.js';
	import * as Table from '../ui/table/index.js';
	import SkeletonRows from './skeleton-rows.svelte';
	let {
		columns,
		rows,
		rowKey,
		/** For the caption: which filter is in force, or "no filter". */
		caption,
		/** True when a filter is applied and has produced nothing. */
		filtered = false,
		loading = false,
		skeletonRows = 3,
		/**
		 * Take the height the parent gives it, instead of a cap passed through
		 * `class`. A screen whose table is the only thing that scrolls sets this,
		 * so the table ends where the window does and the page never scrolls too.
		 */
		fill = false,
		empty,
		filteredEmpty,
		row,
		onactivated,
		selectedKey = null,
		class: className
	}: {
		columns: TableColumn[];
		rows: T[];
		rowKey: (row: T) => string;
		caption: string;
		filtered?: boolean;
		loading?: boolean;
		skeletonRows?: number;
		fill?: boolean;
		empty?: Snippet;
		filteredEmpty?: Snippet;
		row?: Snippet<[T, number]>;
		onactivated?: (item: T) => void;
		selectedKey?: string | null;
		class?: string;
	} = $props();

	/**
	 * Arrow keys move between rows without leaving the table, Home and End jump
	 * to the ends. Enter and Space activate, and only when the screen gave the
	 * table something to activate.
	 */
	function onKeyDown(event: KeyboardEvent): void {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		const tr = target.closest('tr');
		if (!tr || !tr.hasAttribute('data-row-index')) return;

		const index = Number(tr.getAttribute('data-row-index') ?? '0');
		const body = tr.parentElement;
		if (!body) return;

		const move = (next: number): void => {
			const clamped = Math.max(0, Math.min(rows.length - 1, next));
			const nextRow = body.querySelector<HTMLElement>(`tr[data-row-index="${clamped}"]`);
			nextRow?.focus();
			event.preventDefault();
		};

		switch (event.key) {
			case 'ArrowDown':
				return move(index + 1);
			case 'ArrowUp':
				return move(index - 1);
			case 'Home':
				return move(0);
			case 'End':
				return move(rows.length - 1);
			case 'Enter':
			case ' ':
				if (!onactivated) return;
				event.preventDefault();
				onactivated(rows[index] as T);
				return;
			default:
				return;
		}
	}

	function onRowClick(item: T): void {
		onactivated?.(item);
	}
</script>

<div class={cn('relative flex min-h-0 flex-col', fill && 'flex-1')}>
	<!-- shadcn's ScrollArea, not `overflow-auto`. A native scrollbar on a desktop
	     shell is a grey slab that reads as a browser, and this table is the one
	     surface a person stares at for minutes at a time.

	 `className` lands on the SCROLL BOX, not on this wrapper: callers use it
	 for the height cap (`max-h-[62dvh]`), and the viewport inherits that cap.
	 A cap on this wrapper would size nothing, because the wrapper is a flex
	 column whose child only fills a definite height.

	 With `fill` the wrapper grows into its parent instead, and the scroll box
	 takes that whole height — the same rule, read the other way round: the
	 box is only scrollable because the height above it is definite. -->
	<ScrollArea
		orientation="both"
		type="auto"
		class={cn('min-h-0', fill && 'h-full', className)}
		scrollbarYClasses="w-2"
	>
		<!-- Header, rows and cells are shadcn's Table primitives. `Table.Root` is
		     deliberately not used: it wraps the table in `overflow-x-auto`, which
		     makes that wrapper the sticky header's scroll container — and it never
		     scrolls vertically, so the header would slide away inside this
		     ScrollArea. -->
		<table
			role="grid"
			aria-rowcount={rows.length + 1}
			aria-colcount={columns.length}
			class="w-full border-separate border-spacing-0 text-body [&_tbody>tr]:h-(--row-h) [&_tbody>tr:last-child>td]:border-b-0 [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-0"
			onkeydown={onKeyDown}
		>
			<Table.Caption class="sr-only">{caption}</Table.Caption>
			<Table.Header class="sticky top-0 z-10 bg-card">
				<Table.Row class="h-8 hover:bg-transparent">
					{#each columns as column (column.key)}
						<Table.Head
							scope="col"
							class={cn(
								'h-8 border-b border-border px-3 text-label font-medium tracking-normal text-muted-foreground normal-case',
								column.numeric ? 'text-right' : 'text-left',
								column.class
							)}
						>
							{column.label}
						</Table.Head>
					{/each}
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#if loading && rows.length === 0}
					<Table.Row class="border-0 hover:bg-transparent">
						<Table.Cell colspan={columns.length} class="p-0">
							<SkeletonRows rows={skeletonRows} label={caption} />
						</Table.Cell>
					</Table.Row>
				{:else if rows.length === 0}
					<Table.Row class="border-0 hover:bg-transparent">
						<Table.Cell colspan={columns.length} class="p-0">
							{#if filtered && filteredEmpty}
								{@render filteredEmpty()}
							{:else if !filtered && empty}
								{@render empty()}
							{/if}
						</Table.Cell>
					</Table.Row>
				{:else}
					{#each rows as item, index (rowKey(item))}
						<Table.Row
							data-row-index={index}
							data-row-key={rowKey(item)}
							data-state={selectedKey === rowKey(item) ? 'selected' : undefined}
							aria-selected={onactivated ? selectedKey === rowKey(item) : undefined}
							tabindex={0}
							class={cn(
								'border-0 outline-none focus-visible:bg-muted focus-visible:-outline-offset-2',
								onactivated && 'cursor-pointer'
							)}
							onclick={() => onRowClick(item)}
						>
							{#if row}
								{@render row(item, index)}
							{/if}
						</Table.Row>
					{/each}
				{/if}
			</Table.Body>
		</table>
	</ScrollArea>
</div>
