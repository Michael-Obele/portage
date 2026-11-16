/**
 * Runes at run time, for the desktop app's own test run.
 *
 * The root `scripts/preload.ts` does this for the whole repo, and the root
 * `bun run test` already picks it up. Running `bun test` from `apps/desktop`
 * does not, and this app now has `.svelte.ts` stores worth testing — without the
 * plugin, `$state` survives into the bundle as a bare identifier and every
 * import of one dies with `ReferenceError: $state is not defined`.
 *
 * Bun resolves `--preload` against the app directory, so this file exists rather
 * than pointing at the root one. It registers the same plugin; nothing is
 * duplicated but the two lines that must be in every entry point.
 */
import { sveltePlugin } from "../../../scripts/svelte-loader.ts";

Bun.plugin(sveltePlugin);
