# Changelog

## [0.1.20](https://github.com/Michael-Obele/portage/compare/v0.1.19...v0.1.20) (2026-11-27)


### Bug Fixes

* **test:** sort readdir before comparing in dupes.apply refusal test ([5098af6](https://github.com/Michael-Obele/portage/commit/5098af62c02c1834a9a477d6e81d0870b1e6bf4f))
* **test:** sort readdir before comparing in dupes.apply refusal test ([9da99b1](https://github.com/Michael-Obele/portage/commit/9da99b1b66a3d3054d846c06916c34399369d626))

## [0.1.19](https://github.com/Michael-Obele/portage/compare/v0.1.18...v0.1.19) (2026-11-27)


### Features

* **bench:** add the E2 and E3 scripts and their verdict tests ([3c32d81](https://github.com/Michael-Obele/portage/commit/3c32d81f7e4615bde0226f11f15b6ed59c59734a))
* **bench:** add the phone listing timing script ([06e7a59](https://github.com/Michael-Obele/portage/commit/06e7a59946e63c540dc4cf2fdc5746fa0e79f576))
* **bench:** add the Rust candidates for E2 and E3 ([0db3b76](https://github.com/Michael-Obele/portage/commit/0db3b7670d87913438d02c9aae3125ec9182ecf5))
* **bench:** add the S1 binary stream spike script ([5ee6af0](https://github.com/Michael-Obele/portage/commit/5ee6af01366f87b27986878213fbd364e608e42c))
* **bench:** add the S2 phone sync spike script ([174a7c7](https://github.com/Michael-Obele/portage/commit/174a7c7e5527085ea90d173ace3c74ebf52fb46f))
* **bench:** add the S3 adb exec-in spike script ([7e541a2](https://github.com/Michael-Obele/portage/commit/7e541a2291b64777f9fce246609241ebaaf0ec63))
* **bench:** add the send spike guard and record writer ([025c567](https://github.com/Michael-Obele/portage/commit/025c567733fd5ee294133813298cefd0a3ab23e7))
* **durability:** name the path that ran in TypeScript results ([a091da1](https://github.com/Michael-Obele/portage/commit/a091da1bbd317083bc914d64675ddff22c68604a))
* **probes:** stop drive work after three deadline timeouts ([cab3257](https://github.com/Michael-Obele/portage/commit/cab32576bb31e1dcd692b6a652ce3f9c9f7400fc))
* **send:** add send types and the send record ([a2b6e73](https://github.com/Michael-Obele/portage/commit/a2b6e73977ca32241c1d37df211a6fdcb676dcc2))
* **send:** add send types, record, lock, and phone operations ([e54c1c2](https://github.com/Michael-Obele/portage/commit/e54c1c2e721baee133adf70f00df395d61c925a3))
* **send:** add the strict phone listing parser ([5a04854](https://github.com/Michael-Obele/portage/commit/5a04854ac2e207e6c7bcaa4ed5b49529e4d09d86))
* **send:** add the transfer lock and Property 4 test ([7b71af0](https://github.com/Michael-Obele/portage/commit/7b71af0883140b280042353f46e45d9880418590))
* **send:** add typed phone operations to Adb ([ce29d4d](https://github.com/Michael-Obele/portage/commit/ce29d4d89d6b7f0324d763b13d2b6b96316fdec1))
* **shell:** forward frames with a type-only peek ([1cd104c](https://github.com/Michael-Obele/portage/commit/1cd104c17a975b433afe0715a619cb0555af5a3e))


### Bug Fixes

* **doctor:** refuse a root-filesystem destination (R2.14) ([55a24dd](https://github.com/Michael-Obele/portage/commit/55a24dd6008b2bac455b97c54697fd628e930444))
* **durability:** apply dedupe moves through the durable flush path ([8663a3d](https://github.com/Michael-Obele/portage/commit/8663a3d790ded37f0c05d43d2fbf3eb3f63622dd))
* **plan:** an archive row alone does not skip a file the drive lacks ([f109ba3](https://github.com/Michael-Obele/portage/commit/f109ba3aabe3a80533de9d1c29c7d69ed38a0d7b))
* **probes:** bound the Doctor destination and flush checks ([a5dff4a](https://github.com/Michael-Obele/portage/commit/a5dff4abbdb0497e32a97b99ebeed43b68190014))
* **probes:** bound the verify and purge hash reads ([0aa840c](https://github.com/Michael-Obele/portage/commit/0aa840ca07f7d17b5a0c49cf4ed706ba6a79e6fa))
* **probes:** refuse a root-filesystem destination and bound mount checks ([47c2379](https://github.com/Michael-Obele/portage/commit/47c23795fd499729591413126c28203670e05618))
* **probes:** refuse deletes and listings that cannot be read ([ae72aa0](https://github.com/Michael-Obele/portage/commit/ae72aa038692e887ebc597bf70b679b74f34f3f8))
* **probes:** report an unreadable drive read as unreadable ([79fe811](https://github.com/Michael-Obele/portage/commit/79fe811724e2d8d62aaa8f739bcefc4947c5e99c))
* **scan:** match exclusions on whole path segments in the Helper ([b9ef8c7](https://github.com/Michael-Obele/portage/commit/b9ef8c78918136774e55929eb5d1d6aab1b2e23f))
* **scan:** match exclusions on whole segments in the fallback walker ([bcc5893](https://github.com/Michael-Obele/portage/commit/bcc5893e68cac65b8e2295b962e8e4f7e45841f4))
* **shell:** keep the E5 bench clean under clippy and rustfmt ([bee3d6e](https://github.com/Michael-Obele/portage/commit/bee3d6e2cba7a5987a90670c90f22615cf64cafa))
* **trash:** name the path that ran in the trash.empty reply ([cb33c0e](https://github.com/Michael-Obele/portage/commit/cb33c0e3b75431ad4eda1702e9903e109f7b04a1))


### CI

* check src/scan against the branch point and build the Helper ([47c8f01](https://github.com/Michael-Obele/portage/commit/47c8f0154c67ddbc1dc2dbd2099bf145ba1ac1e6))


### Documentation

* **durability:** describe the flush, the probes, and the freeze list ([734a0d1](https://github.com/Michael-Obele/portage/commit/734a0d16d7f26e4c266a68609d407ccd9f18ffc8))
* **specs:** add send-to-phone and durability task plans ([0c62e94](https://github.com/Michael-Obele/portage/commit/0c62e94be78367cd303ffdb215f8b41b156af480))
* **spec:** tick the Phase 3 checkpoint ([8ac9c24](https://github.com/Michael-Obele/portage/commit/8ac9c24cca395c827982871c38f16346f5c120d4))
* **spec:** tick the Phase 4 checkpoint ([6da1d88](https://github.com/Michael-Obele/portage/commit/6da1d88aae6f154506ecf403f3b1d884d16cca44))
* **spec:** tick the Phase 5 checkpoint ([9b76dcd](https://github.com/Michael-Obele/portage/commit/9b76dcd2a51c8ca3c26872d66a66c510041572a1))
* **spec:** tick the Phase 6 checkpoint ([7a4a503](https://github.com/Michael-Obele/portage/commit/7a4a50378774bc12004bfad2c1845b2f71ec6851))
* **spec:** tick the Phase 7 checkpoint ([6c38ccf](https://github.com/Michael-Obele/portage/commit/6c38ccf0136868346ce0fe9547c0a6e91c9f55b1))
* **spec:** tick the send engine core checkpoint ([4e8adfd](https://github.com/Michael-Obele/portage/commit/4e8adfdf813531c0c09efb2516f2d9d511a20ccb))


### Refactoring

* **durability:** drop the sync -f fallback and move moveFile ([2fc3a0d](https://github.com/Michael-Obele/portage/commit/2fc3a0d26e896c6e1beedf21425a8ab88240a5c2))
* **send:** share quoteShellArg and add walk deadlines ([ca3fa92](https://github.com/Michael-Obele/portage/commit/ca3fa92bb3fc9472dddc95cbdd046e4a6cdf2613))


### Tests

* **bench:** add the definition-of-done script ([d2166c7](https://github.com/Michael-Obele/portage/commit/d2166c773bc69c24366981aeb38c6025b06358e0))
* **bench:** add the phone copy exercise ([a233e4a](https://github.com/Michael-Obele/portage/commit/a233e4a8846965bccecfb62a1bb07ce76ba87bfe))
* **bench:** record E2 trash removal on the archive drive ([2e4499f](https://github.com/Michael-Obele/portage/commit/2e4499f69fcf58c93cefe93416b6178cec06dfde))
* **bench:** record E3 move and stat on the archive drive ([ad9fe1e](https://github.com/Michael-Obele/portage/commit/ad9fe1e99f4f1089ff64b7f3f4ac5f8dcfb8ab74))
* **bench:** record E5 frame forwarding cost ([bc85eb0](https://github.com/Michael-Obele/portage/commit/bc85eb0d8c66db080c1762819a192a136cf02717))
* **bench:** record phone listing timings for send ([d04637f](https://github.com/Michael-Obele/portage/commit/d04637f8687db742277ec3b278b31e5f6c2dd548))
* **bench:** record phone listing timings for send ([5e4ac6c](https://github.com/Michael-Obele/portage/commit/5e4ac6c4121e9497017e481ad1fe6f60c868c9b6))
* **bench:** record S1 binary stream results on a phone ([0cb5a8b](https://github.com/Michael-Obele/portage/commit/0cb5a8b13755dcdf7b2ea6cd454edebf3deb2751))
* **bench:** record S2 phone sync results ([73240bb](https://github.com/Michael-Obele/portage/commit/73240bbedd846d9c1576e1b52b3da2eb7c190669))
* **bench:** record S3 adb exec-in results ([a016cb3](https://github.com/Michael-Obele/portage/commit/a016cb3822a7d647c4e803508ef62f22f61d4d69))
* **bench:** record the definition-of-done runs ([b6a338d](https://github.com/Michael-Obele/portage/commit/b6a338da7033a3cd0e03c778b00747db7a71defb))
* **bench:** record the definition-of-done runs after the planner fix ([c9855ba](https://github.com/Michael-Obele/portage/commit/c9855baaa9e384a067556fc27cbd53d9e421ebe8))
* **bench:** record the definition-of-done runs on the final code ([7e4a7ae](https://github.com/Michael-Obele/portage/commit/7e4a7ae518564aba25fd348129a2441ba4e29c6f))
* **bench:** record the Doctor check on the archive drive ([fc5dccc](https://github.com/Michael-Obele/portage/commit/fc5dcccfa83c2bdd7dbed25936f6a104ab6afc21))
* **bench:** record the phone copy run ([5b25686](https://github.com/Michael-Obele/portage/commit/5b25686c6c23fe2ef06553011db1c6e14e3c9fa4))
* **bench:** record the scan exclusion on the archive drive ([fe88876](https://github.com/Michael-Obele/portage/commit/fe88876bb070fe405e3d327c4792beed55bc2efc))
* **bench:** record the trash run on the archive drive ([a24e35c](https://github.com/Michael-Obele/portage/commit/a24e35c28ad4af22ae13f48a4c582ac849e03e01))
* **bench:** wait for the phone run and read its journal rows ([c77b2ed](https://github.com/Michael-Obele/portage/commit/c77b2ed75c49e3da4139bcf101f78c576812358f))
* **durability:** check the Appendix A rows and exact texts ([afc4029](https://github.com/Michael-Obele/portage/commit/afc4029c41aed958fedb7ee17f8d2c7e7e6f0b5d))
* **durability:** name the path that ran in TypeScript results (red) ([d92c56d](https://github.com/Michael-Obele/portage/commit/d92c56da0d0520bce86a24e019acb6ff8b1c240c))
* **probes:** add red tests for unreadable drive reads ([5ceb213](https://github.com/Michael-Obele/portage/commit/5ceb213255e102aecef3c41075b502c98a07c522))
* **send:** add red Property 34 test for the phone listing ([dc67ac3](https://github.com/Michael-Obele/portage/commit/dc67ac3943ebe931c1179fb945d28c6958e5fd8f))
* **send:** add red test for the exec-out byte stream ([50e152a](https://github.com/Michael-Obele/portage/commit/50e152aa0fba477b208ceae27e8b24ee29f4e713))
* **send:** add red tests for listing timing ([4366bf2](https://github.com/Michael-Obele/portage/commit/4366bf2e067f002fb48ccf7a46ce116e4805259c))
* **send:** add red tests for shared helpers ([7fd5c95](https://github.com/Michael-Obele/portage/commit/7fd5c95f1892f4a727cca177597c24200302c89c))
* **send:** add red tests for the S1 verdict ([b3946f9](https://github.com/Michael-Obele/portage/commit/b3946f95433acf8882839b7a4d340bdc9bbf90ac))
* **send:** add red tests for the S2 verdict ([b6f01db](https://github.com/Michael-Obele/portage/commit/b6f01db89ae13615fa01af7022433eb890d1716b))
* **send:** add red tests for the S3 verdict ([7403dc2](https://github.com/Michael-Obele/portage/commit/7403dc27331d830f0c34a843c856e969838b8032))
* **send:** add red tests for the send record ([7ce8ae1](https://github.com/Michael-Obele/portage/commit/7ce8ae1670d063f90a6991f6388ff2f5418eb274))
* **send:** add red tests for the spike guard ([eaacff7](https://github.com/Michael-Obele/portage/commit/eaacff7f09de469d0b8ad543694221bde764397d))
* **send:** add red tests for typed phone operations ([9149dc4](https://github.com/Michael-Obele/portage/commit/9149dc49ab08337c75d702f2ff3638dab8c20693))

## [0.1.18](https://github.com/Michael-Obele/portage/compare/v0.1.17...v0.1.18) (2026-11-26)


### Features

* **durability:** add probe, dirty ledger, and flush primitives ([fd933c2](https://github.com/Michael-Obele/portage/commit/fd933c2775f6c3fa10921f2fb887b3cde175e868))


### Bug Fixes

* **durability:** flush each drive copy before recording it written ([88200aa](https://github.com/Michael-Obele/portage/commit/88200aafb89688a7e12061e7643563a0fb12101d))


### Tests

* **bench:** record E1 flush measurements on the archive drive ([1f9bf28](https://github.com/Michael-Obele/portage/commit/1f9bf28d6e0865ae364bc44193b430c322cf181f))
* **bench:** record E4 Bun sync results on the archive drive ([a003691](https://github.com/Michael-Obele/portage/commit/a0036913915cc1d9fa063414d316c08c8c420d52))
* **bench:** record E4 Bun sync results on the archive drive ([5f4f245](https://github.com/Michael-Obele/portage/commit/5f4f245057e9d86cd92d6ac821d1526404bc96a6))

## [0.1.17](https://github.com/Michael-Obele/portage/compare/v0.1.16...v0.1.17) (2026-11-18)


### Features

* **desktop:** a scan you can see and stop ([b3701d5](https://github.com/Michael-Obele/portage/commit/b3701d508cceb58338b3216c07a1e24bc5e411cb))


### Bug Fixes

* **ci:** find Chrome anywhere, and start it in a container ([a756958](https://github.com/Michael-Obele/portage/commit/a756958ba88e28b461e86fe8286a107a3d56b672))

## [0.1.16](https://github.com/Michael-Obele/portage/compare/v0.1.15...v0.1.16) (2026-11-17)


### Features

* **desktop:** reclaim the trash, and scan drives in Rust ([4c889e9](https://github.com/Michael-Obele/portage/commit/4c889e9a044311a48e458a140e8e2a9b858ea129))


### Refactoring

* drop the CLI and the TUI; the app is the only front end ([1774875](https://github.com/Michael-Obele/portage/commit/17748752a5f1e1dc0d1d98b809400a7a7d5d1e5a))

## [0.1.15](https://github.com/Michael-Obele/portage/compare/v0.1.14...v0.1.15) (2026-11-16)


### Features

* read real archive filenames, survive a wedged drive, and keep screen state ([#20](https://github.com/Michael-Obele/portage/issues/20)) ([1e2f07b](https://github.com/Michael-Obele/portage/commit/1e2f07b03569299867016943a0d806615160176d))

## [0.1.14](https://github.com/Michael-Obele/portage/compare/v0.1.13...v0.1.14) (2026-11-14)


### Features

* **desktop:** add shadcn UI components for alert-dialog, alert, empty, ([d271d10](https://github.com/Michael-Obele/portage/commit/d271d1031397ee55243c45bad896644ca968da80))
* **desktop:** add the Purge and Doctor screens ([dc554ef](https://github.com/Michael-Obele/portage/commit/dc554efaf6a8ab07657ce39b76c2411b3ddbcf85))


### Bug Fixes

* **desktop:** fill the window, pin actions, refuse unsafe drives ([5e74bf4](https://github.com/Michael-Obele/portage/commit/5e74bf40ae32b13f2ef06e392fa29e490811b8d8))
* **desktop:** sync Cargo.lock with the 0.1.13 bump ([5849b93](https://github.com/Michael-Obele/portage/commit/5849b9331d70d8b0ab7e09948d215da8bdb1b743))
* **engine:** skip folder markers and revalidate purge plans ([5e066bb](https://github.com/Michael-Obele/portage/commit/5e066bb27e6de64671b46728024044f9a7e7fb2e))


### Refactoring

* **desktop:** build shared components on shadcn primitives ([b715b99](https://github.com/Michael-Obele/portage/commit/b715b9976c22a142a8421a46ea7bd2002fdb2b35))

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
