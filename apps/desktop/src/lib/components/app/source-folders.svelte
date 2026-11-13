<script lang="ts">
	/**
	 * Which folders on a phone a pull copies from.
	 *
	 * The engine never guesses a source, so a phone with no roots makes an
	 * empty plan and a run that reports success having copied nothing. The
	 * consequence sentence therefore sits beside the list, not in a hint.
	 *
	 * The browser reads the `browse` FRAME, never the answer: the engine writes
	 * the frame before it answers, and the answer's `entries` is a count — the
	 * same mistake that once made a destination change read `undefined`.
	 *
	 * Focus trapping, Escape and focus returning to the trigger all come from
	 * the shadcn Dialog primitives (bits-ui), not from hand-rolled keys.
	 */
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Folder from '@lucide/svelte/icons/folder';
	import { onMount } from 'svelte';

	import type { BrowseEntry, DeviceInfo } from '../../engine/protocol.ts';
	import { app } from '../../state/app.svelte.ts';
	import { plural } from '../../util/format.ts';
	import { cn } from '../../utils.ts';
	import { Button } from '../ui/button/index.js';
	import { ScrollArea } from '../ui/scroll-area/index.js';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogFooter,
		DialogHeader,
		DialogTitle
	} from '../ui/dialog/index.js';
	import EmptyState from './empty-state.svelte';
	import ErrorBand from './error-band.svelte';
	import SkeletonRows from './skeleton-rows.svelte';
	import {
		PHONE_ROOT,
		addRoot,
		breadcrumb,
		describeConsequence,
		dirEntries,
		normalizePath,
		parentPath,
		removeRoot,
		replaceRoot,
		rootVerdict,
		rootsSentence
	} from './source-folders.ts';
	import { CONTROL } from './tokens.ts';
	import { failureBand, type Band } from './transfer-band.ts';

	let {
		device,
		roots,
		busy,
		onchange
	}: {
		device: DeviceInfo;
		roots: string[];
		busy: boolean;
		onchange: (roots: string[]) => void;
	} = $props();

	let open = $state(false);
	let path = $state<string>(PHONE_ROOT);
	let entries = $state<BrowseEntry[]>([]);
	let total = $state(0);
	let truncated = $state(false);
	let loading = $state(false);
	let failure = $state<Band | null>(null);

	/** The path the newest request asked for; a frame is matched against it. */
	let asked = PHONE_ROOT;
	let ticket = 0;

	const folders = $derived(dirEntries(entries));
	const up = $derived(parentPath(path));
	/** What adding this folder would do, so the button and its reason agree. */
	const verdict = $derived(rootVerdict(roots, path));
	const notice = $derived.by(() => {
		const said = verdict;
		if (said.kind === 'already') return 'This folder is already in the list.';
		if (said.kind === 'covered') return `A pull from ${said.by} already copies everything here.`;
		if (said.kind === 'replaces') {
			return `This folder contains ${said.roots.join(', ')}, already in the list. Using it replaces ${
				said.roots.length === 1 ? 'that folder' : 'those folders'
			}.`;
		}
		return null;
	});
	const canUse = $derived(
		!busy && !loading && (verdict.kind === 'free' || verdict.kind === 'replaces')
	);

	onMount(() =>
		app.observeFrame((frame) => {
			if (frame.type !== 'browse') return;
			if (normalizePath(frame.path) !== asked) return;
			entries = frame.entries;
			total = frame.total;
			truncated = frame.truncated;
		})
	);

	async function load(target: string): Promise<void> {
		const mine = ++ticket;
		path = target;
		asked = normalizePath(target);
		loading = true;
		failure = null;
		try {
			await app.port.send('browse', { device: device.id, path: asked });
		} catch (error) {
			if (mine === ticket) failure = failureBand(error, 'plan');
		} finally {
			if (mine === ticket) loading = false;
		}
	}

	function browse(): void {
		open = true;
		path = PHONE_ROOT;
		entries = [];
		total = 0;
		truncated = false;
		void load(PHONE_ROOT);
	}

	function use(): void {
		const next =
			verdict.kind === 'free'
				? addRoot(roots, path)
				: verdict.kind === 'replaces'
					? replaceRoot(roots, path)
					: roots;
		if (next !== roots) onchange(next);
		open = false;
	}

	function drop(target: string): void {
		const next = removeRoot(roots, target);
		if (next !== roots) onchange(next);
	}
</script>

<div class="flex flex-col gap-3">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="text-label text-muted-foreground" data-numeric>{rootsSentence(roots)}</p>
		<Button variant="outline" size="sm" class={CONTROL} disabled={busy} onclick={browse}>
			Add a folder
		</Button>
	</div>

	<p class="measure text-body text-foreground" class:font-medium={roots.length === 0}>
		{describeConsequence(roots)}
	</p>

	{#if roots.length > 0}
		<ul class="divide-y divide-border rounded-surface border border-border">
			{#each roots as root (root)}
				<li class="flex items-center gap-3 px-3 py-2">
					<span class="min-w-0 flex-1 truncate font-mono text-body text-foreground" title={root}>
						{root}
					</span>
					<Button
						variant="outline"
						size="sm"
						class={CONTROL}
						disabled={busy}
						aria-label={`Stop copying from ${root}`}
						onclick={() => drop(root)}
					>
						Remove
					</Button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<Dialog bind:open>
	<DialogContent class="max-h-[85dvh] overflow-y-auto rounded-surface shadow-lg sm:max-w-xl">
		<DialogHeader class="gap-2">
			<DialogTitle class="text-title font-medium tracking-normal normal-case">
				Add a folder
			</DialogTitle>
			<DialogDescription class="measure text-body text-muted-foreground">
				Choose a folder on the phone. A pull copies every file underneath it, so pick the folder
				that holds what you want rather than one level above it.
			</DialogDescription>
		</DialogHeader>

		<div class="flex flex-col gap-1">
			<p class="font-mono text-label break-all text-foreground" data-path>{path}</p>
			<p class="text-caption text-muted-foreground">
				{#each breadcrumb(path) as crumb, index (crumb.path)}
					{#if index > 0}<span aria-hidden="true"> / </span>{/if}<span>{crumb.label}</span>
				{/each}
			</p>
		</div>

		{#if failure}
			<ErrorBand
				what={failure.what}
				means={failure.means}
				todo={failure.todo}
				code={failure.code}
			/>
		{:else}
			<div class="flex flex-col gap-2">
				{#if loading}
					<SkeletonRows rows={4} label="Reading folders" />
				{:else if folders.length === 0}
					<EmptyState
						class="px-0 py-6"
						title="No folders here"
						body="There is nothing underneath this folder to pick. Go up, or use this folder itself."
					/>
				{:else}
					<ScrollArea
						type="auto"
						orientation="horizontal"
						class="max-h-[42vh] rounded-surface border border-border"
					>
						<ul class="divide-y divide-border">
							{#each folders as folder (folder.path)}
								<li>
									<button
										type="button"
										class={cn(
											CONTROL,
											'flex w-full items-center gap-2 px-3 py-2 text-left text-body text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none'
										)}
										onclick={() => void load(folder.path)}
									>
										<Folder class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
										<span class="truncate font-mono">{folder.name}</span>
									</button>
								</li>
							{/each}
						</ul>
					</ScrollArea>
				{/if}

				{#if folders.length > 0 || truncated}
					<p class="text-caption text-muted-foreground">
						{truncated
							? `More entries than the engine lists at once, so some folders are missing. ${plural(total, 'entry', 'entries')} in this folder.`
							: `${plural(folders.length, 'folder')} in this folder.`}
					</p>
				{/if}
			</div>
		{/if}

		<DialogFooter class="mt-1 gap-2 sm:justify-between">
			<div class="flex items-center gap-2">
				{#if up !== path}
					<Button
						variant="outline"
						size="sm"
						class={CONTROL}
						disabled={loading}
						onclick={() => void load(up)}
					>
						<ArrowUp class="size-3.5" aria-hidden="true" />
						Up
					</Button>
				{/if}
				<Button variant="outline" size="sm" class={CONTROL} onclick={() => (open = false)}>
					Cancel
				</Button>
			</div>
			<div class="flex flex-col items-end gap-1">
				{#if notice}
					<p class="measure text-right text-caption text-muted-foreground">{notice}</p>
				{/if}
				<Button variant="default" size="sm" class={CONTROL} disabled={!canUse} onclick={use}>
					Use this folder
				</Button>
			</div>
		</DialogFooter>
	</DialogContent>
</Dialog>
