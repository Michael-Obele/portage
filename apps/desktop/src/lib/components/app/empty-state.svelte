<script lang="ts">
	/**
	 * Nothing here yet — and one way forward.
	 *
	 * Built on shadcn's `Empty`, not on a bespoke div. The registry component
	 * already owns what an empty state is: it grows into the pane, centres its
	 * block, and keeps the copy at a readable measure. Re-implementing that by
	 * hand is how every screen grew its own slightly different void.
	 *
	 * Two deliberate overrides:
	 *
	 *  - LEFT-ALIGNED copy. `sera` centres and uppercases the title; this app's
	 *    headings are sentence case and flush left on every other surface, so an
	 *    empty state centred and shouting would be the one screen that disagrees.
	 *  - `role="heading" aria-level={2}`. `EmptyTitle` renders a `<div>`, which
	 *    would drop the state out of the page outline a screen reader walks.
	 *
	 * `action` is a label phrased as the OUTCOME ("Find your drive and phone"),
	 * because a state has nothing to be done *to* it, only something to be done
	 * about it. One action: two competing buttons mean the screen has none.
	 */
	import { Button } from '../ui/button/index.js';
	import {
		Empty,
		EmptyContent,
		EmptyDescription,
		EmptyHeader,
		EmptyTitle
	} from '../ui/empty/index.js';
	import { CONTROL } from './tokens.ts';
	import { cn } from '../../utils.ts';

	let {
		title,
		body,
		action,
		onselect,
		busy = false,
		class: className
	}: {
		title: string;
		body: string;
		action?: string;
		onselect?: () => void;
		busy?: boolean;
		class?: string;
	} = $props();
</script>

<!-- `items-start text-left` on the ROOT, not just the header: `Empty` centres
	     its children as blocks, so overriding only the header leaves the whole
	     block floating in the middle of a left-aligned page. -->
<Empty class={cn('items-start p-0 py-12 text-left', className)}>
	<EmptyHeader class="max-w-[var(--measure)] items-start">
		<EmptyTitle
			role="heading"
			aria-level={2}
			class="text-lead font-medium tracking-normal text-foreground normal-case"
		>
			{title}
		</EmptyTitle>
		<EmptyDescription class="text-body text-muted-foreground">{body}</EmptyDescription>
	</EmptyHeader>

	{#if action && onselect}
		<EmptyContent class="items-start">
			<Button class={CONTROL} size="sm" disabled={busy} onclick={onselect}>{action}</Button>
		</EmptyContent>
	{:else if action}
		<EmptyDescription class="text-body text-muted-foreground">{action}</EmptyDescription>
	{/if}
</Empty>
