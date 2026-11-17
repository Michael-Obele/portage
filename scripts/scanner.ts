/**
 * Build the Rust scanner and put it where the engine looks for it.
 *
 * `crates/portage-scan` is the walker and digester: 4.1 s over the real 2 TB
 * archive against 178.5 s for the built-in JavaScript walker, because it descends
 * by relative path and JavaScript has no `openat`. It is a separate binary on
 * purpose — a process that `chdir`s is how GNU find does the same tree in 2.5 s.
 *
 * The engine finds it in three places, tried in this order (see
 * `src/dedupe/scanner.ts`): `$PORTAGE_SCAN`, next to the engine binary, then
 * `crates/portage-scan/target/release`. This script produces the first two.
 *
 * Run from the repo root: `bun run build:scanner`. `SKIP_BUILD=1` restages an
 * existing binary instead of rebuilding it.
 */
/// <reference types="bun" />
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const crateDir = join(repoRoot, 'crates', 'portage-scan');
const built = join(crateDir, 'target', 'release', 'portage-scan');
const staged = join(repoRoot, 'dist', 'portage-scan');

function fail(message: string): never {
	console.error(`scanner: ${message}`);
	process.exit(1);
}

if (process.env.SKIP_BUILD !== '1') {
	console.log(`scanner: building ${crateDir}`);
	const result = Bun.spawnSync(['cargo', 'build', '--release'], {
		cwd: crateDir,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit'
	});
	if (result.exitCode !== 0) {
		fail(`cargo build --release exited ${result.exitCode} (cwd ${crateDir})`);
	}
}

if (!existsSync(built)) {
	fail(`${built} is missing; run without SKIP_BUILD=1, or build the crate first`);
}

mkdirSync(dirname(staged), { recursive: true });
copyFileSync(built, staged);
chmodSync(staged, 0o755);

// The version the engine will report on Doctor, read from the binary itself so a
// stale copy cannot claim to be current.
const version = new TextDecoder()
	.decode(Bun.spawnSync([staged, '--version']).stdout)
	.trim();

console.log(`scanner: staged ${staged} (${statSync(staged).size} bytes)`);
console.log(`scanner: ${version}`);
