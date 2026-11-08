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
	import {
		deviceLabel,
		filtersFromIntent,
		intentSentence,
		parseIntent,
		planArgs,
		planFromAnswer,
		pullStartArgs,
		type PullIntent
	} from '../../lib/components/app/plan-filters.ts';
	import {
		MAX_SAMPLES,
		SAMPLE_INTERVAL_MS,
		appendSample,
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

	let starting = $state(false);
	let startFailure = $state<Band | null>(null);
	let nothingToMove = $state(false);
	/** Real filenames from the plan, so the starting skeleton is not anonymous. */
	let startingNames = $state<string[]>([]);
	let series = $state<RateSample[]>([]);
	let firstVerifyAt = $state<number | null>(null);
	let now = $state(Date.now());
	let busy = $state(false);

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
	 * Ask the engine to start, and reset the per-run counters on its `ok`.
	 *
	 * The plan is requested first for one reason only: its filenames make the
	 * starting skeleton say what is about to move. A plan that names nothing
	 * stops here — starting a run with no files would be a run that does nothing
	 * slowly.
	 */
	async function begin(wanted: PullIntent): Promise<void> {
		starting = true;
		startFailure = null;
		nothingToMove = false;
		try {
			const data = await app.port.send<'plan', unknown>(
				'plan',
				planArgs(filtersFromIntent(wanted))
			);
			const plan = planFromAnswer(data);
			if (plan !== null) {
				startingNames = plan.toTransfer.map((file) => file.candidate.srcPath);
				if (plan.toTransfer.length === 0) {
					nothingToMove = true;
					return;
				}
			}
			await app.port.send<'pull.start', unknown>('pull.start', pullStartArgs(wanted));
			// The counters are per-run: carrying them across would make the proof
			// strip claim work this run has not done.
			run.beginRun();
			series = [];
			firstVerifyAt = null;
		} catch (error) {
			startFailure = bandFrom(error);
		} finally {
			starting = false;
		}
	}

	async function control(type: 'pull.pause' | 'pull.resume' | 'pull.stop'): Promise<void> {
		busy = true;
		try {
			await app.port.send(type);
		} catch (error) {
			// The button sends the command; the band reports the refusal. The
			// paused flag itself is never set here — it comes from the frame.
			const band = bandFrom(error);
			app.pushNotice('error', `${band.what} ${band.todo}`);
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		const stopFrames = app.observeFrame((frame) => {
			if (frame.type === 'plan' && starting) {
				startingNames = frame.plan.toTransfer.map((file) => file.candidate.srcPath);
			}
		});

		// One sample a second into a capped rolling array. Not an animation: the
		// chart is redrawn from a new array, and the design bans animating it.
		const tick = setInterval(() => {
			now = Date.now();
			const sample = sampleOf(run.view.overall);
			if (sample !== null) {
				series = appendSample(series, sample, MAX_SAMPLES);
				firstVerifyAt = nextFirstVerify(firstVerifyAt, run.view.proof.verified, sample.t);
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
	$effect(() => {
		if (began) return;
		if (app.connection === 'connecting') return;
		began = true;
		if (intent === null) return;
		// One run at a time: the engine refuses a second one, and a reload must
		// not restart a run that is already going.
		if (viewIsLive(run.view) || run.view.ended) return;
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
		<TransferHero overall={view.overall} proof={view.proof} />

		<!-- The one live region on this screen, fed from the run store, which
		     throttles it to one announcement every five seconds. Never bytes: a
		     screen reader must not be read a 10 Hz counter. -->
		<p
			aria-live="polite"
			aria-atomic="true"
			class="flex flex-wrap items-baseline gap-2 text-body text-foreground"
		>
			<span class="text-muted-foreground">Status</span>
			<span>{run.announcement === '' ? 'Waiting for the first frame.' : run.announcement}</span>
		</p>

		{#if stalled}
			<p class="measure text-body text-state-failed">{stalled}</p>
		{/if}

		<TransferChart {series} {firstVerifyAt} />

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
			<div
				class="rounded-[var(--radius-surface)] border border-border"
				role="status"
				aria-label="Starting the run"
			>
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
	{/if}
</div>
