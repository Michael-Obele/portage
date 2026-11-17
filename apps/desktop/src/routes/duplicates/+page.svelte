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

	import ConfirmSheet from '#lib/components/app/confirm-sheet.svelte';
	import DupesGroups from '#lib/components/app/dupes-groups.svelte';
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
	} from '#lib/components/app/dupes-view.ts';
	import { EmptyState, ErrorBand, PageHeader, SkeletonRows } from '#lib/components/app/index.ts';
	import StatStrip from '#lib/components/app/stat-strip.svelte';
	import { CONTROL } from '#lib/components/app/tokens.ts';
	import { failureBand, type Band } from '#lib/components/app/transfer-band.ts';
	import { Button } from '#lib/components/ui/button/index.js';
	import { ToggleGroup, ToggleGroupItem } from '#lib/components/ui/toggle-group/index.js';
	import type { DupesFrame, NeedsConfirmFrame, TrashFrame } from '#lib/engine/protocol.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import { screens } from '#lib/state/screens.svelte.ts';
	import { isInsideMount } from '#lib/util/mount.ts';
	import { formatBytes, plural, truncateFront } from '#lib/util/format.ts';
	import { createNow } from '#lib/util/now.svelte.ts';
	import { dayAge, relativeTime } from '#lib/util/relative-time.ts';

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
	/** What the drive's trash is still holding — the bytes a move did NOT free. */
	const trash = $derived<TrashFrame | null>(screen.trash);
	const trashBusy = $derived(screen.trashBusy);
	const emptying = $derived(screen.emptying);

	const groups = $derived(scan?.groups ?? []);
	const totals = $derived(groupTotals(selection, groups));
	/** A ticking clock, so "scanned 4 minutes ago" stays true while it is read. */
	const clockNow = createNow();
	const scannedAge = $derived(
		screen.scannedAt === null ? null : relativeTime(screen.scannedAt.getTime(), clockNow.now)
	);

	/**
	 * One sheet, two actions.
	 *
	 * `dupes.apply` moves the ticked copies to the trash; `trash.empty` deletes
	 * what is already there for good. Both arrive as the engine's `needsConfirm`
	 * frame, and both need the same typed word, so they share the component and
	 * differ only in what it is told — a second sheet would be a second place for
	 * the wording to drift.
	 */
	const sheet = $derived.by(() => {
		const pending = pendingConfirm;
		if (pending === null) return null;
		if (pending.action === 'trash.empty') {
			return {
				action: 'trash.empty' as const,
				title: 'Empty the trash',
				confirmWord: 'Empty',
				// The folder NAME, not the full path: the sheet already states
				// "Deleting from: …/.portage/trash", and a repeated 60-character
				// prefix wraps at an arbitrary byte — one real sheet broke
				// "2026-11-07" into "2026-11-0" and "7", which reads as two folders.
				paths: pending.paths.map((path) => path.split('/').pop() ?? path),
				count: pending.count,
				bytes: pending.bytes,
				trashDir: pending.trashDir
			};
		}
		const moving = confirmFacts(pending, groups, selection);
		return {
			action: 'dupes.apply' as const,
			title: 'Move to the trash',
			confirmWord: 'Move',
			...moving
		};
	});

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
			{
				label: 'Reclaimable',
				value: formatBytes(current.reclaimableBytes),
				hint: 'from this report'
			},
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
		// A drive that already has a trash must say so on arrival: otherwise the
		// only way to discover it is to press a scan that finds nothing new.
		void refreshTrash();
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
		// NOT cleared here. A report is stale until a FRESH one lands (the frame
		// handler clears the flag), because a failed re-scan after a move must not
		// leave the old report tickable — that is how the last surviving copy got
		// offered again.
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
			// A scan says nothing about the trash, and "reclaimable" is only half
			// the story until the person knows what is already waiting to be freed.
			void refreshTrash();
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
			// Files have moved, so the report no longer describes the drive. It stays
			// stale until the re-scan below produces a report; if that re-scan fails,
			// the old one must not be ticable.
			screen.staleSelection = true;
			// A report whose files have just moved is out of date, so re-scan
			// before anything else is offered.
			await scanNow();
			app.pushNotice(
				outcome.refused > 0 ? 'warn' : 'info',
				outcome.refused > 0
					? `Moved ${plural(outcome.moved, 'file')}; ${plural(outcome.refused, 'file')} were refused.`
					: `Moved ${plural(outcome.moved, 'file')} · ${formatBytes(outcome.bytesMoved)} to the trash. The space is freed when you empty it.`
			);
			// The trash just grew, so the panel that offers to free it must appear
			// now, not after the next visit.
			void refreshTrash();
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
	/**
	 * Read the trash.
	 *
	 * Cheap (one directory walk) and read-only, so it is safe to call on mount, on
	 * scope change and after every move. It answers with the bytes a move has NOT
	 * freed, which is the number this screen used to leave out.
	 */
	async function refreshTrash(): Promise<void> {
		// QUEUED, not dropped. Returning early meant the refresh after a move was
		// silently lost whenever the previous reading was still in flight, leaving
		// the panel showing the pre-move numbers under a button that promised them.
		if (trashBusy) {
			refreshQueued = true;
			return;
		}
		screen.trashBusy = true;
		try {
			await app.port.send('trash.status', {});
		} catch {
			// A trash reading is an extra: a scan that worked must not be turned
			// into a failure band because the drive would not answer this one. The
			// panel simply does not appear.
			screen.trash = null;
		} finally {
			screen.trashBusy = false;
			if (refreshQueued) {
				refreshQueued = false;
				void refreshTrash();
			}
		}
	}

	/** A queued refresh. Set when a read is asked for while one is in flight. */
	let refreshQueued = false;

	/**
	 * The first `trash.empty`: no `confirm`, so the engine answers with the sheet.
	 *
	 * `days` is the scope: omitted empties the whole trash, an array empties those
	 * day folders, and `[]` with `loose` empties the files sitting directly in the
	 * trash root. The scope is remembered for the confirm, because a confirm that
	 * forgot it would empty everything the sheet just promised not to.
	 */
	async function requestEmpty(days?: string[], loose = false): Promise<void> {
		const current = trash;
		if (current === null || emptying || trashBusy) return;
		screen.emptying = true;
		screen.failure = null;
		screen.pendingConfirm = null;
		screen.emptyDays = days === undefined ? null : days;
		screen.emptyLoose = loose;
		try {
			const scope = days === undefined ? {} : { days, ...(loose ? { loose: true } : {}) };
			await app.port.send('trash.empty', { trashId: current.trashId, ...scope });
		} catch (error) {
			screen.failure = failureBand(error, 'dupes');
		} finally {
			screen.emptying = false;
		}
	}

	/** The confirmation: the typed word is the sheet's business, the id is ours. */
	async function confirmEmpty(): Promise<void> {
		const current = trash;
		if (current === null || emptying) return;
		screen.emptying = true;
		screen.failure = null;
		try {
			const scope =
				screen.emptyDays === null
					? {}
					: { days: screen.emptyDays, ...(screen.emptyLoose ? { loose: true } : {}) };
			const answer = await app.port.send('trash.empty', {
				trashId: current.trashId,
				...scope,
				confirm: current.trashId
			});
			const record: Record<string, unknown> = { ...answer };
			if ('needsConfirm' in record) return; // the engine asked again
			const freed = typeof record['bytesFreed'] === 'number' ? record['bytesFreed'] : 0;
			const failed = Array.isArray(record['refused']) ? record['refused'].length : 0;

			screen.sheetOpen = false;
			screen.pendingConfirm = null;
			screen.emptyDays = null;
			screen.emptyLoose = false;
			// The reading described folders that no longer exist.
			screen.trash = null;
			await refreshTrash();

			// The delta is the proof, when the filesystem will report it. NTFS
			// rounds allocation, so the two numbers never match to the byte — and a
			// sentence with two different answers to "how much did I free" is worse
			// than one. The counted bytes are the number we can stand behind.
			app.pushNotice(
				failed > 0 ? 'warn' : 'info',
				failed > 0
					? `Freed ${formatBytes(freed)}; ${plural(failed, 'folder')} could not be emptied.`
					: `Freed ${formatBytes(freed)} from the drive.`
			);
			if (failed > 0) {
				screen.failure = {
					what: `${plural(failed, 'folder')} could not be emptied.`,
					means:
						'What was deleted is gone; what was refused is still in the trash and still taking space.',
					todo: 'Read the refusal above. A folder another program is holding open cannot be removed.',
					code: null
				};
			}
		} catch (error) {
			screen.sheetOpen = false;
			screen.pendingConfirm = null;
			screen.failure = failureBand(error, 'dupes');
		} finally {
			screen.emptying = false;
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
				title={driveUnknown
					? 'Reading the drives first — a whole-drive scan needs to know the mount'
					: ''}
				onclick={() => void scanNow()}
			>
				{scan === null ? 'Scan for duplicates' : 'Scan again'}
			</Button>
		</div>
	{/snippet}
</PageHeader>

<div class="flex flex-col gap-4 px-6 pb-8">
	<StatStrip items={stats} />

	{#if scan !== null}
		<!-- Which walker ran, and how long it took. A three-minute scan looks
		     broken unless the screen can name the reason, and the reason is a
		     missing binary rather than a slow drive. -->
		<p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
			<span data-numeric>
				Walked {plural(scan.io.dirs, 'folder')} in {(Math.max(scan.io.elapsedMs, 0) / 1000).toFixed(
					1
				)} s
				{scan.io.via === 'scanner' ? 'with the fast scanner' : 'with the built-in walker'}.
			</span>
			{#if scannedAge !== null}
				<span data-numeric>Scanned {scannedAge === 'now' ? 'just now' : scannedAge}.</span>
			{/if}
			{#if scan.io.errorCount > 0}
				<span class="text-warning" data-numeric>
					{plural(scan.io.errorCount, 'path')} could not be read.
				</span>
			{/if}
			{#if scan.unreadableFiles > 0}
				<!-- The difference between "nothing repeats" and "nothing I could
				     look at repeats". A drive pulled out mid-scan lands here. -->
				<span class="text-warning" data-numeric>
					{plural(scan.unreadableFiles, 'file')} could not be re-read, so they were not compared.
				</span>
			{/if}
			{#if scan.io.depthLimited > 0}
				<span class="text-warning" data-numeric>
					{plural(scan.io.depthLimited, 'folder')} were too deep to walk.
				</span>
			{/if}
		</p>
		{#if scan.io.via === 'glob'}
			<p class="measure text-caption text-muted-foreground">
				This scan used the built-in walker, which is correct but far slower on a mounted drive. {scan
					.io.scannerError ?? 'The portage-scan binary was not installed next to the engine.'}
			</p>
		{/if}
	{/if}

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

	{#if trash !== null && trash.totalFiles > 0}
		<!-- ABOVE the groups on purpose. "Move to trash" frees NOTHING on the same
		     drive: the bytes land in .portage/trash and stay there. So the number a
		     person can act on is the one already waiting, and putting it below a
		     list of groups hid it behind a scroll on the real drive.
		     Gated on FILES, not bytes: a trash of zero-byte entries still needs a
		     way out. -->
		<section class="flex flex-col gap-3 rounded-surface border border-border bg-card p-4">
			<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h2 class="text-lead font-medium text-foreground">In the trash</h2>
				<span class="text-label text-muted-foreground" data-numeric>
					{plural(trash.totalFiles, 'file')} · {formatBytes(trash.totalBytes)}
				</span>
			</div>
			<p class="measure text-body text-muted-foreground">
				Moved copies sit in <span class="font-mono text-label text-foreground">{trash.root}</span>,
				on this same drive, so they still take the space they always did. Emptying the trash is the
				step that frees it, and it cannot be undone.
			</p>
			<div class="flex flex-wrap items-center gap-2">
				<Button
					class={CONTROL}
					size="sm"
					variant="destructive"
					disabled={emptying || trashBusy}
					onclick={() => void requestEmpty()}
				>
					Empty the trash{trash.totalBytes > 0 ? ` · frees ${formatBytes(trash.totalBytes)}` : ''}
				</Button>
				<!-- Each day by its AGE, not its folder name: "yesterday" is the fact
				     that decides whether this is stale. Each row can go on its own,
				     which is what `trash.empty`'s `days` was always for. -->
				<ul
					class="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground"
					data-numeric
				>
					{#each trash.days as day (day.date)}
						<li class="flex items-center gap-1.5">
							<span class="text-foreground">{dayAge(day.date, clockNow.now)}</span>
							<span>· {plural(day.files, 'file')} · {formatBytes(day.bytes)}</span>
							<Button
								class={CONTROL}
								size="xs"
								variant="outline"
								disabled={emptying || trashBusy}
								title={`Empty ${day.path}`}
								onclick={() => void requestEmpty([day.path])}
							>
								Empty
							</Button>
						</li>
					{/each}
					{#if trash.looseFiles > 0}
						<li class="flex items-center gap-1.5">
							<span
								>loose · {plural(trash.looseFiles, 'file')} · {formatBytes(trash.looseBytes)}</span
							>
							<Button
								class={CONTROL}
								size="xs"
								variant="outline"
								disabled={emptying || trashBusy}
								title="Empty the files sitting directly in the trash folder"
								onclick={() => void requestEmpty([], true)}
							>
								Empty
							</Button>
						</li>
					{/if}
				</ul>
			</div>
		</section>
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
					The sheet names every file and where it goes before anything moves. A move frees nothing
					until you empty the trash. A keeper is only a suggestion — tick it if you disagree.
				{/if}
			</p>

			<p class="sr-only" role="status" aria-live="polite">
				{plural(totals.count, 'file')} selected · {formatBytes(totals.bytes)}
			</p>
		</footer>
	{/if}
</div>

{#if sheet}
	<ConfirmSheet
		bind:open={() => screen.sheetOpen, (next) => (screen.sheetOpen = next)}
		title={sheet.title}
		action={sheet.action}
		paths={sheet.paths}
		count={sheet.count}
		bytes={sheet.bytes}
		trashDir={sheet.trashDir}
		confirmWord={sheet.confirmWord}
		busy={applying || emptying}
		onconfirm={() => (sheet.action === 'trash.empty' ? void confirmEmpty() : void confirmMove())}
		oncancel={() => {
			screen.sheetOpen = false;
			screen.pendingConfirm = null;
		}}
	/>
{/if}
