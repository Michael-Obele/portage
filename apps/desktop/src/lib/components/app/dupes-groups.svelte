<script lang="ts">
	/**
	 * One block per duplicate group: the tier, the engine's own reason, and the
	 * copies as rows.
	 *
	 * The reason sentence is printed VERBATIM. It is the only place that says
	 * *why* two files were put together ("byte-identical: same size and same
	 * sha256 over the whole file" versus "same episode, different release"), and
	 * paraphrasing it would turn an engine verdict into app copy.
	 *
	 * A keeper is marked with a chip that carries a word, not a colour: delete
	 * the palette and the row still says "kept".
	 */
	import { Button } from '../ui/button/index.js';
	import { Checkbox } from '../ui/checkbox/index.js';
	import { formatBytes, plural, truncateFront } from '../../util/format.ts';
	import { groupKeys, groupSelectionState, memberTone } from './dupes-view.ts';
	import type { WireDupeGroup } from '../../engine/protocol.ts';
	import StateChip from './state-chip.svelte';
	import { CONTROL } from './tokens.ts';

	let {
		groups,
		selection,
		ontoggle,
		onselectgroup,
		oncleargroup
	}: {
		groups: WireDupeGroup[];
		selection: ReadonlySet<string>;
		ontoggle: (key: string) => void;
		onselectgroup: (keys: string[]) => void;
		oncleargroup: (keys: string[]) => void;
	} = $props();
</script>

<div class="flex flex-col gap-6">
	{#each groups as group (group.id)}
		{@const state = groupSelectionState(group, selection)}
		<section class="flex flex-col gap-2">
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h2 class="min-w-0 truncate text-lead font-medium text-foreground">
					{group.label ?? `Tier ${group.tier}, group ${group.id}`}
				</h2>
				{#if group.label !== null}
					<span class="text-label text-muted-foreground">Tier {group.tier}</span>
				{/if}
				<span class="text-label text-muted-foreground" data-numeric>
					{plural(group.members.length, 'file')} · {formatBytes(group.reclaimableBytes)} reclaimable
				</span>
				<div class="ms-auto flex items-center gap-1">
					<Button
						class={CONTROL}
						variant="outline"
						size="xs"
						disabled={state === 'all'}
						onclick={() => onselectgroup(groupKeys(group))}
					>
						Select all
					</Button>
					<Button
						class={CONTROL}
						variant="outline"
						size="xs"
						disabled={state === 'none'}
						onclick={() => oncleargroup(groupKeys(group))}
					>
						Clear
					</Button>
				</div>
			</div>

			<p class="measure text-label text-muted-foreground">{group.reason}</p>

			<ul class="divide-y divide-border rounded-[var(--radius-surface)] border border-border">
				{#each group.members as member (member.key)}
					{@const tone = memberTone(member)}
					<li class="flex items-center gap-3 px-3 py-2">
						<Checkbox
							checked={selection.has(member.key)}
							onCheckedChange={() => ontoggle(member.key)}
							aria-label={`Select ${member.relative} for the trash`}
						/>
						<div class="flex min-w-0 flex-1 flex-col">
							<span class="font-mono text-label break-all text-foreground" title={member.path}>
								{truncateFront(member.relative, 96)}
							</span>
							<span class="sr-only">{member.path}</span>
							{#if member.suspicious !== null || member.scoreReason !== null || member.score !== null}
								<span class="text-caption text-muted-foreground">
									{#if member.suspicious !== null}
										<span>flagged {member.suspicious}</span>
									{/if}
									{#if member.score !== null}
										<span>{member.suspicious !== null ? ' · ' : ''}{member.score}</span>
									{/if}
									{#if member.scoreReason !== null}
										<span
											>{member.suspicious !== null || member.score !== null
												? ' · '
												: ''}{member.scoreReason}</span
										>
									{/if}
								</span>
							{/if}
						</div>
						<StateChip state={tone} />
						<span class="shrink-0 font-mono text-label text-muted-foreground tabular-nums">
							{formatBytes(member.size)}
						</span>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>
