/**
 * Stage the engine binary where Tauri's bundler looks for it.
 *
 * `externalBin` names the binary WITHOUT a target triple; Tauri appends the
 * host triple when it resolves the file, so the staged copy must carry it.
 * Run from apps/desktop: `bun run sidecar`, or `SKIP_BUILD=1 bun run sidecar`
 * to restage a binary that is already in dist/.
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
