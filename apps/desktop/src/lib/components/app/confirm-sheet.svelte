<script lang="ts">
	/**
	 * The one gate in front of a destructive act, and the only thing in the app
	 * that floats: it names every path, the trash directory, and the total, and
	 * it will not run until the person types the button's own word.
	 *
	 * The paths here are the engine's own strings from its `needsConfirm`
	 * payload, so what the sheet shows and what moves are the same list.
	 *
	 * Focus trapping, Escape, the dialog role and focus returning to the trigger
	 * all come from the shadcn Dialog primitives (bits-ui), not from hand-rolled
	 * key handling.
	 */
	import { Button } from '../ui/button/index.js';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogFooter,
		DialogHeader,
		DialogTitle,
	} from '../ui/dialog/index.js';
	import { formatBytes, plural, truncateFront } from '../../util/format.ts';
	import { CONTROL } from './tokens.ts';

	let {
		open = $bindable(false),
		title,
		action,
		paths,
		count,
		bytes,
		trashDir = null,
		/** The word the person must type: the button's own word, lowercase. */
		confirmWord,
		busy = false,
		onconfirm,
		oncancel,
	}: {
		open?: boolean;
		title: string;
		action: 'dupes.apply' | 'purge.apply';
		paths: string[];
		count: number;
		bytes: number;
		trashDir?: string | null;
		confirmWord: string;
		busy?: boolean;
		onconfirm: (typed: string) => void;
		oncancel: () => void;
	} = $props();

	let typed = $state('');

	const word = $derived(confirmWord.trim().toLowerCase());
	const matches = $derived(typed.trim().toLowerCase() === word);
	// `count` and `bytes` come from the engine's payload; `paths` is listed in
	// full below, so the sentence only has to carry the scale.
	const sentence = $derived(
		action === 'dupes.apply'
			? `${plural(count, 'file')} · ${formatBytes(bytes)} move to ${trashDir ?? 'the trash folder'}.`
			: `${plural(count, 'file')} · ${formatBytes(bytes)} are deleted from the phone. The drive copies are untouched.`
	);

	function handleOpenChange(next: boolean): void {
		if (!next && !busy) oncancel();
	}

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		if (!matches || busy) return;
		onconfirm(typed.trim());
	}
</script>

<Dialog bind:open onOpenChange={handleOpenChange}>
	<DialogContent
		showCloseButton={false}
		class="rounded-[var(--radius-surface)] shadow-lg sm:max-w-xl"
	>
		<DialogHeader class="gap-2">
			<DialogTitle class="text-title font-medium normal-case tracking-normal">{title}</DialogTitle>
			<DialogDescription class="measure text-body text-muted-foreground">
				{sentence}
			</DialogDescription>
		</DialogHeader>

		<div class="flex flex-col gap-1">
			<p class="text-label text-muted-foreground">
				{paths.length === count ? 'Every path' : `Showing ${paths.length} of ${count}`}
			</p>
			<ul
				class="max-h-[38vh] overflow-y-auto rounded-[var(--radius-control)] border border-border bg-muted/40 p-2"
			>
				{#each paths as path (path)}
					<li class="font-mono text-label break-all text-foreground" title={path}>
						{truncateFront(path, 96)}
					</li>
				{/each}
			</ul>
		</div>

		{#if trashDir}
			<p class="text-body text-muted-foreground" data-numeric>
				Where they go: <span class="font-mono text-label text-foreground">{trashDir}</span>
			</p>
		{/if}

		<form class="flex flex-col gap-2" onsubmit={submit}>
			<label class="flex flex-col gap-1" for="confirm-word">
				<span class="text-label text-muted-foreground">
					Type <span class="font-mono text-foreground">{word}</span> to continue
				</span>
				<input
					id="confirm-word"
					name="confirm-word"
					class="h-8 w-48 rounded-[var(--radius-control)] border border-input bg-background px-2 font-mono text-body text-foreground outline-none focus-visible:border-ring"
					autocomplete="off"
					spellcheck="false"
					bind:value={typed}
				/>
			</label>

			<DialogFooter class="mt-1 gap-2 sm:justify-end">
				<Button
					variant="outline"
					class={CONTROL}
					size="sm"
					disabled={busy}
					onclick={() => oncancel()}
				>
					Cancel
				</Button>
				<Button
					variant="destructive"
					class={CONTROL}
					size="sm"
					type="submit"
					disabled={!matches || busy}
				>
					{busy ? 'Working' : confirmWord}
				</Button>
			</DialogFooter>
		</form>
	</DialogContent>
</Dialog>
