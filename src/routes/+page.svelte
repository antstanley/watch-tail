<script lang="ts">
	import { onMount } from 'svelte';
	import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from '@lucide/svelte';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import EndpointBadge from '$lib/components/EndpointBadge.svelte';
	import type { ChartSelection } from '$lib/chart-selection';
	import EventScatterPanel from '$lib/components/EventScatterPanel.svelte';
	import ColumnResizer from '$lib/components/ColumnResizer.svelte';
	import RangeControls from '$lib/components/RangeControls.svelte';
	import LogGroupList from '$lib/components/LogGroupList.svelte';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import RegionSelect from '$lib/components/RegionSelect.svelte';
	import SourceControls from '$lib/components/SourceControls.svelte';
	import {
		DEFAULT_REGIONS,
		describeArchive,
		describeGroupsError,
		fetchArchiveStatus,
		fetchHealth,
		fetchLogGroups,
		fetchRegions,
		fetchSeries,
	} from '$lib/groups-client';
	import type { LogLevel } from '$lib/log-buffer';
	import { bucketEvents, requestDurations, isMeaningfulBrush } from '$lib/series-buckets';
	import { LogStream } from '$lib/log-stream.svelte';
	import type { StreamTarget } from '$lib/log-stream.svelte';
	import type { LogMode } from '$lib/time-range';
	import { SIDEBAR_WIDTH, STORAGE_KEYS, clampWidth, parseStoredWidth, remToPx } from '$lib/resize';
	import type {
		ArchiveStatusResponse,
		HealthResponse,
		LogEventDto,
		LogGroupSummary,
		SeriesPoint,
		SeriesMetric,
		StreamSource,
	} from '$lib/types';

	/** Owns the SSE connection; the page only wires it to the UI. */
	const stream = new LogStream();

	/** Region picker state. Seeded from the URL so a shared link restores the view. */
	let region = $state(page.url.searchParams.get('region') ?? '');
	/**
	 * Where the view reads from, seeded from the URL. `archive` is only offered while the local
	 * DuckDB archive reports `available: true`, so the fallback below is applied during bootstrap.
	 */
	let source = $state<StreamSource>(
		page.url.searchParams.get('source') === 'archive' ? 'archive' : 'cloudwatch',
	);
	/** Tail mode and historic window, seeded from the URL; bootstrap forces historic for the archive. */
	let mode = $state<LogMode>(
		page.url.searchParams.get('mode') === 'historic' ? 'historic' : 'live',
	);
	let range = $state(page.url.searchParams.get('range') ?? '15m');
	let windowFrom = $state<number | null>(parseUrlEpoch(page.url.searchParams.get('from')));
	let windowTo = $state<number | null>(parseUrlEpoch(page.url.searchParams.get('to')));
	let rangeLoading = $state(false);
	let regions = $state<string[]>([...DEFAULT_REGIONS]);
	let groups = $state<LogGroupSummary[]>([]);
	let groupsLoading = $state(false);
	let groupsError = $state<string | null>(null);
	let health = $state<HealthResponse | null>(null);
	let endpoint = $state<string | null>(null);
	/** Last `/api/archive` answer, or `null` when it could not be read. */
	let archiveStatus = $state<ArchiveStatusResponse | null>(null);
	let bootError = $state<string | null>(null);
	let filter = $state('');
	let autoScroll = $state(true);

	/**
	 * Log groups in the view, seeded from the URL. One entry is the normal case;
	 * more than one tails them together and adds a group column.
	 */
	let selectedGroups = $state<string[]>(parseUrlGroups(page.url.searchParams));
	/** Primary group: the one the viewer names the view after. */
	let selectedGroup = $derived(selectedGroups[0] ?? null);
	/** Level filter shared by the log view and the chart. */
	let levelFilter = $state<LogLevel | null>(null);
	/**
	 * Group lines by request id, in the log view and in the chart.
	 *
	 * On by default: an incident is read as requests, not as the lines they wrote.
	 * A stored preference wins, so a reader who wants every line keeps every line.
	 */
	let groupRequests = $state(true);
	/** True while the group-list sidebar is open; collapsing gives the logs the full width. */
	let sidebarOpen = $state(true);
	/** True while the log lines are shown; collapsing keeps only the viewer's header. */
	let logOpen = $state(true);
	/** Bucketed counts behind the chart. */
	let chartSelection = $state<ChartSelection | null>(null);
	let seriesBucketMs = $state(60_000);
	let seriesPoints = $state<SeriesPoint[]>([]);
	/** True while the archive counts are being fetched. */
	let seriesLoading = $state(false);
	let chartMetric = $state<SeriesMetric>('duration');
	let seriesRequest = 0;
	/** The chart's own reset handle, for clearing a brush. */
	let scatter = $state<{ reset: () => void } | null>(null);
	/** True only when the local archive reports that it can be read. */
	let archiveAvailable = $derived(archiveStatus?.available === true);
	/** Database file behind the archive, or `null` when it is unknown. */
	let archivePath = $derived(archiveStatus?.path ?? null);
	/** Tooltip of the archive badge in the header. */
	let archiveTitle = $derived(describeArchive(archivePath));

	/** Viewport width, tracked so the sidebar clamp can use a percentage ceiling. */
	let viewportWidth = $state(0);
	/** Sidebar width in pixels; the layout default is 22rem. */
	let sidebarPx = $state(remToPx(SIDEBAR_WIDTH.defaultRem));

	/** Largest sidebar width allowed: 44vw, but never below the minimum. */
	let sidebarMaxPx = $derived(
		viewportWidth === 0
			? remToPx(SIDEBAR_WIDTH.defaultRem)
			: Math.max(remToPx(SIDEBAR_WIDTH.minRem), (viewportWidth * SIDEBAR_WIDTH.maxVw) / 100),
	);
	let sidebarMinPx = remToPx(SIDEBAR_WIDTH.minRem);
	let sidebarStyle = $derived(`--sidebar-width: min(${sidebarPx}px, ${SIDEBAR_WIDTH.maxVw}vw)`);

	/** Reads a raw preference, tolerating disabled or throwing storage. */
	function readPref(key: string): string | null {
		try {
			if (typeof localStorage === 'undefined') return null;
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	/** Persists the sidebar width; failures are ignored (private mode, quota). */
	function saveSidebarWidth(): void {
		try {
			if (typeof localStorage === 'undefined') return;
			localStorage.setItem(STORAGE_KEYS.sidebarWidth, String(Math.round(sidebarPx)));
		} catch {
			// Preferences are best-effort only.
		}
	}

	onMount(() => {
		groupRequests = readPref(STORAGE_KEYS.groupRequests) !== 'false';
		sidebarOpen = readPref(STORAGE_KEYS.sidebarOpen) !== 'false';
		logOpen = readPref(STORAGE_KEYS.logOpen) !== 'false';
		void bootstrap();
		const clampToViewport = (): void => {
			viewportWidth = window.innerWidth;
		};
		clampToViewport();
		sidebarPx = clampWidth(
			parseStoredWidth(
				readPref(STORAGE_KEYS.sidebarWidth),
				remToPx(SIDEBAR_WIDTH.defaultRem),
				remToPx(SIDEBAR_WIDTH.minRem),
				(window.innerWidth * SIDEBAR_WIDTH.maxVw) / 100,
			),
			remToPx(SIDEBAR_WIDTH.minRem),
			Math.max(remToPx(SIDEBAR_WIDTH.minRem), (window.innerWidth * SIDEBAR_WIDTH.maxVw) / 100),
		);
		window.addEventListener('resize', clampToViewport);
		return () => {
			stream.stop();
			window.removeEventListener('resize', clampToViewport);
		};
	});

	/** Loads metadata, the archive status and the groups, then auto-selects the URL groups. */
	async function bootstrap(): Promise<void> {
		// A shared link may name one group or several; both start the view straight away.
		const requestedGroups = parseUrlGroups(page.url.searchParams);
		await loadMeta();
		await loadArchiveStatus();
		// A link may ask for the archive on a machine that cannot read it: fall back to CloudWatch,
		// which also drops the parameter again in `syncUrl`.
		if (source === 'archive' && !archiveAvailable) {
			source = 'cloudwatch';
			endpoint = health?.endpoint ?? null;
		}
		// The archive only replays fixed windows, so live is never the mode for it.
		if (source === 'archive') mode = 'historic';
		await loadGroups(region);
		if (requestedGroups.length > 0) {
			rangeLoading = mode === 'historic';
			selectedGroups = requestedGroups;
			restartStream();
			syncUrl(region, selectedGroups);
		} else {
			syncUrl(region, selectedGroups);
		}
	}

	/**
	 * Reads `GET /api/archive`. The route answers 200 even for an unusable archive, so a failure
	 * here only means the API is unreachable; the archive view stays hidden in that case.
	 */
	async function loadArchiveStatus(): Promise<void> {
		const target = region;
		try {
			const status = await fetchArchiveStatus({ region: target });
			if (region === target) archiveStatus = status;
		} catch {
			if (region === target) archiveStatus = null;
		}
	}

	/** Loads the region list and health, falling back to the built-in region list. */
	async function loadMeta(): Promise<void> {
		try {
			const [regionsResponse, healthResponse] = await Promise.all([fetchRegions(), fetchHealth()]);
			if (regionsResponse.regions.length > 0) regions = regionsResponse.regions;
			if (region === '') {
				region = regionsResponse.defaultRegion || regions[0] || DEFAULT_REGIONS[0];
			}
			health = healthResponse;
			endpoint = healthResponse.endpoint;
		} catch (error) {
			bootError = `Could not reach the watch-tail API. ${failureText(error)}`;
			if (region === '') region = DEFAULT_REGIONS[0];
		}
	}

	/**
	 * Loads the log groups of a region from the active source; a newer region or source change wins
	 * the race. The CloudWatch URL is left exactly as it was, so only the archive names its source.
	 */
	async function loadGroups(target: string): Promise<void> {
		groupsLoading = true;
		groupsError = null;
		const requestedSource = source;
		const query =
			requestedSource === 'archive'
				? { region: target, source: requestedSource }
				: { region: target };
		try {
			const response = await fetchLogGroups(query);
			if (target !== region || requestedSource !== source) return;
			if (response.endpoint !== null) endpoint = response.endpoint;
			groups = response.groups;
		} catch (error) {
			if (target !== region || requestedSource !== source) return;
			groups = [];
			groupsError = describeGroupsError(target, error);
		} finally {
			if (target === region && requestedSource === source) groupsLoading = false;
		}
	}

	/** Parses an epoch-millisecond URL parameter, or `null`. */
	function parseUrlEpoch(value: string | null): number | null {
		if (value === null || value.trim() === '') return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	/** The window the current mode asks for. The archive is always a historic window. */
	function windowParams(): {
		mode: LogMode;
		range?: string;
		from?: number;
		to?: number;
	} {
		if (mode === 'live' && source !== 'archive') return { mode: 'live' };
		if (range === '' && windowFrom !== null && windowTo !== null) {
			return { mode: 'historic', from: windowFrom, to: windowTo };
		}
		return { mode: 'historic', range: range === '' ? '15m' : range };
	}

	/** Stream target for the active source, region, groups and window. */
	function streamTarget(): StreamTarget {
		const window = windowParams();
		const [primary, ...rest] = selectedGroups;
		const target: StreamTarget = {
			region,
			group: primary ?? '',
			groups: [...selectedGroups],
			...window,
		};
		if (source === 'archive') target.source = 'archive';
		return target;
	}

	/** Starts the stream for the current selection, or stops it when nothing is selected. */
	function restartStream(): void {
		chartSelection = null;
		if (region === '' || selectedGroups.length === 0) {
			stream.stop();
			return;
		}
		rangeLoading = mode === 'historic';
		stream.start(streamTarget());
		void loadSeries();
	}

	/** Selects one group, replacing the selection. */
	function selectGroup(name: string): void {
		if (region === '' || name === '') return;
		selectedGroups = [name];
		syncUrl(region, selectedGroups);
		restartStream();
	}

	/**
	 * Adds a group to the selection or removes it.
	 *
	 * The view keeps at least the groups it had: removing the last one leaves the
	 * stream stopped and the list without a selection, which is a valid state.
	 */
	function toggleGroup(name: string): void {
		if (region === '' || name === '') return;
		selectedGroups = selectedGroups.includes(name)
			? selectedGroups.filter((entry) => entry !== name)
			: [...selectedGroups, name];
		syncUrl(region, selectedGroups);
		if (selectedGroups.length === 0) {
			stream.stop();
			seriesPoints = [];
			return;
		}
		restartStream();
	}

	/** Applies a mode or range change: restarts the stream and mirrors it into the URL. */
	function applyRange(payload: {
		mode: LogMode;
		range: string;
		from: number | null;
		to: number | null;
	}): void {
		// The archive holds fixed windows, so a live request is ignored while it is the source.
		if (source === 'archive' && payload.mode === 'live') return;
		mode = payload.mode;
		range = payload.range;
		windowFrom = payload.from;
		windowTo = payload.to;
		syncUrl(region, selectedGroups);
		if (selectedGroups.length === 0) return;
		rangeLoading = payload.mode === 'historic';
		stream.start(streamTarget());
		void loadSeries();
	}

	/**
	 * Applies a brushed range from the chart as the new historic window, which
	 * re-scopes the log view to exactly what was brushed.
	 */
	function applyBrush(selection: { from: number; to: number } | null): void {
		if (selection === null) return;
		// A click that moved a couple of pixels still produces a range, and a double
		// click selects the whole domain. Neither is a zoom, and acting on one would
		// re-scope the log view to a window with nothing in it.
		const window = chartWindow();
		if (!isMeaningfulBrush(selection, window, chartBucketMs(window.from, window.to))) {
			scatter?.reset();
			return;
		}
		applyRange({ mode: 'historic', range: '', from: selection.from, to: selection.to });
	}

	/** Turns request grouping on or off, and remembers the choice. */
	function toggleGroupRequests(): void {
		groupRequests = !groupRequests;
		try {
			localStorage?.setItem(STORAGE_KEYS.groupRequests, groupRequests ? 'true' : 'false');
		} catch {
			// A preference is best effort: private mode, quota, no storage.
		}
	}

	/** Collapses or expands the group-list sidebar, and remembers the choice. */
	function toggleSidebar(): void {
		sidebarOpen = !sidebarOpen;
		try {
			localStorage?.setItem(STORAGE_KEYS.sidebarOpen, sidebarOpen ? 'true' : 'false');
		} catch {
			// A preference is best effort: private mode, quota, no storage.
		}
	}

	/** Collapses or expands the log lines, and remembers the choice. */
	function toggleLog(): void {
		logOpen = !logOpen;
		try {
			localStorage?.setItem(STORAGE_KEYS.logOpen, logOpen ? 'true' : 'false');
		} catch {
			// A preference is best effort: private mode, quota, no storage.
		}
	}

	/** Clears the chart's brush and the window it applied. */
	function clearBrush(): void {
		scatter?.reset();
		applyRange({ mode: 'historic', range: range === '' ? '15m' : range, from: null, to: null });
	}

	/**
	 * Switches between CloudWatch and the local archive.
	 *
	 * The archive forces historic mode, restarts the stream for the selected group and reloads the
	 * group list from the new source, so the sidebar and the viewer always agree.
	 */
	function changeSource(next: StreamSource): void {
		if (next === source) return;
		if (next === 'archive' && !archiveAvailable) return;
		source = next;
		if (next === 'archive' && mode !== 'historic') {
			mode = 'historic';
			if (range === '') {
				range = '15m';
				windowFrom = null;
				windowTo = null;
			}
		}
		if (selectedGroups.length > 0) {
			rangeLoading = mode === 'historic';
			stream.start(streamTarget());
		}
		groups = [];
		syncUrl(region, selectedGroups);
		void loadGroups(region);
		void loadSeries();
	}

	/** Re-reads the archive status and returns to CloudWatch when it disappeared mid-session. */
	async function handleArchiveGone(): Promise<void> {
		await loadArchiveStatus();
		if (source !== 'archive' || archiveAvailable) return;
		source = 'cloudwatch';
		if (selectedGroups.length > 0) stream.start(streamTarget());
		groups = [];
		syncUrl(region, selectedGroups);
		void loadGroups(region);
		void loadSeries();
	}

	/** Switches region: stops the stream, clears the list and reloads the groups. */
	function changeRegion(next: string): void {
		if (next === '' || next === region) return;
		region = next;
		stream.stop();
		groups = [];
		selectedGroups = [];
		seriesPoints = [];
		syncUrl(next, []);
		void loadArchiveStatus();
		void loadGroups(next);
	}

	/** Reloads the groups of the active region. */
	function refreshGroups(): void {
		void loadGroups(region);
	}

	/** Replaces the view parameters in the address bar. */
	function syncUrl(nextRegion: string, nextGroups: readonly string[]): void {
		const url = new URL(page.url);
		if (nextRegion === '') url.searchParams.delete('region');
		else url.searchParams.set('region', nextRegion);
		// CloudWatch is the server default, so only the archive names its source in the URL.
		if (source === 'archive') url.searchParams.set('source', 'archive');
		else url.searchParams.delete('source');
		// One group keeps the short, familiar parameter; several use the list form.
		url.searchParams.delete('group');
		url.searchParams.delete('groups');
		const names = nextGroups.filter((name) => name.length > 0);
		if (names.length === 1) url.searchParams.set('group', names[0] as string);
		else if (names.length > 1) url.searchParams.set('groups', names.join(','));

		if (mode === 'live') {
			url.searchParams.delete('mode');
			url.searchParams.delete('range');
			url.searchParams.delete('from');
			url.searchParams.delete('to');
		} else {
			url.searchParams.set('mode', 'historic');
			url.searchParams.delete('from');
			url.searchParams.delete('to');
			url.searchParams.delete('range');
			if (range === '' && windowFrom !== null && windowTo !== null) {
				url.searchParams.set('from', String(windowFrom));
				url.searchParams.set('to', String(windowTo));
			} else {
				url.searchParams.set('range', range === '' ? '15m' : range);
			}
		}
		if (url.href !== page.url.href) replaceState(url, {});
	}

	/** Clears the loading hint once the server reports its window. */
	$effect(() => {
		if (stream.ready !== null || stream.status === 'error') rangeLoading = false;
	});

	/**
	 * Keeps the chart in step with the view: a new window, selection, source, level
	 * or a new batch of lines all re-load the counts.
	 */
	$effect(() => {
		// Read the reactive inputs so the effect re-runs when any of them change.
		const key = [
			source,
			region,
			selectedGroups.join(','),
			mode,
			range,
			windowFrom ?? '',
			windowTo ?? '',
			levelFilter ?? '',
			groupRequests ? 'request' : 'event',
			chartMetric,
			stream.receivedCount,
			stream.ready?.startTime ?? '',
			stream.ready?.endTime ?? '',
		].join('|');
		if (key.length === 0) return;
		void loadSeries();
	});

	/**
	 * Reacts to `archive-unavailable` from the stream (the file was locked or removed after boot) by
	 * re-checking the archive, so the toggle hides itself instead of offering a source that fails.
	 */
	$effect(() => {
		if (stream.lastError?.code !== 'archive-unavailable') return;
		void handleArchiveGone();
	});

	/** Parses the group selection from the URL, accepting both parameter shapes. */
	function parseUrlGroups(params: URLSearchParams): string[] {
		const list = params.get('groups') ?? '';
		const names = list
			.split(',')
			.map((name) => name.trim())
			.filter((name) => name.length > 0);
		if (names.length > 0) return [...new Set(names)];
		const single = params.get('group')?.trim() ?? '';
		return single.length > 0 ? [single] : [];
	}

	// A selection belongs to the current source/window and chart grouping.
	$effect(() => {
		void [
			source,
			region,
			selectedGroups.join('\0'),
			mode,
			range,
			windowFrom,
			windowTo,
			groupRequests,
		];
		chartSelection = null;
	});

	/** Bucket width for the chart of one window, mirroring the server's choice. */
	function chartBucketMs(from: number, to: number): number {
		const span = Math.max(1, to - from);
		const ladder = [1_000, 5_000, 10_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
		return ladder.find((step) => span / step <= 90) ?? 60 * 60_000;
	}

	/** Window the chart describes: the active historic window, or a rolling quarter hour. */
	function chartWindow(): { from: number; to: number } {
		if (mode === 'historic') {
			const to = windowTo ?? stream.ready?.endTime ?? Date.now();
			const from = windowFrom ?? stream.ready?.startTime ?? to - 15 * 60_000;
			return { from: Math.min(from, to - 1_000), to };
		}
		const to = Date.now();
		return { from: to - 15 * 60_000, to };
	}

	/**
	 * Loads the counts behind the chart.
	 *
	 * The archive can count a whole window in one statement, so it is asked for
	 * them; a CloudWatch view has no aggregate endpoint, so the events already
	 * streamed are bucketed here. Both end up as the same points.
	 */
	async function loadSeries(): Promise<void> {
		const request = ++seriesRequest;
		seriesLoading = false;
		if (selectedGroups.length === 0 || region === '') {
			seriesPoints = [];
			return;
		}
		const { from, to } = chartWindow();
		seriesBucketMs = chartBucketMs(from, to);
		if (source !== 'archive') {
			seriesPoints = (chartMetric === 'duration' ? requestDurations : bucketEvents)(
				stream.lines as LogEventDto[],
				{
					from,
					to,
					bucketMs: chartBucketMs(from, to),
					level: levelFilter,
					fallbackGroup: selectedGroup ?? '',
					byRequest: groupRequests,
				},
			);
			return;
		}
		seriesLoading = true;
		seriesPoints = [];
		try {
			const series = await fetchSeries({
				region,
				groups: selectedGroups,
				from,
				to,
				levels: levelFilter === null ? [] : [levelFilter],
				by: groupRequests ? 'request' : 'event',
				metric: chartMetric,
			});
			if (request === seriesRequest) {
				seriesPoints = series.points;
				seriesBucketMs = series.bucketMs;
			}
		} catch {
			// A newer metric/window response wins over this one.
			if (request === seriesRequest) seriesPoints = [];
		} finally {
			if (request === seriesRequest) seriesLoading = false;
		}
	}

	/** Short description of an unknown failure. */
	function failureText(error: unknown): string {
		return error instanceof Error && error.message !== '' ? error.message : String(error);
	}
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
	<RangeControls
		{mode}
		{range}
		from={windowFrom}
		to={windowTo}
		loading={rangeLoading}
		disabled={selectedGroup === null}
		liveDisabled={source === 'archive'}
		onApply={applyRange}
	/>

	<!-- Right-aligned: what is being watched, and where it comes from. -->
	<div class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
		<span class="text-[0.6875rem] font-semibold uppercase tracking-wider text-neutral-500">
			Watching
		</span>
		<span
			class="max-w-[22rem] truncate rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-200"
		>
			{selectedGroup ?? 'no group selected'}
		</span>
		<span class="text-xs text-neutral-500">in</span>
		<span class="font-mono text-xs text-neutral-300"
			>{region === '' ? 'resolving region…' : region}</span
		>
		{#if source === 'archive'}
			<!-- The archive is a local file: no endpoint and no credentials are involved. -->
			<EndpointBadge endpoint={null} credentials={null} />
			<span
				data-testid="archive-source-badge"
				title={archiveTitle}
				class="rounded-full border border-teal-900 bg-teal-950/60 px-2.5 py-1 text-xs font-medium text-teal-300"
			>
				local archive
			</span>
		{:else}
			<EndpointBadge {endpoint} credentials={health?.credentials ?? null} />
		{/if}
		{#if health !== null && health.ok}
			<span class="text-xs text-emerald-400/80">API ok</span>
		{/if}
	</div>
</div>

{#if bootError !== null}
	<p
		role="alert"
		data-testid="boot-error"
		class="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs leading-5 text-red-300"
	>
		{bootError}
	</p>
{/if}

<div class="flex min-h-0 min-w-0 flex-1 flex-col border border-neutral-800 lg:flex-row">
	<div
		id="log-group-sidebar"
		class="relative flex min-h-0 w-full flex-col border-b border-neutral-800 bg-neutral-950/60 lg:shrink-0 lg:border-b-0 lg:border-r {!sidebarOpen
			? 'lg:hidden'
			: ''}"
		style={sidebarStyle}
		data-testid="sidebar"
	>
		<div
			class="flex min-h-9 flex-none items-center gap-x-3 border-b border-neutral-800 bg-neutral-900/40 px-3 py-1.5"
		>
			<button
				type="button"
				onclick={toggleSidebar}
				aria-expanded={sidebarOpen}
				aria-controls="log-group-sidebar"
				title={sidebarOpen ? 'Hide the group list' : 'Show the group list'}
				data-testid="sidebar-collapse"
				class="flex items-center gap-1 text-sm font-semibold text-neutral-200 transition-colors hover:text-sky-300"
			>
				<!-- Wide screens collapse to the left rail; narrow screens fold the stacked body away. -->
				<span class="hidden lg:inline-flex"><ChevronLeft size="1em" /></span>
				<span class="lg:hidden">
					{#if sidebarOpen}<ChevronUp size="1em" />{:else}<ChevronDown size="1em" />{/if}
				</span>
				{source === 'archive' ? 'Archived groups' : 'Log groups'}
			</button>
		</div>
		{#if sidebarOpen}
			<div class="flex min-h-0 flex-1 flex-col gap-3 p-3" data-testid="sidebar-body">
				<SourceControls {source} {archiveAvailable} {archivePath} onChange={changeSource} />
				<RegionSelect {regions} value={region} onchange={changeRegion} />
				<LogGroupList
					{groups}
					{source}
					{region}
					selected={selectedGroups}
					loading={groupsLoading}
					error={groupsError}
					onSelect={selectGroup}
					onToggle={toggleGroup}
					onRefresh={refreshGroups}
				/>
			</div>
			<!-- The handle rides the panel's inner edge, so the sidebar and the logs meet at one border. -->
			<ColumnResizer
				label="Resize group list"
				width={sidebarPx}
				min={sidebarMinPx}
				max={sidebarMaxPx}
				testId="sidebar-resizer"
				onChange={(next) => (sidebarPx = next)}
				onCommit={() => saveSidebarWidth()}
				class="absolute inset-y-0 -right-1 z-10 hidden w-2 lg:block"
			/>
		{/if}
	</div>

	{#if !sidebarOpen}
		<!-- Folded away: the narrow rail keeps the way back on the left edge. Narrow screens keep the
		     header above instead, so this rail is wide-only. -->
		<div
			class="hidden w-8 shrink-0 flex-col items-center border-r border-neutral-800 bg-neutral-950/60 py-2 lg:flex"
			data-testid="sidebar-seam"
		>
			<button
				type="button"
				onclick={toggleSidebar}
				aria-expanded={sidebarOpen}
				aria-controls="log-group-sidebar"
				title="Show the group list"
				data-testid="sidebar-expand"
				class="flex size-6 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
			>
				<ChevronRight class="size-4" />
			</button>
		</div>
	{/if}

	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		<EventScatterPanel
			bind:this={scatter}
			points={seriesPoints}
			from={chartWindow().from}
			to={chartWindow().to}
			bucketMs={seriesBucketMs}
			groups={selectedGroups}
			byRequest={groupRequests}
			fill={!logOpen}
			metric={chartMetric}
			onMetricChange={(metric) => {
				chartSelection = null;
				chartMetric = metric;
			}}
			onSelect={(point) => {
				autoScroll = false;
				chartSelection = {
					point,
					bucketMs: seriesBucketMs,
					byRequest: groupRequests,
					fallbackGroup: selectedGroup ?? '',
				};
			}}
			loading={seriesLoading}
			onBrush={applyBrush}
		/>

		{#if windowFrom !== null && windowTo !== null && mode === 'historic'}
			<div
				class="flex flex-wrap items-center gap-2 border-b border-neutral-800 bg-neutral-950/60 px-3 py-1.5 text-[0.6875rem] text-neutral-500"
			>
				<span data-testid="brush-window">
					zoomed to {new Date(windowFrom).toLocaleTimeString()} – {new Date(
						windowTo,
					).toLocaleTimeString()}
				</span>
				<button
					type="button"
					onclick={clearBrush}
					data-testid="brush-clear"
					class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-0.5 font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-neutral-100"
				>
					Reset zoom
				</button>
			</div>
		{/if}

		<LogViewer
			selection={chartSelection}
			onSelectionClear={() => (chartSelection = null)}
			lines={stream.lines}
			status={stream.status}
			error={stream.lastError}
			{mode}
			ready={stream.ready}
			endReason={stream.endReason}
			{archivePath}
			{region}
			group={selectedGroup}
			groups={selectedGroups}
			level={levelFilter}
			onLevelChange={(next) => (levelFilter = next)}
			{groupRequests}
			onGroupToggle={toggleGroupRequests}
			open={logOpen}
			onToggle={toggleLog}
			{filter}
			paused={stream.paused}
			{autoScroll}
			pendingCount={stream.pendingCount}
			droppedCount={stream.droppedCount}
			receivedCount={stream.receivedCount}
			onFilterChange={(value) => (filter = value)}
			onPauseToggle={() => stream.togglePause()}
			onClear={() => {
				chartSelection = null;
				stream.clear();
			}}
			onAutoScrollToggle={() => {
				chartSelection = null;
				autoScroll = !autoScroll;
			}}
		/>
	</div>
</div>

<style>
	/*
	 * The sidebar stacks above the panels below `lg`, where it spans the full width; only the wide
	 * layout gives it the resizable column width held in `--sidebar-width`.
	 */
	@media (min-width: 64rem) {
		#log-group-sidebar {
			width: var(--sidebar-width);
		}
	}
</style>
