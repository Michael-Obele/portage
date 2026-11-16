/**
 * Screen state that outlives the screen.
 *
 * The bug this fixes: every route held its view model in `$state` inside
 * `+page.svelte`, so a tab click destroyed the component and took the report,
 * the filters, and the selection with it. On this app that is expensive — a
 * duplicate scan of a 2 TB drive, a purge plan that rereads both ends, a plan
 * with a dozen hand-removed rows — so changing tabs threw away minutes of work.
 *
 * Two separate problems, one answer each:
 *
 *  1. **The component dies.** SvelteKit has no keep-alive, and `snapshot` does
 *     not help: it is bound to a HISTORY ENTRY, so a tab click (a new entry)
 *     restores nothing. With `ssr = false` the official guidance is to keep
 *     state in a shared module, which is exactly what this is — a singleton per
 *     screen whose fields are `$state`. The client router never unloads modules,
 *     so they live as long as the window.
 *  2. **Frames arrive while nobody is listening.** Each screen used to subscribe
 *     in `onMount`, so a scan that finished while you were on another tab
 *     produced a frame with no observer and the report was lost. The routing
 *     below lives at module scope and is started once by the layout, so a report
 *     is captured whichever screen is on screen.
 *
 * What does NOT belong here: anything the engine owns. Reports are captured, not
 * rewritten; `applySelection` still validates against the report the engine
 * issued, and a report whose `scanId` has expired is still refused by the
 * engine. Nothing in this file can make a stale id look fresh.
 */
import { selectionFor } from "../components/app/dupes-view.ts";
import { emptyFilters, type PlanFilters, type PlanRow } from "../components/app/plan-filters.ts";
import type { DoctorFilter } from "../components/app/doctor-view.ts";
import type { Band } from "../components/app/transfer-band.ts";
import type {
	DupesFrame,
	DoctorFrame,
	Frame,
	NeedsConfirmFrame,
	PlanResult,
	PurgePlanFrame
} from "../engine/protocol.ts";

import {
	PREF_KEYS,
	asBoolean,
	asOneOf,
	asPlanFilters,
	browserPrefs,
	readPref,
	writePref,
	type PrefStore
} from "./prefs.ts";

/** A scan scope: the engine's own roots, or everything on the destination drive. */
export type ScanScope = "configured" | "drive";

/**
 * The Plan screen.
 *
 * `plan` is `$state.raw` on purpose: a plan carries one object per file and the
 * app replaces it wholesale, so a deep proxy over thousands of rows would cost
 * for nothing.
 */
export class PlanScreen {
	plan = $state.raw<PlanResult | null>(null);
	filters = $state<PlanFilters>({ device: "", show: "", since: "all" });
	showDraft = $state("");
	selected = $state<PlanRow | null>(null);
	/** Source paths removed by hand. Kept across tabs, because it is intent. */
	excluded = $state<string[]>([]);
	dryRunNote = $state<string | null>(null);
	failure = $state<Band | null>(null);
	loading = $state(false);
	refetching = $state(false);
	confirming = $state(false);
	/** Whether a plan has ever been asked for, so remounting does not re-ask. */
	requested = $state(false);

	#prefs: PrefStore | null;

	constructor(prefs: PrefStore | null) {
		this.#prefs = prefs;
		const saved = readPref(prefs, PREF_KEYS.planFilters, asPlanFilters, emptyFilters());
		this.filters = saved;
		this.showDraft = saved.show;
	}

	/** Replace the filters, and remember them for the next launch. */
	setFilters(next: PlanFilters): void {
		this.filters = next;
		writePref(this.#prefs, PREF_KEYS.planFilters, next);
	}
}

/** The Duplicates screen. */
export class DupesScreen {
	scan = $state.raw<DupesFrame | null>(null);
	selection = $state<Set<string>>(new Set());
	scanning = $state(false);
	applying = $state(false);
	failure = $state<Band | null>(null);
	staleSelection = $state(false);
	pendingConfirm = $state<NeedsConfirmFrame | null>(null);
	sheetOpen = $state(false);
	scope = $state<ScanScope>("configured");

	#prefs: PrefStore | null;

	constructor(prefs: PrefStore | null) {
		this.#prefs = prefs;
		this.scope = readPref(prefs, PREF_KEYS.dupesScope, asOneOf(["configured", "drive"]), "configured");
	}

	/** Change what a scan covers. The report belongs to the old scope and goes. */
	setScope(next: ScanScope): void {
		if (next === this.scope) return;
		this.scope = next;
		this.scan = null;
		this.selection = new Set();
		this.staleSelection = false;
		writePref(this.#prefs, PREF_KEYS.dupesScope, next);
	}
}

/** The Purge screen. */
export class PurgeScreen {
	plan = $state.raw<PurgePlanFrame | null>(null);
	plannedAt = $state<Date | null>(null);
	selection = $state<Set<string>>(new Set());
	planning = $state(false);
	applying = $state(false);
	reRead = $state(false);
	failure = $state<Band | null>(null);
	staleSelection = $state(false);
	pendingConfirm = $state<NeedsConfirmFrame | null>(null);
	sheetOpen = $state(false);

	#prefs: PrefStore | null;

	constructor(prefs: PrefStore | null) {
		this.#prefs = prefs;
		this.reRead = readPref(prefs, PREF_KEYS.purgeVerify, asBoolean, false);
	}

	setReRead(next: boolean): void {
		this.reRead = next;
		writePref(this.#prefs, PREF_KEYS.purgeVerify, next);
	}
}

/** The Doctor screen. */
export class DoctorScreen {
	report = $state.raw<DoctorFrame | null>(null);
	running = $state(false);
	filter = $state<DoctorFilter>("all");
	failure = $state<Band | null>(null);

	#prefs: PrefStore | null;

	constructor(prefs: PrefStore | null) {
		this.#prefs = prefs;
		this.filter = readPref(prefs, PREF_KEYS.doctorFilter, asOneOf(["all", "problems"]), "all");
	}

	setFilter(next: DoctorFilter): void {
		this.filter = next;
		writePref(this.#prefs, PREF_KEYS.doctorFilter, next);
	}
}

/**
 * The Transfer screen's own flags.
 *
 * `began` is the important one. It says "this URL's intent has already been
 * acted on", and it used to be local — so navigating away from a finished run
 * and coming back to `/transfer?mode=…` could start the SAME pull again. The
 * run view itself lives in `run.svelte.ts`, which was always module-scoped.
 */
export class TransferScreen {
	starting = $state(false);
	startFailure = $state<Band | null>(null);
	nothingToMove = $state(false);
	startingNames = $state<string[]>([]);
	firstVerifyAt = $state<number | null>(null);
	busy = $state(false);
	/**
	 * The intent URL a person actually ASKED for, one-shot.
	 *
	 * A URL is not a click. `/transfer?mode=…` can arrive from a bookmark, a
	 * reload, a Back button or a link, and starting a copy from any of those
	 * would act on nobody's request. So the Plan screen mints a token when
	 * "Pull"/"Copy only" is pressed, the Transfer screen consumes it once, and
	 * anything else is offered as a button instead of being started silently.
	 */
	pending = $state<string | null>(null);

	/** An intent that arrived without a token and is waiting to be started. */
	awaitingStart = $state<string | null>(null);

	/** Mint the one-shot token for a click. */
	request(search: string): void {
		this.pending = search;
	}

	/**
	 * Consume the token, if it matches. A fixture is exempt: it cannot copy
	 * anything, and gating it would make `?mock=run&mode=…` unreachable.
	 */
	takeIntent(search: string, mock = false): boolean {
		if (mock) return true;
		if (this.pending !== search) return false;
		this.pending = null;
		return true;
	}
}
/** The Settings screen's unsaved draft. Local to the window, never persisted. */
export class SettingsScreen {
	draft = $state<string | null>(null);
	saving = $state(false);
	saveError = $state<string | null>(null);
	saveFix = $state("");
	loaded = $state(false);
}

function buildScreens(prefs: PrefStore | null) {
	const plan = new PlanScreen(prefs);
	const dupes = new DupesScreen(prefs);
	const purge = new PurgeScreen(prefs);
	const doctor = new DoctorScreen(prefs);
	const transfer = new TransferScreen();
	const settings = new SettingsScreen();

	/**
	 * Throw away everything that belonged to an ENGINE PROCESS.
	 *
	 * A report's `scanId`/`planId` lives in the engine's pending register, so it
	 * is only as alive as the process that issued it. After a restart the old
	 * numbers look usable and every action on them is refused — which is exactly
	 * why reports are never written to disk. Preferences stay: they are inputs,
	 * not facts.
	 */
	function reset(): void {
		plan.plan = null;
		plan.requested = false;
		plan.selected = null;
		plan.failure = null;
		plan.dryRunNote = null;
		plan.loading = false;
		plan.refetching = false;
		plan.confirming = false;
		plan.excluded = [];

		dupes.scan = null;
		dupes.selection = new Set();
		dupes.scanning = false;
		dupes.applying = false;
		dupes.failure = null;
		dupes.staleSelection = false;
		dupes.pendingConfirm = null;
		dupes.sheetOpen = false;

		purge.plan = null;
		purge.plannedAt = null;
		purge.selection = new Set();
		purge.planning = false;
		purge.applying = false;
		purge.failure = null;
		purge.staleSelection = false;
		purge.pendingConfirm = null;
		purge.sheetOpen = false;

		doctor.report = null;
		doctor.running = false;
		doctor.failure = null;

		transfer.starting = false;
		transfer.startFailure = null;
		transfer.nothingToMove = false;
		transfer.startingNames = [];
		transfer.firstVerifyAt = null;
		transfer.busy = false;

		settings.draft = null;
		settings.saving = false;
		settings.saveError = null;
		settings.saveFix = "";
		settings.loaded = false;
	}

	return { plan, dupes, purge, doctor, transfer, settings, reset };
}

export const screens = buildScreens(browserPrefs());

/**
 * Route a frame into the screen it belongs to.
 *
 * Pure enough to test: it takes the store bag as an argument rather than closing
 * over the singleton, so a test can drive it with fakes.
 */
export function routeFrame(
	frame: Frame,
	into: ReturnType<typeof buildScreens> = screens
): void {
	switch (frame.type) {
		case "plan": {
			into.plan.plan = frame.plan;
			into.plan.requested = true;
			into.plan.failure = null;
			return;
		}
		case "dupes": {
			into.dupes.scan = frame;
			// A fresh report re-derives the default selection: tier 1 inside,
			// tier 2 out. Keeping an old selection across a new scan would point
			// keys at a report the engine no longer holds.
			into.dupes.selection = selectionFor(frame.groups);
			into.dupes.staleSelection = false;
			return;
		}
		case "purgePlan": {
			into.purge.plan = frame;
			into.purge.plannedAt = new Date();
			into.purge.selection = new Set();
			into.purge.staleSelection = false;
			return;
		}
		case "doctor": {
			into.doctor.report = frame;
			return;
		}
		case "needsConfirm": {
			// The sheet belongs to whichever screen asked for the action.
			if (frame.action === "dupes.apply") {
				into.dupes.pendingConfirm = frame;
				into.dupes.sheetOpen = true;
			} else if (frame.action === "purge.apply") {
				into.purge.pendingConfirm = frame;
				into.purge.sheetOpen = true;
			}
			return;
		}
		default:
			return;
	}
}

/** A fresh bag of stores. Tests pass `null` so nothing is read from disk. */
export function freshScreens(prefs: PrefStore | null = null) {
	return buildScreens(prefs);
}
