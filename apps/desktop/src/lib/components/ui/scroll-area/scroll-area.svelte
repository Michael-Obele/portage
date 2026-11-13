<script lang="ts">
	import { ScrollArea as ScrollAreaPrimitive } from 'bits-ui';
	import { cn, type WithoutChild } from '#lib/utils.js';
	import Scrollbar from './scroll-area-scrollbar.svelte';

	let {
		ref = $bindable(null),
		viewportRef = $bindable(null),
		class: className,
		orientation = 'vertical',
		scrollbarXClasses = '',
		scrollbarYClasses = '',
		children,
		...restProps
	}: WithoutChild<ScrollAreaPrimitive.RootProps> & {
		orientation?: 'vertical' | 'horizontal' | 'both' | undefined;
		scrollbarXClasses?: string | undefined;
		scrollbarYClasses?: string | undefined;
		viewportRef?: HTMLElement | null;
	} = $props();
</script>

<ScrollAreaPrimitive.Root
	bind:ref
	data-slot="scroll-area"
	class={cn('relative', className)}
	{...restProps}
>
	<!-- `max-h-[inherit]` is load-bearing. A caller that caps this box with
	     `max-h-[62dvh]` leaves the root's height indefinite, so the viewport's
	     `height: 100%` resolves to auto and the content spills out clipped but
	     unscrollable. Inheriting the cap clamps the viewport itself, which is
	     what makes the scrollbar and a sticky header inside it work. -->
	<!-- `overscroll-contain` is load-bearing too. Without it, a wheel that
	     reaches the end of this box scroll-chains into the page behind it, so
	     the document lurches just as the list runs out — a nested scroll area
	     that reads as a bug in the table.

	     `relative` is the less obvious half. Absolutely positioned descendants
	     (every `sr-only` full path in a table row) resolve against their nearest
	     POSITIONED ancestor. Leave this static and that ancestor is the scroll
	     box above the viewport, so the hidden text is clipped by a box that does
	     not move with the scroll, lands at the content's real height, and the
	     page behind grows a phantom scrollbar. Measured: a 15-row plan table made
	     `main` scroll 130 px with nothing to scroll to. -->
	<ScrollAreaPrimitive.Viewport
		bind:ref={viewportRef}
		data-slot="scroll-area-viewport"
		class="relative size-full max-h-[inherit] overscroll-contain rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
	>
		{@render children?.()}
	</ScrollAreaPrimitive.Viewport>
	{#if orientation === 'vertical' || orientation === 'both'}
		<Scrollbar orientation="vertical" class={scrollbarYClasses} />
	{/if}
	{#if orientation === 'horizontal' || orientation === 'both'}
		<Scrollbar orientation="horizontal" class={scrollbarXClasses} />
	{/if}
	<ScrollAreaPrimitive.Corner />
</ScrollAreaPrimitive.Root>
