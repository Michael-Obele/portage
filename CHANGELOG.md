# Changelog

## [0.1.13](https://github.com/Michael-Obele/portage/compare/v0.1.12...v0.1.13) (2026-11-13)


### Bug Fixes

* **desktop:** make the plan table the plan screen's only scroll region ([7121a07](https://github.com/Michael-Obele/portage/commit/7121a07569e9ec02e8db01276393879949bf7e5d))
* **desktop:** stop the selected-row panel collapsing into an empty band ([9d76481](https://github.com/Michael-Obele/portage/commit/9d76481a8bf839330ecacee59f093d92da8a326f))

## [0.1.12](https://github.com/Michael-Obele/portage/compare/v0.1.11...v0.1.12) (2026-11-13)


### Features

* **desktop:** mirror pull excludes in the engine protocol ([70e1341](https://github.com/Michael-Obele/portage/commit/70e1341793bfdf53d86596410226841f3e7fe1d2))
* **desktop:** rebuild the plan screen around shadcn tables ([1ca946f](https://github.com/Michael-Obele/portage/commit/1ca946f34c5cf9ade4c57e2e4351192d74ba45ef))
* **desktop:** run the engine as a Tauri sidecar ([5157d25](https://github.com/Michael-Obele/portage/commit/5157d25c46e4b619c9b850be40deae3888f1b2b9))
* **engine:** trust the drive and accept hand removals ([c537b2c](https://github.com/Michael-Obele/portage/commit/c537b2c86a309e27e013d01389c42c92aa32597c))


### Bug Fixes

* **desktop:** make capped scroll areas scroll and pin headers ([4c591d1](https://github.com/Michael-Obele/portage/commit/4c591d1964584023edfc070a300899a95c2c555e))
* **engine:** read ro as a mount flag, not a substring ([186c31e](https://github.com/Michael-Obele/portage/commit/186c31e4e758868a088588552aea0ea4ec43dc31))
* **engine:** resume a partial copy at its offset ([5f533c8](https://github.com/Michael-Obele/portage/commit/5f533c8fb15f84284c19fdc9f7f1ce42e1ed2346))
* **recovery:** skip space reserve for empty plans ([803876e](https://github.com/Michael-Obele/portage/commit/803876e16c074076391cb16432e29314bce92986))


### CI

* **desktop:** gate the Rust shell and bundle from one command ([af0a287](https://github.com/Michael-Obele/portage/commit/af0a287f061a1656c8c53961c7ed5dccfdc3ab8e))
* **desktop:** skip the generated release PR bundle ([6ed9d67](https://github.com/Michael-Obele/portage/commit/6ed9d67bc7b95364af62eddd34b517a602d8d1b0))


### Documentation

* **desktop:** document the native app and its dev loop ([253cdb5](https://github.com/Michael-Obele/portage/commit/253cdb59e36a3d84aa8703eadbc638c90ad9a92e))


### Refactoring

* **engine:** share device picking and since parsing ([0f96c7b](https://github.com/Michael-Obele/portage/commit/0f96c7b398f5fd3202f9d71baeefc19939d01b87))

## [0.1.11](https://github.com/Michael-Obele/portage/compare/v0.1.10...v0.1.11) (2026-11-09)


### Features

* **desktop:** choose a phone's source folders from Home ([4657212](https://github.com/Michael-Obele/portage/commit/46572123dfc9eab7cecd87f85f1a924cb4d7401f))
* **desktop:** scan and trash duplicates from the Duplicates screen ([08cfe1f](https://github.com/Michael-Obele/portage/commit/08cfe1fc6f64f6c6ebf96a253b9c106ae9fda7ef))


### Bug Fixes

* **dedupe:** resolve a trashed file from the member's own path ([916f771](https://github.com/Michael-Obele/portage/commit/916f771cee3d55759a72353021cbcabee1a23ddf))
* **desktop:** start a run from a fresh intent, read readiness first ([478f08f](https://github.com/Michael-Obele/portage/commit/478f08fd7be59c8fd45114c69ac88086684b05d4))
* **serve:** refuse a pull with no source folders, and say so ([8cab7d6](https://github.com/Michael-Obele/portage/commit/8cab7d619fc9be393dcc6df3906404aa7e956a4e))


### Build

* **desktop:** catch the Rust lockfile up to the released version ([00084be](https://github.com/Michael-Obele/portage/commit/00084beda4b0e1ca7d5cb8b71006b608574b6628))


### Tests

* **serve:** assert the roots warning by content, not by count ([91f336f](https://github.com/Michael-Obele/portage/commit/91f336f6f89b1be11adaec4dafe19371e23aa36c))

## [0.1.10](https://github.com/Michael-Obele/portage/compare/v0.1.9...v0.1.10) (2026-11-09)


### Features

* **engine:** unify plan answer shape across engine, client, and serve ([bfd2302](https://github.com/Michael-Obele/portage/commit/bfd230215949da66bc43042e6546fd8d2b9be099))


### Bug Fixes

* **desktop:** align plan page with engine wire contract ([24931ef](https://github.com/Michael-Obele/portage/commit/24931ef43e4e8f86d6b1d6bca7c28422e6229672))

## [0.1.9](https://github.com/Michael-Obele/portage/compare/v0.1.8...v0.1.9) (2026-11-09)


### Bug Fixes

* **ci:** build the bundle before tagging ([6d299fb](https://github.com/Michael-Obele/portage/commit/6d299fb1af2a8c3a32ca2aaae260c37a3f80c178))
* **ci:** build the bundle before tagging ([e4e8c52](https://github.com/Michael-Obele/portage/commit/e4e8c528b4fce00b387c1e18b1b4e954b272aa66))

## [0.1.8](https://github.com/Michael-Obele/portage/compare/v0.1.7...v0.1.8) (2026-11-09)


### Features

* **desktop:** add adb and UI size settings ([397965e](https://github.com/Michael-Obele/portage/commit/397965eca703bc93b399897d1db0ae1bb3131705))
* **desktop:** implement the home screen ([52341ed](https://github.com/Michael-Obele/portage/commit/52341ed8015646319c42615a2a894ac74eaf6c2a))
* **engine:** find adb in the usual SDK folders ([0006838](https://github.com/Michael-Obele/portage/commit/000683817df48b7cd4aaf8f090dba6ffde2cfdac))

## [0.1.7](https://github.com/Michael-Obele/portage/compare/v0.1.6...v0.1.7) (2026-11-09)


### CI

* do not create a bundle run for a release-only pull request ([724b6fb](https://github.com/Michael-Obele/portage/commit/724b6fb7e9d401fe2af5e7a8961b4be13617b65c))

## [0.1.6](https://github.com/Michael-Obele/portage/compare/v0.1.5...v0.1.6) (2026-11-09)


### Bug Fixes

* **desktop:** type check the app's own scripts ([fac38f4](https://github.com/Michael-Obele/portage/commit/fac38f4761b70da228b74c7cf6f663eb755a20b0))


### CI

* do not create a run for a release-only pull request ([fda0c33](https://github.com/Michael-Obele/portage/commit/fda0c333b9aa840c8623c18163c68ce8112f23e7))
* skip the generated release pull request ([a28880e](https://github.com/Michael-Obele/portage/commit/a28880e080131e4e84de3e435081f8e65e8299cb))

## [0.1.5](https://github.com/Michael-Obele/portage/compare/v0.1.4...v0.1.5) (2026-11-09)


### CI

* delete merged branches automatically ([c1963a7](https://github.com/Michael-Obele/portage/commit/c1963a7a42d0f0661b549827a4e3f55d093d5f79))
* let maintenance commits release and pass the guard ([7c5dd87](https://github.com/Michael-Obele/portage/commit/7c5dd876917590ba536b7d250eedb17c9be56cd2))

## [0.1.4](https://github.com/Michael-Obele/portage/compare/v0.1.3...v0.1.4) (2026-11-09)


### Bug Fixes

* **ci:** attach installers in the same run as the tag ([d94954d](https://github.com/Michael-Obele/portage/commit/d94954d7e7bb71cde64c29675117814839461048))
* **ci:** close the release loop on merged release PRs ([b69972d](https://github.com/Michael-Obele/portage/commit/b69972dc5648c243d5d643fce205e996b146cf46))
* **ci:** confirm the release proposal after the label fix ([4336cdf](https://github.com/Michael-Obele/portage/commit/4336cdfcc757676acfa3831c0131d03eee9c19c3))

## [0.1.3](https://github.com/Michael-Obele/portage/compare/v0.1.2...v0.1.3) (2026-11-09)


### Bug Fixes

* **ci:** put the component in the release PR title ([560ef1e](https://github.com/Michael-Obele/portage/commit/560ef1ecb212f49dc33f42961dbf6749afb92364))
* **ci:** run release-please in single-package mode ([1c987d7](https://github.com/Michael-Obele/portage/commit/1c987d7bbab4dbbf86185a6f2e1d60abc068811d))
* **ci:** set the package name where the PR title reads it ([351b1b9](https://github.com/Michael-Obele/portage/commit/351b1b9631879361f27fa2fb2b72b30f1b68a438))
* **ci:** stop release-please expecting a package component ([05979b8](https://github.com/Michael-Obele/portage/commit/05979b8a48338c60a9da04b75c205e2fd7ce984a))
* **ci:** tag the merged version instead of relying on title matching ([3a7a3be](https://github.com/Michael-Obele/portage/commit/3a7a3bee6f5a79f4079456371c83ef6ff68e6118))
* **ci:** verify the automatic tag after the component fix ([a5d68e9](https://github.com/Michael-Obele/portage/commit/a5d68e9d15a993500d184d07946538b45ea4f823))

## [0.1.2](https://github.com/Michael-Obele/portage/compare/v0.1.1...v0.1.2) (2026-11-09)


### Bug Fixes

* **ci:** enforce the versioning rule the repo runs on ([621e9cb](https://github.com/Michael-Obele/portage/commit/621e9cb8f8e43c09176c04df534fb348b804ec83))
* **ci:** re-run release-please after tagging v0.1.1 ([cd3c310](https://github.com/Michael-Obele/portage/commit/cd3c310976c1331ff3cbc5dd83d433770cbe920a))

## [0.1.1](https://github.com/Michael-Obele/portage/compare/v0.1.0...v0.1.1) (2026-11-09)


### Features

* **apull:** add copy-only adb pull wrapper with drive and device ([a4401e8](https://github.com/Michael-Obele/portage/commit/a4401e8860afa3e94cb78e4c1036a86fb6364e88))
* **desktop:** add switch and toggle primitives ([2ccb898](https://github.com/Michael-Obele/portage/commit/2ccb898f94f2cd69400f5d3aab9b67b3c3b588b3))
* **desktop:** add the app icon set ([ebee5a9](https://github.com/Michael-Obele/portage/commit/ebee5a91e9e599d592cd64cda867511794db8328))
* **desktop:** add the Tauri desktop app ([8d85978](https://github.com/Michael-Obele/portage/commit/8d85978ae0a81d3eadb423e1b1ab18028296ea43))
* **desktop:** build the plan, transfer and summary screens ([91c3074](https://github.com/Michael-Obele/portage/commit/91c3074847641314d3e3c0acf38db3bcedb2c0c2))
* **desktop:** scaffold the SvelteKit and Tauri app ([5603baf](https://github.com/Michael-Obele/portage/commit/5603baf5c179e89878b6301d77aedd3980654c16))
* **device:** enrich volumes with details ([bd56c35](https://github.com/Michael-Obele/portage/commit/bd56c35697329bd792bae83fb95999674a441537))
* **device:** parse lsblk into mounted volumes ([47b7935](https://github.com/Michael-Obele/portage/commit/47b79350fe2e58704539d11d29f46b1aa5793e20))
* initialize Portage CLI for verified Android media offload ([4894d2e](https://github.com/Michael-Obele/portage/commit/4894d2ed23c99c6cb58e3e0934c6965211e4d87c))
* **serve:** add NDJSON engine protocol ([bb43d01](https://github.com/Michael-Obele/portage/commit/bb43d01363263ec10864e25414ab183d1ea77ab1))
* TUI dashboard, dupes review, dedupe engine ([0a0815a](https://github.com/Michael-Obele/portage/commit/0a0815ae9b56e4cf9e2f31fece0e5d035cf9aedc))


### Bug Fixes

* **a11y:** meet AAA contrast in both themes ([1d73304](https://github.com/Michael-Obele/portage/commit/1d73304d4361c902337418c9f39cb9f756366944))
* **desktop:** declare the bun types it compiles against ([6258f00](https://github.com/Michael-Obele/portage/commit/6258f000e0d2097f88858ea5fa7bfb9ef1565e82))
* **device:** report unknown mount state ([3cb24c9](https://github.com/Michael-Obele/portage/commit/3cb24c96dcfbc66d660cb162cab1f0ba8ee0bc45))
