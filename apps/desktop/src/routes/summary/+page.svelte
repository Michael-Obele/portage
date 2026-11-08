<script lang="ts">
	/**
	 * Run summary — the receipt.
	 *
	 * Every figure is the engine's own `EngineSummary` from the terminal `run`
	 * frame. Nothing here is measured by the UI, because a receipt the UI wrote
	 * for itself would agree with nothing in the journal.
	 *
	 * The one action that looks like a retry is not one, and says so: the engine
	 * has no `retry` command yet, so each failure hands over the exact command
	 * line instead.
	 */
	import { goto } from '$app/navigation';

	import { EmptyState, PageHeader } from '../../lib/components/app/index.ts';
	import SummaryReceipt from '../../lib/components/app/summary-receipt.svelte';
	import {
		nothingMoved,
		proofLine,
		proofSentence,
		receiptFailures,
		receiptHeadline,
		retryDeviceId
	} from '../../lib/components/app/summary-receipt.ts';
	import { app } from '../../lib/state/app.svelte.ts';
	import { run } from '../../lib/state/run.svelte.ts';

	const summary = $derived(run.view.summary);
	/** Null unless exactly one ready device is known — see `retryDeviceId`. */
	const deviceId = $derived(retryDeviceId(app.devices));

	const headerSummary = $derived.by(() => {
		if (summary === null) return 'No run has finished in this session.';
		if (nothingMoved(summary)) {
			return 'Nothing to move, so nothing was copied and nothing was deleted.';
		}
		if (summary.failed > 0) return 'What was proven, and what was not. Failures first.';
		return 'What was proven, and what was not. Nothing failed.';
	});

	async function copy(command: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(command);
			app.pushNotice('info', 'Copied the command. Paste it into a terminal to retry that file.');
		} catch {
			app.pushNotice(
				'warn',
				'The clipboard refused the copy. Select the command text and copy it by hand.'
			);
		}
	}
</script>

<PageHeader title="Run summary" summary={headerSummary} />

<div class="flex flex-col gap-6 px-6 pb-8">
	{#if summary === null}
		<EmptyState
			title="No run to summarise"
			body="This screen is the receipt for a finished run, and none has finished in this session. Build a plan to see what would move, then pull from there."
			action="Build a plan"
			onselect={() => void goto('/plan')}
		/>
	{:else}
		<SummaryReceipt
			headline={receiptHeadline(summary)}
			proof={proofLine(summary)}
			proofSentence={proofSentence(summary)}
			failures={receiptFailures(summary, deviceId)}
			nothingMoved={nothingMoved(summary)}
			oncopy={copy}
			onhome={() => void goto('/')}
			onpurge={() => void goto('/purge')}
		/>
	{/if}
</div>
