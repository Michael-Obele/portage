/**
 * The Svelte 5 compiler as a Bun plugin.
 *
 * Svelte 5 needs two different compilers, and the order matters:
 *
 *   - `compileModule()` compiles a `.svelte.ts` (runes in a plain module).
 *     It parses **JavaScript**, not TypeScript, so a file containing
 *     `import { cursor, type CursorOptions }` throws `js_parse_error`.
 *     Hence the Bun.Transpiler step FIRST, then compileModule.
 *
 *   - `compile()` compiles a `.svelte` component. Portage has none (see
 *     docs/tui-impl/01-architecture.md — the renderable tree is the UI), but the
 *     loader supports them so a future component does not need a new build step.
 *
 * Used two ways, and the difference is the entire bug in docs/tui-impl/02:
 *   1. `scripts/preload.ts` calls `Bun.plugin(sveltePlugin)` -> `bun run` and
 *      `bun test` see the loader at runtime.
 *   2. passed to Bun.build() -> the compiled binary.
 *
 * A NOTE ON WHAT DOES **NOT** WORK, because it is in the docs and it is wrong:
 * exporting this plugin as the `default` of a `preload` entry does NOT register
 * it. Verified on Bun 1.4.0: Bun evaluates the preload module (its top-level
 * side effects run) and then never calls `setup()` on the default export, so
 * neither `onResolve` nor `onLoad` ever fires and `$state` survives as a bare
 * identifier. The preload must call `Bun.plugin()` itself. See preload.ts.
 */
import type { BunPlugin } from "bun";

export const sveltePlugin: BunPlugin = {
  name: "svelte",
  setup(build) {
    // `.svelte.ts` — runes outside a component. This is the one portage uses.
    build.onLoad({ filter: /\.svelte\.ts$/ }, async (args) => {
      const { compileModule } = await import("svelte/compiler");
      const source = await Bun.file(args.path).text();
      // Transpile TypeScript BEFORE handing it to compileModule. See header.
      const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
      const result = compileModule(js, {
        filename: args.path,
        generate: "client",
      });
      return { contents: result.js.code, loader: "js" };
    });

    // `.svelte` — components (unused today, kept so they keep working).
    build.onLoad({ filter: /\.svelte$/ }, async (args) => {
      const { compile } = await import("svelte/compiler");
      const source = await Bun.file(args.path).text();
      const result = compile(source, {
        filename: args.path,
        generate: "client",
        css: "injected",
        runes: true,
        compatibility: { componentApi: 5 },
      });
      return { contents: result.js.code, loader: "js" };
    });
  },
};

export default sveltePlugin;
