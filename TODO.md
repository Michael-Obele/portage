# Portage — master TODO & status

**The one file to tick off.** Everything else in `docs/` is the _spec_; this is the _state_.
Seeded 2026-10-04 from a full pass over `docs/`, the source tree, and the
`portage-tui-dedupe-2026-10-04` build session.

Back to [README](./README.md) · Spec: [docs/](./docs/README.md) · Milestones: [docs/milestones.md](./docs/milestones.md) · TUI gates: [docs/tui-impl/06-acceptance.md](./docs/tui-impl/06-acceptance.md)

---

## How to use this file

- Tick `[x]` when the _Done when_ condition is actually met — not when the code exists.
- **A gate that was not run is a failed gate.** If you cannot run it, leave it `[~]` or `[!]` and write why.
- Add new items under the right milestone. Keep the snapshot table honest — update it when you close a milestone.
- Line references below (`src/…:NNN`) are a starting point; they drift.

### Legend

| Mark  | Means                                                                                           |
| ----- | ----------------------------------------------------------------------------------------------- |
| `[x]` | **Done** — built _and_ verified (test, or a real run whose output was seen)                     |
| `[~]` | **Built, not proven** — code exists, the gate/acceptance was never actually exercised           |
| `[ ]` | **Not done**                                                                                    |
| `[!]` | **Blocked** — needs real hardware (phone/drive/TTY) or needs Michael (sudo, a tap on the phone) |
| `—`   | Not applicable / superseded                                                                     |

---

## Snapshot — 2026-10-04

| Thing            | State                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tests            | **101 pass / 0 fail** (`bun run test`)                                                                                                                                                                                                                 |
| Typecheck        | **clean** (`tsc --noEmit`)                                                                                                                                                                                                                             |
| Build            | `bun run build` → `dist/portage`, ~96–100 MB, **renders**                                                                                                                                                                                              |
| Engine files     | `src/xfer src/index src/plan src/scan` **untouched** by the TUI/dedupe work (gate F3)                                                                                                                                                                  |
| Git              | ⚠️ **everything from the TUI + dedupe work is UNCOMMITTED** (untracked `src/tui/`, `src/dedupe/`, `scripts/*`, `bunfig.toml`, 2 test files; modified `package.json`, `src/cli/index.ts`, `src/util/hash.ts`, `tsconfig.json`, `README.md`, `bun.lock`) |
| CLI surface      | 11 commands: `doctor` `devices` `scan` `plan` `pull` `tui` `status` `dupes` `purge` `config` `db`                                                                                                                                                      |
| TUI              | built (7-step spec complete incl. dedupe screen); 5 of 30 acceptance gates unproven                                                                                                                                                                    |
| Dedupe           | engine built (tier 1 + tier 2), report + review + `--apply` to trash; **journalling not written**                                                                                                                                                      |
| Not built at all | `portage retry`, `portage verify`, `portage trash`, `--organize`, Tier-2 transfer pre-check, `archive.anime_key`                                                                                                                                       |

### Working command surface (verified against `src/cli/index.ts`)

| Command         | Flags implemented                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `doctor`        | `--bench`                                                                                                          |
| `devices`       | —                                                                                                                  |
| `scan` / `plan` | `--device` `--show` `--since`                                                                                      |
| `pull`          | `--device` `--show` `--since` `--jobs` `--transport` `--dry-run` `--keep-source` `--delete-source` `--verify-hash` |
| `tui`           | (mounts the dashboard)                                                                                             |
| `status`        | `--run` (limit)                                                                                                    |
| `dupes`         | `--tier 1\|2` `--no-auto` `--apply <path…>` `--dry-run`                                                            |
| `purge`         | `--dry-run` `--verify-hash`                                                                                        |
| `config`        | `get` `set` `keys`                                                                                                 |
| `db`            | `info` `vacuum` `export`                                                                                           |
| global          | `--plain` `--json` `--no-tui` `--verbose` `--quiet` `--yes` `--config` `--dest-root` `--version` `--help`          |

---

## ⏭️ Do these next (short list)

1. **Commit the TUI + dedupe work** (it is all uncommitted; Conventional Commits, no AI attribution).
2. **Run the TUI by hand in a real terminal** → closes gates **C4** (`Ctrl-C` exits 5, terminal usable) and **E5** (resize redraws): `bun run build && ./dist/portage tui`, then `./dist/portage dupes`.
3. **Diff the live screen against `--json`** for one run → closes gate **B1** (JSON parity).
4. **`portage retry`** — the one missing everyday command (the TUI has `r`, the CLI does not).
5. **`portage trash`** (`list` / `--restore` / `--empty`) — right now the dedupe apply message says "restore with `portage trash`" and that command does not exist.

---

## 1. Milestones (docs/milestones.md)

### M0 — Recon and the spike gate

| #         | Task                                         | State | Evidence / note                                                                                                                                  |
| --------- | -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0-1      | Drive: fs, driver, mount options, free space | `[x]` | NTFS, recorded in `docs/decisions.md` (482 GB free, 75 % used)                                                                                   |
| M0-2      | `lsusb -t` link speed, drive **and** phone   | `[~]` | Measured at **480 Mbit**; C→C cable + USB 3 port **not yet tried**                                                                               |
| M0-3      | `sudo apt install xxhash` (**Michael**)      | `[!]` | `xxhsum` still absent; optional                                                                                                                  |
| M0-4      | SMART through the USB bridge                 | `[ ]` | Open question — never answered                                                                                                                   |
| M0-5      | Termux setup on the Pixel                    | `—`   | Deprioritised: D2 demoted rsync/Termux to fallback                                                                                               |
| **M0-S1** | **The make-or-break spike**                  | `[x]` | 27.6 MB/s durable 1-stream, 40.8 MB/s @3; corruption test gave non-zero exit + intact source → **gate passed, transport flipped to plain `adb`** |

**M0 gate:** ✅ passed. `jobs = 3`. First real job (Higehiro: 17 of 23 already on drive) proved the "know what I already have" promise.

### M1 — Skeleton and `doctor`

| #     | Task                                                                 | State | Note                                                                                               |
| ----- | -------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| M1-1  | `bun init`, deps, strict tsconfig                                    | `[x]` | valibot (D24), not zod                                                                             |
| M1-2  | Dispatch, global flags, typed errors → exit codes 0–5                | `[x]` | `src/cli/index.ts`, `src/util/errors.ts`                                                           |
| M1-3  | Config: precedence + `config get/set`                                | `[x]` | `src/config/{load,schema}.ts`, `CONFIG_KEYS`                                                       |
| M1-4  | `src/device/adb.ts` adapter                                          | `[x]` | devices/getprop/serialId/forward/runAs/linkSpeed                                                   |
| M1-5  | `portage doctor` (incl. `--bench`)                                   | `[x]` | `doctor exit=0` recorded                                                                           |
| M1-6  | Fixtures: fake `adb` **and** `rsync` (ok / die@60% / checksum-error) | `[~]` | Only `test/fixtures/fake-adb` exists. **No `fake-rsync`, no die-at-60% / checksum-error variants** |
| M1-S1 | Ink-on-Bun spike                                                     | `—`   | Superseded: renderer is **OpenTUI 0.5.14** (D5, revised 2026-10-04 after a measured A/B)           |

### M2 — Journal, scan, plan

| #       | Task                                                                  | State | Note                                                                                                                                   |
| ------- | --------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| M2-1    | `bun:sqlite` journal + `user_version` migrations                      | `[x]` | `src/index/journal.ts`                                                                                                                 |
| M2-2    | Recovery / reconcile on start                                         | `[x]` | `src/index/recovery.ts`; crash-recovery tests exist                                                                                    |
| M2-3    | Remote walk + eligibility rules                                       | `[x]` | `src/scan/scan.ts`                                                                                                                     |
| M2-4    | `portage scan` + `--json`                                             | `[x]` |                                                                                                                                        |
| M2-5    | `src/plan/`: dest resolution, space check, Tier-1 pre-check hook, ETA | `[~]` | **ETA is dead**: `PlanOptions.rateBps` is never passed, so `etaSeconds` is always null. Tier-1 pre-check hook exists but is not called |
| M2-6    | `portage plan` with byte total + per-file reason                      | `[x]` |                                                                                                                                        |
| M2 acc. | Real season, twice = no-op, `--json` round-trips                      | `[~]` | Unit-tested; not re-run against real hardware in this session                                                                          |

### M3 — The transfer core

| #       | Task                                                                                               | State | Note                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| M3-1    | `adb pull` primary transport; rsync behind same interface                                          | `[x]` | `src/xfer/adb.ts`, `src/xfer/transport.ts`                                            |
| M3-2    | Per-file state machine wired to journal                                                            | `[x]` | `src/xfer/engine.ts`                                                                  |
| M3-3    | Verification gate (exit 0 + size + content + transferred-this-run)                                 | `[x]` | `test/verify-gate.test.ts`; banner-level tests                                        |
| M3-4    | Parallel scheduler, `jobs` from config, auto-drop on 480M                                          | `[~]` | Scheduler exists; auto-drop not confirmed by a run                                    |
| M3-5    | `status`, **`retry`**, `pull --dry-run`                                                            | `[~]` | `status` and `--dry-run` ✅; **`portage retry` not built**                            |
| M3-6    | Interruption: Ctrl-C / SIGTERM leave partials + resumable journal                                  | `[~]` | Signal flag implemented; real interrupt not exercised (gate C5)                       |
| M3-7    | `delete_source` modes + `--keep-source` / `--delete-source`                                        | `[x]` |                                                                                       |
| M3-8    | `portage purge` (journal hash or `--verify-hash`)                                                  | `[x]` | `src/xfer/purge.ts`                                                                   |
| M3 acc. | Full season; cable pull @50 % resumes; corruption **through Portage** blocked; keep-source + purge | `[~]` | M0 proved the mechanics; the through-Portage hardware run is **not re-recorded here** |

### M4 — Tier 1 duplicates

| #       | Task                                                                 | State | Note                                                                               |
| ------- | -------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| M4-1    | Tier-1 engine: metadata pass → sample hash (reject only) → full hash | `[x]` | `src/dedupe/tier1.ts`. **Deviation from D7:** own pipeline, **`jdupes` not used**  |
| M4-2    | Suggested keeper, advisory, never applied                            | `[x]` | with printed reason                                                                |
| M4-3    | Collision detection (`path_norm`, different size/mtime)              | `[ ]` | Not found in code                                                                  |
| M4-4    | `dupes --tier 1 --plain/--json`; write `dupe_groups`/`dupe_members`  | `[~]` | Report ✅; **journal writes NOT done** (tables exist unused, `journal.ts:186-197`) |
| M4-5    | Per-item delete → `.portage/trash/<date>/`; truncated never offered  | `[x]` | `applySelection`; no bulk path, no `--yes`                                         |
| M4 acc. | Same-size-different-content is **not** reported identical            | `[x]` | `test/dedupe.test.ts` "§6 rule 10 — the deliberate break"                          |

### M5 — Tier 2 (same episode, different release)

| #       | Task                                                                             | State | Note                                                                                                             |
| ------- | -------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------- |
| M5-1    | Filename parser → `EpisodeKey`                                                   | `[x]` | `parse-torrent-title@3.0.1` in `src/dedupe/tier2.ts` (no `src/anime/` module; parsing lives in dedupe)           |
| M5-2    | Title normalisation                                                              | `[x]` |                                                                                                                  |
| M5-3    | Group key `(show, season ?? ABSOLUTE, episode)`; unparsed never guessed          | `[x]` |                                                                                                                  |
| M5-4    | Scoring heuristic, advisory, with a printed reason                               | `[x]` |                                                                                                                  |
| M5-5    | Populate `archive.anime_key` during transfers                                    | `[ ]` | **Not done** — needs a journal writer that avoids frozen `src/index/`                                            |
| M5-6    | `dupes --tier 2` review flow, no `--yes`                                         | `[x]` |                                                                                                                  |
| M5 acc. | Michael-naming sample set; 1080p/720p grouped, never auto-deleted; no bad merges | `[x]` | Caveat: `Frieren - 07 [1080p][SubsPlease].mkv` (bare `- 07`) parses to `undefined` → lands in `unparsed`, per §5 |

### M6 — TUI dashboard

| #    | Task                                                                 | State | Note                                                               |
| ---- | -------------------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| M6-1 | `Renderer` interface + OpenTUI impl; capability detection            | `[x]` | `src/tui/renderer.svelte.ts` (only file importing `@opentui/core`) |
| M6-2 | Four-band dashboard                                                  | `[x]` | `src/tui/screens/dashboard.ts`                                     |
| M6-3 | Live wiring, 200 ms tick, no per-byte re-render                      | `[x]` | `src/tui/sink.ts`, `runner.ts`                                     |
| M6-4 | Two rates + EWMA + honest ETA (≥3 samples, ≥30 MB, α 0.3)            | `[x]` | `honestEta()` in `state.svelte.ts`; gates D1/D2 tested             |
| M6-5 | Keybindings + terminal restored on every exit path                   | `[~]` | bindings ✅; `Ctrl-C` path not run in a real terminal (gate C4)    |
| M6-6 | Degradation: `--plain`, `--json`, `NO_COLOR`, non-TTY, narrow, ASCII | `[x]` | `src/tui/degrade.ts`; tests for `NO_COLOR`, `LANG=C`, 40 cols      |

### M7 — TUI review screens and organisation

| #    | Task                                                                            | State | Note                                                  |
| ---- | ------------------------------------------------------------------------------- | ----- | ----------------------------------------------------- |
| M7-1 | Dupe review screen: Tier 1 pre-ticked, Tier 2 never, footer names trash + total | `[x]` | `src/tui/screens/dupes.ts`                            |
| M7-2 | `k` keep / `space` toggle / `u` undo / `j n` nav / `enter` confirm              | `[x]` |                                                       |
| M7-3 | `o` organise preview (read-only)                                                | `[ ]` | Not seen                                              |
| M7-4 | `--organize` writer (4 rules)                                                   | `[ ]` | `--organize` is not a flag; help says "Not built yet" |
| M7-5 | `@clack/prompts` flows for the non-TUI path                                     | `[ ]` | Not a dependency                                      |

### M8 — Hardening

| #    | Task                                                                              | State | Note                                                                      |
| ---- | --------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------- |
| M8-1 | Two phones at once, distinct roots/jobs, no journal cross-talk                    | `[ ]` | Never tested                                                              |
| M8-2 | NTFS realities: read-only detection, dirty bit, case collisions, driver perf note | `[~]` | `doctor` reports fs + driver; read-only/dirty-bit handling not verified   |
| M8-3 | Capacity guard: refuse run leaving < `space_headroom`; suggest reclaimable        | `[~]` | `space_headroom` in config + `statvfs` in plan; refuse-path not exercised |
| M8-4 | Recovery drills: `kill -9`, unplug drive mid-run, restore journal from backup     | `[~]` | `reconcile` unit-tested only                                              |
| M8-5 | `verify --deep` on a sample; `db vacuum`; `events.jsonl` rotation                 | `[~]` | `db vacuum` ✅; **`verify` not built**; rotation not seen                 |
| M8-6 | Wi-Fi fallback tested E2E; adb fallback with corrupted-file retry                 | `[ ]` | Not tested                                                                |

### M9 — Package and hand over

| #    | Task                                                                                                           | State | Note                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| M9-1 | Single binary in `~/.local/bin/portage`                                                                        | `[x]` | `bun run build` → `dist/portage` (via `Bun.build` JS API, **not** `--compile` — D18)                     |
| M9-2 | `bun test` green; fake-transport E2E: success, mid-file death, checksum error, vanished source (24), disk full | `[~]` | 101 green ✅; **fixtures incomplete** — no fake `rsync`, and disk-full / vanished-source E2E not present |
| M9-3 | `scripts/portage-phone-setup.sh` (idempotent)                                                                  | `[ ]` | `scripts/rehearse.sh` exists but is a different thing                                                    |
| M9-4 | Shell completion (`portage completions bash\|zsh`)                                                             | `[ ]` | Not built                                                                                                |
| M9-5 | README for the repo                                                                                            | `[x]` | Revamped (badges, quickstart, contract)                                                                  |

---

## 2. TUI acceptance gates (docs/tui-impl/06-acceptance.md)

Source: the build session's own record. `✅` = command + output seen; `🧪` = covered by a unit test only; `❌` = not run.

**A — Build & packaging**

- [x] A1 compiled binary renders the TUI ✅
- [x] A2 no `$state is not defined` (`grep -c ReferenceError` → `0`) ✅
- [x] A3 plain CLI works from the same binary (`--help`, `doctor`) ✅
- [x] A4 no CLI `bun build --compile` path left in `package.json` ✅

**B — The view is a view**

- [~] B1 every number on screen also exists in JSON 🧪 _(asserted against the same functions — **not yet diffed against a live screen**)_
- [~] B2 every action reachable without the TUI _(the `dupes --apply` / `pull --plain` paths exist; not run as a gate)_
- [x] B3 TUI never writes outside its frame ✅
- [x] B4 no `console.log` under `src/tui/` ✅

**C — Safety**

- [x] C1 nothing deleted without a confirmation naming files ✅
- [x] C2 Tier 2 never pre-ticked ✅
- [x] C3 `q` during a transfer asks first ✅
- [!] C4 `Ctrl-C` exits `5`, terminal usable ❌ **needs a real terminal** (blocked item #1)
- [!] C5 killed transfer leaves the journal resumable ❌ **needs a phone** (blocked item #2)

**D — Honesty of the numbers**

- [x] D1 no ETA before 3 samples and 30 MB ✅
- [x] D2 two rates, both labelled ✅
- [x] D3 a stalled file says so ✅
- [x] D4 JSON reports `eta_seconds: null` when unknown ✅

**E — Terminal behaviour**

- [x] E1 piping produces no escape codes ✅
- [~] E2 `NO_COLOR` removes colour, keeps layout 🧪
- [x] E3 40 columns does not wrap the frame ✅
- [x] E4 `LANG=C` uses ASCII glyphs ✅
- [!] E5 resize redraws at the new width ❌ **by hand in a real terminal** (blocked item #1)
- [~] E6 every exit path restores the terminal 🧪 _(unmount test; SIGTERM + forced throw not run)_

**F — Regression**

- [x] F1 `bun test` passes ✅ (101/101)
- [x] F2 `bun run typecheck` clean ✅
- [x] F3 engine files untouched ✅ (`git diff --stat src/xfer src/index src/plan src/scan` empty)
- [x] F4 no unrecorded runtime dependency ✅ (D18 records `@opentui/core`, `svelte`)

---

## 3. Dedupe safety rules (docs/dedupe.md §6)

- [x] 1. Nothing deletes automatically, in either tier; no `--yes` anywhere — `applySelection` is the only mover
- [x] 2. Report first, always; `dupes` is read-only until a path is named
- [x] 3. Delete = move to `.portage/trash/<date>/` — **partial**: the move happens, but the _decision is not journalled_ (`decided_by`/`decided_at` unwritten)
- [x] 4. Never cross a "keep" boundary (`keep.txt`, `*.important`)
- [x] 5. Never delete the last copy (double-pass over the selection, `normPath` on both sides)
- [x] 6. Never delete outside `dest_root` (`resolveInside` verified: `..`, nested `..`, absolute, NUL, shared-prefix sibling)
- [x] 7. Case-insensitive comparison via `normPath`
- [x] 8. Reclaimable total shown before acting
- [x] 9. The phone is never part of a dedupe run
- [x] 10. Deliberate-break test: same-size-different-content not reported identical (`test/dedupe.test.ts`)
- [x] 11. Report separates "same size" from "same bytes"; truncated flagged (scan-wide `flagTruncated`, not per-group)

---

## 4. Product success criteria (docs/README.md)

- [~] `portage plan` lists exactly the new episodes, nothing already on the drive
- [~] `pull` moves an 8 GB season ≥ 35 MB/s on USB3, phone copies gone _(27.6 MB/s durable on USB 2 today; USB 3 not tried)_
- [!] Cable pulled mid-transfer → fails loudly, partial survives, **re-run resumes** _(needs hardware — gate C5)_
- [!] Deliberately corrupted phone copy → destination not accepted, phone file not deleted, visible in `status` _(needs hardware)_
- [x] Corrupt-but-identical destination is re-transferred, not skipped; no delete on a skip _(banner + verify-gate tests)_
- [!] `pull --keep-source` then `purge` deletes exactly those files _(needs hardware)_
- [x] `portage dupes` reports byte-identical groups and deletes nothing (with or without `--yes`)
- [x] Same episode in 1080p + 720p reported as _same episode, different release_
- [x] Report spans multiple roots; flags the truncated fragment as `suspicious: truncated`
- [~] Anime lands in `/media/node/2TB/Videos/$Anime` unreorganised _(config default; not re-verified this session)_
- [ ] `portage verify --deep` re-hashes the archive against the journal — **command not built**
- [x] One file in `~/.local/bin/portage`; `--plain` usable in a pipe
- [~] TUI never requires the mouse; every destructive action names the exact files _(keyboard-only ✅; real-terminal run pending)_

---

## 5. Not built yet — consolidated

CLI commands explicitly listed in `src/cli/index.ts` help as missing:

- [ ] `portage retry` — re-queue `failed` files, resume from `.portage/partial/`
- [ ] `portage trash [--empty]` — inspect / restore / empty recoverable trash _(the dedupe apply message already tells the user to run it)_
- [ ] `portage verify [--deep] [--since …]` — re-check the archive against stored hashes
- [ ] `--organize` (+ `o` preview) — the opt-in, previewed, reversible rename writer

Not built, not in the help:

- [ ] **Journalling dedupe decisions** — write `dupe_groups` / `dupe_members` (`decided_at`, `decided_by`, `keeper_path`, `reclaimable_bytes`) without touching frozen `src/index/`
- [ ] **`archive.anime_key` population** during transfers (M5-5) → enables Tier-2 transfer pre-check
- [ ] **Tier-2 pre-check at plan time** (`skipped_duplicate` for an episode already in the archive)
- [ ] **Collision detection** (M4-3) — same `path_norm`, different size/mtime, never overwrite
- [ ] **Post-transfer `--check-dupes-after`** — Tier-1 pass over just the new paths
- [ ] **`scripts/portage-phone-setup.sh`** (M9-3)
- [ ] **Shell completion** `portage completions bash|zsh` (M9-4)
- [ ] **`@clack/prompts` flows** for the non-TUI path (M7-5; not a dependency yet)
- [ ] **Fixture coverage**: fake `rsync`; die-at-60 %; checksum-error; vanished source (exit 24); disk full (M1-6, M9-2)
- [ ] **`events.jsonl` rotation**; **`db` restore-from-backup** path
- [ ] **`src/anime/` module** — doc layout names it; today parsing lives inside `src/dedupe/tier2.ts` (works; may want extracting)

---

## 6. Blocked — needs hardware or a human

| #    | Item                                                                    | Needs                           | Closes                                      |
| ---- | ----------------------------------------------------------------------- | ------------------------------- | ------------------------------------------- |
| B-1  | Run `./dist/portage tui` and `./dist/portage dupes` by hand             | a **real terminal**             | gates **C4**, **E5**, and B2 by observation |
| B-2  | Kill a transfer mid-file, re-run, confirm it continues                  | a **phone** attached            | gate **C5**, M3/M8 acceptance               |
| B-3  | Deliberate corruption through Portage (not just the rsync spike)        | a **phone + drive**             | M3 acceptance, success criteria             |
| B-4  | `--keep-source` → `status` → `purge` end-to-end                         | a **phone + drive**             | M3-8 acceptance                             |
| B-5  | Two phones at once; distinct roots/jobs                                 | **both Redmi devices**          | M8-1                                        |
| B-6  | USB 3 port + C→C cable re-measure                                       | the **C→C cable**               | M0-2, D20 resume threshold re-derivation    |
| B-7  | `sudo apt install xxhash`                                               | **Michael** (agent has no sudo) | M0-3                                        |
| B-8  | SMART through the USB bridge                                            | drive + `smartctl`              | M0-4                                        |
| B-9  | Resize the window mid-transfer                                          | a **real terminal**             | gate E5                                     |
| B-10 | Termux `run-as` on the two Redmi units (if the fallback is ever needed) | **both Redmi devices**          | open question in decisions.md               |

---

## 7. Backlog / out of scope for v1 (docs/decisions.md §Out of scope)

- Absolute-numbering → season mapping (AniList/TVDB + cache) — Tier 2 is explicitly a _candidate generator_
- Scheduled unattended runs (systemd user timer) — needs a notification story
- Full-archive integrity scrub over a weekend (report-only)
- `portage watch` — auto-pull on connect (needs udev + dry-run-first guarantee)
- Windows/macOS builds; a Tauri wrapper
- Subtitle-language awareness in Tier 2
- WebDAV/NAS destination with a real durability story
- Hardlink/reflink dedupe on NTFS (**refused by design**)

---

## 8. Open questions still unanswered (docs/decisions.md)

- [ ] C→C cable + USB 3: real MB/s for 1/2/3/4 streams; HDD sequential write ceiling
- [ ] Does Android toybox expose `sha256sum`/`md5sum` on the Pixel/Redmi? (`adb shell toybox | tr ' ' '\n' | grep -i sum`)
- [ ] `ntfs3` vs `ntfs-3g` default on Zorin 18.1, and the measured difference
- [ ] Drive USB bridge + SMART (`smartctl -d sat`); `hd-idle` spin-down
- [ ] Termux `run-as` on the Redmi Pad SE / Note 10s
- [ ] Should `pull` sample-hash `skipped_duplicate` files before ever offering `--purge-known-duplicates`?
- [ ] Where does _already-organised_ anime land, and does `--organize` need an "already looks right" fast path?

---

## 9. Change log for this file

| Date       | Change                                                                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-04 | Created. Seeded from `docs/` (README, architecture, decisions, dedupe, milestones, tui-impl/06) + the `portage-tui-dedupe-2026-10-04` session record + a live read of the source tree. Snapshot: 101 tests green, typecheck clean, build renders, TUI + dedupe built, **work uncommitted**. |
