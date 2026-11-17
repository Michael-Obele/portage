/**
 * The build. `bun run build` produces dist/portage.
 *
 * This file exists for exactly one reason: the CLI form of the build silently
 * produces a broken binary.
 *
 *   bun build --compile --outfile dist/portage src/tui/main.svelte.ts
 *   -> prints a normal build summary, exits 0, writes a binary
 *   -> the binary dies on startup with "ReferenceError: $state is not defined"
 *
 * Cause: `bun build` from the CLI ignores bunfig.toml's `preload`, so the
 * `.svelte.ts` loader never runs and `$state` survives into the bundle as a bare
 * identifier. `bun run` DOES honour the preload, which is exactly why
 * development works and the build does not. Only running the binary catches it.
 *
 * The Bun.build JS API takes plugins explicitly, so the loader always runs.
 */
import { sveltePlugin } from "./svelte-loader.ts";

const result = await Bun.build({
  entrypoints: ["./src/cli/index.ts"],
  // A plain `{ name, setup }` object — NOT the `plugin()` helper from "bun",
  // which Bun.build rejects with `TypeError: Expected plugin to be an object`.
  plugins: [sveltePlugin],
  compile: { outfile: "dist/portage" },
  minify: true,
  sourcemap: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Read the version from the installed package rather than importing
// `@opentui/core/package.json`: its `exports` map does not expose that file, so
// `tsc` cannot resolve the specifier even though Bun can at runtime. A build log
// line is not worth a type error in the script that ships the binary.
const openTuiVersion: string = await Bun.file("node_modules/@opentui/core/package.json")
  .json()
  .then((pkg: { version?: string }) => pkg.version ?? "unknown")
  .catch(() => "unknown");

process.stdout.write(
  `built dist/portage — binary renders the TUI (OpenTUI core ${openTuiVersion})\n`,
);
