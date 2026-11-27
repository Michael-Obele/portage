# Implementation Plan: send-to-phone

## Overview

This plan builds drive-to-phone and phone-to-phone sends in the order that `requirements.md` and `design.md` set. Phase 0 checks the durability work that the send depends on. Phase 1 builds shared helpers. Phase 2 runs the hardware spikes S1 to S4 and the listing timing. The spike records choose the relay and the flush rule, so the engine phases (3 to 10) come after them. Phase 7 builds the stream relay only when S1 passes. The temporary-file relay is required. Phases 11 to 13 build the desktop Send screen and its journeys. Phase 14 runs the real phones. Phase 15 is the definition of done.

Each phase ends with a checkpoint task that runs its commands. Each phase's last code task names the commit subject for that phase.

The open items OI-1 to OI-23 and the defaults D1 to D27 are pending owner decision (design §13). The tasks use the recommended defaults, and each task names the item it depends on.

## Conventions

- **Optional tasks.** Only the stream-relay tasks in Phase 7 (7.1 to 7.3) carry `*`. An agent does not implement a `*` task. Each gated test reads the S1 record and fails unless its `verdict.result` is `pass` (Notes N2, N17).
- **Required tests.** Every test task is required and comes before the code it checks. Its Done when line names the reason it fails first. Guard checks that pass when written are the exceptions (task 15.1).
- **Properties.** Each property in design §6.2 has its own test task. The test title starts with `Feature: send-to-phone, Property N:`, so `-t "Property N:"` selects it. Each property is a seeded generator with at least 100 cases, and the seed is printed on failure. No property library is added. OI-12 is pending, and R18.5 forbids a new package (Notes N3).
- **Test files.** Tests go in existing files: `test/units.test.ts`, `test/serve.test.ts`, `test/serve-contract.test.ts`, `apps/desktop/tests/screens.test.ts`, and `apps/desktop/tests/prefs.test.ts` (Notes N4).
- **Markers.** `Needs the phone` (one ready phone, or two for R-2), `Needs the archive drive mounted`, and `Needs the display` mark tasks that need hardware. Phone tasks run one at a time. `Gate: S1` marks a task that is built only when the S1 record passes.
- **Records.** A measurement record is `bench/results/<YYYY-MM-DD>-send-<experiment>.json`. It is committed, and its `verdict` object holds `result` (`pass` or `fail`). Evidence goes to `bench/evidence/send-to-phone/<id>/` (Notes N1).
- **Commits.** A phase's commit subject appears in the Done when line of that phase's last code task. It is a Conventional Commit of at most 72 characters (`scripts/check-commits.sh`). No commit carries an AI attribution line. Checkpoints make no commits.
- **One file per task.** Each task writes one file, so a task that writes two files is split. Checkpoints write no files.
- **Protocol.** `src/` gets no `console.log`, because stdout is the protocol (AGENTS.md).
- **Dependencies.** No new crate or package (R18.5). Streams use `Bun.spawn`, and the record uses `bun:sqlite`.
- **Frozen.** `src/xfer`, `src/index`, `src/plan`, and `src/scan` do not change (R18.2, R18.3). The new `src/send/plan.ts` is not `src/plan`.
- **Comments.** Comments say why, in two lines or fewer (AGENTS.md).

## Durability dependencies

The send gate needs the durability tasks below, in `.kiro/specs/transfer-durability-and-fs-hardening/tasks.md`. The send tasks do not repeat that work.

- 1.7: `src/util/probe.ts` (`probe`, `statDrive`, the breaker, `PROBE_TIMEOUT_MS`).
- 1.8: `flushDeadlineMs` in `src/util/durable.ts`, which gives the size rule (D18).
- 2.9: `readMount` in `src/util/fs.ts`.
- 2.11: `probeDestination`, `judgeDestination`, and `checkDestination` in `src/index/recovery.ts`.
- 2.31: the root-filesystem refusal (R2.14).
- 2.34: the Phase 2 checkpoint.
- 3.2 and 3.4: the whole-segment exclusion fix in the Rust walker and in `isExcludedRelative`. A drive send relies on the archive walk's exclusions (design §10.1, F-10).
- 3.9: the Phase 3 checkpoint.

The flush functions (1.9 and 1.10) are not needed, because sends write only to phones and host files (OI-13 default b). If the owner picks OI-13 option (a), add 1.9 and 1.10 to task 0.1.

## Tasks

- [ ] 0. Phase 0: durability prerequisites (R18.1; OI-13; design §10.1)
  - [x] 0.1 Checkpoint: durability probe, deadline, mount, and exclusion work is in place
    - Requirements: R18.1, R2.14, R6.1, R6.3. Design: §10.1 items 1 and 2; SD-15; F-10.
    - Files: none.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "probe classifier"`, `-t "flush deadline"`, and `-t "destination check"` exit 0. `bun test --preload ./scripts/preload.ts test/scan-io.test.ts -t "isExcludedRelative"` exits 0. `cd crates/portage-scan && cargo test exclusion` exits 0. If any fails, no send task starts.

- [ ] 1. Phase 1: shared helpers (R16.2, R11.14, R6.3; DD-3; design §3.7, §3.15)
  - [~] 1.1 Write the shared-helper tests (red)
    - Requirements: R16.2, R11.14. Design: §3.7, §3.15, DD-3, SD-8, U-SHELL. D18 (the walk deadline is an argument).
    - Files: `test/units.test.ts` (describe `send shared helpers`).
    - Test: `quoteShellArg` from `src/util/spawn.ts` is the function that `src/serve/browse.ts` re-exports. `realSpawn` with an abort signal kills a sleeping child and resolves. `scannerWalk` with `timeoutMs: 50` and a fake binary that never exits resolves near 50 ms and kills the child. The default stays 180000 ms.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send shared helpers"` fails, because `quoteShellArg` is not exported from `src/util/spawn.ts` and `scannerWalk` takes no options yet.
  - [~] 1.2 Move quoteShellArg and add the abort signal to RunOptions
    - Requirements: R16.2, R11.14. Design: §3.7, DD-3, SD-8.
    - Files: `src/util/spawn.ts`.
    - Build: move `quoteShellArg` here. Add `signal?: AbortSignal` to `RunOptions`, and kill the child on abort. Pull passes no signal, so its behaviour does not change.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send shared helpers"` passes its quoting and abort examples.
  - [~] 1.3 Re-export quoteShellArg from browse
    - Requirements: R16.2. Design: §3.7, DD-3, U-SHELL.
    - Files: `src/serve/browse.ts`.
    - Build: import `quoteShellArg` from `src/util/spawn.ts`, re-export it, and remove the local copy.
    - Done when: `bun run test` exits 0, including the existing browse tests.
  - [~] 1.4 Add the walk deadline and signal to scanner.ts
    - Requirements: R6.3, R11.14. Design: §3.15, RK-10, F-12. D18.
    - Files: `src/dedupe/scanner.ts`.
    - Build: `scannerWalk` takes `options?: { timeoutMs?: number; signal?: AbortSignal }`. The default stays 180 s (`scanner.ts:17`). An abort kills the Helper child.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send shared helpers"` passes its walk example.
  - [~] 1.5 Pass the deadline and signal through scan-io
    - Requirements: R6.3. Design: §3.15. OI-1 (the caller sets the listing deadline).
    - Files: `src/dedupe/scan-io.ts`.
    - Build: `WalkOptions` gains `timeoutMs` and `signal`, which pass to `scannerWalk`. `globIo` checks `signal` between entries. Existing callers do not change.
    - Done when: `bun run test` exits 0, and `git log -1 --format=%s` prints `refactor(send): share quoteShellArg and add walk deadlines` after this task's group commit for tasks 1.2 to 1.5.
  - [~] 1.6 Checkpoint: shared helpers
    - Requirements: R16.11. Design: §3.7, §3.15.
    - Files: none.
    - Done when: `bun run test` and `bun run typecheck` exit 0, and `grep -rn "function quoteShellArg" src` prints one line, in `src/util/spawn.ts`.

- [ ] 2. Phase 2: spikes S1 to S4 and listing timing (R1 to R4; OI-1; design §2.5, §8.2 to §8.5, §8.8)
  - [~] 2.1 Write the spike guard tests (red)
    - Requirements: R1.8, R2.7, R17.9. Design: §8.2 preconditions.
    - Files: `test/units.test.ts` (describe `send spike guard`).
    - Test: the guard refuses a folder that holds a file missing from its manifest. It accepts an empty folder and a folder holding only manifest files. Cleanup removes only manifest paths.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send spike guard"` fails, because `scripts/bench/send-spike.ts` does not exist yet.
  - [~] 2.2 Build the spike guard and record writer
    - Requirements: R1.8, R17.8. Design: §8.1, §8.2.
    - Files: `scripts/bench/send-spike.ts` (new).
    - Build: `guardFolder`, `cleanupManifest`, and `writeSpikeRecord(experiment, verdict, raw)`. The writer calls `writeRecord` from `scripts/bench/record.ts` (durability 0.2) and names the file `bench/results/<date>-send-<experiment>.json`. A record is never overwritten (R17.8).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send spike guard"` passes, and `bun run typecheck` exits 0.
  - [~] 2.3 Write the S1 verdict tests (red)
    - Requirements: R1.5, R1.6. Design: §8.2 pass rule, §2.5. D3.
    - Files: `test/units.test.ts` (describe `send S1 verdict`).
    - Test: `s1Verdict(runs)` passes only when the phone-to-host and host-to-phone hashes are both equal. A failed direction carries both hashes. The control copy, push, and rename results do not change the verdict.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send S1 verdict"` fails, because `scripts/bench/send-s1.ts` does not exist yet.
  - [~] 2.4 Build the S1 script
    - Requirements: R1.1 to R1.4, R1.7, R1.8. Design: §8.2 steps 1 to 10; X1; RK-1, RK-2, RK-5, RK-19, RK-20.
    - Files: `scripts/bench/send-s1.ts` (new).
    - Build: a 400,000,000-byte file. Steps: `exec-out cat` to host, `shell -T cat` to phone, control `shell` without `-T`, `push -Z`, `mv -f` and `mv -n`, folder writability, NUL listing, push progress. Cleanup goes through `send-spike.ts`. Exports `s1Verdict`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send S1 verdict"` passes.
  - [~] 2.5 Run S1 on one phone and commit its record
    - Needs the phone. Requirements: R1.1 to R1.8. Design: §8.2, §2.5. Gate: S1 decides Phase 7.
    - Files: `bench/results/<date>-send-s1-binary-stream.json` (new, committed). Raw output goes to `bench/evidence/send-to-phone/<date>-send-s1-binary-stream/`.
    - Done when: `ls bench/results/*-send-s1-binary-stream.json` lists one record whose `verdict.result` is `pass` or `fail`. Either result is accepted here. If it is `fail`, the temporary-file relay is the only relay (R1.6). `git log -1 --format=%s` prints `test(bench): record S1 binary stream results on a phone`.
  - [x] 2.6 Write the S2 verdict tests (red)
    - Requirements: R2.4, R2.5, R2.6. Design: §8.3 pass rule, §2.5. OI-4.
    - Files: `test/units.test.ts` (describe `send S2 verdict`).
    - Test: `s2Verdict(record)` passes when criteria 1, 2, and 4 are answered. A negative answer on flushing is a valid pass. An undetermined answer is not a pass, and the verdict names the owner decision (OI-4).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send S2 verdict"` fails, because `scripts/bench/send-s2.ts` does not exist yet.
  - [x] 2.7 Build the S2 script
    - Requirements: R2.1 to R2.3, R2.7. Design: §8.3 steps 1 to 6.
    - Files: `scripts/bench/send-s2.ts` (new).
    - Build: check `command -v sync` and its status. Write 300,000,000 bytes with `push -Z`. Read `/proc/meminfo` Dirty and Writeback before and after `sync`, and time `sync`. Repeat five times and delete the file after each run. If Dirty or Writeback is missing, record that and name the measure used. Exports `s2Verdict`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send S2 verdict"` passes.
  - [x] 2.8 Run S2 on one phone and commit its record
    - Needs the phone. Requirements: R2.1 to R2.7. Design: §8.3, §2.5. OI-4.
    - Files: `bench/results/<date>-send-s2-sync.json` (new, committed).
    - Done when: `ls bench/results/*-send-s2-sync.json` lists one record, and `git log -1 --format=%s` prints `test(bench): record S2 phone sync results`. Checkpoint 2.18 reads the verdict.
  - [x] 2.9 Write the S3 verdict tests (red)
    - Requirements: R3.1, R3.3, R3.4, R3.6. Design: §8.4, §2.5 (S3).
    - Files: `test/units.test.ts` (describe `send S3 verdict`).
    - Test: `s3Verdict` passes when criterion 1 is answered, and either the two hashes are equal or the absence of `exec-in` is recorded. The record carries the file size used (R3.5).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send S3 verdict"` fails, because `scripts/bench/send-s3.ts` does not exist yet.
  - [x] 2.10 Build the S3 script
    - Requirements: R3.1 to R3.5. Design: §8.4.
    - Files: `scripts/bench/send-s3.ts` (new).
    - Build: record `adb version` and the `adb help` lines naming `exec-in` and `exec-out`. Run `adb exec-in` to write the 400,000,000-byte file. If it runs, hash the phone copy. If it does not, keep its error output. Exports `s3Verdict`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send S3 verdict"` passes.
  - [x] 2.11 Run S3 on one phone and commit its record
    - Needs the phone. Requirements: R3.1 to R3.6. Design: §8.4, §2.5 (exec-in is a write method only if S1 fails and S3 passes).
    - Files: `bench/results/<date>-send-s3-exec-in.json` (new, committed).
    - Done when: `ls bench/results/*-send-s3-exec-in.json` lists one record with `verdict.result` `pass`, and `git log -1 --format=%s` prints `test(bench): record S3 adb exec-in results`.
  - [~] 2.12 Write the S4 verdict tests (red)
    - Requirements: R4.3, R4.4, R4.5. Design: §8.5 pass rule.
    - Files: `test/units.test.ts` (describe `send S4 verdict`).
    - Test: `s4Verdict` passes when the screenshot file exists and the DOM read returns text. It fails, with the tool's error text, when the driver does not connect. It fails when the SHA-256 of `apps/desktop/src-tauri/tauri.conf.json` differs before and after.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send S4 verdict"` fails, because `scripts/bench/send-s4.ts` does not exist yet.
  - [~] 2.13 Build the S4 script
    - Requirements: R4.1, R4.2, R4.5. Design: §8.5 steps 1 and 2; AGENTS.md driving steps 1 and 2.
    - Files: `scripts/bench/send-s4.ts` (new).
    - Build: hash the production CSP file, run `SKIP_BUILD=1 bunx tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json`, record the start time, and read the driver results file that the operator writes (screenshot path, `document.body.innerText`, IPC state). Exports `s4Verdict`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send S4 verdict"` passes.
  - [~] 2.14 Run S4 through the tauri-dev tools and commit its record
    - Needs the display. Requirements: R4.1 to R4.5, R16.6. Design: §8.5 steps 3 to 5.
    - Files: `bench/results/<date>-send-s4-tauri-dev.json` (new, committed). Screenshot and DOM text go to `bench/evidence/send-to-phone/S4/`.
    - Done when: the record's `verdict.result` is `pass`, `git diff --quiet -- apps/desktop/src-tauri/tauri.conf.json` exits 0, and `git log -1 --format=%s` prints `test(bench): record S4 tauri-dev driver results`. If the verdict is `fail`, the Phase 13 journeys are not recorded as passed (R4.4).
  - [x] 2.15 Write the listing-timing tests (red)
    - Requirements: R2.2, R14.4. Design: §8.8, RK-6. OI-1, D18.
    - Files: `test/units.test.ts` (describe `send listing timing`).
    - Test: `summarizeListingTimes(samples)` returns the longest wall time for 100, 500, and 1,000 entries, and whether each is above 3,000 ms. It has no pass rule.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send listing timing"` fails, because `scripts/bench/send-listing.ts` does not exist yet.
  - [x] 2.16 Build the listing-timing script
    - Requirements: R2.2, R14.4. Design: §8.8.
    - Files: `scripts/bench/send-listing.ts` (new).
    - Build: create folders of 100, 500, and 1,000 entries in the guarded spike folder. Time `find -H` listings and single `stat` calls, then remove the folder. Exports `summarizeListingTimes`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send listing timing"` passes.
  - [x] 2.17 Run the listing timing on one phone and commit its record
    - Needs the phone. Requirements: R2.2, R14.4. Design: §8.8. OI-1.
    - Files: `bench/results/<date>-send-m-listing.json` (new, committed).
    - Done when: the record lists the three sizes with their wall times, and `git log -1 --format=%s` prints `test(bench): record phone listing timings for send`. Its result is the input to OI-1.
  - [~] 2.18 Checkpoint: spike gates
    - Requirements: R1.5, R2.5, R2.6, R3.6, R4.3. OI-4. Design: §2.5.
    - Files: none.
    - Done when: `ls bench/results/*-send-*.json` lists the S1, S2, S3, S4, and listing records, and `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send S"` exits 0. If the S2 record does not say `flushed`, stop here. R2.6 bars the merge of Phases 3 to 10 until the owner decides Q1 (OI-4).

- [ ] 3. Phase 3: engine core, types, record, lock, phone operations (R5.7, R13.12, R15.7; design §3.1, §3.5, §3.6, §3.9, §4)
  - [x] 3.1 Write the record tests (red)
    - Requirements: R13.12. Design: §2.7, §3.5, U-RECORD. EH-18, EH-25. OI-6 (no pruning in v1).
    - Files: `test/units.test.ts` (describe `send record`).
    - Test: `sendRecordPath` uses `XDG_STATE_HOME`, and `~/.local/state` when it is unset. An unwritable folder fails with the EH-18 text "the send record cannot be opened". A job left `running` is marked `cancelled` with "engine stopped" at the next open.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send record"` fails, because `src/send/record.ts` does not exist yet.
  - [x] 3.2 Build the send types
    - Requirements: R13.2, R13.4, R12.1. Design: §3.1, §4.1, §4.2, §4.5.
    - Files: `src/send/types.ts` (new).
    - Build: the request, plan, file, outcome, run state, `FinalState`, `WriteMethod`, `ListingResult<T>`, `PhoneCall`, `PhoneHash`, and `PhoneStat` types. No logic, and no import from `src/serve`.
    - Done when: `bun run typecheck` exits 0.
  - [x] 3.3 Build the send record
    - Requirements: R13.12, R15.4. Design: §2.7, §3.5, §4.3, DD-9. OI-6. EH-18, EH-25.
    - Files: `src/send/record.ts` (new).
    - Build: `sendRecordPath`, and class `SendRecord` with `open`, `insertJob`, `insertFile`, `updateFile`, `finishJob`, `listJobs`, `reconcileInterrupted`, and `close`. It uses `bun:sqlite` in WAL mode, as `src/index/journal.ts` does. It never opens `.portage/portage.db`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send record"` passes.
  - [x] 3.4 Write the Property 4 test (red)
    - Requirements: R5.7, R11.9. Design: §2.6, §3.9, EH-15. D21. Property 4.
    - Files: `test/units.test.ts` (describe `send transfer lock`).
    - Test: `Feature: send-to-phone, Property 4: one transfer at a time across pull and send`. Seeded sequences of acquire and release by pull and send. At most one lease is held at a time. A refused acquire names the holder.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 4:"` fails, because `src/serve/transfer-lock.ts` does not exist yet.
  - [x] 3.5 Build the transfer lock
    - Requirements: R5.7, R11.9. Design: §3.9. D21.
    - Files: `src/serve/transfer-lock.ts` (new).
    - Build: class `TransferLock` with `holder()` and `acquire(kind)`. `acquire` returns a lease or a refusal that names the holder. A lease releases exactly once.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 4:"` passes.
  - [x] 3.6 Write the phone-operation tests (red)
    - Requirements: R7.2, R7.8, R7.12, R7.13, R8.11, R9.1, R9.7, R10.3 to R10.5, R16.2. Design: §3.6, DD-6, DD-7, D27, EH-1, EH-2. OI-17 (the four old methods do not change).
    - Files: `test/units.test.ts` (describe `send phone operations`).
    - Test, with a stubbed spawn: `sha256Phone` returns `ok`, `missing`, or `unreadable` for a timeout, a non-zero exit, no digest, and a missing tool. `syncPhone` runs `sync` through `adb shell` and never `adb sync`. `renameOver` uses `mv -f` to replace and `mv -n` to copy, then checks. `mkdirOne` has no `-p`. `statPhonePath` treats a shell that prints no word as unreadable. `freeBytesAt` reads the folder's volume, not `/sdcard`. `push` has `-Z` and no `--sync`. Every path passes through `quoteShellArg`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send phone operations"` fails, because the typed methods do not exist on `Adb` yet.
  - [x] 3.7 Build the typed phone methods
    - Requirements: R7.2, R7.8, R7.12, R7.13, R8.11, R9.1, R9.7, R10.3 to R10.5. Design: §3.6, DD-6, DD-7, D27.
    - Files: `src/device/adb.ts`.
    - Build: add `sha256Phone`, `syncPhone`, `renameOver`, `removePhone`, `mkdirOne`, `statPhonePath`, `freeBytesAt`, and `push` to `Adb`. Each returns a typed result, so a timeout is never read as an answer. The existing methods keep their behaviour.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send phone operations"` passes, and `bun run test` exits 0.
  - [x] 3.8 Write the Property 34 test (red)
    - Requirements: R14.4, R14.5, R6.5. Design: §3.6, EH-1, EH-21. OI-1 (one retry), OI-21 (symbolic links). Property 34.
    - Files: `test/units.test.ts` (describe `send listing`).
    - Test: `Feature: send-to-phone, Property 34: a listing that is not complete is unreadable, and a long one is cut at 500`. Seeded streams. A missing end sentinel, a non-zero exit, an unparsable record, or a timeout gives `unreadable` with no entries. A complete listing shows the first min(n, 500) entries, and `truncated` is set only when n exceeds 500. A symbolic link is skipped with the reason "symbolic link".
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 34:"` fails, because `parseStrictListing` does not exist in `src/device/adb.ts` yet.
  - [x] 3.9 Build the strict listing
    - Requirements: R14.4, R14.5, R6.2. Design: §3.6, EH-1, EH-21. OI-1, OI-21.
    - Files: `src/device/adb.ts`.
    - Build: `parseStrictListing(bytes, exitCode)` decodes names with a fatal UTF-8 decoder, requires the end sentinel, and returns `unreadable` when a record fails. `listPhoneStrict` runs `find -H` on the root through `quoteShellArg`, retries once on a timeout, and does not follow symbolic links.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 34:"` passes.
  - [~] 3.10 Write the exec-out stream test (red)
    - Requirements: R1.1, R8.1, R8.2. Design: §3.6 (`StreamProcess`), SD-8. X1.
    - Files: `test/units.test.ts` (describe `send exec-out stream`).
    - Test: `execOutStream` yields the phone's bytes unchanged, including 0x0D 0x0A pairs and 0x00 bytes. `kill()` ends the child, and `exited` resolves with its status.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send exec-out stream"` fails, because `execOutStream` does not exist in `src/device/adb.ts` yet.
  - [~] 3.11 Build execOutStream
    - Requirements: R8.1, R8.2. Design: §3.6, SD-8. Precedent: `execOutTail` (`src/device/adb.ts:335-351`).
    - Files: `src/device/adb.ts`.
    - Build: `execOutStream(serial, path, signal?)` uses `Bun.spawn` with stdin ignored and stdout as a binary `ReadableStream`. It does not use `realSpawn`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send exec-out stream"` passes, and `git log -1 --format=%s` prints `feat(send): add send types, record, lock, and phone operations` after this task's group commit for tasks 3.2 to 3.11.
  - [~] 3.12 Checkpoint: engine core
    - Requirements: R16.11. Design: §3.
    - Files: none.
    - Done when: `bun run test` and `bun run typecheck` exit 0.

- [ ] 4. Phase 4: plan rules, pure functions (R5.1 to R5.6, R6.1, R6.2, R6.8, R7.5 to R7.10, R7.13 to R7.15, R8.10, R8.15, R14.2; design §2.8, §3.2)
  - [~] 4.1 Add the seeded generator, FakeAdb, and FakeHost to test/helpers.ts
    - Requirements: R16.1, R16.2. Design: §7.2. Notes N3, N4.
    - Files: `test/helpers.ts`.
    - Build: `seededCases(seed, n)`, a fixed-seed generator that prints its seed when a case fails. `FakeAdb` records every call in order (method, serial, path, arguments) and gives scripted outcomes: ok, exit code, deadline, unplug, wrong digest, missing sentinel, byte stall, and removal failure. `FakeHost` records archive reads, host temporary files, and relay handles, on a deterministic clock.
    - Done when: `bun run test` and `bun run typecheck` exit 0.
  - [~] 4.2 Write the Property 6 test (red)
    - Requirements: R6.1, R6.2, R6.8, R14.11. Design: §3.2, §2.8, EH-17. D12. Property 6.
    - Files: `test/units.test.ts` (describe `send archive mount`).
    - Test: `Feature: send-to-phone, Property 6: the archive mount decides admission, and an unreadable mount is never healthy`. The archive is admitted only when the reading is mounted, the target is not `/`, `ro` is absent, and the folder resolves under the archive root without a `.portage` segment. An unreadable reading gives "the mount could not be read", never "not mounted", "healthy", or "read-only".
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 6:"` fails, because `src/send/plan.ts` does not exist yet.
  - [~] 4.3 Build judgeArchiveMount
    - Requirements: R6.1, R6.2, R6.8. Design: §3.2, EH-17. D12. Notes N6 (reuse durability's rule).
    - Files: `src/send/plan.ts` (new).
    - Build: `judgeArchiveMount(state, root, folder)` as a pure function. It uses the `MountState` from durability task 2.9 and the refusal words of EH-17.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 6:"` passes.
  - [~] 4.4 Write the Property 13 test (red)
    - Requirements: R7.13, R7.14, R8.3, R8.4. Design: §3.2, EH-12. D20. Property 13.
    - Files: `test/units.test.ts` (describe `send free space`).
    - Test: `Feature: send-to-phone, Property 13: free space gates for the phone and the host`. A missing free-space reading is refused as "could not be read". A shortfall is refused exactly when free minus headroom is below the bytes to write. The host check counts every temporary file that can exist at once.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 13:"` fails, because `judgeFreeSpace` does not exist in `src/send/plan.ts` yet.
  - [~] 4.5 Build judgeFreeSpace
    - Requirements: R7.13, R7.14, R8.3. Design: §3.2. D20 (`space_headroom`, C22).
    - Files: `src/send/plan.ts`.
    - Build: `judgeFreeSpace({ free, total, bytesToWrite, headroomFraction })`. Each refusal carries the shortfall in bytes.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 13:"` passes.
  - [~] 4.6 Write the Property 3 test (red)
    - Requirements: R5.1 to R5.5, R14.6. Design: §3.12, EH-16. D11. Property 3.
    - Files: `test/units.test.ts` (describe `send device identity`).
    - Test: `Feature: send-to-phone, Property 3: device identity and phone choice`. A target id is accepted only when it belongs to a ready phone. Two phones that share a device id or serial are refused. A phone-to-phone send needs exactly two ready phones. A drive-to-phone send with no named target chooses none. An empty `ro.serialno` is refused, and the phone is named by serial and model.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 3:"` fails, because `judgeDevices` does not exist in `src/send/plan.ts` yet.
  - [~] 4.7 Build judgeDevices
    - Requirements: R5.1 to R5.6. Design: §3.12, EH-16, EH-6. D11.
    - Files: `src/send/plan.ts`.
    - Build: `judgeDevices(request, phones)`. An unauthorized phone gets the fix "accept the USB debugging prompt on the phone" (R5.6).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 3:"` passes.
  - [~] 4.8 Write the Property 9 test (red)
    - Requirements: R7.1, R7.2. Design: §2.8, DD-6, EH-29. D2. OI-7 (keep the source folder's name). Property 9.
    - Files: `test/units.test.ts` (describe `send target paths`).
    - Test: `Feature: send-to-phone, Property 9: target paths stay inside the target folder`. The target path is the target folder, then the source folder's name (OI-7), then the relative path. Every created folder lies under the target folder. The list of created folders equals the folders that were missing.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 9:"` fails, because `targetPathFor` does not exist in `src/send/plan.ts` yet.
  - [~] 4.9 Build targetPathFor and missingFolderChain
    - Requirements: R7.1, R7.2. Design: §2.8, DD-6, AD-4. OI-7.
    - Files: `src/send/plan.ts`.
    - Build: `targetPathFor(targetFolder, sourceName, relative)` and `missingFolderChain(path, existing)`. The chain lists only the folders that are missing, one level at a time.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 9:"` passes.
  - [~] 4.10 Write the Property 10 test (red)
    - Requirements: R7.5, R7.7. Design: §2.2, §2.3 step 3. D8. Property 10.
    - Files: `test/units.test.ts` (describe `send skip rule`).
    - Test: `Feature: send-to-phone, Property 10: a file is skipped only when both sides hash the same`. A file is skipped as "already there" only when sizes are equal and both SHA-256 values are equal. A size match alone never skips. A hash is read only for same-size pairs.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 10:"` fails, because `judgePlanFile` does not exist in `src/send/plan.ts` yet.
  - [~] 4.11 Write the Property 11 test (red)
    - Requirements: R7.6, R7.11. Design: §2.3 step 7, §4.1. D8, D23. Property 11.
    - Files: `test/units.test.ts` (describe `send replace rule`).
    - Test: `Feature: send-to-phone, Property 11: a differing file is replaced only when the owner chose replace`. Without replace, a differing file is "different file at this path" and is not written. With replace, the verdict is `replace`, and it records the old size and hash (D23).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 11:"` fails, because `judgePlanFile` does not exist in `src/send/plan.ts` yet.
  - [~] 4.12 Build judgePlanFile
    - Requirements: R7.5, R7.6, R7.7, R7.11. Design: §2.2, §4.1. D8, D23.
    - Files: `src/send/plan.ts`.
    - Build: `judgePlanFile(input)` returns one verdict: copy, replace, skip "already there", skip "different file at this path", or refuse for a folder at the target path (EH-30). It reads hashes only for same-size pairs.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 10:"` and `-t "Property 11:"` both pass.
  - [~] 4.13 Write the Property 12 test (red)
    - Requirements: R7.10, R16.2. Design: §2.8, EH-21, EH-22. D27, DD-4. Property 12.
    - Files: `test/units.test.ts` (describe `send names`).
    - Test: `Feature: send-to-phone, Property 12: names keep their bytes, and case collisions are refused`. Names that differ only in case are both refused. A control character, invalid UTF-8, or U+FFFD after decoding is skipped with a reason. Other names pass unchanged. A name over 255 bytes with its 31-byte partial overhead is refused, never truncated. `quoteShellArg` output is read by `sh` as one word equal to the name.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 12:"` fails, because `nameVerdict` does not exist in `src/send/plan.ts` yet.
  - [~] 4.14 Build nameVerdict
    - Requirements: R7.10, R16.2. Design: §2.8, EH-21, EH-22. D27.
    - Files: `src/send/plan.ts`.
    - Build: `nameVerdict(names)` returns a verdict for each name, using the reason text of EH-21 and EH-22.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 12:"` passes.
  - [~] 4.15 Write the Property 36 test (red)
    - Requirements: R8.15, R7.15. Design: §2.8, EH-24. D19. OI-9 (never-scan rules apply), OI-10 (zero bytes are skipped). Property 36.
    - Files: `test/units.test.ts` (describe `send phone source skips`).
    - Test: `Feature: send-to-phone, Property 36: zero-byte, in-flight, and recent phone files are skipped, and only those`. A zero-byte file, a name with `.part`, `.tmp`, or `.crdownload`, and a file modified within `quiet_seconds` are skipped. No other file is skipped.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 36:"` fails, because `judgeSourcePhoneFile` does not exist in `src/send/plan.ts` yet.
  - [~] 4.16 Build judgeSourcePhoneFile
    - Requirements: R8.15. Design: §2.8. D19, OI-10. The suffix list and `quiet_seconds` come from `src/config/schema.ts:123` and `src/scan/scan.ts:81-84`.
    - Files: `src/send/plan.ts`.
    - Build: `judgeSourcePhoneFile(file, now, quietSeconds)`. Reads the existing suffix list. It does not copy it.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 36:"` passes.
  - [~] 4.17 Write the Property 8 test (red)
    - Requirements: R6.5, R6.6, R8.13. Design: §2.3 steps 1 and 3, EH-23, F-13. Property 8.
    - Files: `test/units.test.ts` (describe `send source queue`).
    - Test: `Feature: send-to-phone, Property 8: a source file is queued only when it was read and did not change`. A path that is missing at its turn gives `missing-since-plan`. Any other stat or read failure gives `could-not-read-source`. A file whose size changed is never queued.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 8:"` fails, because `judgeSourceFile` does not exist in `src/send/plan.ts` yet.
  - [~] 4.18 Build judgeSourceFile
    - Requirements: R6.5, R6.6, R8.13. Design: §2.3 steps 1 and 3, F-13. EH-23.
    - Files: `src/send/plan.ts`.
    - Build: `judgeSourceFile(stat, plannedSize)`. It stats the path before any hash, so a missing path and an unreadable one stay separate.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 8:"` passes.
  - [~] 4.19 Write the Property 24 test (red)
    - Requirements: R8.10, R14.2, R5.5. Design: §4.1, §4.5. D1. OI-2 (phone roots), OI-8 (single files), OI-9 (never-scan). Property 24.
    - Files: `test/units.test.ts` (describe `send request rules`).
    - Test: `Feature: send-to-phone, Property 24: move is offered only for phone sources`. A drive source with move is refused. A phone source may choose move. Roots are limited to `/sdcard` and `/storage/emulated/0`, and a `..` segment is refused (OI-2). A `single` file is accepted (OI-8). A phone source under a never-scan folder is refused (OI-9).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 24:"` fails, because `judgeRequest` does not exist in `src/send/plan.ts` yet.
  - [~] 4.20 Build judgeRequest
    - Requirements: R8.10, R14.2. Design: §4.1, §2.8. OI-2, OI-8, OI-9.
    - Files: `src/send/plan.ts`.
    - Build: `judgeRequest(request)` returns a refusal with its reason, or accepts the request.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 24:"` passes, and `git log -1 --format=%s` prints `feat(send): add plan rules for mounts, devices, and files` after this task's group commit for tasks 4.1 to 4.20.
  - [~] 4.21 Checkpoint: plan rules
    - Requirements: R16.11. Design: §3.2.
    - Files: none.
    - Done when: `bun run test` and `bun run typecheck` exit 0.

- [ ] 5. Phase 5: planner over archive and phone listings (R6.3, R6.4, R6.6, R6.9, R7.3, R7.4, R7.8, R7.9, R13.1, R13.2; design §3.2, §2.2; OI-19)
  - [~] 5.1 Write the planner examples (red)
    - Requirements: R7.3, R7.4, R7.8, R7.9, R7.13, R7.15, R6.1, R6.3, R6.6, R6.9, R13.1. Design: §3.2, §2.2, U-PLAN-1. OI-19, OI-10.
    - Files: `test/units.test.ts` (describe `send planner examples`).
    - Test with `FakeAdb` and `FakeHost`: the target folder must exist (R7.3). The plan never reads the journal (R7.4, spy). An unreadable target gives `could-not-read-target`. A folder at the target path is refused. A free-space read failure refuses the send. A zero-byte file is skipped (OI-10). The mount is checked before the listing (R6.1). Each archive probe has the 3 s deadline, and each file read has the size rule (R6.3). A missing source gives `missing-since-plan`. The walker field says `scanner` or `glob`. The chooser reports `readdir` with no walker (OI-19).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send planner examples"` fails, because `buildSendPlan` does not exist in `src/send/plan.ts` yet.
  - [~] 5.2 Build buildSendPlan
    - Requirements: R6.1, R6.3, R7.3, R7.4, R13.1, R13.2. Design: §2.2, §3.2. D12, D18, OI-19.
    - Files: `src/send/plan.ts`.
    - Build: run the device checks (`judgeDevices`), the archive mount check (`judgeArchiveMount`), the archive walk through `scanIo` with the probe deadline (task 1.5), the strict target listing (task 3.9), and the free-space check (`judgeFreeSpace`). Classify each file with the judgement functions, then compute the four counts so they sum to the source count (R13.2). Lists leftover partials (R10.11).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send planner examples"` passes, and `git log -1 --format=%s` prints `feat(send): add the planner over archive and phone listings` after this task's group commit for tasks 5.1 and 5.2.
  - [~] 5.3 Checkpoint: planner
    - Requirements: R16.11. Design: §3.2.
    - Files: none.
    - Done when: `bun run test` and `bun run typecheck` exit 0.

- [ ] 6. Phase 6: relays, temporary-file relay required (R8.2 to R8.8, R8.14, R11.14, R13.11; design §3.4, §2.5; D3, D18)
  - [~] 6.1 Write the Property 22 test (red)
    - Requirements: R8.7, R11.14, R13.11. Design: §3.4 (`StallWatchdog`), EH-5. D18. Property 22.
    - Files: `test/units.test.ts` (describe `send stall`).
    - Test: `Feature: send-to-phone, Property 22: a silent relay stalls after 30 seconds, and the screen says so after 10`. The watchdog fails its file as "stalled" exactly when silence reaches 30 s before the next byte or the end. The progress view shows whole seconds of silence once silence reaches 10 s.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 22:"` fails, because `StallWatchdog` does not exist in `src/send/relay.ts` yet.
  - [~] 6.2 Build StallWatchdog
    - Requirements: R8.7, R13.11. Design: §3.4. D18.
    - Files: `src/send/relay.ts` (new).
    - Build: class `StallWatchdog` with `touch`, `stop`, and `silentForMs`, on an injectable clock.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 22:"` passes.
  - [~] 6.3 Write the Property 21 test (red)
    - Requirements: R8.1, R8.2, R8.6, R1.6. Design: §2.5. D3. Property 21. The stream clause is added in task 7.1.
    - Files: `test/units.test.ts` (describe `send relay choice`).
    - Test: `Feature: send-to-phone, Property 21: the relay is chosen by the spike, and a stream copy counts only when complete`. `chooseRelay(s1Record)` returns the stream relay only when `verdict.result` is `pass`, and otherwise the temporary-file relay. `countsAsCopied` is true only when the byte count equals the size and both exits are 0.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 21:"` fails, because `chooseRelay` does not exist in `src/send/relay.ts` yet.
  - [~] 6.4 Build chooseRelay and countsAsCopied
    - Requirements: R8.1, R8.2, R8.6. Design: §2.5. D3.
    - Files: `src/send/relay.ts`.
    - Build: `chooseRelay(s1Record)`, which reads the S1 record from `bench/results/`, and `countsAsCopied(outcome, size)`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 21:"` passes.
  - [~] 6.5 Write the Property 14 test (red)
    - Requirements: R8.5. Design: §3.4, EH-9, EH-10. Property 14.
    - Files: `test/units.test.ts` (describe `send host temporary files`).
    - Test: `Feature: send-to-phone, Property 14: temporary files are never on the archive`. A host temporary path inside the archive root is refused. Each host temporary file is either removed or listed by path in the result.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 14:"` fails, because `hostTempPathFor` does not exist in `src/send/relay.ts` yet.
  - [~] 6.6 Build hostTempPathFor and settleHostTemp
    - Requirements: R8.5. Design: §3.4, EH-10. D20.
    - Files: `src/send/relay.ts`.
    - Build: `hostTempPathFor(stateDir, archiveRoot)` refuses an archive path. `settleHostTemp(path, removed)` returns the path for the result when removal fails.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 14:"` passes.
  - [~] 6.7 Write the host room tests (red)
    - Requirements: R8.3, R8.4. Design: §3.2, U-HOST, EH-12. D20.
    - Files: `test/units.test.ts` (describe `send host room`).
    - Test: a failed or unreadable host free-space read refuses the file with the stated reason. The budget counts the sum of concurrent temporary files. An archive path is refused and an outside path is accepted.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send host room"` fails, because `checkHostRoom` does not exist in `src/send/relay.ts` yet.
  - [~] 6.8 Build checkHostRoom
    - Requirements: R8.3, R8.4. Design: §3.2, §3.8 (`diskSpaceAsync`). D20.
    - Files: `src/send/relay.ts`.
    - Build: `checkHostRoom` calls `diskSpaceAsync` from `src/util/fs.ts` and then `judgeFreeSpace`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send host room"` passes.
  - [~] 6.9 Write the temporary-file relay tests (red)
    - Requirements: R8.2, R8.7, R8.8. Design: §3.4 (`tempFileRelay`), U-FAKE-4. EH-5.
    - Files: `test/units.test.ts` (describe `send temp file relay`).
    - Test: with `FakeAdb` and `FakeHost`, a successful relay writes the host file with `exec-out cat`, pushes it to the partial, and removes the host file. A silent relay stops both sides and fails the file with "stalled".
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send temp file relay"` fails, because `tempFileRelay` does not exist in `src/send/relay.ts` yet.
  - [~] 6.10 Build tempFileRelay
    - Requirements: R8.2, R8.5, R8.7, R8.8. Design: §3.4, §2.5. D3, D18.
    - Files: `src/send/relay.ts`.
    - Build: `tempFileRelay` runs `execOutStream` into a host file under the state directory, pushes it with `push -Z`, removes the host file, and runs the stall watchdog. It reports the relay name for the result (R8.8).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send temp file relay"` passes, and `git log -1 --format=%s` prints `feat(send): add temporary file relay and stall watchdog` after this task's group commit for tasks 6.1 to 6.10.
  - [~] 6.11 Checkpoint: relays
    - Requirements: R16.11. Design: §3.4.
    - Files: none.
    - Done when: `bun run test` and `bun run typecheck` exit 0.

- [ ] 7. Phase 7: gated stream relay (Gate: S1; R8.1, R8.6, R9.2; D3, D5; design §3.4 `streamRelay`, §3.6 `shellStreamIn`)
  - [~] 7.1 Write the stream gate test and the stream clause of Property 21 (red). Gate: S1
    - Requirements: R8.1, R8.6, R9.2. Design: §2.5, §3.4. Property 21 (stream clause).
    - Files: `test/units.test.ts` (describe `send stream relay gate`).
    - Test: reads the newest `bench/results/*-send-s1-binary-stream.json`, and fails unless its `verdict.result` is `pass`. The stream clause of Property 21: a stream copy counts only when the bytes equal the size and both stream processes exit 0.
    - Done when: with the S1 record at `fail`, `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send stream relay gate"` fails with "the S1 record does not allow the stream relay". With `pass`, it fails because `streamRelay` does not exist yet.
  - [~] 7.2 Build shellStreamIn. Gate: S1
    - Requirements: R8.1. Design: §3.6. SD-8, RK-1.
    - Files: `src/device/adb.ts`.
    - Build: `shellStreamIn(serial, command, signal?)` runs `adb shell -T <command>` with a pipe on stdin. It returns a `StreamProcess` whose `stdin` is a `FileSink`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send stream relay gate"` passes its adb-side example.
  - [~] 7.3 Build pumpWithHash and streamRelay. Gate: S1
    - Requirements: R8.1, R8.6, R8.7, R9.2. Design: §3.4. D3, D5.
    - Files: `src/send/relay.ts`.
    - Build: `pumpWithHash` hashes each chunk and resets the watchdog. `streamRelay` pipes `execOutStream` on the source into `shellStreamIn` on the target. It counts the file as copied only through `countsAsCopied`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 21:"` and `-t "send stream relay gate"` pass, and `git log -1 --format=%s` prints `feat(send): add stream relay behind the S1 gate` after this task's group commit.
  - [~] 7.4 Checkpoint: relay choice with the gate as it stands
    - Requirements: R8.1, R8.2. Design: §2.5. D3.
    - Files: none. Required even if the stream tasks are not built.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 21:"` exits 0 and `bun run test` exits 0. The relay chosen equals the S1 record's verdict.

- [ ] 8. Phase 8: job, per-file order, verification, breakers, cancel, and move (R5.9, R6.7, R6.10, R8.9 to R8.14, R9, R10, R11, R13.2, R13.3, R13.4; design §2.3, §2.6, §3.3, §4.2)
  - [~] 8.1 Write the Property 15 test (red)
    - Requirements: R8.14, R9.2, R9.3, R9.4. Design: §2.3 step 5. D5. Property 15.
    - Files: `test/units.test.ts` (describe `send verification`).
    - Test: `Feature: send-to-phone, Property 15: a verified copy needs every comparison to match`. A file is verified exactly when every compared hash is present and equal. The copy command's exit status never changes the verdict.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 15:"` fails, because `verifyHashes` does not exist in `src/send/job.ts` yet.
  - [~] 8.2 Build verifyHashes
    - Requirements: R8.14, R9.2 to R9.4. Design: §2.3 step 5. D5.
    - Files: `src/send/job.ts` (new).
    - Build: `verifyHashes(hashes)`, which returns verified only when every present hash equals the others.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 15:"` passes.
  - [~] 8.3 Write the Property 16 test (red)
    - Requirements: R9.5, R9.6. Design: EH-2, EH-27. D18. Property 16.
    - Files: `test/units.test.ts` (describe `send hash outcomes`).
    - Test: `Feature: send-to-phone, Property 16: a mismatch and an unreadable hash are reported as different things`. A timeout or missing reading gives "could not be read". A differing digest gives "content differs", with the first 12 characters of each hash. Neither writes the final path, and the partial is removed.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 16:"` fails, because `classifyHashOutcome` does not exist in `src/send/job.ts` yet.
  - [~] 8.4 Build classifyHashOutcome
    - Requirements: R9.5, R9.6. Design: EH-2, EH-27.
    - Files: `src/send/job.ts`.
    - Build: `classifyHashOutcome(source, target)` returns `content differs` or `could not be read`, with the messages of EH-2 and EH-27.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 16:"` passes.
  - [~] 8.5 Write the Property 19 test (red)
    - Requirements: R10.2, R10.10. Design: §3.3, DD-4, SD-4. D7, D9. Property 19.
    - Files: `test/units.test.ts` (describe `send partial names`).
    - Test: `Feature: send-to-phone, Property 19: partial names follow the pattern and never repeat`. A partial name starts with the Portage marker, ends in `.part`, never repeats across starts, and never equals a final name. It is `null` when the basename plus 31 bytes exceeds 255 (EH-22).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 19:"` fails, because `nextPartialName` does not exist in `src/send/job.ts` yet.
  - [~] 8.6 Build nextPartialName
    - Requirements: R10.2, R10.10. Design: §3.3, DD-4. D9 (no resume).
    - Files: `src/send/job.ts`.
    - Build: `nextPartialName(basename, randomChars)` returns `.portage-partial-<8>-<basename>.part`, or `null` when the length is over the limit.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 19:"` passes.
  - [~] 8.7 Write the Property 5 test (red)
    - Requirements: R5.9, R6.10. Design: §2.1 DD-2, EH-3, EH-4. D25. Property 5.
    - Files: `test/units.test.ts` (describe `send breakers`).
    - Test: `Feature: send-to-phone, Property 5: breakers trip on three deadlines in a row`. The phone breaker trips at the third consecutive deadline, and any other outcome resets the count. After a trip no call starts. The archive breaker uses durability's `breakerFor` (task 1.7) and stays tripped until restart.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 5:"` fails, because `PhoneBreaker` does not exist in `src/send/job.ts` yet.
  - [~] 8.8 Build PhoneBreaker
    - Requirements: R5.9. Design: DD-2, AD-6. D25.
    - Files: `src/send/job.ts`.
    - Build: class `PhoneBreaker` per job. Archive calls keep using durability's breaker, so phone calls never touch it.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 5:"` passes.
  - [~] 8.9 Write the copy and move order tests (red)
    - Requirements: R9.1, R10.1, R10.3 to R10.5, R16.1. Design: §2.3, U-ORDER. D5, D17. Property 17.
    - Files: `test/units.test.ts` (describe `send file order`).
    - Test: `Feature: send-to-phone, Property 17: each file runs in the fixed order, and nothing reaches the final name early`. With a recording `FakeAdb`, a copy follows: expected hash, write, partial hash, flush 1, rename, flush 2, done. A move continues with a fresh final hash, a fresh source hash, and the source removal. No final-name write happens before the partial hash matches and flush 1 returns ok.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 17:"` fails, because `runFileSteps` does not exist in `src/send/job.ts` yet.
  - [~] 8.10 Build runFileSteps for the copy path
    - Requirements: R9.1, R10.1, R10.3 to R10.5. Design: §2.3 steps 1 to 9. D5, D6, D17.
    - Files: `src/send/job.ts`.
    - Build: `runFileSteps(file, ctx)`, steps 1 to 9 of §2.3. Phone sources use the relay chosen in task 6.4. Drive sources use `push -Z`. The move steps are added in task 8.30.
    - Done when: the copy examples of `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 17:"` pass. Its move examples stay red until task 8.30.
  - [~] 8.11 Write the Property 18 test (red)
    - Requirements: R10.6, R10.7. Design: EH-7, EH-8, §2.3 steps 6 to 9. D17. Property 18.
    - Files: `test/units.test.ts` (describe `send flush outcome`).
    - Test: `Feature: send-to-phone, Property 18: a file is done only after verification and both flushes`. A failed or timed-out flush 1 fails the file and removes the partial. A failed flush 2, after the rename, gives "in place, not confirmed flushed". Only verification plus both flushes gives done.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 18:"` fails, because the flush outcome rules are not in `src/send/job.ts` yet.
  - [~] 8.12 Build the flush outcome rules
    - Requirements: R10.6, R10.7. Design: EH-7, EH-8. D17.
    - Files: `src/send/job.ts`.
    - Build: the flush outcome logic that `runFileSteps` calls after flush 1 and flush 2.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 18:"` passes.
  - [~] 8.13 Write the Property 20 test (red)
    - Requirements: R10.8 to R10.12, R13.7. Design: EH-9. D7. Property 20.
    - Files: `test/units.test.ts` (describe `send partial cleanup`).
    - Test: `Feature: send-to-phone, Property 20: partials are never counted, and each one is removed or listed`. Partial names never count as files, skipped entries, or done entries. Each partial is removed on failure or cancel before the rename, or listed by path when its removal is not confirmed.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 20:"` fails, because the cleanup in `src/send/job.ts` does not exist yet.
  - [~] 8.14 Build partial cleanup and leftover listing
    - Requirements: R10.8, R10.12, R13.7. Design: EH-9. D7.
    - Files: `src/send/job.ts`.
    - Build: `cleanupPartial(path, removeResult)`. It removes only the run's own partial and lists the path when removal is not confirmed.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 20:"` passes.
  - [~] 8.15 Write the Property 1 test (red)
    - Requirements: R13.2, R13.4, R11.8. Design: §4.1, §4.2. D13. Property 1.
    - Files: `test/units.test.ts` (describe `send partition`).
    - Test: `Feature: send-to-phone, Property 1: plans and results partition their files`. The four plan counts add up to the source count. Each planned file has exactly one final state, and the state counts add up to the planned file count.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 1:"` fails, because the outcome counting does not exist in `src/send/job.ts` yet.
  - [~] 8.16 Build the outcome counts
    - Requirements: R13.2, R13.4. Design: §4.2.
    - Files: `src/send/job.ts`.
    - Build: `countOutcomes(files)` returns one count per final state, and it throws when a file has no final state.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 1:"` passes.
  - [~] 8.17 Write the Property 25 and U-CANCEL tests (red)
    - Requirements: R11.2 to R11.6. Design: §2.6, EH-20. D10, D22. Property 25.
    - Files: `test/units.test.ts` (describe `send cancel`).
    - Test: `Feature: send-to-phone, Property 25: a cancel stops the next file and finishes or removes the current one`. No file starts after a cancel. A rename that already happened gets its second flush. A partial that was not renamed is removed. No source is removed unless its copy was verified in this send. The cancel answer returns before the file in progress ends.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 25:"` fails, because the cancel path does not exist in `src/send/job.ts` yet.
  - [~] 8.18 Build cancel
    - Requirements: R11.2 to R11.6. Design: §2.6, DD-11. EH-20.
    - Files: `src/send/job.ts`.
    - Build: `cancel()` sets `cancelRequested`, aborts the child processes of the current step, and stops the job from starting another file. It returns before the file in progress ends.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 25:"` passes.
  - [~] 8.19 Write the Property 26 test (red)
    - Requirements: R11.10 to R11.13. Design: §2.6, §1.3. D4. OI-3. Property 26.
    - Files: `test/units.test.ts` (describe `send concurrency`).
    - Test: `Feature: send-to-phone, Property 26: at most one file is in flight to a phone`. For any requested number, the effective number per phone is 1 (OI-3). An unread link speed also gives 1 and is reported as "not read" (R11.13).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 26:"` fails, because `effectiveInFlight` does not exist in `src/send/job.ts` yet.
  - [~] 8.20 Build effectiveInFlight
    - Requirements: R11.10, R11.13. Design: §2.6. D4, OI-3. Notes N7 (R11.11 and R11.12 are not built).
    - Files: `src/send/job.ts`.
    - Build: `effectiveInFlight(requested, linkMbps)` returns 1. The `jobs` setting is not read in v1.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 26:"` passes.
  - [~] 8.21 Write the Property 33 test (red)
    - Requirements: R13.3, R13.10. Design: §4.2 `SendRunState`, §3.3. D13. C31 (`src/serve/view.svelte.ts`). Property 33.
    - Files: `test/units.test.ts` (describe `send progress`).
    - Test: `Feature: send-to-phone, Property 33: progress figures have the meaning of the overall figures`. Time left is `null` until 3 samples and 30,000,000 bytes exist. The rates use the transfer sink's smoothing constant.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 33:"` fails, because `runStateFor` does not exist in `src/send/job.ts` yet.
  - [~] 8.22 Build runStateFor
    - Requirements: R13.3, R13.10. Design: §4.2. C31.
    - Files: `src/send/job.ts`.
    - Build: `runStateFor(progress)` builds the run state, and takes its time-left figure from the existing `honestEta` in `src/serve/view.svelte.ts`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 33:"` passes.
  - [~] 8.23 Write the fixed cases 1 to 5 (red)
    - Requirements: R16.2, R9.5, R10.7, R8.7. Design: §7.3 U-FAKE-1 to U-FAKE-5. EH-2, EH-5, EH-7.
    - Files: `test/units.test.ts` (describe `send fake cases 1-5`).
    - Test: exit 0 with the wrong content; a missing hash tool; `sync` absent; a stall on a relay; a deadline on a hash. One test each.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send fake cases 1-5"` fails, because the job does not handle these cases yet.
  - [~] 8.24 Make job.ts pass fake cases 1 to 5
    - Requirements: R16.2. Design: §7.3, EH-2, EH-5, EH-7.
    - Files: `src/send/job.ts`.
    - Build: the handling for each case, with the messages of EH-2, EH-5, and EH-7.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send fake cases 1-5"` exits 0.
  - [~] 8.25 Write the fixed cases 6 to 10 (red)
    - Requirements: R16.2, R5.8, R10.8. Design: §7.3 U-FAKE-6 to U-FAKE-10. EH-6, EH-9, EH-20, EH-23. Notes N8.
    - Files: `test/units.test.ts` (describe `send fake cases 6-10`).
    - Test: a cancel during a temporary-file relay (N8); a target write failure; a temporary file that cannot be removed; a source that disappears; a phone unplugged mid-file ("phone not attached", EH-6).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send fake cases 6-10"` fails, because the job does not handle these cases yet.
  - [~] 8.26 Make job.ts pass fake cases 6 to 10
    - Requirements: R16.2, R5.8, R10.8. Design: §7.3, EH-6, EH-9, EH-20, EH-23.
    - Files: `src/send/job.ts`.
    - Build: the handling for each case.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send fake cases 6-10"` exits 0.
  - [~] 8.27 Write the fixed cases 11 to 15 (red)
    - Requirements: R16.2, R7.10, R7.11, R8.9, R14.5. Design: §7.3 U-FAKE-11 to U-FAKE-15. EH-1, EH-21, EH-22, D23.
    - Files: `test/units.test.ts` (describe `send fake cases 11-15`).
    - Test: names with spaces, quotes, brackets, and non-ASCII letters; two names that differ only in case; a skipped file in a move; a replace whose new file fails verification, which leaves the old file in place (D23); a folder listing that times out.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send fake cases 11-15"` fails, because the job does not handle these cases yet.
  - [~] 8.28 Make job.ts pass fake cases 11 to 15
    - Requirements: R16.2, R7.11. Design: §7.3, D23, EH-1, EH-21.
    - Files: `src/send/job.ts`.
    - Build: the handling for each case. If a rule in `src/send/plan.ts` is wrong, record it in a new task and do not edit `plan.ts` here.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send fake cases 11-15"` exits 0.
  - [~] 8.29 Write the Property 23 test (red)
    - Requirements: R8.9, R8.11, R8.12. Design: §2.3 steps 10 and 11. D22. EH-11. Property 23.
    - Files: `test/units.test.ts` (describe `send move`).
    - Test: `Feature: send-to-phone, Property 23: a move removes a source only after a verified copy in the same send`. The source is removed only when the copy was verified in this send, the final path was flushed and renamed, both fresh hashes equal the expected hash, and the owner confirmed the move. A failed removal gives "copied, source kept". With move not chosen, no removal call is made on any phone.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 23:"` fails, because the move steps do not exist in `src/send/job.ts` yet.
  - [~] 8.30 Build the move steps
    - Requirements: R8.9, R8.11, R8.12. Design: §2.3 steps 10 and 11. D22. EH-11.
    - Files: `src/send/job.ts`.
    - Build: steps 10 and 11 of `runFileSteps`, which run only when move is chosen and the copy was verified in this send.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 23:"` and the move examples of `-t "Property 17:"` pass.
  - [~] 8.31 Write the Property 7 test (red)
    - Requirements: R6.7, R16.3. Design: §2.1, §3.2. D1. Property 7.
    - Files: `test/units.test.ts` (describe `send archive writes`).
    - Test: `Feature: send-to-phone, Property 7: no send call mutates the archive`. Over seeded send sequences on `FakeHost`, no write, rename, truncate, or delete reaches a path under the archive root.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 7:"` fails, because `assertNotArchive` does not exist in `src/send/job.ts` yet.
  - [~] 8.32 Build the archive write guard
    - Requirements: R6.7. Design: §2.1. D1.
    - Files: `src/send/job.ts`.
    - Build: `assertNotArchive(path, archiveRoot)` runs before every write, rename, and remove in the job.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 7:"` passes.
  - [~] 8.33 Write the startSendJob tests (red)
    - Requirements: R5.7, R11.1, R13.12. Design: §3.3, §2.6. D21.
    - Files: `test/units.test.ts` (describe `send job start`).
    - Test: `startSendJob` refuses when a pull holds the lock, naming the holder. It inserts the job and file rows, runs in the background, and releases the lease in a `finally`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send job start"` fails, because `startSendJob` does not exist in `src/send/job.ts` yet.
  - [~] 8.34 Build startSendJob
    - Requirements: R5.7, R11.1, R13.12. Design: §3.3. D21.
    - Files: `src/send/job.ts`.
    - Build: `startSendJob(plan, deps, sink)` takes the lock (task 3.5), writes the record rows (task 3.3), runs the job in the background, and releases the lease in `finally`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send job start"` passes, and `git log -1 --format=%s` prints `feat(send): add per-file order, verification, and cancel` after this task's group commit for tasks 8.1 to 8.34.
  - [~] 8.35 Checkpoint: job
    - Requirements: R16.11. Design: §2.3, §2.6.
    - Files: none.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send"` exits 0, and `bun run typecheck` exits 0.

- [ ] 9. Phase 9: protocol, frames, desktop mirror, and commands (R15.1 to R15.8; design §3.10 to §3.13, §3.17, §4.4 to §4.6)
  - [~] 9.1 Write the Property 31 test (red)
    - Requirements: R15.1 to R15.4, R15.2. Design: §3.10, §4.4. EH-14. Property 31.
    - Files: `test/serve-contract.test.ts` (describe `send wire rules`).
    - Test: `Feature: send-to-phone, Property 31: commands and frames follow the wire rules`. A send command with an undeclared key is refused. Each command line gets exactly one answer frame with its id. Each send frame is one JSON object on one stdout line, and it validates against its schema. Every send ends with a `sendResult`.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve-contract.test.ts -t "Property 31:"` fails, because `send.plan` is not in `ArgsSchemas` yet.
  - [~] 9.2 Build the send schemas in protocol.ts
    - Requirements: R15.1, R15.4, R15.5. Design: §3.10, §4.5. OI-14.
    - Files: `src/serve/protocol.ts`.
    - Build: `SendSourceSchema`, `SendTargetSchema`, `ArgsSchemas` for the four send commands (strict), `SendPlanFrameSchema`, `SendRunFrameSchema`, `SendResultFrameSchema`, and `send.start` in the `needsConfirm` action list. `FRAME_SCHEMAS` keeps `trash`.
    - Done when: `bun run typecheck` exits 0, and `bun test --preload ./scripts/preload.ts test/serve-contract.test.ts -t "Property 31:"` still fails only because the frame writers do not exist yet.
  - [~] 9.3 Write the Property 32 test (red)
    - Requirements: R15.4, R13.12. Design: §3.11, §2.7. Property 32.
    - Files: `test/units.test.ts` (describe `send round trip`).
    - Test: `Feature: send-to-phone, Property 32: frames and the record round-trip`. An outcome written as a `sendResult` frame and parsed gives an equal value. An outcome written to `SendRecord` and read back gives an equal value.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 32:"` fails, because `outcomeToFrame` does not exist in `src/serve/frames.ts` yet.
  - [~] 9.4 Build the send frame writers
    - Requirements: R15.3, R15.4. Design: §3.11, §4.4.
    - Files: `src/serve/frames.ts`.
    - Build: `sendPlan`, `sendRun`, and `sendResult` writers, following the `trash` writer at line 115. Each writes one JSON line.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 32:"` and `bun test --preload ./scripts/preload.ts test/serve-contract.test.ts -t "Property 31:"` pass.
  - [~] 9.5 Write the frame-type parity test (red)
    - Requirements: R15.6. Design: §4.6, §7.3 U-FT. C16, C17, F-1.
    - Files: `test/units.test.ts` (describe `frame type parity`).
    - Test: every `head("…")` in `src/serve/frames.ts` appears in `FRAME_TYPES` in `apps/desktop/src-tauri/src/engine.rs`, and that list has no name the engine does not write. The list must hold 22 names.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "frame type parity"` fails, because `engine.rs` lists 18 names and omits `trash` and the send frames.
  - [~] 9.6 Update FRAME_TYPES in engine.rs
    - Requirements: R15.6. Design: §3.16, §4.6. F-1.
    - Files: `apps/desktop/src-tauri/src/engine.rs`.
    - Build: replace the array at line 85 with the 22 names in the order of §4.6.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "frame type parity"` passes, and `cd apps/desktop/src-tauri && cargo test` exits 0.
  - [~] 9.7 Update the desktop engine mirror
    - Requirements: R15.5, R15.6. Design: §3.17. OI-14. Notes N12 (the desktop answer keys).
    - Files: `apps/desktop/src/lib/engine/protocol.ts`.
    - Build: add the four commands to `CommandArgs`, the send shapes to `ANSWER_KEYS`, `send.start` to `NeedsConfirmFrame.action`, and the send frames to `Frame`. This file stays import-free (`test/units.test.ts` guards it).
    - Done when: `cd apps/desktop && bun run check` reports 0 errors and 0 warnings, and `bun run test` exits 0.
  - [~] 9.8 Add the send kind to the pending register
    - Requirements: R12.4. Design: §3.13. C13, F-17.
    - Files: `src/serve/pending.ts`.
    - Build: `PendingKind` gains `"send"`, and entries gain an optional `send` field. The 10-minute TTL does not change.
    - Done when: `bun run typecheck` exits 0, and `bun run test` exits 0.
  - [~] 9.9 Build the SendController planning path
    - Requirements: R12.1, R11.1, R14.3, R14.4, R14.5. Design: §3.12, §2.6 (plans). OI-19, OI-20. Notes N5 (file placement).
    - Files: `src/send/controller.ts` (new).
    - Build: `plan(request)` answers at once and runs `buildSendPlan` in the background. It stores the plan under the send id. `folders(args)` returns strict listings, with `source` set to `readdir` or `phone-find` (OI-19). `cancel` during planning stores nothing (OI-20). `dispose()` cancels and waits.
    - Done when: `bun run typecheck` exits 0.
  - [~] 9.10 Wire the send commands into dispatch.ts
    - Requirements: R15.1, R15.2, R15.8. Design: §3.12, §4.5. D11.
    - Files: `src/serve/dispatch.ts`.
    - Build: `send.plan`, `send.confirm`, `send.cancel`, and `send.folders` in `handlerTable`. `createContext` creates the `TransferLock` and `ctx.sends`.
    - Done when: `bun run typecheck` exits 0, and `bun run test` exits 0. `git log -1 --format=%s` prints `feat(send): add send protocol, frames, and commands` after this task's group commit for tasks 9.1 to 9.10.
  - [~] 9.11 Checkpoint: protocol and frames
    - Requirements: R16.11, R15.7. Design: §3.10 to §3.13.
    - Files: none.
    - Done when: `bun run test`, `bun run typecheck`, and `cd apps/desktop && bun run check` exit 0.

- [ ] 10. Phase 10: confirm gate, lock, command loop, and shutdown (R5.7, R11.1, R11.2, R12.2 to R12.10, R15.8; design §2.6, §3.9, §3.12, DD-10, DD-12; OI-16, OI-22)
  - [~] 10.1 Write the Property 27 test (red)
    - Requirements: R12.2, R12.3. Design: §2.6, §4.5. C12. Property 27.
    - Files: `test/serve.test.ts` (describe `send confirm echo`).
    - Test: `Feature: send-to-phone, Property 27: no write starts without a confirm that echoes the send id`. A confirm value that is not the stored send id starts no write, rename, replace, or delete. The answer repeats `needsConfirm` with the same send id.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "Property 27:"` fails, because `send.confirm` is not handled yet.
  - [~] 10.2 Build the confirm echo gate
    - Requirements: R12.2, R12.3. Design: §4.5. C12.
    - Files: `src/send/controller.ts`.
    - Build: `confirm(sendId, confirm)` compares the echo with the stored id, and returns `needsConfirm` on a mismatch.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "Property 27:"` passes.
  - [~] 10.3 Write the Property 28 test (red)
    - Requirements: R12.4, R12.5. Design: EH-13, §2.2. D24. C13. Property 28.
    - Files: `test/serve.test.ts` (describe `send confirm freshness`).
    - Test: `Feature: send-to-phone, Property 28: a plan is refused when it expires or when the listings changed`. A confirm after 10 minutes is refused and asks for a new plan. A changed file count or byte total returns a new plan and asks again. Otherwise the job starts.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "Property 28:"` fails, because the expiry and re-list rules are not in the controller yet.
  - [~] 10.4 Build the expiry and re-list rules
    - Requirements: R12.4, R12.5. Design: EH-13, EH-28. D24.
    - Files: `src/send/controller.ts`.
    - Build: `confirm` re-lists the source and target, compares counts and bytes with the stored plan, and checks the 10-minute TTL. The messages are those of EH-13.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "Property 28:"` passes.
  - [~] 10.5 Write the Property 29 test (red)
    - Requirements: R12.6, R12.7. Design: §4.5. D23. Property 29.
    - Files: `test/serve.test.ts` (describe `send listed paths`).
    - Test: `Feature: send-to-phone, Property 29: a confirmed send touches only the paths its plan listed`. A replace path or source path that is not in the stored plan for this send id is refused before any write, rename, or delete call.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "Property 29:"` fails, because the listed-path check is not in the controller yet.
  - [~] 10.6 Build the listed-path check
    - Requirements: R12.6, R12.7. Design: §4.5. D23.
    - Files: `src/send/controller.ts`.
    - Build: `assertListed(sendId, path)` runs before any write, rename, or delete call.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "Property 29:"` passes.
  - [~] 10.7 Write the Property 30 test (red)
    - Requirements: R12.8, R12.10. Design: §4.1, §3.2. D14. OI-22. Property 30.
    - Files: `test/units.test.ts` (describe `send confirm word`).
    - Test: `Feature: send-to-phone, Property 30: the confirm word and the sheet list follow the plan`. The word is "move" when a move is included, otherwise "replace" when any file is replaced, otherwise "copy". The sheet paths are the replaced targets and the moved sources, or the sheet states how many it does not show.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 30:"` fails, because `confirmWordFor` does not exist in `src/send/plan.ts` yet.
  - [~] 10.8 Build confirmWordFor and sheetPaths
    - Requirements: R12.8, R12.10. Design: §3.2. OI-22.
    - Files: `src/send/plan.ts`.
    - Build: `confirmWordFor({ move, replaces })` and `sheetPaths(plan, limit)`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "Property 30:"` passes.
  - [~] 10.9 Write the U-LOCK and U-TIME tests (red)
    - Requirements: R5.7, R11.1, R15.8. Design: §7.3 U-LOCK, U-TIME. D21. EH-15.
    - Files: `test/serve.test.ts` (describe `send lock and command loop`).
    - Test: a pull is refused while a send holds the lock, and the answer names the holder. A send is refused while a pull holds it. A status request is answered while a slow `FakeAdb` job waits on a phone call.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "send lock and command loop"` fails, because `RunController` does not take the lock yet.
  - [~] 10.10 Build the pull lock in run.ts
    - Requirements: R5.7, R11.9. Design: §3.14. D21. EH-15.
    - Files: `src/serve/run.ts`.
    - Build: `RunController.start()` acquires `"pull"` before anything else. It returns `{ ok: false, reason: "a send is running" }` when the lock is held. The lease releases when the summary settles, and when the starter throws.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "send lock and command loop"` shows the lock examples passing.
  - [~] 10.11 Make send.confirm answer at once
    - Requirements: R11.1, R15.8. Design: §2.6, DD-10. C10.
    - Files: `src/serve/dispatch.ts`.
    - Build: `send.confirm` returns the started answer while the job runs in the background, so the command loop is not held. Status answers during a send.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "send lock and command loop"` exits 0.
  - [~] 10.12 Write the destructive-handler lock tests (red)
    - Requirements: R5.7, R11.9. Design: F-8, RK-13. OI-16 (default b).
    - Files: `test/serve.test.ts` (describe `send lock destructive handlers`).
    - Test: `purge.apply`, `trash.empty`, and `dupes.apply` are refused while a send holds the lock, and the answer names the holder.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "send lock destructive handlers"` fails, because those handlers do not take the lock yet.
  - [~] 10.13 Take the lock in the destructive handlers
    - Requirements: R5.7, R11.9. Design: F-8, RK-13. OI-16.
    - Files: `src/serve/dispatch.ts`.
    - Build: `purge.apply`, `trash.empty`, and `dupes.apply` acquire `"pull"` (the lock holder name for pull-side work), and release it in `finally`.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "send lock destructive handlers"` passes.
  - [~] 10.14 Write the contract tests C-1, C-2, and C-4 (red)
    - Requirements: R15.1, R15.2, R15.5, R15.7, R12.1, R16.4, R18.6. Design: §7.4 C-1 to C-4. K-4.
    - Files: `test/serve-contract.test.ts` (describe `send contract`).
    - Test: C-1 runs the stdin and stdout loop for each send command, with input kept open until `sendResult` (C-3). Each command gets exactly one answer with its id, and the answer keys match `ANSWER_KEYS`. C-2: `needsConfirm` names `send.start`, `PROTOCOL_VERSION` is 1, and the keys in `src/config/schema.ts` are unchanged. C-4: a refused plan returns an error answer and writes no `sendPlan` frame.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve-contract.test.ts -t "send contract"` fails, because the send commands are not fully wired yet.
  - [~] 10.15 Make the contract tests pass in dispatch.ts
    - Requirements: R15.1, R15.2, R15.5, R12.1. Design: §7.4, §4.5.
    - Files: `src/serve/dispatch.ts`.
    - Build: the answer shapes of §4.5 and the refusal path of C-4. If the controller needs a change, record it as a new task and do not edit `controller.ts` here.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve-contract.test.ts -t "send contract"` exits 0.
  - [~] 10.16 Write the shutdown and end-of-input tests (red)
    - Requirements: R11.3, R11.7. Design: §2.6, DD-12, EH-26. D10.
    - Files: `test/serve.test.ts` (describe `send shutdown`).
    - Test: end of input and the `shutdown` command each cancel a running send and wait for its cleanup before `bye`. The send is recorded as `cancelled` with "closed by the app". The process id does not change.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "send shutdown"` fails, because end of input does not dispose the controller yet.
  - [~] 10.17 Dispose the controller at end of input
    - Requirements: R11.3, R11.7. Design: §2.6, DD-12. EH-26.
    - Files: `src/serve/index.ts`.
    - Build: at end of input, call `ctx.sends.dispose()` before writing `bye`.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "send shutdown"` passes its end-of-input example.
  - [~] 10.18 Dispose the controller on shutdown
    - Requirements: R11.3. Design: §3.12. DD-12, EH-26.
    - Files: `src/serve/dispatch.ts`.
    - Build: the `shutdown` handler calls `ctx.sends.dispose()` before it answers. The pull's `runs.dispose()` call stays.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "send shutdown"` exits 0, and `git log -1 --format=%s` prints `feat(send): gate sends on confirm echo and plan expiry` after this task's group commit for tasks 10.1 to 10.18.
  - [~] 10.19 Checkpoint: confirm gate and lock
    - Requirements: R16.11. Design: §2.6, §4.5.
    - Files: none.
    - Done when: `bun run test` and `bun run typecheck` exit 0.

- [ ] 11. Phase 11: desktop Send state, prefs, sheet, rail, and screen (R12.9, R13.9, R14.1 to R14.20; design §3.18; D-tests in §7.6; OI-15, OI-22)
  - [~] 11.1 Write the send state tests (red)
    - Requirements: R13.9, R14.5, R14.9, R14.12, R14.13, R14.14. Design: §3.18, DD-13, §7.6 D-1 to D-4, D-6. Property 2 (`Feature: send-to-phone, Property 2: choosers and remembered folders never show what was not read`).
    - Files: `apps/desktop/tests/screens.test.ts` (describe `send state`).
    - Test: `routeSendFrame` stores each frame unchanged. `reset()` clears the plan, run, result, sheet, and listing. `readOnMount` routes the last `sendPlan` and `sendRun`. A URL with send parameters does not start a send. A failed listing shows "could not be read" and no folders. A remembered folder absent from the listing shows "not found on the phone". Property 2 is a seeded test of the phone choices and the remembered folder.
    - Done when: `cd apps/desktop && bun run test` fails, because `lib/state/send.svelte.ts` does not exist yet.
  - [~] 11.2 Build the send state singleton
    - Requirements: R13.9, R14.12, R14.13. Design: §3.18, DD-13.
    - Files: `apps/desktop/src/lib/state/send.svelte.ts` (new).
    - Build: the `SendScreen` class from §3.18, with `$state.raw` for the plan, run, and result. It holds no count, rate, or estimate of its own.
    - Done when: `cd apps/desktop && bun run test` passes the send state tests.
  - [~] 11.3 Write the live-region test (red)
    - Requirements: R14.19. Design: §7.6 D-8. C32. Property 35.
    - Files: `apps/desktop/tests/screens.test.ts` (describe `send live region`).
    - Test: `Feature: send-to-phone, Property 35: the live region is quiet and never names bytes`. Over seeded progress timelines, at most one announcement appears in any five-second window, and no announcement holds a byte count.
    - Done when: `cd apps/desktop && bun run test` fails on this block, because the announcer does not exist yet.
  - [~] 11.4 Build the announcer
    - Requirements: R14.19. Design: §3.18. C32 (`run.svelte.ts` 5 s).
    - Files: `apps/desktop/src/lib/state/send.svelte.ts`.
    - Build: `announce(frame, now)` returns text in file counts and phase only, at most once every five seconds.
    - Done when: `cd apps/desktop && bun run test` passes the live-region block.
  - [~] 11.5 Write the remembered-folder pref test (red)
    - Requirements: R14.15. Design: §7.6 D-5, §3.18. C34. D2.
    - Files: `apps/desktop/tests/prefs.test.ts` (describe `send folders pref`).
    - Test: `asSendFolders` accepts a map of device id to folder string and refuses any other value. The key is `portage-send-folders`.
    - Done when: `cd apps/desktop && bun run test` fails, because `asSendFolders` does not exist yet.
  - [~] 11.6 Build the remembered-folder pref
    - Requirements: R14.15. Design: §3.18. C34.
    - Files: `apps/desktop/src/lib/state/prefs.ts`.
    - Build: add `sendFolders: 'portage-send-folders'` to `PREF_KEYS`, and `asSendFolders` with its validator.
    - Done when: `cd apps/desktop && bun run test` passes the pref block.
  - [~] 11.7 Write the sheet test (red)
    - Requirements: R12.9, R14.8, R14.18. Design: §7.6 D-7, §3.18. OI-22.
    - Files: `apps/desktop/tests/screens.test.ts` (describe `send confirm sheet`).
    - Test: the sentence and confirm word for `send.start` cover copy, replace, and move. The confirm control stays disabled until the word matches.
    - Done when: `cd apps/desktop && bun run test` fails on this block, because `send.start` is not handled by the sheet yet.
  - [~] 11.8 Build the send.start sheet branch
    - Requirements: R12.9, R14.8, R14.18. Design: §3.18. OI-22. F-16.
    - Files: `apps/desktop/src/lib/components/app/confirm-sheet.svelte`.
    - Build: add `send.start` to the action union and its sentence. Focus moves to the Cancel button on open. Do not hand-edit `components/ui`.
    - Done when: `cd apps/desktop && bun run test` passes the sheet block, and `bun run check` reports 0 errors.
  - [~] 11.9 Write the rail test (red)
    - Requirements: R14.1. Design: §7.6 D-9, §3.18. Notes N13 (keyboard map).
    - Files: `apps/desktop/tests/screens.test.ts` (describe `send rail`).
    - Test: the navigation lists Send with letter `e`, the keyboard map lists it too, and the letters h, p, t, d, u, o, s, and e are unique.
    - Done when: `cd apps/desktop && bun run test` fails on this block, because `NAV` has no Send entry yet.
  - [~] 11.10 Add the Send entry and the reset call to +layout.svelte
    - Requirements: R14.1, R14.12. Design: §3.18 (lines 48 to 56, and 131 to 137). C28, D-2.
    - Files: `apps/desktop/src/routes/+layout.svelte`.
    - Build: add `{ href: '/send', label: 'Send', letter: 'e' }` to `NAV`, and call `send.reset()` in the reset effect for `stopped` and `restarting`.
    - Done when: `cd apps/desktop && bun run test` passes the rail block, and `bun run check` reports 0 errors.
  - [~] 11.11 Route send frames in screens-routing.ts
    - Requirements: R13.9, DD-13. Design: §3.18, F-2.
    - Files: `apps/desktop/src/lib/state/screens-routing.ts`.
    - Build: the observer passes `sendPlan`, `sendRun`, and `sendResult` to `send.routeSendFrame`.
    - Done when: `cd apps/desktop && bun run test` exits 0.
  - [~] 11.12 Write the hydration test (red)
    - Requirements: R14.12, R15.6. Design: §3.18, F-3. OI-15 (default a).
    - Files: `apps/desktop/tests/screens.test.ts` (describe `send hydration`).
    - Test: `HYDRATION_ORDER` lists `trash`.
    - Done when: `cd apps/desktop && bun run test` fails on this block, because `HYDRATION_ORDER` omits `trash`.
  - [~] 11.13 Add trash to HYDRATION_ORDER
    - Requirements: R15.6. Design: F-3. OI-15.
    - Files: `apps/desktop/src/lib/state/app.svelte.ts`.
    - Build: add `trash` to `HYDRATION_ORDER` (lines 80 to 92).
    - Done when: `cd apps/desktop && bun run test` passes the hydration block.
  - [~] 11.14 Build the Send route
    - Requirements: R14.2 to R14.11, R14.16, R14.20. Design: §3.18, D14. C30, C31. Run the Svelte autofixer (AGENTS.md) on the file.
    - Files: `apps/desktop/src/routes/send/+page.svelte` (new).
    - Build: the four steps. The source chooser lists archive folders and phone folders, through `send.folders`. The target chooser lists ready phones and the remembered folder. Plan preview, confirm sheet, progress with Cancel, and result. Labels and numbers come only from frames. Uses existing tokens and no new colour.
    - Done when: `cd apps/desktop && bun run check` reports 0 errors and 0 warnings, and `bun run build` exits 0. `git log -1 --format=%s` prints `feat(desktop): add the Send screen and its state` after this task's group commit for tasks 11.1 to 11.14.
  - [~] 11.15 Checkpoint: desktop Send screen
    - Requirements: R14.16, R14.17. Design: §9.3.
    - Files: none.
    - Done when: `cd apps/desktop && bun run check`, `bun run test`, and `bun run a11y` exit 0.

- [ ] 12. Phase 12: ui:sweep journeys J-7 and J-8 (R16.5, R14.1 to R14.10; design §9.1, §9.2, §8.9; D15)
  - [~] 12.1 Write the J-7 and J-8 steps (red)
    - Requirements: R16.5, R14.2 to R14.8. Design: §9.1, §9.2. D15.
    - Files: `apps/desktop/scripts/ui-sweep.ts`.
    - Build: add the step names `send: drive to phone, ...` (J-7) and `send: phone to phone, ...` (J-8), with the routes `/send?mock=send&kind=drive` and `/send?mock=send&kind=phone`. Each step asserts the text of §9.1.
    - Done when: `cd apps/desktop && bun run build && bun run ui:sweep` exits non-zero, and the failing step is one of the `send:` steps, because the `send` mock scenario does not exist yet.
  - [~] 12.2 Build the send mock scenario
    - Requirements: R16.5. Design: §9.2. D15.
    - Files: `apps/desktop/src/lib/engine/mock.ts`.
    - Build: add `send` to `MockScenario` (line 42). It answers the four send commands and emits `sendPlan`, `needsConfirm`, `sendRun`, and `sendResult` with fixed content. No randomness.
    - Done when: `cd apps/desktop && bun run build && bun run ui:sweep` exits 0 and reports nine steps.
  - [~] 12.3 Copy the send screenshots into bench/evidence and commit
    - Requirements: R16.10, R16.5. Design: §8.9, F-15.
    - Files: `bench/evidence/send-to-phone/ui-sweep/07-send.png` and `bench/evidence/send-to-phone/ui-sweep/08-send.png` (copied from `/tmp/portage-ui` by one command).
    - Done when: `ls bench/evidence/send-to-phone/ui-sweep/` lists both files, and `git log -1 --format=%s` prints `test(desktop): add send journeys J-7 and J-8 to ui:sweep` after this task's commit.
  - [~] 12.4 Checkpoint: sweep
    - Requirements: R16.5. Design: §9.1.
    - Files: none.
    - Done when: `cd apps/desktop && bun run build && bun run ui:sweep` exits 0 with nine steps.

- [ ] 13. Phase 13: tauri-dev journeys without hardware (R16.6, R16.7, R16.9, R14.5, R14.11, R14.12, R14.18; design §8.7; needs S4 from task 2.14)
  - [~] 13.1 Journey T-2: no phone attached (Needs the display)
    - Requirements: R16.6, R16.7, R14.11. Design: §8.7 T-2. Starts after S4 passes (2.14).
    - Files: `bench/evidence/send-to-phone/T-2/result.json` (new). The screenshot, DOM text, and IPC state go in the same folder.
    - Done when: `grep -c '"result": "pass"' bench/evidence/send-to-phone/T-2/result.json` prints 1, and the Send screen text names "no phone attached" with no target.
  - [~] 13.2 Journey T-3: archive refusals (Needs the display)
    - Requirements: R16.7, R14.11. Design: §8.7 T-3. H4. Notes N9.
    - Files: `bench/evidence/send-to-phone/T-3/result.json` (new).
    - Done when: `grep -c '"result": "pass"' bench/evidence/send-to-phone/T-3/result.json` prints 1, and the "not mounted" text appears. The read-only and root-filesystem texts are checked in the unit tests.
  - [~] 13.3 Journey T-4: engine stopped and restarting (Needs the display)
    - Requirements: R14.12, R16.7. Design: §8.7 T-4. D-2.
    - Files: `bench/evidence/send-to-phone/T-4/result.json` (new).
    - Done when: `grep -c '"result": "pass"' bench/evidence/send-to-phone/T-4/result.json` prints 1, and the Send state is empty after the restart.
  - [~] 13.4 Journey T-7: keyboard only (Needs the display)
    - Requirements: R14.1, R14.18. Design: §8.7 T-7. D-9.
    - Files: `bench/evidence/send-to-phone/T-7/result.json` (new).
    - Done when: `grep -c '"result": "pass"' bench/evidence/send-to-phone/T-7/result.json` prints 1, with `g` then `e` opening Send and focus on the sheet's Cancel button.
  - [~] 13.5 Journey T-8: phone folder listing fails (Needs the phone, Needs the display)
    - Requirements: R14.5, R16.6. Design: §8.7 T-8. D-6. Notes N10.
    - Files: `bench/evidence/send-to-phone/T-8/result.json` (new). Commit with the journeys.
    - Done when: `grep -c '"result": "pass"' bench/evidence/send-to-phone/T-8/result.json` prints 1, and the chooser shows "could not be read" with no folders. `git log -1 --format=%s` prints `test(desktop): record tauri-dev send journeys` after this task's group commit for tasks 13.1 to 13.5.
  - [~] 13.6 Checkpoint: journeys
    - Requirements: R16.10. Design: §8.7.
    - Files: none.
    - Done when: `ls bench/evidence/send-to-phone/T-*/result.json` lists five files, and each reports `pass`.

- [ ] 14. Phase 14: real-device runs and hash records (R17.1 to R17.9, R16.8; design §8.6; R-1 and R-2)
  - [~] 14.1 Write the hash record tests (red)
    - Requirements: R17.3, R17.7, R17.8, R17.9. Design: §8.6, §8.1.
    - Files: `test/units.test.ts` (describe `send hash record`).
    - Test: a record lists, for each file, the source path, target path, size, each applicable hash, the relay or write method, the flush outcome, the final state, and the raw output. A delete with no approved list is refused. A failed run keeps its record, and a new run writes a new file.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send hash record"` fails, because `scripts/bench/send-run.ts` does not exist yet.
  - [~] 14.2 Build the real-run script
    - Requirements: R17.3, R17.4, R17.5, R17.6, R17.7. Design: §8.6.
    - Files: `scripts/bench/send-run.ts` (new).
    - Build: record the environment (device ids, models, Android versions, adb version, kernel, archive device, port, link speed, mount options). Record `df` before and after a move, and the archive listing before and after. Refuse any delete without an approved list file. Names records `<date>-send-r1-...` or `<date>-send-r2-...`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send hash record"` passes.
  - [~] 14.3 Run R-1, drive-to-phone, with journey T-5 (Needs the phone, Needs the archive drive mounted, Needs the display)
    - Requirements: R17.1, R17.3 to R17.8, R16.8. Design: §8.6 R-1 steps 1 to 10. D1, D15.
    - Files: `bench/results/<date>-send-r1-drive-to-phone-1.json` (new, committed). Evidence goes to `bench/evidence/send-to-phone/R-1/` and `T-5/`.
    - Done when: the record exists, the archive listing before and after match (R17.6), and `git log -1 --format=%s` prints `test(bench): record real-device drive-to-phone send run`. A failed record is kept, and the next run is a new file (R17.8).
  - [~] 14.4 Run R-2, phone-to-phone, with journey T-6 (Needs the phone, two phones attached, Needs the display)
    - Requirements: R17.2, R17.5, R17.8, R16.8. Design: §8.6 R-2 steps 1 to 7. TODO M8-1 (`TODO.md:251`). D11.
    - Files: `bench/results/<date>-send-r2-phone-to-phone-1.json` (new, committed). Evidence goes to `bench/evidence/send-to-phone/R-2/` and `T-6/`.
    - Done when: the record names the relay that `chooseRelay` selected, shows `df` before and after the move, and shows the host temporary file removed after the cancel. `git log -1 --format=%s` prints `test(bench): record real-device phone-to-phone send run`.
  - [~] 14.5 Checkpoint: real runs
    - Requirements: R17.3, R17.8. Design: §8.1.
    - Files: none.
    - Done when: `ls bench/results/*-send-r*-*.json` lists the two runs, each with its hash fields. A `fail` verdict is accepted here and is recorded, not edited.

- [ ] 15. Phase 15: definition of done (R16.10 to R16.12, R18.2 to R18.7; design §7.8, §9.4, §9.5; AGENTS.md)
  - [~] 15.1 Write the repository check tests
    - Requirements: R18.2, R18.3, R18.4, R18.5, R18.6. Design: §9.4 K-1, K-2, K-4; OI-23. These checks pass when written, as durability tasks 6.6 and 6.7 do (Notes N11).
    - Files: `test/units.test.ts` (describe `send repo checks`).
    - Test: K-1, frozen folders (`src/xfer`, `src/index`, `src/plan`, `src/scan`) unchanged against the base commit from `scripts/range-start.sh`. `scripts/apull.sh` and `crates/portage-scan` unchanged (R18.4, OI-23). K-2, no new dependency in `package.json` or `apps/desktop/package.json`. K-4, the schema keys in `src/config/schema.ts` unchanged.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send repo checks"` exits 0.
  - [~] 15.2 Write the docs tests (red)
    - Requirements: R16.12, R16.5. Design: §9.5. C26, C27.
    - Files: `test/units.test.ts` (describe `send docs`, with three sub-blocks `send docs README`, `send docs TODO`, and `send docs AGENTS`).
    - Test: README gives the nine-step sweep, and has a send section that states the verification rule and the difference from apull's size rule. TODO has the send rows and links M8-1 to the R-2 record. AGENTS.md says nine steps and names the send commands.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send docs"` fails on all three sub-blocks, because the docs still say seven.
  - [~] 15.3 Update README.md
    - Requirements: R16.12. Design: §9.5. C26, C27.
    - Files: `README.md`.
    - Build: the step count (README line 314), and a send section.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send docs README"` passes.
  - [~] 15.4 Update TODO.md
    - Requirements: R16.12. Design: §9.5. C37.
    - Files: `TODO.md`.
    - Build: add the send rows, and link M8-1 to the R-2 record.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send docs TODO"` passes.
  - [~] 15.5 Update AGENTS.md
    - Requirements: R16.12. Design: §9.5 (the count and the send commands only).
    - Files: `AGENTS.md`.
    - Build: the "7-step headless journey" line becomes nine, and the send commands are listed under Commands.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "send docs AGENTS"` passes, and `git log -1 --format=%s` prints `docs(send): describe send-to-phone and the nine-step sweep` after this task's group commit for tasks 15.1 to 15.5.
  - [~] 15.6 Checkpoint: definition of done
    - Requirements: R16.11, R16.12. Design: §7.8. AGENTS.md definition of done.
    - Files: none.
    - Done when, in order, each exits 0: `bun run typecheck`; `bun run test`; `cd apps/desktop && bun run check && bun run test && bun run a11y && bun run build && bun run ui:sweep`; `cd crates/portage-scan && cargo test`; `cd apps/desktop/src-tauri && cargo test`; and `scripts/check-commits.sh HEAD~1 HEAD`.

## Notes

- **N1. Record path.** Design §8.1 puts spike and run records under `bench/results/send-to-phone/`. This list uses the durability naming, `bench/results/<date>-send-<experiment>.json`, as the Conventions require. The design is not edited. Owner to choose one.
- **N2. Stream relay build.** Design §2.5 says both relay branches are written and tested, and the record picks the default. This list builds the stream relay only when S1 passes (Phase 7), as the owner's rule requires. The temporary-file relay is required (R8.2). If the owner wants both written now, Phase 7's test tasks become required.
- **N3. Property library.** OI-12's recommended default is fast-check. The owner has not approved it, and the list forbids a new library until then. The properties are seeded generators in existing files. If OI-12 is approved, the same test titles can move to fast-check.
- **N4. Test files.** Design §7.5 names new files (`test/send-*.test.ts`). The list puts the tests in existing files, as the list's rule requires. The fakes go in `test/helpers.ts`, not `test/send-fakes.ts` (design §7.2).
- **N5. SendController location.** Design §3.12 defines `SendController` and names no file. Task 9.9 puts it in `src/send/controller.ts`, a sixth file under `src/send` (design §2.1 lists five). Alternatively it can go in `dispatch.ts`.
- **N6. Mount rule duplicates durability.** `judgeArchiveMount` (task 4.3) and durability's `judgeDestination` (task 2.11, with the root rule of 2.31) state the same rule. Once durability task 2.31 lands, task 4.3 should call `judgeDestination` rather than add a second rule (R6.1, D12).
- **N7. Defaults against requirement text.** The list follows these defaults, and each changes a requirement's wording:
  - OI-7 (keep the source folder's name): R7.1 must say "relative to the source folder's parent".
  - OI-8 (single files): R14.2 and Q5 must allow single files.
  - OI-10 (zero bytes skipped): R7.15 and Q4 must change.
  - OI-3 (one file in flight, `jobs` not read): R11.11 and R11.12 are not built in v1 (tasks 8.19 and 8.20).
- **N8. Stream cancel case.** U-FAKE-6 in design §7.3 says "a cancel during a stream". Task 8.25 uses a temporary-file relay. The stream variant belongs to Phase 7, which is gated.
- **N9. Archive journey on this host.** H4 says the archive drive is not attached. T-3 therefore shows the "not mounted" refusal live. The read-only and root-filesystem refusals are covered by the unit tests in task 4.2.
- **N10. Journey T-8.** Design §8.7 marks T-8 as needing no hardware. A failing folder listing needs a phone, so the list marks it `Needs the phone`. The unit test in task 11.1 covers the no-hardware case.
- **N11. Guard checks.** Task 15.1 and the docs checks pass when written, as durability tasks 6.6 and 6.7 do.
- **N12. Desktop mirror.** `apps/desktop/src/lib/engine/protocol.ts` stays import-free (design §3.17). OI-17 (quoting in four old adb methods) is a separate change and is not in this list.
- **N13. Keyboard map.** Design §3.18 names the NAV entry but not the keyboard map. Task 11.9 expects the map to be the `NAV` constant. If the map is elsewhere, the test names it when written.
- **N14. Hardware on this host.** H3 and H4 say no phone is attached and no archive drive is mounted. Every task marked with a hardware marker waits for the owner's hardware. Those tasks cannot run here.
- **N15. S2 gate.** R2.6 says the send feature does not merge until the owner decides Q1 when S2 does not show a flush (OI-4). Checkpoint 2.18 is the stop point.
- **N16. Flush tasks.** Durability tasks 1.9 and 1.10 (flush functions) are not needed under OI-13 default (b). Task 0.1 lists the change if the owner picks option (a).
- **N17. Enabling the gated tasks.** Phase 7 tasks carry `*`. Once the S1 record shows `pass`, the owner or the agent removes `*` from 7.1 to 7.3 and builds them. Checkpoint 7.4 is required in either case.
- **N18. Wave order.** The graph below is sequential. Almost every task writes `test/units.test.ts`, `test/serve.test.ts`, or one module, and the graph rule forbids two tasks that write one file in the same wave. The graph also follows the list order, which puts each red test before its code (Conventions). The workflow's rule that tests go after the code they test conflicts with the Conventions, and the Conventions govern here.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1"] },
    { "id": 1, "tasks": ["1.1"] },
    { "id": 2, "tasks": ["1.2"] },
    { "id": 3, "tasks": ["1.3"] },
    { "id": 4, "tasks": ["1.4"] },
    { "id": 5, "tasks": ["1.5"] },
    { "id": 6, "tasks": ["1.6"] },
    { "id": 7, "tasks": ["2.1"] },
    { "id": 8, "tasks": ["2.2"] },
    { "id": 9, "tasks": ["2.3"] },
    { "id": 10, "tasks": ["2.4"] },
    { "id": 11, "tasks": ["2.5"] },
    { "id": 12, "tasks": ["2.6"] },
    { "id": 13, "tasks": ["2.7"] },
    { "id": 14, "tasks": ["2.8"] },
    { "id": 15, "tasks": ["2.9"] },
    { "id": 16, "tasks": ["2.10"] },
    { "id": 17, "tasks": ["2.11"] },
    { "id": 18, "tasks": ["2.12"] },
    { "id": 19, "tasks": ["2.13"] },
    { "id": 20, "tasks": ["2.14"] },
    { "id": 21, "tasks": ["2.15"] },
    { "id": 22, "tasks": ["2.16"] },
    { "id": 23, "tasks": ["2.17"] },
    { "id": 24, "tasks": ["2.18"] },
    { "id": 25, "tasks": ["3.1"] },
    { "id": 26, "tasks": ["3.2"] },
    { "id": 27, "tasks": ["3.3"] },
    { "id": 28, "tasks": ["3.4"] },
    { "id": 29, "tasks": ["3.5"] },
    { "id": 30, "tasks": ["3.6"] },
    { "id": 31, "tasks": ["3.7"] },
    { "id": 32, "tasks": ["3.8"] },
    { "id": 33, "tasks": ["3.9"] },
    { "id": 34, "tasks": ["3.10"] },
    { "id": 35, "tasks": ["3.11"] },
    { "id": 36, "tasks": ["3.12"] },
    { "id": 37, "tasks": ["4.1"] },
    { "id": 38, "tasks": ["4.2"] },
    { "id": 39, "tasks": ["4.3"] },
    { "id": 40, "tasks": ["4.4"] },
    { "id": 41, "tasks": ["4.5"] },
    { "id": 42, "tasks": ["4.6"] },
    { "id": 43, "tasks": ["4.7"] },
    { "id": 44, "tasks": ["4.8"] },
    { "id": 45, "tasks": ["4.9"] },
    { "id": 46, "tasks": ["4.10"] },
    { "id": 47, "tasks": ["4.11"] },
    { "id": 48, "tasks": ["4.12"] },
    { "id": 49, "tasks": ["4.13"] },
    { "id": 50, "tasks": ["4.14"] },
    { "id": 51, "tasks": ["4.15"] },
    { "id": 52, "tasks": ["4.16"] },
    { "id": 53, "tasks": ["4.17"] },
    { "id": 54, "tasks": ["4.18"] },
    { "id": 55, "tasks": ["4.19"] },
    { "id": 56, "tasks": ["4.20"] },
    { "id": 57, "tasks": ["4.21"] },
    { "id": 58, "tasks": ["5.1"] },
    { "id": 59, "tasks": ["5.2"] },
    { "id": 60, "tasks": ["5.3"] },
    { "id": 61, "tasks": ["6.1"] },
    { "id": 62, "tasks": ["6.2"] },
    { "id": 63, "tasks": ["6.3"] },
    { "id": 64, "tasks": ["6.4"] },
    { "id": 65, "tasks": ["6.5"] },
    { "id": 66, "tasks": ["6.6"] },
    { "id": 67, "tasks": ["6.7"] },
    { "id": 68, "tasks": ["6.8"] },
    { "id": 69, "tasks": ["6.9"] },
    { "id": 70, "tasks": ["6.10"] },
    { "id": 71, "tasks": ["6.11"] },
    { "id": 72, "tasks": ["7.1"] },
    { "id": 73, "tasks": ["7.2"] },
    { "id": 74, "tasks": ["7.3"] },
    { "id": 75, "tasks": ["7.4"] },
    { "id": 76, "tasks": ["8.1"] },
    { "id": 77, "tasks": ["8.2"] },
    { "id": 78, "tasks": ["8.3"] },
    { "id": 79, "tasks": ["8.4"] },
    { "id": 80, "tasks": ["8.5"] },
    { "id": 81, "tasks": ["8.6"] },
    { "id": 82, "tasks": ["8.7"] },
    { "id": 83, "tasks": ["8.8"] },
    { "id": 84, "tasks": ["8.9"] },
    { "id": 85, "tasks": ["8.10"] },
    { "id": 86, "tasks": ["8.11"] },
    { "id": 87, "tasks": ["8.12"] },
    { "id": 88, "tasks": ["8.13"] },
    { "id": 89, "tasks": ["8.14"] },
    { "id": 90, "tasks": ["8.15"] },
    { "id": 91, "tasks": ["8.16"] },
    { "id": 92, "tasks": ["8.17"] },
    { "id": 93, "tasks": ["8.18"] },
    { "id": 94, "tasks": ["8.19"] },
    { "id": 95, "tasks": ["8.20"] },
    { "id": 96, "tasks": ["8.21"] },
    { "id": 97, "tasks": ["8.22"] },
    { "id": 98, "tasks": ["8.23"] },
    { "id": 99, "tasks": ["8.24"] },
    { "id": 100, "tasks": ["8.25"] },
    { "id": 101, "tasks": ["8.26"] },
    { "id": 102, "tasks": ["8.27"] },
    { "id": 103, "tasks": ["8.28"] },
    { "id": 104, "tasks": ["8.29"] },
    { "id": 105, "tasks": ["8.30"] },
    { "id": 106, "tasks": ["8.31"] },
    { "id": 107, "tasks": ["8.32"] },
    { "id": 108, "tasks": ["8.33"] },
    { "id": 109, "tasks": ["8.34"] },
    { "id": 110, "tasks": ["8.35"] },
    { "id": 111, "tasks": ["9.1"] },
    { "id": 112, "tasks": ["9.2"] },
    { "id": 113, "tasks": ["9.3"] },
    { "id": 114, "tasks": ["9.4"] },
    { "id": 115, "tasks": ["9.5"] },
    { "id": 116, "tasks": ["9.6"] },
    { "id": 117, "tasks": ["9.7"] },
    { "id": 118, "tasks": ["9.8"] },
    { "id": 119, "tasks": ["9.9"] },
    { "id": 120, "tasks": ["9.10"] },
    { "id": 121, "tasks": ["9.11"] },
    { "id": 122, "tasks": ["10.1"] },
    { "id": 123, "tasks": ["10.2"] },
    { "id": 124, "tasks": ["10.3"] },
    { "id": 125, "tasks": ["10.4"] },
    { "id": 126, "tasks": ["10.5"] },
    { "id": 127, "tasks": ["10.6"] },
    { "id": 128, "tasks": ["10.7"] },
    { "id": 129, "tasks": ["10.8"] },
    { "id": 130, "tasks": ["10.9"] },
    { "id": 131, "tasks": ["10.10"] },
    { "id": 132, "tasks": ["10.11"] },
    { "id": 133, "tasks": ["10.12"] },
    { "id": 134, "tasks": ["10.13"] },
    { "id": 135, "tasks": ["10.14"] },
    { "id": 136, "tasks": ["10.15"] },
    { "id": 137, "tasks": ["10.16"] },
    { "id": 138, "tasks": ["10.17"] },
    { "id": 139, "tasks": ["10.18"] },
    { "id": 140, "tasks": ["10.19"] },
    { "id": 141, "tasks": ["11.1"] },
    { "id": 142, "tasks": ["11.2"] },
    { "id": 143, "tasks": ["11.3"] },
    { "id": 144, "tasks": ["11.4"] },
    { "id": 145, "tasks": ["11.5"] },
    { "id": 146, "tasks": ["11.6"] },
    { "id": 147, "tasks": ["11.7"] },
    { "id": 148, "tasks": ["11.8"] },
    { "id": 149, "tasks": ["11.9"] },
    { "id": 150, "tasks": ["11.10"] },
    { "id": 151, "tasks": ["11.11"] },
    { "id": 152, "tasks": ["11.12"] },
    { "id": 153, "tasks": ["11.13"] },
    { "id": 154, "tasks": ["11.14"] },
    { "id": 155, "tasks": ["11.15"] },
    { "id": 156, "tasks": ["12.1"] },
    { "id": 157, "tasks": ["12.2"] },
    { "id": 158, "tasks": ["12.3"] },
    { "id": 159, "tasks": ["12.4"] },
    { "id": 160, "tasks": ["13.1"] },
    { "id": 161, "tasks": ["13.2"] },
    { "id": 162, "tasks": ["13.3"] },
    { "id": 163, "tasks": ["13.4"] },
    { "id": 164, "tasks": ["13.5"] },
    { "id": 165, "tasks": ["13.6"] },
    { "id": 166, "tasks": ["14.1"] },
    { "id": 167, "tasks": ["14.2"] },
    { "id": 168, "tasks": ["14.3"] },
    { "id": 169, "tasks": ["14.4"] },
    { "id": 170, "tasks": ["14.5"] },
    { "id": 171, "tasks": ["15.1"] },
    { "id": 172, "tasks": ["15.2"] },
    { "id": 173, "tasks": ["15.3"] },
    { "id": 174, "tasks": ["15.4"] },
    { "id": 175, "tasks": ["15.5"] },
    { "id": 176, "tasks": ["15.6"] }
  ]
}
```
