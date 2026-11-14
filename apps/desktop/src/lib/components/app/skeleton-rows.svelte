<script lang="ts">
	/**
	 * A skeleton shaped like a real row.
	 *
	 * The bars are shadcn's `Skeleton` (`bg-muted animate-pulse`), not a local
	 * re-spelling of it: the primitive is what makes the resting state of every
	 * loading surface identical, and a hand-rolled `bg-muted` div is how they
	 * stop being.
	 *
	 * The widths mirror a real row — chip, name, size — so the eye learns the
	 * layout before the first byte arrives.
	 */
	import { Skeleton } from '../ui/skeleton/index.js';
	import { cn } from '../../utils.ts';

	let {
		rows = 3,
		/** Screen-reader text. A skeleton with no label is a blank screen. */
		label = 'Loading',
		class: className
	}: {
		rows?: number;
		label?: string;
		class?: string;
	} = $props();

	const indices = $derived(Array.from({ length: Math.max(1, rows) }, (_, i) => i));
</script>

<div class={cn('flex flex-col', className)} role="status" aria-busy="true" aria-label={label}>
	{#each indices as index (index)}
		<div class="row-h flex items-center gap-3 border-b border-border px-3">
			<Skeleton class="h-4 w-20 shrink-0 rounded-full" />
			<Skeleton
				class="h-3 rounded-sm"
				style="width: {index % 3 === 0 ? 46 : index % 3 === 1 ? 32 : 39}%"
			/>
			<Skeleton class="ms-auto h-3 w-16 shrink-0 rounded-sm" />
		</div>
	{/each}
	<span class="sr-only">{label}</span>
</div>
