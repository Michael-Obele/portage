/**
 * Wire the screen stores to the engine.
 *
 * Kept out of `screens.svelte.ts` on purpose: that module must stay importable
 * by a plain `bun test`, and `app.svelte.ts` pulls in `$app/env`, a SvelteKit
 * virtual module the test runner cannot resolve. The store is the state; this is
 * the plug.
 */
import { app } from "./app.svelte.ts";
import { routeFrame } from "./screens.svelte.ts";

let started = false;

/**
 * Start capturing frames for the screens. Called ONCE by the layout, BEFORE
 * `app.start()`, so the first frames are not missed — a scan that is already
 * running replays on hydrate, and those frames are exactly what a returning tab
 * needs.
 */
export function startScreenRouting(): () => void {
	if (started) return () => {};
	started = true;
	const stop = app.observeFrame((frame) => routeFrame(frame));
	return () => {
		stop();
		started = false;
	};
}
