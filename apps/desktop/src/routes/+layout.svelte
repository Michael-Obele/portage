<script lang="ts">
	/**
	 * The shell: everything a screen is drawn inside.
	 *
	 * It owns the window furniture (the drag strip, the rail, the titlebar), the
	 * one live region, the keyboard map, and the connection to the engine. It
	 * owns no screen's data. A screen imports what it needs from
	 * `#lib/components/app` and renders into `children`.
	 */
	import { browser } from '$app/env';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
	import Copy from '@lucide/svelte/icons/copy';
	import House from '@lucide/svelte/icons/house';
	import Keyboard from '@lucide/svelte/icons/keyboard';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Moon from '@lucide/svelte/icons/moon';
	import Settings from '@lucide/svelte/icons/settings';
	import Stethoscope from '@lucide/svelte/icons/stethoscope';
	import Sun from '@lucide/svelte/icons/sun';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { onMount } from 'svelte';

	import './layout.css';
	import favicon from '../lib/assets/favicon.svg';
	import { ErrorBand, KeyHint, ToastHost } from '../lib/components/app/index.ts';
	import { CONTROL } from '../lib/components/app/tokens.ts';
	import { Button } from '../lib/components/ui/button/index.js';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogHeader,
		DialogTitle,
	} from '../lib/components/ui/dialog/index.js';
	import { app, type ThemeChoice } from '../lib/state/app.svelte.ts';
	import { run } from '../lib/state/run.svelte.ts';
	import { cn } from '../lib/utils.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	/** The rail. `letter` is the `g` chord that reaches the screen. */
	const NAV = [
		{ href: '/', label: 'Home', letter: 'h', icon: House },
		{ href: '/plan', label: 'Plan', letter: 'p', icon: ListChecks },
		{ href: '/transfer', label: 'Transfer', letter: 't', icon: ArrowRightLeft },
		{ href: '/duplicates', label: 'Duplicates', letter: 'd', icon: Copy },
		{ href: '/purge', label: 'Purge', letter: 'u', icon: Trash2 },
		{ href: '/doctor', label: 'Doctor', letter: 'o', icon: Stethoscope },
		{ href: '/settings', label: 'Settings', letter: 's', icon: Settings },
	] as const;

	const THEMES: ReadonlyArray<{ value: ThemeChoice; label: string; icon: typeof Sun }> = [
		{ value: 'light', label: 'Light theme', icon: Sun },
		{ value: 'dark', label: 'Dark theme', icon: Moon },
		{ value: 'system', label: 'Follow the system theme', icon: Monitor },
	];

	let helpOpen = $state(false);
	let chordArmed = $state(false);
	let chordTimer: ReturnType<typeof setTimeout> | null = null;

	const path = $derived(page.url.pathname);
	const currentScreen = $derived(
		NAV.find((item) => (item.href === '/' ? path === '/' : path.startsWith(item.href)))?.label ??
			'Portage'
	);

	function isActive(href: string): boolean {
		return href === '/' ? path === '/' : path.startsWith(href);
	}

	/** The dot is never colour alone: it is always drawn beside its word. */
	const status = $derived.by(() => {
		switch (app.connection) {
			case 'mock':
				return { tone: 'bg-state-skipped', word: 'fixture' };
			case 'connected':
				return { tone: 'bg-state-verified', word: 'engine' };
			case 'restarting':
				return { tone: 'bg-state-copying', word: 'restarting' };
			case 'stopped':
				return { tone: 'bg-state-failed', word: 'stopped' };
			default:
				return { tone: 'bg-state-copying', word: 'starting' };
		}
	});

	const engineDown = $derived(app.connection === 'stopped' || app.connection === 'restarting');

	onMount(() => {
		// The run store watches frames through the app rather than opening a
		// second set of Tauri listeners: one window, one connection.
		const stopObserving = app.observeFrame((frame) => run.applyFrame(frame));
		void app.start(browser ? location.search : '');

		return () => {
			stopObserving();
			void app.stop();
		};
	});

	// The live region is throttled to one announcement every five seconds, so a
	// 10 Hz frame rate cannot flood a screen reader.
	$effect(() => {
		run.refreshAnnouncement();
	});

	function disarmChord(): void {
		chordArmed = false;
		if (chordTimer !== null) clearTimeout(chordTimer);
		chordTimer = null;
	}

	function onKeydown(event: KeyboardEvent): void {
		const target = event.target;
		if (target instanceof HTMLElement) {
			const tag = target.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
				return;
			}
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;

		if (event.key === '?') {
			helpOpen = !helpOpen;
			event.preventDefault();
			return;
		}

		if (chordArmed) {
			const hit = NAV.find((item) => item.letter === event.key.toLowerCase());
			disarmChord();
			if (hit) {
				event.preventDefault();
				void goto(hit.href);
			}
			return;
		}

		if (event.key === 'g') {
			chordArmed = true;
			chordTimer = setTimeout(disarmChord, 1500);
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head>
	<title>{currentScreen} · Portage</title>
	<link rel="icon" href={favicon} />
</svelte:head>

<a
	href="#main-content"
	class="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-[var(--radius-control)] focus:border focus:border-border focus:bg-card focus:px-3 focus:py-1.5 focus:text-body focus:text-foreground"
>
	Skip to content
</a>

<div class="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
	<!-- The drag strip. Controls inside it opt out through the `[data-drag-region]`
	     rule in layout.css, so no control is ever swallowed by the window drag. -->
	<header
		data-drag-region
		class="flex h-9 shrink-0 items-center gap-3 border-b border-border px-3"
	>
		<span class="font-mono text-label font-medium tracking-tight text-foreground">portage</span>
		<span class="text-label text-muted-foreground" aria-hidden="true">·</span>
		<span class="text-label text-muted-foreground">{currentScreen}</span>

		<div class="ms-auto flex items-center gap-3">
			<span class="flex items-center gap-1.5 text-caption text-muted-foreground">
				<span class={cn('size-2 shrink-0 rounded-full', status.tone)} aria-hidden="true"></span>
				{status.word}
			</span>

			<div
				role="group"
				aria-label="Theme"
				class="flex items-center gap-0.5 rounded-[var(--radius-control)] border border-border p-0.5"
			>
				{#each THEMES as option (option.value)}
					<button
						type="button"
						aria-label={option.label}
						aria-pressed={app.theme === option.value}
						class={cn(
							'flex size-6 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground hover:bg-muted hover:text-foreground',
							app.theme === option.value && 'bg-muted text-foreground'
						)}
						onclick={() => app.setTheme(option.value)}
					>
						<option.icon class="size-4" aria-hidden="true" />
					</button>
				{/each}
			</div>

			<button
				type="button"
				aria-label="Keyboard map"
				class="flex size-6 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground hover:bg-muted hover:text-foreground"
				onclick={() => (helpOpen = true)}
			>
				<Keyboard class="size-4" aria-hidden="true" />
			</button>
		</div>
	</header>

	<div class="flex min-h-0 flex-1">
		<nav aria-label="Screens" class="flex w-48 shrink-0 flex-col border-r border-border bg-sidebar">
			<ul class="flex flex-col gap-0.5 p-2">
				{#each NAV as item (item.href)}
					{@const active = isActive(item.href)}
					{@const badged = item.href === '/duplicates' && app.dupesGroups > 0}
					<li>
						<a
							href={item.href}
							aria-current={active ? 'page' : undefined}
							class={cn(
								'flex h-8 items-center gap-2 rounded-[var(--radius-control)] border-l-2 px-2 text-body',
								active
									? 'border-primary bg-sidebar-accent font-medium text-sidebar-accent-foreground'
									: 'border-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
							)}
						>
							<item.icon class="size-4 shrink-0" aria-hidden="true" />
							<span class="truncate">{item.label}</span>
							{#if badged}
								<span
									class="ms-auto font-mono text-caption tabular-nums text-muted-foreground"
									data-numeric
								>
									{app.dupesGroups}
								</span>
								<span class="sr-only">duplicate groups found</span>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
			<p class="mt-auto px-3 pb-3 font-mono text-caption text-muted-foreground">
				v{__APP_VERSION__}
			</p>
		</nav>

		<main id="main-content" class="flex min-w-0 flex-1 flex-col overflow-y-auto">
			{#if app.usingMock}
				<p
					role="status"
					class="border-b border-border bg-muted px-6 py-2 text-label text-muted-foreground"
				>
					Fixture data. No engine is running, so nothing here moves a file.
				</p>
			{/if}

			{#if app.protocolMismatch !== null}
				<ErrorBand
					class="m-6 mb-0"
					what={`The engine speaks protocol version ${app.protocolMismatch}; this app speaks version 1.`}
					means="The two halves of Portage are from different releases, so a command could mean something subtly different on each side."
					todo="Install the app and the engine from the same release, then reopen Portage."
				/>
			{:else if engineDown}
				<ErrorBand
					class="m-6 mb-0"
					what="The engine is not running."
					means="Nothing can be scanned, planned, pulled or verified until it is back."
					todo="Restart it below. If it stops again straight away, the last line it wrote is underneath."
				>
					{#snippet actions()}
						<Button
							class={CONTROL}
							size="sm"
							disabled={app.connection === 'restarting'}
							onclick={() => void app.restartEngine()}
						>
							{app.connection === 'restarting' ? 'Restarting' : 'Restart engine'}
						</Button>
					{/snippet}
				</ErrorBand>
				{#if app.stderrTail.length > 0}
					<pre
						class="mx-6 mt-2 overflow-x-auto rounded-[var(--radius-control)] border border-border bg-muted p-2 font-mono text-caption text-muted-foreground">{app.stderrTail.join('\n')}</pre>
				{/if}
			{/if}

			{@render children()}
		</main>
	</div>
</div>

<!-- One live region for the whole window, throttled to one announcement every
     five seconds, and never about bytes. -->
<p class="sr-only" aria-live="polite" aria-atomic="true">{run.announcement}</p>

<ToastHost notices={app.notices} ondismiss={(id) => app.dismissNotice(id)} theme={app.theme} />

<Dialog bind:open={helpOpen}>
	<DialogContent class="rounded-[var(--radius-surface)] sm:max-w-md">
		<DialogHeader class="gap-2">
			<DialogTitle class="text-title font-medium normal-case tracking-normal">
				Keyboard map
			</DialogTitle>
			<DialogDescription class="text-body text-muted-foreground">
				Every route and every overlay in this app is reachable without a pointer.
			</DialogDescription>
		</DialogHeader>
		<dl class="flex flex-col gap-2">
			<div class="flex items-center gap-4">
				<dt><KeyHint keys="?" label="Open and close this map" /></dt>
				<dd class="sr-only">Question mark opens the keyboard map</dd>
			</div>
			<div class="flex items-center gap-4">
				<dt><KeyHint keys="Escape" label="Leave an overlay and return focus" /></dt>
				<dd class="sr-only">Escape closes the focused overlay</dd>
			</div>
			<div class="flex flex-col gap-1">
				<dt><KeyHint keys="g" label="then a letter, to go to a screen" /></dt>
				{#each NAV as item (item.href)}
					<dd class="ps-1">
						<KeyHint keys={item.letter} label={item.label} />
					</dd>
				{/each}
			</div>
		</dl>
		<p class="text-body text-muted-foreground">
			Screens add their own keys beside the action they perform, and the row of hints at the
			bottom of a screen lists the ones that apply there.
		</p>
	</DialogContent>
</Dialog>

