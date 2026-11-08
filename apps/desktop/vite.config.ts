import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// One version for the app and the installer, read from package.json at build
// time, so the bundle and the release note can never disagree.
const { version } = JSON.parse(
	readFileSync(new URL('./package.json', import.meta.url), 'utf8')
);

export default defineConfig({
	define: { __APP_VERSION__: JSON.stringify(version) },
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Tauri loads index.html from disk: SPA mode, no server, and every
			// route resolves to the fallback page.
			adapter: adapter({ fallback: 'index.html' })
		})
	],
	// Tauri's devUrl is pinned to 5174. Without strictPort a busy port makes
	// vite move while Tauri keeps waiting, and the window stays blank.
	server: { port: 5174, strictPort: true }
});
