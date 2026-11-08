<script lang="ts">
	/**
	 * A row's state, as a glyph AND a word.
	 *
	 * Colour is never the only signal: the glyph and the word carry the meaning,
	 * and the colour repeats it. Delete the palette and the chip still reads.
	 * `verifying` is derived locally (bar at 100 %, no `verified` yet) and is not
	 * an engine state; every other value is the engine's own vocabulary.
	 */
	import Check from '@lucide/svelte/icons/check';
	import Clock from '@lucide/svelte/icons/clock';
	import Copy from '@lucide/svelte/icons/copy';
	import MinusCircle from '@lucide/svelte/icons/minus-circle';
	import Pause from '@lucide/svelte/icons/pause';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import { cn } from '../../utils.ts';

	export type StateChipState =
		| 'queued'
		| 'copying'
		| 'verifying'
		| 'verified'
		| 'deleted'
		| 'kept'
		| 'failed'
		| 'skipped'
		| 'duplicate';

	interface Chip {
		word: string;
		icon: typeof Check;
		tone: 'neutral' | 'copying' | 'verified' | 'failed' | 'skipped';
	}

	const CHIPS: Record<StateChipState, Chip> = {
		queued: { word: 'queued', icon: Clock, tone: 'neutral' },
		copying: { word: 'copying', icon: Copy, tone: 'copying' },
		verifying: { word: 'verifying', icon: ShieldCheck, tone: 'copying' },
		verified: { word: 'verified', icon: Check, tone: 'verified' },
		deleted: { word: 'deleted', icon: Trash2, tone: 'verified' },
		kept: { word: 'kept', icon: Pause, tone: 'neutral' },
		failed: { word: 'failed', icon: X, tone: 'failed' },
		skipped: { word: 'skipped', icon: MinusCircle, tone: 'skipped' },
		duplicate: { word: 'duplicate', icon: Copy, tone: 'skipped' },
	};

	const TONES: Record<Chip['tone'], string> = {
		neutral: 'border-border text-muted-foreground',
		copying: 'border-[color-mix(in_oklch,var(--state-copying),transparent_55%)] text-state-copying',
		verified:
			'border-[color-mix(in_oklch,var(--state-verified),transparent_55%)] text-state-verified',
		failed:
			'border-[color-mix(in_oklch,var(--state-failed),transparent_55%)] text-state-failed',
		skipped:
			'border-[color-mix(in_oklch,var(--state-skipped),transparent_55%)] text-muted-foreground',
	};

	let {
		state,
		class: className,
		/** Draw the chip on its own fill. The kit page uses it; tables do not. */
		solid = false,
	}: {
		state: StateChipState;
		class?: string;
		solid?: boolean;
	} = $props();

	const chip = $derived(CHIPS[state]);
	const solidClasses = $derived(
		solid
			? {
					copying: 'border-transparent bg-state-copying text-state-copying-foreground',
					verified: 'border-transparent bg-state-verified text-state-verified-foreground',
					failed: 'border-transparent bg-state-failed text-state-failed-foreground',
					skipped: 'border-transparent bg-state-skipped text-state-skipped-foreground',
					neutral: 'border-border bg-muted text-muted-foreground',
				}[chip.tone]
			: TONES[chip.tone]
	);
	const Icon = $derived(chip.icon);
</script>

<span
	data-chip={state}
	class={cn(
		'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-px text-label whitespace-nowrap',
		solidClasses,
		className
	)}
>
	<Icon class="size-4 shrink-0" aria-hidden="true" />
	<span>{chip.word}</span>
</span>
