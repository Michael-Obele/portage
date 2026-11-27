# Requirements Document

**Feature:** send-to-phone
**Spec type:** feature
**Workflow:** requirements-first
**Status:** Draft for owner review. The owner's sixteen defaults and the author's additions are not approved. Design and tasks start after the owner reviews this document and after spikes S1 to S4 have run.

## Introduction

Portage copies a phone's files onto the archive drive and verifies every byte. This feature adds two send kinds. A drive-to-phone send copies an archive folder onto a folder the owner picks on a phone. A phone-to-phone send copies a phone folder onto a folder on a second phone. adb cannot copy between two phones directly, so the host relays the bytes.

Three rules hold for every send. A send never deletes archive content. A file counts as done only when the bytes on the target phone hash the same as the bytes the send read, and the phone has flushed the file's storage. A result that cannot be proven is reported as not proven, never as done and never as absent.

A phone-to-phone relay takes one of two forms: a stream through host memory, or a temporary file on the host. Spike S1 decides which form is used. Spikes S2 to S4 decide the phone flush call, whether this adb build's stream commands work, and whether the tauri-dev tools can drive the desktop app for the evidence this feature needs.

This spec reuses the probe wrapper and the flush rules of `.kiro/specs/transfer-durability-and-fs-hardening/requirements.md`. That spec is still a draft and is not committed. Requirement 18 sets the order of work.

## Scope and exclusions

**In scope.** Drive-to-phone and phone-to-phone sends: copy, verify, target folder, skip and replace rules, move for phone sources, cancel, plan, progress, and result. Device, deadline, and "could not be read" rules. Phone flush and partial files. The Send screen in the desktop app and its accessibility checks. Engine protocol frames for sends. Unit, contract, ui:sweep, and tauri-dev tests, and real-device runs with hash records. Spikes S1 to S4.

**Out of scope.** Copying from a phone to the archive (that is the existing pull). Any drive other than the archive. Wi-Fi adb. Changes to `scripts/apull.sh`, `crates/portage-scan`, `src/scan`, or the pull's behaviour, resume rules, journal rows, and timeouts. Choosing individual files (Q5). Scan progress. Windows and Apple.

**Constraints.** AGENTS.md binds this feature, including its definition of done. No requirement here needs a new crate or package (Requirement 18).

## Verified facts

Facts the owner supplied are marked X. Facts checked on this host are marked H. Facts read from the repository are marked C. Line numbers refer to the current tree.

### Supplied by the owner

| ID  | Fact                                                                                                                                                    | Source                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| X1  | `adb shell` allocates a terminal by default. The terminal turns LF into CRLF and corrupts binary output. `adb exec-out` is the binary-safe output path. | developer.android.com/tools/adb; Stack Overflow question 11689511. Owner-supplied, not re-checked. |
| X2  | Whether `adb exec-in` exists in this adb build is unverified.                                                                                           | Owner. Spike S3 tests it.                                                                          |

### Checked on this host

| ID  | Fact                                                                                                                                                                                                                                                                    | Source                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| H1  | adb is `Android Debug Bridge version 1.0.41` (build 36.0.0-13206524), at /home/node/android/platform-tools/adb.                                                                                                                                                         | `adb version`                       |
| H2  | `adb help` lists `push [--sync] [-z ALGORITHM] [-Z]`, and says `--sync` pushes only files whose timestamps differ between host and device. It lists `shell [-e ESCAPE] [-n] [-Tt]`, and says `-T` disables pty allocation. It names no `exec-out` or `exec-in` command. | `adb help`                          |
| H3  | `adb devices` lists no device.                                                                                                                                                                                                                                          | `adb devices`                       |
| H4  | `lsblk` shows no USB disk and no mount under /media. `lsusb -t` shows no mass-storage or Android device. The archive drive is not attached to this host now. The request says it is attached but not mounted, and this check does not confirm that.                     | `lsblk`, `/proc/mounts`, `lsusb -t` |
| H5  | Branch is master at v0.1.17. `.kiro/specs/` is untracked, so the transfer-durability spec is not committed and its rules are not yet in code.                                                                                                                           | `git status`, `git log`             |

### Read from the repository

| ID  | Fact                                                                                                                                                                                                                                                      | Source                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| C1  | `Adb.shell` defaults to a 30 s timeout. `hashRemote` runs `sha256sum` with 300 s. `pull` defaults to 3,600,000 ms. None of them is a 3 s probe deadline.                                                                                                  | src/device/adb.ts 239, 298-300, 320                                                      |
| C2  | The device id is `sha1(ro.serialno)`. If `ro.serialno` cannot be read, the id becomes the hash of the adb serial instead.                                                                                                                                 | src/device/adb.ts 200-203, 422-425                                                       |
| C3  | `selectReady` filters ready phones by id prefix, serial, or model.                                                                                                                                                                                        | src/device/adb.ts 491-513                                                                |
| C4  | `deviceFreeBytes` reads `df -k /sdcard`, a fixed path, not the volume of the target folder.                                                                                                                                                               | src/device/adb.ts 223-229                                                                |
| C5  | `realSpawn` sets stdin to ignore and decodes stdout as text. A binary stream, or a write that needs stdin, cannot use it.                                                                                                                                 | src/util/spawn.ts 40, 61, 77                                                             |
| C6  | The pull path runs `sync -f` after each copy. The engine states that exit code 0 is never enough, and that verification needs the phone's own hash.                                                                                                       | src/xfer/adb.ts 106, 128; src/xfer/engine.ts 14-21, 353                                  |
| C7  | Today a destination file of the same size is skipped as already on the drive.                                                                                                                                                                             | src/plan/plan.ts 168-171                                                                 |
| C8  | Overwrite is refused. A name collision is skipped, never overwritten.                                                                                                                                                                                     | src/serve/dispatch.ts 344-350                                                            |
| C9  | `pickDevice` takes the first ready phone when no filter is given.                                                                                                                                                                                         | src/serve/dispatch.ts 169-176                                                            |
| C10 | The command loop awaits each `dispatch` before it reads the next line, so a long handler blocks the commands behind it.                                                                                                                                   | src/serve/index.ts 145-148                                                               |
| C11 | A second `pull.start` is refused while a run is active. `pull.stop` takes effect between files.                                                                                                                                                           | src/serve/run.ts 113-118, 186-193                                                        |
| C12 | The confirm gate returns `needsConfirm` first, and acts only when `confirm` equals the record id. `trash.empty` re-reads the trash and refuses when its counts changed.                                                                                   | src/serve/dispatch.ts 823-833, 942, 1094                                                 |
| C13 | Pending records expire after 10 minutes.                                                                                                                                                                                                                  | src/serve/pending.ts 25                                                                  |
| C14 | `browse` throws only when both listings fail and return nothing. If one listing fails and the other succeeds, it returns the surviving listing with no error. The cap is `BROWSE_LIMIT`, 500.                                                             | src/serve/browse.ts 120-124                                                              |
| C15 | The `needsConfirm` action list is `dupes.apply`, `purge.apply`, `trash.empty`.                                                                                                                                                                            | src/serve/protocol.ts 456                                                                |
| C16 | The frame schema table has 19 frame types, including `trash` at line 519.                                                                                                                                                                                 | src/serve/protocol.ts 505-522                                                            |
| C17 | The Rust shell's frame list has 18 names and omits `trash`.                                                                                                                                                                                               | apps/desktop/src-tauri/src/engine.rs 85                                                  |
| C18 | The run path sets `linkMbps` to null for every device. Doctor's link figure is the fastest speed on any bus, not one phone's.                                                                                                                             | src/serve/sink.ts 108; src/serve/doctor.ts 111-117, 379-388                              |
| C19 | The 480 Mbit auto-drop is a recorded decision (docs/decisions.md line 25) and a planned milestone (docs/milestones.md 123). No TypeScript code implements it. `isUsb2` only feeds doctor's warning. TODO.md 196 says auto-drop is not confirmed by a run. | docs/decisions.md 25; docs/milestones.md 123; TODO.md 196; src/device/adb.ts 478-481     |
| C20 | The global `jobs` setting defaults to 3, with a range of 1 to 8. Each device may override it.                                                                                                                                                             | src/config/schema.ts 93 and the device schema                                            |
| C21 | `delete_source` defaults to `after-verify`, so pulls delete phone copies by default.                                                                                                                                                                      | src/config/schema.ts 95                                                                  |
| C22 | `space_headroom` defaults to 0.02 of a volume. The drive check runs `findmnt` and `df` synchronously, with no deadline.                                                                                                                                   | src/config/schema.ts 97; src/index/recovery.ts 157                                       |
| C23 | In-flight suffixes include `.part`, `.tmp`, and `.crdownload`. `quiet_seconds` defaults to 120.                                                                                                                                                           | src/config/schema.ts 92, 123-131; src/scan/scan.ts 81-84, 92                             |
| C24 | Never-scan folders include `Android/data`, `Android/obb`, and `.portage`.                                                                                                                                                                                 | src/config/schema.ts 133-148                                                             |
| C25 | The journal appends events to `events.jsonl`.                                                                                                                                                                                                             | src/index/journal.ts 10, 225, 608                                                        |
| C26 | The CLI script already streams phone to phone: `exec-out tar -c` piped into `exec-in tar -x`, under `set -uo pipefail`. Its skip rule and its check both use size.                                                                                        | scripts/apull.sh 13-23, 31, 238-255; docs/apull.md 221-227                               |
| C27 | The apull phone-to-phone path was verified on a 2 MB file with md5sum only.                                                                                                                                                                               | docs/apull.md 226-227                                                                    |
| C28 | The desktop app has no Send screen. The rail has seven screens, with chord letters h, p, t, d, u, o, s.                                                                                                                                                   | apps/desktop/src/routes/+layout.svelte 48-56                                             |
| C29 | A URL does not count as a click. The transfer screen mints a one-shot token on a click and consumes it once.                                                                                                                                              | apps/desktop/src/lib/state/screens.svelte.ts 208-241                                     |
| C30 | The confirm sheet is an alert dialog with a typed confirm word and a list of paths.                                                                                                                                                                       | apps/desktop/src/lib/components/app/confirm-sheet.svelte                                 |
| C31 | The progress labels are "Instant rate", "Average rate", and "Time left". Time left shows a dash until 3 samples and 30,000,000 bytes exist. A stall shows after 10 s.                                                                                     | apps/desktop/src/lib/components/app/transfer-hero.svelte; src/serve/view.svelte.ts 26-32 |
| C32 | The live region announces at most once every five seconds, in file counts and never in bytes.                                                                                                                                                             | apps/desktop/src/lib/state/run.svelte.ts 23; apps/desktop/src/lib/state/run.ts           |
| C33 | Destinations are refused for read-only, unknown access, the root filesystem, and the boot filesystem.                                                                                                                                                     | apps/desktop/src/lib/components/app/destinations.ts                                      |
| C34 | Preferences live in localStorage under named keys, and every read passes a validator.                                                                                                                                                                     | apps/desktop/src/lib/state/prefs.ts 28                                                   |
| C35 | The contrast gate measures text at 7:1 and non-text at 3:1. CI runs it.                                                                                                                                                                                   | apps/desktop/scripts/contrast.ts 17, 19; .github/workflows/ci.yml 125-126                |
| C36 | CI's frozen-files check covers src/xfer, src/index, src/plan, and src/scan.                                                                                                                                                                               | .github/workflows/ci.yml 89-95                                                           |
| C37 | TODO M8-1, two phones attached at once, is marked "Never tested".                                                                                                                                                                                         | TODO.md 251                                                                              |
| C38 | The desktop plan records "no phone-to-phone streaming in v1". This request reverses that for the app.                                                                                                                                                     | docs/plans/2026-11-08-desktop-app/truth.md 100; gaps.md G4                               |

## Glossary

- **Archive drive**: the local volume that holds the archive. Its mount is checked before a drive-to-phone send (Requirement 6).
- **Archive folder**: a folder under the archive drive's destination root, chosen as the source of a drive-to-phone send.
- **Cancel**: the owner's request to stop a send. Requirement 11 sets its effect.
- **Confirm word**: the word the owner must type on the confirmation sheet before a send starts (Requirement 12).
- **Could not be read**: the result for a read, stat, hash, or listing that did not finish within its deadline, or that failed for a reason other than a missing path. It is never reported as missing, absent, zero, or healthy.
- **Desktop app**: the SvelteKit screens and the Rust shell in `apps/desktop`.
- **Device id**: a phone's stable id, `sha1(ro.serialno)`, as C2 describes.
- **Done**: a file whose verification (Requirement 9) succeeded, whose two flushes (Requirement 10) succeeded, and whose final name exists on the target phone.
- **Drive-to-phone send**: a send whose source is an archive folder and whose target is a folder on a phone.
- **Engine**: the `dist/portage` process that the Desktop app starts. It reads one command per stdin line and writes one frame per stdout line.
- **Flush on the phone**: a `sync` on the target phone. A file is flushed twice: once after its verified temporary file is written, and once after its rename (Requirement 10).
- **Host temporary file**: a file the host writes during a temporary file relay. It is never written to the archive drive.
- **Hash record**: a committed record of one real-device run. It lists each file's hashes, the path that ran, the flush outcome, the final state, and the raw command output.
- **Leftover partial**: a temporary file that a send wrote and did not remove, found in a target folder by a later plan.
- **Move**: an option for a phone-to-phone send that deletes each source file after its copy is done and re-checked. It is never offered for a drive source.
- **MB**: 1,000,000 bytes, as in the transfer-durability spec's flush rule. A 400 MB file is 400,000,000 bytes.
- **Partial file**: any temporary file a send writes before its rename, on a phone or on the host. A partial file is never done.
- **Phone**: an Android device attached over adb whose adb state is `device`.
- **Phone-to-phone send**: a send whose source is a phone folder and whose target is a folder on a different phone.
- **Plan**: the read-only result of a send's planning. It is stored under the send id until the owner confirms it or it expires.
- **Probe**: a read of drive or phone state that a decision depends on. Each probe has a deadline. The transfer-durability spec's Requirement 2 defines the wrapper.
- **Relay**: the path a phone-to-phone file takes through the host. The stream relay and the temporary file relay are the two forms.
- **Replaced**: a target file that a verified copy overwrote by rename, because the owner chose replace for that send.
- **Send**: one run of a send job, from its plan through its result. Each send has one send id.
- **Send id**: the id of a stored plan. The owner's confirm must echo it.
- **Skipped**: a file the send did not copy, with a reason. The reasons are "already there", "different file at this path", and the refusals in Requirement 7 and Requirement 8.
- **Source**: the folder the owner chose to copy from. The files under it are source files.
- **Spike record**: the committed output of spike S1, S2, S3, or S4.
- **Stall**: a write or relay that moves no bytes for 30 seconds (default D18).
- **Stream relay**: a phone-to-phone form in which the host passes bytes from one phone to the other through memory, with no host file.
- **Target**: the phone and the folder on it that receive the files.
- **Temporary file relay**: a phone-to-phone form in which the host stores each file in a host temporary file between the two phones.
- **Temporary name**: the name a partial file carries in the target folder. It has the Portage marker and the `.part` suffix (Requirement 10).
- **Verified**: a file whose hash comparison in Requirement 9 succeeded.

## Requirements

### Requirement 1: Spike S1, binary-safe stream in both directions

**User Story:** As the owner, I want proof that bytes which pass through the host arrive unchanged in both directions, so that the stream relay is used only when its bytes are known to match.

#### Acceptance Criteria

1. WHEN spike S1 streams a 400 MB test file from a phone to the host with `adb exec-out cat`, THE spike record SHALL show the SHA-256 of that file on the phone, computed with `sha256sum`, and the SHA-256 of the bytes the host received, and SHALL state whether the two are equal.
2. WHEN spike S1 streams the same file from the host to a phone with `adb shell -T cat`, THE spike record SHALL show the SHA-256 of the host file and the SHA-256 of the copy on the phone, computed with `sha256sum` after the stream ends, and SHALL state whether the two are equal.
3. WHEN spike S1 runs, THE spike record SHALL include a control copy of the same file through `adb shell` without the `-T` flag, with its SHA-256 on the phone, so that the owner can see whether the terminal changes the bytes (X1).
4. WHEN spike S1 runs, THE spike record SHALL show the file size in bytes, the adb version, the device id and Android version of each phone, and the wall time of each stream.
5. THE spike S1 SHALL pass only when criteria 1 and 2 both show equal hashes, and THE spike record SHALL state the result as "pass" or "fail".
6. IF spike S1 does not pass, THEN THE Engine SHALL relay every phone-to-phone file by the temporary file relay (D3), and THE spike record SHALL name each failed direction with the two hashes that differ.
7. WHEN spike S1 runs its host-to-phone direction, THE spike record SHALL also show the same file written with `adb push` and its SHA-256 on the phone, so that the drive-to-phone write method is chosen from measured results (D3).
8. THE spike S1 SHALL delete only the test files that it created, on each phone and on the host, and SHALL refuse to run in a folder that contains any file it did not create.

### Requirement 2: Spike S2, sync on the phone

**User Story:** As the owner, I want to know whether `sync` on the phone flushes its storage and how long it takes, so that a file is recorded as done only after a flush that has been measured.

#### Acceptance Criteria

1. WHEN spike S2 runs, THE spike record SHALL state whether the `sync` command exists on each tested phone, and SHALL state the exit status of `sync` when it runs.
2. WHEN spike S2 runs, THE spike record SHALL show the Dirty and Writeback values that the phone reports for its storage before and after a `sync` that follows a 300 MB write, and SHALL show the time that `sync` took.
3. IF the phone does not report Dirty and Writeback values, THEN THE spike record SHALL say so and SHALL name the measure used to decide whether the flush happened.
4. WHEN spike S2 runs, THE spike record SHALL state whether `sync` flushed the phone's storage, or SHALL state that the result could not be determined.
5. THE spike S2 SHALL pass when criteria 1, 2, and 4 are answered in the record. A negative answer to criterion 4 is a valid pass, because it sends the choice to the owner (D6, Q1).
6. IF the record shows that `sync` does not flush phone storage, or that the result could not be determined, THEN THE send feature SHALL NOT merge until the owner decides the durability rule (Q1).
7. THE spike S2 SHALL delete its 300 MB test file from the phone after each run.

### Requirement 3: Spike S3, adb exec-in in this build

**User Story:** As the owner, I want to know whether `adb exec-in` exists in this adb build and moves bytes unchanged, because the repository's apull script already depends on it.

#### Acceptance Criteria

1. WHEN spike S3 runs, THE spike record SHALL state the adb version, whether `adb exec-in` runs, and whether `adb help` lists `exec-in` and `exec-out` (H2).
2. IF `adb exec-in` runs, THEN THE spike record SHALL show the SHA-256 of the 400 MB host file and the SHA-256 of the copy on the phone after an `adb exec-in` write, and SHALL state whether the two are equal.
3. IF `adb exec-in` does not run, THEN THE spike record SHALL show the error output of that run and SHALL state that the command is absent from this build.
4. IF `adb exec-in` is absent, THEN THE spike record SHALL state that the phone-to-phone path of `scripts/apull.sh`, which runs `exec-in tar -x` (C26), cannot run on this build.
5. THE spike record SHALL show the file size used for each check, so that the 2 MB check documented for apull (C27) is not mistaken for the 400 MB result.
6. THE spike S3 SHALL pass when criterion 1 is answered and either criterion 2 shows equal hashes or criterion 3 records the absence.

### Requirement 4: Spike S4, tauri-dev reaches the debug app

**User Story:** As the owner, I want the tauri-dev tools to drive the debug build of the desktop app, so that each Send flow can be checked on the real app with evidence.

#### Acceptance Criteria

1. WHEN spike S4 runs, THE spike record SHALL show that the debug shell was built with the command in AGENTS.md, `SKIP_BUILD=1 bunx tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json`, and SHALL show the time at which the app started.
2. WHEN spike S4 runs, THE spike record SHALL show a driver session that connected after the app started, a webview screenshot file, and the text of `document.body.innerText` read through the driver.
3. THE spike S4 SHALL pass when criterion 2 succeeds: the screenshot file exists, and the DOM read returns text.
4. IF the driver session cannot connect, THEN THE spike record SHALL show the tool's error text, and THE journeys in Requirement 16 SHALL NOT be recorded as passed until spike S4 passes.
5. THE spike record SHALL show the Content Security Policy in `apps/desktop/src-tauri/tauri.conf.json` before and after the spike, and SHALL show that the production file is unchanged (AGENTS.md, Driving the real app, step 2).

### Requirement 5: Device identity and phone rules

**User Story:** As the owner, I want every send to name its phones by identity, and to refuse any send that could copy a phone onto itself or pick a phone I did not choose.

#### Acceptance Criteria

1. THE Engine SHALL name each phone in a send command by its device id, and SHALL refuse a phone argument that is not the device id of an attached phone (D11; C2).
2. IF the device id of either phone cannot be read from `ro.serialno`, THEN THE Engine SHALL refuse the send and SHALL name that phone by its adb serial and model (D11; C2).
3. WHEN a send is planned or started, THE Engine SHALL refuse the send if the source and the target share a device id or an adb serial (D11).
4. WHEN a phone-to-phone send is planned or started, THE Engine SHALL require exactly two ready phones and SHALL name both by device id. IF the number of ready phones is not two, THEN THE Engine SHALL refuse the send and SHALL list each ready phone by device id and model (D11).
5. WHEN a drive-to-phone send is planned or started, THE Engine SHALL require the owner to name the target phone, and SHALL NOT choose a phone when none is named (D11; C9).
6. IF a named phone is not in the ready state, THEN THE Engine SHALL refuse the send and SHALL state the state the phone reported (unauthorized, offline, or unknown). WHEN the state is unauthorized, THE Engine SHALL give the fix "accept the USB debugging prompt on the phone".
7. WHILE a pull or a send is running, THE Engine SHALL refuse to start the other kind of job (D21; C11).
8. WHEN a phone in a running send stops being in the ready state, THE Engine SHALL fail the file in progress with the reason "phone not attached", and SHALL stop the send at the next file boundary (D26).
9. WHEN three phone calls in a row reach their deadlines, THE Engine SHALL end the send and SHALL report that phone as "could not be read" (D25; transfer-durability R2.12, applied to phones).
10. WHEN a send ends, THE result SHALL record the device id of each phone that the send used (C37).

### Requirement 6: Archive source checks and honest reads

**User Story:** As the owner, I want a drive-to-phone send to refuse an archive that is not mounted, is read-only, or sits on the root filesystem, and to say plainly when a read on the drive did not finish.

#### Acceptance Criteria

1. WHEN a drive-to-phone send is planned or started, THE Engine SHALL run the mount check of transfer-durability R2.14 on the archive root (D12; C22).
2. WHEN the mount check cannot read the archive mount, THE Engine SHALL refuse the send with the result "could not be read", and SHALL NOT report the archive as absent, healthy, or read-only (transfer-durability R2.3).
3. THE Engine SHALL give each archive probe the 3-second deadline of transfer-durability R2.2, and SHALL give each read of an archive file's contents the size rule of transfer-durability R1.12 (D12, D18).
4. WHEN an archive probe or read reaches its deadline, THE Engine SHALL stop waiting, SHALL end the send before it starts another file, and SHALL report the archive as "could not be read" (transfer-durability R2.3).
5. WHEN a source file on the archive fails a stat or a read for any reason other than a missing path, THE Engine SHALL report that file as "could not be read" and SHALL NOT send it (transfer-durability R2.5).
6. WHEN a source file on the archive is missing when the send reaches it, THE Engine SHALL report that file as "missing since the plan" and SHALL NOT send it.
7. THE Engine SHALL NOT delete, move, or rename any file or folder on the archive drive in any send (D1).
8. THE Engine SHALL refuse a source folder that lies outside the archive mount, or that lies inside `.portage` (C24).
9. THE archive folder listing SHALL state which walker ran, the scanner or the glob walker (AGENTS.md rule 4).
10. WHEN three archive drive calls in a row reach their deadlines, THE Engine SHALL end the send and SHALL report the archive as "could not be read" until the Engine restarts (transfer-durability R2.12).

### Requirement 7: Drive-to-phone send

**User Story:** As the owner, I want to copy an archive folder onto a folder I pick on a phone, with what is already there skipped and nothing overwritten unless I say so.

#### Acceptance Criteria

1. THE Engine SHALL place each source file under the target folder, at the path it has relative to the source folder the owner chose (D2; Q2).
2. THE Engine SHALL create a missing folder only beneath the target folder, and SHALL list each folder it created in the result (D2).
3. THE Engine SHALL accept as the target folder only a folder that exists on the target phone when the plan is made (D2).
4. THE Engine SHALL compute the SHA-256 of each source file from the file on the archive drive as it is at the start of the send, and SHALL NOT use a hash stored in the archive journal (AGENTS.md rule 5).
5. WHEN the target folder holds a file at the same relative path, with the same size and the same SHA-256 computed on the target phone, THE Engine SHALL skip that file and SHALL report it as "already there" (D8).
6. WHEN the target folder holds a file at the same relative path whose size or SHA-256 differs, THE Engine SHALL skip that file, SHALL report it as "different file at this path", and SHALL NOT overwrite it unless the owner chose replace for this send (D8).
7. THE Engine SHALL decide every skip from hashes on both sides, and SHALL NOT decide a skip from size alone (D8; C7).
8. IF a target path cannot be read by a stat or a hash within its deadline, THEN THE Engine SHALL NOT copy that file and SHALL report it as "could not be read on the phone" (transfer-durability R2.5; D18).
9. IF a target path is a folder, THEN THE Engine SHALL NOT copy that file and SHALL report it as "a folder is at this path".
10. WHEN two source files would map to target paths that differ only in letter case, THE Engine SHALL refuse both files and SHALL report a name collision (D27).
11. WHEN the owner chooses replace for a send, THE Engine SHALL replace a differing target file only with a verified copy that is renamed over it (D23).
12. THE Engine SHALL write each file first to a temporary name in the target folder, using a binary-safe write method that Requirement 1 criterion 7 or Requirement 3 shows to be binary-safe. THE Engine SHALL NOT use `adb push --sync` or compression (D3; D27; H2).
13. IF the free space on the phone volume that holds the target folder cannot be read, THEN THE Engine SHALL refuse the send with the result "could not be read" (D20).
14. WHEN the free space on that volume is readable but less than the bytes to write plus the headroom in D20, THE Engine SHALL refuse the send and SHALL state the shortfall (D20).
15. WHEN a source file has zero bytes, THE plan SHALL show that file as a file to copy (Q4).

### Requirement 8: Phone-to-phone send

**User Story:** As the owner, I want to copy a folder from one phone to another through the host, and to keep the host's disk out of it when the stream is proven.

#### Acceptance Criteria

1. WHILE spike S1 has passed, THE Engine SHALL relay each phone-to-phone file by the stream relay. The stream relay pipes the source phone's `adb exec-out cat` output into the target phone's `adb shell -T cat` input, and the host SHALL hash every byte it passes (D3).
2. IF spike S1 has not passed, THEN THE Engine SHALL relay each phone-to-phone file by the temporary file relay (D3).
3. WHEN the temporary file relay is used, THE Engine SHALL write a host temporary file only after a free-space check on the host volume that holds it passes. That check SHALL cover every temporary file that can exist at the same time (D20).
4. IF the free-space check fails, or cannot read the free space, THEN THE Engine SHALL refuse that file and SHALL state whether the check failed or could not be read (D20).
5. THE Engine SHALL keep every host temporary file off the archive drive, SHALL remove each one when its file ends (done, failed, or cancelled), and SHALL list by path each host temporary file it could not remove.
6. WHEN a stream relay ends, THE Engine SHALL count the bytes that passed, and SHALL count the file as copied only if the byte count equals the source size and both stream processes exit with status 0 (D5).
7. WHILE a stream relay or a temporary file relay moves no bytes for 30 seconds, THE Engine SHALL stop both sides of that transfer and SHALL fail the file with the reason "stalled" (D18).
8. THE Engine SHALL state the relay that ran, stream or temporary file, for each file in the plan and in the result (D13).
9. WHEN the owner has not chosen move for a phone-to-phone send, THE Engine SHALL delete no file on either phone (D1).
10. THE Engine SHALL offer move only for a phone-to-phone send, and SHALL NOT offer it for a drive-to-phone send, because a send never deletes archive content (D1).
11. WHEN the owner chooses move, THE Engine SHALL delete a source file only when all of these hold: the file was copied and verified in this send, its final file on the target phone is flushed and renamed, a fresh SHA-256 of that final path equals the source SHA-256, and the owner confirmed the move (D22).
12. IF a source delete fails or cannot be confirmed, THEN THE Engine SHALL report that file as "copied, source kept", with the reason, and SHALL NOT count it as moved.
13. IF the size of a source file at the start of its copy differs from its size in the plan, THEN THE Engine SHALL fail that file with the reason "changed since the plan" and SHALL NOT copy it.
14. WHILE the phone-to-phone relay is in use, THE Engine SHALL verify each file with the three hashes of Requirement 9 criterion 2 (D5).
15. WHEN a phone source file's name carries an in-flight suffix, or its modification time is within `quiet_seconds` of the plan, THE plan SHALL skip that file and SHALL report the reason (D19; C23).

### Requirement 9: Verification by hash

**User Story:** As the owner, I want a file counted only when the bytes on the target phone match the bytes the send read, so that a corrupt copy is never reported as done.

#### Acceptance Criteria

1. WHEN a temporary file is written on a target phone, THE Engine SHALL compare its SHA-256, computed on the phone with `sha256sum`, with the source's SHA-256, before the rename (D5).
2. WHEN a phone-to-phone file is copied by the stream relay, THE Engine SHALL compare the source phone's SHA-256, the host's SHA-256 of the streamed bytes, and the target phone's SHA-256 of the temporary file. THE Engine SHALL treat the file as verified only when all three are equal (D5).
3. WHEN a drive-to-phone file is written, THE Engine SHALL compare the archive file's SHA-256, computed on the host, with the target phone's SHA-256 of the temporary file (D5).
4. THE Engine SHALL count a file as verified only after the comparisons in criteria 1 to 3 succeed, and SHALL NOT count a file as verified because a copy command exited with status 0 (C6).
5. IF a hash comparison fails, THEN THE Engine SHALL fail the file with the reason "content differs", SHALL show the first 12 characters of each hash, SHALL remove its temporary file, and SHALL leave the source and any existing target file untouched.
6. IF a hash cannot be read within its deadline (D18), THEN THE Engine SHALL fail the file with the reason "could not be read", not "content differs", and SHALL remove its temporary file.
7. THE Engine SHALL compute every SHA-256 on both sides with the same algorithm, SHA-256 (D5).

### Requirement 10: Phone flush, temporary names, and partial files

**User Story:** As the owner, I want a file recorded as done only after the phone has flushed it, and no partial file left looking finished, so that a phone that loses power never shows a file that is not complete.

#### Acceptance Criteria

1. THE Engine SHALL write each file's bytes only to a temporary name in the target folder, and SHALL NOT write to the final name until the verification in Requirement 9 succeeds (D7).
2. THE temporary name SHALL start with a fixed Portage marker and SHALL end in `.part`, which the scan already treats as in flight (C23). A pull therefore never offers a partial as media (D7).
3. WHEN a temporary file is verified, THE Engine SHALL flush the phone's storage with the flush call that spike S2 selects, before the rename (D6).
4. WHEN the first flush succeeds, THE Engine SHALL rename the temporary file to the final name in the same target folder (D6).
5. WHEN the rename succeeds, THE Engine SHALL flush the phone's storage again before it records the file as done (D17).
6. THE Engine SHALL record a file as done only after the verification and both flushes have succeeded (D5; D6; D17).
7. IF a flush fails or reaches its deadline (D18), THEN THE Engine SHALL fail the file with the reason. IF that flush came after the rename, THEN THE Engine SHALL report the file as "in place, not confirmed flushed" and SHALL NOT report it as done.
8. IF a file fails or is cancelled before its rename, THEN THE Engine SHALL remove its temporary file and SHALL report the removal. IF the removal fails or cannot be confirmed, THEN THE result SHALL list that temporary file by path as a leftover partial (D7).
9. THE Engine SHALL NOT count a partial file as done, skipped, or existing, in any result, plan, or progress view (D7).
10. WHEN a send starts a file, THE Engine SHALL create a new temporary name, and SHALL NOT append to or reuse an existing partial (D9).
11. WHEN a plan reads a target folder, THE plan SHALL list each leftover partial, meaning a file with the Portage marker and the `.part` suffix, as a leftover, and SHALL NOT count it as a file of the send (D7).
12. THE Engine SHALL delete no leftover partial in any send. The only temporary file that a send deletes is its own, under criterion 8 (D7).

### Requirement 11: Cancel, concurrency, and the 480 Mbit rule

**User Story:** As the owner, I want to stop a send at any moment without restarting the Engine, with one job at a time and a cautious number of files in flight to each phone.

#### Acceptance Criteria

1. THE Engine SHALL run a send job without holding the command loop, so that status and cancel requests are answered while a send runs (C10).
2. WHEN the owner requests cancel, THE Engine SHALL answer the request without waiting for the file in progress (D10).
3. WHEN a cancel arrives while a file's bytes are being written to its temporary name, THE Engine SHALL stop that file's transfer processes, SHALL remove its temporary file under Requirement 10 criterion 8, and SHALL start no further file (D10).
4. WHEN a cancel arrives after a file has been renamed into place, THE Engine SHALL complete that file's second flush before it stops, and SHALL report the file as done or failed by that flush (D10; D17).
5. WHEN a cancel arrives during a temporary file relay, THE Engine SHALL remove the host temporary file that the relay created (D10; Requirement 8 criterion 5).
6. WHEN a send is cancelled, THE Engine SHALL NOT delete any source file whose copy was not verified in that send (D10; D22).
7. WHEN a send is cancelled, THE Engine SHALL keep the same process identifier, so that the Engine is not restarted (D10).
8. WHEN a send ends, THE result SHALL assign exactly one final state to each planned file (Requirement 13 criterion 4).
9. THE Engine SHALL run at most one send job at a time (D21).
10. THE Engine SHALL keep one file in flight to a target phone by default (D4).
11. WHERE the owner raises the number of files in flight for one send, THE Engine SHALL accept a number no greater than the existing `jobs` setting, which defaults to 3 and allows up to 8 (D4; C20).
12. WHILE a target phone's link speed is 480 Mbit/s or less, THE Engine SHALL keep one file in flight to that phone, whatever the owner chose (D4; C19).
13. IF the link speed of a target phone cannot be read, or cannot be attributed to that phone, THEN THE Engine SHALL keep one file in flight to that phone and SHALL report the link as "not read" (D4; C18).
14. IF a relay or a write stalls (Requirement 8 criterion 7), THEN THE Engine SHALL fail only that file, and SHALL continue with the next file while both phones remain ready (D18).

### Requirement 12: Confirmation gate and one-way doors

**User Story:** As the owner, I want every send that replaces or moves files to show exactly what it will change, and to act only after I confirm the same plan.

#### Acceptance Criteria

1. WHEN the owner asks for a send, THE Engine SHALL build the plan, store it under a send id, and answer with a needs-confirm result that names the target phone and folder, the file count, the bytes, each skip with its reason, each file to be replaced, and whether a move is included (C12).
2. THE Engine SHALL start no file write, rename, replace, or delete until the owner's confirm echoes the send id of that result.
3. IF the confirm does not match the send id, THEN THE Engine SHALL answer again with the needs-confirm result and SHALL NOT act (C12).
4. IF the confirm arrives more than 10 minutes after the plan was stored, THEN THE Engine SHALL refuse the send and SHALL ask for a new plan (C13; D24).
5. WHEN the confirm arrives, THE Engine SHALL re-read the target folder and the source listing. IF the file count or the bytes differ from the stored plan, THEN THE Engine SHALL refuse the send, SHALL return the new plan, and SHALL ask for confirmation again (C12; D24).
6. THE Engine SHALL replace a target file only at a target path that the stored plan listed for this send id (D23; C12).
7. THE Engine SHALL delete a source file only at a source path that the stored plan listed for this send id (C12).
8. THE confirm word on the sheet SHALL be "move" when a move is included, otherwise "replace" when any file will be replaced, and otherwise "copy" (D14; C30).
9. THE sheet SHALL state in words what leaves a phone for a move, what is replaced on the target for a replace, and that a copy changes nothing on either phone.
10. THE sheet SHALL list every path that will be replaced or deleted, or SHALL state how many paths the list does not show (D14; C30).

### Requirement 13: Plan, progress, and result

**User Story:** As the owner, I want the plan, the progress, and the result to show counts that add up, the reason for each skip, and the path that ran, so that I can trust every number.

#### Acceptance Criteria

1. THE plan SHALL show the target phone (model and device id), the target folder, the number of files to copy and their bytes, each skip with its reason, each file to be replaced, whether a move is included, the relay that will run for each phone-to-phone file, the free-space result, and the link speed or "not read" (D13).
2. THE plan SHALL state the number of files in the source, and SHALL state a count of files to copy, skipped, refused, and not readable. Those four counts SHALL add up to the number of source files (D13).
3. THE progress view SHALL show the file in progress, the bytes copied so far for the send, "Instant rate", "Average rate", and "Time left", labelled as the transfer screen labels them (D13; C31).
4. THE result SHALL assign each planned file exactly one final state from this list: verified and done; replaced; skipped, already there; skipped, different file at this path; refused, with the reason; could not be read on the source; could not be read on the target; missing since the plan; failed; cancelled; not started; copied, source kept; in place, not confirmed flushed. THE counts of those states SHALL add up to the number of planned files.
5. THE result SHALL name the relay or the write method that ran for each file (D13).
6. THE result SHALL state the flush outcome for each file that is done (D6; D17).
7. THE result SHALL list by path each folder that the send created, each leftover partial, and each host temporary file that remains (D2; D7).
8. WHEN a move has run, THE result SHALL state the free space of the source phone before and after the send, as read with `df` (C4; AGENTS.md definition of done, item 2).
9. THE progress view and the result SHALL take every number from the Engine's frames, and THE Desktop app SHALL NOT compute a rate, a count, or an estimate of its own (C31).
10. THE Engine SHALL report progress figures with the same meaning as the existing overall figures: bytes done and total, files done and total, failed, skipped, the instant and average rates, and the estimate of time left (C31; src/serve/sink.ts).
11. WHEN a file in progress has moved no bytes for 10 seconds, THE progress view SHALL show that file as "stalled", with the number of seconds (C31).
12. THE Engine SHALL write each send's result to the record location that the owner confirms in Q6 (C25).

### Requirement 14: Desktop Send flow and accessibility

**User Story:** As the owner, I want the Send flow to take me through source, target, plan, confirmation, progress, and result in one place, and to work from the keyboard.

#### Acceptance Criteria

1. THE Desktop app SHALL offer a Send screen in the navigation rail, reachable with a `g` chord letter that no other screen uses. The letters in use are h, p, t, d, u, o, and s (C28). THE keyboard map SHALL list the new letter.
2. THE Send screen SHALL ask the owner first for the source kind, an archive folder or a phone folder. Each send takes one folder as its source (Q5).
3. THE Send screen SHALL offer only ready phones as the target, shown with the model and the device id, and SHALL offer the folders that the target phone lists. The list shows folders only (C14).
4. WHEN a phone folder listing is capped at 500 entries (C14), THE Send screen SHALL state that the list is partial.
5. WHEN a phone folder listing fails, THE Send screen SHALL report that folder as "could not be read", and SHALL NOT show it as having no subfolders (C14).
6. THE Send screen SHALL refuse to select the same phone as both source and target, and SHALL state why (D11).
7. THE Desktop app SHALL show the plan (Requirement 13 criterion 1) before it opens the confirmation sheet.
8. THE Desktop app SHALL open the existing confirmation sheet for every send, and SHALL NOT start a send until the owner types the confirm word (C30; D14).
9. THE Desktop app SHALL start a send only from the owner's click on the confirm control in the current window session. It SHALL NOT start a send from a URL, a page reload, or a back navigation (C29).
10. WHILE a send runs, THE Desktop app SHALL show a Cancel control, and SHALL state in words what cancel does (D10).
11. THE Desktop app SHALL show each of these states with its reason and its fix in words: no phone attached; a phone not in the ready state, with the state it reports; fewer than two ready phones for a phone-to-phone send; an archive that is not mounted, is read-only, or sits on the root filesystem (C33); a folder that could not be read; free space that is short or unreadable; and an engine that is stopped.
12. WHEN the engine connection becomes stopped or restarting, THE Desktop app SHALL reset the Send state, as the other screens do (`+layout.svelte`, the `screens.reset` and `run.reset` effect).
13. WHEN the owner chooses a target phone that has a remembered folder, THE Desktop app SHALL pre-fill the remembered folder (D2).
14. IF the remembered folder is not on the phone, THEN THE Desktop app SHALL show it as "not found on the phone", and SHALL NOT use it until the owner chooses a folder (D2).
15. THE Desktop app SHALL keep the remembered folder for each phone in the window preferences, and SHALL NOT write it to the engine's config (D2; C34).
16. THE Desktop app SHALL use the existing design tokens and component classes, and SHALL NOT add a colour that `bun run a11y` does not measure (D14; C35).
17. THE `bun run a11y` gate SHALL exit 0 for the Send screen's colour pairs, at 7:1 for text and at 3:1 for non-text parts (D14; C35).
18. THE Desktop app SHALL keep every Send action reachable from the keyboard, and SHALL move focus to the Cancel button of the confirmation sheet when the sheet opens (D14; C30).
19. THE live region SHALL announce send progress at most once every five seconds, in file counts and phase, and SHALL NOT announce bytes (C32).
20. THE Desktop app SHALL format every byte count, rate, and duration with the functions in `apps/desktop/src/lib/util/format.ts` (AGENTS.md, Svelte patterns).

### Requirement 15: Engine protocol and frames

**User Story:** As a maintainer, I want the send commands and frames to follow the existing wire rules, so that the desktop app and the Engine cannot disagree about a send.

#### Acceptance Criteria

1. THE Engine SHALL validate the arguments of each send command with the same strict rule as the other commands, so that an unknown key rejects the command (C16; `ArgsSchemas` in src/serve/protocol.ts).
2. THE Engine SHALL answer each send command with exactly one answer frame that carries the command's id, including when the command fails (src/serve/dispatch.ts, one-answer rule).
3. THE Engine SHALL write each frame as one JSON object on one stdout line, and SHALL write no other text to stdout while a send runs. Diagnostics SHALL go to stderr or to log frames (AGENTS.md, stdout is the protocol; C10).
4. WHEN a send's state changes, THE Engine SHALL write a state frame, and WHEN a send ends, THE Engine SHALL write a result frame. Each frame SHALL pass the schema for its type (`parseFrame` in src/serve/protocol.ts).
5. THE needs-confirm frame SHALL name each send action in its action list (C15).
6. THE Rust shell SHALL remember the last frame of every type that the Engine writes, and a test SHALL fail when the shell's list differs from the Engine's list. Today the shell lists 18 names and omits `trash`, which the Engine writes (C16; C17).
7. UNTIL the owner decides Q7, THE Engine SHALL keep the protocol version at 1.
8. WHILE a send runs, THE Engine SHALL answer status requests (Requirement 11 criterion 1).

### Requirement 16: Tests, journeys, and the definition of done

**User Story:** As the owner, I want each send kind tested at the unit, contract, screen, and real-app layers, so that every claim in the docs has evidence behind it.

#### Acceptance Criteria

1. THE unit suite SHALL run each send path against a fake adb that records every call in order. It SHALL check this order: source hash, write or relay, temporary file hash, first flush, rename, second flush, done. For a move, the order SHALL continue with a fresh hash of the final path, and then the source delete (D5; D17; D22).
2. THE unit suite SHALL include a fake case for each of these: exit 0 with wrong content; a missing hash tool; `sync` absent; a stall; a deadline; a cancel during a stream; a target write failure; a temporary file that cannot be removed; a source that disappears; a phone unplugged mid-file; names with spaces, quotes, brackets, and non-ASCII letters; two names that differ only in case; a skipped file in a move; and a replace whose new file fails verification, which must leave the old file in place (D23).
3. THE unit suite SHALL check that no code path of a send deletes a file on the archive drive (D1).
4. THE contract tests SHALL run the Engine's stdin and stdout loop for each send command, SHALL check each answer's keys against the app's answer key table (`ANSWER_KEYS` in `apps/desktop/src/lib/engine/protocol.ts`), and SHALL parse each frame with the frame schemas (C16).
5. THE ui:sweep SHALL gain one journey for each send kind, each with its own screenshot, and `bun run ui:sweep` SHALL exit 0 with the new step count (D15; `apps/desktop/scripts/ui-sweep.ts` line 225; README line 314).
6. THE tauri-dev journeys SHALL run on the real debug app and SHALL start a driver session after the app starts. For each flow they SHALL record at least one webview screenshot, the `document.body.innerText` read, and the IPC state read through the tauri-dev tools (D15; AGENTS.md steps 3 and 4; Requirement 4).
7. THE tauri-dev journeys that run without hardware SHALL cover each refusal and empty state that the real Engine produces with no phone and no archive mount (D15; H3; H4).
8. THE tauri-dev journeys that need hardware SHALL run during the real-device runs of Requirement 17, and SHALL cover each Send flow of Requirement 14.
9. A tauri-dev journey step that waits for a long action SHALL poll `document.body.innerText`, rather than wait on one call that runs longer than the plugin's deadline (AGENTS.md, Driving the real app, step 4).
10. THE evidence for each journey and each spike SHALL be committed to the repository, in a folder that the design names (D15).
11. THE change SHALL pass `bun run typecheck`, `bun run test`, `bun run check`, `bun run test` in `apps/desktop`, `bun run a11y`, `cargo test` in `crates/portage-scan` and in `apps/desktop/src-tauri`, `bun run build && bun run ui:sweep`, and `scripts/check-commits.sh` over the change range (AGENTS.md, Definition of done).
12. THE README and TODO.md SHALL describe the send feature, its verification rule, and its difference from apull's size-only rule, as the code does after the change (C26; C27).

### Requirement 17: Real-device runs and hash records

**User Story:** As the owner, I want each send kind run on my real phones, with the hashes recorded, so that every claim rests on bytes read from the devices.

#### Acceptance Criteria

1. THE drive-to-phone real run SHALL use one ready phone and one archive folder of at least three files. It SHALL cover a copy, a skip reported as "already there", one replace, and one cancel during a file (D15; D11).
2. THE phone-to-phone real run SHALL use two ready phones attached at the same time. It SHALL cover one file through the relay that spike S1 selects, one folder with a file already on the target, one move, and one cancel during a file. This run is the first test of TODO M8-1 for sends (D11; D15; C37).
3. EACH real run SHALL commit a hash record that lists, for each file: source path, target path, size, each SHA-256 that applies, the relay or write method that ran, the flush outcome, the final state, and the raw command output (D15).
4. EACH real run SHALL record each phone's device id, model, and Android version, the adb version, and the host kernel. A run that reads the archive SHALL also record the archive's device name, USB port, link speed, and mount options (transfer-durability R7.1 and R7.2).
5. THE real run for a move SHALL record the source phone's free space with `df` before and after the move (AGENTS.md definition of done, item 2).
6. THE real run SHALL record the archive folder's listing (names, sizes, and modification times) before and after the run, and that listing SHALL be unchanged (D1).
7. BEFORE a real run deletes any phone file, THE owner SHALL approve the list of files to be deleted (AGENTS.md rule 6).
8. WHEN a hash in a real run differs, THE hash record SHALL keep that failed run, and THE next run SHALL be a new record, not an edit of the failed one.
9. THE real runs SHALL delete only the files they created on the phones, and SHALL leave every other file as they found it (transfer-durability R4.12).

### Requirement 18: Dependencies, freeze, and constraints

**User Story:** As the maintainer, I want this feature to build on the transfer-durability probe and flush rules, and to respect the repository's freezes and rules, so that a send cannot weaken them.

#### Acceptance Criteria

1. THE send feature SHALL NOT begin implementation until the probe work (transfer-durability Requirement 2) and the flush rules (transfer-durability Requirement 1) have merged. Alternatively, THE send feature SHALL land on the same branch after that work (D16; H5).
2. UNTIL the freeze lift of the transfer-durability spec merges, THE send feature SHALL NOT change `src/xfer`, `src/index`, or `src/plan`, because CI's frozen-files check covers them (C36; D16).
3. THE send feature SHALL NOT change `src/scan`, which the transfer-durability spec keeps frozen (transfer-durability R6.3; C36).
4. THE send feature SHALL NOT change `crates/portage-scan`, `scripts/apull.sh`, or the production Content Security Policy in `apps/desktop/src-tauri/tauri.conf.json` (AGENTS.md, Driving the real app, step 2; Q9).
5. No requirement in this document needs a new crate or package, so THE send feature SHALL add none. A later change that needs one SHALL name it and the requirement it serves.
6. THE send feature SHALL add no configuration key. It SHALL read the existing `jobs` setting, the per-device `jobs` override, and `space_headroom` (C20; C22).
7. THE Engine SHALL follow AGENTS.md: terse comments, no `console.log`, and `#lib` imports. THE Desktop app SHALL import through `#lib`, and SHALL NOT hand-edit `components/ui` (AGENTS.md, traps and Svelte patterns).

## Open questions and defaults

Each default below is written into the criteria listed under "Used in". Each criterion carries its default number in parentheses. None of the defaults is approved yet. D1 to D16 come from the owner's list. D17 to D27 are the author's additions, so the owner can accept or change each one separately.

### Defaults from the owner's list (not yet approved)

**D1. Copy, never move, by default.** A move is opt-in for each send, behind the confirmation gate. A send never deletes anything from the archive drive, so a drive-to-phone send has no move option.

- Used in: 6.7, 8.9, 8.10, 16.3, 17.6.
- Reason: AGENTS.md rule 5 says never delete the last copy, and rule 6 says ask before a one-way door. The existing pull deletes phone copies by default (C21), so the send states its own default. A move from the archive would delete archive content, which this request rules out.

**D2. Target folder, layout, and pre-fill.** The owner picks the target folder on the phone for each send. The source's relative layout is kept under that folder. The last folder used for that phone is pre-filled.

- Used in: 7.1, 7.2, 7.3, 13.7, 14.13, 14.14, 14.15. Related: Q2.
- Reason: the pull keeps each file's path relative to the configured phone folder (src/scan/scan.ts, the `relative` rule in `scanDevice`). The owner picks only folders that already exist, so a typed path cannot create a stray folder. The remembered folder lives in window preferences (C34), and the engine config is not changed.

**D3. Phone-to-phone relay.** The stream relay pipes the source's `adb exec-out cat` into the target's `adb shell -T cat`, and the host hashes the bytes. The stream is used only if spike S1 passes in both directions. Otherwise the host relays through a temporary file, after the free-space check in D20.

- Used in: 1.6, 1.7, 7.12, 8.1, 8.2.
- Reason: the shared wrapper sets stdin to ignore and decodes stdout as text (C5), so it cannot carry a binary stream either way. `shell -T` disables the terminal (H2), and the terminal is what corrupts binary output (X1). apull already streams with `exec-out` and `exec-in` (C26), but its check is by size (C27).

**D4. Concurrency and the 480 Mbit rule.** One send job runs at a time. Inside a job, each target phone receives one file at a time. The owner may raise that for one send, up to the existing `jobs` value (default 3, maximum 8). A link at 480 Mbit/s or less keeps one file at a time whatever the owner chose. A link that cannot be read or attributed also keeps one file at a time.

- Used in: 11.10, 11.11, 11.12, 11.13.
- Reason: 3 is the measured knee for pulls (C20), and a send feeds a single phone, so one file at a time is the cautious start. The 480 Mbit auto-drop is a recorded decision (docs/decisions.md line 25) and a planned milestone (docs/milestones.md 123), but no code implements it (C19). The run path never reads a per-phone link speed (C18).

**D5. Verification.** A file is verified when the target's SHA-256 equals the source's SHA-256. For a drive source, the source hash is the archive file's hash computed on the host. For a phone source, it is the source phone's `sha256sum`. A stream relay must also match on the streamed bytes. A file is done only after this match.

- Used in: 8.6, 8.14, 9.1, 9.2, 9.3, 9.7, 10.6, 16.1.
- Reason: a copy's exit status is never enough (C6). The phone's `sha256sum` takes 1372 ms for 400 MB (X3), so a hash on each side is affordable.

**D6. Flush on the phone.** The flush is `sync` on the target phone, if spike S2 shows that it flushes phone storage. If S2 does not show that, the owner decides (Q1).

- Used in: 2.5, 10.3, 10.4, 10.6, 13.6.
- Reason: a finished write is not necessarily on the device. The pull notes that adb reports a file finished once its bytes reach the page cache (src/xfer/adb.ts, comment at lines 103-106). The phone may have the same gap, and S2 measures it.

**D7. Partial files.** Bytes are written to a temporary name in the target folder. The file is renamed into place only after verification. A partial file is removed on failure or cancel, and it is never counted as done.

- Used in: 10.1, 10.2, 10.8, 10.9, 10.11, 10.12, 13.7.
- Reason: the drive side keeps partials apart from finished files (src/index/recovery.ts). A temporary name that ends in `.part` is already treated as in flight by the scan (C23), so a pull never takes a partial for media.

**D8. Existing files.** A target file with the same relative path, the same size, and the same SHA-256 is skipped and reported as "already there". A different file at that path is never overwritten silently. Replacing is the owner's choice for each send.

- Used in: 7.5, 7.6, 7.7.
- Reason: the existing plan skips a same-size file as already on disk (C7), which proves only the size. The engine refuses overwrites (C8). A send needs a content check, and replace is an explicit, confirmed exception.

**D9. No resume.** A failed file is sent again from its first byte by the next send.

- Used in: 10.10.
- Reason: resume exists only for `adb pull` (src/xfer/adb.ts, `resumeTail`), which reads the source's tail again. A push or a stream has no equivalent that proves the tail, so a whole-file hash is the only check.

**D10. Cancel.** A running send can be stopped without restarting the engine. The file in progress is removed as a partial. Finished files stay, and the result lists them.

- Used in: 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 14.10.
- Reason: the existing stop acts only between files (C11). An engine restart would also drop state that the other screens hold, so a send needs its own cancel that keeps the process running.

**D11. Device rules.** Each phone is identified by its device id. The source and target must differ. A phone-to-phone send needs exactly two ready phones. Two-phone use is tested with real phones.

- Used in: 5.1, 5.2, 5.3, 5.4, 5.5, 14.6, 17.1, 17.2.
- Reason: the device id is `sha1(ro.serialno)`, and it falls back to the adb serial when `ro.serialno` cannot be read (C2). `pickDevice` chooses the first ready phone without asking (C9), which a send must not do. Two-phone use was never tested (C37).

**D12. Drive sources.** The archive drive must pass the destination check of the transfer-durability spec (its R2.14 and its probe rules).

- Used in: 6.1, 6.3.
- Reason: the transfer-durability spec defines that check. The check in code runs `findmnt` and `df` synchronously, with no deadline (C22), so the send needs the bounded version.

**D13. Plan and progress.** The plan shows the files, the bytes, each skipped file with its reason, the target, and whether a move is included. Progress uses the dashboard's labels. The result names the relay that ran for each phone-to-phone file.

- Used in: 8.8, 13.1, 13.3, 13.5.
- Reason: the dashboard already labels the instant rate, the average rate, and time left, and withholds the estimate until it can be honest (C31). Reusing those labels keeps one meaning per number. The relay name tells a host-memory stream apart from a host file.

**D14. Desktop app.** A Send flow with a source chooser, a target chooser, a plan preview, a confirmation step, progress, and a result. It uses the existing screens and design tokens, and it passes the AAA contrast gate.

- Used in: 12.8, 12.10, 14.8, 14.16, 14.17, 14.18.
- Reason: the app already has the rail, the confirm sheet, the error band, and the tokens (C28, C30). `bun run a11y` is the repository's AAA gate: 7:1 for text and 3:1 for non-text (C35), and CI runs it.

**D15. Testing and evidence.** Unit tests with a fake adb. Engine contract tests. One ui:sweep journey for each send kind. tauri-dev journeys on the real debug app. Real-device runs with committed hash records. Spikes S1 to S4 with committed records.

- Used in: 16.5, 16.6, 16.7, 16.10, 17.1, 17.2, 17.3.
- Reason: the existing tests already use a fake adb and a temporary drive (test/helpers.ts), and ui:sweep drives a fixture engine (apps/desktop/scripts/ui-sweep.ts). A unit test cannot observe a disk flush (transfer-durability R1.10), so the real-device runs carry the durability claim.

**D16. Sequencing.** The send feature starts after the probe work of the transfer-durability spec merges, or lands on the same branch after that work.

- Used in: 18.1, 18.2.
- Reason: the probe wrapper and the flush rules exist only in a draft that is not committed (H5). CI freezes `src/xfer`, `src/index`, `src/plan`, and `src/scan` (C36), so a change to `src/xfer` fails CI until the freeze lift merges.

### Defaults the author added (not in the owner's list)

**D17. Two flushes on the phone.** The phone is flushed once after the verified temporary file is written, and once more after its rename, before the file is recorded as done.

- Used in: 10.5, 10.6, 11.4, 13.6, 16.1.
- Reason: a rename changes a directory entry, and transfer-durability fact F4 says an fsync of a file does not make its directory entry durable. The cost of the second flush is part of the S2 measurement.

**D18. Phone deadlines.** Phone probes (listing, stat, free space, existence) take the 3-second deadline of transfer-durability R2.2. A hash read or a flush takes the size rule of transfer-durability R1.12, which is 30 seconds plus 1 second per 10 MB. A write or relay that moves no bytes for 30 seconds is stalled.

- Used in: 6.3, 7.8, 8.7, 9.6, 10.7, 11.14.
- Reason: the 3-second deadline reuses the existing wrapper. A 400 MB hash takes 1372 ms (X3), so a fixed 3-second limit on a hash would fail a healthy large file. The 30-second stall matches the base term of R1.12. If a healthy folder listing exceeds 3 seconds, the owner must choose a longer probe deadline.

**D19. Phone sources and in-flight files.** A phone source file whose name carries an in-flight suffix, or whose modification time is within `quiet_seconds` of the plan, is skipped with that reason.

- Used in: 8.15.
- Reason: the scan already refuses these files (C23). A file still being written is a partial, and copying it would only be caught later by a hash mismatch.

**D20. Free space.** The target phone must have room for the bytes to write, plus `space_headroom` of the volume's total. The host temporary-file check uses the same headroom on the host volume, and it counts every temporary file that can exist at once. The phone check reads the volume that holds the target folder, not the fixed `/sdcard` path (C4).

- Used in: 7.13, 7.14, 8.3, 8.4.
- Reason: the existing headroom rule (C22) is reused, so no configuration key is added. Concurrent relays each hold a host file, so the check must count all of them.

**D21. One job at a time across pulls and sends.** A send does not start while a pull runs, and a pull does not start while a send runs.

- Used in: 5.7, 11.9.
- Reason: a pull and a send would share the adb link and the phone's storage. The pull already refuses a second run (C11).

**D22. Move deletes only what was verified in the same send.** A source file is deleted only after this send copied it and verified it. A skipped file is never a delete candidate.

- Used in: 8.11, 11.6, 16.1.
- Reason: rule 3 of the engine (src/xfer/engine.ts, header lines 18-21) says a skipped file is never a delete candidate. A skip proves less than a fresh verified copy does.

**D23. Replace by rename.** A replace writes and verifies a temporary file, then renames it over the target. The old file is never deleted first. The result reports the old file's size and hash.

- Used in: 7.11, 12.6, 16.2.
- Reason: deleting first would leave no file at the path if the new copy then failed. AGENTS.md rule 5 says never delete the last copy. Reporting the old hash lets the owner see what was replaced.

**D24. Confirm refresh and expiry.** At confirm, the engine re-reads the target folder and the source listing. If the file count or the byte total has changed, the engine returns a new plan. A stored plan expires after 10 minutes.

- Used in: 12.4, 12.5.
- Reason: `trash.empty` already re-reads the trash before it acts (C12), and pending records expire after 10 minutes (C13).

**D25. Three phone deadlines in a row end the send.** After three phone calls in a row reach their deadlines, the send ends and reports that phone as "could not be read".

- Used in: 5.9.
- Reason: transfer-durability R2.12 sets the same rule for the drive, with a default of 6. A phone that times out three times in a row is not worth more calls.

**D26. A phone that stops being ready mid-send.** The file in progress fails with "phone not attached". The send stops at the next file boundary, and the files not yet started are reported as not started.

- Used in: 5.8.
- Reason: retrying a missing cable would spin. Stopping at a boundary keeps each file's final state exact (13.4).

**D27. Write method and names.** No `adb push --sync`, because `--sync` skips a file whose timestamp matches, whatever its bytes (H2). No compression. Names are sent exactly as they are, and two source names that differ only in letter case are refused.

- Used in: 7.10, 7.12.
- Reason: H2 describes `--sync` as timestamp-based. Compression is lossless, but a single write path with a known result is simpler to verify, and the hash checks cover the content either way. With two sources that differ only in case, one target path would hold two files, and the hash check cannot say which source it came from.

### Open questions

**Q1. The rule if `sync` does not flush the phone.** If spike S2 shows that `sync` does not flush phone storage, which rule applies? Options: (a) no real writes to phones until a flush is proven; (b) writes without a flush, with that fact stated in every result; (c) another flush method that S2 measures. The provisional answer is (a). Related: 2.5, 2.6, 10.3.

**Q2. The source folder's own name.** Does a send place the source folder's own name under the target, or only its contents? The provisional answer is contents only, which matches the pull's root rule. Related: 7.1.

**Q3. Never-scan folders for phone sources.** Should the never-scan folders (`Android/data`, `Android/obb`, C24) apply to a phone source in a send? The provisional answer is no: the owner chooses the folder, and any file that cannot be read is reported as "could not be read". Related: 8.15.

**Q4. Zero-byte files.** Should a send copy zero-byte files? The scan skips them today (src/scan/scan.ts, `classify`, "zero bytes"). The provisional answer is yes, as 7.15 states.

**Q5. Individual files.** Should a send accept individual files as well as folders? The provisional answer is folders only, as 14.2 states.

**Q6. Where a send's record is kept.** The provisional answer is the archive's `events.jsonl` (C25) when the drive is mounted, and the host's state directory otherwise. A phone-to-phone send needs no drive, so the second case must exist. The record never goes into the archive tables. Related: 13.12.

**Q7. Protocol version.** Does an additive change to the protocol need a new version number? The provisional answer is no, because the app and the engine ship together. Related: 15.7.

**Q8. Scope reversal.** The desktop plan says "no phone-to-phone streaming in v1" (C38). Does the owner accept that this request reverses that decision for the desktop app?

**Q9. apull's size-only rule.** apull's phone-to-phone path checks by size (C26, C27), and its header says a same-size file is skipped without a content check (scripts/apull.sh, lines 13-23). Should apull keep that rule, or adopt this spec's hash rule? The provisional answer is that this feature leaves apull unchanged (18.4).

### Facts not confirmed

- The archive drive is attached and unmounted, as the request says. This host shows no USB storage device (H4).
- A phone is attached. `adb devices` lists none (H3).
- `adb exec-out` works in adb 1.0.41. Its help text does not list it, although the code uses it (H2; `src/device/adb.ts`, `execOutTail`).
- `adb exec-in` runs in this build (X2; spike S3).
- `adb shell -T cat` carries a binary stream into a file unchanged (spike S1).
- `adb push` writes binary content unchanged in this build (spike S1, criterion 7).
- `sync` exists on the phone, and it flushes phone storage (spike S2).
- The phone reports Dirty and Writeback values in a form this spec can read (spike S2, criterion 3).
- The tauri-dev driver session connects to the debug app (spike S4).
- A phone's link speed can be attributed to that phone (C18).
- The 480 Mbit auto-drop works in practice (C19; TODO.md line 196 says not confirmed by a run).
- Which two phones the two-phone run will use. TODO.md line 388 names "both Redmi devices", and no device is attached now.
- Target folders on a phone accept writes from adb, given the phone's storage rules. This is not tested.
- The transfer-durability probe wrapper and flush rules exist in code. They are a draft, not committed (H5).
