<script lang="ts">
	/**
	 * Copy one string to the clipboard, and say so for a moment.
	 *
	 * The window is a Tauri webview: `navigator.clipboard.writeText` works, but
	 * only inside a real click, because WebKit refuses it without user activation.
	 * This button is that click. A refusal is reported rather than swallowed,
	 * since a copy button that silently does nothing is worse than no button.
	 */
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';

	import { app } from '../../state/app.svelte.ts';
	import { cn } from '../../utils.ts';

	let {
		value,
		label = 'Copy',
		class: className
	}: { value: string; label?: string; class?: string } = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 1200);
		} catch {
			app.pushNotice('error', 'The clipboard refused that copy.');
		}
	}
</script>

<button
	type="button"
	aria-label={`${label}: ${value}`}
	title={`${label}: ${value}`}
	class={cn(
		'inline-flex size-5 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
		className
	)}
	onclick={() => void copy()}
>
	{#if copied}
		<Check class="size-3.5 text-state-verified" aria-hidden="true" />
		<span class="sr-only">Copied</span>
	{:else}
		<Copy class="size-3.5" aria-hidden="true" />
		<span class="sr-only">Copy</span>
	{/if}
</button>
