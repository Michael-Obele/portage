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
 * than pointing at the root one.
 *
 * The COMPILER, though, resolves from where it is imported. CI installs this
 * app's dependencies only — there is no root `node_modules` — so the loader is
 * handed a resolver rooted here. Importing the root preload instead failed in CI
 * with `Cannot find module 'svelte/compiler' from scripts/svelte-loader.ts`
 * while passing locally, where the root install is present.
 */
import { makeSveltePlugin } from "../../../scripts/svelte-loader.ts";

Bun.plugin(makeSveltePlugin(() => import("svelte/compiler")));
