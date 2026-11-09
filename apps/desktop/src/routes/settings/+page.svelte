<script lang="ts">
	/**
	 * Settings, first pass: the two things that decide whether the app is usable
	 * at all on a desktop that was never set up for Android tooling.
	 *
	 *  - WHERE adb IS. A desktop launch inherits the session PATH
	 *    (`/usr/local/bin:/usr/bin:/bin`), and never reads a shell's rc file, so
	 *    an SDK under `$HOME` is invisible to the engine. The engine searches the
	 *    usual folders on its own now; this field is the override for the one
	 *    that is somewhere unusual.
	 *  - HOW BIG THE UI IS. The design runs a dense 13 px body, which is right
	 *    for a ledger of file names and too small on a large screen.
	 *
	 * The rest of the config groups in `screens.md` (destination, transfer,
	 * devices, journal) are not here yet; the engine already exposes every key.
	 */
	import { CONTROL, PageHeader, PROSE, SURFACE } from '../../lib/components/app/index.ts';
	import { Button } from '../../lib/components/ui/button/index.js';
	import { Input } from '../../lib/components/ui/input/index.js';
	import { Label } from '../../lib/components/ui/label/index.js';
	import { EngineFailure } from '../../lib/engine/client.ts';
	import { app, scalePercent, UI_SCALES, type ThemeChoice } from '../../lib/state/app.svelte.ts';
	import { cn } from '../../lib/utils.ts';

	const THEMES: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' },
		{ value: 'system', label: 'System' }
	];

	/** A segmented control's button: two choices that sit side by side. */
	const SEGMENT =
		'rounded-[var(--radius-control)] border border-border px-2.5 py-1 text-label text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-pressed:border-input aria-pressed:bg-muted aria-pressed:text-foreground';

	const SOURCE_WORDS: Record<string, string> = {
		config: 'from adb_path',
		path: 'on PATH',
		search: 'found by search, not on PATH',
		none: ''
	};

	/**
	 * `null` while the field is pristine, so the engine's value shows through
	 * and a `config` frame that arrives after mount still lands. Typing sets it.
	 */
	let draft = $state<string | null>(null);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let saveFix = $state('');

	const saved = $derived(app.config?.adb_path ?? '');
	const value = $derived(draft ?? saved);
	const dirty = $derived(draft !== null && draft !== saved);
	const canSave = $derived(app.config !== null && !app.usingMock);

	/** Which layer won, in the words `screens.md` asks for. */
	const originText = $derived.by(() => {
		const origin = app.origins['adb_path'] ?? 'default';
		if (origin === 'default') return 'the built-in default, which searches the usual places';
		if (origin === 'env') return 'the environment (PORTAGE_ADB_PATH)';
		return origin;
	});

	const adb = $derived.by(() => {
		const ready = app.ready;
		if (ready === null) {
			return { ok: false, text: 'Waiting for the engine.', detail: '' };
		}
		if (!ready.adbFound) {
			return {
				ok: false,
				text: 'Not found',
				detail:
					'The engine looked on PATH, at ANDROID_HOME and ANDROID_SDK_ROOT, and in the usual SDK folders under your home directory.'
			};
		}
		return {
			ok: true,
			text: ready.adbPath ?? 'found',
			detail: SOURCE_WORDS[ready.adbSource] ?? ''
		};
	});

	async function save(): Promise<void> {
		saving = true;
		saveError = null;
		saveFix = '';
		try {
			// The engine writes its own config file; the app never touches it.
			await app.setConfig('adb_path', value.trim());
			draft = null;
			// adb is resolved once per engine process, so the new path only takes
			// effect on the next one. Restart now rather than leave a field that
			// looks applied and is not.
			await app.restartEngine();
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'The engine did not answer.';
			saveFix = error instanceof EngineFailure ? error.fix : '';
		} finally {
			saving = false;
		}
	}

	async function recheck(): Promise<void> {
		// A restart swaps the child process; Save and Revert must not race it.
		saving = true;
		saveError = null;
		saveFix = '';
		try {
			await app.restartEngine();
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'The engine did not answer.';
			saveFix = error instanceof EngineFailure ? error.fix : '';
		} finally {
			saving = false;
		}
	}

	/**
	 * Read the config once, and only once the shell has settled which engine
	 * answers.
	 *
	 * The shell chooses the port (a real engine or a fixture) inside its own
	 * mount, which is later than this screen's — and the engine emits `ready`
	 * but no `config` at startup, so a direct load of this screen left the adb
	 * field disabled for good: `canSave` needs a config to compare against.
	 */
	let loaded = $state(false);
	$effect(() => {
		if (loaded) return;
		if (app.connection !== 'connected' && app.connection !== 'mock') return;
		loaded = true;
		void app.loadConfig().catch((error: unknown) => {
			saveError = error instanceof Error ? error.message : 'The engine did not answer.';
			saveFix = error instanceof EngineFailure ? error.fix : '';
		});
	});
</script>

<PageHeader title="Settings" summary="Change the config without wondering which value won." />

<div class="flex max-w-3xl flex-col gap-4 px-6 pb-8">
	<section class={cn(SURFACE, 'flex flex-col gap-3 p-4')} aria-labelledby="phone-tools">
		<div class="flex flex-col gap-1">
			<h2 id="phone-tools" class="text-lead font-medium text-foreground">Phone tools</h2>
			<p class={PROSE}>
				adb is how every phone command reaches the device. Portage looks for it on PATH and in the
				usual Android SDK folders; name an exact binary here when yours lives somewhere else.
			</p>
		</div>

		<p class="flex flex-wrap items-baseline gap-x-2 gap-y-1" data-numeric>
			<span class="text-label text-muted-foreground">Resolved</span>
			<span
				class={cn('font-mono text-label', adb.ok ? 'text-state-verified' : 'text-state-failed')}
			>
				{adb.text}
			</span>
			{#if adb.detail}
				<span class="text-caption text-muted-foreground">{adb.detail}</span>
			{/if}
		</p>

		<div class="flex flex-col gap-1.5">
			<Label
				for="adb-path"
				class="text-label font-medium tracking-normal text-foreground normal-case"
			>
				adb location
			</Label>
			<Input
				id="adb-path"
				class="h-8 rounded-[var(--radius-control)] border border-input bg-background px-2 font-mono text-label md:text-label"
				placeholder="Leave empty to search PATH and the SDK folders"
				bind:value={() => value, (next) => (draft = next)}
				disabled={!canSave || saving}
				spellcheck={false}
				autocomplete="off"
			/>
			<p class="text-caption text-muted-foreground">
				Currently {originText}.
			</p>
		</div>

		{#if saveError}
			<p class="text-body text-state-failed">{saveError}</p>
			{#if saveFix}
				<p class={PROSE}>{saveFix}</p>
			{/if}
		{:else if dirty}
			<p class="text-caption text-muted-foreground">
				Unsaved. Saving writes the value and restarts the engine so it takes effect.
			</p>
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			<Button
				class={CONTROL}
				size="sm"
				disabled={!dirty || saving || !canSave}
				onclick={() => void save()}
			>
				{saving ? 'Saving' : 'Save'}
			</Button>
			<Button
				variant="ghost"
				class={CONTROL}
				size="sm"
				disabled={!dirty || saving}
				onclick={() => (draft = null)}
			>
				Revert
			</Button>
			<Button
				variant="outline"
				class={CONTROL}
				size="sm"
				disabled={saving}
				onclick={() => void recheck()}
			>
				Check again
			</Button>
			{#if app.userConfigPath}
				<span class="text-caption text-muted-foreground">
					Stored in <span class="font-mono">{app.userConfigPath}</span>
				</span>
			{/if}
		</div>
	</section>

	<section class={cn(SURFACE, 'flex flex-col gap-3 p-4')} aria-labelledby="appearance">
		<div class="flex flex-col gap-1">
			<h2 id="appearance" class="text-lead font-medium text-foreground">Appearance</h2>
			<p class={PROSE}>
				Both of these belong to this window, not to a drive, so they stay on this machine whatever
				you plug in.
			</p>
		</div>

		<div class="flex flex-col gap-1.5">
			<span class="text-label font-medium text-foreground">Theme</span>
			<div role="group" aria-label="Theme" class="flex flex-wrap gap-1">
				{#each THEMES as option (option.value)}
					<button
						type="button"
						aria-pressed={app.theme === option.value}
						class={SEGMENT}
						onclick={() => app.setTheme(option.value)}
					>
						{option.label}
					</button>
				{/each}
			</div>
		</div>

		<div class="flex flex-col gap-1.5">
			<span class="text-label font-medium text-foreground">UI size</span>
			<div role="group" aria-label="UI size" class="flex flex-wrap gap-1">
				{#each UI_SCALES as scale (scale)}
					<button
						type="button"
						aria-pressed={app.uiScale === scale}
						class={SEGMENT}
						onclick={() => app.setUiScale(scale)}
					>
						{scalePercent(scale)}
					</button>
				{/each}
			</div>
			<p class="text-caption text-muted-foreground">
				Every text size, row height and space in the app scales together. Ctrl and plus or minus
				steps through these; Ctrl and 0 goes back to 100 %.
			</p>
		</div>

		<div class="rounded-[var(--radius-control)] border border-border bg-muted px-3 py-2">
			<p class="text-body text-foreground">
				The quick brown fox jumps over the lazy dog while a transfer runs.
			</p>
			<p class="font-mono text-caption text-muted-foreground" data-numeric>
				13 px body, 11 px caption, 32 px rows at 100 %
			</p>
		</div>
	</section>
</div>
