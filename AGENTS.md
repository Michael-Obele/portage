# AGENTS.md

Rules and hard-won facts for working in this repo. Read this before touching code.

## What this is

Portage moves a phone's downloads onto an archive drive, verifies every byte, and
reclaims space on that drive. **The product is the desktop app (`apps/desktop/`)
plus `scripts/apull.sh`.** There is no CLI and no TUI — both were deleted on
2026-11-17. Windows and Apple are future work; nothing is built for them today.

`dist/portage` is not a user tool: it is the engine the app spawns as a sidecar
and speaks a JSON line protocol with (one request per line in, one frame per line
out). `dist/portage-scan` is a Rust helper the engine spawns.

## Their rules (the owner's words, paraphrased)

1. **Terse comments.** Explain *why*, never *what*. No narration, no restating the
   signature, no essays. If a fact matters across files, it belongs here, not in a
   forty-line header. Target: a file header ≤ 6 lines, inline comments ≤ 2.
2. **No demo for a finished product.** A gate that was not run is a failed gate.
   Screens must be exercised, not eyeballed once.
3. **Do not reinvent.** Standard library first, then a well-known package, then
   code. `Intl.RelativeTimeFormat`/`Intl.NumberFormat`/`Intl.DateTimeFormat` are
   the answer for dates and numbers; do not add date-fns/dayjs for that.
4. **Honest UI.** Never show a number the code cannot stand behind. Distinguish
   "nothing found" from "nothing I could read". Say which walker ran.
5. **Never delete the last copy.** Re-check survivors **on disk**, never against a
   report snapshot.
6. **Ask before one-way doors** (deleting a tree, rewriting history, changing a
   security posture). Everything reversible: just do it.

## Commands

```bash
bun run test           # engine + dedupe + serve (449)
bun run typecheck      # tsc, includes scripts/
bun run build          # dist/portage
bun run build:scanner  # cargo build --release + stage dist/portage-scan
cd crates/portage-scan && cargo test          # 28
cd apps/desktop && bun run check              # svelte-check, must be 0/0
cd apps/desktop && bun run test               # 212
cd apps/desktop && bun run build && bun run ui:sweep   # 7-step headless journey
```

`ui:sweep` drives the built SPA in headless Chrome over CDP. It proves the
**screens**; the engine has its own suites. It is in CI.

## Traps (each one cost real time)

- **`Bun.file().exists()` is false for a directory.** Use `statSafe` (node `stat`)
  or `stat`/`lstat`. This made `isDirectory()` false for every directory.
- **`toISOString().slice(0,10)` is the UTC day.** Trash folders use `localDayKey`
  — and the desktop has its own copy; `test/units.test.ts` asserts they agree.
- **The engine's command loop is sequential.** While a command runs, no later
  line is read, so a command cannot be cancelled mid-flight. "Stop scan" therefore
  restarts the engine. A real cancel needs `dupes.scan` to become start-like.
- **`externalBin` entries are all required at build time.** `tauri-build` copies
  each one and fails if missing; CI must `touch` a placeholder for `portage` **and**
  `portage-scan`.
- **`#lib/*` resolves per package**: `./src/*` at the root, `./src/lib/*` in
  `apps/desktop`. A `#lib` import inside a desktop file that the root tests import
  would load the *engine's* module. Two files cross that boundary; both must stay
  import-free (`test/units.test.ts` guards it).
- **ntfs-3g charges by path component.** One folder holds a 462-segment chain. A
  full-path walk took **175 s**; a `chdir` walk of the same tree took **4.1 s**.
  JavaScript has no `openat`, which is why the walker is Rust.
- **A whole-drive scan is expensive.** Tier 1 hashes every same-size candidate:
  33,314 files / 1.3 TB produced 803 groups / 111 GB reclaimable, and on a cold USB
  mount it runs for hours. Default UI scope is the configured folders.
- **`PR_SET_PDEATHSIG`** in `crates/portage-scan` is what stops an orphaned walker
  surviving an engine restart. Do not remove it; it was verified by SIGKILLing the
  engine mid-scan.
- **`cargo clippy -D warnings` rejects `assert!(CONST > n)`**; use
  `const _: () = assert!(..)`.
- **Never `console.log` in the engine** — stdout is the protocol.

## Driving the real app (tauri MCP)

1. Build a debug shell: `SKIP_BUILD=1 bunx tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json`.
2. `tauri.conf.json` keeps a **strict CSP for production**; the bridge injects
   scripts, and WebKitGTK applies `script-src` to injected user scripts, so the
   helper never registers. `tauri.dev.conf.json` sets `csp: null` for that reason.
   Do not copy that into the production config.
3. Start the app, then **stop and start the driver session** — the ref helper is
   registered once per session, so a session that outlived its app cannot work, and
   every JS/click/screenshot tool fails with "Resolve-ref helper was not available".
4. `webview_wait_for` is bounded by the plugin's ~5 s eval deadline. For long work,
   poll `document.body.innerText` with `webview_execute_js` instead.
5. `webview_interact` with a text selector fails when several nodes match; pass
   `nth`, a CSS selector, or click through `webview_execute_js`.
6. Only `webview_*` tools need the helper. `manage_window` and
   `ipc_get_backend_state` are native/bridge-level and keep working.

## Research (tomoshi, exa)

Use `mcp_tomoshi-mcp_tomoshi_discover`/`_extract` (or exa) for library docs, API
behaviour and error strings **before** guessing. `tomoshi_monitor` is
change-tracking, not search: point it at a page you want to be told about later.

## Memory (sepia)

`manage_entity`/`manage_memory` hold the durable project facts. Before a decision
that contradicts an earlier one, search memory first; after learning something
structural (a trap, a scope change, a release outcome), write it back.

## Svelte 5 / SvelteKit patterns

- Runes only work in `.svelte`/`.svelte.ts`. Runes in a plain `.ts` silently fail
  under `bun build --compile` unless `scripts/svelte-loader.ts` is passed to
  `Bun.build` — `scripts/build.ts` does that explicitly.
- Screen state lives in module singletons (`lib/state/screens.svelte.ts`), not in
  components: tab changes destroy components, and frames arrive while no component
  is mounted.
- Derive, don't sync: `$derived` for values, `$effect` only for external systems
  (intervals, subscriptions). A `$effect` writing state that a `$derived` could
  compute is a bug.
- `$state.raw` for big immovable objects (a report); plain `$state` for editables.
- Use `Intl` for dates/numbers. Use `formatBytes`/`plural`/`formatDuration` from
  `lib/util/format.ts` — one rendering per number.
- Imports use `#lib/...`. Keep the extension the file already uses.
- Styling: Tailwind v4 tokens only (`bg-card`, `text-muted-foreground`,
  `rounded-surface`), the `CONTROL` class for buttons, `data-numeric` +
  `tabular-nums` for figures. No ad-hoc colours; `bun run a11y` checks contrast.
- Components come from shadcn-svelte (`components/ui/`, generated — do not hand
  edit) over Bits UI primitives. Query the shadcn-svelte MCP for the component and
  its props before writing markup; never port React props (`asChild`).
- After editing a Svelte file, run the Svelte MCP `svelte-autofixer` and fix what
  it reports before moving on.

## Design and review process

- **`skill-wayfinder`** — orient before acting: read the map (this file, TODO.md,
  the route) before editing.
- **`skill-ponytail`** — laziness ladder: stdlib → dependency → code; delete before
  adding; smallest correct diff.
- **`skill-caveman`** — terse output when speed matters; still accurate.
- **`skill-discretion`** — act by default; ask only for one-way doors.
- **`skill-motion-psychology`** — motion explains state changes, never decorates;
  short, eased, and absent under `prefers-reduced-motion`.
- **`skill-mobile-product-page-ui`** — one dominant action per screen, thumb reach,
  cut what does not serve the goal.
- **`skill-subagent-driven-development` / `skill-swarm-orchestration`** — split work
  into isolated, verifiable pieces; each lands with its own evidence.
- **Forge agents** — before calling a change done, run `forge` (or `forge-contract`,
  `forge-logic`, `forge-security`, `forge-quality`, `forge-verify`) and act on the
  findings. The last run found a data-loss bug in the most important route; assume
  there is one.

## Definition of done

1. `typecheck`, root tests, desktop `check` + tests, `cargo test`, `ui:sweep` — all
   green. Evidence, not assertion.
2. Exercised against the real drive when the change touches scanning, trash or
   Doctor (`df` before/after for anything that claims to free space).
3. Docs told the truth: README/TODO updated if behaviour changed.
4. Conventional commit, `scripts/check-commits.sh HEAD~1 HEAD` passes.
5. Release: push → release-please PR → merge → the run tags after installers
   exist. Confirm the `.deb` contains `usr/bin/portage-scan`.

## Known gaps

- A running scan cannot be cancelled; stopping it restarts the engine.
- The scan's walk phase reports no progress beyond "walking <root>".
- Purge needs a phone; only its refusals are covered by tests.
- `crates/portage-scan` is versioned separately (0.1.15) from the app.
- Windows and Apple are not started.
