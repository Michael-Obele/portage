<script lang="ts">
	/**
	 * Plan — what a pull would move, and what it would skip, with a reason each.
	 *
	 * The plan is a read: the engine walks the phone and the drive and answers
	 * with a `plan` frame. Nothing on this screen writes anything, and the two
	 * actions that would write (Pull, Copy only) leave the screen rather than
	 * doing it here, carrying their filters in the URL.
	 *
	 * Filters go to the ENGINE rather than being applied here, so the count in
	 * the header is the engine's count and the table cannot disagree with it.
	 */
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	import {
		EmptyState,
		ErrorBand,
		PageHeader,
		SkeletonRows
	} from '../../lib/components/app/index.ts';
	import PlanFilters from '../../lib/components/app/plan-filters.svelte';
	import PlanTable from '../../lib/components/app/plan-table.svelte';
	import StatStrip from '../../lib/components/app/stat-strip.svelte';
	import CopyButton from '../../lib/components/app/copy-button.svelte';
	import {
		deviceLabel,
		emptyFilters,
		filtersActive,
		filtersSentence,
		intentFrom,
		intentToSearch,
		planArgs,
		planRows,
		type PlanFilters as Filters,
		type PlanRow,
		type PullMode
	} from '../../lib/components/app/plan-filters.ts';
	import { CONTROL } from '../../lib/components/app/tokens.ts';
	import { Button } from '../../lib/components/ui/button/index.js';
	import { failureBand, type Band } from '../../lib/components/app/transfer-band.ts';
	import type { PlanResult } from '../../lib/engine/protocol.ts';
	import { app } from '../../lib/state/app.svelte.ts';
	import { formatBytes, plural } from '../../lib/util/format.ts';

	let filters = $state<Filters>(emptyFilters());
	let showDraft = $state('');
	let plan = $state<PlanResult | null>(null);
	let loading = $state(false);
	let refetching = $state(false);
	let failure = $state<Band | null>(null);
	let selected = $state<PlanRow | null>(null);
	let dryRunNote = $state<string | null>(null);
	/** Source paths removed from this pull. The plan is re-read after each one. */
	let excluded = $state<string[]>([]);

	const rows = $derived(plan === null ? [] : planRows(plan));
	const removedCount = $derived(
		plan === null ? 0 : plan.skipped.filter((file) => file.excluded).length
	);
	const stats = $derived.by(() => {
		if (plan === null) return [];
		const items = [
			{ label: 'To move', value: plural(plan.toTransfer.length, 'file') },
			{ label: 'Bytes', value: formatBytes(plan.bytesTotal) },
			{ label: 'Skipped', value: plural(plan.skipped.length, 'file') },
			{
				// Excluded bytes are skipped too, but they are not "already on the
				// drive" — subtracting them keeps the label true.
				label: 'Already on the drive',
				value: formatBytes(plan.bytesSkipped - plan.bytesExcluded),
				tone: 'muted' as const
			}
		];
		if (removedCount > 0) {
			items.push({
				label: 'Removed by hand',
				value: plural(removedCount, 'file'),
				tone: 'muted' as const
			});
		}
		return items;
	});

	const active = $derived(filtersActive(filters));
	const deviceName = $derived(app.devices.find((device) => device.id === filters.device));
	const inForce = $derived(
		filtersSentence(filters, deviceName === undefined ? undefined : deviceLabel(deviceName))
	);

	const summary = $derived.by(() => {
		// The numbers live in the stat strip below. Repeating them here is the
		// kind of duplication that makes a screen feel generated, so the header
		// only ever says what the strip cannot: whether it is still reading.
		if (plan === null) return 'Reading the phone and the drive.';
		if (refetching) return 'Reading the phone and the drive…';
		return plan.toTransfer.length === 0 ? 'Nothing would be copied.' : '';
	});

	/**
	 * True when `path` is `mount`, or sits under it.
	 *
	 * `startsWith` alone is not containment: `/media/x/2TB2` starts with
	 * `/media/x/2TB`, so a drive would take its neighbour's access as its own
	 * and a read-only mount could pass for writable. A mount point is a
	 * directory, and a sibling sharing its prefix is a different volume.
	 */
	function insideMount(path: string, mount: string): boolean {
		const root = mount.endsWith('/') ? mount.slice(0, -1) : mount;
		return path === root || path.startsWith(`${root}/`);
	}

	/**
	 * What stops a pull, in the words the person needs. `null` means nothing
	 * does.
	 *
	 * The read-only check reads the volume list rather than the plan, and treats
	 * "access could not be checked" as read-only: a mount whose access is unknown
	 * is not writable until something says it is.
	 */
	const blocker = $derived.by((): Band | null => {
		if (plan === null) return null;
		if (!plan.space.ok) {
			const reason = plan.space.reason?.trim() ?? '';
			const free = formatBytes(plan.space.freeBytes);
			return {
				what:
					reason === ''
						? `The drive would not have enough room: ${free} free for ${formatBytes(plan.bytesTotal)}.`
						: reason,
				means: `Free space on the destination is ${free}; the plan needs ${formatBytes(plan.bytesTotal)} plus the configured headroom.`,
				todo:
					plan.space.fix?.trim() || 'Free some space on the drive, then request the plan again.',
				code: null
			};
		}
		// Captured before the callback: `plan` is reactive state, so TypeScript
		// does not keep the null check above across a closure boundary.
		const destRoot = plan.destRoot;
		const volume = app.volumes.find((entry) => insideMount(destRoot, entry.mountPoint));
		if (volume && volume.readOnly !== false) {
			return {
				what:
					volume.readOnly === null
						? `Whether ${volume.mountPoint} can be written to could not be checked.`
						: `${volume.mountPoint} is mounted read-only.`,
				means:
					'A pull writes to the destination, so a destination that cannot be written to stops it.',
				todo: 'Remount the drive read-write, or choose another destination in Settings, then request the plan again.',
				code: null
			};
		}
		return null;
	});

	const pullDisabled = $derived(blocker !== null || plan === null || plan.toTransfer.length === 0);

	function bandFrom(error: unknown): Band {
		return failureBand(error, 'plan');
	}

	function setPlan(next: PlanResult): void {
		plan = next;
		failure = null;
	}

	async function request(): Promise<boolean> {
		const first = plan === null;
		if (first) loading = true;
		else refetching = true;
		failure = null;
		try {
			// The plan itself arrives as the `plan` FRAME — the engine writes it
			// before it answers — and the observer below stores it. The answer is
			// a tally, so reading the plan out of it is exactly the mistake that
			// crashed the destination picker.
			await app.port.send('plan', planArgs(filters, excluded));
			return true;
		} catch (error) {
			failure = bandFrom(error);
			return false;
		} finally {
			loading = false;
			refetching = false;
		}
	}

	function apply(next: Partial<Filters>): void {
		filters = { ...filters, ...next };
		selected = null;
		dryRunNote = null;
		void request();
	}

	function clear(): void {
		filters = emptyFilters();
		showDraft = '';
		selected = null;
		dryRunNote = null;
		void request();
	}

	function startPull(mode: PullMode): void {
		void goto(`/transfer${intentToSearch(intentFrom(filters, mode, excluded))}`);
	}

	function remove(row: PlanRow): void {
		if (excluded.includes(row.srcPath)) return;
		excluded = [...excluded, row.srcPath];
		void request();
	}

	function restore(row: PlanRow): void {
		excluded = excluded.filter((path) => path !== row.srcPath);
		void request();
	}

	function restoreAll(): void {
		if (excluded.length === 0) return;
		excluded = [];
		void request();
	}

	async function dryRun(): Promise<void> {
		dryRunNote = null;
		// The failure band is the one place a refused request is explained. A
		// "finished" note under it would claim the opposite of what it says.
		if (!(await request())) return;
		dryRunNote =
			'Dry run finished. The plan was rebuilt from the phone and the drive; nothing was copied and nothing was deleted.';
	}

	function reveal(path: string): void {
		void app.revealPath(path).catch(() => {
			app.pushNotice('warn', 'The file manager would not open that folder.');
		});
	}

	onMount(() => {
		return app.observeFrame((frame) => {
			if (frame.type === 'plan') setPlan(frame.plan);
		});
	});

	/**
	 * Ask for the plan once, and only once the port is chosen.
	 *
	 * The shell picks the port (a real engine or a fixture) inside its own mount,
	 * which is later than this screen's — so a request sent straight from
	 * `onMount` leaves before there is anything to send it to, and the screen
	 * opens on a failure band it has not earned. Waiting on the connection is
	 * what makes the first frame honest.
	 */
	let requested = $state(false);
	$effect(() => {
		if (requested) return;
		if (app.connection === 'connecting') return;
		requested = true;
		// The read-only check reads the volume list, and only Home ever asks for
		// one — the engine emits no `volumes` frame at startup, so a direct load
		// of this screen checked an empty list and called every mount writable. A
		// list that cannot be read stays empty on purpose: the check then says
		// access is unknown, which still stops a pull.
		void app.loadVolumes().catch(() => {});
		void request();
	});
</script>

<PageHeader title="Plan" {summary} />

<div class="flex flex-col gap-4 px-6 pb-8">
	{#if plan}
		<p class="flex flex-wrap items-center gap-2 text-label">
			<span class="text-muted-foreground">Destination</span>
			<span class="font-mono break-all text-foreground">{plan.destRoot}</span>
			<CopyButton value={plan.destRoot} label="Copy the destination path" />
			<span class="text-muted-foreground" data-numeric>
				{formatBytes(plan.space.freeBytes)} free
			</span>
		</p>
	{/if}

	<StatStrip items={stats} class="px-2" />

	<PlanFilters
		{filters}
		devices={app.devices}
		{showDraft}
		busy={loading || refetching}
		onshowdraft={(value) => (showDraft = value)}
		onsubmit={() => apply({ show: showDraft })}
		ondevice={(id) => apply({ device: id })}
		onsince={(window) => apply({ since: window })}
		onclear={clear}
	/>

	{#if failure}
		<ErrorBand what={failure.what} means={failure.means} todo={failure.todo} code={failure.code}>
			{#snippet actions()}
				<Button class={CONTROL} size="sm" disabled={loading} onclick={() => void request()}>
					Request the plan again
				</Button>
			{/snippet}
		</ErrorBand>
	{/if}

	{#if loading && plan === null}
		<SkeletonRows rows={8} label="Reading the phone and the drive" />
	{:else if plan === null}
		{#if !failure}
			<EmptyState
				title="No plan yet"
				body="The engine has not answered with a plan. Request one to see what a pull would move."
				action="Request the plan"
				onselect={() => void request()}
			/>
		{/if}
	{:else}
		<footer
			class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-surface)] border border-border bg-card px-4 py-3"
		>
			<div class="flex flex-wrap items-center gap-2">
				<Button
					class={CONTROL}
					size="sm"
					disabled={pullDisabled}
					onclick={() => startPull('delete-after-verify')}
				>
					Pull
				</Button>
				<Button
					class={CONTROL}
					size="sm"
					variant="outline"
					disabled={pullDisabled}
					onclick={() => startPull('keep')}
				>
					Copy only
				</Button>
				<Button
					class={CONTROL}
					size="sm"
					variant="outline"
					disabled={loading || refetching}
					onclick={() => void dryRun()}
				>
					Dry run
				</Button>
			</div>

			<p class="measure text-caption text-muted-foreground">
				Pull copies, verifies, then deletes the phone copy. Copy only keeps it. Dry run rebuilds the
				plan and moves nothing.
			</p>

			{#if removedCount > 0}
				<p class="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
					{plural(removedCount, 'file')} removed from this pull by hand.
					<Button class={CONTROL} size="sm" variant="ghost" onclick={restoreAll}
						>Put them back</Button
					>
				</p>
			{/if}

			{#if blocker}
				<p class="measure text-body text-state-failed" data-numeric>
					{blocker.what}
					{blocker.means}
					{blocker.todo}
				</p>
			{:else if plan.toTransfer.length === 0}
				<p class="measure text-body text-muted-foreground">
					There is nothing to pull, so Pull and Copy only are unavailable.
				</p>
			{/if}

			{#if dryRunNote}
				<p class="measure text-body text-muted-foreground">{dryRunNote}</p>
			{/if}
		</footer>

		{#if plan.warnings.length > 0}
			<ul
				class="flex flex-col gap-1 rounded-[var(--radius-surface)] border border-border bg-muted px-4 py-3"
			>
				{#each plan.warnings as warning, index (index)}
					<li class="measure text-body text-foreground">{warning}</li>
				{/each}
			</ul>
		{/if}

		{#if plan.toTransfer.length === 0 && !active}
			<EmptyState
				title={refetching ? 'Reading the phone and the drive' : 'Nothing new on this phone'}
				body={plan.skipped.length > 0
					? `${plural(plan.skipped.length, 'file')} are already on the drive, or were passed over. Nothing would be copied.`
					: 'The scan found no files to move and nothing to skip.'}
				action="Review duplicates"
				onselect={() => void goto('/duplicates')}
				busy={refetching}
			/>
		{/if}

		{#if rows.length > 0 || active}
			<PlanTable
				{rows}
				loading={loading && plan === null}
				filtersSentence={inForce}
				{selected}
				onactivate={(row) => (selected = row)}
				onclear={clear}
				onreveal={reveal}
				onremove={remove}
				onrestore={restore}
			/>
		{/if}
	{/if}
</div>
