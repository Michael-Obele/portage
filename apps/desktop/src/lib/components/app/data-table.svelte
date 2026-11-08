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
		empty,
		filteredEmpty,
		row,
		onactivated,
		selectedKey = null,
		class: className,
	}: {
		columns: TableColumn[];
		rows: T[];
		rowKey: (row: T) => string;
		caption: string;
		filtered?: boolean;
		loading?: boolean;
		skeletonRows?: number;
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

<div class={cn('relative min-h-0', className)}>
	<div class="h-full overflow-auto rounded-[var(--radius-surface)] border border-border">
		<!-- `border-separate` is what makes a sticky header paint its own border
		     instead of dropping it while it scrolls. `role="grid"` is the ARIA
		     pattern for a table whose rows take focus and move with the arrow
		     keys; callers give their cells `role="gridcell"` to complete it. -->
		<table
			role="grid"
			aria-rowcount={rows.length + 1}
			aria-colcount={columns.length}
			class="w-full border-separate border-spacing-0 text-body [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_tbody>tr]:h-[var(--row-h)] [&_tbody>tr:last-child>td]:border-b-0"
			onkeydown={onKeyDown}
		>
			<caption class="sr-only">{caption}</caption>
			<thead class="sticky top-0 z-10">
				<tr class="h-8 bg-card">
					{#each columns as column (column.key)}
						<th
							scope="col"
							class={cn(
								'border-b border-border px-3 text-label font-medium text-muted-foreground',
								column.numeric ? 'text-right' : 'text-left',
								column.class
							)}
						>
							{column.label}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#if loading && rows.length === 0}
					<tr>
						<td colspan={columns.length} class="p-0">
							<SkeletonRows rows={skeletonRows} label={caption} />
						</td>
					</tr>
				{:else if rows.length === 0}
					<tr>
						<td colspan={columns.length}>
							{#if filtered && filteredEmpty}
								{@render filteredEmpty()}
							{:else if !filtered && empty}
								{@render empty()}
							{/if}
						</td>
					</tr>
				{:else}
					{#each rows as item, index (rowKey(item))}
						<tr
							data-row-index={index}
							data-row-key={rowKey(item)}
							data-selected={selectedKey === rowKey(item) ? 'true' : undefined}
							tabindex="0"
							class={cn(
								'bg-background outline-none',
								'focus-visible:-outline-offset-2 focus-visible:bg-muted',
								'data-[selected=true]:bg-muted',
								onactivated && 'cursor-pointer'
							)}
							onclick={() => onRowClick(item)}
						>
							{#if row}
								{@render row(item, index)}
							{/if}
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>
