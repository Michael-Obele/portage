<script lang="ts">
	/**
	 * The receipt.
	 *
	 * The headline is the engine's own `EngineSummary` — its files, its bytes,
	 * its duration, its rate. Not the UI's clock: a summary that measured itself
	 * would agree with no journal.
	 *
	 * The retry is honest about what it is. `portage retry` is not built (G7), so
	 * there is nothing in this app to press that would retry anything. Instead
	 * each failure carries the exact command line to run, with a copy button —
	 * labelled as a copy, because that is what it does.
	 */
	import { plural } from '../../util/format.ts';
	import { cn } from '../../utils.ts';
	import { Button } from '../ui/button/index.js';
	import DataTable, { type TableColumn } from './data-table.svelte';
	import { CONTROL, IDENTIFIER, ROW_NAME } from './tokens.ts';
	import type { ReceiptFailure, ReceiptHeadline, ProofLine } from './summary-receipt.ts';

	let {
		headline,
		proof,
		proofSentence,
		failures,
		nothingMoved,
		oncopy,
		onhome,
		onpurge,
		class: className
	}: {
		headline: ReceiptHeadline;
		proof: ProofLine;
		proofSentence: string;
		failures: ReceiptFailure[];
		nothingMoved: boolean;
		oncopy: (command: string) => void;
		onhome: () => void;
		onpurge: () => void;
		class?: string;
	} = $props();

	const COUNTERS = [
		{ key: 'verified', label: 'Verified' },
		{ key: 'deleted', label: 'Deleted from phone' },
		{ key: 'kept', label: 'Kept on phone' },
		{ key: 'failed', label: 'Failed' },
		{ key: 'skipped', label: 'Skipped' }
	] as const;

	const FAILURE_COLUMNS: TableColumn[] = [
		{ key: 'name', label: 'File' },
		{ key: 'why', label: 'Why' },
		{ key: 'retry', label: 'Retry from the CLI' }
	];

	function countFor(key: (typeof COUNTERS)[number]['key']): number {
		return proof[key];
	}
</script>

<div class={cn('flex flex-col gap-6', className)}>
	<section class="flex flex-col gap-2" aria-labelledby="receipt-headline">
		<h2 id="receipt-headline" class="sr-only">Run summary</h2>
		<p class="text-display font-medium text-foreground" data-numeric>{headline.sentence}</p>
		{#if nothingMoved}
			<p class="measure text-body text-muted-foreground">
				Nothing to move. The plan named no files, so nothing was copied, verified or deleted.
			</p>
		{/if}
	</section>

	<section class="flex flex-col gap-2" aria-labelledby="receipt-proof">
		<h3 id="receipt-proof" class="text-label text-muted-foreground">Proof</h3>
		<dl class="grid grid-cols-2 gap-4 sm:grid-cols-5" data-numeric>
			{#each COUNTERS as counter (counter.key)}
				<div class="flex flex-col">
					<dt class="text-caption text-muted-foreground">{counter.label}</dt>
					<dd class="font-mono text-display text-foreground tabular-nums">
						{countFor(counter.key)}
					</dd>
				</div>
			{/each}
		</dl>
		<p class="measure text-body text-muted-foreground">{proofSentence}</p>
	</section>

	<!-- No failures: no failures block at all. An empty heading is a thing a
	     person has to check before they can be relieved. -->
	{#if failures.length > 0}
		<section class="flex flex-col gap-2" aria-labelledby="receipt-failures">
			<h3 id="receipt-failures" class="text-label text-muted-foreground">Failures, first</h3>
			<p class="measure text-body text-muted-foreground">
				{plural(failures.length, 'file')} did not make it. The phone copy is untouched for each of them,
				so running the command again is safe.
			</p>
			<DataTable
				columns={FAILURE_COLUMNS}
				rows={failures}
				rowKey={(failure) => failure.key}
				caption={`Failed files, ${failures.length}`}
			>
				{#snippet row(item)}
					<td role="gridcell" class="px-3">
						<span class="flex min-w-0 flex-col">
							<span class={ROW_NAME} title={item.srcPath}>{item.name}</span>
							<span class={cn(IDENTIFIER, 'truncate text-muted-foreground')}>{item.srcPath}</span>
						</span>
					</td>
					<td role="gridcell" class="px-3">
						<span class="block text-body text-foreground">
							{item.reason === '' ? 'The engine did not give a reason.' : item.reason}
						</span>
					</td>
					<td role="gridcell" class="px-3">
						<div class="flex items-center gap-2">
							<code class="truncate font-mono text-label text-foreground" title={item.command}>
								{item.command}
							</code>
							<Button
								class={CONTROL}
								size="sm"
								variant="outline"
								onclick={() => oncopy(item.command)}
							>
								Copy command
							</Button>
						</div>
					</td>
				{/snippet}
			</DataTable>
			<p class="measure text-caption text-muted-foreground">
				There is no retry button here on purpose: the engine has no <span class="font-mono"
					>retry</span
				>
				command yet, so this copies the exact command line to run instead. A
				<span class="font-mono">&lt;id&gt;</span> means the engine had not listed exactly one ready device,
				so no device could be named for you.
			</p>
		</section>
	{/if}

	<section class="flex flex-wrap items-center gap-2">
		<Button class={CONTROL} size="sm" variant="outline" onclick={onhome}>Back to Home</Button>
		<Button class={CONTROL} size="sm" variant="outline" onclick={onpurge}>
			Review what is still on the phone
		</Button>
	</section>

	{#if failures.length > 0}
		<p class="measure text-caption text-muted-foreground">
			Every failure above is counted in the headline: it reads
			<span class="font-mono">{headline.files}</span>, and the shortfall is
			{plural(failures.length, 'file')}.
		</p>
	{/if}
</div>
