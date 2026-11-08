<script lang="ts">
	/**
	 * The numbers that decide whether to act, aligned so they can be compared.
	 *
	 * A sentence ("10 files to move · 3.9 GB · 5 skipped") cannot be scanned down
	 * a column, and on a screen whose whole job is a size decision, scanning is
	 * the job.
	 *
	 * No card, no radius, no box: hairline dividers and proximity do the
	 * grouping. Boxes inside boxes is the tell this component exists to remove.
	 * Padding is owned by the parent (`px-6` on the page), so the first label
	 * lines up with the page title instead of floating in from the edge.
	 */
	import { cn } from '../../utils.ts';

	export interface Stat {
		label: string;
		value: string;
		/** A second line, for a condition the number depends on. */
		hint?: string;
		tone?: 'default' | 'verified' | 'failed' | 'muted';
	}

	let { items, class: className }: { items: Stat[]; class?: string } = $props();

	const TONE: Record<NonNullable<Stat['tone']>, string> = {
		default: 'text-foreground',
		verified: 'text-state-verified',
		failed: 'text-state-failed',
		muted: 'text-muted-foreground'
	};
</script>

{#if items.length > 0}
	<dl class={cn('grid grid-cols-2 gap-y-3 sm:grid-cols-4', className)}>
		{#each items as item, index (item.label)}
			<div
				class={cn(
					'flex min-w-0 flex-col gap-0.5',
					// A divider is the group boundary; there is no box to draw.
					index > 0 && 'border-l border-border pl-4',
					// On a two-column wrap the left cell of each row starts flush.
					index % 2 === 0 && 'pl-0 sm:border-l sm:pl-4',
					index === 0 && 'sm:border-l-0 sm:pl-0'
				)}
			>
				<dt class="text-caption text-muted-foreground">{item.label}</dt>
				<dd class={cn('font-mono text-lead tabular-nums', TONE[item.tone ?? 'default'])}>
					{item.value}
				</dd>
				{#if item.hint}
					<dd class="text-caption text-muted-foreground">{item.hint}</dd>
				{/if}
			</div>
		{/each}
	</dl>
{/if}
