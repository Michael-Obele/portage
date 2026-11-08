<script lang="ts">
	/**
	 * The proof strip: the product's claim drawn as one thing.
	 *
	 * Four counters that only ever go up — written · verified · deleted · kept —
	 * on ONE continuous line that fills left to right. Each counter also has a
	 * tick at its own position, so the distance between "verified" and "deleted"
	 * is visible rather than asserted.
	 *
	 * The line's domain is files, and both the fill and the ticks share it: the
	 * fill's leading edge is how far the run has reached, and the four labels
	 * are where each state currently stands.
	 */
	import type { ProofCounts } from '../../state/run.ts';
	import { cn } from '../../utils.ts';

	let {
		proof,
		/** Files in this run, from the frame. Never a number this component made up. */
		total,
		class: className,
	}: {
		proof: ProofCounts;
		total: number;
		class?: string;
	} = $props();

	const counters = $derived([
		{ key: 'written', word: 'written', value: proof.written },
		{ key: 'verified', word: 'verified', value: proof.verified },
		{ key: 'deleted', word: 'deleted', value: proof.deleted },
		{ key: 'kept', word: 'kept on phone', value: proof.kept },
	]);

	const denominator = $derived(Math.max(1, total, proof.written, proof.verified));
	const reached = $derived(
		Math.max(proof.written, proof.verified, proof.deleted, proof.kept)
	);

	function fraction(value: number): number {
		return Math.max(0, Math.min(1, value / denominator));
	}

	const summary = $derived(
		`${proof.written} written, ${proof.verified} verified, ` +
			`${proof.deleted} deleted from the phone, ${proof.kept} kept on the phone, ` +
			`of ${total} files.`
	);
</script>

<figure class={cn('flex w-full flex-col gap-2', className)}>
	<!-- The drawing repeats the numbers below it, so it is hidden from a screen
	     reader rather than read out twice. -->
	<div class="relative h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
		<div
			data-proof-fill
			class="h-full rounded-full bg-foreground"
			style="width: {fraction(reached) * 100}%; transition: width var(--motion-base) var(--ease-out-expo);"
		></div>
	</div>
	<div class="relative h-2 w-full" aria-hidden="true">
		{#each counters as counter (counter.key)}
			<span
				class="absolute top-0 h-2 w-px bg-border"
				style="left: {fraction(counter.value) * 100}%; transition: left var(--motion-base) var(--ease-out-expo);"
			></span>
		{/each}
	</div>

	<dl class="grid grid-cols-4 gap-3" data-numeric>
		{#each counters as counter (counter.key)}
			<div class="flex min-w-0 flex-col">
				<dt class="truncate text-caption text-muted-foreground">{counter.word}</dt>
				<dd class="font-mono text-lead tabular-nums text-foreground">{counter.value}</dd>
			</div>
		{/each}
	</dl>

	<figcaption class="sr-only">{summary}</figcaption>
</figure>
