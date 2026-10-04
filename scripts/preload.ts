/**
 * The runtime half of the Svelte loader.
 *
 * `bunfig.toml` preloads THIS file, not svelte-loader.ts. The reason is a trap
 * that cost an hour and is now recorded in docs/tui.md §7 and svelte-loader.ts:
 *
 *   A preload module's DEFAULT EXPORT is not registered as a runtime plugin.
 *   Verified on Bun 1.4.0 — Bun evaluates the preload module (top-level side
 *   effects run) and then never calls `setup()` on the exported plugin. Neither
 *   `onResolve` nor `onLoad` ever fires, `$state` survives into the bundle as a
 *   bare identifier, and every `.svelte.ts` file dies with
 *   `ReferenceError: $state is not defined`.
 *
 *   Calling `Bun.plugin()` explicitly is what makes it work, at run time and
 *   under `bun test`. Two lines, and the difference between "the TUI works in
 *   development" and "the TUI works only in the binary".
 *
 * This file is NOT imported by scripts/build.ts. The build passes the plugin to
 * `Bun.build()` explicitly, which is a different mechanism entirely.
 */
import { sveltePlugin } from "./svelte-loader.ts";

Bun.plugin(sveltePlugin);

export { sveltePlugin };
