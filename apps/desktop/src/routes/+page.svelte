<script lang="ts">
	/**
	 * Home: the state of things, and the one thing to do next.
	 *
	 * Three questions, in the order a person asks them: where do my files go,
	 * where do they come from, and what now. The screen keeps no detail of its
	 * own: every path, count and word comes from the engine's frames, so it
	 * cannot disagree with the screens that drill into them.
	 */
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleDot from '@lucide/svelte/icons/circle-dot';
	import Lock from '@lucide/svelte/icons/lock';
	import Unplug from '@lucide/svelte/icons/unplug';

	import {
		CONTROL,
		EmptyState,
		ErrorBand,
		PageHeader,
		SkeletonRows,
		SourceFolders,
		SURFACE
	} from '../lib/components/app/index.ts';
	import { Button } from '../lib/components/ui/button/index.js';
	import { EngineFailure } from '../lib/engine/client.ts';
	import type { DeviceInfo, DeviceState, Volume } from '../lib/engine/protocol.ts';
	import { app } from '../lib/state/app.svelte.ts';
	import { formatBytes, plural } from '../lib/util/format.ts';
	import { cn } from '../lib/utils.ts';

	/** The layers the config can come from, in words rather than config vocabulary. */
	const ORIGIN_WORDS: Record<string, string> = {
		default: 'the built-in default',
		env: 'the environment (PORTAGE_DEST_ROOT)',
		flag: 'a command line flag'
	};

	let reading = $state(false);
	let picking = $state(false);
	let savingTo = $state<string | null>(null);
	let runError = $state<{ what: string; todo: string; code: number | null } | null>(null);

	/** The task the failure band's "Try again" repeats. A request, not UI state. */
	let lastTask: (() => Promise<void>) | null = null;

	const busy = $derived(reading || picking || savingTo !== null);
	const destRoot = $derived(app.config?.dest_root.trim() ?? '');
	const destOrigin = $derived.by((): string => {
		const origin = app.origins['dest_root'] ?? 'default';
		return ORIGIN_WORDS[origin] ?? origin;
	});

	/** The volume the destination sits on. The longest mount point wins: `/` prefixes everything. */
	const destVolume = $derived.by((): Volume | null => {
		if (destRoot === '') return null;
		let best: Volume | null = null;
		for (const volume of app.volumes) {
			if (!holds(destRoot, volume.mountPoint)) continue;
			if (best === null || volume.mountPoint.length > best.mountPoint.length) best = volume;
		}
		return best;
	});

	const drivesWaiting = $derived(app.volumes.length === 0 && (app.ready === null || reading));
	const phonesWaiting = $derived(app.devices.length === 0 && (app.ready === null || reading));
	const readyDevices = $derived(app.devices.filter((device) => phoneState(device) === 'device'));

	/** A path boundary, so `/media/one` is not treated as living inside `/media/on`. */
	function holds(path: string, mount: string): boolean {
		if (mount === '') return false;
		if (path === mount) return true;
		return path.startsWith(mount.endsWith('/') ? mount : `${mount}/`);
	}

	/** `${mount}/Videos`, without doubling a trailing slash or losing the root. */
	function videosPath(mount: string): string {
		return `${mount.replace(/\/+$/, '')}/Videos`;
	}

	/**
	 * The engine sends 0 when `df` could not read a volume, so a zero here means
	 * "unknown", never "empty". `0 B` would be a number nobody measured.
	 */
	function freeWords(bytes: number): string {
		return Number.isFinite(bytes) && bytes > 0
			? `${formatBytes(bytes)} free`
			: 'free space unknown';
	}

	function totalWords(bytes: number): string {
		return Number.isFinite(bytes) && bytes > 0 ? `of ${formatBytes(bytes)}` : '';
	}

	/** `unauthorized` is the actionable state, so it outranks whatever `state` says. */
	function phoneState(device: DeviceInfo): DeviceState {
		return device.unauthorized ? 'unauthorized' : device.state;
	}

	/** One place for the three-part failure band, and the task to repeat. */
	async function attempt(task: () => Promise<void>): Promise<void> {
		lastTask = task;
		runError = null;
		try {
			await task();
			lastTask = null;
		} catch (error) {
			runError = {
				what: error instanceof Error ? error.message : 'The engine did not answer.',
				todo:
					error instanceof EngineFailure && error.fix.trim() !== ''
						? error.fix
						: 'Try again, or restart the engine from Settings.',
				code: error instanceof EngineFailure ? error.code : null
			};
		}
	}

	/**
	 * Save one phone's folders, then re-read the config the engine wrote.
	 *
	 * `config.set` takes the whole `devices` table and the engine owns the file,
	 * so this goes through the same task/failure path as every other write on
	 * this screen: a refusal lands in the band above with the engine's own fix.
	 */
	async function saveRoots(deviceId: string, roots: string[]): Promise<void> {
		savingTo = deviceId;
		try {
			await attempt(() => app.setDeviceRoots(deviceId, roots));
		} finally {
			savingTo = null;
		}
	}

	function retry(): void {
		if (lastTask !== null) void attempt(lastTask);
	}

	async function withReading(task: () => Promise<void>): Promise<void> {
		reading = true;
		try {
			await task();
		} finally {
			reading = false;
		}
	}

	/** Exactly what the "Read drives and phones" button promises. */
	async function readLists(): Promise<void> {
		await app.loadVolumes();
		await app.loadDevices();
	}

	function refreshLists(): void {
		void attempt(() => withReading(readLists));
	}

	/**
	 * The first read also asks for the config, because the engine emits `ready`
	 * on start and no `config`: without it the destination would look unset on
	 * every fresh launch. When `ready` already says there is none, there is
	 * nothing to ask for.
	 */
	function readEverything(): void {
		void attempt(() =>
			withReading(async () => {
				if (app.ready?.destinationConfigured !== false) await app.loadConfig();
				await readLists();
			})
		);
	}

	async function chooseFolder(): Promise<void> {
		await attempt(async () => {
			picking = true;
			try {
				const chosen = await app.pickFolder({
					title: 'Choose the destination folder',
					defaultPath: destRoot === '' ? undefined : destRoot
				});
				if (chosen === null || chosen.trim() === '') return;
				await app.setConfig('dest_root', chosen);
			} finally {
				picking = false;
			}
		});
	}

	async function useVolume(volume: Volume): Promise<void> {
		await attempt(async () => {
			savingTo = volume.device;
			try {
				await app.setConfig('dest_root', videosPath(volume.mountPoint));
			} finally {
				savingTo = null;
			}
		});
	}

	let requested = $state(false);

	/**
	 * Read this screen's facts once the shell has settled which engine answers.
	 *
	 * This is a request to an external process, not state mirrored into a rune:
	 * the shell chooses the port (a real engine or a fixture) inside its own
	 * mount, later than this screen's, so `onMount` can reach a port that is
	 * about to be replaced.
	 */
	$effect(() => {
		if (requested) return;
		if (app.connection !== 'connected' && app.connection !== 'mock') return;
		// `destinationConfigured` is what decides whether asking for the config
		// is meaningful, and it arrives in the `ready` frame. Reading before
		// that frame makes the answer "unknown", and a first run then looked
		// fully configured because `config.get` still answers with defaults.
		if (app.ready === null) return;
		requested = true;
		readEverything();
	});
</script>

<PageHeader
	title="Home"
	summary="The drive the archive lands on, the phone it comes from, and the one thing to do next."
/>

<div class="flex flex-col gap-6 px-6 pb-8">
	{#if runError}
		<ErrorBand
			what={runError.what}
			means="The engine refused the request, so these lists are the last ones it sent."
			todo={runError.todo}
			code={runError.code}
		>
			{#snippet actions()}
				<Button variant="outline" size="sm" class={CONTROL} disabled={busy} onclick={retry}>
					Try again
				</Button>
			{/snippet}
		</ErrorBand>
	{/if}

	<section class="flex flex-col gap-3" aria-labelledby="destination">
		<h2 id="destination" class="text-lead font-medium text-foreground">Destination</h2>

		<div class={cn(SURFACE, 'flex flex-col gap-3 p-4')}>
			{#if destRoot !== ''}
				<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
					<p class="min-w-0">
						<span class="font-mono text-body break-all text-foreground">{destRoot}</span>
					</p>
					<Button
						variant="outline"
						size="sm"
						class={CONTROL}
						disabled={busy}
						onclick={() => void chooseFolder()}
					>
						{picking ? 'Choosing a folder' : 'Change'}
					</Button>
				</div>

				<p class="text-caption text-muted-foreground">Set by {destOrigin}</p>

				<p class="flex flex-wrap items-baseline gap-x-2 text-label">
					{#if destVolume === null}
						<span class="text-muted-foreground">
							This folder is not on a mounted drive, so free space is unknown.
						</span>
					{:else if destVolume.freeBytes > 0}
						<span class="font-mono text-foreground tabular-nums">
							{formatBytes(destVolume.freeBytes)} free
						</span>
						<span class="text-muted-foreground">on {destVolume.fsType}</span>
					{:else}
						<span class="text-muted-foreground">
							Free space on {destVolume.fsType} could not be read.
						</span>
					{/if}
				</p>
			{:else if app.config === null && app.ready?.destinationConfigured !== false}
				<p class="text-label text-muted-foreground">Waiting for the engine to send its config.</p>
			{:else}
				<div class="flex flex-col items-start gap-3">
					<EmptyState
						class="px-0 py-0"
						title="No destination yet"
						body="Pick the folder new files land in. Any mounted drive works; a folder on your home disk works too."
					/>
					<Button
						variant="outline"
						size="sm"
						class={CONTROL}
						disabled={busy}
						onclick={() => void chooseFolder()}
					>
						{picking ? 'Choosing a folder' : 'Choose a folder'}
					</Button>
				</div>
			{/if}
		</div>
	</section>

	<div class="flex flex-wrap items-center gap-2">
		<Button href="/plan" variant="default" size="sm" class={CONTROL}>Plan a pull</Button>
		<Button variant="ghost" size="sm" class={CONTROL} disabled={busy} onclick={refreshLists}>
			{reading ? 'Reading drives and phones' : 'Read drives and phones'}
		</Button>
	</div>

	<section class="flex flex-col gap-3" aria-labelledby="drives">
		<div class="flex items-baseline gap-2">
			<h2 id="drives" class="text-lead font-medium text-foreground">Drives</h2>
			{#if app.volumes.length > 0}
				<span class="text-label text-muted-foreground tabular-nums" data-numeric>
					{plural(app.volumes.length, 'drive')}
				</span>
			{/if}
		</div>

		{#if drivesWaiting}
			<SkeletonRows rows={4} label="Reading drives" />
		{:else if app.volumes.length === 0}
			<EmptyState
				title="No drives found"
				body="Plug the archive drive in. This list refreshes when you read drives again."
			/>
		{:else}
			<ul class="divide-y divide-border rounded-[var(--radius-surface)] border border-border">
				{#each app.volumes as volume (volume.device)}
					<li class="flex items-center gap-3 px-3 py-2">
						<span
							class="min-w-0 truncate font-mono text-body text-foreground"
							title={volume.mountPoint}
						>
							{volume.mountPoint}
						</span>
						{#if volume.label !== null && volume.label !== ''}
							<span class="shrink-0 text-label text-muted-foreground">{volume.label}</span>
						{/if}
						<span class="shrink-0 font-mono text-label text-foreground tabular-nums">
							{freeWords(volume.freeBytes)}
						</span>
						{#if totalWords(volume.totalBytes) !== ''}
							<span class="shrink-0 font-mono text-label text-muted-foreground tabular-nums">
								{totalWords(volume.totalBytes)}
							</span>
						{/if}
						<span class="shrink-0 text-label text-muted-foreground">{volume.fsType}</span>

						<div class="ms-auto flex shrink-0 items-center gap-3">
							{#if volume.isPortageDrive}
								<span class="text-label text-state-verified">portage drive</span>
							{/if}
							{#if volume.readOnly === true}
								<span class="text-label text-state-failed">read-only</span>
								<Button
									variant="outline"
									size="sm"
									class={CONTROL}
									disabled
									aria-label={`Use ${volume.mountPoint} as the destination`}
								>
									Use
								</Button>
							{:else if volume.readOnly === null}
								<span class="text-label text-muted-foreground">access unknown</span>
							{:else}
								<Button
									variant="outline"
									size="sm"
									class={CONTROL}
									disabled={busy}
									aria-label={`Use ${volume.mountPoint} as the destination`}
									onclick={() => void useVolume(volume)}
								>
									Use
								</Button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="flex flex-col gap-3" aria-labelledby="phones">
		<div class="flex items-baseline gap-2">
			<h2 id="phones" class="text-lead font-medium text-foreground">Phones</h2>
			{#if app.devices.length > 0}
				<span class="text-label text-muted-foreground tabular-nums" data-numeric>
					{plural(app.devices.length, 'phone')}
				</span>
			{/if}
		</div>

		{#if app.usingMock}
			<p class="text-caption text-muted-foreground">Fixture data. Nothing here is a real device.</p>
		{/if}

		{#if app.ready?.adbFound === false}
			<ErrorBand
				what="adb was not found"
				means="Portage looks for it on PATH and in the usual Android SDK folders. A desktop launch does not read your shell's startup files, so an SDK in your home folder can be invisible here."
				todo="Open Settings and either let the search find it or name the binary yourself."
			>
				{#snippet actions()}
					<Button href="/settings" variant="outline" size="sm" class={CONTROL}>
						Open settings
					</Button>
				{/snippet}
			</ErrorBand>
		{:else if phonesWaiting}
			<SkeletonRows rows={2} label="Reading phones" />
		{:else if app.devices.length === 0}
			<EmptyState
				title="Nothing attached"
				body="Plug in a phone, enable USB debugging, and accept the RSA prompt on the device."
			/>
		{:else}
			<ul class="divide-y divide-border rounded-[var(--radius-surface)] border border-border">
				{#each app.devices as device (device.id)}
					{@const state = phoneState(device)}
					<li class="flex items-start gap-3 px-3 py-2">
						<div class="flex min-w-0 flex-1 flex-col gap-0.5">
							<div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
								<span class="truncate text-body text-foreground">
									{device.model.trim() !== '' ? device.model : device.serial}
								</span>
								{#if device.android.trim() !== ''}
									<span class="text-label text-muted-foreground">Android {device.android}</span>
								{/if}
								<span class="font-mono text-caption text-muted-foreground">
									{device.id.slice(0, 12)}
								</span>
							</div>
							{#if state === 'unauthorized'}
								<p class="text-caption text-foreground">
									Unlock the phone and tap 'Always allow from this computer' on the RSA prompt.
								</p>
							{/if}
						</div>

						{#if state === 'device'}
							<span class="flex shrink-0 items-center gap-1.5 text-label text-state-verified">
								<CircleCheck class="size-3.5 shrink-0" aria-hidden="true" />
								ready
							</span>
						{:else if state === 'unauthorized'}
							<span class="flex shrink-0 items-start gap-1.5 text-label text-state-failed">
								<Lock class="mt-px size-3.5 shrink-0" aria-hidden="true" />
								unauthorized
							</span>
						{:else if state === 'offline'}
							<span class="flex shrink-0 items-start gap-1.5 text-label text-state-failed">
								<Unplug class="mt-px size-3.5 shrink-0" aria-hidden="true" />
								offline
							</span>
						{:else}
							<span class="flex shrink-0 items-start gap-1.5 text-label text-muted-foreground">
								<CircleDot class="mt-px size-3.5 shrink-0" aria-hidden="true" />
								unknown
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="flex flex-col gap-3" aria-labelledby="phone-folders">
		<h2 id="phone-folders" class="text-lead font-medium text-foreground">Phone folders</h2>

		{#if readyDevices.length === 0}
			<p class="measure text-body text-muted-foreground">
				{app.devices.length === 0
					? 'Plug in a phone and its folders can be chosen here.'
					: 'A phone has to be ready before its folders can be chosen.'}
			</p>
		{:else}
			{#each readyDevices as device (device.id)}
				{@const roots = app.config?.devices?.[device.id]?.roots ?? []}
				<div class={cn(SURFACE, 'flex flex-col gap-3 p-4')}>
					<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
						<span class="min-w-0 truncate text-body text-foreground">
							{device.model.trim() !== '' ? device.model : device.serial}
						</span>
						<span class="font-mono text-caption text-muted-foreground">
							{device.id.slice(0, 12)}
						</span>
					</div>
					<SourceFolders
						{device}
						{roots}
						{busy}
						onchange={(next) => void saveRoots(device.id, next)}
					/>
				</div>
			{/each}
		{/if}
	</section>
</div>
