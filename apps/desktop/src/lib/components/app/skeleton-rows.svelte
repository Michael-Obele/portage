<script lang="ts">
	/**
	 * A skeleton shaped like a real row.
	 *
	 * No shimmer. A static skeleton is calmer, cheaper, and does not fire an
	 * animation while the engine is already the slow part. The widths mirror a
	 * real row — chip, name, size — so the eye learns the layout before the
	 * first byte arrives.
	 */
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
			<div class="h-4 w-20 shrink-0 rounded-full bg-muted"></div>
			<div
				class="h-3 rounded-sm bg-muted"
				style="width: {index % 3 === 0 ? 46 : index % 3 === 1 ? 32 : 39}%"
			></div>
			<div class="ml-auto h-3 w-16 shrink-0 rounded-sm bg-muted"></div>
		</div>
	{/each}
	<span class="sr-only">{label}</span>
</div>
