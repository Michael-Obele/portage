/**
 * A clock the UI can read, so an age cannot drift into a lie while a screen sits
 * open. Ticks every 30 s; call during component init.
 */
export function createNow(intervalMs = 30_000): { readonly now: number } {
	const clock = $state({ now: Date.now() });
	$effect(() => {
		const id = setInterval(() => {
			clock.now = Date.now();
		}, intervalMs);
		return () => clearInterval(id);
	});
	return clock;
}
