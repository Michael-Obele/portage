<script lang="ts">
	/**
	 * The toast region: engine `notice` frames plus local confirmations.
	 *
	 * Bottom right, three at a time, dismissible, and at most ONE action each —
	 * a toast offering two choices is a dialog wearing the wrong clothes.
	 *
	 * sonner is the renderer; `app.notices` is the model. This mirrors the model
	 * into sonner by id, so a notice that is dismissed in either place is gone
	 * from both rather than reappearing.
	 */
	import { toast, type ExternalToast } from 'svelte-sonner';
	import type { Notice } from '../../state/app.svelte.ts';
	import { Toaster } from '../ui/sonner/index.js';

	let {
		notices,
		ondismiss,
		theme = 'system',
		density = 'comfortable',
	}: {
		notices: Notice[];
		ondismiss: (id: number) => void;
		theme?: 'light' | 'dark' | 'system';
		density?: 'comfortable' | 'compact';
	} = $props();

	// Not `$state`: this is a de-duplication ledger, not something to render, and
	// making it reactive would re-run the effect that fills it.
	const mirrored = new Set<number>();

	$effect(() => {
		for (const notice of notices) {
			if (mirrored.has(notice.id)) continue;
			mirrored.add(notice.id);

			const options: ExternalToast = {
				id: String(notice.id),
				onDismiss: () => ondismiss(notice.id),
			};
			if (notice.action) {
				options.action = {
					label: notice.action.label,
					onClick: () => notice.action?.run(),
				};
			}

			if (notice.level === 'error') toast.error(notice.message, options);
			else if (notice.level === 'warn') toast.warning(notice.message, options);
			else toast.info(notice.message, options);
		}
	});
</script>

<Toaster
	{theme}
	position="bottom-right"
	visibleToasts={3}
	closeButton
	richColors={false}
	toastOptions={{
		class: density === 'compact' ? 'text-label' : 'text-body',
	}}
/>
