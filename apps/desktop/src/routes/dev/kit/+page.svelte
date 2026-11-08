<script lang="ts">
	/**
	 * The kitchen sink. Not in the nav; reachable at `/dev/kit`.
	 *
	 * It is the review surface for the token layer and the shared components:
	 * every role, the whole type scale, every state chip, and every primitive in
	 * its default, hover, focus, active, disabled, loading and error state.
	 *
	 * Hover, focus and active cannot be forced from markup, so those columns
	 * apply the SAME utilities the variant applies on those states. The
	 * appearance is therefore inspectable without a pointer; the live behaviour
	 * still comes from the pointer or the keys.
	 */
	import { toast } from 'svelte-sonner';

	import { Badge } from '../../../lib/components/ui/badge/index.js';
	import { Button } from '../../../lib/components/ui/button/index.js';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '../../../lib/components/ui/card/index.js';
	import { Checkbox } from '../../../lib/components/ui/checkbox/index.js';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogHeader,
		DialogTitle,
		DialogTrigger
	} from '../../../lib/components/ui/dialog/index.js';
	import { Input } from '../../../lib/components/ui/input/index.js';
	import { Label } from '../../../lib/components/ui/label/index.js';
	import { Progress } from '../../../lib/components/ui/progress/index.js';
	import { ScrollArea } from '../../../lib/components/ui/scroll-area/index.js';
	import {
		Select,
		SelectContent,
		SelectItem,
		SelectTrigger,
		SelectValue
	} from '../../../lib/components/ui/select/index.js';
	import { Separator } from '../../../lib/components/ui/separator/index.js';
	import { Skeleton } from '../../../lib/components/ui/skeleton/index.js';
	import {
		Tabs,
		TabsContent,
		TabsList,
		TabsTrigger
	} from '../../../lib/components/ui/tabs/index.js';
	import {
		Tooltip,
		TooltipContent,
		TooltipProvider,
		TooltipTrigger
	} from '../../../lib/components/ui/tooltip/index.js';

	import {
		ConfirmSheet,
		DataTable,
		EmptyState,
		ErrorBand,
		KeyHint,
		PageHeader,
		ProofStrip,
		SkeletonRows,
		StateChip,
		type StateChipState,
		type TableColumn
	} from '../../../lib/components/app/index.ts';
	import { CONTROL } from '../../../lib/components/app/tokens.ts';
	import { formatBytes } from '../../../lib/util/format.ts';
	import type { ProofCounts } from '../../../lib/state/run.ts';
	import { cn } from '../../../lib/utils.ts';

	const TYPES = [
		{ name: 'caption', cls: 'text-caption', size: '11 px' },
		{ name: 'label', cls: 'text-label', size: '12 px' },
		{ name: 'body', cls: 'text-body', size: '13 px' },
		{ name: 'lead', cls: 'text-lead', size: '15 px' },
		{ name: 'title', cls: 'text-title', size: '18 px' },
		{ name: 'display', cls: 'text-display', size: '22 px' },
		{ name: 'display-lg', cls: 'text-display-lg', size: '28 px' }
	];

	const ROLES = [
		'background',
		'foreground',
		'card',
		'card-foreground',
		'popover',
		'popover-foreground',
		'primary',
		'primary-foreground',
		'secondary',
		'secondary-foreground',
		'muted',
		'muted-foreground',
		'accent',
		'accent-foreground',
		'destructive',
		'border',
		'input',
		'ring',
		'chart-1',
		'chart-2',
		'chart-3',
		'sidebar',
		'sidebar-foreground',
		'sidebar-primary',
		'sidebar-accent',
		'sidebar-border',
		'sidebar-ring'
	];

	const STATE_ROLES = [
		{ name: 'state-copying', fg: 'state-copying-foreground' },
		{ name: 'state-verified', fg: 'state-verified-foreground' },
		{ name: 'state-failed', fg: 'state-failed-foreground' },
		{ name: 'state-skipped', fg: 'state-skipped-foreground' }
	];

	const CHIP_STATES: StateChipState[] = [
		'queued',
		'copying',
		'verifying',
		'verified',
		'deleted',
		'kept',
		'failed',
		'skipped',
		'duplicate'
	];

	const MOTION = [
		{ name: '--motion-fast', value: '120ms', use: 'a row chip changing' },
		{ name: '--motion-base', value: '180ms', use: 'the proof strip filling, a toast' },
		{ name: '--motion-slow', value: '240ms', use: 'the confirm sheet appearing' },
		{ name: '--ease-out-expo', value: 'cubic-bezier(0.2,0,0,1)', use: 'every one of them' }
	];

	const DENSITY = [
		{ name: '--row-h', value: '32px', use: 'a comfortable row' },
		{ name: '--row-h-compact', value: '28px', use: 'a compact row' },
		{ name: '--measure', value: '68ch', use: 'prose width' },
		{ name: '--radius-control', value: '6px', use: 'controls and inputs' },
		{ name: '--radius-surface', value: '10px', use: 'cards and sheets' }
	];

	/** The three variants the app actually uses, plus the states to inspect. */
	const BUTTONS = [
		{
			variant: 'default' as const,
			label: 'default',
			hover: 'bg-primary/80',
			active: 'bg-primary/80 translate-y-px',
			focus: 'ring-2 ring-ring'
		},
		{
			variant: 'outline' as const,
			label: 'outline',
			hover: 'bg-muted text-foreground',
			active: 'bg-muted text-foreground translate-y-px',
			focus: 'ring-2 ring-ring'
		},
		{
			variant: 'destructive' as const,
			label: 'destructive',
			hover: 'bg-destructive/20',
			active: 'bg-destructive/20 translate-y-px',
			focus: 'ring-2 ring-destructive'
		}
	];

	// --- table fixtures ------------------------------------------------------

	interface KitRow {
		key: string;
		name: string;
		state: StateChipState;
		size: number;
		reason: string;
	}

	const ROWS: KitRow[] = [
		{
			key: 'a',
			name: '[SubsPlease] Frieren - 01 (1080p) [F1A2B3C4].mkv',
			state: 'verified',
			size: 412_000_000,
			reason: ''
		},
		{
			key: 'b',
			name: '[SubsPlease] Frieren - 02 (1080p) [A1B2C3D4].mkv',
			state: 'copying',
			size: 398_000_000,
			reason: ''
		},
		{
			key: 'c',
			name: '[SubsPlease] Frieren - 03 (1080p) [B2C3D4E5].mkv',
			state: 'verifying',
			size: 421_000_000,
			reason: ''
		},
		{
			key: 'd',
			name: '[SubsPlease] Frieren - 04 (1080p) [C3D4E5F6].mkv',
			state: 'failed',
			size: 405_000_000,
			reason: 'device offline mid-file'
		},
		{
			key: 'e',
			name: '[SubsPlease] Frieren - 05 (1080p) [D4E5F6A7].mkv',
			state: 'queued',
			size: 433_000_000,
			reason: ''
		},
		{
			key: 'f',
			name: '[SubsPlease] Frieren - 06 (1080p) [E5F6A7B8].mkv',
			state: 'skipped',
			size: 410_000_000,
			reason: 'already on the drive'
		},
		{
			key: 'g',
			name: 'A.Very.Long.Release.Name.That.Keeps.Going.And.Going.1080p.WEB-DL.x264-GROUP.mkv',
			state: 'duplicate',
			size: 1_240_000_000,
			reason: 'byte-identical to the drive copy'
		}
	];

	const COLUMNS: TableColumn[] = [
		{ key: 'state', label: 'State' },
		{ key: 'name', label: 'Name' },
		{ key: 'size', label: 'Size', numeric: true },
		{ key: 'reason', label: 'Why' }
	];

	const PROOFS: Array<{ label: string; proof: ProofCounts; total: number }> = [
		{
			label: 'nothing has started',
			proof: { written: 0, verified: 0, deleted: 0, kept: 0 },
			total: 12
		},
		{
			label: 'mid-run, nothing deleted yet',
			proof: { written: 5, verified: 4, deleted: 0, kept: 0 },
			total: 12
		},
		{
			label: 'finished in delete-after-verify',
			proof: { written: 12, verified: 12, deleted: 11, kept: 1 },
			total: 12
		}
	];

	/** The two branches of the confirm gate, for the two destructive screens. */
	let moveOpen = $state(false);
	let purgeOpen = $state(false);

	const TRASH = '/media/node/2TB/.portage/trash/2026-11-08';
	const MOVED = [
		`/media/node/2TB/Videos/$Anime/Frieren/S01/[SubsPlease] Frieren - 01 (1080p) [F1A2B3C4] (1).mkv`,
		`/media/node/2TB/Videos/$Anime/Frieren/S01/[SubsPlease] Frieren - 04 (1080p) [C3D4E5F6] (1).mkv`
	];

	function handleConfirm(): void {
		moveOpen = false;
		purgeOpen = false;
		toast.success('Purged 12 files');
	}
</script>

<PageHeader
	title="Kitchen sink"
	summary="Every token and every shared component, for review. Not in the nav."
/>

<div class="flex flex-col gap-10 px-6 pb-16">
	<!-- type -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lead font-medium">Type scale</h2>
		<p class="measure text-body text-muted-foreground">
			Ratio about 1.2. One UI family in two weights; identifiers use the mono face.
		</p>
		<ul class="flex flex-col gap-1">
			{#each TYPES as type (type.name)}
				<li class="flex items-baseline gap-4">
					<span class="w-24 shrink-0 font-mono text-caption text-muted-foreground">
						{type.name}
					</span>
					<span class="w-16 shrink-0 font-mono text-caption text-muted-foreground">
						{type.size}
					</span>
					<span class={cn(type.cls, 'truncate text-foreground')}>
						36.4 MB/s · 8.1 GB · ETA 3 min 42 s
					</span>
				</li>
			{/each}
		</ul>
	</section>

	<!-- colour -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lead font-medium">Roles</h2>
		<p class="measure text-body text-muted-foreground">
			Light and dark side by side. Both are the same map; dark moves surfaces one step and
			desaturates, and is not an inversion.
		</p>
		<div class="grid gap-4 lg:grid-cols-2">
			{#each [{ label: 'Light', dark: false }, { label: 'Dark', dark: true }] as theme (theme.label)}
				<div
					class={cn(
						'rounded-[var(--radius-surface)] border border-border p-3',
						theme.dark && 'dark bg-background text-foreground'
					)}
				>
					<p class="mb-2 text-label text-muted-foreground">{theme.label}</p>
					<div class="grid grid-cols-3 gap-2">
						{#each ROLES as role (role)}
							<div class="flex flex-col gap-1">
								<div
									class="h-8 rounded-[var(--radius-control)] border border-border"
									style="background: var(--{role})"
								></div>
								<span class="truncate font-mono text-caption text-muted-foreground">
									{role}
								</span>
							</div>
						{/each}
					</div>
					<Separator class="my-3" />
					<div class="grid grid-cols-2 gap-2">
						{#each STATE_ROLES as role (role.name)}
							<div class="flex flex-col gap-1">
								<div
									class="flex h-8 items-center justify-center rounded-[var(--radius-control)] font-mono text-caption"
									style="background: var(--{role.name}); color: var(--{role.fg})"
								>
									{role.name} on {role.fg}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</section>

	<!-- motion and density -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lead font-medium">Motion and density</h2>
		<div class="grid gap-6 lg:grid-cols-2">
			<dl class="flex flex-col gap-1" data-numeric>
				{#each MOTION as row (row.name)}
					<div class="flex items-baseline gap-3">
						<dt class="w-40 shrink-0 font-mono text-label text-foreground">{row.name}</dt>
						<dd class="w-40 shrink-0 font-mono text-label text-muted-foreground">{row.value}</dd>
						<dd class="text-label text-muted-foreground">{row.use}</dd>
					</div>
				{/each}
			</dl>
			<dl class="flex flex-col gap-1" data-numeric>
				{#each DENSITY as row (row.name)}
					<div class="flex items-baseline gap-3">
						<dt class="w-40 shrink-0 font-mono text-label text-foreground">{row.name}</dt>
						<dd class="w-24 shrink-0 font-mono text-label text-muted-foreground">{row.value}</dd>
						<dd class="text-label text-muted-foreground">{row.use}</dd>
					</div>
				{/each}
			</dl>
		</div>
	</section>

	<!-- buttons -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lead font-medium">Buttons</h2>
		<div class="overflow-x-auto">
			<table class="border-separate border-spacing-2">
				<thead>
					<tr>
						<th scope="col" class="text-left text-label text-muted-foreground">variant</th>
						{#each ['default', 'hover (applied)', 'focus (applied)', 'active (applied)', 'disabled', 'loading'] as head (head)}
							<th scope="col" class="text-left text-label text-muted-foreground">{head}</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each BUTTONS as spec (spec.variant)}
						<tr>
							<td class="font-mono text-label text-foreground">{spec.label}</td>
							<td>
								<Button variant={spec.variant} class={CONTROL} size="sm">Pull</Button>
							</td>
							<td>
								<Button variant={spec.variant} class={cn(CONTROL, spec.hover)} size="sm">
									Pull
								</Button>
							</td>
							<td>
								<Button variant={spec.variant} class={cn(CONTROL, spec.focus)} size="sm">
									Pull
								</Button>
							</td>
							<td>
								<Button variant={spec.variant} class={cn(CONTROL, spec.active)} size="sm">
									Pull
								</Button>
							</td>
							<td>
								<Button variant={spec.variant} class={CONTROL} size="sm" disabled>Pull</Button>
							</td>
							<td>
								<Button variant={spec.variant} class={CONTROL} size="sm" disabled aria-busy="true">
									Working
								</Button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="measure text-label text-muted-foreground">
			The applied columns reuse the same utilities the variant applies on that state, because a
			pointer and a keypress cannot be staged from markup.
		</p>
	</section>

	<!-- chips, badges, hints -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lead font-medium">State chips</h2>
		<p class="measure text-body text-muted-foreground">
			Glyph and word always; colour repeats the meaning and is never the only carrier of it.
		</p>
		<div class="flex flex-wrap items-center gap-2">
			{#each CHIP_STATES as state (state)}
				<StateChip {state} />
			{/each}
		</div>
		<div class="flex flex-wrap items-center gap-2">
			{#each CHIP_STATES as state (state)}
				<StateChip {state} solid />
			{/each}
		</div>
		<div class="flex flex-wrap items-center gap-3">
			<Badge>badge</Badge>
			<Badge variant="secondary">secondary</Badge>
			<Badge variant="destructive">destructive</Badge>
			<KeyHint keys="space" label="pause" />
			<KeyHint keys="g" label="then a letter" />
		</div>
	</section>

	<!-- form primitives -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lead font-medium">Inputs</h2>
		<div class="flex flex-wrap items-end gap-6">
			<div class="flex flex-col gap-2">
				<Label for="kit-name">Device label</Label>
				<Input id="kit-name" class={CONTROL} value="Pixel 10 Pro XL" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="kit-bad">Invalid</Label>
				<Input id="kit-bad" class={CONTROL} aria-invalid="true" value="09" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="kit-off">Locked by an env var</Label>
				<Input id="kit-off" class={CONTROL} value="3" disabled />
			</div>
			<div class="flex items-center gap-2">
				<Checkbox id="kit-check" checked />
				<Label for="kit-check">Include already-present</Label>
			</div>
			<div class="flex flex-col gap-2">
				<Label for="kit-select">Verify</Label>
				<Select type="single" value="standard">
					<SelectTrigger id="kit-select" class={cn(CONTROL, 'w-40')}>
						<SelectValue placeholder="Choose" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="standard">standard</SelectItem>
						<SelectItem value="paranoid">paranoid</SelectItem>
					</SelectContent>
				</Select>
			</div>
		</div>

		<Tabs value="tier1" class="w-full max-w-sm">
			<TabsList>
				<TabsTrigger value="tier1">Tier 1 · identical</TabsTrigger>
				<TabsTrigger value="tier2">Tier 2 · same episode</TabsTrigger>
			</TabsList>
			<TabsContent value="tier1" class="pt-3 text-body text-muted-foreground">
				Tier 1 arrives ticked: those members are byte-identical.
			</TabsContent>
			<TabsContent value="tier2" class="pt-3 text-body text-muted-foreground">
				Tier 2 never arrives ticked: same episode, different release is a taste decision.
			</TabsContent>
		</Tabs>
	</section>

	<!-- surfaces -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lead font-medium">Surfaces</h2>
		<div class="grid gap-4 lg:grid-cols-3">
			<Card class="rounded-[var(--radius-surface)] shadow-none">
				<CardHeader>
					<CardTitle class="text-body font-medium">A card</CardTitle>
				</CardHeader>
				<CardContent class="text-body text-muted-foreground">
					Cards exist for a device summary, a duplicate group and a doctor check. Nothing else.
				</CardContent>
			</Card>
			<Card class={cn('rounded-[var(--radius-surface)] shadow-none', 'bg-muted')}>
				<CardHeader>
					<CardTitle class="text-body font-medium">Sunken</CardTitle>
				</CardHeader>
				<CardContent class="text-body text-muted-foreground">
					The ladder's third step, used for wells and table zebra.
				</CardContent>
			</Card>
			<div class="flex flex-col gap-3">
				<Progress value={62} max={100} />
				<Skeleton class="h-3 w-40 rounded-[var(--radius-control)]" />
				<ScrollArea class="h-20 rounded-[var(--radius-control)] border border-border p-2">
					<p class="text-body text-muted-foreground">
						A scroll area with enough text to make the scrollbar appear, so its contrast can be
						measured in both themes.
					</p>
				</ScrollArea>
			</div>
		</div>
	</section>

	<!-- overlays -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lead font-medium">Overlays</h2>
		<div class="flex flex-wrap items-center gap-3">
			<Dialog>
				<DialogTrigger>
					{#snippet child({ props })}
						<Button {...props} class={CONTROL} size="sm" variant="outline">Dialog</Button>
					{/snippet}
				</DialogTrigger>
				<DialogContent class="rounded-[var(--radius-surface)]">
					<DialogHeader>
						<DialogTitle class="text-title font-medium tracking-normal normal-case">
							A dialog
						</DialogTitle>
						<DialogDescription class="text-body text-muted-foreground">
							Focus is trapped inside, Escape leaves it, and focus returns to this button.
						</DialogDescription>
					</DialogHeader>
				</DialogContent>
			</Dialog>

			<Button class={CONTROL} size="sm" variant="outline" onclick={() => (moveOpen = true)}>
				Confirm sheet: move
			</Button>
			<Button class={CONTROL} size="sm" variant="destructive" onclick={() => (purgeOpen = true)}>
				Confirm sheet: purge
			</Button>

			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger>
						{#snippet child({ props })}
							<Button {...props} class={CONTROL} size="sm" variant="ghost">Tooltip</Button>
						{/snippet}
					</TooltipTrigger>
					<TooltipContent>A tooltip is not a label.</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		</div>
	</section>

	<!-- feedback -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lead font-medium">Feedback</h2>
		<div class="flex flex-wrap items-center gap-3">
			<Button
				class={CONTROL}
				size="sm"
				variant="outline"
				onclick={() => toast.info('The drive was unplugged.')}
			>
				Info toast
			</Button>
			<Button
				class={CONTROL}
				size="sm"
				variant="outline"
				onclick={() => toast.warning('The link dropped to USB 2 speeds.')}
			>
				Warn toast
			</Button>
			<Button
				class={CONTROL}
				size="sm"
				variant="outline"
				onclick={() =>
					toast.error('The engine stopped.', {
						action: { label: 'Restart engine', onClick: () => toast.success('Restarting') }
					})}
			>
				Error toast with one action
			</Button>
		</div>

		<ErrorBand
			what="The phone stopped answering mid-file."
			means="The copy on the drive is incomplete and was not verified, so nothing was deleted."
			todo="Reconnect the cable and pull again; it resumes at that file."
			code={null}
		/>

		<SkeletonRows rows={3} label="Reading the phone" />

		<EmptyState
			title="Nothing new on this phone"
			body="23 files are already on the drive."
			action="Review what is still on the phone"
		/>
	</section>

	<!-- proof strip -->
	<section class="flex flex-col gap-4">
		<h2 class="text-lead font-medium">Proof strip</h2>
		<p class="measure text-body text-muted-foreground">
			Four counters that only go up, on one line that fills left to right. Each counter has a tick
			at its own position. Reduced motion keeps the change and drops the animation.
		</p>
		<div class="grid gap-6 lg:grid-cols-3">
			{#each PROOFS as entry (entry.label)}
				<div class="flex flex-col gap-2">
					<p class="text-label text-muted-foreground">{entry.label}</p>
					<ProofStrip proof={entry.proof} total={entry.total} />
				</div>
			{/each}
		</div>
	</section>

	<!-- chart pattern -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lead font-medium">Chart pattern</h2>
		<p class="measure text-body text-muted-foreground">
			The shape every chart follows: a sentence above it, the drawing, and the same numbers in a
			table behind a disclosure. The charts themselves arrive with the screens.
		</p>
		<figure class="flex w-full max-w-2xl flex-col gap-2">
			<figcaption class="text-body text-muted-foreground">
				36.4 MB/s average, down from 40.8.
			</figcaption>
			<svg class="h-32 w-full" viewBox="0 0 320 80" role="img" aria-hidden="true">
				<line x1="0" y1="79" x2="320" y2="79" class="stroke-border" stroke-width="1" />
				{#each [40.8, 39.2, 41.1, 38.4, 37.0, 38.8, 36.4] as value, index (index)}
					<rect
						x={index * 46 + 4}
						y={79 - ((value - 30) / 15) * 70}
						width="36"
						height={((value - 30) / 15) * 70}
						style="fill: var(--chart-1)"
					/>
				{/each}
			</svg>
			<details class="text-body">
				<summary class="cursor-pointer text-label text-muted-foreground">
					The same numbers as a table
				</summary>
				<table class="mt-2 w-full text-label">
					<caption class="sr-only">Average throughput per run</caption>
					<thead>
						<tr>
							<th scope="col" class="text-left text-muted-foreground">Run</th>
							<th scope="col" class="text-right text-muted-foreground">Average</th>
						</tr>
					</thead>
					<tbody>
						{#each [40.8, 39.2, 41.1, 38.4, 37.0, 38.8, 36.4] as value, index (index)}
							<tr>
								<td class="text-left text-foreground">-{7 - index}</td>
								<td class="text-right text-foreground" data-numeric>{value} MB/s</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
		</figure>
	</section>

	<!-- table -->
	<section class="flex flex-col gap-3">
		<h2 class="text-lead font-medium">Table</h2>
		<p class="measure text-body text-muted-foreground">
			Sticky header, right-aligned tabular numerals, rows you can reach with Tab and move between
			with the arrow keys, and an empty state that differs from a filtered one.
		</p>
		<div class="flex flex-col gap-4">
			<DataTable
				columns={COLUMNS}
				rows={ROWS}
				rowKey={(item) => item.key}
				caption="Kitchen sink rows, nothing filtered"
				class="h-80"
			>
				{#snippet row(item)}
					<td role="gridcell"><StateChip state={item.state} /></td>
					<td role="gridcell" class="max-w-md truncate font-medium text-foreground">
						{item.name}
					</td>
					<td role="gridcell" class="text-right font-mono text-foreground tabular-nums">
						{formatBytes(item.size)}
					</td>
					<td role="gridcell" class="text-muted-foreground">{item.reason}</td>
				{/snippet}
			</DataTable>

			<div class="grid gap-4 lg:grid-cols-3">
				<DataTable
					columns={COLUMNS}
					rows={[]}
					rowKey={(item: KitRow) => item.key}
					caption="Kitchen sink rows, an empty phone"
					class="h-40"
				>
					{#snippet empty()}
						<EmptyState
							title="Nothing new on this phone"
							body="23 files are already on the drive."
							action="Review what is still on the phone"
						/>
					{/snippet}
				</DataTable>

				<DataTable
					columns={COLUMNS}
					rows={[]}
					rowKey={(item: KitRow) => item.key}
					caption="Kitchen sink rows, filtered to nothing by show=frieren-99"
					filtered
					class="h-40"
				>
					{#snippet filteredEmpty()}
						<EmptyState
							title="No file matches this filter"
							body="23 files are on this phone; none of them match “frieren-99”."
							action="Clear filters"
						/>
					{/snippet}
				</DataTable>

				<DataTable
					columns={COLUMNS}
					rows={[]}
					rowKey={(item: KitRow) => item.key}
					caption="Kitchen sink rows, still reading the phone"
					loading
					skeletonRows={4}
					class="h-40"
				/>
			</div>
		</div>
	</section>
</div>

<ConfirmSheet
	bind:open={moveOpen}
	title="Move 2 files to the trash"
	action="dupes.apply"
	paths={MOVED}
	count={MOVED.length}
	bytes={817_000_000}
	trashDir={TRASH}
	confirmWord="move"
	onconfirm={handleConfirm}
	oncancel={() => (moveOpen = false)}
/>

<ConfirmSheet
	bind:open={purgeOpen}
	title="Purge 3 files"
	action="purge.apply"
	paths={[
		'/sdcard/Download/Anime/Frieren/S01/[SubsPlease] Frieren - 01 (1080p) [F1A2B3C4].mkv',
		'/sdcard/Download/Anime/Frieren/S01/[SubsPlease] Frieren - 02 (1080p) [A1B2C3D4].mkv',
		'/sdcard/Download/Anime/Frieren/S01/[SubsPlease] Frieren - 03 (1080p) [B2C3D4E5].mkv'
	]}
	count={3}
	bytes={1_231_000_000}
	confirmWord="purge"
	onconfirm={handleConfirm}
	oncancel={() => (purgeOpen = false)}
/>
