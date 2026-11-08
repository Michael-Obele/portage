<script lang="ts">
	/**
	 * The Plan screen's filters, as one bar.
	 *
	 * Three things this fixes, all of them visible:
	 *
	 *  1. **It was a card of six outlined boxes**, which ate half the window and
	 *     left the table in the remainder. Filters are chrome; the data is the
	 *     screen, so the chrome gets one row.
	 *  2. **Four separate borders is not a segmented control.** The time window
	 *     is one decision with four answers, so it is one track with one moving
	 *     fill.
	 *  3. **The shipped toggle style is uppercase and wide-tracked** (the `sera`
	 *     template). Sentence case, normal tracking: the app does not shout.
	 *
	 * The text filter still submits on Enter, not per keystroke: a `plan` walks
	 * the whole phone, and one adb walk per character to answer one question is
	 * how a filter becomes a stall.
	 */
	import { Search, X } from '@lucide/svelte';

	import type { DeviceInfo } from '../../engine/protocol.ts';
	import { cn } from '../../utils.ts';
	import { Button } from '../ui/button/index.js';
	import { Input } from '../ui/input/index.js';
	import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select/index.js';
	import { Switch } from '../ui/switch/index.js';
	import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group/index.js';
	import {
		ALL_DEVICES,
		deviceLabel,
		filtersActive,
		type PlanFilters,
		type SinceWindow
	} from './plan-filters.ts';
	import { CONTROL } from './tokens.ts';

	let {
		filters,
		devices,
		showDraft,
		busy,
		onshowdraft,
		onsubmit,
		ondevice,
		onsince,
		onoverwrite,
		onclear,
		class: className
	}: {
		filters: PlanFilters;
		devices: DeviceInfo[];
		/** The un-submitted text, so a typed filter is not sent until Enter. */
		showDraft: string;
		busy: boolean;
		onshowdraft: (value: string) => void;
		onsubmit: () => void;
		ondevice: (id: string) => void;
		onsince: (window: SinceWindow) => void;
		onoverwrite: (on: boolean) => void;
		onclear: () => void;
		class?: string;
	} = $props();

	const TRIGGER = cn(
		CONTROL,
		'h-8 w-full justify-between rounded-[var(--radius-control)] border border-input bg-transparent px-2.5'
	);

	const ready = $derived(devices.filter((device) => device.state === 'device'));
	const active = $derived(filtersActive(filters));

	/**
	 * The triggers render their own labels rather than `Select.Value`.
	 *
	 * bits-ui can only name the selected item once its content has been mounted
	 * at least once, so before the first open the trigger falls back to the raw
	 * value, which is how a device id leaks into a control labelled in English.
	 */
	const deviceText = $derived.by(() => {
		if (filters.device === ALL_DEVICES) return 'Any device';
		const device = devices.find((entry) => entry.id === filters.device);
		return device === undefined ? filters.device : deviceLabel(device);
	});

	/** Short labels: a segmented control has no room for prose. */
	const WINDOWS: ReadonlyArray<{ value: SinceWindow; label: string; title: string }> = [
		{ value: 'all', label: 'All', title: 'Any time' },
		{ value: '1d', label: '1d', title: 'Modified in the last day' },
		{ value: '7d', label: '7d', title: 'Modified in the last week' },
		{ value: '30d', label: '30d', title: 'Modified in the last 30 days' }
	];
</script>

<form
	class={cn('flex flex-wrap items-center gap-2 border-b border-border px-6 py-2', className)}
	aria-label="Plan filters"
	onsubmit={(event) => {
		event.preventDefault();
		onsubmit();
	}}
>
	<div class="relative">
		<Search
			class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
			aria-hidden="true"
		/>
		<Input
			class={cn(CONTROL, 'h-8 w-44 border-input pr-7 pl-7')}
			placeholder="Filter names"
			aria-label="Filter files by name, then press Enter"
			title="Press Enter to apply"
			value={showDraft}
			oninput={(event) => onshowdraft(event.currentTarget.value)}
		/>
		{#if showDraft.length > 0}
			<button
				type="button"
				class="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer rounded-[var(--radius-control)] p-0.5 text-muted-foreground transition-colors hover:text-foreground"
				aria-label="Clear the name filter"
				onclick={() => {
					onshowdraft('');
					onsubmit();
				}}
			>
				<X class="size-3.5" aria-hidden="true" />
			</button>
		{/if}
	</div>

	<span class="h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>

	<Select
		type="single"
		value={filters.device}
		onValueChange={(value) => ondevice(value ?? ALL_DEVICES)}
	>
		<SelectTrigger class={cn(TRIGGER, 'w-36')} aria-label="Device">
			<span class="truncate">{deviceText}</span>
		</SelectTrigger>
		<SelectContent>
			<SelectItem value={ALL_DEVICES} label="Any device">Any device</SelectItem>
			{#each ready as device (device.id)}
				<SelectItem value={device.id} label={deviceLabel(device)}>
					{deviceLabel(device)}
				</SelectItem>
			{/each}
		</SelectContent>
	</Select>

	<!-- One track, one moving fill. `variant="default"` keeps the items
	     borderless so the group reads as a single control. -->
	<ToggleGroup
		type="single"
		value={filters.since}
		spacing={0}
		aria-label="Modified window"
		class="h-8 gap-0 rounded-[var(--radius-control)] bg-muted p-0.5"
		onValueChange={(value) => {
			if (value) onsince(value as SinceWindow);
		}}
	>
		{#each WINDOWS as option (option.value)}
			<ToggleGroupItem
				value={option.value}
				class="h-7 min-w-0 rounded-[calc(var(--radius-control)-2px)] px-2 text-label tracking-normal normal-case data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-none"
				title={option.title}
			>
				{option.label}
			</ToggleGroupItem>
		{/each}
	</ToggleGroup>

	<div class="ml-auto flex items-center gap-2">
		<label
			class="flex cursor-pointer items-center gap-1.5 text-label whitespace-nowrap text-muted-foreground"
		>
			<Switch
				checked={filters.overwrite}
				onCheckedChange={onoverwrite}
				aria-label="Re-copy existing files"
			/>
			Re-copy
		</label>

		{#if active}
			<Button
				type="button"
				variant="ghost"
				size="sm"
				class={cn(CONTROL, 'h-8 px-2')}
				disabled={busy}
				onclick={onclear}
			>
				Clear
			</Button>
		{/if}
	</div>
</form>
