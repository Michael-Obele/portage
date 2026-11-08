<script lang="ts">
	/**
	 * A route that the shell can reach but that has no screen yet.
	 *
	 * The rail must not offer a dead link, so each screen the next phase builds
	 * gets a page that says plainly what it will be and what it will read. This
	 * is scaffolding, not a design.
	 */
	import { EmptyState, PageHeader } from './index.ts';

	let {
		title,
		summary,
		body,
	}: {
		title: string;
		summary: string;
		body: string;
	} = $props();
</script>

<PageHeader {title} {summary} />
<div class="px-6">
	<EmptyState title="Not built yet" {body} />
</div>
