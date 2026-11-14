<script lang="ts">
	/**
	 * The one gate in front of a destructive act, and the only thing in the app
	 * that floats: it names every path, the trash directory, and the total, and
	 * it will not run until the person types the button's own word.
	 *
	 * Built on shadcn's `AlertDialog`, not `Dialog`. An alert dialog is
	 * role="alertdialog", it does not close on an outside click, and its initial
	 * focus lands on Cancel — all three are what "this deletes files" means, and
	 * all three would have to be re-earned by hand on a plain dialog.
	 *
	 * The paths here are the engine's own strings from its `needsConfirm`
	 * payload, so what the sheet shows and what moves are the same list.
	 */
	import {
		AlertDialog,
		AlertDialogContent,
		AlertDialogDescription,
		AlertDialogFooter,
		AlertDialogHeader,
		AlertDialogTitle
	} from '../ui/alert-dialog/index.js';
	import { Button } from '../ui/button/index.js';
	import { Input } from '../ui/input/index.js';
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
		oncancel
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
			: `${plural(count, 'file')} · ${formatBytes(bytes)} leave the phone. The drive copies are untouched.`
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

<AlertDialog bind:open onOpenChange={handleOpenChange}>
	<AlertDialogContent class="gap-4 rounded-surface p-6 shadow-lg sm:max-w-xl">
		<AlertDialogHeader class="gap-2">
			<AlertDialogTitle class="text-title font-medium tracking-normal text-foreground normal-case">
				{title}
			</AlertDialogTitle>
			<AlertDialogDescription class="measure text-body text-muted-foreground">
				{sentence}
			</AlertDialogDescription>
		</AlertDialogHeader>

		<div class="flex flex-col gap-1">
			<p class="text-label text-muted-foreground">
				{paths.length === count ? 'Every path' : `Showing ${paths.length} of ${count}`}
			</p>
			<ul class="max-h-[38vh] overflow-y-auto rounded-control border border-border bg-muted/40 p-2">
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
				<Input
					id="confirm-word"
					name="confirm-word"
					class="h-8 w-48 rounded-control border border-input bg-background font-mono text-body"
					autocomplete="off"
					spellcheck="false"
					aria-invalid={typed.trim() !== '' && !matches}
					bind:value={typed}
				/>
			</label>

			<AlertDialogFooter class="mt-1 gap-2 sm:justify-end">
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
			</AlertDialogFooter>
		</form>
	</AlertDialogContent>
</AlertDialog>
