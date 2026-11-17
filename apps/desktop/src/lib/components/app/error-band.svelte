<script lang="ts">
	/**
	 * Every error says three things: what happened, what it means, what to do
	 * now. A band that says only the first is a dead end, so the three are
	 * required props — there is no one-line variant to reach for by accident.
	 *
	 * Built on shadcn's `Alert`, which already owns the `role="alert"`, the
	 * accent bar, the icon column and the destructive palette. The three slots
	 * are this app's, because a generic alert has no idea that an engine failure
	 * needs a fix sentence and a retry.
	 */
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';

	import { Alert, AlertDescription, AlertTitle } from '#lib/components/ui/alert/index.js';
	import { cn } from '#lib/utils.ts';

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

<Alert
	variant="destructive"
	class={cn('rounded-surface border-border bg-card px-4 py-3', className)}
>
	<TriangleAlert class="mt-0.5 size-4 shrink-0 text-state-failed" aria-hidden="true" />

	<div class="flex min-w-0 flex-col gap-1">
		<AlertTitle class="text-body font-medium tracking-normal text-foreground normal-case">
			{what}
		</AlertTitle>
		<AlertDescription class="measure text-body text-muted-foreground">{means}</AlertDescription>
		<p class="measure text-body text-foreground">{todo}</p>
		{#if code !== undefined && code !== null && code !== 0}
			<p class="font-mono text-caption text-muted-foreground">engine code {code}</p>
		{/if}
		{#if actions}
			<div class="mt-1 flex items-center gap-2">{@render actions()}</div>
		{/if}
	</div>
</Alert>
