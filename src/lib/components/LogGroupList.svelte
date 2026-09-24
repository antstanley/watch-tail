<script lang="ts">
	import { fitGroupName } from '$lib/group-name';
	import { formatBytes, formatCount, formatTimestamp } from '$lib/format';
	import { MAX_GROUP_ROWS, noArchivedGroupsMessage, noGroupsMessage } from '$lib/groups-client';
	import type { LogGroupSummary, StreamSource } from '$lib/types';

	type Props = {
		/** Groups returned for the active region. */
		groups?: LogGroupSummary[];
		/** Where the list came from; the archive list shows local counts instead of sizes. */
		source?: StreamSource;
		/** Active region, used for context in the empty state. */
		region?: string;
		/** Names of the groups currently being tailed; empty when none are selected. */
		selected?: string[];
		loading?: boolean;
		/** API error message, shown instead of the list. */
		error?: string | null;
		/** Row cap; defaults to {@link MAX_GROUP_ROWS}. */
		maxRows?: number;
		/** Called with the group name when a row is clicked, replacing the selection. */
		onSelect?: (name: string) => void;
		/** Called with the group name when its checkbox is toggled in or out of the selection. */
		onToggle?: (name: string) => void;
		/** Called when the refresh button is clicked. */
		onRefresh?: () => void;
	};

	let {
		groups = [],
		source = 'cloudwatch',
		region = '',
		selected = [],
		loading = false,
		error = null,
		maxRows = MAX_GROUP_ROWS,
		onSelect,
		onToggle,
		onRefresh,
	}: Props = $props();

	let search = $state('');

	/** True when the list holds archived groups rather than live CloudWatch ones. */
	let archived = $derived(source === 'archive');

	/** Badge text for a group: how many events the archive holds for it. */
	function archivedCount(group: LogGroupSummary): string | null {
		return group.archivedEvents === undefined
			? null
			: `${formatCount(group.archivedEvents)} archived`;
	}

	/** `oldest -> newest` span of a group's archived events, or `null` when unknown. */
	function archivedSpan(group: LogGroupSummary): string | null {
		if (group.archivedOldest === undefined || group.archivedNewest === undefined) return null;
		return `${formatTimestamp(group.archivedOldest)} \u2192 ${formatTimestamp(group.archivedNewest)}`;
	}

	/** Groups matching the search box, case-insensitively. */
	let filtered = $derived(
		groups.filter((group) => group.name.toLowerCase().includes(search.trim().toLowerCase())),
	);
	/** Rows actually rendered, capped at `maxRows`. */
	let visible = $derived(filtered.slice(0, maxRows));
	let truncated = $derived(filtered.length > visible.length);
	let query = $derived(search.trim());

	/**
	 * Selection as a flat list of names. `selected` is typed as a list, but callers that have not
	 * migrated yet may still pass a single name (or `null`), so those are normalised here.
	 */
	function selectionList(value: string[] | string | null | undefined): string[] {
		if (value === null || value === undefined) return [];
		return Array.isArray(value) ? value : [value];
	}

	let activeSelection = $derived(selectionList(selected));

	/** True when `name` is part of the current (possibly multi-group) selection. */
	function isSelected(name: string): boolean {
		return activeSelection.includes(name);
	}

	/** Row styling, highlighting every group that is currently being tailed. */
	function rowTone(name: string): string {
		return isSelected(name)
			? 'border-sky-800 bg-sky-950/50 text-sky-200'
			: 'border-transparent bg-neutral-900/60 text-neutral-300 hover:border-neutral-800 hover:text-neutral-100';
	}
</script>

<section class="flex min-h-0 flex-1 flex-col gap-3">
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-baseline gap-2">
			<span class="text-xs text-neutral-500" data-testid="group-count">
				{formatCount(filtered.length)} of {formatCount(groups.length)}
			</span>
			{#if activeSelection.length > 1}
				<span class="text-xs font-medium text-sky-400" data-testid="selected-count">
					{formatCount(activeSelection.length)} selected
				</span>
			{/if}
			{#if archived}
				<span
					class="rounded-full border border-teal-900 bg-teal-950/50 px-1.5 py-0.5 text-[0.625rem] font-medium text-teal-300"
					data-testid="group-source-badge"
				>
					local
				</span>
			{/if}
		</div>
		<button
			type="button"
			onclick={() => onRefresh?.()}
			disabled={loading}
			class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
		>
			{loading ? 'Refreshing…' : 'Refresh'}
		</button>
	</div>

	<div class="flex flex-col gap-1.5">
		<label class="sr-only" for="group-search">Search log groups</label>
		<input
			id="group-search"
			type="search"
			placeholder="Search log groups"
			value={search}
			oninput={(event) => (search = event.currentTarget.value)}
			class="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 hover:border-neutral-700 focus:border-sky-600"
		/>
	</div>

	{#if error !== null && error !== ''}
		<p
			role="alert"
			data-testid="group-error"
			class="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs leading-5 text-red-300"
		>
			{error}
		</p>
	{:else if loading && groups.length === 0}
		<div class="flex flex-col gap-2" data-testid="group-loading" aria-busy="true">
			{#each Array.from({ length: 5 }) as _row, index (index)}
				<div class="h-5 animate-pulse rounded bg-neutral-800/80"></div>
			{/each}
			<p class="text-xs text-neutral-500">Loading log groups…</p>
		</div>
	{:else if groups.length === 0}
		<p
			data-testid="group-empty"
			class="rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs leading-5 text-neutral-400"
		>
			{archived ? noArchivedGroupsMessage(region) : noGroupsMessage(region)}
		</p>
	{:else if visible.length === 0}
		<p data-testid="group-no-match" class="px-1 py-2 text-xs text-neutral-500">
			No log groups match “{query}”.
		</p>
	{:else}
		<ul class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
			{#each visible as group (group.arn ?? group.name)}
				<li class="flex items-center gap-1.5">
					<input
						type="checkbox"
						data-testid="group-check-{group.name}"
						aria-label={`Include ${group.name} in the selection`}
						checked={isSelected(group.name)}
						onchange={() => onToggle?.(group.name)}
						class="size-3.5 shrink-0 cursor-pointer accent-sky-500"
					/>
					<button
						type="button"
						data-testid="group-row"
						data-group-name={group.name}
						aria-label={group.name}
						title={group.name}
						aria-current={isSelected(group.name) ? 'true' : undefined}
						onclick={() => onSelect?.(group.name)}
						class="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors {rowTone(
							group.name,
						)}"
					>
						<span
							class="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-mono"
							use:fitGroupName={group.name}
							aria-hidden="true">{group.name}</span
						>
						{#if archived}
							<span class="flex shrink-0 items-center gap-1.5">
								{#if archivedCount(group) !== null}
									<span
										data-testid="group-archived-count"
										title={archivedSpan(group) ?? 'Events held in the local DuckDB archive'}
										class="rounded-full border border-teal-900 bg-teal-950/50 px-1.5 py-0.5 text-[0.625rem] font-medium text-teal-300"
									>
										{archivedCount(group)}
									</span>
								{/if}
								{#if archivedSpan(group) !== null}
									<!-- The span needs room, so it only appears on wide sidebars. -->
									<span
										class="hidden text-[0.6875rem] text-neutral-500 xl:inline"
										data-testid="group-archived-span"
									>
										{archivedSpan(group)}
									</span>
								{/if}
							</span>
						{:else if group.storedBytes !== undefined}
							<span class="shrink-0 text-[0.6875rem] text-neutral-500">
								{formatBytes(group.storedBytes)}
							</span>
						{/if}
					</button>
				</li>
			{/each}
		</ul>
		{#if truncated}
			<p class="text-[0.6875rem] text-neutral-500" data-testid="group-truncated">
				Showing first {formatCount(maxRows)} of {formatCount(filtered.length)} groups.
			</p>
		{/if}
	{/if}
</section>
