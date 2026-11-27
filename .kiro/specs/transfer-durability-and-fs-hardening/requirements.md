# Requirements Document

**Feature:** transfer-durability-and-fs-hardening
**Spec type:** feature
**Workflow:** requirements-first
**Status:** Draft for owner review. Design and tasks start after the owner reviews this document.

## Introduction

Portage copies phone downloads to an archive drive, checks each copy against the phone's own hash, and then deletes the phone copy. Three defects weaken that sequence:

1. The flush after each copy runs `sync -f`. On the archive drive's ntfs-3g mount, that call does not ask the driver to flush the device (F1 to F3, C1). A phone copy can be deleted while the only copy on the drive is still in the page cache.
2. Several probes of the drive wait on a child process with no deadline. When the drive stops answering, the Engine stops answering too (C8, Appendix A).
3. A directory exclusion with a slash matches a suffix of the path, not whole segments. The default list excludes `Android/data`, so the scan silently skips a folder named `MyAndroid/data` (C3, C4).

This feature fixes those three defects first. It then adds measured Helper moves, a type-only frame peek in the Desktop shell, and the CI checks that would have caught these defects. Work follows the owner's order: measurements E1 and E4; the durability fix; the exclusion fix; the asynchronous probes; measurements E2 and E3 with any gated Helper moves; the frame change, measured by E5.

## Scope and exclusions

**In scope**

- The Flush of every drive copy, on every transport, before the drive copy is recorded as written. The same Flush runs before a cross-folder move removes its source. The directory fsyncs that R1 criterion 13 requires when a run creates directories.
- A deadline and non-blocking execution for every probe and flush in Appendix A.
- Whole-segment exclusion matching in the Helper and in the TypeScript fallback.
- Helper moves for trash deletion, the cross-folder move, and the survivor stat. Each moves only behind its measured gate.
- A type-only frame peek in the Desktop shell.
- CI: the frozen-files check against the base revision, and the parity suites run against a built Helper.
- Docs and comments that describe the flush, the destination check, or the freeze.
- Measurements E1 to E5 and their benchmark records.

**Out of scope**

- Scan progress, and a Stop that does not restart the Engine.
- A Rust verification hash.
- Tier 1 and tier 2 decision logic.
- The journal: its schema and its writers.
- The adb transport, except the flush and stat calls at the end of a copy and the rsync version check (P14). Pull arguments, resume rules, and existing timeouts do not change.
- The UI. No screen or control is added. The shell change is internal.
- Volume discovery (src/device/volumes.ts). It already bounds its probe.
- src/scan. It stays frozen. Its phone-side matcher already applies the segment rule (C3).

**Constraints**

- No new crates. The Helper already depends on libc (crates/portage-scan/Cargo.toml line 15). The Desktop shell has no libc, and this feature adds none. Enabling serde_json's `raw_value` feature in the shell is allowed, because it is a feature flag.
- AGENTS.md binds this feature. The rules that matter most here: never delete the last copy; re-check survivors on disk; say "could not be read" when a read fails; ask before a one-way door; keep PR_SET_PDEATHSIG; exercise scan, trash, and Doctor changes on the real drive; show df before and after any claim of freed space.
- Freeze for this feature: src/xfer, src/index, and src/plan are unfrozen. src/scan stays frozen. The owner decided that the lift is permanent (Decided by the owner, entry b).
- The benchmarks create and delete their own fixture trees on the archive drive. Requirement 4, criterion 12 limits that deletion.
- E1 runs on the archive drive's mount type in use, which is fuseblk ntfs-3g today (F13). The benchmark record names the driver (Requirement 7, criterion 2).

## Verified facts

Rows F1 to F6 are owner-cited external sources, which no workspace file can confirm. Rows F7 to F13 are environment facts. Rows C1 to C17 are code facts read from this workspace. Line numbers refer to the current tree.

### External and environment facts

| ID | Fact | Source | Status |
| --- | --- | --- | --- |
| F1 | `sync -f` calls syncfs(2). | coreutils src/sync.c | Owner-cited |
| F2 | Linux sends FUSE_SYNCFS to a FUSE server only when the server advertises FUSE_HAS_SYNCFS. Without it, dirty pages reach the server, but the device flush is never requested. | torvalds/linux fs/fuse/inode.c, fuse_sync_fs | Owner-cited |
| F3 | ntfs-3g's fsync handler, also registered as fsyncdir, calls ntfs_device_sync ("sync the full device"). Its operation table has no syncfs entry. | tuxera/ntfs-3g edge src/ntfs-3g.c | Owner-cited |
| F4 | An fsync on a file does not guarantee that its directory entry reached disk. The directory needs its own fsync. | man7 fsync(2) | Owner-cited |
| F5 | Rust std's remove_dir_all removes children with openat, unlinkat, and fdopendir on glibc Linux, so it resolves the full path once. | rust-lang library/std/src/sys/fs/unix.rs | Owner-cited |
| F6 | Node documents fs.fsyncSync(fd) and fs.fdatasyncSync(fd). Bun's support for both is unverified, because Bun's docs did not load. | nodejs.org/api/fs.html | Owner-cited for Node; Bun unverified |
| F7 | The archive drive is /dev/sda1 at /media/node/2TB, fuseblk (ntfs-3g), read-write, rotational, on USB port 4-2 at 5000 Mbit. The phone (Pixel 10 Pro XL) is on port 3-2 at 480 Mbit. Dated note, 2026-11-23: The earlier checks showed /dev/sda1 on USB port 4-2 at 5000 Mbit. The current checks show /dev/sdb1 on USB port 3-4 at 480 Mbit. The drive model is unchanged. The measurement records capture the device and the port at run time. | Owner | Mount line checked (F10). The link speed and the device were checked again later, as the dated note says. Rotational flag not checked. |
| F8 | Baseline before the change: Dirty 20788 kB, Writeback 0 kB. | /proc/meminfo, reported by owner | Not checked |
| F9 | Existing measurements: durable rate 27.6 MB/s with `dd conv=fsync` over 1 GB. Writeback is about 25 percent of wall time: 14.8 s on top of 44.2 s (59.0 s in all) for a 1.8 GB job. | docs/milestones.md lines 62-65 | Read |
| F10 | The mount line reads `/dev/sda1 /media/node/2TB fuseblk rw,nosuid,nodev,relatime,user_id=0,group_id=0,default_permissions,allow_other,blksize=4096`. Dated note, 2026-11-23: The line above is from the earlier check. The current checks show /dev/sdb1 on USB port 3-4 at 480 Mbit. The drive model is unchanged. The measurement records capture the device and the port at run time. | /proc/mounts on this machine | Checked |
| F11 | Kernel 7.0.0-43-generic. /proc/diskstats gives 17 statistics per device, after three name columns. The 16th statistic is flush requests completed, which is column 19 of the line. At the earlier check, sda and sda1 both showed 0. | uname -r; /proc/diskstats | Checked for /dev/sda1 at the earlier check: the line has 20 columns, and column 19 read 0. The current archive device has not been checked. |
| F12 | /sys/block/sda/queue/write_cache reads "write back" for /dev/sda, so that device has a volatile cache and device flushes matter. | sysfs | Checked for /dev/sda. The current archive device has not been checked. |
| F13 | The archive drive is a fuseblk ntfs-3g mount today. docs/tui.md documents kernel ntfs3 as available (see C16). That is not confirmed on this machine. /proc/filesystems lists fuseblk and does not list ntfs3, and the kernel module may load on demand. If the drive were mounted with kernel ntfs3, which has no FUSE layer, its syncfs behaviour could differ from ntfs-3g. The fix uses fsync on the file and on the directory. E1 checks its effect on the mount type in use. | F10 for the mount type; docs/tui.md 173-175 for the ntfs3 claim; /proc/filesystems for the listing | Mount type checked (F10). /proc/filesystems checked: fuseblk listed, ntfs3 not listed. Module availability not checked. |

### Code facts

| ID | Fact | Source |
| --- | --- | --- |
| C1 | fsyncPath runs `sync -f`. When that fails, it falls back to a bare `sync`, which is filesystem-wide. It returns a boolean, and every call site discards it. A failed flush is therefore recorded as copied. | src/util/fs.ts 25-37; src/xfer/adb.ts 106, 176, 273 |
| C2 | Order today for one file: transport copy (which flushes), record as written, hash verification, then phone copy removal only when delete_source is `after-verify`, the default. The values `never` and `prompt` skip the removal. | src/xfer/engine.ts 239, 269, 274, 316-317; src/config/schema.ts 22, 95 |
| C3 | Directory exclusions with a slash match a suffix of the path with no segment boundary. The Rust walker and the TypeScript fallback both do this. The phone-side matcher checks the boundary correctly. | crates/portage-scan/src/walk.rs 121-132 (line 128); src/dedupe/scan-io.ts 92-105 (line 102); src/scan/scan.ts 69-73 |
| C4 | Three default exclusions contain a slash: `Android/data`, `Android/obb`, and `DCIM/.thumbnails`. The walker receives this list. | src/config/schema.ts (ALWAYS_EXCLUDED_DIRS); src/dedupe/scan-io.ts 131; src/serve/doctor.ts 247-249 |
| C5 | The frozen-files step runs `git status --porcelain` on four folders. A clean CI checkout has no uncommitted edits, so this step cannot see a committed change. | .github/workflows/ci.yml 88-96 |
| C6 | The parity suites skip when no Helper is found. The engine job does not build the Helper. | test/scan-io.test.ts 30, 104, 130, 147, 165, 183; ci.yml engine job, about lines 64-96 |
| C7 | The shell parses every stdout line into a serde_json Value, keeps the Value of each known type, and forwards the original line. There are 18 known types. | apps/desktop/src-tauri/src/engine.rs 85, 112, 126, 314-330 |
| C8 | A non-zero findmnt exit is reported as "not on a mounted filesystem". The run path refuses to start when the check is not ok. The plan path only records a warning. | src/index/recovery.ts 157-199; src/serve/run-loop.ts 164-175; src/plan/plan.ts 228-230 |
| C9 | When a move crosses devices, moveFile copies with Bun.write and then removes the source. It never flushes. | src/util/fs.ts 193-204 |
| C10 | The survivor check, the reconciliation stats, and the trash listing treat a failed stat as absent. | src/dedupe/index.ts 425-433; src/index/recovery.ts (reconcile, about lines 80-102); src/util/fs.ts 131-145; src/dedupe/trash.ts 83 |
| C11 | The Helper runs once per request: it reads one JSON request on stdin, writes one response, and exits. | crates/portage-scan/src/main.rs line 31 |
| C12 | The Helper depends on libc 0.2.191 and serde_json "1". The Desktop shell depends on serde_json "1" with no features, and has no libc. | crates/portage-scan/Cargo.toml 15-17; apps/desktop/src-tauri/Cargo.toml 19-21 |
| C13 | The trash-empty path asks for confirmation first. It acts only when the confirm id matches and a fresh reading matches the stored counts. It reads free space before and after, and deletes the pending record on success. | src/serve/dispatch.ts about 1073-1139 |
| C14 | Comments and TODO entries call src/scan, src/xfer, and src/index frozen. | src/util/paths.ts 43-46; src/serve/dispatch.ts 251-255; test/serve.test.ts 1431-1434; apps/desktop/src/lib/state/prefs.ts 15-18; TODO.md 222, 366, 368 |
| C15 | The README state machine reads "bytes landed, then fsync". The README also says each file is flushed before it is called finished, and says "Local drive only." | README.md 75, 104-108, 298 |
| C16 | An older snapshot in docs/tui.md shows the drive at 480M. It says ntfs-3g is used although kernel ntfs3 is documented as available. That is not confirmed on this machine (F13). The driver and link speed can change. | docs/tui.md 173-175 |
| C17 | The trash root is `<destination root>/.portage/trash`. emptyTrash deletes only inside it. | src/dedupe/trash.ts line 5 and line 143 |

Not confirmed from the workspace: F1 to F6; the rotational flag in F7; F8; the ntfs3 availability in F13; Bun's support for fsync on files and directories (F6); and the write-cache setting (F12) and the flush counter (F11) of the current archive device. AGENTS.md describes the folder shape, but no committed file defines the fixture. The Measurements section now defines the fixtures.

## Glossary

- **Archive drive**: the local volume that holds the archive. On the owner's machine it was /dev/sda1 at /media/node/2TB at the earlier check, and it is /dev/sdb1 at the current check (F7, dated note).
- **Destination root**: the archive folder that receives drive copies (the `dest_root` setting). It sits on the archive drive.
- **Destination check**: the check that the plan path and the run path both run on the destination root, reading its mount state (P2) and free space (P3), and returning a result that is not ok when either read fails or the destination is on the root filesystem (R2 criteria 4 and 14).
- **Nearest mount point**: the mount point that holds a path, which is the target that `findmnt --target` reports for that path.
- **Root filesystem**: the filesystem mounted at `/`.
- **Trash root**: `<destination root>/.portage/trash`. Trash deletion may change only this folder (C17).
- **Phone copy**: a file on the phone, read over adb (or rsync in the fallback transport).
- **Drive copy**: the file the Engine writes under the destination root for one phone copy, and the copy that a cross-folder move makes when it falls back to copy and remove (R1 criterion 8).
- **Flush**: the durability step for one drive copy. It is an fsync of the drive copy's data, followed by an fsync of the directory that holds it (F4).
- **Directory fsync**: an fsync of a directory. The Flush makes one, on the directory that holds the drive copy (R1 criterion 2). R1 criterion 13 requires others for the flush set, and each of those has a 30-second deadline (default 12).
- **Flush set**: for a run that creates directories, every directory the run created, plus the existing parent of each topmost created directory (R1 criterion 13). The parent is flushed once per run, and again only when this run adds another topmost created directory beneath it (default 11).
- **Gated drive copy**: a drive copy beneath a directory this run created whose phone copy is still present. R1 criterion 13 applies to it, and a failed fsync fails it (defaults 10 and 13).
- **Durable**: a drive copy is durable once its Flush, and any directory fsync that R1 criterion 13 requires for it, has returned success. E1 checks the device-level meaning.
- **Probe**: a read of archive-drive or destination state that a decision depends on: mount state, free space, existence, size, survivor state, the trash listing, or the verify read and the purge read of a drive copy. The rsync version check (P14) is also a probe under R2 criterion 2.
- **Drive call**: one Flush, directory fsync, probe, or per-file stat of the archive drive, including the verify read and the purge read of a drive copy. Each has a deadline (R1 criteria 12 and 13, R2 criterion 2).
- **Unreadable**: a probe or stat that timed out, or that failed for any reason other than a missing path. An unreadable result is reported as "could not be read". Two results use other wording: a check in row P14 or P15 that reaches its deadline is reported as "failed" (R2 criterion 3), and the purge read in row P20 is reported as "drive copy unreadable" (R2 criterion 10). It is never reported as missing, absent, or zero.
- **Engine**: the `dist/portage` process that the Desktop shell starts. It reads one JSON request per line on stdin and writes one frame per line on stdout.
- **Frame**: one JSON object on one Engine stdout line. Its top-level `type` field names it.
- **Desktop shell**: the Rust program in apps/desktop/src-tauri. It starts the Engine and forwards each frame as the `engine://frame` event.
- **Helper**: the `portage-scan` binary built from crates/portage-scan. It reads one request, writes one response, and exits (C11).
- **Event loop**: the Engine's single thread that reads requests and writes responses. One blocking call on it stops every other request.
- **Frozen folder**: a folder that the CI frozen-files check protects from committed changes on this branch. After this feature, src/scan is the only frozen folder. The owner decided that the lift is permanent (Decided by the owner, entry b), so the check covers src/scan only (R6.3).
- **Survivor check**: the on-disk re-check that another copy still exists before a file is removed (AGENTS.md rule 5).
- **Pending record**: the entry the Engine keeps for a destructive action until the person confirms it (the pending-action register in src/serve/dispatch.ts).
- **Fixture**: a test tree that a benchmark creates under its own fixture root. The deep fixture has a chain of 462 path segments. The shallow fixture has three path segments or fewer (approved; Decided by the owner, entry a).
- **Measured gap**: a difference between the TypeScript path and the Helper path for one operation, shown in a benchmark record to meet the thresholds in Requirement 4.
- **Benchmark record**: a committed record of one measurement. It holds the script, the raw output, the environment (kernel, driver, device name, USB port, mount options, link speed, host, build), and the verdict.

## Measurements

The definitions below are the owner's approved plan, with E5 added for the frame benchmark. Other documents use E-labels for other gates (for example docs/tui-impl/06-acceptance.md), so cite these by spec name.

| ID | Question | Decides | Requirement |
| --- | --- | --- | --- |
| E1 | Durability counter test on the archive drive. For each of these three forms of the flush, record the flush-requests-completed counter (the 16th of the 17 statistics on the archive device's /proc/diskstats line, which is column 19) and the Dirty and Writeback values in /proc/meminfo, before and after: (1) the current `sync -f`; (2) an fsync of a file; (3) an fsync of a file followed by an fsync of its directory. Write 300 MB to the drive first, so Dirty rises. Also record the wall time of each flush, the longest stat latency while one Flush is pending on the same drive, and the time a stat takes after that Flush has ended. | Whether the durability change may merge (R1 criterion 11). Whether a healthy drive finishes a flush within the deadline in R1 criterion 12 (decided default 5), and whether it finishes a directory fsync within the 30-second deadline of default 12. Whether a stat that starts after a pending Flush ends stays within the 3-second probe deadline, and how long a stat waits for a pending Flush (R2 criterion 13). | R1 criteria 10 and 11; R2 criterion 13 |
| E2 | Trash deletion. Time the TypeScript removal (Bun rm with recursive set) against the Helper removal (Rust std remove_dir_all) on the deep and shallow fixtures. | Whether trash deletion moves to the Helper, through the gate in R4 criterion 1. | R4 criterion 1 |
| E3 | Cross-folder move and survivor stat. Time the TypeScript rename and stat against the Helper move (renameat with two directory handles) and the Helper stat, on the same fixtures. | Whether the cross-folder move and the survivor stat move to the Helper, through the gate in R4 criterion 1. The Helper stat is timed as one group request (decided default 4). | R4 criteria 2 and 3 |
| E4 | Bun fsync on an archive-drive file and on its directory. Record whether each call succeeds and whether the E1 counter moves. | Whether the directory fsyncs of R1 criteria 2 and 13 use Bun's fsync or the Helper (decided default 2). | R1 criteria 2, 13, and 14 |
| E5 | Frame forwarding. Time and peak memory for forwarding one 33,000-file dupes frame, before and after the type-only peek. This is the benchmark record that Requirement 5 needs. | Nothing. The frame change ships either way. | R5 criteria 6 and 7 |

Each E1 and E4 run records the open mode of every handle used for the flush.

Fixtures, as the owner approved them: each fixture holds 1,000 files of 4 KiB each, so both fixtures hold the same file count. The deep fixture is one chain of 462 path segments. The shallow fixture has three path segments or fewer.

The E1 run writes 6.3 GB of test files in total: 20 timed runs of 300 MB, plus one stat-scenario file of 300 MB. Each file is deleted after its run. The owner has approved this total. Each file sits under the benchmark's fixture root, so R4.12 limits its deletion.

## Requirements

### Requirement 1: Durable drive copy before the phone copy is deleted

**User Story:** As a Portage user, I want a phone copy deleted only after its drive copy is flushed and matches the phone's hash, so that a deleted phone copy never leaves the only copy in the page cache.

#### Acceptance Criteria

1. WHEN a copy finishes on any transport, including a resumed copy and the rsync fallback, THE Engine SHALL perform one Flush on the drive copy before it records the drive copy as written.
2. THE Flush SHALL fsync the drive copy's data, and then fsync the directory that holds the drive copy.
3. THE Flush SHALL consist only of the two fsync calls named in criterion 2.
4. THE Engine SHALL count a drive copy as durable only after its Flush, and any directory fsync that criterion 13 requires for it, returns success.
5. IF the Flush fails or reaches its deadline (criterion 12), THEN THE Engine SHALL record the file as failed with the reason, and SHALL keep the phone copy unchanged.
6. THE Engine SHALL delete a phone copy only after the Flush has succeeded, any directory fsync that criterion 13 requires has succeeded, and the drive copy's hash equals the phone's hash.
7. WHILE a Flush or a directory fsync is pending, THE Engine SHALL answer other requests without waiting for it.
8. WHEN a cross-folder move falls back to copy and remove, THE Engine SHALL perform the Flush on the copy, and any directory fsync that criterion 13 requires for it, before it removes the source.
9. THE unit suite SHALL check the call order with a recording fake, in this order: Flush of the drive copy's data, Flush of its directory, any directory fsync that criterion 13 requires for the copy, record as written, hash match, and then phone copy deletion.
10. THE device-level effect SHALL be verified by E1, because a unit test cannot observe a disk flush.
11. THE durability change SHALL merge only after an E1 record, committed before the change, shows that the Flush increases the archive drive's flush-requests-completed counter.
12. THE Flush SHALL have a deadline of 30 seconds plus 1 second for each started 10,000,000 bytes (10 decimal megabytes) of the drive copy's size. A partial unit counts as a full one, so a drive copy of zero bytes has a 30-second deadline, and a drive copy of 10,000,001 bytes has a 32-second deadline. E1 SHALL show that a healthy drive finishes a flush within that deadline.
13. WHEN a drive copy lies beneath a directory that this run created, THE Engine SHALL fsync, bottom up, each member of the flush set that has gained an entry since its last fsync, before it records that copy as written or deletes its phone copy. The flush set is every directory that this run created, plus the existing parent of each topmost created directory. IF one of these fsyncs fails or reaches its deadline, THEN THE Engine SHALL record each affected drive copy as failed with the reason, and SHALL keep its phone copy unchanged. Each of these fsyncs has the deadline of criterion 12 for a drive copy of zero bytes, which is 30 seconds. A run that creates no directories needs no fsync beyond criterion 2.
14. IF Bun's directory fsync fails on the archive drive (E4), THEN THE Helper SHALL perform each directory fsync that criteria 2 and 13 require, with a std file handle and sync_all, and the Helper SHALL add no libc call for that step. IF the Helper is missing in that case, THEN THE Engine SHALL treat the directory fsync as failed, so criterion 5 applies.
15. THE unit suite SHALL check, with a recording fake, that each member of the flush set that has gained an entry since its last fsync, including the existing parent of each topmost created directory, is fsynced bottom up before any drive copy beneath a created directory is recorded as written or has its phone copy deleted.

### Requirement 2: Bounded probes that never freeze the Engine

**User Story:** As a Portage user, I want every drive read to finish within a deadline or report that the drive could not be read, so that a sick drive cannot freeze the app or make an unreadable drive look healthy.

#### Acceptance Criteria

1. THE destination check on the plan path and on the run path SHALL run without blocking the Event loop.
2. THE Engine SHALL give each probe in Appendix A, rows P2 to P14 and P17 to P19, its own deadline of 3 seconds, with no bound shared between probes, and run each probe asynchronously as criterion 15 requires. THE Engine SHALL give the flush in row P15, and the verify read and the purge read in row P20, the flush deadline of R1 criterion 12, for the size of the file that each call covers.
3. WHEN a probe in rows P2 to P13 reaches its deadline, THE Engine SHALL stop waiting for that probe and SHALL report that the destination could not be read (for row P13, that the trash could not be read, as criterion 11 requires), without stating zero free space, a healthy drive, or "not mounted". WHEN a probe in rows P17 and P18 reaches its deadline, THE Engine SHALL stop waiting for that probe and SHALL report that the path could not be read, without reporting the path as missing. WHEN the findmnt probe in row P19 reaches its deadline, THE Engine SHALL stop waiting and SHALL report that the mount check could not be read, without reporting an unknown filesystem or a drive that is not read-only. WHEN the verify read in row P20 reaches its deadline, THE Engine SHALL stop waiting and SHALL report that the drive copy could not be read. WHEN the check in row P14 or P15 reaches its deadline, THE Engine SHALL stop waiting and SHALL report that check as failed, without reporting the rsync binary or the test file as healthy.
4. WHEN the destination check cannot read the drive, THE destination check SHALL return a result that is not ok, so that the run path refuses to start.
5. WHEN a stat fails for any reason other than a missing path, THE Engine SHALL report the path as unreadable, and SHALL NOT mark a row missing or let any deletion rest on that path.
6. THE per-file stat calls on the copy path and the verify path SHALL run without spawning a child process.
7. WHEN a per-file stat on the copy path or the verify path times out, THE Engine SHALL fail that file with a reason that says the destination could not be read.
8. WHILE a probe, a Flush, a directory fsync, or a version check is pending, THE Engine SHALL answer other requests, including a status request.
9. THE survivor check SHALL count a copy as a survivor only when its stat returns a result, and SHALL refuse the deletion when no survivor is proven.
10. THE purge check on each drive copy SHALL refuse the purge item with the reason "drive copy unreadable" when the drive copy cannot be read. THE purge existence check in row P12 SHALL apply the 3-second deadline of criterion 2. THE purge read in row P20 SHALL apply the flush deadline of R1 criterion 12 for the drive copy's size.
11. THE trash listing SHALL report that the trash could not be read when its stat fails for any reason other than a missing trash root, and SHALL NOT report "no trash" for that failure.
12. WHEN three drive calls in a row reach their deadline, THE Engine SHALL refuse further work that touches the archive drive, and SHALL report the archive drive as unreadable until the Engine restarts.
13. WHILE a Flush or a directory fsync is pending on the archive drive, THE Engine SHALL start the deadline of each probe and per-file stat on that drive (criterion 2) only after every such call has returned or reached its own deadline, so that the wait for a pending call is bounded.
14. WHEN the destination check runs, THE destination check SHALL refuse a destination whose nearest mount point is the root filesystem, SHALL report that the archive drive is not mounted, and SHALL NOT report that destination as healthy.
15. WHEN this feature merges, THE Engine SHALL run every probe and every flush listed in Appendix A asynchronously, so that a deadline can stop the wait for each probe and flush.

The destination check runs two probes, mount state and free space. Each has its own 3-second deadline (criterion 2), so the check can take up to six seconds once any pending Flush or directory fsync on the archive drive has ended (criterion 13).

### Requirement 3: Exclusions match whole path segments

**User Story:** As a Portage user, I want the exclusion `Android/data` to skip only that folder, so that a folder named `MyAndroid/data` on my archive is still scanned.

#### Acceptance Criteria

1. WHEN a directory exclusion contains "/", THE Helper SHALL exclude a directory only when the exclusion's segments equal the last segments of that directory's path.
2. WHEN a directory exclusion contains "/", THE TypeScript fallback SHALL apply the same rule as the Helper.
3. WHEN the exclusion is `Android/data`, THE Helper and THE TypeScript fallback SHALL exclude files under `Videos/Android/data` and SHALL include files under `Videos/MyAndroid/data`.
4. WHEN an exclusion contains no "/", THE Helper and THE TypeScript fallback SHALL exclude a directory only when the directory's name equals the exclusion, at any depth.
5. THE Helper's unit tests SHALL include the pair of paths named in criterion 3.
6. THE walker parity suite SHALL include the pair of paths named in criterion 3 in its fixture, and SHALL require both walkers to return the same candidate set.

### Requirement 4: The Helper takes trash and move work only on a measured gap

**User Story:** As a Portage user, I want the Rust helper to take over trash deletion and file moves only where a benchmark on my archive drive shows a real gain, so that safety decisions stay in TypeScript and no unmeasured change ships.

#### Acceptance Criteria

1. THE trash deletion SHALL move to the Helper only when E2 shows both of the following: on the deep fixture, the TypeScript median time is at least 2.0 times the Helper median time; and on the shallow fixture, the Helper median time is at most 1.10 times the TypeScript median time.
2. THE cross-folder move, which is the apply step that moves a duplicate from its place under the destination root into the trash root, SHALL move to the Helper only when E3 meets the gate in criterion 1, measured separately for that move. IF the Helper is missing or its gate has not passed, THEN THE cross-folder move SHALL run on its TypeScript path, and THE result SHALL name TypeScript as the path that ran (criterion 10).
3. THE survivor stat SHALL move to the Helper only when E3 meets the gate in criterion 1, measured separately for that stat. WHEN the Helper path is used, one request SHALL cover a whole group of survivor candidates, so that no request starts a process per file. IF the Helper is missing or its gate has not passed, THEN THE survivor stat SHALL run on its TypeScript path, and THE result SHALL name TypeScript as the path that ran (criterion 10).
4. THE Engine SHALL choose every path. THE Helper SHALL perform the named operation on each path that the Engine passes, and SHALL return one result per path.
5. THE Helper SHALL refuse a deletion path whose parent directories do not resolve inside the trash root. The final component is the entry itself, so criterion 6 governs a symbolic link there. For a move, THE Helper SHALL refuse a source outside the destination root and a target outside the trash root. Each refusal SHALL be reported for its path.
6. WHEN a path inside the trash root is a symbolic link, THE Helper SHALL remove the link itself and SHALL leave the link's target untouched.
7. THE survivor decision SHALL remain in TypeScript.
8. THE Helper-backed action SHALL keep the confirmation step and the pending record of the TypeScript path, and SHALL add no UI path.
9. THE trash emptying SHALL return the same counts and refusals on the Helper path and on the TypeScript path for the same input. THE trash emptying SHALL report freed bytes that differ between the two paths by at most one 4,096-byte block per removed file.
10. THE result of each action that can use the Helper, including the directory fsyncs of R1 criterion 14, SHALL name the path that ran, either Helper or TypeScript.
11. IF a gate is not met, THEN THE operation SHALL stay in TypeScript, and THE benchmark record SHALL stay in the repository.
12. THE benchmark script SHALL delete only fixture trees that it created under its fixture root, and SHALL refuse to run when that root contains files it did not create.
13. IF the Helper is missing or its gate in criterion 1 has not passed, THEN THE trash deletion SHALL run on the TypeScript path, and THE result SHALL name TypeScript as the path that ran (criterion 10).

### Requirement 5: Frames forwarded with a type-only peek

**User Story:** As a Portage user, I want the desktop app to forward large scan results without rebuilding them, so that a 33,000-file result costs less time and memory to pass through.

#### Acceptance Criteria

1. THE Desktop shell SHALL forward each Engine stdout line unchanged as the `engine://frame` event.
2. THE Desktop shell SHALL decide whether to remember a frame from its top-level type field alone.
3. WHEN a frame's type is one of the 18 known types, THE Desktop shell SHALL remember that frame as the last frame of its type.
4. WHEN a line is not a JSON object or its type is not known, THE Desktop shell SHALL forward the line and SHALL keep the remembered frames unchanged.
5. THE `engine_status` response SHALL return the last remembered frame of each known type, with the same JSON value as before this change.
6. THE benchmark record for E5 SHALL show the time and peak memory for forwarding one 33,000-file dupes frame, before and after this change.
7. THE benchmark record for E5 SHALL state the host, the frame size in bytes, and the Desktop shell build.

### Requirement 6: CI enforces the freeze and the parity tests

**User Story:** As the owner, I want CI to catch a committed change to src/scan, and to fail when a parity test is skipped, so that the freeze and the walker parity hold on every push.

#### Acceptance Criteria

1. THE frozen-files check SHALL compare the branch's committed changes against the base revision that the commit-range check uses.
2. THE frozen-files check SHALL fail when a committed change touches src/scan.
3. THE frozen-files check SHALL cover src/scan only.
4. WHEN the base revision has moved since the branch point, THE frozen-files check SHALL judge only the changes the branch adds.
5. THE Engine CI job SHALL build the Helper before it runs the tests.
6. THE Engine CI job SHALL run the walker parity suite and the digester parity suite against the built Helper.
7. IF any test in the walker parity suite or the digester parity suite is skipped, THEN THE Engine CI job SHALL fail. The built-in default test in test/scan-io.test.ts is outside this rule, because it skips by design when the Helper is present.
8. THE comments and TODO entries that describe src/xfer, src/index, or src/plan as frozen SHALL match the new freeze list.

### Requirement 7: Evidence and definition of done

**User Story:** As the owner, I want each decision backed by a committed record and a full check run, so that every claim in the docs can be audited.

#### Acceptance Criteria

1. EACH measurement (E1, E2, E3, E4, and E5, as each applies) SHALL be committed as a script with its raw output. EACH archive-drive measurement (E1, E2, E3, and E4) SHALL also record the archive drive's device name, its USB port, its link speed in Mbit/s, and its mount options. E5 SHALL record the host, the frame size, and the Desktop shell build, as Requirement 5, criterion 7 requires.
2. EACH archive-drive measurement SHALL record the kernel release and the mount driver, fuseblk or ntfs3.
3. THE change SHALL pass typecheck, the root test suite, the desktop check and test suites, cargo test in crates/portage-scan and in apps/desktop/src-tauri, and ui:sweep.
4. THE change SHALL be exercised on the archive drive for the scan exclusion, for the trash path, and for Doctor's checks, and each claim of freed space SHALL show df before and after.
5. THE README and TODO.md SHALL describe the Flush (file and directory), the directory fsyncs of R1 criterion 13, the deadline rule of R2 criterion 13, and the destination check (its deadline and its could-not-be-read result), as the code does after the change. THE README state machine SHALL show that written follows the Flush.
6. THE commits SHALL pass scripts/check-commits.sh over the change range.
7. THE change SHALL be exercised once by a real phone transfer with delete_source set to never, and THE run SHALL show that the flush happens before the drive copy is recorded as written and that no phone copy is deleted.

## Open questions and decided defaults

### Decided by the owner

(a) The Requirement 4 thresholds are approved. On the deep fixture, the Helper must be at least 2.0 times faster than the TypeScript path. In R4.1 terms, the TypeScript median time is at least 2.0 times the Helper median time. On the shallow fixture, the Helper must take at most 1.10 times the TypeScript time. Each path gets five runs. Both fixtures hold the same file count. The shallow fixture has three path segments or fewer.

(b) The freeze lift on src/xfer, src/index, and src/plan is permanent after this feature merges. src/scan stays frozen. R6.3 stays as written.

### Part 2: Decided defaults

These defaults are decided. Each one records its reason. The owner may change any of them later.

1. **Flush per file.** Flushes are per file now. Batching is a later change that needs a measurement. Any batch still completes each drive copy's Flush, and each directory fsync that R1 criterion 13 requires, before that copy's phone copy is deleted. Reason: batching changes when each copy becomes durable, so it needs its own measurement first. The per-file rule keeps the deletion order for each copy (R1.6).
2. **Helper directory step.** If Bun's directory fsync fails in E4, the Helper performs every directory fsync that R1 criteria 2 and 13 require, using a std file handle and sync_all. No libc call is added for this step. Reason: F4 requires the directory fsync. A std file handle and sync_all need no new crate and no libc call, and the Helper already exists (C12).
3. **TypeScript path for Helper-backed operations.** Trash deletion (R4.13), the cross-folder move (R4.2), and the survivor stat (R4.3) each keep their TypeScript path when the Helper is missing or its gate has not passed. Each result names the path that ran (R4.10). The directory fsync in R1.14 has no TypeScript fallback, because it runs only where Bun's directory fsync has failed. If the Helper is missing there, that fsync fails, its result names TypeScript as the path that ran (R4.10), and R1 criterion 5 applies. Reason: the Helper is a gated speed-up, so a missing Helper or a failed gate should not stop the action. The named path shows which code ran.
4. **Survivor stat gate.** The survivor stat uses the same gate as Requirement 4. When the Helper path is used, one request covers a whole group, so no request starts a process per file. When the Helper is missing or the gate has not passed, default 3 applies. Reason: the Helper runs one process per request (C11), so a per-file request would start one process per file.
5. **Flush deadline.** The flush deadline is 30 seconds plus 1 second for each started 10,000,000 bytes (10 decimal megabytes) of file size. A partial unit counts as a full one. On expiry the file fails and the phone copy stays. Each probe keeps its own 3 second deadline, with no shared bound. E1 must show that a healthy drive finishes a flush within this deadline. Reason: F9 records 14.8 seconds of writeback on top of a 44.2 second run that wrote 1.8 GB. The per-unit term allows about 10 MB/s, which is about 2.8 times slower than the 27.6 MB/s durable rate in F9. A shared bound would tie a probe's wait to a flush's length, and the reverse.
6. **Refusal after stuck calls.** After 3 drive calls in a row hit their deadline, the Engine refuses further drive work and reports the drive as unreadable until it restarts. Reason: a call that the kernel never completes keeps its worker thread after its deadline. Bun's worker pool size for file operations is not verified, so a small limit stops blocked calls from piling up.
7. **Created directories.** A drive copy beneath a directory this run created is recorded as written, and its phone copy is deleted, only after each member of the flush set that has gained an entry since its last fsync has been fsynced, bottom up. The flush set is every directory this run created, plus the existing parent of each topmost created directory. That parent is included because the entry of each topmost created directory lives in it. Each such fsync has the zero-byte flush deadline of 30 seconds (R1 criterion 13). A run that creates no directories adds no fsync beyond R1.2. Reason: F4 applies to every changed directory entry, and a file's Flush does not make a new directory entry durable. The gate covers only copies beneath a created directory. A copy outside every created directory adds no new entry, and a gate on it could not be met once its phone copy had already been deleted.
8. **Stat deadlines during a flush.** A probe or per-file stat on the archive drive starts its deadline only after every Flush and directory fsync pending on that drive has returned or reached its own deadline (R2 criterion 13). That deadline is 3 seconds for a probe or stat, and the flush rule of R1 criterion 12 for the verify read and the purge read in row P20. Each flush keeps its own deadline, from default 5 or from R1 criterion 13, so the wait is bounded. Reason: E1 measures stat latency during a flush. Without this rule, a healthy stat that queues behind a flush would count the flush's wait against its 3-second deadline and fail on a healthy drive.
9. **Probe coverage.** Today only two rows have a bound, and both are kill timers. P4 has a 3-second kill timer in `diskSpaceAsync` (src/util/fs.ts 82). P19 has a 5-second kill timer on its `findmnt` probes (src/serve/doctor.ts 390 to 410). `realSpawn` kills the child with SIGTERM and SIGKILL (src/util/spawn.ts 44 to 53), and the call still awaits the child's exit (src/util/spawn.ts 79). A child stuck on the drive may never exit, so a kill timer does not bound the wait. Every other row has no bound today. Under this spec, rows P2 to P14 and P17 to P19 each get a 3-second deadline (R2.2), and the Engine stops waiting when it expires (R2.3). P4 keeps its 3-second value. P19 takes the 3-second deadline in place of its 5-second kill timer. That deadline ends the child after the Engine has stopped waiting, and no separate kill timer remains. The 3-second value is the one P4 already uses, and E1 tests whether a healthy drive stays within it. P14, the rsync version check, is a host check, so it reports "failed" (R2.3). P15, Doctor's flush of its test file in /tmp, is a flush and not a probe, so it takes the flush deadline of default 5 for the size of that file. P20, the verify read and the purge read, takes the flush rule of R1 criterion 12 for the size of the drive copy. A read of a copy takes time that grows with its size, as a flush does, so a fixed 3-second deadline would fail a healthy large copy. P1 and P16 are covered by R1. P17, the plan's per-file stat, is a synchronous `statSync` (src/plan/plan.ts 168). A synchronous call cannot stop waiting, so P17 meets its 3-second deadline only when the stat runs asynchronously. Rows P1, P2, P3, P5 to P10, P14, P15, and P17 are synchronous today and face the same condition. Reason for every bound: each row reads drive or destination state that a decision depends on, and a call with no deadline can wait without limit, even when it is asynchronous (R2.8).
10. **Gate scope.** The flush-before-delete rule of R1 criterion 13 covers each drive copy beneath a directory this run created. It does not cover copies whose phone copy was deleted earlier in the run, so "each affected drive copy" in R1 criterion 13 means a covered copy whose phone copy is still present. Reason: a phone copy deleted earlier had already passed its gate when it was processed. The Engine cannot restore it, so a later failure cannot undo that deletion. Re-gating it would record a failure for a copy that is already gone.
11. **Parent flush per run.** Each topmost created directory is handled per run, and its existing parent is flushed once for each run. The parent is flushed again only when this run adds another topmost created directory beneath it, because R1 criterion 13 requires a fsync after each new entry (default 7). Reason: a shared parent, such as the destination root, can hold many copies. Under F3, each fsync on the ntfs-3g mount syncs the whole device, so a flush per copy would multiply that cost. Once per run, plus once per further created topmost directory, ties the cost to the directories a run creates, not to the number of files.
12. **Directory fsync deadline.** The deadline of each directory fsync that R1 criterion 13 requires is the zero-byte flush deadline of R1 criterion 12, which is 30 seconds. The directory fsync inside the Flush (R1 criterion 2) stays under the Flush deadline. Reason: the drive copy's data is flushed before any of these fsyncs runs (R1 criterion 9), so the directory fsync has no per-byte work left to scale with. The 30-second base term is the bound that R1 criterion 12 gives a flush with no data. E1 measures directory fsync time in form (3), so the bound is checked on the archive drive.
13. **Failed directory fsync.** A directory fsync that fails or reaches its deadline fails each drive copy beneath that directory that the gate covers (default 10). The failed copy keeps its phone copy, as a failed Flush does (R1 criterion 5). Reason: a failed fsync means the directory entry may not be durable, which is the risk F4 describes. Keeping the phone copy lets a later run copy the file again. Treating the failure as a failed Flush keeps one failure rule for every durability call.

## Appendix A: Probe and flush inventory

| ID | Call | Where | Mechanism today | Deadline today | Covered by |
| --- | --- | --- | --- | --- | --- |
| P1 | Flush of a drive copy (`sync -f`, then bare `sync`) | src/util/fs.ts 25-37; called at src/xfer/adb.ts 106, 176, 273 | Child process, waited on synchronously | None | R1 |
| P2 | Mount check (`findmnt`) | src/index/recovery.ts 162 | Child process, synchronous | None | R2.2 to R2.4, R2.14 |
| P3 | Free space (`df`) through diskSpace | src/util/fs.ts 46; called from src/index/recovery.ts 192 and src/serve/doctor.ts 170 | Child process, synchronous | None | R2.2 to R2.4 |
| P4 | Free space before and after trash emptying | src/serve/dispatch.ts about 1119-1121 | Child process, asynchronous | 3 s (kill timer) | R2.2, R2.3 |
| P5 | Partial-bytes stat before a copy | src/xfer/engine.ts 221 | Child process (stat), synchronous | None | R2.6, R2.7 |
| P6 | Stat after an adb pull | src/xfer/adb.ts 93 | Child process, synchronous | None | R2.6, R2.7 |
| P7 | Stat after an rsync copy | src/xfer/adb.ts 264 | Child process, synchronous | None | R2.6, R2.7 |
| P8 | Stat during verification | src/xfer/engine.ts 364 | Child process, synchronous | None | R2.6, R2.7 |
| P9 | Reconcile stat on verified rows | src/index/recovery.ts reconcile, about line 82 | Child process, synchronous; any error reads as missing | None | R2.5 |
| P10 | Reconcile stat on partial files | src/index/recovery.ts reconcile, about line 102 | Child process, synchronous | None | R2.5 |
| P11 | Survivor stat | src/dedupe/index.ts 429 | Node stat, asynchronous; null on any error | None | R2.9; R4.3 |
| P12 | Drive copy existence check before purge | src/serve/dispatch.ts 269 | Bun.file exists, asynchronous | None | R2.10 |
| P13 | Trash root stat | src/dedupe/trash.ts 83 | Node stat, asynchronous; error reads as "no trash" | None | R2.11 |
| P14 | Rsync binary version check | src/xfer/adb.ts 216 | Child process, synchronous | None | R2.2 (3 seconds), R2.3, R2.8 |
| P15 | Doctor flush of a /tmp file (not the archive) | src/serve/doctor.ts 457 | Child process, synchronous | None | R2.2 (flush deadline of R1 criterion 12), R2.3, R2.8 |
| P16 | Cross-folder move fallback (copy, then remove) | src/util/fs.ts 193-204 | Bun.write, no flush | None | R1.8 |
| P17 | Per-file stat in the plan, on the destination path | src/plan/plan.ts 168 (`statSync` with `throwIfNoEntry: false`) | Node `statSync`, synchronous, in-process. A missing path returns undefined. Any other error throws. | None | R2.2 (3 seconds), R2.3, R2.5 |
| P18 | Doctor's isDirectory checks on the destination root | src/serve/doctor.ts 162 and 244, through `isDirectory` (src/util/fs.ts 181) | `statSafe` (async `stat`). Any error returns null, so `isDirectory` returns false, and line 162 reports the root as "does not exist". | None | R2.2 (3 seconds), R2.3, R2.5 |
| P19 | Doctor's findmnt probes (FSTYPE and OPTIONS) on the destination root | src/serve/doctor.ts 390 to 410 (called at 171 and 172) | Child process through `realSpawn`, asynchronous. A timeout returns code 124, which `probeFstype` reads as "unknown filesystem" and `isReadOnly` reads as not read-only. The call still awaits the child's exit. | 5 s (kill timer) | R2.2 (3 seconds), R2.3 |
| P20 | Verify read and purge read of each drive copy | `sha256File` in src/util/hash.ts, called from `verifyFile` (src/xfer/engine.ts 374) and from the `verifyHash` branch of src/xfer/purge.ts (line 82; the branch starts at line 78) | Bun file reads, asynchronous, in-process. Returns null for a missing file and for a read error. The deadline is set at the two call sites, not inside `sha256File`. | None | R2.2 (flush rule for the file's size), R2.3, R2.10 |

Requirement 2, criterion 2 applies to every row from P2 to P15 and from P17 to P20. Requirement 2, criterion 13 applies to every archive-drive row, P2 to P13 and P17 to P20. Requirement 2, criterion 15 applies to every row from P1 to P15 and from P17 to P20. None of the three is listed in every row's "Covered by" cell. `sampleHash` in src/util/hash.ts is out of scope. The dedupe scan is its only caller (src/dedupe/scan-io.ts 261 and src/dedupe/tier1.ts 164), so this spec sets no deadline for it.

src/device/volumes.ts also bounds its probe with diskSpaceAsync. It is out of scope as volume discovery.

## Changes beyond the brief

- R1.8, the Flush and any directory fsync before a cross-folder move removes its source. The brief does not mention this fallback. C9 shows the gap.
- R1.11, the E1 merge gate. The brief says E1 verifies the device effect. This criterion makes the gate explicit.
- R2.2 and Appendix A rows P9 to P15, and P17 to P20. The brief names the destination check and the copy-path stats. These rows are the same kind of blocking read. R2.2, R2.3, and R2.10 also name P14, P15, and P17 to P20, which default 9 covers.
- R2.13 and default 8. The rule that a stat's 3-second deadline starts after pending flushes is not in the brief. It follows from E1's stat measurement and the flush deadline.
- R2.5 and R2.9 to R2.11. AGENTS.md rule 4 requires "nothing I could read" to stay distinct from "nothing found". C10 shows failed stats reading as absent.
- R2.4. The run path already refuses when the check is not ok (C8). The criterion keeps that behavior.
- R4.3. The survivor stat uses the same gate as R4.1, with one group request per Helper call (decided default 4), and the TypeScript fallback of default 3. R4.2 and R4.13 state the same fallback.
- Directory fsync chain (R1.13, R1.15, default 7). The flush set keeps the owner's definition: every created directory plus the existing parent of each topmost created directory. Two precisions are added. The gate covers only drive copies beneath a created directory, because a gate on an earlier copy cannot be met after its phone copy is deleted. A member is fsynced again only after it gains an entry. R1.4, R1.6, R1.8, and R1.9 include these fsyncs, R1.7 does not block on them, and R1.14 covers them when Bun's fsync fails. Defaults 10 to 13 add four rules: the gate covers only copies whose phone copy is still present (default 10); the existing parent is flushed once per run, and again only when a further topmost created directory is added beneath it (default 11); the deadline of these fsyncs is 30 seconds (default 12); and a failed fsync fails each covered copy and keeps its phone copy (default 13).
- R4.12. AGENTS.md rule 6 asks before deleting a tree. The benchmark deletes only its own fixtures, and this criterion limits that delete.
- R5.7. Host and build are recorded so that the E5 numbers can be compared.
- R6.4 and R6.8. Merge-base judgment for a moved base, and the stale freeze text in C14.
- R7.2, R7.4, and R7.6. Kernel and driver recording, the AGENTS.md drive exercise, and the commit check.
- Label changes. E2 now covers trash deletion only. E3 covers the cross-folder move and the survivor stat. E4 is the owner's definition, Bun fsync on an archive-drive file and its directory. E5 is the frame benchmark, which was E3 before this revision. R4.2, R4.3, R5.6, R5.7, and R7.1 use the new labels. The E1 to E5 definitions are the owner's approved plan.
- Decided defaults. Part 2 of the open questions records thirteen defaults with their reasons. Each default appears in the criterion that uses it: flush per file (R1.1), flush deadline and probe deadlines with no shared bound (R1.5, R1.12, R2.2), Helper directory step (R1.14), created directories (R1.13 and R1.15), gate scope (R1.13 and R1.15), parent flush per run (R1.13), directory fsync deadline (R1.13), failed directory fsync (R1.5 and R1.13), refusal after three timed-out drive calls (R2.12), stat deadlines during a flush (R2.13), probe coverage (R2.2 and R2.3), survivor group requests (R4.3), and TypeScript path for Helper-backed operations (R4.2, R4.3, and R4.13).
- New criteria. R1.12 to R1.15, R2.12, R2.13, R2.15, and R4.13 are new. They follow the last existing criterion in each requirement, so no existing criterion number changed.
- ntfs3 addition. F13 records that the archive drive is a fuseblk ntfs-3g mount. docs/tui.md documents kernel ntfs3 as available, and C16 repeats that claim. /proc/filesystems on this machine lists fuseblk and not ntfs3, so the availability is not confirmed here. Constraints require E1 to run on the mount type in use and to name the driver.
- Open questions 5 to 10 are replaced by Decided by the owner (a) and (b), and the thirteen decided defaults in Part 2.
