<script lang="ts">
	/**
	 * Home, as a placeholder the next phase replaces.
	 *
	 * It is here so the shell is testable now: it reads the `ready` frame, it
	 * can send a real `volumes.list` and render what comes back, and it says
	 * plainly that the real screen is not written.
	 */
	import { EmptyState, PageHeader, SkeletonRows } from '../lib/components/app/index.ts';
	import { CONTROL } from '../lib/components/app/tokens.ts';
	import { Button } from '../lib/components/ui/button/index.js';
	import { app } from '../lib/state/app.svelte.ts';
	import { formatBytes } from '../lib/util/format.ts';

	let checking = $state(false);
	let checkError = $state<string | null>(null);

	const facts = $derived(
		app.ready === null
			? []
			: [
					{
						key: 'engine',
						value: `${app.ready.engineVersion} · protocol v${app.ready.protocolVersion}`
					},
					{ key: 'platform', value: app.ready.platform },
					{ key: 'adb', value: app.ready.adbFound ? 'found' : 'not found' },
					{
						key: 'destination',
						value: app.ready.destinationConfigured ? 'configured' : 'not configured'
					}
				]
	);

	async function checkVolumes(): Promise<void> {
		checking = true;
		checkError = null;
		try {
			await app.loadVolumes();
		} catch (error) {
			checkError = error instanceof Error ? error.message : 'The engine did not answer.';
		} finally {
			checking = false;
		}
	}
</script>

<PageHeader title="Home" summary="What the state of things is, and what to do next." />

<div class="flex flex-col gap-6 px-6 pb-8">
	{#if app.ready === null && app.connection !== 'mock'}
		<SkeletonRows rows={3} label="Waiting for the engine" />
	{:else}
		<dl class="flex flex-wrap gap-x-8 gap-y-2" data-numeric>
			{#each facts as fact (fact.key)}
				<div class="flex flex-col">
					<dt class="text-caption text-muted-foreground">{fact.key}</dt>
					<dd class="font-mono text-label text-foreground">{fact.value}</dd>
				</div>
			{/each}
		</dl>

		<div class="flex flex-col gap-3">
			<div class="flex items-center gap-2">
				<Button class={CONTROL} size="sm" disabled={checking} onclick={() => void checkVolumes()}>
					{checking ? 'Reading volumes' : 'Read volumes'}
				</Button>
				<span class="text-label text-muted-foreground">
					Sends one <span class="font-mono">volumes.list</span> to the engine.
				</span>
			</div>

			{#if checkError}
				<p class="measure text-body text-state-failed">{checkError}</p>
			{:else if app.volumes.length > 0}
				<ul class="flex flex-col gap-1">
					{#each app.volumes as volume (volume.device)}
						<li
							class="flex items-baseline gap-3 rounded-[var(--radius-control)] border border-border px-3 py-2"
						>
							<span class="truncate font-mono text-label text-foreground">{volume.mountPoint}</span>
							<span class="text-label text-muted-foreground">{volume.fsType}</span>
							<span class="ms-auto text-label text-foreground" data-numeric>
								{formatBytes(volume.freeBytes)} free
							</span>
							{#if volume.readOnly !== false}
								<span class="text-label text-state-failed">
									{volume.readOnly === null ? 'access unknown' : 'read-only'}
								</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<EmptyState
			title="Home is not written yet"
			body="The destination and phone cards, the headline from the last scan, the primary action and the throughput chart all belong to the next phase. This page exists so the shell around them can be built and driven today."
		/>
	{/if}
</div>
