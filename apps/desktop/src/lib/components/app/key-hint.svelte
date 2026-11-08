<script lang="ts">
	/**
	 * A key hint: the keycap and what it does.
	 *
	 * `<kbd>` is the correct element, so a screen reader says "kbd" rather than
	 * reading a stray letter, and the hints line at the bottom of a screen is a
	 * list a person can skim.
	 */
	import { cn } from '../../utils.ts';

	let {
		keys,
		label,
		class: className,
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
		<kbd
			class="inline-flex h-5 min-w-5 items-center justify-center rounded-[var(--radius-control)] border border-border bg-muted px-1 font-mono text-caption text-foreground"
		>
			{part}
		</kbd>
	{/each}
	<span>{label}</span>
</span>
