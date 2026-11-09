<script lang="ts">
	/**
	 * Duplicates — where the wasted space is, and exactly which copies move.
	 *
	 * The engine does the deciding and hands the screen opaque keys (`k0..kN`),
	 * one per member. A path is never sent back: `dupes.apply` takes keys, and an
	 * unknown key refuses the WHOLE call rather than moving part of a selection
	 * nobody reviewed.
	 *
	 * Where the data comes from matters on this screen:
	 *
	 *  - The report is the `dupes` FRAME. `dupes.scan`'s answer is a tally
	 *    (`{scanId, groups, keys, reclaimableBytes, trashDir}`), so the groups,
	 *    the counts and the caveats are all read from the frame.
	 *  - The confirmation is the `needsConfirm` FRAME, written before its answer,
	 *    and it carries the engine's own path list and trash directory. The
	 *    follow-up call sends `confirm: scanId` — the sheet collects the typed
	 *    word, the engine compares its own pending id.
	 *
	 * Nothing here auto-scans: a scan walks every configured root and can take
	 * minutes, so it happens when the person asks for it.
	 */
	import { onMount } from 'svelte';

	import ConfirmSheet from '../../lib/components/app/confirm-sheet.svelte';
	import DupesGroups from '../../lib/components/app/dupes-groups.svelte';
	import {
		applySummary,
		clearKeys,
		confirmFacts,
		groupTotals,
		scanSentence,
		selectKeys,
		selectionFor,
		toggle
	} from '../../lib/components/app/dupes-view.ts';
	import {
		EmptyState,
		ErrorBand,
		PageHeader,
		SkeletonRows
	} from '../../lib/components/app/index.ts';
	import StatStrip from '../../lib/components/app/stat-strip.svelte';
	import { CONTROL } from '../../lib/components/app/tokens.ts';
	import { failureBand, type Band } from '../../lib/components/app/transfer-band.ts';
	import { Button } from '../../lib/components/ui/button/index.js';
	import type { DupesFrame, NeedsConfirmFrame } from '../../lib/engine/protocol.ts';
	import { app } from '../../lib/state/app.svelte.ts';
	import { formatBytes, plural, truncateFront } from '../../lib/util/format.ts';

	/** The last report. Every number on the screen comes from this frame. */
	let scan = $state<DupesFrame | null>(null);
	/** Selected keys — never paths. Replaced, not mutated, so the UI reacts. */
	let selection = $state<Set<string>>(new Set());
	let scanning = $state(false);
	let applying = $state(false);
	let failure = $state<Band | null>(null);
	/** A failed apply leaves the selection attached to nothing live. */
	let staleSelection = $state(false);
	/** The engine's `needsConfirm` frame for THIS screen's action. */
	let pendingConfirm = $state<NeedsConfirmFrame | null>(null);
	let sheetOpen = $state(false);

	const groups = $derived(scan?.groups ?? []);
	const totals = $derived(groupTotals(selection, groups));
	const facts = $derived(
		pendingConfirm === null ? null : confirmFacts(pendingConfirm, groups, selection)
	);

	/**
	 * A dead engine is a condition of the world, not an event to copy into state:
	 * deriving it means a skeleton can never keep shimmering over an engine that
	 * has already exited, and no effect has to write anything.
	 */
	const engineStopped = $derived(app.connection === 'stopped');
	const busy = $derived(scanning && !engineStopped);

	// Only when this screen has something the shell's banner does not say: a scan
	// that died mid-walk, or a report that can no longer be acted on.
	const stoppedBand = $derived<Band | null>(
		engineStopped && (scanning || scan !== null)
			? {
					what: scanning
						? 'The engine stopped while the scan was running.'
						: 'The engine is not running, so this report cannot be acted on.',
					means: scanning
						? 'The report was never finished, so nothing on this screen is a count of anything.'
						: 'A scan belongs to the engine process that made it, so restarting the engine is what makes a new one possible.',
					todo: 'Start the engine again, then scan.',
					code: null
				}
			: null
	);

	/** What the band shows: a dead engine outranks a stale failure sentence. */
	const band = $derived(stoppedBand ?? failure);

	const summary = $derived.by(() => {
		const current = scan;
		if (scanning) {
			return current === null
				? 'Comparing the scan roots. Nothing moves until you pick it.'
				: 'Comparing the scan roots again; the groups below are the previous report.';
		}
		if (current !== null) return scanSentence(current);
		return 'Compares the roots this config scans for files that are byte-identical, then for the same episode in two releases. Nothing moves until you pick it.';
	});

	const stats = $derived.by(() => {
		const current = scan;
		if (current === null) return [];
		return [
			{
				label: 'Groups',
				value: plural(current.groups.length, 'group'),
				hint: `${plural(current.tier1Count, 'byte-identical group')} · ${plural(current.tier2Count, 'same-episode group')}`
			},
			{ label: 'Reclaimable', value: formatBytes(current.reclaimableBytes) },
			{ label: 'Files scanned', value: plural(current.scannedFiles, 'file') },
			{
				label: 'Bytes scanned',
				value: formatBytes(current.scannedBytes),
				tone: 'muted' as const
			}
		];
	});

	const moveDisabled = $derived(
		scan === null || busy || applying || staleSelection || engineStopped || totals.count === 0
	);

	const caveats = $derived.by(() => {
		const current = scan;
		if (current === null) return [];
		return [
			...current.truncated.map((path) => ({
				path,
				note: 'truncated — far smaller than its siblings'
			})),
			...current.unparsed.map((path) => ({ path, note: 'could not be parsed' }))
		];
	});

	async function scanNow(): Promise<void> {
		if (busy) return;
		scanning = true;
		failure = null;
		staleSelection = false;
		try {
			// `{}` means "the engine's own roots"; the report arrives as a frame.
			await app.port.send('dupes.scan', {});
		} catch (error) {
			failure = failureBand(error, 'dupes');
		} finally {
			scanning = false;
		}
	}

	/**
	 * The first `dupes.apply`: no `confirm`, so the engine answers with the
	 * `needsConfirm` frame, which is what opens the sheet.
	 */
	async function requestMove(): Promise<void> {
		const current = scan;
		if (current === null || moveDisabled) return;
		applying = true;
		failure = null;
		pendingConfirm = null;
		try {
			await app.port.send('dupes.apply', {
				scanId: current.scanId,
				keys: [...selection]
			});
		} catch (error) {
			failure = failureBand(error, 'dupes');
			staleSelection = true;
		} finally {
			applying = false;
		}
	}

	/** The confirmation: the typed word is the sheet's business, the id is ours. */
	async function confirmMove(): Promise<void> {
		const current = scan;
		if (current === null || applying) return;
		applying = true;
		failure = null;
		try {
			const answer = await app.port.send('dupes.apply', {
				scanId: current.scanId,
				keys: [...selection],
				confirm: current.scanId
			});
			const outcome = applySummary(answer);
			// `null` means the engine asked again: the sheet stays open with the
			// facts its own frame just refreshed.
			if (outcome === null) return;
			sheetOpen = false;
			pendingConfirm = null;
			// A report whose files have just moved is out of date, so re-scan
			// before anything else is offered.
			await scanNow();
			app.pushNotice(
				outcome.refused > 0 ? 'warn' : 'info',
				outcome.refused > 0
					? `Moved ${plural(outcome.moved, 'file')}; ${plural(outcome.refused, 'file')} were refused.`
					: `Moved ${plural(outcome.moved, 'file')} · ${formatBytes(outcome.bytesMoved)} to the trash.`
			);
			if (outcome.refused > 0 && failure === null) {
				failure = {
					what: `${plural(outcome.refused, 'file')} were refused and stayed where they were.`,
					means: `${plural(outcome.moved, 'file')} moved to the trash. The engine will not move a file it cannot vouch for, so the refused copies are untouched.`,
					todo: 'Check the group above before moving anything else. A refused copy is a reason to look, never a reason to retry.',
					code: null
				};
			}
		} catch (error) {
			sheetOpen = false;
			pendingConfirm = null;
			failure = failureBand(error, 'dupes');
			staleSelection = true;
		} finally {
			applying = false;
		}
	}

	onMount(() =>
		app.observeFrame((frame) => {
			if (frame.type === 'dupes') {
				// The frame, not the answer: this is the report.
				scan = frame;
				selection = selectionFor(frame.groups);
				staleSelection = false;
				return;
			}
			if (frame.type === 'needsConfirm' && frame.action === 'dupes.apply') {
				pendingConfirm = frame;
				sheetOpen = true;
			}
		})
	);
</script>

<PageHeader title="Duplicates" {summary}>
	{#snippet actions()}
		<Button class={CONTROL} size="sm" disabled={busy} onclick={() => void scanNow()}>
			{scan === null ? 'Scan for duplicates' : 'Scan again'}
		</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4 px-6 pb-8">
	<StatStrip items={stats} class="px-2" />

	{#if band}
		<ErrorBand what={band.what} means={band.means} todo={band.todo} code={band.code}>
			{#snippet actions()}
				<Button
					class={CONTROL}
					size="sm"
					variant="outline"
					disabled={busy}
					onclick={() => void scanNow()}
				>
					Scan again
				</Button>
			{/snippet}
		</ErrorBand>
	{/if}

	{#if scanning && scan === null}
		<SkeletonRows rows={8} label="Scanning for duplicates" />
	{:else if scan === null}
		{#if !band}
			<EmptyState
				title="No scan yet"
				body="Use Scan for duplicates above. It reads the configured roots and reports byte-identical files, then the same episode in two releases; nothing is moved until you select a copy and confirm it."
			/>
		{/if}
	{:else if scan.groups.length === 0}
		<EmptyState title="No duplicates found" body={`Nothing repeats. ${scanSentence(scan)}`} />
	{:else}
		<DupesGroups
			{groups}
			{selection}
			ontoggle={(key) => (selection = toggle(selection, key))}
			onselectgroup={(keys) => (selection = selectKeys(selection, keys))}
			oncleargroup={(keys) => (selection = clearKeys(selection, keys))}
		/>
	{/if}

	{#if caveats.length > 0}
		<section class="flex flex-col gap-2">
			<h2 class="text-lead font-medium text-foreground">Not compared</h2>
			<p class="measure text-body text-muted-foreground">
				These paths were read but never put in a group, so a duplicate could still be hiding among
				them. They are in no selection and nothing here will move them.
			</p>
			<ul class="divide-y divide-border rounded-[var(--radius-surface)] border border-border">
				{#each caveats as entry (`${entry.note}:${entry.path}`)}
					<li class="flex items-center gap-3 px-3 py-2">
						<span class="min-w-0 font-mono text-label break-all text-foreground" title={entry.path}>
							{truncateFront(entry.path, 96)}
						</span>
						<span class="ms-auto shrink-0 text-caption text-muted-foreground">{entry.note}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if scan !== null && scan.groups.length > 0}
		<footer
			class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-surface)] border border-border bg-card px-4 py-3"
		>
			<Button
				class={CONTROL}
				size="sm"
				variant="outline"
				disabled={moveDisabled}
				onclick={() => void requestMove()}
			>
				Move {plural(totals.count, 'file')} to trash · {formatBytes(totals.bytes)}
			</Button>

			<p class="measure text-caption text-muted-foreground">
				{#if staleSelection}
					This selection no longer belongs to a live scan. Scan again before moving anything.
				{:else}
					The sheet names every file and where it goes before anything moves. A keeper is only a
					suggestion — tick it if you disagree.
				{/if}
			</p>

			<p class="sr-only" role="status" aria-live="polite">
				{plural(totals.count, 'file')} selected · {formatBytes(totals.bytes)}
			</p>
		</footer>
	{/if}
</div>

{#if facts}
	<ConfirmSheet
		bind:open={sheetOpen}
		title="Move to the trash"
		action="dupes.apply"
		paths={facts.paths}
		count={facts.count}
		bytes={facts.bytes}
		trashDir={facts.trashDir}
		confirmWord="Move"
		busy={applying}
		onconfirm={() => void confirmMove()}
		oncancel={() => {
			sheetOpen = false;
			pendingConfirm = null;
		}}
	/>
{/if}
