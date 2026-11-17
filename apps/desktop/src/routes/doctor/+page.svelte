<script lang="ts">
	/**
	 * Doctor — what this machine can and cannot do, before a run finds out.
	 *
	 * The engine's `doctor` command prints advice with a copy-pasteable fix after
	 * every ✗ or ⚠ line, because "consider a faster cable" is useless at 11pm
	 * with a season waiting while `try the C-to-C cable on a USB 3 port` is a
	 * next step. Each of those prose lines also arrives as a `log` frame, and the
	 * verdicts arrive in one `doctor` frame carrying `{ok, checks[]}`.
	 *
	 * This screen is deliberately thin: it orders the checks so a failure cannot
	 * hide under a wall of passes, and it puts a copy button on every fix. It
	 * never re-judges a status and never invents a check.
	 */

	import CopyButton from '#lib/components/app/copy-button.svelte';
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
		doctorVerdict,
		failureCount,
		fixIsCommand,
		hasFix,
		isProblem,
		passedCount,
		notOkCount,
		problemCount,
		unreadable,
		visibleChecks,
		type DoctorFilter
	} from '#lib/components/app/doctor-view.ts';
	import { Button } from '#lib/components/ui/button/index.js';
	import { ToggleGroup, ToggleGroupItem } from '#lib/components/ui/toggle-group/index.js';
	import type { DoctorCheck, DoctorFrame, DoctorStatus } from '#lib/engine/protocol.ts';
	import { app } from '#lib/state/app.svelte.ts';
	import { screens } from '#lib/state/screens.svelte.ts';
	import { plural } from '#lib/util/format.ts';
	import { createNow } from '#lib/util/now.svelte.ts';
	import { relativeTime } from '#lib/util/relative-time.ts';
	import { cn } from '#lib/utils.ts';

	/**
	 * The report lives in a module store (see `lib/state/screens.svelte.ts`), so
	 * a tab click no longer throws away a completed check — and a report that
	 * arrives while another tab is open is still captured. Reads are aliases;
	 * writes go through `screen.`.
	 */
	const screen = screens.doctor;
	/** The last report. Every row on the screen comes from this frame. */
	const report = $derived(screen.report);
	const running = $derived(screen.running);
	const filter = $derived(screen.filter);
	const failure = $derived(screen.failure);

	const engineStopped = $derived(app.connection === 'stopped');
	const busy = $derived(running && !engineStopped);
	const verdict = $derived(doctorVerdict(report));
	const clockNow = createNow();
	/**
	 * `checked 2 minutes ago` — the report's own age.
	 *
	 * Doctor used to show no timestamp at all, so pressing Run again produced an
	 * identical screen and looked like a dead button. The age makes a re-run
	 * visible, and it ticks so it cannot go stale.
	 */
	const summary = $derived.by(() => {
		const at = screen.checkedAt;
		if (at === null) return verdict.detail;
		return `${verdict.detail} · checked ${relativeTime(at.getTime(), clockNow.now)}`;
	});
	const checks = $derived(report === null ? [] : visibleChecks(report.checks, filter));
	const isUnreadable = $derived(report !== null && unreadable(report));

	const stats = $derived.by(() => {
		const current = report;
		if (current === null) return [];
		return [
			{ label: 'Checks', value: plural(current.checks.length, 'check') },
			{
				label: 'Passed',
				value: String(passedCount(current.checks)),
				tone: 'muted' as const
			},
			{
				label: 'Flagged',
				value: String(problemCount(current.checks)),
				hint: 'warnings and failures',
				tone: 'muted' as const
			},
			{
				label: 'Failed',
				value: String(failureCount(current.checks)),
				tone: failureCount(current.checks) > 0 ? ('failed' as const) : ('muted' as const)
			}
		];
	});

	const stoppedBand = $derived<Band | null>(
		engineStopped && (running || report !== null)
			? {
					what: running
						? 'The engine stopped while the checks were running.'
						: 'The engine is not running, so this report cannot be trusted about anything.',
					means: running
						? 'The report was never finished, so nothing on this screen is a verdict about this machine.'
						: 'A check is run by the engine process, so restarting the engine is what makes a new one possible.',
					todo: 'Start the engine again, then run the checks.',
					code: null
				}
			: null
	);

	const band = $derived(stoppedBand ?? failure);

	/** The chip a status earns. A word always, so colour is never the signal. */
	const STATUS_WORD: Record<DoctorStatus, string> = {
		ok: 'ok',
		warn: 'warn',
		fail: 'failed',
		info: 'info'
	};

	/** Colour repeats the word; it never carries it alone. */
	const TONE: Record<DoctorStatus, string> = {
		ok: 'border-[color-mix(in_oklch,var(--state-verified),transparent_55%)] text-state-verified',
		warn: 'border-[color-mix(in_oklch,var(--state-warning),transparent_55%)] text-state-warning',
		fail: 'border-[color-mix(in_oklch,var(--state-failed),transparent_55%)] text-state-failed',
		info: 'border-border text-muted-foreground'
	};

	async function runNow(bench: boolean): Promise<void> {
		if (busy) return;
		screen.running = true;
		screen.failure = null;
		try {
			await app.port.send('doctor', { bench });
		} catch (error) {
			screen.failure = failureBand(error, 'doctor');
		} finally {
			screen.running = false;
		}
	}

</script>

<PageHeader title="Doctor" summary={summary}>
	{#snippet actions()}
		<div class="flex items-center gap-2">
			<Button
				class={CONTROL}
				size="sm"
				variant="outline"
				disabled={busy}
				onclick={() => void runNow(true)}
			>
				Measure throughput
			</Button>
			<Button class={CONTROL} size="sm" disabled={busy} onclick={() => void runNow(false)}>
				{report === null ? 'Run the checks' : 'Run again'}
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
					onclick={() => void runNow(false)}
				>
					Run again
				</Button>
			{/snippet}
		</ErrorBand>
	{/if}

	{#if running && report === null}
		<SkeletonRows rows={8} label="Running the checks" />
	{:else if report === null}
		{#if !band}
			<EmptyState
				title="Nothing checked yet"
				body="Use Run the checks above. It looks at adb, the devices, the destination and the journal, and gives every problem a command you can copy. Measure throughput adds a real transfer to a scratch file, which is slower."
			/>
		{/if}
	{:else if isUnreadable}
		{#if !band}
			<EmptyState
				title="The report could not be read"
				body="The engine ran and answered, but this build cannot make sense of what came back. That is a version mismatch between the app and the engine, not a clean bill of health."
			/>
		{/if}
	{:else}
		<section class="flex flex-col gap-2">
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h2 class="text-lead font-medium text-foreground">Checks</h2>
				<ToggleGroup
					type="single"
					value={filter}
					spacing={0}
					aria-label="Which checks to show"
					class="ms-auto h-8 gap-0 rounded-control bg-muted p-0.5"
					onValueChange={(value) => {
						if (value) screen.setFilter(value as DoctorFilter);
					}}
				>
					<ToggleGroupItem
						value="all"
						class="h-7 min-w-0 rounded-[calc(var(--radius-control)-2px)] px-2 text-label tracking-normal normal-case data-[state=on]:bg-card data-[state=on]:text-foreground"
					>
						All {report.checks.length}
					</ToggleGroupItem>
					<ToggleGroupItem
						value="problems"
						class="h-7 min-w-0 rounded-[calc(var(--radius-control)-2px)] px-2 text-label tracking-normal normal-case data-[state=on]:bg-card data-[state=on]:text-foreground"
					>
						Not OK {notOkCount(report.checks)}
					</ToggleGroupItem>
				</ToggleGroup>
			</div>

			{#if checks.length === 0}
				<EmptyState
					title="Every check passed"
					body="Nothing here is asking for attention. Switch to All to read the report the engine produced."
				/>
			{:else}
				<ul class="divide-y divide-border rounded-surface border border-border">
					{#each checks as check (`${check.label}:${check.value}`)}
						<li class="flex flex-col gap-1 px-3 py-2">
							<div class="flex items-start gap-3">
								<span
									class={cn(
										'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-caption',
										TONE[check.status]
									)}
								>
									{STATUS_WORD[check.status]}
								</span>
								<span class="min-w-0 shrink-0 font-mono text-label text-foreground">
									{check.label}
								</span>
								<span
									class={cn(
										'min-w-0 flex-1 text-label wrap-break-word',
										isProblem(check) ? 'text-foreground' : 'text-muted-foreground'
									)}
								>
									{check.value}
								</span>
							</div>
							{#if hasFix(check) && check.fix !== null}
								{#if fixIsCommand(check)}
									<div class="flex items-start gap-2 ps-16">
										<code
											class="min-w-0 flex-1 rounded-control bg-muted/50 px-2 py-1 font-mono text-caption wrap-break-word text-foreground"
										>
											{check.fix}
										</code>
										<CopyButton value={check.fix} label="Copy the fix" class="mt-0.5" />
									</div>
								{:else}
									<p class="measure ps-16 text-caption text-muted-foreground">{check.fix}</p>
								{/if}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<p class="measure text-caption text-muted-foreground">
			Every row above is the engine's own verdict, printed as it produced it. Nothing on this screen
			changes the machine: Doctor reads, and a fix only runs when you run it.
		</p>
	{/if}
</div>
