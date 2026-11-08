<script lang="ts">
	/**
	 * Instant versus average, over the run.
	 *
	 * Its job is to show whether the cable is dying and how far the average has
	 * drifted — so it is two lines, one y axis, horizontal rules only, and no
	 * animation. (An animated chart about throughput is a chart about animation.)
	 *
	 * Three rules from `design.md` are load-bearing:
	 *
	 *  1. **A text summary line above it**, because a number in a sentence is
	 *     what a person reads.
	 *  2. **A data table behind a disclosure**, so the chart is never the only
	 *     way to reach the numbers.
	 *  3. **The series differ by line style as well as hue** — instant solid,
	 *     average dashed — so the chart survives greyscale and forced colours.
	 *
	 * Samples come from `transfer-series.ts`: each one is a copy of the two rates
	 * the frame already carried, so nothing here measures anything.
	 */
	import { LineChart } from 'layerchart';

	import { DASH, formatDuration, formatRate } from '../../util/format.ts';
	import { cn } from '../../utils.ts';
	import { ChartContainer, type ChartConfig } from '../ui/chart/index.js';
	import { seriesSummary, type RateSample } from './transfer-series.ts';

	let {
		series,
		firstVerifyAt,
		class: className
	}: {
		series: RateSample[];
		/** Run seconds at which the first file verified, or `null`. */
		firstVerifyAt: number | null;
		class?: string;
	} = $props();

	/** The container injects `--color-instant` / `--color-average` from these. */
	const config = {
		instant: { label: 'instant', color: 'var(--color-chart-1)' },
		average: { label: 'average', color: 'var(--color-chart-2)' }
	} satisfies ChartConfig;

	/** One chart row. Named, so the accessors are not inferred as `any`. */
	interface ChartRow {
		t: number;
		instant: number;
		average: number;
		hasInstant: boolean;
		hasAverage: boolean;
	}

	/**
	 * `null` is "not measured yet", and a chart cannot draw that — so a null is
	 * carried as a point that is marked undefined and breaks the line, rather
	 * than being flattened to zero where it would read as a stalled transfer.
	 */
	const chartRows: ChartRow[] = $derived(
		series
			.filter((sample) => sample.instant !== null || sample.average !== null)
			.map((sample) => ({
				t: sample.t,
				instant: sample.instant ?? 0,
				average: sample.average ?? 0,
				hasInstant: sample.instant !== null,
				hasAverage: sample.average !== null
			}))
	);
	const enough = $derived(chartRows.length >= 2);

	const summary = $derived(seriesSummary(series, firstVerifyAt));
	const caption = $derived(
		`${formatDuration(series[0]?.t ?? 0)} to ${formatDuration(series[series.length - 1]?.t ?? 0)} of the run`
	);
</script>

<section class={cn('flex flex-col gap-2', className)}>
	<p class="measure text-body text-foreground">{summary}</p>

	{#if enough}
		<ChartContainer {config} class="aspect-auto h-44 w-full" aria-label={summary}>
			<LineChart
				data={chartRows}
				x="t"
				series={[
					{
						key: 'instant',
						label: 'instant',
						value: (row: ChartRow) => row.instant,
						color: 'var(--color-instant)',
						props: { defined: (row: ChartRow) => row.hasInstant }
					},
					{
						key: 'average',
						label: 'average',
						value: (row: ChartRow) => row.average,
						color: 'var(--color-average)',
						// Dashed, so the two series are still separable in greyscale.
						props: { defined: (row: ChartRow) => row.hasAverage, strokeDasharray: '4 3' }
					}
				]}
				grid={{ x: false }}
				legend={false}
				motion="none"
				padding={{ top: 4, right: 8, bottom: 4, left: 4 }}
				annotations={firstVerifyAt === null
					? []
					: [{ type: 'line' as const, x: firstVerifyAt, label: 'first verify' }]}
			/>
		</ChartContainer>
	{:else}
		<p class="text-body text-muted-foreground">
			The chart starts after the second sample; the engine has not reported two rates yet.
		</p>
	{/if}

	<details class="flex flex-col gap-1">
		<summary class="cursor-pointer text-label text-muted-foreground">
			Show the samples as a table
		</summary>
		<div class="mt-2 max-h-56 overflow-auto rounded-[var(--radius-control)] border border-border">
			<table class="w-full text-label">
				<caption class="sr-only">Rate samples, {caption}</caption>
				<thead class="sticky top-0 bg-card">
					<tr>
						<th
							scope="col"
							class="border-b border-border px-3 py-1 text-left font-medium text-muted-foreground"
						>
							Elapsed
						</th>
						<th
							scope="col"
							class="border-b border-border px-3 py-1 text-right font-medium text-muted-foreground"
						>
							Instant
						</th>
						<th
							scope="col"
							class="border-b border-border px-3 py-1 text-right font-medium text-muted-foreground"
						>
							Average
						</th>
					</tr>
				</thead>
				<tbody data-numeric>
					{#each series as sample (sample.t)}
						<tr class="border-b border-border last:border-b-0">
							<td class="px-3 py-1 font-mono text-muted-foreground">
								{formatDuration(sample.t)}
							</td>
							<td class="px-3 py-1 text-right font-mono text-foreground">
								{sample.instant === null ? DASH : formatRate(sample.instant)}
							</td>
							<td class="px-3 py-1 text-right font-mono text-foreground">
								{sample.average === null ? DASH : formatRate(sample.average)}
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan={3} class="px-3 py-2 text-muted-foreground">No samples yet.</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</details>
</section>
