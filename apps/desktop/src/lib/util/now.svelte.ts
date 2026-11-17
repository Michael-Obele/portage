/**
 * A clock the UI can read.
 *
 * A relative phrase ("2 minutes ago") is only true for a moment. Rendering it
 * from a single `Date.now()` taken at mount makes it drift into a lie while the
 * screen sits open, which is exactly the kind of quiet wrongness this app is
 * built against. So a screen that shows an age reads a ticking value.
 *
 * 30 s is chosen so a phrase can be at most half a minute stale — the thresholds
 * it feeds are minutes and hours — while costing one interval per mounted screen
 * rather than a frame-by-frame timer.
 *
 * Must be called during component initialisation: it registers an effect on the
 * calling component, which is also what cleans the interval up.
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
