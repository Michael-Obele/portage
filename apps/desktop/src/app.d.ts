// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	/**
	 * The app version, injected by Vite at build time from `package.json` (see
	 * `define` in `vite.config.ts`). Never a literal in the source: a version
	 * that is typed somewhere is a version that goes stale.
	 */
	const __APP_VERSION__: string;

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
