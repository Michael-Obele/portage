<script lang="ts">
	/**
	 * The top of every screen: a title, one line of summary, and the screen's
	 * actions. One action per screen carries the accent, and that decision
	 * belongs to the screen — not here.
	 */
	import type { Snippet } from 'svelte';
	import { cn } from '../../utils.ts';

	let {
		title,
		summary,
		actions,
		class: className
	}: {
		title: string;
		summary?: string;
		actions?: Snippet;
		class?: string;
	} = $props();
</script>

<header class={cn('flex items-start justify-between gap-4 px-6 pt-5 pb-4', className)}>
	<div class="flex min-w-0 flex-col gap-1">
		<h1 class="truncate text-title font-medium text-foreground">{title}</h1>
		{#if summary}
			<p class="text-body text-muted-foreground">{summary}</p>
		{/if}
	</div>
	{#if actions}
		<div class="flex shrink-0 items-center gap-2">
			{@render actions()}
		</div>
	{/if}
</header>
