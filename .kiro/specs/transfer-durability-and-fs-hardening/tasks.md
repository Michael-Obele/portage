# Implementation Plan: transfer-durability-and-fs-hardening

## Overview

This plan builds the feature in the order that requirements.md and design.md approve. Phase 0 makes the measurements before any production change, and its records fix two constants that Phase 1 must match. Phases 1 to 7 follow: the durability core, the probes, the exclusion fix with the CI checks, the gated Helper moves, the frame peek, the documentation, and the definition of done. Each phase has a checkpoint task that runs the phase's commands and fixes what fails. Phase 4 adds two required tasks after its checkpoint (4.26 and 4.27), and its header says why.

## Conventions

- **Optional tasks.** Only the gated Helper tasks in Phase 4 (4.4 to 4.24) carry `*`. An agent does not implement a `*` task. Each gated task's test reads its gate's record in `bench/results/` and fails unless that record allows the gate (Notes N12 and N14). The owner's step to enable a gated task is in the Notes owner checklist (N30).
- **Required tests.** Test tasks are required, because AGENTS.md treats a gate that was not run as a failed gate. Each test task is written before the code it checks, and it fails first for the reason its Done when line names. The named exceptions are the R2.7 test in 2.33 and the checks in 6.6 and 6.7, which pass when written. Each property has its own task.
- **Markers.** `Needs the archive drive mounted` and `Needs the phone` mark a task that needs the hardware. Drive tasks run one at a time, because the flush counter is per device (Notes N27). `Gate: ...` marks a Helper task that is built only when its gate's record passes.
- **Records.** A measurement record is a JSON file under `bench/results/`, named `YYYY-MM-DD-<experiment>.json`. Its `verdict` object holds `result` (`pass` or `fail`) and the decision fields of its experiment.
- **Commits.** The commit subject of a group appears in the Done when line of the group's last task. A subject uses a Conventional Commit type and is at most 72 characters, as scripts/check-commits.sh requires. No commit carries an AI attribution line. Checkpoints make no commits.
- **Protocol.** The engine's stdout carries the JSON protocol, so src/ gets no `console.log` (AGENTS.md).
- **Dependencies.** No new crates. libc is already a dependency of crates/portage-scan. The Desktop shell gets only the serde_json `raw_value` feature.
- **Frozen.** src/scan is frozen. No task changes it.
- **Property tests.** Each property is a seeded generator in an existing test file, with at least 100 iterations. The seed is printed on failure.
- **Messages.** A task that writes a message quotes its text exactly from R2.3, R2.10, R2.14 (with design O-17), or EH-13 in design.md. A message that the design gives from another source keeps the design's text, and the task names that source.
- **Files.** Each task names the files it writes. A task that writes several files lists each one, and its Done when line checks each one.

## Tasks

- [x] 0. Phase 0: measurements before any production change
  - [x] 0.1 Write the tests for the bench record parsers (red)
    - Requirements: R7.1, R7.2. Design: Measurement plan (Harness modules, Record fields).
    - Files: `test/units.test.ts` (new `bench record` describe block).
    - Tests first: diskstats column 19 is the flush-requests-completed counter (the 16th statistic). A fuseblk line in `/proc/mounts` gives the driver `ntfs-3g`. The CI pin is read from `bun-version` in ci.yml. A sysfs `speed` value is read as Mbit/s. The mount guard accepts a root under a `fuseblk` or `ntfs3` mount and refuses any other root.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "bench record"` failed, because `scripts/bench/record.ts` did not exist yet.

  - [x] 0.2 Build the bench record module
    - Requirements: R7.1, R7.2; O-9. Design: Measurement plan (Harness modules, Record fields); DV-2.
    - Files: `scripts/bench/record.ts` (new).
    - Build: capture the commit and dirty state, host, kernel, Bun version, the CI pin, the mount line, the driver, the block device, the rotational flag, the write-cache mode, the device model, and the USB link speed. Read the device and link values at run time, and record the values found. Export `mountGuard(root)`, which refuses to run unless the nearest mount point of `root` has the driver `fuseblk` or `ntfs3`. Export `writeRecord(experiment, verdict, raw)`, which writes one JSON file under `bench/results/` that follows the Conventions.
    - Done when: the tests from 0.1 pass, and `bun run typecheck` passes.

  - [x] 0.3 Write the Property 10 test for the fixture guard (red)
    - Requirements: R4.12. Design: Correctness Property 10; Measurement plan (fixtures.ts).
    - Files: `test/units.test.ts` (new `fixture guard` describe block).
    - Tests first: Property 10 as a seeded generator over three root states: empty, only manifest entries, and a foreign entry at a random depth. The guard deletes only manifest paths. In the foreign case it deletes nothing and exits with an error. Also an example: the deep fixture has exactly 462 segments. The seed is printed on failure.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "fixture guard"` failed, because `scripts/bench/fixtures.ts` did not exist yet.

  - [x] 0.4 Build the fixtures module
    - Requirements: R4.12. Design: Measurement plan (Harness modules, Fixtures).
    - Files: `scripts/bench/fixtures.ts` (new).
    - Build: the deep fixture (one chain of 462 path segments, with short names) and the shallow fixture (three segments or fewer) under a fixture root. Each fixture holds 1,000 files of 4 KiB. The deep fixture places all 1,000 files in its deepest directory, which is the design position (O-18). Write every created path to a manifest. Delete only manifest paths. Refuse to run when the root holds an entry the manifest does not list.
    - Done when: the tests from 0.3 pass.

  - [x] 0.5 Write the E1 verdict tests (red)
    - Requirements: R1.10, R1.11 (the archive drive's counter, read from the disk line), R1.12. Design: Measurement plan (E1, Decision table).
    - Files: `test/units.test.ts` (new `E1 verdict` describe block).
    - Tests first: `e1Verdict(runs)` in `scripts/bench/e1-flush.ts` takes the disk-line counter readings for forms 0, 1a, 1b, and 2, and the flush and directory-sync times. The disk line decides, because it is the line that holds the flush counter (`verdict.counterLine` is `"disk"`). The partition line is recorded but does not decide. It returns `result` and `openMode`. The result is `pass` when the disk counter moves for form 1a or form 1b, and form 2's file flush finishes within `flushDeadlineMs(300000000)`, which is 60,000 ms, and its directory sync finishes within 30,000 ms. The open mode is `"r"` when form 1a moves the counter, and `"r+"` when only form 1b does. The result is `fail` when no fsync form moves the counter. Examples cover each case. A seeded check of at least 100 iterations confirms that the result is `pass` exactly under those conditions. The seed is printed on failure.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "E1 verdict"` failed, because `scripts/bench/e1-flush.ts` did not exist yet.

  - [x] 0.6 Write the E1 script, run it on the archive drive, and commit its record
    - Needs the archive drive mounted. Requirements: R1.10, R1.11, R1.12, R1.13, R2.13. Design: Measurement plan (E1, Decision table); DV-5, DV-14; O-12.
    - Files: `scripts/bench/e1-flush.ts` (new), `bench/results/<date>-e1-flush.json` (new, committed).
    - Build: form 0 is `sync -f <file>` through Bun.spawn. Form 1a opens the file with "r" and calls `sync()`. Form 1b does the same with "r+". Form 2 is form 1a, then the directory opened with "r" and `sync()`. Each form runs five times (O-12). Each timed run writes a new file of 300,000,000 bytes, so the flush has dirty data, and deletes it after the run. Record for each run: the flush-requests-completed counter (column 19 of the archive partition and of its disk), `Dirty` and `Writeback`, the open mode of each handle, and the wall time. The verdict reads the disk line, which holds the counter (`verdict.counterLine` is `"disk"`). It records the partition line with its own result (`verdict.partitionLine.result`, which is `"fail"` in the current record, because the partition line does not move). R1.11 requires the archive drive's counter to move, and that counter is the disk line. While one form 2 flush is pending, time 50 `fs.stat` calls, and record the longest one and the first stat after the flush ends (DV-5, Notes N18). Export `e1Verdict` from 0.5, and store its `result` and `openMode` in the verdict. Call `mountGuard` before any write. The 21 files (20 timed runs and one stat-scenario file) total 6,300,000,000 bytes (Notes N1). Record `df` before and after the cleanup.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "E1 verdict"` passes, `ls bench/results/*-e1-flush.json` lists one record, and `git log -1 --format=%s` prints `test(bench): record E1 flush measurements on the archive drive`.

  - [x] 0.7 Write the E4 script, run it on the archive drive, and commit its record
    - Needs the archive drive mounted. Requirements: R1.14. Design: Measurement plan (E4); O-10; DV-18, DV-25.
    - Files: `scripts/bench/e4-bun-sync.ts` (new), `bench/results/<date>-e4-bun-sync.json` (new, committed).
    - Build: write the run file at the sizes in the record's `raw.fixture` (300,000,000 bytes, with 1,000,000 dirty bytes). On an archive file, call `sync()` on a handle opened with "r", then on one opened with "r+". Then create `pending.bin` in the run folder, write 4096 bytes, and close it without any sync, so that the directory sync is the first call that can flush that entry (the record's `raw.procedure`). Then call `sync()` on the file's directory, opened with "r". For each call, record the counter before and after, whether it succeeded, and the error text. Record `Bun.version`. Run the script under Bun 1.4.4, the CI pin, and under the local Bun, and keep both runs in the record. The verdict's `directoryBranch` is `"A"` when the directory `sync()` throws under the CI pin, and the CI pin run decides (`verdict.decidedBy`). It is `"B"` when that call succeeds and moves the counter. The verdict is `fail` when neither holds, and `pass` when `directoryBranch` is set. Call `mountGuard` before any write.
    - Done when: `ls bench/results/*-e4-bun-sync.json` lists one record, its `verdict.directoryBranch` is `"A"` or `"B"`, its runs name both Bun versions, and `git log -1 --format=%s` prints `test(bench): record E4 Bun sync results on the archive drive`.

  - [x] 0.8 Checkpoint: Phase 0 gates
    - Run `bun run test` and `bun run typecheck`, and fix what fails.
    - Run `bun test --preload ./scripts/preload.ts test/units.test.ts -t "E1 verdict"`, and fix what fails.
    - Done when: both commands pass, and `grep -l '"result": *"pass"' bench/results/*-e1-flush.json` lists the E1 record. If the E1 verdict is `fail`, this check fails and Phase 1 does not start, because R1.11 forbids the durability change without a passing E1 record.

- [ ] 1. Phase 1: durability core (R1, R2.6, R2.7, R2.13)
     This phase starts only when checkpoint 0.8 passes. Test tasks come before the code they check. The durability tests use recording fakes or temporary folders, never the archive drive.
  - [x] 1.1 Write the probe tests (red)
    - Requirements: R2.3, R2.5, R2.7, R2.9, R2.10, R2.11. Design: Correctness Property 3; EH-2; RK-17; Testing strategy, Layer 1.
    - Files: `test/units.test.ts` (new `probe classifier` describe block).
    - Tests first: Property 3 as a seeded generator over the codes ENOENT, EACCES, EIO, EINVAL, and random codes, and over four outcomes: success, error, deadline timeout, and breaker refusal. Use a 50 ms deadline, not the 3-second default. Add the test `probe resolves at its deadline when the child never exits`: the task is a fake child whose exit never settles, even after the kill. The probe resolves as `unreadable` with reason `timeout` at 50 ms, and the child's later exit changes no result and no breaker count. Add the test `probe accepts a null root`: with `root` set to `null`, the probe waits for no flush and does not count toward the breaker.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "probe classifier"` failed, because `src/util/probe.ts` did not exist yet.

  - [x] 1.2 Write the flush deadline tests and the recorded-decision test (red)
    - Requirements: R1.11, R1.12. Design: Correctness Property 7; Measurement plan (E1, E4); Decision table.
    - Files: `test/units.test.ts` (new `flush deadline` and `recorded decisions` describe blocks).
    - Tests first: Property 7 as a seeded generator of sizes, checking `flushDeadlineMs(s) = 30000 + 1000 × ceil(s / 10000000)` and that the value never falls as the size grows. Three examples: 0 bytes gives 30,000 ms, 10,000,000 bytes gives 31,000 ms, and 10,000,001 bytes gives 32,000 ms. The `recorded decisions` test reads the newest `bench/results/*-e1-flush.json` and `bench/results/*-e4-bun-sync.json`. It fails when a record is missing, when its `verdict.result` is not `pass`, when `FLUSH_OPEN_MODE` differs from the E1 `verdict.openMode`, or when `DIRECTORY_SYNC_BRANCH` differs from the E4 `verdict.directoryBranch`. The constants come from task 1.8. This test was red until Phase 0 wrote the records (tasks 0.6 and 0.7) and task 1.8 added the two constants.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "flush deadline"` failed because `src/util/durable.ts` did not exist yet, and `-t "recorded decisions"` failed because `FLUSH_OPEN_MODE` and `DIRECTORY_SYNC_BRANCH` were not exported yet.

  - [x] 1.3 Write the tests for the dirty ledger (Property 2, red)
    - Requirements: R1.13, R1.15. Design: Correctness Property 2; EH-4; DV-9.
    - Files: `test/verify-gate.test.ts` (new `dirty ledger` describe block).
    - Tests first: Property 2 as a seeded generator of sequences over one root: mark, snapshot, clear with a version, and poison. A mark bumped after a snapshot survives a clear made with the snapshot's version. A poisoned mark is never cleared.
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "dirty ledger"` fails.

  - [x] 1.4 Write the tests for the breaker and probe waiting (Property 8, red)
    - Requirements: R2.12, R2.13. Design: Correctness Property 8; EH-3, EH-6.
    - Files: `test/verify-gate.test.ts` (new `breaker` describe block).
    - Tests first: Property 8 as a seeded generator of outcomes on one root. The breaker trips on the third consecutive timeout. A success or an error resets the count. A tripped breaker refuses further work. A probe waits only for the flushes pending when it starts. A flush that starts later does not extend that wait. The tests use 50 ms deadlines.
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "breaker"` fails.

  - [x] 1.5 Write the tests for the durable drive copy (red)
    - Requirements: R1.2, R1.3, R1.5, R1.7, R1.8, R1.13. Design: EH-1, EH-7, EH-10, EH-13 (exact strings); Testing strategy, Layers 1 and 2; Notes N4 and N5.
    - Files: `test/verify-gate.test.ts` (new `durable drive copy` describe block).
    - Tests first: a recording fake shows that `flushFile` makes exactly two fsync calls, one on the file and then one on its directory (R1.2, R1.3). The fake is passed through the optional `deps` argument. An `ensureDirTracked` example in a temporary folder creates a deep path from the top down and returns `created`. Two concurrent calls on one path give one `created` and one `exists`. A `flushGate` example refuses a copy beneath a poisoned directory and accepts one elsewhere under the same root. A `moveFile` example with an injected `rename` that throws EXDEV flushes and gates the copy before it unlinks the source, and a failed flush keeps the source. A failed file flush returns the EH-13 text "flush failed: the drive did not confirm the file was written", matched exactly. A stalled flush does not block a status request (R1.7).
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "durable drive copy"` fails.

  - [x] 1.6 Write the test for the order of durability steps (Property 1, red)
    - Requirements: R1.1, R1.4, R1.6, R1.9, R2.6. Design: Correctness Property 1; Per-file order of operations, steps 1 to 9; Testing strategy, Layer 1.
    - Files: `test/verify-gate.test.ts` (new `durability order` describe block, extending `recordingTransport` and `engineFor`).
    - Tests first: Property 1 as a seeded generator of copy sequences, where each flush call (file, directory, gate) returns success, failure, or timeout. Assert that `written` is recorded only after all three flush calls succeed, and that `removeSource` runs only after the hashes match. A failed or timed-out flush keeps the phone copy. The fixed example for one copy has the order: file flush, directory flush, gate, `written`, hash, delete. R2.6: spy on `Bun.spawn` and `Bun.spawnSync` during the run, and assert that no drive stat starts a child process.
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "durability order"` fails.

  - [x] 1.7 Build the probe wrapper
    - Requirements: R2.2, R2.5, R2.6, R2.11, R2.12, R2.13. Design: Components (`src/util/probe.ts`); EH-2, EH-3, EH-6; RK-17; DV-19 (O-6 adopted).
    - Files: `src/util/probe.ts` (new).
    - Build: `PROBE_TIMEOUT_MS`, `ProbeResult`, `classifyError`, `probe`, `statDrive` (which uses `fs.stat` and starts no child process), `breakerFor`, `runFlushCall` (which registers each in-flight call), and `resetDriveState`. `probe` resolves at its own deadline even when its task has not settled, and it never waits on a child process's exit. Only deadline timeouts count toward the breaker. Any call that returns resets the count (decided default 6). `probe` waits for the calls that were pending when it started, and for no later call (O-6).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "probe classifier"` passes, and `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "breaker"` passes.

  - [x] 1.8 Build the dirty ledger, the flush deadline, `ensureDirTracked`, and the two recorded constants
    - Requirements: R1.11, R1.12, R1.13, R1.15, R2.6. Design: Components (`src/util/durable.ts`: `DirtyLedger`, `ledgerFor`, `resetLedgers`, `flushDeadlineMs`, `ensureDirTracked`); EH-4; DV-9; Decision table.
    - Files: `src/util/durable.ts` (new).
    - Build: `flushDeadlineMs(size)` returns 30,000 plus 1,000 times `ceil(size / 10,000,000)`. `DirtyLedger` provides mark, snapshot, `clearIfUnchanged`, poison, and `chainPoison`. Marks last for the life of the process (DV-9). `ensureDirTracked` stats the target through `statDrive`. If the target exists, it returns `exists` without touching the ancestors. Otherwise it walks up one probe per level, then creates each missing level from the top down with a non-recursive `mkdir`. `EEXIST` counts as existing. Export `FLUSH_OPEN_MODE`, with the value of the E1 record's `verdict.openMode`, and `DIRECTORY_SYNC_BRANCH`, with the value of the E4 record's `verdict.directoryBranch`. Each constant has a one-line comment that names its record.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "flush deadline"` passes, `-t "recorded decisions"` passes, and `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "dirty ledger"` passes.

  - [x] 1.9 Build the flush functions
    - Requirements: R1.2, R1.3, R1.4, R1.5, R1.12, R1.13, R1.15. Design: Components (`flushFile`, `flushGate`, `syncFileOnly`, `FlushOutcome`); EH-1, EH-4, EH-5, EH-10, EH-13; DV-18, DV-29, DV-30.
    - Files: `src/util/durable.ts` (the file from 1.8, so this task runs after it).
    - Build: `flushFile(root, path, size, deps?)` opens the file with `FLUSH_OPEN_MODE`, calls `sync()`, and closes it. It then opens the directory with "r", because Linux does not open a directory for writing, calls `sync()`, and closes it. `flushGate` fsyncs each dirty, unpoisoned directory under the root, bottom up, and stops at the first failure. A failed or timed-out directory sync poisons that directory until the Engine restarts (O-5). A copy beneath a poisoned directory fails with the EH-13 text "flush skipped: an earlier flush of this folder failed; restart the Engine to retry: <dir>". `syncFileOnly(path, size, deps?)` takes the size-based deadline, and `deps.deadlineMs` overrides it in tests. It touches neither the ledger nor the breaker (DV-29). `datasync()` is not used (DV-18). `FlushOutcome` has the four values in DV-30. The failure messages are the EH-13 texts: "flush failed: the drive did not confirm the file was written" for a failed file flush, "flush failed: the drive did not confirm the folder entry: <dir>" for a failed directory sync, and "flush timed out after <s> s: <path>" for a timeout. The recorded E4 value is `DIRECTORY_SYNC_BRANCH` = `"B"` (the E4 record's `verdict.directoryBranch`), so the directory sync uses Bun's `sync()`. Under `"A"` the directory sync would stay unwired until the gated task 4.24 builds the Helper path, and it would return `failed` with the EH-13 text "flush failed: the drive did not confirm the folder entry: <dir>".
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "durable drive copy"` passes.

  - [x] 1.10 Build `moveFile` with the cross-device flush
    - Requirements: R1.8. Design: Components (`moveFile` in `durable.ts`); DV-23 and O-4; Test seams.
    - Files: `src/util/durable.ts` (the file from 1.9, so this task runs after it).
    - Build: `moveFile(root, from, to, deps?)`. On the same device it calls `rename` and does not flush. On EXDEV it copies, calls `flushFile`, calls `flushGate`, and unlinks the source only after both return `ok`. A failed flush keeps the source.
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "durable drive copy"` still passes, and `git log -1 --format=%s` prints `feat(durability): add probe, dirty ledger, and flush primitives`, once the group commit for tasks 1.1 to 1.10 is made.

  - [x] 1.11 Add the destination root to the copy request
    - Requirements: R1.1, R2.7. Design: Components (`src/xfer/transport.ts`, `CopyRequest`).
    - Files: `src/xfer/transport.ts`.
    - Build: add `root: string` to `CopyRequest`, the destination root that the probes and the breaker use. The rsync version check (P14) changes in task 2.18.
    - Done when: `bun run typecheck` reports errors only in files that build a `CopyRequest`, and tasks 1.12 to 1.14 fix them.

  - [x] 1.12 Convert the adb pull path
    - Requirements: R1.1, R2.6, R2.7. Design: Per-file order, step 3; Components (`src/xfer/adb.ts`, `AdbTransport.copy`); EH-2.
    - Files: `src/xfer/adb.ts` (lines 53, 93, 106, and 176).
    - Build: delete the `ensureDir` call at line 53. Replace the `statSyncSafe` call at line 93 with `statDrive(req.root, req.destPath)`. A missing result gives `failed` with "does not exist", the design's text for a missing destination (design, Components, transports). An unreadable result gives `failed` with the EH-13 text "the destination could not be read; nothing was changed". Delete the two `fsyncPath` calls, at lines 106 and 176. The transport makes no flush and creates no directory.
    - Done when: `grep -n "fsyncPath\|ensureDir(" src/xfer/adb.ts` reports only the rsync lines, which task 1.13 changes.

  - [x] 1.13 Convert the rsync copy path
    - Requirements: R1.1, R2.6, R2.7. Design: Per-file order, step 3; Components (`RsyncTransport.copy`); DV-20 and O-2 (accepted: the rsync arguments do not change).
    - Files: `src/xfer/adb.ts` (lines 247, 264, and 273). The version check at line 216 is task 2.18.
    - Build: the same changes as 1.12, applied to the rsync copy. Delete the `ensureDir` call at line 247. Replace the `statSyncSafe` call at line 264 with `statDrive`. Delete the `fsyncPath` call at line 273.
    - Done when: `grep -n "fsyncPath\|ensureDir(\|statSyncSafe" src/xfer/adb.ts` prints nothing.

  - [x] 1.14 Convert the engine's copy path
    - Requirements: R1.1, R1.4, R1.5, R1.6, R1.7, R2.6, R2.7, R2.13. Design: Per-file order, steps 1 to 9; EH-1, EH-2, EH-7; Test seams; Notes N4, N22, N23.
    - Files: `src/xfer/engine.ts`.
    - Build: add `root` to `EngineOptions`, and an optional durability argument with `flushFile` and `flushGate` as defaults. In `processFile`, step 1 replaces the `statSyncSafe` call at line 221 with `statDrive`. A missing partial gives size 0. An unreadable partial fails the file, and the partial is not reset to zero. Step 2 calls `ensureDirTracked` before the copy, and a `failed` result fails the file (EH-7). Step 4 calls `flushFile` after a `copied` outcome. A failure or timeout records `failed` with the reason and keeps the phone copy. Step 5 calls `flushGate` on the destination directory. Step 6 is the existing `written` state at line 269. Step 7 replaces the `statSyncSafe` call at line 364 in `verifyFile` with `statDrive`. A missing result fails with "destination disappeared before verification" (design.md EH-2, Verify size row; the per-file table at step 7 gives the shorter "destination disappeared"). An unreadable result fails with the EH-13 text "the destination could not be read; nothing was changed". Steps 8 and 9 do not change. The step numbers in the engine's own comments count something else, so this task follows the design's table (Notes N22).
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "durability order"` passes, and `bun run test` passes.

  - [x] 1.15 Pass the root to the transfer call in the run loop
    - Requirements: R1.1. Design: Migration step 3.
    - Files: `src/serve/run-loop.ts` (the `runTransfer` call at line 188).
    - Build: add `root: destRoot` to the options. The call has no visible `await`, and its summary is used as a value. If the call is not awaited, add the `await` and name the fix in the commit body (Notes N16). Change nothing else.
    - Done when: `bun run typecheck` reports no error in `run-loop.ts`.

  - [x] 1.16 Pass the root in the engine's test helper
    - Requirements: R1.1. Design: Migration step 3.
    - Files: `test/verify-gate.test.ts` (the `engineFor` helper).
    - Build: `engineFor` adds `root: drive.root`.
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts` passes, and `git log -1 --format=%s` prints `fix(durability): flush each drive copy before recording it written`, once the group commit for tasks 1.11 to 1.16 is made.

  - [x] 1.17 Use the durable apply step in the dedupe move
    - Requirements: R1.8, R1.13. Design: Components (`src/dedupe/index.ts`, apply step); Migration step 3.
    - Files: `src/dedupe/index.ts` (lines 13, 449, and 450).
    - Build: replace `ensureDir(dirname(to))` with `ensureDirTracked(dirname(to), opts.destRoot)`. Replace `moveFile(target, to)` with `moveFile(opts.destRoot, target, to)`. A `failed` result refuses the move and gives its reason. Import both from `#lib/util/durable.ts`. `statSafe` stays imported from `fs.ts` until Phase 2.
    - Done when: `bun test --preload ./scripts/preload.ts test/dedupe.test.ts` passes.

  - [x] 1.18 Delete `fsyncPath`, `ensureDir`, and `moveFile` from `fs.ts`
    - Requirements: R1 (Migration steps 4 and 5). Design: Migration; the `src/util/fs.ts` header rewrite.
    - Files: `src/util/fs.ts`.
    - Build: delete `fsyncPath` (lines 25 to 37) and its bare `sync` fallback. Delete `ensureDir` and `moveFile`. Rewrite the header in six lines or fewer, pointing to `src/util/durable.ts`. Remove the stray comment above `ensureDir`. `statSafe`, `isDirectory`, `statSyncSafe`, and `diskSpace` stay for Phase 2.
    - Done when: `grep -rn "fsyncPath\|ensureDir\b\|moveFile" src` shows only `durable.ts` and its callers. `src/serve/doctor.ts` keeps its own `sync -f` until task 2.17.

  - [x] 1.19 Check the config writer
    - Requirements: R1.13. Design: Migration step 3 (this check applies only if the write can land under an archive root).
    - Files: `src/config/load.ts`, only if the check requires a change.
    - Build: read the directory creation near line 213. If the path can sit under `dest_root`, replace the plain `mkdir` with `ensureDirTracked`, and add a test to `test/verify-gate.test.ts` that the write creates its folders through the ledger. If it cannot, change no code, and say why in the commit body.
    - Done when: `bun run test` passes, and `git log -1 --format=%s` prints `refactor(durability): drop the sync -f fallback and move moveFile`, once the group commit for tasks 1.17 to 1.19 is made.

  - [x] 1.20 Checkpoint: Phase 1 durability core
    - Run `bun run test` and `bun run typecheck`, and fix what fails.
    - Run `grep -rn "console.log" src/xfer src/util`, and fix any match.
    - Run `git diff --stat master -- src/scan`, and fix any change to src/scan.
    - Done when: the three commands pass, with no match and no diff.

- [ ] 2. Phase 2: probes and bounded drive reads (R2.1 to R2.5, R2.8 to R2.12, R2.14, R2.15, Appendix A)
     This phase starts after checkpoint 1.20. Phase 1 already moved the copy-path and verify-path stats (R2.6, R2.7) and the flushes. This phase moves the other Appendix A call sites. Task 1.7 builds the breaker (R2.12), and this phase wires it to the run loop (2.27), the status frame (2.28 and 2.29), and Doctor (2.30). Tasks 2.31 to 2.33 then apply the approved mount rule, the Doctor bound, and the verify and purge deadlines. Every probe test uses a fake that never resolves and a 50 ms deadline. Each test is red until the task named in its Done when line is done.
  - [x] 2.1 Write the destination-check probe tests (red)
    - Requirements: R2.1, R2.3, R2.4. Design: Correctness Property 3 at the call sites; EH-2 (destination check row); EH-13; DV-4, DV-14.
    - Files: `test/units.test.ts` (new `destination check` describe block).
    - Tests first: a `findmnt` fake that never resolves, at a 50 ms deadline, gives `unreadable` with reason `timeout`. The destination's reason is the EH-13 text "the destination could not be read; nothing was changed". The status is neither `not-mounted` nor `ok`. A `df` fake that never resolves gives `unreadable`, never zero free space. Exit 1 with no output gives `not-mounted`. Exit 0 gives `mounted` with the filesystem type, the options, and the target. `checkDestination` with a timed-out `findmnt` returns `status: "unreadable"` and `ok: false`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "destination check"` fails, because `readMount`, `probeDestination`, and the async `checkDestination` do not exist yet.

  - [x] 2.2 Write the reconcile three-way tests (red)
    - Requirements: R2.5. Design: EH-2 (reconcile rows); Appendix A rows P9 and P10; DV-3, DV-28.
    - Files: `test/verify-gate.test.ts` (new `reconcile three-way` describe block).
    - Tests first: a `verified` row whose path sits under a regular file gets ENOTDIR, which is not ENOENT. Reconcile keeps that row `verified` and lists the path under `unreadable`. A missing destination is still marked `failed` with "missing". An unreadable partial is listed under `unreadable`, not under `orphanPartials`. The tests call `reconcile(journal, partialDir, root)`.
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "reconcile three-way"` fails.

  - [x] 2.3 Write the unreadable-trash tests (red)
    - Requirements: R2.11. Design: EH-2 (trash row); Correctness Property 3.
    - Files: `test/trash.test.ts` (new `unreadable trash` describe block).
    - Tests first: a trash root under a regular file gives `unreadable` set to "the trash could not be read" and `exists` false. The status never reads as "no trash".
    - Done when: `bun test --preload ./scripts/preload.ts test/trash.test.ts -t "unreadable trash"` fails.

  - [x] 2.4 Write the survivor-check tests (red)
    - Requirements: R2.9. Design: EH-2 (survivor row); EH-13; Notes N15.
    - Files: `test/dedupe.test.ts` (new `survivor check` describe block).
    - Tests first: a survivor path under a regular file is not counted as a survivor, and the deletion is refused with the EH-13 text "the destination could not be read; nothing was changed".
    - Done when: `bun test --preload ./scripts/preload.ts test/dedupe.test.ts -t "survivor check"` fails.

  - [x] 2.5 Write the purge and Doctor probe tests (red)
    - Requirements: R2.2, R2.3, R2.8, R2.10. Design: EH-2 (purge rows, Doctor rows); EH-13; Appendix A rows P12, P18, P19; DV-29.
    - Files: `test/serve.test.ts` (new `unreadable reads` describe block).
    - Tests first, each with a 50 ms deadline:
      - "dispatch purge refuses an unreadable drive copy": a `statDrive` fake that never resolves gives the refusal "drive copy unreadable" (R2.10). A missing drive copy keeps "the drive copy is gone — nothing was deleted".
      - "applyPurge refuses an unreadable drive copy": the same fake gives "drive copy unreadable" in `src/xfer/purge.ts`. A missing drive copy keeps "drive copy no longer exists".
      - "a directory in place of a drive copy is refused as not a file": the refusal is "the drive copy is not a file — nothing was deleted".
      - "Doctor destination row reads an unreadable root as could not be read" (row P18): a `statDrive` fake that never resolves prints "the destination could not be read", and never "does not exist". "does not exist" appears only for a missing path.
      - "Doctor mount check reads a timed-out findmnt as could not be read" (row P19): the probe prints "the mount check could not be read", never an unknown filesystem or a drive that is not read-only.
      - "a status request is answered while a purge probe never resolves" (R2.8): with the purge `statDrive` fake stalled, a status request on the dispatch path returns before the probe's 50 ms deadline. It is red until task 2.19 wires the probe.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "unreadable reads"` fails.

  - [x] 2.6 Write the planner-snapshot tests (red)
    - Requirements: R2.1, R2.2, R2.3, R2.8. Design: Components (`src/plan/plan.ts`: `snapshotDestinations`, `DriveEntryState`, `PlanOptions.space` and `onDisk`); "Behaviour of buildPlan with the snapshot"; DV-10, DV-11.
    - Files: `test/plan.test.ts` (new `planner snapshot` describe block).
    - Tests first: a `statDrive` fake that never resolves makes `snapshotDestinations` return each path as `unreadable` at the 50 ms deadline (row P17). An `unreadable` entry skips the file with "the path could not be read; not transferred over". An entry absent from the map is treated as unreadable and skipped with the same text. A `missing` entry is planned for transfer. An `ok` file of the same size is skipped, and a file of a different size is a collision, as before. `buildPlan` returns a value, not a promise.
    - Done when: `bun test --preload ./scripts/preload.ts test/plan.test.ts -t "planner snapshot"` fails.

  - [x] 2.7 Write the rsync-check and Doctor-flush deadline tests (red)
    - Requirements: R2.2, R2.3, R2.8. Design: Appendix A rows P14 and P15; EH-13 (`check failed: no answer within <s> s`); DV-29; Testing strategy (the `timeoutMs` seam).
    - Files: `test/units.test.ts` (new `deadline checks` describe block).
    - Tests first, each with a fake that never resolves and a 50 ms deadline:
      - `RsyncTransport.available` with a `--version` call that never resolves returns `failed` with the reason "check failed: no answer within 0.05 s". At the production deadline, `formatDeadline(3000)` returns "3 s", so the message reads "check failed: no answer within 3 s".
      - `syncFileOnly` with an fsync that never resolves returns `timeout`. `doctorFlushMessage` gives "check failed: no answer within 0.05 s". For a zero-byte file at the production deadline, `formatDeadline(flushDeadlineMs(0))` returns "30 s".
      - Neither check changes the breaker count. Row P14 uses a null root, and row P15 records no breaker count.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "deadline checks"` fails, because `formatDeadline`, `doctorFlushMessage`, and the async rsync check do not exist yet.

  - [x] 2.8 Make the existing destination-check tests pass a mounted probe
    - Requirements: R2.14. Design: Testing strategy, Layer 2 (design.md gives verify-gate.test.ts lines 459 and 466; the file has them at lines 464 and 471) and Layer 1 (the planner tests with an explicit destination probe); DV-14.
    - Files: `src/index/recovery.ts` (the current `checkDestination`), `src/plan/plan.ts` (`PlanOptions`), `test/verify-gate.test.ts`, `test/plan.test.ts`.
    - Build: add an optional `probe` argument to the current synchronous `checkDestination`. When it is given, the function judges that value and makes no read. Add an optional `destinationProbe` to `PlanOptions`, which `buildPlan` passes to the same judgement. Task 2.11 and task 2.13 replace these with the async signature and the snapshot.
    - Tests to update, each to pass a mounted probe whose `mount` target is `/mnt/archive` and whose `space` is the real free space:
      - In `test/verify-gate.test.ts`, the `destination pre-flight` describe block, "an empty plan is never refused for lack of space" (line 464) and "a plan that cannot fit is still refused" (line 471).
      - In `test/plan.test.ts`, the `planFor` helper (line 62) and every test that calls it: in `the plan reads the destination, not only the journal`, "a file that is not on the drive yet is queued, under the same folder it has on the phone", "a file already at the destination with the same size is skipped", "an interrupted copy this journal knows about is queued, so it can resume", "a different-sized file that no run claims is a collision, not an overwrite", "a file this journal recorded as failed is retried, not trusted because the size matches", and "every file in every folder is still accounted for"; and in `a file removed from the pull by hand`, "is still planned, marked excluded, and never queued" and "is not confused with a file that is already on the drive".
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "destination pre-flight"` and `bun test --preload ./scripts/preload.ts test/plan.test.ts` show the same results as before this task, with no test failing for a reason other than the new seam.

  - [x] 2.9 Add `readMount` to `src/util/fs.ts`
    - Requirements: R2.2, R2.3. Design: Components (`readMount`, `MountState`); DV-4.
    - Files: `src/util/fs.ts`.
    - Build: `readMount(spawn, path, timeoutMs = 3000)` runs `findmnt -rno FSTYPE,OPTIONS,TARGET --target <path>`. A `TIMEOUT` signal gives `unreadable`. Exit 1 with no output gives `not-mounted`. Any other failure gives `unreadable`. Success gives `mounted` with the filesystem type, the options, and the target. Escaped spaces in the fields are unescaped. `mountOptions` in volumes.ts stays until task 2.10.
    - Done when: the `readMount` examples in the `destination check` block pass, which task 2.1 names. The `checkDestination` examples stay red until task 2.11.

  - [x] 2.10 Move volume discovery onto `readMount`
    - Requirements: DV-4. Design: Components (`readMount`); Notes N8 (volume discovery is out of scope).
    - Files: `src/device/volumes.ts`.
    - Build: delete `mountOptions`. Call `readMount(spawn, mountPoint, 5_000)` where the call sits at line 234. Volume discovery keeps its 5-second bound. Keep the output shape.
    - Done when: `bun test --preload ./scripts/preload.ts test/volumes.test.ts` passes, and `grep -n "mountOptions" src` prints nothing.

  - [x] 2.11 Make the destination check async, split into a probe and a judgement
    - Requirements: R2.1, R2.3, R2.4. Design: Components (`probeDestination`, `judgeDestination`, `checkDestination`, `DestinationCheck` with `status`); DV-14; Notes N2.
    - Files: `src/index/recovery.ts` (`checkDestination` at line 157, and the `findmnt` call at line 162).
    - Build: `probeDestination(spawn, destRoot)` reads the mount with `readMount` and the free space with `diskSpaceAsync`, each under its own 3-second deadline. It makes no decision. `judgeDestination(probe, plannedBytes, headroom)` is pure. It keeps the existing reasons for a full disk and a read-only mount. For any unreadable read, it returns `status: "unreadable"`, `ok: false`, and the EH-13 text "the destination could not be read; nothing was changed" (R2.4). `checkDestination(spawn, destRoot, plannedBytes, headroom)` runs the probe and then the judgement. It replaces the optional `probe` argument from task 2.8. `isReadOnlyMount` stays. Update the two calls in `test/verify-gate.test.ts` that task 2.8 changed, to pass a fake spawn that reports a mounted target.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "destination check"` passes the examples that task 2.1 names, except the root-filesystem example, which task 2.31 adds. `bun run typecheck` reports errors only in `src/plan/plan.ts` and `src/serve/run-loop.ts`, which tasks 2.13 and 2.14 fix.

  - [x] 2.12 Give reconcile a root and three-way results
    - Requirements: R2.5, R2.2. Design: Components (`reconcile`, `RecoveryReport.unreadable`); EH-2; DV-3, DV-28.
    - Files: `src/index/recovery.ts` (the same file as task 2.11, so this task runs after it).
    - Build: `reconcile(journal, partialDir, root)`. Replace each `statSyncSafe` call (lines 82 and 102) with `statDrive(root, path)`. A `missing` verified row is failed with "missing", as now. An `unreadable` verified row stays `verified` and is listed in `unreadable`. An unreadable partial is listed in `unreadable`, not in `orphanPartials`. `RecoveryReport` gains `unreadable: string[]`, and `EMPTY_REPORT` sets it to an empty list.
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "reconcile three-way"` passes.

  - [x] 2.13 Make the planner take a snapshot
    - Requirements: R2.1, R2.8. Design: Components (`src/plan/plan.ts`: `destinationsFor`, `snapshotDestinations`, `PlanOptions.space` and `onDisk`); "Behaviour of buildPlan with the snapshot"; DV-10, DV-11; Notes N2.
    - Files: `src/plan/plan.ts` (`PlanOptions` near line 63, the `statSync` at line 168, and the `checkDestination` call at line 228), and the `planFor` helper in `test/plan.test.ts`.
    - Build: add `destinationsFor(candidates, destRoot)` and `snapshotDestinations(root, destPaths)`. The snapshot runs `statDrive` for each path, each under its own 3-second deadline, and callers await it. `PlanOptions.space` replaces the `destinationProbe` from task 2.8, and `buildPlan` judges it with its own `bytesTotal` through `judgeDestination`. `buildPlan` keeps the warning text, reads `onDisk` instead of calling `statSync`, and stays synchronous. The `planFor` helper passes `space` and `onDisk` in place of the 2.8 argument.
    - Done when: `bun test --preload ./scripts/preload.ts test/plan.test.ts` passes.

  - [x] 2.14 Switch the run path to the snapshot and the async probe
    - Requirements: R2.1, R2.4, R2.8. Design: Components (`src/serve/run-loop.ts`); DV-10.
    - Files: `src/serve/run-loop.ts` (the `reconcile` call near line 147, the plan near line 155, and the check near line 164).
    - Build: pass `destRoot` to `reconcile`. After `gather`, call `destinationsFor`, `snapshotDestinations`, and `probeDestination`, awaiting each, and then call `buildPlan`. After planning, call `judgeDestination` with `planResult.bytesTotal`. A result that is not `ok` throws the existing precondition error. That error covers `unreadable` too.
    - Done when: `bun run typecheck` reports no error in `src/serve/run-loop.ts`.

  - [x] 2.15 Switch the plan action to the snapshot
    - Requirements: R2.1, R2.8. Design: Components (`src/serve/dispatch.ts`, the plan action near line 586); DV-10.
    - Files: `src/serve/dispatch.ts` (lines 585 to 590).
    - Build: the plan action calls `destinationsFor`, awaits `snapshotDestinations` and `probeDestination`, and then calls `buildPlan`.
    - Done when: `bun run typecheck` reports no error in `src/serve/dispatch.ts`, `bun test --preload ./scripts/preload.ts test/plan.test.ts test/verify-gate.test.ts` passes, and `git log -1 --format=%s` prints `fix(probes): report an unreadable drive read as unreadable`, once the group commit for tasks 2.8 to 2.15 is made.

  - [x] 2.16 Move the Doctor destination block to the probes
    - Requirements: R2.2, R2.3, R2.5, R2.8. Design: Components (`src/serve/doctor.ts`, lines 160 to 178); DV-12 and O-1 (3 seconds); DV-13; EH-13.
    - Files: `src/serve/doctor.ts` (lines 160 to 178).
    - Build: the destination block takes its spawn and stat functions as parameters, so the tests in task 2.5 can pass fakes. Replace `isDirectory` at line 162 with `statDrive(destRoot, destRoot)`. A `missing` result prints "does not exist". An `unreadable` result prints "the destination could not be read", with the failure mark. Replace `diskSpace` at line 171 with `diskSpaceAsync(spawn, destRoot)`, under its 3-second deadline. The `probeFstype` and `isReadOnly` calls keep their child-process form for now, with a 3-second bound in place of the 5-second bound. Task 2.32 moves them to `readMount`.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "Doctor destination row reads an unreadable root"` passes. The test checks that the row prints "could not be read" for an unreadable root, prints "does not exist" only for a missing path, and that `grep -n "isDirectory" src/serve/doctor.ts` shows no call at line 162.

  - [x] 2.17 Move the Doctor walk check and the P15 flush to the probes
    - Requirements: R2.2, R2.3, R2.8. Design: Components (`src/serve/doctor.ts`, lines 244 and 457); DV-29; EH-13.
    - Files: `src/util/probe.ts` (`formatDeadline`), `src/serve/doctor.ts` (lines 244 and 457).
    - Build: add `formatDeadline(ms)` to `src/util/probe.ts`. It returns the seconds with up to two decimals and the unit " s", so 3000 gives "3 s", 50 gives "0.05 s", and 30000 gives "30 s". At line 244, `statDrive` replaces `isDirectory` in the walk's readiness check. An unreadable destination skips the walk and prints "the destination could not be read". At line 457, `syncFileOnly(tmp, size)` replaces `Bun.spawnSync(["sync", "-f", tmp])`, under `flushDeadlineMs(size)`. Add `doctorFlushMessage(outcome)`, a pure function. A timeout gives "check failed: no answer within <s> s", with `<s>` from `formatDeadline`. The message is never "healthy".
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "deadline checks"` passes its Doctor-flush example, and `grep -n 'sync", "-f"' src/serve/doctor.ts` prints nothing.

  - [x] 2.18 Make the rsync version check async (row P14)
    - Requirements: R2.2, R2.3, R2.8. Design: Appendix A row P14; Components (`Transport.available`, `TransportVerdict`); RK-17.
    - Files: `src/xfer/transport.ts` (the `available` signature and `TransportVerdict`), `src/xfer/adb.ts` (`RsyncTransport.available`, line 215), and the caller that awaits `available`.
    - Build: `available(deviceId)` returns `Promise<TransportVerdict>`. It runs `rsync --version` through `realSpawn` under `probe(null, ...)`, with a 3-second deadline, and the `RsyncTransport` constructor takes optional `spawn` and `timeoutMs` for the test. A timeout gives `failed` with the reason "check failed: no answer within 3 s", using `formatDeadline`. A missing binary gives `absent`. A version that answers gives `available`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "deadline checks"` passes its rsync example, and `bun run typecheck` reports no error in `src/xfer/adb.ts`.

  - [x] 2.19 Make the purge check in dispatch use the probe and the root
    - Requirements: R2.10. Design: Components (`withFreshDriveCopies`, dispatch line 264, and its call at line 876); EH-2 (purge row); Notes N24.
    - Files: `src/serve/dispatch.ts` (lines 264 to 275 and the call at line 876).
    - Build: `withFreshDriveCopies(plan, root)` calls `statDrive(root, path)`. `missing` keeps "the drive copy is gone — nothing was deleted". `unreadable` refuses with "drive copy unreadable" (R2.10). A directory refuses with "the drive copy is not a file — nothing was deleted". The call at line 876 passes the destination root.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "dispatch purge refuses an unreadable drive copy"` passes.

  - [x] 2.20 Make the survivor check use the probe
    - Requirements: R2.9. Design: Components (`src/dedupe/index.ts`, the survivor check at line 429); EH-2 (survivor row); EH-13; Notes N15.
    - Files: `src/dedupe/index.ts` (line 429).
    - Build: replace `statSafe` with `statDrive(opts.destRoot, other.path)`. Only `ok` counts as a survivor. A `missing` or `unreadable` result does not count, and the deletion is refused. An unreadable survivor is refused with the EH-13 text "the destination could not be read; nothing was changed".
    - Done when: `bun test --preload ./scripts/preload.ts test/dedupe.test.ts -t "survivor check"` passes.

  - [x] 2.21 Apply the probe to the applied purge
    - Requirements: R2.10. Design: Appendix A (row P12 covers only dispatch); DV-11; Notes N7.
    - Files: `src/xfer/purge.ts` (the existence check at line 151 in `applyPurge`, and the options type).
    - Build: add `root` to the purge options. Replace `Bun.file(...).exists()` with `statDrive`. `missing` keeps "drive copy no longer exists". `unreadable` refuses with "drive copy unreadable" (R2.10). A directory refuses with "the drive copy is not a file — nothing was deleted". The verify read at line 82 is task 2.33.
    - Done when: `bun run typecheck` reports errors only at the call site that task 2.22 fixes.

  - [x] 2.22 Pass the root to the applied purge
    - Requirements: R2.10. Design: Notes N24.
    - Files: `src/serve/dispatch.ts` (the `applyPurge` call site).
    - Build: the call passes the destination root that task 2.21 added to the options.
    - Done when: `bun run typecheck` passes.

  - [x] 2.23 Make the trash listing report an unreadable root
    - Requirements: R2.11. Design: Components (`src/dedupe/trash.ts`, `TrashStatus.unreadable`); EH-2 (trash row).
    - Files: `src/dedupe/trash.ts` (`TrashStatus` at line 25, and the `stat` call at line 83).
    - Build: `readTrash` calls `statDrive(destRoot, root)`. `missing` keeps `exists: false`. `unreadable` sets `unreadable` to "the trash could not be read" and keeps `exists: false`. It never reports "no trash" for an unreadable root. `emptyTrash` keeps its `lstat` and containment checks.
    - Done when: `bun test --preload ./scripts/preload.ts test/trash.test.ts -t "unreadable trash"` passes.

  - [x] 2.24 Wrap the trash free-space reads with the probe (row P4)
    - Requirements: R2.2, R2.3. Design: Appendix A row P4; Components (`diskSpaceAsync`, 3-second deadline).
    - Files: `test/serve.test.ts` (new test, first), `src/serve/dispatch.ts` (the two reads near lines 1118 and 1120).
    - Tests first: "trash emptying refuses when free space cannot be read". A free-space read that never resolves, at a 50 ms deadline, makes trash emptying refuse with the EH-13 text "the destination could not be read; nothing was changed", and it deletes nothing.
    - Build: wrap each `diskSpaceAsync` read with `probe(destRoot, ...)` at 3 seconds. A timed-out read refuses before any deletion.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "trash emptying refuses"` passes.

  - [x] 2.25 Delete `diskSpace` and `statSyncSafe`
    - Requirements: R2 (Migration step 5). Design: Migration step 5.
    - Files: `src/util/fs.ts`.
    - Build: check with grep that no caller of either function remains. Then delete `diskSpace` (lines 44 to 62) and `statSyncSafe` (lines 147 to 159). Keep `statSafe` and `isDirectory`.
    - Done when: `grep -rn "statSyncSafe\|diskSpace(" src` prints nothing, `bun run typecheck` passes, and `git log -1 --format=%s` prints `fix(probes): refuse deletes and listings that cannot be read`, once the group commit for tasks 2.16 to 2.25 is made.

  - [x] 2.26 Write the breaker-run tests (red)
    - Requirements: R2.12. Design: EH-3; Data models (`breaker`); EH-13.
    - Files: `test/verify-gate.test.ts` (new `breaker run` describe block), `test/serve.test.ts` (one example in `unreadable reads`).
    - Tests first: a breaker that trips during a run stops new files, and the run summary carries the EH-13 text "the archive drive stopped answering; restart the Engine after checking the drive". A tripped breaker makes `flushFile` and `flushGate` return `refused`. "Doctor destination row reports a tripped breaker": with the breaker tripped, the destination row prints the same EH-13 text.
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "breaker run"` fails.

  - [x] 2.27 Stop taking new files when the breaker trips
    - Requirements: R2.12. Design: EH-3; Components (`breakerFor`).
    - Files: `src/xfer/engine.ts` (the per-file loop in `runTransfer`).
    - Build: `runTransfer` takes no new file once `breakerFor(root).tripped` is true. It ends the run as failed with the EH-13 breaker text.
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "breaker run"` passes.

  - [x] 2.28 Add the drive-unreadable field to the status schema
    - Requirements: R2.12. Design: EH-3; Notes N13.
    - Files: `src/serve/protocol.ts` (the status schema).
    - Build: add an optional `driveUnreadable` boolean to the status schema.
    - Done when: `bun run typecheck` passes.

  - [x] 2.29 Report the breaker in the status frame
    - Requirements: R2.12. Design: EH-3; Notes N13.
    - Files: `src/serve/dispatch.ts` (the `ctx.frames.status` payload near line 470).
    - Build: set `driveUnreadable` to true when a breaker on the destination root is tripped.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve-contract.test.ts` passes.

  - [x] 2.30 Report the breaker in Doctor
    - Requirements: R2.12. Design: EH-3.
    - Files: `src/serve/doctor.ts` (the destination block from task 2.16).
    - Build: while the breaker is tripped, the destination row prints the EH-13 breaker text "the archive drive stopped answering; restart the Engine after checking the drive".
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "Doctor destination row reports a tripped breaker"` passes, and `git log -1 --format=%s` prints `feat(probes): stop drive work after three deadline timeouts`, once the group commit for tasks 2.26 to 2.30 is made.

  - [x] 2.31 Refuse a root-filesystem destination (R2.14)
    - Requirements: R2.14. Design: Components (destination check, the root-filesystem rule); DV-14; RK-10; Notes N9.
    - Files: `test/units.test.ts` (the root-filesystem examples in `destination check`), `src/index/recovery.ts` (`judgeDestination`).
    - Tests first: a mount whose target is `/` is refused, with `status` `refused`, `ok` false, and the R2.14 text "the archive drive is not mounted". A mount whose target is not `/` passes. The judgement covers both the plan path and the run path.
    - Build: `judgeDestination` refuses a target of `/`. An exit-1 `not-mounted` result keeps its current reason text, "destination is not on a mounted filesystem", as the design's destination-check section states.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "destination check"` passes every example.

  - [x] 2.32 Move Doctor's findmnt probes onto `readMount` at 3 seconds (row P19)
    - Requirements: R2.2, R2.3. Design: Appendix A row P19; Components (`readMount`); Doctor section; DV-12; O-1.
    - Files: `src/serve/doctor.ts` (`probeFstype` and `isReadOnly`, lines 390 to 410, and their call sites at lines 171 and 172).
    - Build: `probeFstype` and `isReadOnly` each call `readMount(spawn, destRoot, 3000)` under `probe()`. The 3-second deadline is also the kill timer, and the 5-second kill timer is removed. A timeout prints "the mount check could not be read", and it never prints an unknown filesystem or a drive that is not read-only.
    - Done when: `bun test --preload ./scripts/preload.ts test/serve.test.ts -t "Doctor mount check reads a timed-out findmnt"` passes.

  - [x] 2.33 Set the flush deadline on the verify read and the purge read (row P20)
    - Requirements: R2.2, R2.3, R2.7, R2.10. Design: Appendix A row P20; DV-21; RK-8; Per-file order, step 8.
    - Files: `test/verify-gate.test.ts` (two new tests, first), `src/xfer/engine.ts` (`verifyFile`, the hash read at line 374 and the message at line 376), `src/xfer/purge.ts` (the verify read near line 82).
    - Tests first, with a 50 ms seam in the engine and purge options (`hashDeadlineMs`):
      - "verify read deadline fails the file with the drive-copy text": a hash read that never resolves fails the file with "the drive copy could not be read", and the phone copy is kept.
      - "purge read deadline refuses with drive copy unreadable": a hash read that never resolves refuses the purge item with "drive copy unreadable".
      - "read deadline: verify-size stat fails the file with the destination text" (R2.7): a `statDrive` fake that never resolves for the verify-size stat fails the file with "the destination could not be read; nothing was changed". This checks code from task 1.14, so it passes when written. It is the one test in Phase 2 that does not fail first.
    - Build: in `verifyFile`, wrap `sha256File` on the drive copy in `probe(root, ...)` with `flushDeadlineMs(size)`. A null result or a timeout fails the file with "the drive copy could not be read" (R2.3). The line-376 message changes to that text. In `src/xfer/purge.ts`, wrap the verify read of `row.dest_path` with `flushDeadlineMs(row.size)`. A null result or a timeout refuses with "drive copy unreadable". A timeout counts toward the breaker through `probe()`. `src/util/hash.ts` does not change.
    - Done when: `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "read deadline"` passes all three tests.

  - [x] 2.34 Checkpoint: Phase 2 probes
    - Run `bun run test` and `bun run typecheck`, and fix what fails.
    - Run `grep -rn "statSyncSafe\|diskSpace(" src`, and fix any match.
    - Done when: both commands pass, and the grep prints nothing.

- [ ] 3. Phase 3: whole-segment exclusions and the CI checks (R3, R6)
     This phase starts after checkpoint 2.34. The exclusion fix changes both walkers, and each walker has its own test. The CI changes come after the code, so the frozen check and the Helper build run against the fixed walker.
  - [x] 3.1 Write the Rust exclusion tests (Property 4, red)
    - Requirements: R3.1, R3.3, R3.4, R3.5. Design: Correctness Property 4; Testing strategy, Layer 3; DV-26.
    - Files: `crates/portage-scan/src/walk.rs` (the `#[cfg(test)]` module).
    - Tests first: a tree with `Videos/Android/data/com.app/cache.bin` and `Videos/MyAndroid/data/com.app/keep.mkv`, and the exclusion `Android/data`. The walk returns `Videos/MyAndroid/data/com.app/keep.mkv` and does not return the first file. A name without a slash excludes a directory with that name at any depth. Property 4 uses a seeded generator in the test module, with no new crate. It compares `excluded` with a reference matcher on random relative paths, runs at least 100 iterations, and prints the seed on failure.
    - Done when: `cd crates/portage-scan && cargo test exclusion` fails on the `MyAndroid` case.

  - [x] 3.2 Fix the Rust walker's exclusion match
    - Requirements: R3.1, R3.4. Design: Components (`walk.rs`, `tail_matches`); C3.
    - Files: `crates/portage-scan/src/walk.rs` (`excluded` at line 121).
    - Build: a pattern with a slash excludes a directory only when its segments equal the last segments of `trail` followed by `name`. Compare by index, without cloning the trail, and keep the signature. A pattern without a slash matches the directory name exactly.
    - Done when: `cd crates/portage-scan && cargo test exclusion` passes, and `cargo clippy --all-targets -- -D warnings` passes.

  - [x] 3.3 Write the TypeScript exclusion tests (Property 4, red)
    - Requirements: R3.2, R3.3, R3.4. Design: Correctness Property 4; Testing strategy, Layer 1; DV-27.
    - Files: `test/scan-io.test.ts` (the `isExcludedRelative` block near line 80).
    - Tests first: the named pair, `Videos/Android/data/...` and `Videos/MyAndroid/data/...`. A seeded property test over random paths compares `isExcludedRelative` with the same reference matcher that task 3.1 uses.
    - Done when: `bun test --preload ./scripts/preload.ts test/scan-io.test.ts -t "isExcludedRelative"` fails on the `MyAndroid` pair.

  - [x] 3.4 Fix the TypeScript matcher
    - Requirements: R3.2, R3.4. Design: Components (`src/dedupe/scan-io.ts`, `isExcludedRelative`, same signature).
    - Files: `src/dedupe/scan-io.ts` (lines 83 to 105).
    - Build: a pattern with a slash matches an ancestor only when the ancestor equals the pattern, or ends with `/` followed by the pattern. A pattern without a slash still matches a directory name exactly.
    - Done when: `bun test --preload ./scripts/preload.ts test/scan-io.test.ts -t "isExcludedRelative"` passes.

  - [x] 3.5 Update the parity fixture, the DV-27 assertion, and the Helper guard
    - Requirements: R3.6, R6.6, R6.7. Design: Testing strategy, Layer 4 (parity suites); DV-27.
    - Files: `test/scan-io.test.ts` (the fixture at lines 33 to 60, the parity assertions at lines 119 to 121, and a new guard test).
    - Build: add `MyAndroid/data/com.app/keep.mkv` to the fixture. The check on `entry.includes("Android/data")` becomes a check on consecutive whole segments, and the expected count rises from 6 to 7. Add a guard test that fails when `PORTAGE_REQUIRE_SCANNER` is `1` and no Helper is found, so that a missing Helper fails the job instead of skipping the parity tests. The built-in default test keeps its skip.
    - Done when: with a built Helper (`bun run build:scanner`), `bun test --preload ./scripts/preload.ts test/scan-io.test.ts` passes. With `PORTAGE_REQUIRE_SCANNER=1` and no Helper, every parity test fails, and none skips.

  - [x] 3.6 Write the frozen-check and range-start tests (red)
    - Requirements: R6.1, R6.2, R6.4. Design: CI changes (frozen check, `range-start.sh`); Testing strategy, Layer 4; O-15; Notes N17.
    - Files: `test/units.test.ts` (new `ci frozen check` describe block, which creates temporary git repositories with `mkdtemp`).
    - Tests first: (1) a committed change to `src/scan` makes the check fail. (2) A committed change to `src/xfer` passes. (3) When the base moves on after the branch point, the check judges only the branch's own changes (R6.4). (4) `range-start.sh` prints `BASE_SHA` when that is set, prints `BEFORE` when it is set and not all zeros, and otherwise prints the merge-base with `origin/master`, or the root commit when that fails.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "ci frozen check"` fails, because `scripts/range-start.sh` does not exist yet.

  - [x] 3.7 Add `scripts/range-start.sh`
    - Requirements: R6.1, R6.4. Design: CI changes; O-15.
    - Files: `scripts/range-start.sh` (new, executable).
    - Build: print the value that the commits job computes inline today, by the same rule and in the same order: `BASE_SHA`, then `BEFORE` when it is not all zeros, then the merge-base with `origin/master`, then the root commit.
    - Done when: `bash scripts/range-start.sh` prints a commit id in this repository, and `bun test --preload ./scripts/preload.ts test/units.test.ts -t "ci frozen check"` passes.

  - [x] 3.8 Change the CI workflow
    - Requirements: R6.1 to R6.7. Design: CI changes (commits job, engine job, frozen check; rust and scanner jobs unchanged).
    - Files: `.github/workflows/ci.yml` (the `commits` job, and the Test and frozen-files steps of the `engine` job).
    - Build: (a) The `commits` job calls `./scripts/range-start.sh` in place of its inline logic. (b) The `engine` job gets the job-level environment `PORTAGE_SCAN: ${{ github.workspace }}/dist/portage-scan` and `PORTAGE_REQUIRE_SCANNER: "1"`, a `dtolnay/rust-toolchain@stable` step, a `swatinem/rust-cache@v2` step with `workspaces: crates/portage-scan -> target`, and a `bun run build:scanner` step before the Test step. (c) The frozen step follows the shell in design.md's CI changes: `range_start` from the script, `base` from `git merge-base`, then `git diff --name-only "$base" HEAD -- src/scan`, with the error text that design.md gives. The `git status --porcelain` step is removed.
    - Done when: `/home/node/.local/bin/actionlint .github/workflows/ci.yml` exits 0, `grep -n 'build:scanner\|bun run test' .github/workflows/ci.yml` shows the build line before the test line inside the engine job (R6.5), and `bun test --preload ./scripts/preload.ts test/units.test.ts -t "ci frozen check"` still passes.

  - [x] 3.9 Checkpoint: Phase 3 exclusions and CI
    - Run `bun run test`, and fix what fails.
    - In `crates/portage-scan`, run `cargo test`, `cargo clippy --all-targets -- -D warnings`, and `cargo fmt --check`, and fix what fails.
    - Done when: each command passes.

- [ ] 4. Phase 4: measured Helper moves (R4, R1.14 branch A)
     Tasks 4.1 to 4.3 are required. Tasks 4.2 and 4.3 produce the records that decide the gates. Tasks 4.4 to 4.24 are gated and optional, and each carries `*`. Each gated test reads its gate's record and fails unless that record allows the gate, so no Helper code can pass its gate without a committed record (R4.11). Task 4.25 is a required checkpoint. Tasks 4.26 and 4.27 are required and come after the checkpoint. They name the path that ran in the TypeScript results (R4.10, R4.13), which no required task covered before. The owner's step to enable a gated task is in the Notes owner checklist (N30).
  - [x] 4.1 Build the bench-only Rust example for E2 and E3
    - Requirements: R4.1, R4.2, R4.3. Design: Measurement plan (E2, E3; Rust candidates in `examples/fsbench.rs`).
    - Files: `crates/portage-scan/examples/fsbench.rs` (new). It uses the crate's existing libc dependency and adds no crate.
    - Build: three candidates, each printing one JSON line per run. The removal candidate uses std `remove_dir_all` on a fixture. The move candidate uses `renameat` with two directory handles. The stat candidate makes one group call over all moved paths. The example is for benchmarks only.
    - Done when: `cd crates/portage-scan && cargo clippy --all-targets -- -D warnings` passes, and `cargo run --release --example fsbench -- --help` prints the usage.

  - [~] 4.2 Write the E2 script, run it on the archive drive, and commit its record
    - Needs the archive drive mounted. Requirements: R4.1, R4.12. Design: Measurement plan (E2, protocol); O-12.
    - Files: `scripts/bench/e2-trash.ts` (new), `bench/results/<date>-e2-trash.json` (new, committed).
    - Build: on the deep and shallow fixtures, each with 1,000 files of 4,096 bytes (4,096,000 bytes per fixture), time the TypeScript removal (Bun `rm` with recursive set) and the Rust candidate from 4.1. Run five times per path, alternating the order between runs. Each run builds a new fixture and times only the removal. Call `mountGuard` before any write. The verdict's `result` is `pass` when the deep ratio, the TypeScript median over the Helper median, is at least 2.0, and the shallow ratio, the Helper median over the TypeScript median, is at most 1.10. Otherwise it is `fail`.
    - Done when: `ls bench/results/*-e2-trash.json` lists one record, its `verdict.result` is `pass` or `fail`, and `git log -1 --format=%s` prints `test(bench): record E2 trash removal on the archive drive`.

  - [~] 4.3 Write the E3 script, run it on the archive drive, and commit its record
    - Needs the archive drive mounted. Requirements: R4.2, R4.3, R4.12. Design: Measurement plan (E3); O-11.
    - Files: `scripts/bench/e3-move-stat.ts` (new), `bench/results/<date>-e3-move-stat.json` (new, committed).
    - Build: the same fixtures and run rules as task 4.2. The move takes every file into a trash day folder, once with TypeScript `rename` and once with the Rust `renameat` candidate. The stat times TypeScript `stat` for each path, and the Helper stat as one group call. The move and the stat each get a verdict, `verdict.move.result` and `verdict.stat.result`, because R4.2 and R4.3 measure them separately. Call `mountGuard` before any write.
    - Done when: `ls bench/results/*-e3-move-stat.json` lists one record with both verdicts, and `git log -1 --format=%s` prints `test(bench): record E3 move and stat on the archive drive`.

  - [~]\* 4.4 Gate E2 passes: write the Property 6 tests (red)
    - Gate: E2 passes (`verdict.result` is `pass` in the E2 record). Requirements: R4.4, R4.5, R4.6, R4.10. Design: Correctness Property 6; Conditional Helper design (containment, Rust rules).
    - Files: `crates/portage-scan/src/main.rs` (the test module of this existing file).
    - Tests first: Property 6 as a seeded generator over relative paths with `..`, absolute paths, a symbolic link as a parent, names with separators, and empty names. A path is removed only when every parent resolves inside the trash root. Each refused path gets a `refused` result and no filesystem call. The result count equals the input count, in order. A symbolic-link entry is unlinked, and its target stays. The test first reads `bench/results/*-e2-trash.json` and fails unless its `verdict.result` is `pass`.
    - Done when: `cd crates/portage-scan && cargo test containment` fails before task 4.6 is done.

  - [~]\* 4.5 Gate E2 passes: build `sys.rs` for the trash path
    - Gate: E2 passes. Requirements: R4.5. Design: Conditional Helper design (module layout, Rust rules).
    - Files: `crates/portage-scan/src/sys.rs` (new).
    - Build: wrappers for `openat` with `O_DIRECTORY | O_NOFOLLOW`, `fstatat` with `AT_SYMLINK_NOFOLLOW`, `unlinkat`, and `close`. Every libc call is in this module. Each `unsafe` block has a `// SAFETY:` comment, and no `unwrap` appears outside tests.
    - Done when: `cd crates/portage-scan && cargo clippy --all-targets -- -D warnings` passes.

  - [~]\* 4.6 Gate E2 passes: build the parent walk in `remove.rs`
    - Gate: E2 passes. Requirements: R4.5, R4.6. Design: Containment: the parent walk (DV-15, O-8).
    - Files: `crates/portage-scan/src/remove.rs` (new).
    - Build: check the path lexically first (absolute, no `..`, under the root). Then open the root and walk each parent with `openat(O_DIRECTORY | O_NOFOLLOW)`. A symbolic-link component is refused. The final entry is handled through its verified parent: `fstatat` with `AT_SYMLINK_NOFOLLOW` decides the kind. A link or a file is removed with `unlinkat`. A directory is removed by a recursive walk that opens each child with `O_NOFOLLOW`. No path is looked up by name after the check.
    - Done when: `cd crates/portage-scan && cargo test containment` passes.

  - [~]\* 4.7 Gate E2 passes: add the `capabilities` and `remove` requests to `main.rs`
    - Gate: E2 passes. Requirements: R4.4. Design: Requests and responses (`remove`, `capabilities`); DV-16.
    - Files: `crates/portage-scan/src/main.rs` (after the test in task 4.4).
    - Build: `capabilities` returns `{ ok, version, commands }`. `remove` returns one result per path, with `removed`, `refused`, `missing` (ENOENT only), or `unreadable`, plus `files` and `bytes`. A rejected request exits with code 2 and carries `error`.
    - Done when: `cd crates/portage-scan && cargo test` passes, including a test that sends one `capabilities` line and reads the response.

  - [~]\* 4.8 Gate E2 or E3 passes: write the Helper client tests (red)
    - Gate: E2 passes, or E3 passes for the move or the stat (`verdict.move.result` or `verdict.stat.result` is `pass`). Requirements: R4.10, R4.11, R4.13. Design: Routing and capability; EH-11.
    - Files: `test/units.test.ts` (new `helper client` describe block).
    - Tests first: a missing binary gives the TypeScript path, and the result names it. A failed capability query gives the TypeScript path, with its reason. A gate whose record is not `pass` never calls the binary, even when the binary exists. Each test reads the gate records of tasks 4.2 and 4.3 first.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "helper client"` fails.

  - [~]\* 4.9 Gate E2 or E3 passes: build `src/util/helper.ts`
    - Gate: E2 passes, or E3 passes for the move or the stat. Requirements: R4.10, R4.11, R4.13. Design: Routing and capability (`src/util/helper.ts`, new).
    - Files: `src/util/helper.ts` (new).
    - Build: a gate table with one boolean per operation (`remove`, `move`, `stat`). Each boolean is read from its record's verdict, and none is typed into the code. Before each command, the client sends `{"command":"capabilities"}` (DV-16). A failed query, a timeout, or a gate that is not `pass` sends the operation to TypeScript. Every result names the path that ran, `helper` or `typescript`, with the reason. The deadline and the kill come from `src/util/spawn.ts`.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "helper client"` passes.

  - [~]\* 4.10 Gate E2 passes: write the Property 9 tests (red)
    - Gate: E2 passes. Requirements: R4.9, R4.10, R4.13. Design: Correctness Property 9 (conditional); Testing strategy, Layer 1.
    - Files: `test/trash.test.ts` (new `equivalence` describe block).
    - Tests first: Property 9 as a seeded generator over trash trees and target lists. The TypeScript path and the Helper path return the same counts, bytes, and refusals, with the same paths and reasons (R4.9). Freed bytes differ by at most one 4,096-byte block per removed file.
    - Done when: `bun test --preload ./scripts/preload.ts test/trash.test.ts -t "equivalence"` fails.

  - [~]\* 4.11 Gate E2 passes: route trash deletion through the Helper
    - Gate: E2 passes. Requirements: R4.8, R4.9, R4.10, R4.13. Design: Components (`src/dedupe/trash.ts`, `emptyTrash`).
    - Files: `src/dedupe/trash.ts`.
    - Build: `emptyTrash` sends deletion through `helper.ts` when the `remove` gate is `pass`, and otherwise runs TypeScript. The result names the path that ran. The confirmation step and the pending record stay as they are (R4.8, C13).
    - Done when: `bun test --preload ./scripts/preload.ts test/trash.test.ts -t "equivalence"` passes.

  - [~]\* 4.12 Gate E3 passes for the move: write the move-command tests (red)
    - Gate: E3 passes for the move (`verdict.move.result` is `pass`). Requirements: R4.2, R4.5, R4.10, R1.8. Design: Requests and responses (`move`); Containment; DV-23.
    - Files: `crates/portage-scan/src/relocate.rs` (new; the test module is written first).
    - Tests first: a source outside the destination root is refused. A target outside the trash root is refused. A symbolic-link parent is refused. `EXDEV` returns `failed` with the reason "crosses devices". `createdDirs` lists new directories from the top down.
    - Done when: `cd crates/portage-scan && cargo test relocate` fails before task 4.14 is done.

  - [~]\* 4.13 Gate E3 passes for the move: add `renameat` and `mkdirat` to `sys.rs`
    - Gate: E3 passes for the move. Requirements: R4.2. Design: Module layout (`sys.rs`).
    - Files: `crates/portage-scan/src/sys.rs` (the file from task 4.5, so this task runs after it).
    - Build: wrappers for `renameat` and `mkdirat`. Each `unsafe` block has a `// SAFETY:` comment.
    - Done when: `cd crates/portage-scan && cargo clippy --all-targets -- -D warnings` passes.

  - [~]\* 4.14 Gate E3 passes for the move: build `relocate.rs`
    - Gate: E3 passes for the move. Requirements: R4.2, R4.5. Design: Requests and responses (`move`).
    - Files: `crates/portage-scan/src/relocate.rs`.
    - Build: the move command, with the containment checks that task 4.12 tests. It returns one `moved` or `failed` result per pair, and `createdDirs` in top-down order.
    - Done when: `cd crates/portage-scan && cargo test relocate` passes.

  - [~]\* 4.15 Gate E3 passes for the move: add the `move` request to `main.rs`
    - Gate: E3 passes for the move. Requirements: R4.2. Design: Module layout (`main.rs`).
    - Files: `crates/portage-scan/src/main.rs` (after task 4.7).
    - Build: the `move` request, with the same rejection behaviour as task 4.7.
    - Done when: `cd crates/portage-scan && cargo test` passes.

  - [~]\* 4.16 Gate E3 passes for the move: route the cross-folder move through the Helper
    - Gate: E3 passes for the move. Requirements: R4.2, R4.10, R1.8. Design: Components (`src/dedupe/index.ts`, apply step).
    - Files: `src/dedupe/index.ts` (the `moveFile` call in the apply step, after task 1.17).
    - Build: the move goes through `helper.ts` when the move gate is `pass`. A `crosses devices` result falls back to TypeScript `moveFile`, which flushes and gates the copy before it removes the source (R1.8). The result names the path that ran.
    - Done when: `bun test --preload ./scripts/preload.ts test/dedupe.test.ts` passes.

  - [~]\* 4.17 Gate E3 passes for the stat: write the group-stat tests (red)
    - Gate: E3 passes for the stat (`verdict.stat.result` is `pass`). Requirements: R4.3, R2.2, R2.9. Design: Requests and responses (`stat`); O-11.
    - Files: `crates/portage-scan/src/stat.rs` (new; the test module is written first).
    - Tests first: one request covers a group of paths and returns one result per path. The outcomes are `file`, `dir`, `missing` (ENOENT only), and `unreadable` (any other error). Each path has a 3-second deadline (O-11).
    - Done when: `cd crates/portage-scan && cargo test stat` fails before task 4.18 is done.

  - [~]\* 4.18 Gate E3 passes for the stat: build `stat.rs`
    - Gate: E3 passes for the stat. Requirements: R4.3. Design: Requests and responses (`stat`).
    - Files: `crates/portage-scan/src/stat.rs`.
    - Build: the group stat. It follows symbolic links, as `statDrive` does, and it uses std `fs::metadata`, so it makes no libc call.
    - Done when: `cd crates/portage-scan && cargo test stat` passes.

  - [~]\* 4.19 Gate E3 passes for the stat: add the `stat` request to `main.rs`
    - Gate: E3 passes for the stat. Requirements: R4.3. Design: Module layout (`main.rs`).
    - Files: `crates/portage-scan/src/main.rs` (after task 4.15).
    - Build: the `stat` request.
    - Done when: `cd crates/portage-scan && cargo test` passes.

  - [~]\* 4.20 Gate E3 passes for the stat: route the survivor stat through one group request
    - Gate: E3 passes for the stat. Requirements: R4.3, R4.7, R2.9. Design: Components (`src/dedupe/index.ts`, survivor check).
    - Files: `src/dedupe/index.ts` (the survivor check, after task 4.16).
    - Build: one Helper stat per group of candidates, never one process per file. Only `ok` counts as a survivor. The decision stays in TypeScript (R4.7).
    - Done when: `bun test --preload ./scripts/preload.ts test/dedupe.test.ts -t "survivor check"` passes.

  - [~]\* 4.21 Gate E4 branch A: write the fsync-command tests (red)
    - Gate: E4 branch A (`verdict.directoryBranch` is `"A"`). Requirements: R1.14, R4.10. Design: Requests and responses (`fsync`); Conditional Helper design; decided default 2.
    - Files: `crates/portage-scan/src/fsync.rs` (new; the test module is written first).
    - Tests first: a directory or a file target is synced with a standard file handle and `sync_all`, with no libc call. A target outside the root fails with "outside the archive root". A failed sync is `failed`. The test first reads `bench/results/*-e4-bun-sync.json` and fails unless its `directoryBranch` is `"A"`.
    - Done when: `cd crates/portage-scan && cargo test fsync` fails before task 4.22 is done.

  - [~]\* 4.22 Gate E4 branch A: build `fsync.rs`
    - Gate: E4 branch A. Requirements: R1.14. Design: Requests and responses (`fsync`).
    - Files: `crates/portage-scan/src/fsync.rs`.
    - Build: the fsync command, using `std::fs::File::open` and `sync_all`.
    - Done when: `cd crates/portage-scan && cargo test fsync` passes.

  - [~]\* 4.23 Gate E4 branch A: add the `fsync` request to `main.rs`
    - Gate: E4 branch A. Requirements: R1.14. Design: Module layout (`main.rs`).
    - Files: `crates/portage-scan/src/main.rs` (after task 4.19).
    - Build: the `fsync` request, with the same rejection behaviour as task 4.7.
    - Done when: `cd crates/portage-scan && cargo test` passes.

  - [~]\* 4.24 Gate E4 branch A: route directory fsyncs through the Helper
    - Gate: E4 branch A, meaning `verdict.directoryBranch` is `"A"` in the E4 record. That record holds `"B"`, so this task stays unbuilt. Requirements: R1.14, R4.10, R1 criterion 5. Design: Decided default 2; Components (`src/util/durable.ts`).
    - Files: `src/util/durable.ts` (the directory step in `flushFile` and `flushGate`, and the value of `DIRECTORY_SYNC_BRANCH`).
    - Build: under branch A, the directory sync calls the Helper `fsync` command, and `DIRECTORY_SYNC_BRANCH` stays `"A"`. A missing Helper makes the directory fsync `failed` with the EH-13 text "flush failed: the drive did not confirm the folder entry: <dir>", and the result names TypeScript as the path that ran.
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "recorded decisions"` passes, and `bun test --preload ./scripts/preload.ts test/verify-gate.test.ts -t "durable drive copy"` passes.

  - [~] 4.25 Checkpoint: Phase 4 gates
    - Run `bun run test` and `bun run typecheck`, and fix what fails.
    - In `crates/portage-scan`, run `cargo test` and `cargo clippy --all-targets -- -D warnings`, and fix what fails.
    - Done when: each command passes.
  - [x] 4.26 Write the tests that name the path that ran (red)
    - Requirements: R4.10, R4.13, R1.14. Design: Requirement 4, criterion 10; Components (`src/dedupe/trash.ts`, `src/dedupe/index.ts`, `src/util/durable.ts`); Testing strategy, Layer 1.
    - Files: `test/trash.test.ts` (new `path name` describe block), `test/dedupe.test.ts` (new `path name` describe block), `test/units.test.ts` (new `path name` describe block).
    - Tests first: (1) `emptyTrash` with no Helper returns a result whose `path` is `"typescript"`, with a `reason`. (2) The cross-folder move's apply step, on its copy-and-remove branch, returns `path: "typescript"`. (3) The survivor check returns `path: "typescript"` for each candidate. (4) `flushFile` returns `path: "typescript"` for its directory sync while `DIRECTORY_SYNC_BRANCH` is `"B"`. Each test fails until task 4.27 is done.
    - Done when: `bun test --preload ./scripts/preload.ts test/trash.test.ts -t "path name"`, `bun test --preload ./scripts/preload.ts test/dedupe.test.ts -t "path name"`, and `bun test --preload ./scripts/preload.ts test/units.test.ts -t "path name"` each fail, because no result carries a `path` field yet.
  - [~] 4.27 Name the path that ran in the TypeScript results (R4.10, R4.13)
    - Requirements: R4.10, R4.13, R1.14. Design: Decided default 3 (TypeScript path for Helper-backed operations); Components (`src/dedupe/trash.ts`, `src/dedupe/index.ts`, `src/util/durable.ts`).
    - Files: `src/dedupe/trash.ts` (the `emptyTrash` result), `src/dedupe/index.ts` (the apply step and the survivor check), `src/util/durable.ts` (the `FlushOutcome` values from `flushFile` and `flushGate`).
    - Build: each of these results gets a `path` field, `"helper"` or `"typescript"`, and a `reason` when the TypeScript path ran because the Helper was missing or its gate had not passed. Until tasks 4.11, 4.16, and 4.20 add Helper branches, every outcome names `"typescript"`. The directory sync outcome follows the recorded `DIRECTORY_SYNC_BRANCH`.
    - Done when: the tests from 4.26 pass, and `bun run typecheck` reports no error in these files.

- [ ] 5. Phase 5: type-only frame peek in the Desktop shell (R5)
     This phase has no gate. Its cargo runs need the sidecar placeholders that CI creates, and the WebKitGTK 4.1 development package (Notes N20, N21).
  - [~] 5.1 Write the frame-memory example tests (red)
    - Requirements: R5.2, R5.3, R5.4, R5.5. Design: Testing strategy, Layer 3 (frame memory); EH-12.
    - Files: `apps/desktop/src-tauri/src/engine.rs` (the `#[cfg(test)]` module).
    - Tests first: five examples. (1) A known type is remembered. (2) The last line of a type wins. (3) An unknown type is ignored. (4) A line that is not a JSON object is ignored. (5) `engine_status` returns the stored JSON unchanged.
    - Done when: `cd apps/desktop/src-tauri && cargo test frame_memory` fails, because `remember_frame` does not exist yet.

  - [~] 5.2 Write the frame-memory property test (Property 5, red)
    - Requirements: R5.1, R5.4, R5.5. Design: Correctness Property 5.
    - Files: `apps/desktop/src-tauri/src/engine.rs` (the same test module, after task 5.1).
    - Tests first: Property 5 as a seeded generator of stdout lines: known-type objects with random extra fields, objects with an unknown or non-string `type`, non-object JSON values, and malformed text. Each line is forwarded unchanged. The remembered line for each of the 18 types is the last matching line, or none. The `engine_status` value equals the value that the legacy `Value`-based implementation gives for the same sequence. The legacy implementation stays in the test module as the reference for R5.5. The generator runs at least 100 iterations, and the seed is printed on failure.
    - Done when: `cd apps/desktop/src-tauri && cargo test frame_memory_property` fails.

  - [~] 5.3 Enable serde_json's `raw_value` feature
    - Requirements: R5.5. Design: Constraints (the feature flag is allowed; no new crate).
    - Files: `apps/desktop/src-tauri/Cargo.toml` (line 21: `serde_json = { version = "1", features = ["raw_value"] }`). `Cargo.lock` changes only through the feature.
    - Build: enable `raw_value` in the existing `serde_json` dependency.
    - Done when: `cd apps/desktop/src-tauri && cargo build` succeeds, and `git diff -- apps/desktop/src-tauri/Cargo.lock` adds no new package.

  - [~] 5.4 Build the type peek and `remember_frame`
    - Requirements: R5.1, R5.2, R5.3, R5.4. Design: Components (`TypePeek`, `known_type`, `remember_frame`); EH-12.
    - Files: `apps/desktop/src-tauri/src/engine.rs` (new functions beside `on_stdout`, near line 314).
    - Build: `TypePeek` is a serde visitor that reads only the top-level `type` and skips every other value with `IgnoredAny`. `known_type` maps the 18 known names to `&'static str`. `remember_frame(last, line)` stores the line as the last frame of its type. For any other input, it leaves `last` unchanged.
    - Done when: `cd apps/desktop/src-tauri && cargo test frame_memory` passes its five examples.

  - [~] 5.5 Store raw frames and forward each line unchanged
    - Requirements: R5.1, R5.5. Design: Components (`EngineState`, `EngineStatus`, `on_stdout`); DV-17.
    - Files: `apps/desktop/src-tauri/src/engine.rs` (lines 108 to 126, 251 to 258, and 314 to 330).
    - Build: `EngineState.last` becomes `Mutex<HashMap<&'static str, Box<RawValue>>>`. `EngineStatus.last` becomes `HashMap<String, Box<RawValue>>`, and the `String` key appears only at serialization (DV-17). `on_stdout` forwards the line unchanged (R5.1), then calls `remember_frame`. It builds no `Value`.
    - Done when: `cd apps/desktop/src-tauri && cargo test frame_memory` and `cargo test frame_memory_property` pass, `cargo clippy --all-targets -- -D warnings` passes, and `git log -1 --format=%s` prints `feat(shell): forward frames with a type-only peek`, once the group commit for tasks 5.3 to 5.5 is made.

  - [~] 5.6 Write the E5 benchmark test and script, run the script, and commit the record
    - Requirements: R5.6, R5.7, R7.1. Design: Measurement plan (E5; harness modules `e5-frames.ts` and `record.ts`).
    - Files: `apps/desktop/src-tauri/src/engine.rs` (an ignored test `remember_frame_bench`), `scripts/bench/e5-frames.ts` (new), `bench/results/<date>-e5-frames.json` (new, committed).
    - Build: the ignored test generates one 33,000-file dupes frame from a fixed seed. It times `remember_frame` on that frame, reads `VmHWM` from `/proc/self/status` before and after, and runs the legacy `Value` implementation in the same process, in the same order, five times. It prints the frame size in bytes and the commit. The script runs the ignored test, parses its output, and writes the record with `writeRecord`. The record states the host, the frame size in bytes, the shell build (the commit), and that the measurement covers the remember path only, not the whole app. E5 decides nothing (R5.6).
    - Done when: `cd apps/desktop/src-tauri && cargo test -- --ignored remember_frame_bench` prints the numbers, `ls bench/results/*-e5-frames.json` lists the record, and `git log -1 --format=%s` prints `test(bench): record E5 frame forwarding cost`.

  - [~] 5.7 Checkpoint: Phase 5 shell tests
    - Run `cd apps/desktop/src-tauri && cargo test`, `cargo clippy --all-targets -- -D warnings`, and `cargo fmt --check`, and fix what fails.
    - Done when: the three commands pass.

- [ ] 6. Phase 6: documentation, the approved checks, and the exact texts (R6.8, R7.5, Appendix A)
     Tasks 6.6 and 6.7 are the approved checks from the revision. They are required, and they write only tests.
  - [~] 6.1 Update the README state machine, the flush text, and the destination check
    - Requirements: R7.5. Design: Documents and comments (README lines 75, 104 to 108, and 298); EH-13.
    - Files: `README.md`.
    - Build: line 75 shows that `written` follows the flush: the file fsync, the directory fsync, and the gate for created directories. Rewrite the flush description at lines 104 to 108 to give the file and directory fsyncs, the gate, and the deadline rule: 30 seconds plus 1 second for each started 10,000,000 bytes, with a 30-second floor. Add the R2.13 rule: a probe's 3-second deadline starts only after the flushes pending when it starts. Describe the destination check's 3-second deadline and its "could not be read" result, which refuses the run. Line 298 ("Local drive only.") stays. Confirm each line's current text before editing, because the line numbers come from design.md (Notes N29).
    - Done when: `grep -n "sync -f\|bytes landed, then fsync" README.md` prints nothing, and `grep -c "could not be read" README.md` prints 1 or more.

  - [~] 6.2 Update the TODO freeze lines and the benchmark entry
    - Requirements: R6.8, R7.5. Design: Documents and comments (TODO.md lines 70, 222, 366, and 368); DV-1.
    - Files: `TODO.md`.
    - Build: lines 222, 366, and 368 name the freeze. Change them to the new list, which is `src/scan` only (R6.8). Line 70: the stat latency now has an E1 record, while the 4.1 s and 175 s walk claims still have none, so their entry stays open. Name the E1 record in the entry. Add the R2.13 deadline rule to the probe entry (R7.5). Confirm each line's current text before editing (Notes N29).
    - Done when: `grep -n "frozen" TODO.md` names `src/scan` only, and `grep -c "bench/results" TODO.md` prints 1 or more.

  - [~] 6.3 Remove the `src/xfer` freeze claim from the dispatch comment
    - Requirements: R6.8. Design: Documents and comments (`src/serve/dispatch.ts`, lines 251 to 255).
    - Files: `src/serve/dispatch.ts`.
    - Build: rewrite the sentence that calls `src/xfer` a frozen acceptance surface, in fewer lines. Keep the rest of the comment.
    - Done when: `grep -n "frozen" src/serve/dispatch.ts` shows no claim about `src/xfer`.

  - [~] 6.4 Remove the `src/index` freeze claim from the prefs comment
    - Requirements: R6.8. Design: Documents and comments (`apps/desktop/src/lib/state/prefs.ts`, lines 15 to 18).
    - Files: `apps/desktop/src/lib/state/prefs.ts`.
    - Build: remove the claim that `src/index` is frozen. If those lines make no such claim, change nothing.
    - Done when: `grep -n "frozen" apps/desktop/src/lib/state/prefs.ts` shows no claim about `src/index`.

  - [~] 6.5 Record the accepted risks in TODO.md
    - Requirements: R7.5. Design: Risks and ceilings (RK-1, RK-2, RK-3, RK-5, RK-6, RK-7, RK-14); the accepted items O-2, O-4, O-5, O-7, O-9, and O-13.
    - Files: `TODO.md`.
    - Build: add one entry for each ID, giving its effect, its handling, and its upgrade path, as the design states them. The IDs are RK-1 (the journal's synchronous drive calls), RK-2 (a stuck kernel call holds its Bun worker), RK-3 (the fsyncgate residual after restart, O-5), RK-5 (a probe can wait about 533 seconds for a 5 GB flush, O-13), RK-6 (a same-device rename does not fsync the source directory, O-4), RK-7 (rsync sibling writes, O-2), and RK-14 (rows left in `written` after a crash, O-7). Also record O-9 (the host values come from the record) and DV-8 (the poison lasts until restart).
    - Done when: `grep -c "RK-" TODO.md` prints 7 or more, and `git log -1 --format=%s` prints `docs(durability): describe the flush, the probes, and the freeze list`, once the group commit for tasks 6.1 to 6.5 is made.

  - [~] 6.6 Check the Appendix A rows P17 to P20 against the design
    - Requirements: R2.2, R2.6, R2.15. Design: Appendix A rows P17 to P20 (requirements.md, Appendix A); Appendix A rows and their change (design.md).
    - Files: `test/units.test.ts` (new `appendix A rows` describe block). `requirements.md` is not changed.
    - Build: the test reads `.kiro/specs/transfer-durability-and-fs-hardening/requirements.md`, finds rows P17, P18, P19, and P20 in Appendix A, and asserts that each names its call site (plan.ts line 168; doctor.ts lines 162 and 244; doctor.ts lines 390 to 410; engine.ts line 374 and purge.ts line 82) and its deadline (3 s for P17, P18, and P19; the flush rule for P20). It also asserts that none of the files Appendix A names (`src/index/recovery.ts`, `src/plan/plan.ts`, `src/serve/doctor.ts`, `src/xfer/adb.ts`, `src/xfer/engine.ts`, `src/xfer/purge.ts`, `src/dedupe/index.ts`, `src/dedupe/trash.ts`, `src/serve/dispatch.ts`, `src/util/fs.ts`) still calls `spawnSync`, `statSync`, `statSyncSafe`, or `diskSpace(` (R2.6, R2.15).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "appendix A rows"` passes, and `git diff --quiet -- .kiro/specs/transfer-durability-and-fs-hardening/requirements.md` exits 0.

  - [~] 6.7 Test the exact message texts
    - Requirements: R2.3, R2.10, R2.14. Design: EH-13 (exact strings); the R2.14 text under design O-17; Notes N15.
    - Files: `test/units.test.ts` (new `exact messages` describe block).
    - Build: the test asserts that each text below appears, quoted exactly, in at least one of the source files named beside it. It also asserts that no text describing an unreadable result contains "missing", "zero", or "healthy". The texts and their files: "flush failed: the drive did not confirm the file was written" and "flush timed out after " (`src/util/durable.ts`); "flush failed: the drive did not confirm the folder entry: " and "flush skipped: an earlier flush of this folder failed; restart the Engine to retry: " (`src/util/durable.ts`); "the destination could not be read; nothing was changed" (`src/index/recovery.ts`, `src/dedupe/index.ts`, `src/xfer/adb.ts`); "the archive drive stopped answering; restart the Engine after checking the drive" (`src/xfer/engine.ts`, `src/serve/doctor.ts`); "check failed: no answer within " (`src/serve/doctor.ts`, `src/xfer/adb.ts`); "the archive drive is not mounted" (`src/index/recovery.ts`); "drive copy unreadable" (`src/xfer/purge.ts`, `src/serve/dispatch.ts`); "the mount check could not be read" (`src/serve/doctor.ts`); "the drive copy could not be read" (`src/xfer/engine.ts`); "the path could not be read; not transferred over" (`src/plan/plan.ts`); "the trash could not be read" (`src/dedupe/trash.ts`).
    - Done when: `bun test --preload ./scripts/preload.ts test/units.test.ts -t "exact messages"` passes.

  - [~] 6.8 Checkpoint: documentation and exact texts
    - Run `bun run test` and `bun run typecheck`, and fix what fails.
    - Done when: both commands pass.

- [ ] 7. Phase 7: definition of done (R7.3, R7.4, R7.6)
     This phase gives the evidence that AGENTS.md's definition of done asks for. Each evidence run is a script task, and its record is committed under `bench/results/`. A claim of freed space shows `df` before and after. This phase has no release task. Release is an owner step (Notes N25 and N30).
  - [~] 7.1 Write the definition-of-done script
    - Requirements: R7.3. Design: Testing strategy, Layer 4 (desktop, Rust).
    - Files: `scripts/definition-of-done.sh` (new, executable).
    - Build: the script runs, in order: `bun run typecheck`; `bun run test` at the root; in `apps/desktop`, `bun run check` (0 errors and 0 warnings), `bun run test`, and `bun run a11y`; `cargo test` in `crates/portage-scan` and in `apps/desktop/src-tauri`; `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` in both Rust crates; and finally `bun run build && bun run ui:sweep` in `apps/desktop`. It writes each command, its exit code, and its test counts to `bench/results/<date>-definition-of-done.txt`, and it exits non-zero when any command fails.
    - Done when: `bash -n scripts/definition-of-done.sh` exits 0.

  - [~] 7.2 Run the definition-of-done script and commit its evidence
    - Requirements: R7.3. Design: Testing strategy, Layer 4.
    - Files: `bench/results/<date>-definition-of-done.txt` (new, committed).
    - Build: run `scripts/definition-of-done.sh`. If a command fails, fix its cause in code and run the script again.
    - Done when: the script exits 0, the evidence file is committed, and `git log -1 --format=%s` prints `test(bench): record the definition-of-done runs`.

  - [~] 7.3 Write the scan-exclusion exercise, run it on the archive drive, and commit the record
    - Needs the archive drive mounted. Requirements: R3.3, R4.12, R7.4. Design: Testing strategy, Layer 4 (step 1).
    - Files: `scripts/bench/exercise-scan.ts` (new), `bench/results/<date>-scan-exclusion.json` (new, committed).
    - Build: the script calls `mountGuard` and the fixture guard. It creates `Videos/Android/data/` and `Videos/MyAndroid/data/` under a dedicated exercise folder on the drive, not in the owner's library, and records `df` before and after. It runs the scan through the engine's JSON protocol, with `dist/portage-scan` in place. The expected result is that the `Android/data` file is absent and the `MyAndroid/data` file is listed. It removes only the fixtures it created. The record holds both expectations and the observed result.
    - Done when: the record's `verdict.result` is `pass`, and `git log -1 --format=%s` prints `test(bench): record the scan exclusion on the archive drive`.

  - [~] 7.4 Write the trash exercise, run it on the archive drive, and commit the record
    - Needs the archive drive mounted. Requirements: R4.8, R4.9, R7.4. Design: Testing strategy, Layer 4 (step 2); Notes N10.
    - Files: `scripts/bench/exercise-trash.ts` (new), `bench/results/<date>-trash-run.json` (new, committed).
    - Build: the script calls `mountGuard` and the fixture guard, and creates a fixture file under `<destRoot>/.portage/trash/<day>/`. It runs trash emptying through its confirmation step, and records `df` before and after, and the bytes the engine reports as freed. The verdict is `pass` when the freed bytes are within one 4,096-byte block per removed file of the `df` change (Notes N10).
    - Done when: the record's `verdict.result` is `pass`, and `git log -1 --format=%s` prints `test(bench): record the trash run on the archive drive`.

  - [~] 7.5 Write the Doctor exercise, run it on the archive drive, and commit the record
    - Needs the archive drive mounted. Requirements: R2.3, R2.14, R7.4. Design: Testing strategy, Layer 4 (step 3); Notes N9.
    - Files: `scripts/bench/exercise-doctor.ts` (new), `bench/results/<date>-doctor-check.json` (new, committed).
    - Build: the script runs Doctor with the drive mounted and records its destination row. It then points `dest_root` at an empty, unmounted directory on the system disk and runs Doctor again. The expected text is "the archive drive is not mounted", and the output never says "healthy". The script restores the config afterwards. Call `mountGuard` for the mounted run only.
    - Done when: the record holds both outputs, its `verdict.result` is `pass` when the second output contains "the archive drive is not mounted", and `git log -1 --format=%s` prints `test(bench): record the Doctor check on the archive drive`.

  - [~] 7.6 Write the phone-copy exercise, run it, and commit the record
    - Needs the phone. Requirements: R1.1, R1.6, R7.7. Design: Notes N11; Testing strategy, Layer 4 (phone run).
    - Files: `scripts/bench/exercise-phone.ts` (new), `bench/results/<date>-phone-copy.json` (new, committed).
    - Build: the script pulls one small file over adb through the changed copy path, with `delete_source` set to `never`. It reads the journal rows for that file and checks that the row moved through `copying`, `written`, and `verified`, and that the flush and the hash check ran. It deletes nothing on the phone. Deleting from the phone is a one-way door under AGENTS.md rule 6, so the script does not do it.
    - Done when: the record's `verdict.result` is `pass`, the journal rows are in the record, and `git log -1 --format=%s` prints `test(bench): record the phone copy run`.

  - [~] 7.7 Review the change and fix each finding
    - Requirements: R7 (AGENTS.md, design and review process). Use `forge-review-gates` to choose the review agents, and run them on the branch's diff from the branch point.
    - Files: the files that each finding names. A finding that is a behaviour gets a regression test first, in the file that fits it.
    - Build: for each finding, write a test that fails on the defect, then fix the code. A finding that is not a defect is answered in `bench/results/<date>-review.md` (new), with its reason, and that file is committed with the fix it belongs to.
    - Done when: `bun run test` passes, and each finding has a test, a fix, or an entry in the review file.

  - [~] 7.8 Checkpoint: definition of done
    - Run `bun run test` and `bun run typecheck`, and fix what fails.
    - Run `scripts/check-commits.sh "$(git merge-base origin/master HEAD)" HEAD`, and fix what fails.
    - Done when: both commands pass, and `git status --porcelain bench` prints nothing, because each evidence task committed its record.

## Notes

- N1. **E1 total (approved).** E1 writes 21 files of 300,000,000 bytes: 20 timed runs and one stat-scenario file, 6,300,000,000 bytes in all. Each file is deleted after its run. The owner approved this total (design.md, Open items N1; requirements.md, Measurements). Task 0.6 depends on it.
- N2. **Destination check split (decision).** `probeDestination` is async and makes no decision. `judgeDestination` is pure. `buildPlan` judges the probe with its own byte total, and the run path judges again with `planResult.bytesTotal`. Both paths refuse on the same result (design.md, Components, destination check; DV-10). Tasks 2.8, 2.11, 2.13, and 2.14 depend on it.
- N3. **Test-first order (decision).** Each red test task sits in an earlier wave than the code task that makes it pass. This follows the owner's test-first direction. It departs from dependency-graph rule 4 in the workflow, which puts test tasks in later waves.
- N4. **Injection seams (decision).** The flush functions take an optional `deps` argument, following `moveFile`'s `deps.rename`. The defaults are the real functions. The seam is internal, so it needs no owner decision. Tasks 1.5, 1.9, and 1.10 depend on it.
- N5. **Layer 2 test file (decision).** Tests that use real files in a temporary folder live in `test/verify-gate.test.ts`, because design.md's Testing strategy names no file for them.
- N6. **Gate name (decision).** The owner's direction called the gate `flushChain`. design.md and these tasks call it `flushGate`.
- N7. **Purge existence check (decision).** The existence check in `applyPurge` (src/xfer/purge.ts line 151) is not an Appendix A row. R2.10 covers it, and `statDrive` gives it the 3-second deadline (design.md, Appendix A rows and their change). Task 2.21 depends on it. Task 6.6 does not add it to Appendix A.
- N8. **Volume discovery (scope).** Volume discovery is out of scope (requirements.md, Scope and exclusions). Task 2.10 moves its mount read to `readMount` and keeps its 5-second bound. `isPortageDrive` (src/device/volumes.ts line 168) keeps its `isDirectory` call and its current behaviour.
- N9. **Doctor expectation for an empty unmounted directory.** Design O-3 is approved. The report text is design O-17, which is still open (N30). When `dest_root` points at an empty, unmounted directory on the system disk, Doctor prints "the archive drive is not mounted" (R2.14). Task 7.5 checks this text. Before task 2.31 lands, Doctor can report such a directory as mounted, because `findmnt` reports the parent filesystem (DV-14).
- N10. **Trash tolerance (approved).** Freed bytes may differ from the `df` change by one 4,096-byte block per removed file. R4.9 states this bound, and design.md's Layer 4 step 2 uses it (design.md, Open items N10). Task 7.4 checks it.
- N11. **Phone run (approved).** The phone run pulls one file with `delete_source` set to `never`, and it deletes nothing on the phone (R7.7; design.md, Open items N11). Task 7.6 runs it, under the "Needs the phone" marker.
- N12. **Gate line format (decision).** A gate line names the record and the field that decide it. "Gate: E2 passes" means `verdict.result` is `pass` in the E2 record. "Gate: E3 passes for the move" and "for the stat" read `verdict.move.result` and `verdict.stat.result`. "Gate: E4 branch A" reads `verdict.directoryBranch` as `"A"`.
- N13. **Status field (decision).** Tasks 2.28 and 2.29 add `driveUnreadable` to the status frame, as R2.12 and design.md's EH-3 require. The desktop screens do not change, because the requirements add no control.
- N14. **Optional gated tasks (decision).** Only Phase 4's gated Helper tasks (4.4 to 4.24) carry `*`. Each gated test reads its gate's record and fails unless the record's verdict is `pass`, so no gate passes without a committed record (R4.11).
- N15. **Unreadable survivor text (design position; O-17 open).** An unreadable survivor refuses the deletion with the EH-13 text "the destination could not be read; nothing was changed" (design.md, Open items: O-16 approved, O-17 open; N30). Tasks 2.4 and 2.20 depend on it. The earlier text "could not read another copy to prove it survives" is retired.
- N16. **Unawaited `runTransfer` (fact).** src/serve/run-loop.ts line 188 calls `runTransfer` without `await`, and the summary is used as a value. Task 1.15 reads that call, and adds the `await` if the call is wrong.
- N17. **Frozen-check tests (decision).** The frozen-check and range-start tests live in `test/units.test.ts`. They create temporary git repositories, so no new test file is needed (design.md, CI changes).
- N18. **E1 stat measurement (decision).** Task 0.6 uses plain `fs.stat`, because `statDrive` is built in Phase 1, and Phase 0 runs before any production change.
- N19. **Test tasks are required (decision).** Test tasks are not optional. AGENTS.md rule 2 says a gate that was not run is a failed gate.
- N20. **Sidecar placeholders (fact).** The shell's cargo runs need the sidecar placeholders that CI creates: `apps/desktop/src-tauri/binaries/portage-<triple>` and `portage-scan-<triple>`. Create them locally and keep them untracked, as AGENTS.md's build trap requires.
- N21. **WebKitGTK package (fact).** The shell's cargo tests need the WebKitGTK 4.1 development package. Before task 5.1, check it with `pkg-config --exists webkit2gtk-4.1`.
- N22. **Engine step numbers (decision).** Task 1.14 follows the step numbers of design.md's per-file table. The step numbers in `processFile`'s comments count something else.
- N23. **Skipped outcome (fact).** A `skipped` outcome from the transport copies nothing, so it gets no flush. Crash recovery of `written` rows is O-7, which stays out of scope (design.md, Open items O-7).
- N24. **Root arguments (fact).** `withFreshDriveCopies` gets a `root` argument in task 2.19, and its one caller is src/serve/dispatch.ts line 876. The applied purge gets a `root` option in task 2.21, and task 2.22 passes it.
- N25. **Release (decision).** This plan has no release task. The owner decides when to release (AGENTS.md, definition of done, item 5).
- N26. **Exit-1 mount text (decision).** design.md's destination-check section keeps the current text for an exit-1 `findmnt`, "destination is not on a mounted filesystem". EH-2's row gives that case the R2.14 text. Task 2.31 follows the section, so only a target of `/` gets the R2.14 text.
- N27. **Drive runs one at a time (decision).** The flush counter is per device, so two runs on the archive drive would mix their counts. Tasks 0.6, 0.7, 4.2, 4.3, 7.3, 7.4, 7.5, and 7.6 run in the order the plan gives.
- N28. **Property 6 location (decision).** Property 6 lives in the test module of `main.rs`, which already exists, because the Conventions require property tests in existing test files (task 4.4).
- N29. **Line numbers in documents (fact).** Line numbers for README.md and TODO.md come from design.md, and they may be out of date. Confirm each line's text before editing (tasks 6.1 and 6.2).
- N30. **Owner checklist.** These steps need the owner. None of them is a task. (1) Mount the archive drive and connect the phone before tasks 4.2, 4.3, 7.3, 7.4, 7.5, and 7.6 run. The drive runs one measurement at a time (N27). (2) Remove the `*` from a gated task only after its gate's record in `bench/results/` passes (N12, N14). (3) Decide design O-17: the not-mounted report text (R2.14) and the unreadable survivor text (N15). (4) Decide design O-5, the poison rule (DV-8). (5) Confirm design O-6, the R2.13 reading. (6) Decide the run order for E2 and E3, because design O-12 does not approve alternating order. (7) Confirm the archive device. Both Phase 0 records show /dev/sda1 on USB port 4-1 at 5000 Mbit/s, which differs from F7, F10, and DV-2. (8) Confirm that R1.11's "the archive drive's" counter is the disk line, which the E1 record decides on. (9) Decide the release (N25).
- N31. **Coverage notes.** R1.14 applies only when Bun's directory fsync fails. E4 recorded branch `B`, so the condition is false. The E4 record and the recorded-decisions test (task 1.2) cover that, and tasks 4.21 to 4.24 build the branch-A path only if a later E4 record says `A`. R2.7 is covered by a test in 2.33 that passes when written, because its code is in 1.14. R2.8 is covered by the test in 2.5. R2.6 and R2.15 are covered by the row tasks and by the grep test in 6.6. R4.10 and R4.13 are covered for the TypeScript path by 4.26 and 4.27, and for the Helper path by the gated tasks. R6.5 is checked in the Done when line of 3.8. The R2.13 rule for R7.5 is added in 6.1 and 6.2.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1"] },
    { "id": 1, "tasks": ["0.2"] },
    { "id": 2, "tasks": ["0.3"] },
    { "id": 3, "tasks": ["0.4"] },
    { "id": 4, "tasks": ["0.5"] },
    { "id": 5, "tasks": ["0.6"] },
    { "id": 6, "tasks": ["0.7"] },
    { "id": 7, "tasks": ["0.8"] },
    { "id": 8, "tasks": ["1.1", "1.3"] },
    { "id": 9, "tasks": ["1.2", "1.4"] },
    { "id": 10, "tasks": ["1.5", "1.7"] },
    { "id": 11, "tasks": ["1.6"] },
    { "id": 12, "tasks": ["1.8", "1.11"] },
    { "id": 13, "tasks": ["1.9", "1.12"] },
    { "id": 14, "tasks": ["1.10", "1.13"] },
    { "id": 15, "tasks": ["1.14"] },
    { "id": 16, "tasks": ["1.15", "1.16", "1.17"] },
    { "id": 17, "tasks": ["1.18", "1.19"] },
    { "id": 18, "tasks": ["1.20"] },
    { "id": 19, "tasks": ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6"] },
    { "id": 20, "tasks": ["2.7", "2.8"] },
    { "id": 21, "tasks": ["2.9"] },
    { "id": 22, "tasks": ["2.10", "2.11"] },
    { "id": 23, "tasks": ["2.12", "2.13"] },
    { "id": 24, "tasks": ["2.14", "2.15", "2.16"] },
    { "id": 25, "tasks": ["2.17", "2.19", "2.20"] },
    { "id": 26, "tasks": ["2.18", "2.21", "2.23"] },
    { "id": 27, "tasks": ["2.22"] },
    { "id": 28, "tasks": ["2.24"] },
    { "id": 29, "tasks": ["2.25", "2.26"] },
    { "id": 30, "tasks": ["2.27", "2.28"] },
    { "id": 31, "tasks": ["2.29", "2.30"] },
    { "id": 32, "tasks": ["2.31", "2.32"] },
    { "id": 33, "tasks": ["2.33"] },
    { "id": 34, "tasks": ["2.34"] },
    { "id": 35, "tasks": ["3.1", "3.3", "3.6"] },
    { "id": 36, "tasks": ["3.2", "3.4", "3.7"] },
    { "id": 37, "tasks": ["3.5", "3.8"] },
    { "id": 38, "tasks": ["3.9"] },
    { "id": 39, "tasks": ["4.1"] },
    { "id": 40, "tasks": ["4.2"] },
    { "id": 41, "tasks": ["4.3"] },
    { "id": 42, "tasks": ["4.4", "4.5"] },
    { "id": 43, "tasks": ["4.6", "4.21"] },
    { "id": 44, "tasks": ["4.7", "4.8", "4.22"] },
    { "id": 45, "tasks": ["4.9", "4.10"] },
    { "id": 46, "tasks": ["4.11", "4.12"] },
    { "id": 47, "tasks": ["4.13"] },
    { "id": 48, "tasks": ["4.14", "4.17"] },
    { "id": 49, "tasks": ["4.15", "4.18"] },
    { "id": 50, "tasks": ["4.16", "4.19"] },
    { "id": 51, "tasks": ["4.20", "4.23"] },
    { "id": 52, "tasks": ["4.24"] },
    { "id": 53, "tasks": ["4.25"] },
    { "id": 54, "tasks": ["4.26"] },
    { "id": 55, "tasks": ["4.27"] },
    { "id": 56, "tasks": ["5.1", "5.3"] },
    { "id": 57, "tasks": ["5.2"] },
    { "id": 58, "tasks": ["5.4"] },
    { "id": 59, "tasks": ["5.5"] },
    { "id": 60, "tasks": ["5.6"] },
    { "id": 61, "tasks": ["5.7"] },
    { "id": 62, "tasks": ["6.1", "6.2", "6.3", "6.4"] },
    { "id": 63, "tasks": ["6.5", "6.6"] },
    { "id": 64, "tasks": ["6.7"] },
    { "id": 65, "tasks": ["6.8"] },
    { "id": 66, "tasks": ["7.1"] },
    { "id": 67, "tasks": ["7.2"] },
    { "id": 68, "tasks": ["7.3"] },
    { "id": 69, "tasks": ["7.4"] },
    { "id": 70, "tasks": ["7.5"] },
    { "id": 71, "tasks": ["7.6"] },
    { "id": 72, "tasks": ["7.7"] },
    { "id": 73, "tasks": ["7.8"] }
  ]
}
```
