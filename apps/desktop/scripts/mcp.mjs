#!/usr/bin/env node
/**
 * Drive the running Tauri dev app through its MCP bridge, from a plain shell.
 *
 *   node scripts/mcp.mjs --list
 *   node scripts/mcp.mjs webview_dom_snapshot '{"type":"accessibility"}'
 *   node scripts/mcp.mjs webview_execute_js '{"code":"document.title"}'
 *   node scripts/mcp.mjs webview_screenshot '{}'      # writes ./mcp-shot.jpg
 *
 * It starts `@hypothesi/tauri-mcp-server` over stdio, opens a driver session
 * against the app's loopback bridge (127.0.0.1:9223), calls one tool, prints the
 * result, and exits. `bun run tauri:dev` must be running.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SERVER = ['-y', '-p', '@hypothesi/tauri-mcp-server', 'mcp-server-tauri'];
const args = process.argv.slice(2);

if (args.length === 0) {
	console.error('usage: node scripts/mcp.mjs <tool> [json-args] | --list');
	process.exit(2);
}

const listMode = args[0] === '--list';
const tool = listMode ? null : args[0];
let toolArgs = {};
if (args[1]) {
	try {
		const raw = args[1].startsWith('@') ? readFileSync(args[1].slice(1), 'utf8') : args[1];
		toolArgs = JSON.parse(raw);
	} catch {
		console.error('second argument must be JSON, or @path to a JSON file');
		process.exit(2);
	}
}

const p = spawn('npx', SERVER, { stdio: ['pipe', 'pipe', 'inherit'] });
/** @param {object} o */
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');

/** @param {any} result */
function printResult(result) {
	if (!result) return;
	if (result.error) {
		console.log('ERROR:', JSON.stringify(result.error).slice(0, 2000));
		return;
	}
	for (const part of result.content ?? []) {
		if (part.type === 'text') console.log(part.text);
		else if (part.type === 'image') {
			const file = 'mcp-shot.' + (part.mimeType?.includes('png') ? 'png' : 'jpg');
			writeFileSync(file, Buffer.from(part.data, 'base64'));
			console.log(`[image ${part.mimeType} -> ${file}]`);
		} else console.log(JSON.stringify(part));
	}
}

let buf = '';
p.stdout.on('data', (d) => {
	buf += d.toString();
	let i;
	while ((i = buf.indexOf('\n')) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let m;
		try {
			m = JSON.parse(line);
		} catch {
			continue;
		}

		if (m.id === 1) {
			send({ jsonrpc: '2.0', method: 'notifications/initialized' });
			if (listMode) {
				send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
			} else {
				send({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'driver_session', arguments: { action: 'start' } }
				});
			}
		} else if (m.id === 2) {
			if (listMode) {
				for (const t of m.result?.tools ?? []) {
					console.log(t.name, '->', JSON.stringify(t.inputSchema?.properties ?? {}));
				}
				finish();
			} else if (m.error || m.result?.isError) {
				printResult(m.result ?? { error: m.error });
				finish(1);
			} else {
				send({
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/call',
					params: { name: tool, arguments: toolArgs }
				});
			}
		} else if (m.id === 3) {
			printResult(m.result ?? { error: m.error });
			finish(m.result?.isError ? 1 : 0);
		}
	}
});
p.stdout.on('error', () => {});
p.stdin.on('error', () => {});

function finish(code = 0) {
	p.kill();
	process.exit(code);
}

send({
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2024-11-05',
		capabilities: {},
		clientInfo: { name: 'mcp.mjs', version: '0' }
	}
});

setTimeout(() => {
	console.error('timeout waiting for the app (is `bun run tauri:dev` running?)');
	finish(1);
}, 30000);
