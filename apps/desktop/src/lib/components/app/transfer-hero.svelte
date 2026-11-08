<script lang="ts">
	/**
	 * The run's headline: how far along, how fast, and how long.
	 *
	 * Every number is copied from the frame. Nothing here divides bytes by a
	 * UI clock, and the ETA is `etaWords(overall.etaSeconds)`, which draws `—`
	 * until the engine will vouch for a figure.
	 *
	 * The two rates are deliberately two numbers with two names. "Speed" is not
	 * a word this screen uses: an instant rate and a run average differ by a
	 * factor of two on a bad cable, and collapsing them into one reading is the
	 * mistake that makes a person trust a transfer that is failing.
	 */
	import type { Overall } from '../../engine/protocol.ts';
	import { etaWords, formatBytes, formatDuration, formatRate } from '../../util/format.ts';
	import { cn } from '../../utils.ts';
	import { pct, rates, type ProofCounts } from '../../state/run.ts';
	import ProofStrip from './proof-strip.svelte';

	let {
		overall,
		proof,
		class: className
	}: {
		overall: Overall;
		proof: ProofCounts;
		class?: string;
	} = $props();

	const percent = $derived(pct(overall.bytesDone, overall.bytesTotal));
	const both = $derived(rates(overall));
	const elapsed = $derived(formatDuration(overall.elapsedMs / 1000));

	const readings = $derived([
		{
			key: 'instant',
			label: 'Instant rate',
			value: formatRate(both.instant),
			note: 'measured over the last second'
		},
		{
			key: 'average',
			label: 'Average rate',
			value: formatRate(both.average),
			note: 'measured over the whole run'
		}
	]);
</script>

<section
	class={cn(
		'flex flex-col gap-4 rounded-[var(--radius-surface)] border border-border bg-card px-4 py-4',
		className
	)}
	aria-labelledby="transfer-hero-heading"
>
	<h2 id="transfer-hero-heading" class="sr-only">Run progress</h2>

	<div class="flex flex-wrap items-end gap-x-8 gap-y-3" data-numeric>
		<p class="flex items-baseline gap-2">
			<span class="font-mono text-display-lg text-foreground tabular-nums">{percent}%</span>
			<span class="text-body text-muted-foreground">of the run</span>
		</p>
		<div class="flex flex-col">
			<span class="text-caption text-muted-foreground">Copied</span>
			<span class="font-mono text-lead text-foreground tabular-nums">
				{formatBytes(overall.bytesDone)} of {formatBytes(overall.bytesTotal)}
			</span>
		</div>
		<div class="flex flex-col">
			<span class="text-caption text-muted-foreground">Files</span>
			<span class="font-mono text-lead text-foreground tabular-nums">
				{overall.filesDone} of {overall.filesTotal}
			</span>
		</div>
		<div class="flex flex-col">
			<span class="text-caption text-muted-foreground">Elapsed</span>
			<span class="font-mono text-lead text-foreground tabular-nums">{elapsed}</span>
		</div>
		<div class="flex flex-col">
			<span class="text-caption text-muted-foreground">Remaining</span>
			<span class="font-mono text-lead text-foreground tabular-nums">
				{etaWords(overall.etaSeconds)}
			</span>
		</div>
	</div>

	<!-- The bar repeats the percent above it, so it carries no text of its own. -->
	<div
		role="progressbar"
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={percent}
		aria-valuetext="{percent}% of {formatBytes(overall.bytesTotal)}"
		class="h-2 w-full overflow-hidden rounded-full bg-muted"
	>
		<div class="h-full rounded-full bg-primary" style="width: {percent}%"></div>
	</div>

	<dl class="grid grid-cols-2 gap-4 sm:grid-cols-4" data-numeric>
		{#each readings as reading (reading.key)}
			<div class="flex flex-col">
				<dt class="text-caption text-muted-foreground">{reading.label}</dt>
				<dd class="font-mono text-display text-foreground tabular-nums">{reading.value}</dd>
				<dd class="text-caption text-muted-foreground">{reading.note}</dd>
			</div>
		{/each}
		<div class="flex flex-col">
			<dt class="text-caption text-muted-foreground">Jobs</dt>
			<dd class="font-mono text-display text-foreground tabular-nums">{overall.jobs}</dd>
			<dd class="text-caption text-muted-foreground">files copied at once</dd>
		</div>
		<div class="flex flex-col">
			<dt class="text-caption text-muted-foreground">Failed</dt>
			<dd class="font-mono text-display text-foreground tabular-nums">{overall.failed}</dd>
			<dd class="text-caption text-muted-foreground">
				{overall.skipped === 0 ? 'skipped none' : `skipped ${overall.skipped}`}
			</dd>
		</div>
	</dl>

	<div class="flex flex-col gap-2 border-t border-border pt-3">
		<h3 class="text-label text-muted-foreground">Proof</h3>
		<ProofStrip {proof} total={overall.filesTotal} />
		<p class="measure text-caption text-muted-foreground">
			Written and verified are counted from the run's own rows. Deleted and kept on phone are only
			knowable from the engine's end-of-run summary, so they stay at zero until it arrives.
		</p>
	</div>
</section>
