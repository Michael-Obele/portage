<script lang="ts">
	/**
	 * Pause and Stop — and the sentence that stops them from being a lie.
	 *
	 * The engine honours both only BETWEEN files: a file already in flight runs
	 * to the end of its copy. A control that implied instant preemption would be
	 * the most convincing lie in the app, so the meaning is written out under the
	 * buttons as well as in each control's own description. A tooltip is not a
	 * label.
	 */
	import type { Snippet } from 'svelte';
	import { cn } from '../../utils.ts';
	import { Button } from '../ui/button/index.js';
	import { CONTROL } from './tokens.ts';

	let {
		paused,
		ended,
		busy,
		/** The engine is gone; Stop must still be reachable. */
		engineDown = false,
		onpause,
		onresume,
		onstop,
		onsummary,
		actions,
		class: className
	}: {
		paused: boolean;
		ended: boolean;
		busy: boolean;
		engineDown?: boolean;
		onpause: () => void;
		onresume: () => void;
		onstop: () => void;
		onsummary: () => void;
		actions?: Snippet;
		class?: string;
	} = $props();

	const PAUSE_HELP = 'Finishes the file in flight, then holds.';
	const STOP_HELP = 'Finishes the file in flight, then stops.';
</script>

<section
	class={cn(
		'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-surface)] border px-4 py-3',
		// A paused run is marked as a whole band, not only on the button: the
		// state belongs to the run.
		paused
			? 'border-[color-mix(in_oklch,var(--state-copying),transparent_55%)] bg-muted'
			: 'border-border bg-card',
		className
	)}
	aria-label="Run controls"
>
	{#if ended}
		<p class="text-body text-foreground">The engine has finished this run.</p>
		<Button class={CONTROL} size="sm" onclick={onsummary}>Review the run summary</Button>
	{:else}
		{#if paused}
			<span class="flex items-center gap-1.5 text-body font-medium text-foreground">
				<!-- Glyph and word, never colour alone. -->
				<span aria-hidden="true">⏸</span> Paused
			</span>
		{/if}
		<Button
			class={CONTROL}
			size="sm"
			variant={paused ? 'default' : 'outline'}
			disabled={busy}
			title={paused ? 'Resume the run' : PAUSE_HELP}
			onclick={paused ? onresume : onpause}
		>
			{paused ? 'Resume' : 'Pause'}
		</Button>
		<Button
			class={CONTROL}
			size="sm"
			variant="destructive"
			disabled={busy}
			title={STOP_HELP}
			onclick={onstop}
		>
			Stop
		</Button>
		<p class="measure text-caption text-muted-foreground">
			Pause: {PAUSE_HELP} Stop: {STOP_HELP} Both are honoured between files, never mid-file — there is
			no instant preemption to offer.
		</p>
	{/if}

	{#if engineDown && !ended}
		<p class="text-label text-state-failed">
			The engine is not running. Stop is still available so the run can be closed out.
		</p>
	{/if}

	{#if actions}
		<div class="ms-auto flex items-center gap-2">{@render actions()}</div>
	{/if}
</section>
