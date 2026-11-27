# Requirements Document

## Introduction

Portage tells the user when a newer release of the app exists. The check is off by default. When the user turns it on, the Engine asks GitHub for the latest published release once each time Portage starts. A newer release shows an in-app banner with one action, which opens the release page in the system browser. Portage does not download or install anything. The request runs in the Engine, so the production Content Security Policy stays as it is.

This request makes the release check the first outbound network call in the product. The project documents that say the app makes no network calls must change in the same work (Requirement 9).

**Checked against the working tree:**

- The production CSP in `apps/desktop/src-tauri/tauri.conf.json` (line 28) sets `connect-src 'self' ipc: http://ipc.localhost`, which does not allow GitHub. The Engine is a separate Bun process, so the Webview's policy does not govern its request.
- No outbound network code exists yet. Outside tests, `src/` has no `fetch`, `http`, or `https` call. No HTTP client crate appears in `crates/**/Cargo.toml` or `apps/desktop/src-tauri/Cargo.toml`.
- `__APP_VERSION__` is read from `apps/desktop/package.json` by `apps/desktop/vite.config.ts` (line 14). The root `package.json`, `apps/desktop/package.json`, and `tauri.conf.json` all read 0.1.18, and release-please keeps them in step. Tags `v0.1.1` through `v0.1.18` exist.
- The Engine does know its own version. `src/serve/main.ts` takes it from the root `package.json`, and the `ready` frame reports it. `apps/desktop/src/lib/state/app.svelte.ts` (line 279) already warns when that version differs from `__APP_VERSION__`. The design may compare versions in either process.
- The Engine awaits each command before it reads the next line (`src/serve/index.ts`, lines 145 to 148). A slow release check must not hold the command loop.
- The notice host (`apps/desktop/src/lib/components/app/toast-host.svelte`) sets no toast duration, so the library default of 4000 ms applies (`apps/desktop/node_modules/svelte-sonner/dist/Toaster.svelte`, line 12). When that timer ends, the library calls `onAutoClose`, which the host does not handle. The notice then leaves the screen while it stays in `app.notices`. `MAX_NOTICES` (`app.svelte.ts`, line 77) also drops the oldest notice when a fourth one arrives. Requirement 4 depends on both.
- `opener:default` is already granted in `apps/desktop/src-tauri/capabilities/default.json`. That permission set includes opening https URLs. Its scope is for design.
- `docs/` is gitignored (`.gitignore`, line 1), so the documentation corrections will not appear in a commit.
- The word "offline" already names an Engine that is not running (`FailureKind` in `apps/desktop/src/lib/engine/client.ts`, line 55) and a phone in the `offline` device state (`DeviceState` in `apps/desktop/src/lib/engine/protocol.ts`, line 52). This spec uses "Network_Failure" for the new case.
- GitHub's latest-release endpoint returns the latest published full release, and drafts and prereleases are excluded ([GitHub REST releases](https://docs.github.com/en/rest/releases/releases)). A primary rate-limit response is HTTP 403 or 429 with `x-ratelimit-remaining: 0` ([GitHub REST troubleshooting](https://docs.github.com/rest/using-the-rest-api/troubleshooting-the-rest-api)). Both points are rephrased for compliance with licensing restrictions.

**Repo rules that shape the criteria (AGENTS.md):** The UI names its three states honestly: "Up to date", "Couldn't check for updates", and "Not checked yet". Dates and times use `Intl`. Styling uses Tailwind v4 tokens and shadcn-svelte components. The switch and the banner are exercised by the headless journey, not only by unit tests.

**Deferred to design:** the request time limit, the opener permission scope for https URLs, which process compares versions, how the banner action reaches the Webview, the Engine_Configuration key name, how the Last_Good_Result is stored, and how the banner stays visible past the 4000 ms timer.

**Out of scope:** a manual "check now" control; any retry in the same Launch after a failed check; checks on a timer or while the app stays open; downloading, installing, or updating in place; operating-system notifications; remembering a closed notice or a skipped version across Launches; draft and prerelease releases; the `portage-scan` crate's own version; any change to the production CSP.

## Glossary

- **Portage**: the desktop app in `apps/desktop/`, together with the Engine it starts.
- **Engine**: the `portage` engine process (`dist/portage`). It reads one JSON request per line and writes one JSON frame per line.
- **Engine_Configuration**: the config file that the Engine owns. The desktop app changes it only through the `config.set` command.
- **Webview**: the window content that the desktop app renders with Svelte, under the production Content Security Policy.
- **Project_Documentation**: the Markdown files under `docs/` in the repository, including `docs/plans/2026-11-08-desktop-app/`.
- **Settings_Screen**: the Settings route of the desktop app.
- **Update_Switch**: the one switch on the Settings_Screen that turns update checks on or off.
- **Update_Status**: the status text on the Settings_Screen that states what update checks are doing or found.
- **Update_Checker**: the part of the Engine that runs Release_Checks and records their Check_Results.
- **Launch**: one run of Portage, from start until quit. The "session" in the request means one Launch.
- **Running_Version**: the Portage app version that the desktop build bakes in as `__APP_VERSION__`, read from `apps/desktop/package.json`.
- **GitHub**: the code host that serves the release API and the release pages for `Michael-Obele/portage`.
- **Release_Request**: the single HTTPS GET to `https://api.github.com/repos/Michael-Obele/portage/releases/latest`.
- **Release_Tag**: the `tag_name` of the release that the Release_Request returns, for example `v0.1.19`.
- **Release_Check**: the attempt that a Launch makes to read the latest release, when update checks are on. It sends at most one Release_Request. Its finish time is when the attempt ends, whatever its Check_Result.
- **Check_Result**: the outcome of a Release_Check. It is one of "Newer release", "Up to date", or "Couldn't check".
- **Last_Good_Result**: the most recent Check_Result of "Newer release" or "Up to date", with its finish time. It persists across Launches.
- **Network_Failure**: a Release_Request that cannot reach GitHub, or that does not finish within its time limit.
- **Rate_Limit_Response**: a GitHub response that refuses a request because the quota is used up. It has HTTP status 403 or 429, and either `x-ratelimit-remaining: 0` or a secondary-limit message.
- **Update_Notice**: the in-app banner, shown through the existing notice host, that announces a newer release.
- **Release_Page**: the GitHub page for one release: `https://github.com/Michael-Obele/portage/releases/tag/<Release_Tag>`.
- **Headless_Journey**: the `bun run ui:sweep` run in `apps/desktop/`, which drives the built app in headless Chrome.

## Requirements

### Requirement 1: Update checks are opt-in

**User Story:** As a Portage user, I want update checks to stay off until I turn them on, so that Portage contacts GitHub only when I ask it to.

#### Acceptance Criteria

1. WHILE the Update_Switch has no stored value, THE Update_Checker SHALL treat update checks as off.
2. WHILE update checks are off, THE Update_Checker SHALL send no Release_Request.
3. THE Settings_Screen SHALL provide the Update_Switch as its only control for update checks.
4. THE Settings_Screen SHALL present the Update_Switch as the app's existing shadcn-svelte switch.
5. WHEN the user changes the Update_Switch, THE Engine SHALL save the new value in the Engine_Configuration, so that the Settings_Screen shows the saved value after Portage restarts.
6. WHEN the user turns the Update_Switch on during a Launch, THE Update_Checker SHALL send no Release_Request until the next Launch.
7. THE Settings_Screen SHALL state beside the Update_Switch that turning the Update_Switch on lets Portage contact GitHub once each time Portage starts.

### Requirement 2: One check per Launch

**User Story:** As a Portage user, I want Portage to check for a release once when it starts, so that the app does not poll GitHub while it stays open.

#### Acceptance Criteria

1. WHILE update checks are on, WHEN a Launch starts, THE Update_Checker SHALL start one Release_Check.
2. WHILE Portage stays open, THE Update_Checker SHALL start no Release_Check after the one that the Launch started.
3. WHILE a Release_Check is in progress, THE Engine SHALL answer other commands without waiting for the Release_Check to finish.

### Requirement 3: Settings shows an honest update status

**User Story:** As a Portage user, I want Settings to show what the last check actually found, so that I can tell "Up to date" apart from "Couldn't check for updates" and from "Not checked yet".

#### Acceptance Criteria

1. WHILE update checks are off, THE Settings_Screen SHALL show "Update checks are off" as the Update_Status.
2. WHILE update checks are on and no Release_Check has finished in the current Launch, THE Settings_Screen SHALL show "Not checked yet" as the Update_Status.
3. WHEN a Release_Check in the current Launch finishes with "Up to date", THE Settings_Screen SHALL show "Up to date" as the Update_Status, with the finish time of that Release_Check.
4. WHEN a Release_Check in the current Launch finishes with "Newer release", THE Settings_Screen SHALL show "Portage X.Y.Z is available" as the Update_Status, with the finish time of that Release_Check, where X.Y.Z is the Release_Tag without its leading v.
5. WHEN a Release_Check in the current Launch finishes with "Couldn't check" and a Last_Good_Result is stored, THE Settings_Screen SHALL show "Couldn't check for updates" as the Update_Status, together with that Last_Good_Result and its finish time, labelled as the last successful check.
6. WHEN a Release_Check in the current Launch finishes with "Couldn't check" and no Last_Good_Result is stored, THE Settings_Screen SHALL show "Couldn't check for updates" as the Update_Status and no other result.
7. THE Settings_Screen SHALL show "Up to date" as the current Update_Status only when a Release_Check in the current Launch has finished with "Up to date".
8. THE Settings_Screen SHALL show a version number only when a successful Release_Check read that number from a Release_Tag.
9. WHEN a Release_Check finishes with "Newer release" or "Up to date", THE Engine SHALL store that Check_Result and its finish time as the Last_Good_Result, replacing the previous Last_Good_Result.
10. IF a Release_Check finishes with "Couldn't check", THEN THE Engine SHALL keep the stored Last_Good_Result unchanged.
11. THE Settings_Screen SHALL format every finish time with Intl date and time formatting.

### Requirement 4: The Update_Notice announces a newer release

**User Story:** As a Portage user, I want an in-app notice when a newer release exists, so that I can open its release page from the app.

#### Acceptance Criteria

1. WHEN a Release_Check finishes with "Newer release", THE Portage SHALL show the Update_Notice.
2. THE Update_Notice SHALL read "Portage X.Y.Z is available", where X.Y.Z is the Release_Tag without its leading v.
3. THE Update_Notice SHALL offer one action, labelled "View release".
4. WHEN the user activates "View release", THE Portage SHALL open the Release_Page of the release named in the Update_Notice in the system browser.
5. THE Update_Notice SHALL open only Release_Pages of the `Michael-Obele/portage` GitHub repository, over https.
6. WHILE Portage stays open and the user has not closed the Update_Notice, THE Update_Notice SHALL stay visible, including when other notices arrive.
7. THE Portage SHALL announce a newer release only through the Update_Notice in the app's existing notice host.

### Requirement 5: Closing the Update_Notice hides it for the Launch

**User Story:** As a Portage user, I want to close the notice and not see it again in this Launch, so that a closed notice does not keep coming back.

#### Acceptance Criteria

1. WHEN the user closes the Update_Notice, THE Portage SHALL hide the Update_Notice for the rest of the Launch.
2. WHEN the user closes the Update_Notice, THE Settings_Screen SHALL keep showing the Update_Status.
3. THE Portage SHALL hold the closed state of the Update_Notice in memory only, so that no closed notice or skipped version survives a Launch.
4. WHEN a Release_Check finishes with "Newer release" in a new Launch, THE Portage SHALL show the Update_Notice even if the user closed it in an earlier Launch.

### Requirement 6: Network failure and rate limit are reported as "Couldn't check"

**User Story:** As a Portage user, I want an honest message when Portage cannot read the latest release, so that a failed check never looks like an up-to-date app.

#### Acceptance Criteria

1. IF a Network_Failure occurs, THEN THE Update_Checker SHALL finish the Release_Check with "Couldn't check".
2. IF GitHub answers the Release_Request with a Rate_Limit_Response, THEN THE Update_Checker SHALL finish the Release_Check with "Couldn't check".
3. IF GitHub answers the Release_Request with any other error status, THEN THE Update_Checker SHALL finish the Release_Check with "Couldn't check".
4. IF the answer to the Release_Request contains no Release_Tag string, THEN THE Update_Checker SHALL finish the Release_Check with "Couldn't check".
5. WHEN a Release_Check finishes with "Couldn't check", THE Update_Checker SHALL send no further Release_Request until the next Launch.
6. IF a Release_Check finishes with "Couldn't check", THEN THE Portage SHALL show no Update_Notice.

### Requirement 7: Version comparison

**User Story:** As a Portage user, I want Portage to announce only a real newer release, so that I am never sent to a release page for an equal, older, or unreadable version.

#### Acceptance Criteria

1. WHEN the Release_Tag matches vX.Y.Z and the Running_Version matches X.Y.Z, THE Update_Checker SHALL compare the major, minor, and patch numbers as whole numbers, so that 0.1.10 is newer than 0.1.9.
2. WHEN the Release_Tag is greater than the Running_Version, THE Update_Checker SHALL finish the Release_Check with "Newer release".
3. WHEN the Release_Tag equals the Running_Version, THE Update_Checker SHALL finish the Release_Check with "Up to date".
4. WHEN the Release_Tag is less than the Running_Version, THE Update_Checker SHALL finish the Release_Check with "Up to date".
5. IF the Release_Tag does not match vX.Y.Z, THEN THE Update_Checker SHALL finish the Release_Check with "Couldn't check".
6. IF the Running_Version does not match X.Y.Z, THEN THE Update_Checker SHALL finish the Release_Check with "Couldn't check".

### Requirement 8: The release request stays in the Engine and the CSP stays unchanged

**User Story:** As a Portage maintainer, I want the release request to run in the Engine and the Webview policy to stay unchanged, so that the desktop window keeps its strict content security policy.

#### Acceptance Criteria

1. THE Engine SHALL send the Release_Request, and THE Webview SHALL NOT send the Release_Request.
2. THE Engine SHALL send the Release_Request only to `https://api.github.com/repos/Michael-Obele/portage/releases/latest`.
3. THE Portage SHALL make no outbound network request other than the Release_Request.
4. THE production Content Security Policy in `apps/desktop/src-tauri/tauri.conf.json` SHALL keep its current value.

### Requirement 9: Documentation states the one release request

**User Story:** As a Portage maintainer, I want the project documents to describe the one release request, so that no document says Portage makes no network calls.

#### Acceptance Criteria

1. THE project documentation SHALL correct every statement that Portage makes no network calls or that no data leaves the machine. Those statements are at `docs/plans/2026-11-08-desktop-app/architecture.md` line 280; `truth.md` lines 80 and 83; `screens.md` lines 70 and 240 to 241; `gaps.md` lines 40, 41, and 50; and `report.md` line 53.
2. THE project documentation SHALL describe the Release_Request as the only outbound network call and SHALL state that the Release_Request runs only when the Update_Switch is on.
3. THE project documentation SHALL keep the statements that Portage has no operating-system notifications, no self-updater, and no background watching.
4. THE coverage matrix in `screens.md` SHALL give the Settings_Screen an Offline state, "Couldn't check for updates", in place of the dash at line 239.

### Requirement 10: The built app exercises the switch and the notice

**User Story:** As a Portage maintainer, I want the Headless_Journey to exercise the Update_Switch and the Update_Notice in the built app, so that the screens are proven and not only unit-tested.

#### Acceptance Criteria

1. WHEN the Headless_Journey runs, THE Headless_Journey SHALL exercise the Update_Switch on the Settings_Screen from its default off state to on and back to off.
2. WHEN the Headless_Journey runs, THE Headless_Journey SHALL exercise each Update_Status named in Requirement 3 on the Settings_Screen.
3. WHEN the Headless_Journey runs, THE Headless_Journey SHALL exercise the Update_Notice, including its "View release" action and its close control.
4. THE engine test suite (`bun run test` at the repository root) SHALL cover each version comparison case in Requirement 7 and each failure case in Requirement 6.

## Assumptions to confirm at review

These are decisions this draft makes beyond the wording of the request.

- A Launch makes its one check only when update checks are on at that Launch. Turning the Update_Switch on later waits for the next Launch, to honour "no checks while the app stays open".
- The Update_Notice comes only from the current Launch's check. A stored Last_Good_Result never raises it.
- The Settings_Screen shows a newer version as text and has no release-page action. The action exists only on the Update_Notice.
- A release tag older than the Running_Version counts as "Up to date". A tag or Running_Version that fails the vX.Y.Z pattern counts as "Couldn't check".
- Requirement 1.7, the disclosure line, is an addition. All copy in Requirements 1, 3, and 4 except "Couldn't check for updates" is a proposal.
