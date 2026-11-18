<script lang="ts">
	/**
	 * Purge — free the phone of the copies the drive already holds.
	 *
	 * The engine decides what is safe: `purge.plan` answers with an eligible
	 * candidate per file it can vouch for and a refused row per file it cannot,
	 * each carrying its reason. This screen never computes a delete set of its
	 * own; it lists the engine's and lets a person narrow it to a set of opaque
	 * keys.
	 *
	 * Where the data comes from:
	 *
	 *  - The plan is the `purgePlan` FRAME. `purge.plan`'s answer is a tally
	 *    (`{planId, eligible, refused, bytesReclaimed}`), so the candidates, the
	 *    refusals and the total are all read from the frame, exactly as Plan
	 *    reads the `plan` frame and Duplicates reads the `dupes` frame.
	 *  - The confirmation is the `needsConfirm` FRAME, written before its answer,
	 *    carrying the engine's own path list. The follow-up call sends
	 *    `confirm: planId`; the sheet collects the typed word, the engine
	 *    compares its own pending id.
	 *
	 * Nothing here auto-plans. A plan walks the journal and may re-read hashes at
	 * both ends, which on a phone means real minutes, so it happens when the
	 * person asks for it.
	 */

	import ConfirmSheet from '#lib/components/app/confirm-sheet.svelte';
	import {
		EmptyState,
		ErrorBand,
		PageHeader,
		SkeletonRows
	} from '#lib/components/app/index.ts';
	import StatStrip from '#lib/components/app/stat-strip.svelte';
	import { CONTROL } from '#lib/components/app/tokens.ts';
	import { failureBand, type Band } from '#lib/components/app/transfer-band.ts';
	import {
		allKeys,
		confirmFacts,
		planSentence,
		proofWord,
		purgeOutcome,
		refusalSentence,
		toggleKey,
		totalsFor
	} from '#lib/components/app/purge-view.ts';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { ToggleGroup, ToggleGroupItem } from '#lib/components/ui/toggle-group/index.js';
	import type { NeedsConfirmFrame, PurgePlanFrame } from '#lib/engine/protocol.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import { screens } from '#lib/state/screens.svelte.ts';
	import { formatBytes, plural, truncateFront } from '#lib/util/format.ts';
	import { createNow } from '#lib/util/now.svelte.ts';
	import { ageOf } from '#lib/util/relative-time.ts';

	/**
	 * The plan lives in a module store (see `lib/state/screens.svelte.ts`), so a
	 * tab click no longer throws away a check that re-read both ends of every
	 * file. Reads are aliases; writes go through `screen.`.
	 *
	 * `plannedAt` is the clock that distinguishes "Check again" from a dead
	 * button, and it belongs with the plan it describes.
	 */
	const screen = screens.purge;
	/** The last plan. Every number on the screen comes from this frame. */
	const plan = $derived(screen.plan);
	const plannedAt = $derived(screen.plannedAt);
	/** Selected keys — never paths. Replaced, not mutated, so the UI reacts. */
	const selection = $derived(screen.selection);
	const planning = $derived(screen.planning);
	const applying = $derived(screen.applying);
	/** Re-read both hashes instead of trusting the journal. Slower, stronger. */
	const reRead = $derived(screen.reRead);
	const failure = $derived(screen.failure);
	/** A failed apply leaves the selection attached to nothing live. */
	const staleSelection = $derived(screen.staleSelection);
	const pendingConfirm = $derived(screen.pendingConfirm);
	const sheetOpen = $derived(screen.sheetOpen);

	const eligible = $derived(plan?.eligible ?? []);
	const totals = $derived(totalsFor(selection, eligible));
	const facts = $derived(
		pendingConfirm === null || plan === null ? null : confirmFacts(pendingConfirm, plan, selection)
	);

	/**
	 * A dead engine is a condition of the world, not an event to copy into state:
	 * deriving it means a skeleton can never keep shimmering over an engine that
	 * has already exited.
	 */
	const engineStopped = $derived(app.connection === 'stopped');
	const busy = $derived(planning && !engineStopped);

	const stoppedBand = $derived<Band | null>(
		engineStopped && (planning || plan !== null)
			? {
					what: planning
						? 'The engine stopped while the plan was being made.'
						: 'The engine is not running, so this plan cannot be acted on.',
					means: planning
						? 'The plan was never finished, so nothing on this screen is a count of anything.'
						: 'A plan belongs to the engine process that made it, so restarting the engine is what makes a new one possible.',
					todo: 'Start the engine again, then check the phone.',
					code: null
				}
			: null
	);

	const band = $derived(stoppedBand ?? failure);

	const clockNow = createNow();

	/**
	 * `2 minutes ago` — the question a re-check answers.
	 *
	 * The wall clock is still here, in the row's `title`: "checked at 14:32:07"
	 * reads as a fact but answers nothing, while "checked 2 minutes ago" is what
	 * decides whether pressing Check again is worth it. It ticks, so it cannot
	 * drift into a lie while the screen sits open.
	 */
	const checkedAge = $derived(
		plannedAt === null ? '' : ageOf(plannedAt.getTime(), clockNow.now)
	);

	/** `14:32:07` — local time, seconds, because a re-check is seconds apart. */
	const clockText = $derived(
		plannedAt === null
			? ''
			: plannedAt.toLocaleTimeString(undefined, {
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
					hour12: false
				})
	);

	const summary = $derived(planning ? 'Checking the phone against the drive.' : planSentence(plan));

	const stats = $derived.by(() => {
		const current = plan;
		if (current === null) return [];
		return [
			{
				label: 'Safe to delete',
				value: plural(current.eligible.length, 'file'),
				hint:
					current.refused.length === 0
						? 'every file was vouched for'
						: `${plural(current.refused.length, 'file')} refused`
			},
			{ label: 'Frees on the phone', value: formatBytes(current.bytesReclaimed) },
			{
				label: 'Selected',
				value: plural(totals.count, 'file'),
				hint: totals.count === 0 ? 'nothing yet' : formatBytes(totals.bytes),
				tone: totals.count === 0 ? ('muted' as const) : ('default' as const)
			}
		];
	});

	const deleteDisabled = $derived(
		plan === null || busy || applying || staleSelection || engineStopped || totals.count === 0
	);

	const allSelected = $derived(eligible.length > 0 && totals.count === eligible.length);

	async function planNow(): Promise<void> {
		if (busy) return;
		screen.planning = true;
		screen.failure = null;
		// NOT cleared here. Only a `purgePlan` frame proves the plan on screen is
		// current; a check that throws must leave the old plan marked stale rather
		// than re-enabling Delete against files it has already deleted.
		try {
			await app.port.send('purge.plan', { verifyHash: reRead });
		} catch (error) {
			screen.failure = failureBand(error, 'purge');
		} finally {
			screen.planning = false;
		}
	}

	/**
	 * The first `purge.apply`: no `confirm`, so the engine answers with the
	 * `needsConfirm` frame, which is what opens the sheet.
	 */
	async function requestDelete(): Promise<void> {
		const current = plan;
		if (current === null || deleteDisabled) return;
		screen.applying = true;
		screen.failure = null;
		screen.pendingConfirm = null;
		try {
			await app.port.send('purge.apply', {
				planId: current.planId,
				keys: [...selection]
			});
		} catch (error) {
			screen.failure = failureBand(error, 'purge');
			screen.staleSelection = true;
		} finally {
			screen.applying = false;
		}
	}

	async function confirmDelete(): Promise<void> {
		const current = plan;
		if (current === null || applying) return;
		screen.applying = true;
		screen.failure = null;
		try {
			const answer = await app.port.send('purge.apply', {
				planId: current.planId,
				keys: [...selection],
				confirm: current.planId
			});
			const outcome = purgeOutcome(answer);
			if (outcome === null) {
				// The engine asked again: the sheet stays open with fresh facts.
				screen.sheetOpen = true;
				return;
			}
			screen.sheetOpen = false;
			screen.pendingConfirm = null;
			// The plan that was just acted on describes files that no longer exist.
			// Mark it stale BEFORE the re-plan, so an engine that has gone away
			// between the delete and the check cannot leave a live-looking plan.
			screen.staleSelection = true;

			const deleted = outcome.deleted;
			const failed = outcome.failed;

			// The plan described files that no longer exist, so re-plan before
			// offering anything else.
			await planNow();
			app.pushNotice(
				failed > 0 ? 'warn' : 'info',
				failed > 0
					? `Deleted ${plural(deleted, 'file')} from the phone; ${plural(failed, 'file')} were refused.`
					: `Deleted ${plural(deleted, 'file')} from the phone.`
			);
			if (failed > 0) {
				screen.failure = {
					what: `${plural(failed, 'file')} were refused and are still on the phone.`,
					means: `${plural(deleted, 'file')} were deleted. The engine will not delete a file it cannot vouch for, so the refused copies are untouched.`,
					todo: 'Read the refusals below before checking again. A refused file is a reason to look, never a reason to retry.',
					code: null
				};
			}
		} catch (error) {
			screen.sheetOpen = false;
			screen.pendingConfirm = null;
			screen.failure = failureBand(error, 'purge');
			screen.staleSelection = true;
		} finally {
			screen.applying = false;
		}
	}

</script>

<PageHeader title="Purge" {summary}>
	{#snippet actions()}
		<Button
			class={CONTROL}
			size="sm"
			disabled={busy}
			aria-busy={busy}
			onclick={() => void planNow()}
		>
			{#if busy}
				<Spinner class="size-3.5" />
				Checking
			{:else}
				{plan === null ? 'Check the phone' : 'Check again'}
			{/if}
		</Button>
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
					onclick={() => void planNow()}
				>
					Check again
				</Button>
			{/snippet}
		</ErrorBand>
	{/if}

	{#if planning && plan === null}
		<SkeletonRows rows={8} label="Checking the phone against the drive" />
	{:else if plan === null}
		{#if !band}
			<EmptyState
				title="Nothing checked yet"
				body="Use Check the phone above. It reads the transfer journal and lists the files a verified drive copy already covers; nothing is deleted until you tick a file and confirm it."
			/>
		{/if}
	{:else if plan.eligible.length === 0}
		{#if !band}
			<EmptyState title="Nothing to delete" body={planSentence(plan)} />
		{/if}
	{:else}
		<section class="flex flex-col gap-2">
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h2 class="text-lead font-medium text-foreground">Safe to delete</h2>
				<span class="text-label text-muted-foreground" data-numeric>
					{plural(plan.eligible.length, 'file')} · {formatBytes(plan.bytesReclaimed)}
				</span>
				<!-- The clock is what proves a re-check happened. The counts cannot:
				     they are identical by design when nothing on either end changed. -->
				<span class="text-caption text-muted-foreground" data-numeric title={clockText}>
					checked {checkedAge}
				</span>
				<div class="ms-auto">
					<Button
						class={CONTROL}
						variant="outline"
						size="xs"
						disabled={allSelected}
						onclick={() => {
							screen.selection = allKeys(eligible);
							screen.staleSelection = false;
						}}
					>
						Select all
					</Button>
				</div>
			</div>

			<p class="measure text-label text-muted-foreground">
				Each file has a copy on the drive that was verified during the transfer. Deleting one here
				removes it from the phone and leaves the drive untouched.
			</p>

			<ul class="divide-y divide-border rounded-surface border border-border">
				{#each eligible as candidate (candidate.key)}
					<li class="flex items-center gap-3 px-3 py-2">
						<Checkbox
							checked={selection.has(candidate.key)}
							onCheckedChange={() => {
								screen.selection = toggleKey(selection, candidate.key);
								screen.staleSelection = false;
							}}
							aria-label={`Select ${candidate.srcPath} to delete from the phone`}
						/>
						<div class="flex min-w-0 flex-1 flex-col">
							<span
								class="font-mono text-label break-all text-foreground"
								title={candidate.srcPath}
							>
								{truncateFront(candidate.srcPath, 96)}
							</span>
							<span class="text-caption text-muted-foreground">
								{proofWord(candidate)}
							</span>
						</div>
						<span class="shrink-0 font-mono text-label text-muted-foreground tabular-nums">
							{formatBytes(candidate.size)}
						</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if plan !== null && plan.refused.length > 0}
		<section class="flex flex-col gap-2">
			<h2 class="text-lead font-medium text-foreground">Refused</h2>
			<p class="measure text-body text-muted-foreground">
				The engine will not delete a file it cannot vouch for. These stay on the phone, and nothing
				here will touch them.
			</p>
			<ul class="divide-y divide-border rounded-surface border border-border">
				{#each plan.refused as entry (entry.srcPath)}
					<li class="flex flex-col gap-0.5 px-3 py-2">
						<span class="font-mono text-label break-all text-foreground" title={entry.srcPath}>
							{truncateFront(entry.srcPath, 96)}
						</span>
						<span class="text-caption text-muted-foreground">{refusalSentence(entry.reason)}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if plan !== null && plan.eligible.length > 0}
		<!-- Sticky, because a purge plan is 57 rows on a real phone: an action bar
		     at the end of that list is a decision the person has to scroll to find,
		     and the one control on this screen that deletes anything should never be
		     the hardest thing on it to reach. -->
		<footer
			class="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-surface border border-border bg-card px-4 py-3 shadow-sm"
		>
			<div class="flex flex-wrap items-center gap-2">
				<Button
					class={CONTROL}
					size="sm"
					variant="destructive"
					disabled={deleteDisabled}
					onclick={() => void requestDelete()}
				>
					Delete {plural(totals.count, 'file')} from the phone · {formatBytes(totals.bytes)}
				</Button>

				<ToggleGroup
					type="single"
					value={reRead ? 'reread' : 'journal'}
					spacing={0}
					aria-label="How to verify the copy"
					class="h-8 gap-0 rounded-control bg-muted p-0.5"
					disabled={busy}
					onValueChange={(value) => {
						const next = value === 'reread';
						if (next === reRead) return;
						screen.setReRead(next);
						void planNow();
					}}
				>
					<ToggleGroupItem
						value="journal"
						class="h-7 min-w-0 rounded-[calc(var(--radius-control)-2px)] px-2 text-label tracking-normal normal-case data-[state=on]:bg-card data-[state=on]:text-foreground"
						title="Use the check recorded when each file was copied — fast"
					>
						Use the copy record
					</ToggleGroupItem>
					<ToggleGroupItem
						value="reread"
						class="h-7 min-w-0 rounded-[calc(var(--radius-control)-2px)] px-2 text-label tracking-normal normal-case data-[state=on]:bg-card data-[state=on]:text-foreground"
						title="Read both copies now and compare them before offering anything — slower"
					>
						Re-check both copies
					</ToggleGroupItem>
				</ToggleGroup>
			</div>

			<p class="measure text-caption text-muted-foreground">
				{#if staleSelection}
					This selection no longer belongs to a live plan. Check again before deleting anything.
				{:else if totals.count === 0}
					Tick a file above. Nothing is selected for you, because deleting from the phone is your
					call and not this screen's.
				{:else}
					The sheet names every file before anything is deleted. <b
						class="font-medium text-foreground">Deleting is permanent</b
					> — the phone copy does not go to a trash folder. The drive copy is not touched.
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
		title="Delete from the phone"
		action="purge.apply"
		paths={facts.paths}
		count={facts.count}
		bytes={facts.bytes}
		trashDir={facts.trashDir}
		confirmWord="Delete"
		busy={applying}
		onconfirm={() => void confirmDelete()}
		oncancel={() => {
			screen.sheetOpen = false;
			screen.pendingConfirm = null;
		}}
	/>
{/if}
