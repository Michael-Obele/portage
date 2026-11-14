<script lang="ts">
	/**
	 * A key hint: the keycap and what it does.
	 *
	 * `<kbd>` is the correct element, and the cap itself is shadcn's `Kbd` so the
	 * chrome lives in one place. A screen reader says "kbd" rather than reading a
	 * stray letter, and the hints line at the bottom of a screen is a list a
	 * person can skim.
	 */
	import { Kbd } from '../ui/kbd/index.js';
	import { cn } from '../../utils.ts';

	let {
		keys,
		label,
		class: className
	}: {
		/** One or more keys. Multi-key combos pass more than one. */
		keys: string | string[];
		label: string;
		class?: string;
	} = $props();

	const parts = $derived(Array.isArray(keys) ? keys : [keys]);
</script>

<span class={cn('inline-flex items-center gap-1.5 text-caption text-muted-foreground', className)}>
	{#each parts as part, index (part + index)}
		{#if index > 0}
			<span aria-hidden="true">then</span>
		{/if}
		<Kbd class="h-5 min-w-5 justify-center rounded-control px-1 font-mono text-caption">
			{part}
		</Kbd>
	{/each}
	<span>{label}</span>
</span>
