<script lang="ts">
	/**
	 * Every error says three things: what happened, what it means, what to do
	 * now. A band that says only the first is a dead end, so the three are
	 * required props — there is no one-line variant to reach for by accident.
	 */
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';
	import { cn } from '../../utils.ts';

	let {
		what,
		means,
		todo,
		/** The engine's own code, when there is one. Shown small, never alone. */
		code,
		actions,
		class: className
	}: {
		what: string;
		means: string;
		todo: string;
		code?: number | string | null;
		actions?: Snippet;
		class?: string;
	} = $props();
</script>

<div
	role="alert"
	class={cn(
		'flex items-start gap-3 rounded-[var(--radius-surface)] border border-[color-mix(in_oklch,var(--state-failed),transparent_55%)] bg-card px-4 py-3',
		className
	)}
>
	<TriangleAlert class="mt-0.5 size-4 shrink-0 text-state-failed" aria-hidden="true" />
	<div class="flex min-w-0 flex-1 flex-col gap-1">
		<p class="text-body font-medium text-foreground">{what}</p>
		<p class="measure text-body text-muted-foreground">{means}</p>
		<p class="measure text-body text-foreground">{todo}</p>
		{#if code !== undefined && code !== null && code !== 0}
			<p class="font-mono text-caption text-muted-foreground">engine code {code}</p>
		{/if}
		{#if actions}
			<div class="mt-1 flex items-center gap-2">{@render actions()}</div>
		{/if}
	</div>
</div>
