/**
 * Stage the engine binary where Tauri's bundler looks for it.
 *
 * `externalBin` names the binary WITHOUT a target triple; Tauri appends the
 * host triple when it resolves the file, so the staged copy must carry it.
 * Run from apps/desktop: `bun run sidecar`, or `SKIP_BUILD=1 bun run sidecar`
 * to restage a binary that is already in dist/.
 *
 * TWO binaries are staged: the engine (`portage`) and the Rust scanner
 * (`portage-scan`). The scanner is not optional — it is what makes a whole-drive
 * scan take 4 s instead of 3 minutes — so a build that silently omits it would
 * ship a product that feels broken. Its absence is therefore a FAILURE here, and
 * Doctor reports it if it is somehow missing at runtime.
 */
/// <reference types="bun" />
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const appRoot = dirname(import.meta.dir);
const repoRoot = resolve(appRoot, '..', '..');
const built = join(repoRoot, 'dist', 'portage');
const stagedDir = join(appRoot, 'src-tauri', 'binaries');

function fail(message: string): never {
	console.error(`sidecar: ${message}`);
	process.exit(1);
}

/** Run a command to completion in `cwd`, or die with its exit code. */
function run(command: string[], cwd: string): void {
	const result = Bun.spawnSync(command, {
		cwd,
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit'
	});
	if (result.exitCode !== 0) {
		fail(`\`${command.join(' ')}\` failed with exit code ${result.exitCode} (cwd ${cwd})`);
	}
}

if (process.env.SKIP_BUILD !== '1') {
	console.log(`sidecar: building the engine (bun run build in ${repoRoot})`);
	run(['bun', 'run', 'build'], repoRoot);
}

if (!existsSync(built)) {
	fail(`${built} is missing; run the root build first, or unset SKIP_BUILD=1`);
}

const triple = new TextDecoder()
	.decode(Bun.spawnSync(['rustc', '--print', 'host-tuple']).stdout)
	.trim();
if (triple === '') {
	fail('`rustc --print host-tuple` printed nothing; is rustc on PATH?');
}

mkdirSync(stagedDir, { recursive: true });
const staged = join(stagedDir, `portage-${triple}`);
await Bun.write(staged, Bun.file(built));
chmodSync(staged, 0o755);

console.log(`sidecar: staged ${staged} (${statSync(staged).size} bytes)`);
console.log('sidecar: externalBin stays "binaries/portage", with no triple');

// --- the scanner ------------------------------------------------------------
// Built by `bun run build:scanner` (or restaged with SKIP_BUILD=1). It must sit
// beside the engine so `process.execPath`'s directory finds it in the bundle.
if (process.env.SKIP_BUILD !== '1') {
	console.log(`sidecar: building the scanner (bun run build:scanner in ${repoRoot})`);
	run(['bun', 'run', 'build:scanner'], repoRoot);
}

const scannerBuilt = join(repoRoot, 'dist', 'portage-scan');
if (!existsSync(scannerBuilt)) {
	fail(
		`${scannerBuilt} is missing; run \`bun run build:scanner\` (needs cargo), or unset SKIP_BUILD=1`
	);
}
const scannerStaged = join(stagedDir, `portage-scan-${triple}`);
await Bun.write(scannerStaged, Bun.file(scannerBuilt));
chmodSync(scannerStaged, 0o755);

console.log(`sidecar: staged ${scannerStaged} (${statSync(scannerStaged).size} bytes)`);
console.log('sidecar: externalBin is "binaries/portage" + "binaries/portage-scan", no triples');
