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

	import ConfirmSheet from '../../lib/components/app/confirm-sheet.svelte';
	import DupesGroups from '../../lib/components/app/dupes-groups.svelte';
	import {
		applySummary,
		clearKeys,
		confirmFacts,
		groupTotals,
		groupUnparsed,
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
	import { ToggleGroup, ToggleGroupItem } from '../../lib/components/ui/toggle-group/index.js';
	import type { DupesFrame, NeedsConfirmFrame } from '../../lib/engine/protocol.ts';
	import { app } from '../../lib/state/app.svelte.ts';
	import { screens } from '../../lib/state/screens.svelte.ts';
	import { isInsideMount } from '../../lib/util/mount.ts';
	import { formatBytes, plural, truncateFront } from '../../lib/util/format.ts';

	/**
	 * The report, the selection and the scan scope live in a module store (see
	 * `lib/state/screens.svelte.ts`). A duplicate scan is minutes of work, and a
	 * tab click used to throw it away — worse, a scan that FINISHED while another
	 * tab was open produced a frame with no observer, so the report was lost even
	 * though the engine had it.
	 *
	 * Reads are aliases; writes go through `screen.`.
	 */
	const screen = screens.dupes;
	const scan = $derived(screen.scan);
	/** Selected keys — never paths. Replaced, not mutated, so the UI reacts. */
	const selection = $derived(screen.selection);
	const scanning = $derived(screen.scanning);
	const applying = $derived(screen.applying);
	const failure = $derived(screen.failure);
	/** A failed apply leaves the selection attached to nothing live. */
	const staleSelection = $derived(screen.staleSelection);
	/** The engine's `needsConfirm` frame for THIS screen's action. */
	const pendingConfirm = $derived(screen.pendingConfirm);
	const sheetOpen = $derived(screen.sheetOpen);

	const groups = $derived(scan?.groups ?? []);
	const totals = $derived(groupTotals(selection, groups));
	const facts = $derived(
		pendingConfirm === null ? null : confirmFacts(pendingConfirm, groups, selection)
	);

	/**
	 * What a scan covers.
	 *
	 * `configured` is the engine's own roots: `config.roots` plus the
	 * destination. `drive` is the mount that holds the destination, because the
	 * archive IS a drive — someone tidying 2 TB means the whole thing, and the
	 * configured roots are usually one folder on it.
	 */
	const scope = $derived(screen.scope);

	/** The longest mount that contains the destination, or `null`. */
	const driveMount = $derived.by((): string | null => {
		const dest = app.config?.dest_root.trim() ?? '';
		if (dest === '') return null;
		let best: string | null = null;
		for (const volume of app.volumes) {
			// NEVER the root filesystem. When the archive drive is unplugged the
			// destination path still sits under `/`, so the longest-containing
			// mount becomes `/` and a "whole drive" scan would walk the entire
			// system disk. That is not what anyone means by the archive drive.
			if (volume.mountPoint === '/') continue;
			if (!isInsideMount(dest, volume.mountPoint)) continue;
			if (best === null || volume.mountPoint.length > best.length) best = volume.mountPoint;
		}
		return best;
	});

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
		// The stat strip below already carries files, bytes, groups and the
		// reclaimable total. Repeating those four numbers in a sentence 100 px
		// above the strip made the screen look generated, and gave a reader two
		// places to check for one fact.
		if (current !== null) return '';
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
		return current.truncated.map((path) => ({
			path,
			note: 'truncated — far smaller than its siblings'
		}));
	});

	/**
	 * A cold launch starts with no volumes, and the engine emits none at startup —
	 * so a persisted "Whole drive" scope would show a selected-but-disabled chip
	 * and refuse every scan. Ask once, the same way Home and Plan do.
	 */
	let asked = $state(false);
	$effect(() => {
		if (asked) return;
		if (app.connection !== 'connected' && app.connection !== 'mock') return;
		asked = true;
		if (app.config === null) void app.loadConfig().catch(() => {});
		void app.loadVolumes().catch(() => {});
	});

	/**
	 * The unreadable names, grouped by why.
	 *
	 * On a real archive this list is long and has few distinct causes, so the
	 * screen shows causes with counts, not one row per file. A wall of six
	 * thousand lines teaches nobody anything.
	 */
	const unparsedGroups = $derived(scan === null ? [] : groupUnparsed(scan.unparsed));

	/**
	 * A whole-drive scan whose mount is not known yet.
	 *
	 * The button is disabled rather than allowed to fail: the guard inside
	 * `scanNow` is the safety net, and this is the same rule stated early enough
	 * that nobody has to read an error to learn it.
	 */
	const driveUnknown = $derived(scope === 'drive' && driveMount === null);

	async function scanNow(): Promise<void> {
		if (busy) return;
		screen.scanning = true;
		screen.failure = null;
		screen.staleSelection = false;
		try {
			// `{}` means "the engine's own roots"; the report arrives as a frame.
			if (scope === 'drive' && driveMount === null) {
				// Refuse, rather than scan the configured roots while the toggle
				// says "Whole drive". Reached when the archive drive is unplugged,
				// or when a deep link lands before the volume list is loaded.
				screen.failure = {
					what: 'The archive drive is not mounted.',
					means:
						'A whole-drive scan needs the mount that holds the destination, and the system disk is never scanned in its place.',
					todo: 'Plug the drive in and read drives on Home, or switch the scope to the configured folders.',
					code: null
				};
				return;
			}
			const roots = scope === 'drive' && driveMount !== null ? [driveMount] : undefined;
			await app.port.send('dupes.scan', roots === undefined ? {} : { roots });
		} catch (error) {
			screen.failure = failureBand(error, 'dupes');
		} finally {
			screen.scanning = false;
		}
	}

	/**
	 * The first `dupes.apply`: no `confirm`, so the engine answers with the
	 * `needsConfirm` frame, which is what opens the sheet.
	 */
	async function requestMove(): Promise<void> {
		const current = scan;
		if (current === null || moveDisabled) return;
		screen.applying = true;
		screen.failure = null;
		screen.pendingConfirm = null;
		try {
			await app.port.send('dupes.apply', {
				scanId: current.scanId,
				keys: [...selection]
			});
		} catch (error) {
			screen.failure = failureBand(error, 'dupes');
			screen.staleSelection = true;
		} finally {
			screen.applying = false;
		}
	}

	/** The confirmation: the typed word is the sheet's business, the id is ours. */
	async function confirmMove(): Promise<void> {
		const current = scan;
		if (current === null || applying) return;
		screen.applying = true;
		screen.failure = null;
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
			screen.sheetOpen = false;
			screen.pendingConfirm = null;
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
				screen.failure = {
					what: `${plural(outcome.refused, 'file')} were refused and stayed where they were.`,
					means: `${plural(outcome.moved, 'file')} moved to the trash. The engine will not move a file it cannot vouch for, so the refused copies are untouched.`,
					todo: 'Check the group above before moving anything else. A refused copy is a reason to look, never a reason to retry.',
					code: null
				};
			}
		} catch (error) {
			screen.sheetOpen = false;
			screen.pendingConfirm = null;
			screen.failure = failureBand(error, 'dupes');
			screen.staleSelection = true;
		} finally {
			screen.applying = false;
		}
	}
</script>

<PageHeader title="Duplicates" {summary}>
	{#snippet actions()}
		<div class="flex flex-wrap items-center gap-2">
			<ToggleGroup
				type="single"
				value={scope}
				spacing={0}
				aria-label="What to scan"
				class="h-8 gap-0 rounded-control bg-muted p-0.5"
				disabled={busy}
				onValueChange={(value) => {
					// bits-ui emits '' when the active item is clicked again. That is
					// not "switch to configured" — it is "nothing selected", and a
					// silent scope change would throw the report away.
					if (value === '') return;
					// The method clears the report, the selection and the stale flag,
					// AND remembers the choice — this handler used to do the clearing
					// inline and never persist, so the toggle reset on every restart.
					screen.setScope(value === 'drive' ? 'drive' : 'configured');
				}}
			>
				<ToggleGroupItem
					value="configured"
					class="h-7 min-w-0 rounded-[calc(var(--radius-control)-2px)] px-2 text-label tracking-normal normal-case data-[state=on]:bg-card data-[state=on]:text-foreground"
					title="The folders this config already scans"
				>
					Configured folders
				</ToggleGroupItem>
				<ToggleGroupItem
					value="drive"
					class="h-7 min-w-0 rounded-[calc(var(--radius-control)-2px)] px-2 text-label tracking-normal normal-case data-[state=on]:bg-card data-[state=on]:text-foreground"
					title={driveMount === null ? 'No drive is mounted' : `Everything on ${driveMount}`}
					disabled={driveMount === null}
				>
					Whole drive
				</ToggleGroupItem>
			</ToggleGroup>
			<Button
				class={CONTROL}
				size="sm"
				disabled={busy || driveUnknown}
				title={driveUnknown ? 'Reading the drives first — a whole-drive scan needs to know the mount' : ''}
				onclick={() => void scanNow()}
			>
				{scan === null ? 'Scan for duplicates' : 'Scan again'}
			</Button>
		</div>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4 px-6 pb-8">
	<StatStrip items={stats} />

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
			ontoggle={(key) => (screen.selection = toggle(selection, key))}
			onselectgroup={(keys) => (screen.selection = selectKeys(selection, keys))}
			oncleargroup={(keys) => (screen.selection = clearKeys(selection, keys))}
		/>
	{/if}

	{#if caveats.length > 0 || unparsedGroups.length > 0}
		<section class="flex flex-col gap-3">
			<h2 class="text-lead font-medium text-foreground">Not compared</h2>
			<p class="measure text-body text-muted-foreground">
				Nothing here is in a group, so nothing here can move — except a file already flagged
				truncated, which may sit in a group above with a copy of itself. A duplicate could still be
				hiding among these.
			</p>

			{#if caveats.length > 0}
				<ul class="divide-y divide-border rounded-surface border border-border">
					{#each caveats as entry (`${entry.note}:${entry.path}`)}
						<li class="flex items-center gap-3 px-3 py-2">
							<span
								class="min-w-0 font-mono text-label break-all text-foreground"
								title={entry.path}
							>
								{truncateFront(entry.path, 96)}
							</span>
							<span class="ms-auto shrink-0 text-caption text-muted-foreground">{entry.note}</span>
						</li>
					{/each}
				</ul>
			{/if}

			{#if unparsedGroups.length > 0}
				<ul class="divide-y divide-border rounded-surface border border-border">
					{#each unparsedGroups as group (group.reason)}
						<li class="flex flex-col gap-1 px-3 py-2">
							<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
								<span class="font-mono text-label text-foreground tabular-nums" data-numeric>
									{group.count}
								</span>
								<span class="text-body text-foreground">{group.reason}</span>
							</div>
							{#if group.examples.length > 0}
								<details class="text-caption text-muted-foreground">
									<summary class="cursor-pointer">
										{plural(group.examples.length, 'example')}
									</summary>
									<ul class="mt-1 flex flex-col gap-0.5">
										{#each group.examples as example (example)}
											<li class="font-mono break-all" title={example}>
												{truncateFront(example, 96)}
											</li>
										{/each}
									</ul>
								</details>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	{#if scan !== null && scan.groups.length > 0}
		<!-- Sticky for the same reason as Purge: a scan can report dozens of
		     groups, and the move-to-trash action must not be below all of them. -->
		<footer
			class="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-surface border border-border bg-card px-4 py-3 shadow-sm"
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
		bind:open={() => screen.sheetOpen, (next) => (screen.sheetOpen = next)}
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
			screen.sheetOpen = false;
			screen.pendingConfirm = null;
		}}
	/>
{/if}
