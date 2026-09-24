<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { ArrowRight, ChevronDown, ChevronRight } from '@lucide/svelte';
	import { selectedChartEvents, type ChartSelection } from '$lib/chart-selection';
	import ColumnResizer from './ColumnResizer.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import { formatCount, formatSpan, formatTime, formatTimestamp } from '$lib/format';
	import { describeArchive, describeStreamError } from '$lib/groups-client';
	import {
		detectLevel,
		effectiveLevel,
		eventKey,
		filterByLevel,
		filterEvents,
		levelColorClass,
	} from '$lib/log-buffer';
	import type { LogLevel } from '$lib/log-buffer';
	import { findJsonInMessage, formatLogMessage, tokenizeJson } from '$lib/log-format';
	import type { JsonToken } from '$lib/log-format';
	import { requestRows } from '$lib/request-groups';
	import type { RequestRow } from '$lib/request-groups';
	import { PREFIX_WIDTH, STORAGE_KEYS, parseStoredWidth, remToPx } from '$lib/resize';
	import { textSize } from '$lib/text-size.svelte';
	import { LEVEL_LABELS } from '$lib/series-buckets';
	import { describeWindow } from '$lib/time-range';
	import type { LogMode } from '$lib/time-range';
	import type {
		LogEventDto,
		SeriesLevel,
		StreamErrorPayload,
		StreamReadyPayload,
		StreamState,
	} from '$lib/types';

	type Props = {
		selection?: ChartSelection | null;
		onSelectionClear?: () => void;
		/** Lines held by the client buffer, oldest first. */
		lines?: LogEventDto[];
		/** Connection status. */
		status?: StreamState;
		/** Last stream error, or `null`. */
		error?: StreamErrorPayload | null;
		/** Active region, used for error and empty-state context. */
		region?: string;
		/** Group being tailed, or `null` when nothing is selected. */
		group?: string | null;
		/** Client-side text filter, controlled by the parent. */
		filter?: string;
		/** True while the visible buffer is frozen. */
		paused?: boolean;
		/** True when new lines scroll the view. */
		autoScroll?: boolean;
		/** Lines held back while paused. */
		pendingCount?: number;
		/** Lines dropped by the cap. */
		droppedCount?: number;
		/** Total events received since the last reset. */
		receivedCount?: number;
		/** Active tail mode, used for the window chip. */
		mode?: LogMode;
		/** Last `ready` payload, which describes the window the server is scanning. */
		ready?: StreamReadyPayload | null;
		/** Reason the server ended the stream, for example `window-complete`. */
		endReason?: string | null;
		/** Database file behind the local archive, shown in the archive tooltip. */
		archivePath?: string | null;
		/** Log groups in the view; more than one adds a group column. */
		groups?: string[];
		/**
		 * Active level filter. Leave it undefined to let the viewer own the filter;
		 * pass a value (including `null`) to control it from outside, which is how
		 * the chart above stays in step with the chips.
		 */
		level?: LogLevel | null;
		/** Called when the level filter changes while it is controlled. */
		onLevelChange?: (level: LogLevel | null) => void;
		/**
		 * Group lines that share a request id into one row, opened on demand. On by
		 * default, and owned by the page so the chart counts the same requests.
		 */
		groupRequests?: boolean;
		/** Called when the grouping toggle is pressed. */
		onGroupToggle?: () => void;
		/** True while the lines are shown; collapsed, the viewer keeps only its header. */
		open?: boolean;
		/** Called when the header's collapse toggle is pressed. */
		onToggle?: () => void;
		onFilterChange?: (value: string) => void;
		onPauseToggle?: () => void;
		onClear?: () => void;
		onAutoScrollToggle?: () => void;
	};

	let {
		selection = null,
		onSelectionClear,
		lines = [],
		status = 'idle',
		error = null,
		region = '',
		group = null,
		filter = '',
		paused = false,
		autoScroll = true,
		pendingCount = 0,
		droppedCount = 0,
		receivedCount = 0,
		mode = 'live',
		ready = null,
		endReason = null,
		archivePath = null,
		groups = [],
		level = undefined,
		onLevelChange,
		groupRequests = true,
		onGroupToggle,
		open = true,
		onToggle,
		onFilterChange,
		onPauseToggle,
		onClear,
		onAutoScrollToggle,
	}: Props = $props();

	const TIMESTAMP_COLUMN_PX = remToPx(7.5);
	let timestampPx = $state(TIMESTAMP_COLUMN_PX);
	let groupPx = $state(144);
	// Row padding and gap mirror the `px-3`/`gap-2` classes, so they follow the
	// text size and the column handles stay on their edges.
	let rowPaddingPx = $derived(remToPx(0.75, textSize.rootFontPx));
	let rowGapPx = $derived(remToPx(0.5, textSize.rootFontPx));
	const PREFIX_MIN_PX = remToPx(PREFIX_WIDTH.minRem);
	const PREFIX_MAX_PX = remToPx(PREFIX_WIDTH.maxRem);
	const PREFIX_DEFAULT_PX = remToPx(PREFIX_WIDTH.defaultRem);

	/** Reads a raw preference, tolerating disabled or throwing storage. */
	function readPref(key: string): string | null {
		try {
			if (typeof localStorage === 'undefined') return null;
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	/** Persists a preference; failures are ignored (private mode, quota). */
	function writePref(key: string, value: string): void {
		try {
			if (typeof localStorage === 'undefined') return;
			localStorage.setItem(key, value);
		} catch {
			// Preferences are best-effort only.
		}
	}

	/** View preferences, restored in `onMount` so SSR output stays deterministic. */
	let wrapLines = $state(false);
	let jsonView = $state(true);
	let prefixPx = $state(PREFIX_DEFAULT_PX);

	onMount(() => {
		timestampPx = parseStoredWidth(readPref(STORAGE_KEYS.timestampWidth), 120, 64, 320);
		groupPx = parseStoredWidth(readPref(STORAGE_KEYS.groupWidth), 144, 64, 640);
		wrapLines = readPref(STORAGE_KEYS.wrap) === 'true';
		jsonView = readPref(STORAGE_KEYS.jsonView) !== 'false';
		prefixPx = parseStoredWidth(
			readPref(STORAGE_KEYS.prefixWidth),
			PREFIX_DEFAULT_PX,
			PREFIX_MIN_PX,
			PREFIX_MAX_PX,
		);
	});

	/** One rendered row, pre-formatted so the template stays declarative. */
	type Row = {
		selected: boolean;
		key: string;
		time: string;
		timestamp: string;
		streamName: string | undefined;
		message: string;
		tokens: JsonToken[] | null;
		/**
		 * Payload found inside the raw line, used when pretty-printing is off and
		 * the row is expanded. `null` when the line carries no JSON.
		 */
		expandable: string | null;
		/** Log group the line came from, when the payload carries one. */
		group: string | null;
		/** Detected level, or `null` when the line carried no signal. */
		level: LogLevel | null;
		levelClass: string;
	};

	/** Level the viewer owns when the parent does not control it. */
	let ownLevelFilter = $state<LogLevel | null>(null);
	/** Active level filter: the parent's when given, otherwise the viewer's. */
	let levelFilter = $derived(level === undefined ? ownLevelFilter : level);

	/** Sets the level filter, through the parent when it is controlled. */
	function setLevelFilter(next: LogLevel | null): void {
		if (level === undefined) ownLevelFilter = next;
		else onLevelChange?.(next);
	}

	/** The four levels offered as filter chips, in severity order. */
	const LEVEL_CHIPS: { level: LogLevel; label: string; activeClass: string }[] = [
		{ level: 'error', label: 'Error', activeClass: 'border-red-800 bg-red-950/50 text-red-300' },
		{
			level: 'warn',
			label: 'Warn',
			activeClass: 'border-amber-800 bg-amber-950/40 text-amber-300',
		},
		{
			level: 'info',
			label: 'Info',
			activeClass: 'border-neutral-700 bg-neutral-800 text-neutral-100',
		},
		{
			level: 'debug',
			label: 'Debug',
			activeClass: 'border-neutral-700 bg-neutral-800 text-neutral-400',
		},
	];
	/** Shared chip styling. */
	const levelChip =
		'rounded-md border px-2 py-1 text-xs font-medium transition-colors hover:border-neutral-700';

	let selectedEvents = $derived(selectedChartEvents(lines, selection));

	/** Lines matching the text filter and the level filter. */
	let visible = $derived(filterByLevel(filterEvents(lines, filter), levelFilter));
	let visibleSelectedCount = $derived(visible.filter((event) => selectedEvents.has(event)).length);

	/** How many lines of each level are loaded, including `unknown`. */
	let levelCounts = $derived.by(() => {
		const counts = { error: 0, warn: 0, info: 0, debug: 0, unknown: 0 } as Record<string, number>;
		for (const event of lines) {
			const rowLevel = effectiveLevel(event);
			counts[rowLevel ?? 'unknown'] = (counts[rowLevel ?? 'unknown'] ?? 0) + 1;
		}
		return counts;
	});
	/** Presentation rows for the visible lines, one per line in buffer order. */
	let lineRows: Row[] = $derived(
		visible.map((event, index) => {
			// The server's detection is authoritative when it is present: it is the
			// same value the archive stored. Events without it (older payloads, tests)
			// fall back to the local guess.
			const rowLevel = event.level !== undefined ? event.level : detectLevel(event.message);
			const formatted = formatLogMessage(event.message, { prettyJson: jsonView });
			const levelClass = levelColorClass(rowLevel);
			// With pretty-printing off, a line that carries JSON can still be
			// opened on demand; the payload is found in the raw text.
			let expandable: string | null = null;
			if (!jsonView) {
				const embedded = findJsonInMessage(event.message);
				if (embedded !== null) expandable = JSON.stringify(embedded, null, 2);
			}
			return {
				selected: selectedEvents.has(event),
				key: eventKey(event, index),
				time: formatTime(event.timestamp),
				timestamp: formatTimestamp(event.timestamp),
				streamName: event.streamName,
				group: event.group ?? null,
				message: formatted.text,
				tokens: jsonView && formatted.isJson ? tokenizeJson(formatted.text) : null,
				expandable,
				level: rowLevel,
				levelClass,
			};
		}),
	);

	/**
	 * One row of the list: a line, or a request that holds its lines.
	 *
	 * A request row carries everything the header shows, so the template stays
	 * declarative and the list never re-formats a line it already formatted.
	 */
	type DisplayRow =
		| ({ kind: 'line' } & Row)
		| {
				kind: 'request';
				key: string;
				/** Request id every line in the group carries. */
				id: string;
				/** Clock time of the first line, and its full timestamp for the tooltip. */
				time: string;
				timestamp: string;
				/** Number of lines in the group. */
				count: number;
				/** First to last line, as `1.2s`. */
				span: string;
				/** Most critical level in the group. */
				level: SeriesLevel;
				levelLabel: string;
				levelClass: string;
				/** Log group and stream, when every line in the request shares them. */
				group: string | null;
				streamName: string | null;
				/** Worst line, trimmed to one short line for the collapsed row. */
				preview: string;
				children: Row[];
		  };

	/** Longest preview kept for a collapsed request, in characters. */
	const PREVIEW_LENGTH = 160;

	/** Prefixes a formatted line row with its kind. */
	function asLine(row: Row): DisplayRow {
		return { kind: 'line', ...row };
	}

	/** Builds the request header row from the lines it holds. */
	function requestDisplayRow(row: Extract<RequestRow, { kind: 'request' }>): DisplayRow {
		const children = row.request.events
			.map((entry) => lineRows[entry.index])
			.filter((child): child is Row => child !== undefined);
		const worstLevel = row.request.level;
		const first = children[0];
		return {
			kind: 'request',
			key: row.key,
			id: row.request.id,
			time: first?.time ?? '',
			timestamp: first?.timestamp ?? '',
			count: children.length,
			span: formatSpan(row.request.last - row.request.first),
			level: worstLevel,
			levelLabel: LEVEL_LABELS[worstLevel],
			levelClass: levelColorClass(worstLevel === 'unknown' ? null : worstLevel),
			group: sharedField(children.map((child) => child.group)),
			streamName: sharedField(children.map((child) => child.streamName)),
			preview: requestPreview(row.request),
			children,
		};
	}

	/** The value every entry shares, or `null` when they differ. */
	function sharedField(values: readonly (string | null | undefined)[]): string | null {
		const first = values[0];
		if (first === null || first === undefined) return null;
		return values.every((value) => value === first) ? first : null;
	}

	/**
	 * One short line for a collapsed request: its most critical line, because that
	 * is the line that explains why the request is coloured the way it is.
	 */
	function requestPreview(request: Extract<RequestRow, { kind: 'request' }>['request']): string {
		const worst =
			request.events.find(
				(entry) => effectiveLevel(visible[entry.index] ?? { message: '' }) === request.level,
			) ?? request.events[0];
		const message = visible[worst?.index ?? -1]?.message ?? '';
		const [firstLine = ''] = message.split('\n');
		return firstLine.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH);
	}

	/** Rows the list renders: grouped by request when the preference is on. */
	let displayRows: DisplayRow[] = $derived.by(() => {
		if (!groupRequests) return lineRows.map(asLine);
		const rows: DisplayRow[] = [];
		for (const row of requestRows(visible)) {
			if (row.kind === 'line') {
				rows.push(asLine(lineRows[row.index] as Row));
				continue;
			}
			// A request with a single line reads better as that line: there is
			// nothing to expand and nothing the header could add.
			if (row.request.events.length === 1) {
				const only = lineRows[row.request.events[0]?.index ?? -1];
				if (only !== undefined) rows.push(asLine(only));
				continue;
			}
			rows.push(requestDisplayRow(row));
		}
		return rows;
	});

	/** True when the list is showing request rows. */
	let grouped = $derived(displayRows.some((row) => row.kind === 'request'));
	/** Requests in view, shown next to the line count while grouping. */
	let requestCount = $derived(displayRows.filter((row) => row.kind === 'request').length);

	let scroller: HTMLElement | null = $state(null);

	/** Keeps the newest line in view while auto-scroll is on (vertical only). */
	$effect(() => {
		// Reading the row count keeps this effect in sync with every appended batch.
		const total = displayRows.length;
		if (selection !== null || !autoScroll || scroller === null || total === 0) return;
		scroller.scrollTop = scroller.scrollHeight;
	});

	let firstSelectedKey = $derived(
		displayRows.find((row) =>
			row.kind === 'line' ? row.selected : row.children.some((child) => child.selected),
		)?.key,
	);

	let scrolledSelection: ChartSelection | null = null;
	let scrolledKey: string | undefined;

	// Scroll once per selection (or when its first matching row arrives), after
	// expanding request rows. Unrelated incoming lines must not steal the position.
	$effect(() => {
		const current = selection;
		const first = firstSelectedKey;
		if (current === null || first === undefined) {
			scrolledSelection = null;
			return;
		}
		if (current === scrolledSelection && first === scrolledKey) return;
		untrack(() => {
			const next = { ...expandedRows };
			for (const row of displayRows) {
				if (row.kind === 'request' && row.children.some((child) => child.selected))
					next[row.key] = true;
			}
			expandedRows = next;
		});
		let cancelled = false;
		void tick().then(() => {
			if (cancelled || scroller === null) return undefined;
			const target = scroller.querySelector<HTMLElement>('[data-chart-selected="true"]');
			if (target) {
				scrolledSelection = current;
				scrolledKey = first;
				scroller.scrollTop +=
					target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
			}
			return undefined;
		});
		return () => {
			cancelled = true;
		};
	});

	/** Error text with the group and region context. */
	let errorText = $derived(
		error === null ? null : describeStreamError(region, group, error.message),
	);
	/** True when the ready frame says the events come from the local archive. */
	let archived = $derived(ready?.source === 'archive');
	/**
	 * Status the badge shows. The archive has no live tail: it replays a fixed window and ends by
	 * itself, so its connecting/live/reconnecting states would all be misleading.
	 */
	let displayStatus = $derived(
		archived && (status === 'connecting' || status === 'live' || status === 'reconnecting')
			? 'idle'
			: status,
	);
	/** Tooltip of the archive indicator, naming the database file it reads. */
	let archiveTitle = $derived(describeArchive(archivePath));
	/** Body text when there is nothing to render. */
	let emptyText = $derived(
		group === null || group === ''
			? 'Select a log group to start tailing.'
			: filter.trim() !== ''
				? 'No lines match the filter.'
				: archived
					? `No archived events for ${group} in this window.`
					: `Waiting for events from ${group}\u2026`,
	);
	/** Auto-scroll button colour. */
	let autoScrollTone = $derived(autoScroll ? 'text-sky-300' : 'text-neutral-400');
	/** Chip describing the active window. */
	let windowSummary = $derived(describeWindow(ready, Date.now()));
	/** True when a historic scan finished on its own. */
	let windowComplete = $derived(mode === 'historic' && endReason === 'window-complete');
	/** Wrap toggle colour. */
	let wrapTone = $derived(wrapLines ? 'text-sky-300' : 'text-neutral-400');
	/** JSON toggle colour. */
	let jsonTone = $derived(jsonView ? 'text-sky-300' : 'text-neutral-400');
	/** Grouping toggle colour. */
	let groupTone = $derived(groupRequests ? 'text-sky-300' : 'text-neutral-400');
	/** Rows fill the window when wrapping, and grow to their content otherwise. */
	let listClass = $derived(wrapLines ? 'w-full' : 'w-max min-w-full');
	/** Message cell: wrapped text or a single long line that scrolls sideways. */
	let messageClass = $derived(
		wrapLines ? 'min-w-0 flex-1 whitespace-pre-wrap break-words' : 'whitespace-pre',
	);
	/** Left edge of the prefix resize handle, in pixels from the scrolled content edge. */
	let handleLeft = $derived(
		rowPaddingPx + timestampPx + rowGapPx + (groups.length > 1 ? groupPx + rowGapPx : 0) + prefixPx,
	);
	/** Prefix column width as a CSS length. */
	let prefixStyle = $derived(`width: ${prefixPx}px`);
	/** Keep metadata on one flex line, reserving readable space for the wrapped message. */
	let wrappedMinWidth = $derived(handleLeft + rowGapPx + 240 + rowPaddingPx);

	/** Rows the user has opened, keyed by row key. */
	let expandedRows = $state<Record<string, boolean>>({});

	/** True when a row is open. */
	function isExpanded(key: string): boolean {
		return expandedRows[key] === true;
	}

	/** Opens or closes a row that carries JSON. */
	function toggleRow(key: string): void {
		if (expandedRows[key] === true) {
			const { [key]: _closed, ...rest } = expandedRows;
			expandedRows = rest;
			return;
		}
		expandedRows = { ...expandedRows, [key]: true };
	}

	/** Colour for a JSON token, keeping punctuation and whitespace quiet. */
	function tokenClass(type: JsonToken['type']): string {
		switch (type) {
			case 'key':
				return 'text-sky-300';
			case 'string':
				return 'text-emerald-300';
			case 'number':
				return 'text-amber-300';
			case 'boolean':
				return 'text-fuchsia-300';
			case 'null':
				return 'text-neutral-500';
			case 'punctuation':
				return 'text-neutral-600';
			default:
				return '';
		}
	}

	/** Persists the current prefix width. */
	function savePrefixWidth(): void {
		writePref(STORAGE_KEYS.prefixWidth, String(Math.round(prefixPx)));
	}

	/** Toggles wrapping and stores the preference. */
	function toggleWrap(): void {
		wrapLines = !wrapLines;
		writePref(STORAGE_KEYS.wrap, String(wrapLines));
	}

	/** Toggles JSON pretty-printing and stores the preference. */
	function toggleJson(): void {
		jsonView = !jsonView;
		writePref(STORAGE_KEYS.jsonView, String(jsonView));
	}
</script>

<section
	class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-neutral-950 {open
		? 'flex-1'
		: 'flex-none'}"
>
	<div
		class="flex min-h-9 flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-neutral-800 bg-neutral-900/40 px-3 py-1"
	>
		<button
			type="button"
			onclick={() => onToggle?.()}
			aria-expanded={open}
			title={open ? 'Hide the log lines' : 'Show the log lines'}
			data-testid="log-toggle"
			class="flex items-center gap-1 text-sm font-semibold text-neutral-200 transition-colors hover:text-sky-300"
		>
			{#if open}
				<ChevronDown size="1em" />
			{:else}
				<ChevronRight size="1em" />
			{/if}
			Log lines
		</button>
		<div class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
			<StatusBadge status={displayStatus} />
			{#if archived}
				<span
					data-testid="archive-badge"
					title={archiveTitle}
					class="rounded-full border border-teal-900 bg-teal-950/60 px-2 py-0.5 text-[0.6875rem] font-medium text-teal-300"
				>
					local archive
				</span>
			{/if}
			<span class="text-xs text-neutral-400" data-testid="visible-count">
				{formatCount(visible.length)} shown
			</span>
			{#if grouped}
				<span class="text-xs text-neutral-400" data-testid="request-count">
					{formatCount(requestCount)} requests
				</span>
			{/if}
			<span class="text-xs text-neutral-500" data-testid="received-count">
				{formatCount(receivedCount)} received
			</span>
			{#if pendingCount > 0}
				<span class="text-xs text-amber-300" data-testid="pending-count">
					{formatCount(pendingCount)} buffered
				</span>
			{/if}
			{#if droppedCount > 0}
				<span class="text-xs text-amber-300/80" data-testid="dropped-count">
					{formatCount(droppedCount)} dropped
				</span>
			{/if}
			<span
				class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium {windowSummary.mode ===
				'historic'
					? 'border-amber-900 bg-amber-950/40 text-amber-300'
					: 'border-neutral-800 bg-neutral-900 text-neutral-400'}"
				title={windowSummary.title}
				data-testid="window-chip"
			>
				{#if windowSummary.mode === 'live'}
					<span>live</span>
				{:else}
					{#if windowSummary.preset !== null}
						<span>{windowSummary.preset} ·</span>
					{/if}
					<span>{windowSummary.from}</span>
					<ArrowRight size="1em" />
					<span>{windowSummary.to}</span>
				{/if}
			</span>
			{#if windowSummary.clamped}
				<span class="text-[0.6875rem] text-amber-400/80" data-testid="window-clamped">
					14-day limit
				</span>
			{/if}
			{#if windowComplete}
				<span class="text-[0.6875rem] text-emerald-400/80" data-testid="window-complete">
					window complete
				</span>
			{/if}
		</div>
	</div>

	{#if open}
		<div
			class="flex flex-none flex-wrap items-center gap-2 border-b border-neutral-800 bg-neutral-900/40 px-3 py-1.5"
		>
			<div class="flex items-center gap-1" role="group" aria-label="Filter by level">
				<button
					type="button"
					onclick={() => setLevelFilter(null)}
					aria-pressed={levelFilter === null}
					title="Show every level, including lines with no level"
					data-testid="level-all"
					class="{levelChip} {levelFilter === null
						? 'border-sky-700 bg-sky-950/60 text-sky-200'
						: 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-700'}"
				>
					All
				</button>
				{#each LEVEL_CHIPS as chip (chip.level)}
					<button
						type="button"
						onclick={() => setLevelFilter(levelFilter === chip.level ? null : chip.level)}
						aria-pressed={levelFilter === chip.level}
						title="Show only {chip.label} lines ({levelCounts[chip.level] ?? 0} loaded)"
						data-testid="level-{chip.level}"
						class="{levelChip} {levelFilter === chip.level
							? chip.activeClass
							: 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-700'}"
					>
						{chip.label}
						{#if (levelCounts[chip.level] ?? 0) > 0}
							<span class="ml-1 opacity-70">{formatCount(levelCounts[chip.level] ?? 0)}</span>
						{/if}
					</button>
				{/each}
			</div>
			<input
				type="search"
				aria-label="Filter log lines"
				placeholder="Filter lines"
				value={filter}
				oninput={(event) => onFilterChange?.(event.currentTarget.value)}
				class="w-40 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 hover:border-neutral-700 focus:border-sky-600"
			/>
			<button
				type="button"
				onclick={toggleWrap}
				aria-pressed={wrapLines}
				title="Wrap long lines instead of scrolling sideways"
				data-testid="wrap-toggle"
				class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium transition-colors hover:border-neutral-700 {wrapTone}"
			>
				Wrap
			</button>
			<button
				type="button"
				onclick={toggleJson}
				aria-pressed={jsonView}
				title="Pretty-print JSON log entries (off: click a line to open its JSON)"
				data-testid="json-toggle"
				class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium transition-colors hover:border-neutral-700 {jsonTone}"
			>
				JSON
			</button>
			<button
				type="button"
				onclick={() => onGroupToggle?.()}
				aria-pressed={groupRequests}
				title="Group the lines of one request into a single row, coloured by its most critical line (off: one row per line)"
				data-testid="group-toggle"
				class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium transition-colors hover:border-neutral-700 {groupTone}"
			>
				By request
			</button>
			<button
				type="button"
				onclick={() => onPauseToggle?.()}
				aria-pressed={paused}
				class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-100"
			>
				{paused ? 'Resume' : 'Pause'}
			</button>
			<button
				type="button"
				onclick={() => onClear?.()}
				class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-100"
			>
				Clear
			</button>
			<button
				type="button"
				onclick={() => onAutoScrollToggle?.()}
				aria-pressed={autoScroll}
				class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs font-medium transition-colors hover:border-neutral-700 {autoScrollTone}"
			>
				Auto-scroll
			</button>
		</div>
		{#if errorText !== null}
			<p
				role="alert"
				data-testid="stream-error"
				class="border-b border-red-900 bg-red-950/50 px-3 py-2 text-xs leading-5 text-red-300"
			>
				{errorText}
			</p>
		{/if}

		{#if selection !== null}
			<div
				class="flex items-center gap-2 px-3 py-1 text-xs text-sky-300"
				role="status"
				data-testid="chart-selection-status"
			>
				{#if selectedEvents.size === 0}
					Selected logs are not in the loaded buffer. Zoom into this time range to load them.
				{:else}
					{visibleSelectedCount} of {selectedEvents.size} selected log lines visible{visibleSelectedCount <
					selectedEvents.size
						? ' — clear the text or level filter to see all'
						: ''}.
				{/if}
				<button type="button" class="ml-auto underline" onclick={onSelectionClear}
					>Clear selection</button
				>
			</div>
		{/if}
		<div
			bind:this={scroller}
			class="min-h-0 min-w-0 flex-1 overflow-auto bg-neutral-950"
			data-testid="log-scroller"
		>
			{#if group === null || group === ''}
				<p class="px-3 py-6 text-sm text-neutral-500" data-testid="viewer-idle">
					Select a log group to start tailing.
				</p>
			{:else if displayRows.length === 0}
				<p class="px-3 py-6 text-sm text-neutral-500" data-testid="viewer-empty">
					{emptyText}
				</p>
			{:else}
				<!-- The handle lives inside the scrolled content so it stays on the column edge. -->
				<div
					class="relative min-h-full {listClass}"
					style:min-width={wrapLines ? `${wrappedMinWidth}px` : undefined}
					data-testid="log-canvas"
				>
					<ol class="font-mono text-xs leading-5" data-testid="log-lines">
						<!-- One line of the list. A line that belongs to a request is indented and
					     marked, so an opened request reads as a nested block. -->
						{#snippet logLine(row: Row, child: boolean)}
							{@const expandable = row.expandable !== null}
							{@const open = expandable && isExpanded(row.key)}
							<!-- Clicking a line that carries JSON opens it; a line without JSON is
						     not a control, so it gets no role or handler. -->
							<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
							<li
								class="flex flex-wrap items-baseline gap-2 px-3 py-0.5 hover:bg-neutral-900/60 {listClass} {expandable
									? 'cursor-pointer'
									: ''}"
								data-testid="log-line"
								data-chart-selected={row.selected ? 'true' : undefined}
								class:bg-sky-950={row.selected}
								class:ring-1={row.selected}
								class:ring-inset={row.selected}
								class:ring-sky-700={row.selected}
								data-request-child={child ? 'true' : undefined}
								data-level={row.level ?? 'unknown'}
								data-expandable={expandable ? 'true' : undefined}
								data-expanded={open ? 'true' : undefined}
								role={expandable ? 'button' : undefined}
								tabindex={expandable ? 0 : undefined}
								aria-expanded={expandable ? open : undefined}
								title={expandable
									? open
										? 'Hide the JSON in this line'
										: 'Show this line as JSON'
									: undefined}
								onclick={expandable ? () => toggleRow(row.key) : undefined}
								onkeydown={expandable
									? (event) => {
											if (event.key !== 'Enter' && event.key !== ' ') return;
											event.preventDefault();
											toggleRow(row.key);
										}
									: undefined}
							>
								<span
									class="shrink-0 truncate text-neutral-500"
									style="width: {timestampPx}px"
									title={row.timestamp}
								>
									{row.time}
								</span>
								{#if groups.length > 1}
									<!-- Only worth a column when the view holds more than one group. -->
									<span
										class="shrink-0 truncate text-teal-400/80"
										style="width: {groupPx}px"
										title={row.group ?? ''}
										data-testid="log-group"
									>
										{row.group ?? ''}
									</span>
								{/if}
								<span
									class="shrink-0 truncate text-sky-400/80"
									style={prefixStyle}
									title={row.streamName ?? ''}
									data-testid="log-stream"
								>
									{row.streamName ?? ''}
								</span>
								{#if expandable}
									{#if open}
										<ChevronDown class="shrink-0 text-neutral-600" size="1em" />
									{:else}
										<ChevronRight class="shrink-0 text-neutral-600" size="1em" />
									{/if}
								{/if}
								<span class="{messageClass} {row.levelClass}" data-testid="log-message">
									{#if row.tokens !== null}
										{#each row.tokens as token, tokenIndex (`${row.key}-${tokenIndex}`)}<span
												class={tokenClass(token.type)}>{token.text}</span
											>{/each}
									{:else}
										{row.message}
									{/if}
								</span>
								{#if open && row.expandable !== null}
									<span
										class="w-full whitespace-pre text-xs text-neutral-300"
										data-testid="log-json-expanded"
									>
										{#each tokenizeJson(row.expandable) as token, tokenIndex (`${row.key}-json-${tokenIndex}`)}<span
												class={tokenClass(token.type)}>{token.text}</span
											>{/each}
									</span>
								{/if}
							</li>
						{/snippet}

						{#each displayRows as row (row.key)}
							{#if row.kind === 'request'}
								{@const open = isExpanded(row.key)}
								<li
									class={listClass}
									data-testid="log-request-group"
									data-chart-selected={row.children.some((child) => child.selected)
										? 'true'
										: undefined}
									class:bg-sky-950={row.children.some((child) => child.selected)}
									data-request-id={row.id}
									data-level={row.level}
									data-expanded={open ? 'true' : undefined}
									data-lines={row.count}
								>
									<button
										type="button"
										class="flex w-full flex-wrap items-baseline gap-2 px-3 py-0.5 text-left hover:bg-neutral-900/60"
										aria-expanded={open}
										title={open
											? 'Hide the lines of this request'
											: 'Show every line of this request'}
										data-testid="request-group-summary"
										onclick={() => toggleRow(row.key)}
									>
										<span
											class="shrink-0 truncate text-neutral-500"
											style="width: {timestampPx}px"
											title={row.timestamp}
										>
											{row.time}
										</span>
										{#if groups.length > 1}
											<span
												class="shrink-0 truncate text-teal-400/80"
												style="width: {groupPx}px"
												title={row.group ?? ''}
												data-testid="log-group"
											>
												{row.group ?? ''}
											</span>
										{/if}
										<span
											class="shrink-0 truncate text-sky-400/80"
											style={prefixStyle}
											title={row.streamName ?? ''}
											data-testid="log-stream"
										>
											{row.streamName ?? ''}
										</span>
										{#if open}
											<ChevronDown class="shrink-0 text-neutral-600" size="1em" />
										{:else}
											<ChevronRight class="shrink-0 text-neutral-600" size="1em" />
										{/if}
										<span
											class="shrink-0 rounded border border-neutral-700 bg-neutral-900 px-1.5 font-mono text-[0.6875rem] text-sky-200"
											data-testid="request-group-id"
											title="Request id shared by these lines"
										>
											{row.id}
										</span>
										<span class="shrink-0 text-neutral-400" data-testid="request-group-count">
											{formatCount(row.count)} lines
										</span>
										<span class="shrink-0 text-neutral-500" data-testid="request-group-span">
											{row.span}
										</span>
										<span
											class="shrink-0 font-medium {row.levelClass}"
											data-testid="request-group-level"
										>
											{row.levelLabel}
										</span>
										{#if !open}
											<span
												class="min-w-0 truncate text-neutral-500"
												data-testid="request-group-preview"
											>
												{row.preview}
											</span>
										{/if}
									</button>
									{#if open}
										<ul class="contents">
											{#each row.children as child (child.key)}
												{@render logLine(child, true)}
											{/each}
										</ul>
									{/if}
								</li>
							{:else}
								{@render logLine(row, false)}
							{/if}
						{/each}
					</ol>

					<ColumnResizer
						label="Resize timestamp column"
						width={timestampPx}
						min={64}
						max={320}
						testId="timestamp-resizer"
						onChange={(next) => (timestampPx = next)}
						onCommit={(next) => writePref(STORAGE_KEYS.timestampWidth, String(next))}
						class="absolute inset-y-0 w-2 border-r border-neutral-800/40"
						style="left: {rowPaddingPx + timestampPx - 4}px"
					/>
					{#if groups.length > 1}
						<ColumnResizer
							label="Resize log group column"
							width={groupPx}
							min={64}
							max={640}
							testId="group-resizer"
							onChange={(next) => (groupPx = next)}
							onCommit={(next) => writePref(STORAGE_KEYS.groupWidth, String(next))}
							class="absolute inset-y-0 w-2 border-r border-neutral-800/40"
							style="left: {rowPaddingPx + timestampPx + rowGapPx + groupPx - 4}px"
						/>
					{/if}
					<ColumnResizer
						label="Resize stream column"
						width={prefixPx}
						min={PREFIX_MIN_PX}
						max={PREFIX_MAX_PX}
						testId="prefix-resizer"
						onChange={(next) => (prefixPx = next)}
						onCommit={() => savePrefixWidth()}
						class="absolute inset-y-0 w-2 border-r border-neutral-800/40"
						style="left: {handleLeft - 4}px"
					/>
				</div>
			{/if}
		</div>
	{/if}
</section>
