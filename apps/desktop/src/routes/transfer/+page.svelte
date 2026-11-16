<script lang="ts">
	/**
	 * Transfer — the claim made visible while it happens.
	 *
	 * This screen reads `run.view` and nothing else. Every rate, every ETA and
	 * every percentage in it came out of a frame; the reducers already did the
	 * arithmetic, and a second opinion computed here would eventually disagree
	 * with the journal. The only thing this screen adds is TIME: a rolling set of
	 * local samples so the rate chart has a shape, which are copies of the two
	 * rates each frame carried.
	 *
	 * The run starts here only because the Plan screen sent an intent in the URL
	 * — `mode` is the marker. Arriving at `/transfer` without one and with no run
	 * in flight says "nothing to move" instead of inventing work.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';

	import {
		EmptyState,
		ErrorBand,
		PageHeader,
		SkeletonRows
	} from '../../lib/components/app/index.ts';
	import StateChip from '../../lib/components/app/state-chip.svelte';
	import TransferChart from '../../lib/components/app/transfer-chart.svelte';
	import TransferControls from '../../lib/components/app/transfer-controls.svelte';
	import TransferHero from '../../lib/components/app/transfer-hero.svelte';
	import TransferRows from '../../lib/components/app/transfer-rows.svelte';
	import { failureBand, type Band } from '../../lib/components/app/transfer-band.ts';
	import { browserStore, consentGiven } from '../../lib/components/app/pull-consent.ts';
	import {
		deviceLabel,
		filtersFromIntent,
		intentSentence,
		parseIntent,
		planArgs,
		pullStartArgs,
		type PullIntent
	} from '../../lib/components/app/plan-filters.ts';
	import {
		SAMPLE_INTERVAL_MS,
		nextFirstVerify,
		rowViews,
		sampleOf,
		stalledSentence,
		viewIsLive,
		type RateSample
	} from '../../lib/components/app/transfer-series.ts';
	import { plural } from '../../lib/util/format.ts';
	import { app } from '../../lib/state/app.svelte.ts';
	import { run } from '../../lib/state/run.svelte.ts';
	import { screens } from '../../lib/state/screens.svelte.ts';

	/**
	 * Everything except the clock lives in a module store (see
	 * `lib/state/screens.svelte.ts`), so leaving this tab and coming back shows
	 * the same run instead of an empty screen.
	 *
	 * `now` stays local on purpose: it is a ticking value, not state to keep.
	 */
	const screen = screens.transfer;
	const starting = $derived(screen.starting);
	const startFailure = $derived(screen.startFailure);
	const nothingToMove = $derived(screen.nothingToMove);
	/** Real filenames from the plan, so the starting skeleton is not anonymous. */
	const startingNames = $derived(screen.startingNames);
	/** The samples live in `run` so the summary can draw the finished run too. */
	const series: RateSample[] = $derived(run.series);
	const firstVerifyAt = $derived(screen.firstVerifyAt);
	let now = $state(Date.now());
	const busy = $derived(screen.busy);

	const view = $derived(run.view);
	const intent: PullIntent | null = $derived(parseIntent(page.url.search));
	const live = $derived(viewIsLive(view));
	const ended = $derived(view.ended);
	const interrupted = $derived(
		!ended &&
			view.overall.filesTotal > 0 &&
			app.connection !== 'connected' &&
			app.connection !== 'mock'
	);
	/**
	 * The run names its own devices; one that is no longer ready is the cable.
	 * The banner says what the engine will actually do about it: nothing, until a
	 * file boundary.
	 */
	const deviceLost = $derived(view.devices.some((device) => !device.ready));
	const views = $derived(rowViews(view.rows, now));
	const stalled = $derived(stalledSentence(views));

	/**
	 * What the engine is doing right now.
	 *
	 * `run.announcement` is the screen-reader string: produced on events, and
	 * throttled to one every five seconds so a reader is not spammed. That also
	 * means it is EMPTY for the whole first file, which is why the old fallback
	 * — "Waiting for the first frame." — sat underneath a hero visibly counting
	 * bytes and a 6 % progress bar. When there is nothing to announce, say what
	 * the numbers already show instead of contradicting them.
	 */
	const statusLine = $derived.by((): string => {
		// Terminal and paused states outrank the announcement. The announcement is
		// only refreshed when frames arrive, so after the engine dies it keeps
		// printing the last "Copying…" sentence forever — the one case where a
		// stale line actively misleads. The wording here is deliberately not the
		// header's: the header states the fact, this line states its consequence.
		if (interrupted) return 'Stopped mid-run — no more frames are arriving.';
		if (ended) return 'Nothing further will change.';
		if (view.overall.paused) {
			return 'Paused. The file in flight finished; nothing new starts until you resume.';
		}
		if (run.announcement !== '') return run.announcement;
		if (view.overall.bytesDone > 0) {
			const files =
				view.overall.filesTotal > 0
					? ` — ${view.overall.filesDone} of ${view.overall.filesTotal} files finished`
					: '';
			return `Copying${files}.`;
		}
		if (starting) return 'Starting the run…';
		return 'Connected. Waiting for the first byte.';
	});

	const intentText = $derived.by(() => {
		if (intent === null) return null;
		const device = app.devices.find((entry) => entry.id === intent.device);
		return intentSentence(intent, device === undefined ? undefined : deviceLabel(device));
	});

	const title = $derived(interrupted ? 'Transfer · interrupted' : 'Transfer');

	const summary = $derived.by(() => {
		if (interrupted) {
			return 'The engine stopped before this run finished. The numbers below are the last ones it sent.';
		}
		if (ended) return 'The engine has finished this run.';
		if (view.overall.filesTotal > 0) {
			return `${view.overall.filesDone} of ${view.overall.filesTotal} files · ${intentText ?? 'run in progress'}`;
		}
		if (starting) return 'Building the plan, then starting the copy.';
		return intentText === null ? 'No transfer is running.' : intentText;
	});

	function bandFrom(error: unknown): Band {
		return failureBand(error, 'transfer');
	}

	/**
	 * Ask the engine to start.
	 *
	 * The plan is requested first for one reason only: its filenames make the
	 * starting skeleton say what is about to move. A plan that names nothing
	 * stops here — starting a run with no files would be a run that does nothing
	 * slowly.
	 *
	 * The per-run counters are cleared by the caller BEFORE `pull.start` goes
	 * out: the engine writes frames before it answers, so clearing them here
	 * would wipe the first frames of the run just begun.
	 */
	async function begin(wanted: PullIntent): Promise<void> {
		// The promise is made on the Plan screen. This URL can be reached without
		// ever having seen it — a bookmark, a reload, a Back button — so an
		// unacknowledged delete-after-verify run goes back to the screen that
		// explains it rather than starting one. A fixture is exempt: it cannot
		// delete anything, and gating it would make the screen unreachable from
		// `?mock=`, which is how it gets tested.
		if (
			!app.usingMock &&
			wanted.mode === 'delete-after-verify' &&
			!consentGiven(browserStore())
		) {
			void goto('/plan');
			return;
		}
		screen.starting = true;
		screen.startFailure = null;
		screen.nothingToMove = false;
		try {
			screen.startingNames = [];
			await app.port.send('plan', planArgs(filtersFromIntent(wanted), wanted.exclude));
			// The `plan` frame landed while that answer was in flight — the engine
			// always writes it first — and the observer below filled this in, so an
			// empty list is a real answer: there is nothing to copy.
			if (startingNames.length === 0) {
				screen.nothingToMove = true;
				return;
			}
			await app.port.send('pull.start', pullStartArgs(wanted));
		} catch (error) {
			screen.startFailure = bandFrom(error);
		} finally {
			screen.starting = false;
		}
	}

	async function control(type: 'pull.pause' | 'pull.resume' | 'pull.stop'): Promise<void> {
		screen.busy = true;
		try {
			await app.port.send(type);
		} catch (error) {
			// The button sends the command; the band reports the refusal. The
			// paused flag itself is never set here — it comes from the frame.
			const band = bandFrom(error);
			app.pushNotice('error', `${band.what} ${band.todo}`);
		} finally {
			screen.busy = false;
		}
	}

	onMount(() => {
		const stopFrames = app.observeFrame((frame) => {
			if (frame.type === 'plan' && starting) {
				screen.startingNames = frame.plan.toTransfer.map((file) => file.candidate.srcPath);
			}
		});

		// One sample a second into a capped rolling array. Not an animation: the
		// chart is redrawn from a new array, and the design bans animating it.
		const tick = setInterval(() => {
			now = Date.now();
			const sample = sampleOf(run.view.overall);
			if (sample !== null) {
				run.pushSample(sample);
				screen.firstVerifyAt = nextFirstVerify(firstVerifyAt, run.view.proof.verified, sample.t);
			}
			run.refreshAnnouncement(now);
		}, SAMPLE_INTERVAL_MS);

		return () => {
			stopFrames();
			clearInterval(tick);
		};
	});

	/**
	 * Start the run the URL asked for, once — and only once the shell has chosen
	 * its port.
	 *
	 * A request sent straight from `onMount` leaves before the shell has picked
	 * between a real engine and a fixture, so it would fail against nothing and
	 * open the screen on a failure band it has not earned.
	 */
	let began = $state(false);

	/**
	 * The intent URL this screen has already acted on.
	 *
	 * `began` is per-mount so a fresh visit re-evaluates, but the marker is not:
	 * coming BACK to a URL whose pull has already run must not silently start it
	 * again. The Plan screen clears this marker when a person actually asks for a
	 * new pull, so a real click is never mistaken for a back-navigation.
	 */
	$effect(() => {
		if (began) return;
		if (app.connection === 'connecting') return;
		began = true;
		if (intent === null) return;
		// A URL is not a click: a bookmark, a reload or a Back button must not
		// start a copy. The Plan screen mints a one-shot token when Pull is
		// pressed; anything else is offered as a button below.
		if (!screen.takeIntent(page.url.search, app.usingMock)) {
			screen.awaitingStart = page.url.search;
			return;
		}
		screen.awaitingStart = null;
		// One run at a time: the engine refuses a second one, and a reload must
		// not restart a run that is already going.
		if (viewIsLive(run.view)) return;
		// The counters are per-run but this store outlives the screen, so an
		// ended run from an earlier visit would otherwise be the last thing a
		// later intent ever saw. Clear them BEFORE the engine is asked: frames
		// precede answers, so clearing after `pull.start` resolves wipes the new
		// run's first frames.
		run.beginRun();
		screen.firstVerifyAt = null;
		void begin(intent);
	});
</script>

<PageHeader {title} {summary} />

<div class="flex flex-col gap-4 px-6 pb-8">
	{#if app.connection === 'stopped'}
		<ErrorBand
			what="The engine is not running."
			means="The run cannot advance. Nothing is deleted while the engine is down, so the drive copy stays as it was."
			todo="Restart the engine. A run that was in flight will not resume on its own — start a new one from Plan."
		/>
	{/if}

	{#if deviceLost && !ended}
		<ErrorBand
			what="A device in this run is no longer ready."
			means="The copy in flight will finish or fail on its own; the run then stops. Nothing unverified is deleted."
			todo="Reconnect the cable and leave the phone unlocked. The run stops after the current file, so a new run is what picks the rest up."
		/>
	{/if}

	{#if startFailure}
		<ErrorBand
			what={startFailure.what}
			means={startFailure.means}
			todo={startFailure.todo}
			code={startFailure.code}
		/>
	{/if}

	{#if nothingToMove}
		<EmptyState
			title="Nothing to move"
			body="The plan named no files on this phone with these filters, so no run was started. Nothing was copied and nothing was deleted."
			action="Build a plan"
			onselect={() => void goto('/plan')}
		/>
	{:else if !live && !ended && screen.awaitingStart !== null && startFailure === null}
		<!-- The URL asked for a pull but nobody pressed anything: a link, a
		     reload, a Back button. Offer the action instead of taking it. -->
		<EmptyState
			title="Ready when you are"
			body={`${intentText ?? 'This link names a pull.'} Nothing has been copied. Opening a link never starts a copy on its own.`}
			action={intent?.mode === 'keep' ? 'Copy only' : 'Pull and free the phone'}
			onselect={() => {
				if (intent !== null) void begin(intent);
			}}
		/>
	{:else if !live && !ended && intent === null}
		<EmptyState
			title="No transfer is running"
			body="This screen shows a run as it happens. Build a plan, then pull from there — the plan says exactly what would move before anything moves."
			action="Build a plan"
			onselect={() => void goto('/plan')}
		/>
	{:else if !live && !ended && startFailure === null}
		<SkeletonRows rows={4} label="Starting the run" />
	{:else}
		<TransferHero overall={view.overall} proof={view.proof} settled={ended} />

		<!-- Visible only. The window's one live region is in the layout, fed by
		     this same string and throttled to one announcement every five
		     seconds; a second `aria-live` here would say every status change
		     twice. Never bytes: a screen reader must not be read a 10 Hz
		     counter.

		     The fallback is NOT "waiting for the first frame" by default. An
		     announcement is only produced on events, so mid-file the string is
		     still empty while the hero above is visibly counting bytes — the
		     screen contradicted itself. When there is nothing to announce, say
		     what the numbers already show. -->
		<p class="flex flex-wrap items-baseline gap-2 text-body text-foreground">
			<span class="text-muted-foreground">Status</span>
			<span>{statusLine}</span>
		</p>

		{#if stalled}
			<p class="measure text-body text-state-failed">{stalled}</p>
		{/if}

		<TransferControls
			paused={view.overall.paused}
			{ended}
			{busy}
			engineDown={app.connection === 'stopped'}
			onpause={() => void control('pull.pause')}
			onresume={() => void control('pull.resume')}
			onstop={() => void control('pull.stop')}
			onsummary={() => void goto('/summary')}
		/>

		{#if starting && view.rows.length === 0}
			<div class="rounded-surface border border-border" role="status" aria-label="Starting the run">
				{#if startingNames.length === 0}
					<SkeletonRows rows={6} label="Building the plan" />
				{:else}
					<ul>
						{#each startingNames as name (name)}
							<li class="row-h flex items-center gap-3 border-b border-border px-3 last:border-b-0">
								<StateChip state="queued" />
								<span class="truncate text-body text-foreground">{name}</span>
							</li>
						{/each}
					</ul>
					<p class="px-3 py-2 text-caption text-muted-foreground">
						{plural(startingNames.length, 'file')} planned, queued behind the first byte. The engine numbers
						the rows as it starts them.
					</p>
				{/if}
			</div>
		{:else}
			<TransferRows rows={views} loading={false} />
		{/if}

		<!-- The chart is a diagnostic, not the headline: a two-second-old run
		     does not need a line graph above the list of files it is copying.
		     It used to sit between the hero and the rows, which pushed the one
		     question this screen answers — what is it doing right now — below
		     the fold. Collapsed by default, and still one keyboard press away. -->
		<details class="rounded-surface border border-border bg-card px-4 py-3">
			<summary class="cursor-pointer text-label text-muted-foreground">
				Throughput chart — instant versus average over the run
			</summary>
			<div class="pt-3">
				<TransferChart {series} {firstVerifyAt} />
			</div>
		</details>
	{/if}
</div>
