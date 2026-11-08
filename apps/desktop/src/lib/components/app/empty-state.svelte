<script lang="ts">
	/**
	 * Nothing here yet — and one way forward.
	 *
	 * `action` is a label phrased as the OUTCOME ("Find your drive and phone"),
	 * because a state has nothing to be done *to* it, only something to be done
	 * about it. One action: two competing buttons mean the screen has none.
	 */
	import { Button } from '../ui/button/index.js';
	import { CONTROL } from './tokens.ts';
	import { cn } from '../../utils.ts';

	let {
		title,
		body,
		action,
		onselect,
		busy = false,
		class: className,
	}: {
		title: string;
		body: string;
		action?: string;
		onselect?: () => void;
		busy?: boolean;
		class?: string;
	} = $props();
</script>

<div class={cn('flex flex-col items-start gap-3 px-6 py-12', className)}>
	<h2 class="text-lead font-medium text-foreground">{title}</h2>
	<p class="measure text-body text-muted-foreground">{body}</p>
	{#if action && onselect}
		<Button class={CONTROL} size="sm" disabled={busy} onclick={onselect}>{action}</Button>
	{:else if action}
		<p class="text-body text-muted-foreground">{action}</p>
	{/if}
</div>
