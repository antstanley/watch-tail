import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from './+page.svelte';

/**
 * Page-level tests for the CloudWatch/archive switch.
 *
 * `$app/state` and `$app/navigation` are mocked, `fetch` answers the four API routes and a fake
 * `EventSource` records the stream URLs, so the whole page can be driven without a server and
 * without touching a real archive.
 *
 * The file is not `+`-prefixed: SvelteKit reserves those names inside `src/routes`.
 */

const mocks = vi.hoisted(() => ({
	url: new URL('http://localhost:5173/'),
	replaceState: vi.fn<(url: URL, state: unknown) => void>(),
}));

vi.mock('$app/state', () => ({
	page: {
		get url() {
			return mocks.url;
		},
	},
}));

vi.mock('$app/navigation', () => ({
	replaceState: (url: URL, state: unknown) => mocks.replaceState(url, state),
}));

/** Minimal `EventSource` double that records the URLs the page opens. */
class FakeEventSource {
	static urls: string[] = [];

	readonly url: string;
	readyState = 0;

	constructor(url: string) {
		this.url = url;
		FakeEventSource.urls.push(url);
	}

	addEventListener(): void {
		// The page only needs the connection to exist.
	}

	removeEventListener(): void {
		// Nothing to detach in this double.
	}

	close(): void {
		this.readyState = 2;
	}
}

/** Archive availability the stubbed `/api/archive` answers with. */
let archiveAvailable = true;
/** Groups the stubbed CloudWatch list returns; a test may add a second one. */
let cloudwatchGroups: { name: string; storedBytes?: number }[] = [
	{ name: '/aws/app', storedBytes: 2048 },
];
/** Every URL the page fetched, in order. */
let requested: string[] = [];

/** Answers the API routes the page calls during bootstrap. */
function stubApi(input: string): Promise<Response> {
	requested.push(input);
	const url = new URL(input, 'http://localhost');
	const source = url.searchParams.get('source') === 'archive' ? 'archive' : 'cloudwatch';

	if (url.pathname === '/api/regions') {
		return json({
			regions: ['us-east-1', 'eu-west-1'],
			defaultRegion: 'us-east-1',
			endpoint: null,
		});
	}
	if (url.pathname === '/api/health') {
		return json({
			ok: true,
			region: 'us-east-1',
			endpoint: null,
			local: false,
			credentials: 'ambient',
		});
	}
	if (url.pathname === '/api/archive') {
		return json({
			path: '/tmp/watch-tail/archive.duckdb',
			available: archiveAvailable,
			error: archiveAvailable ? null : 'Cannot find module @duckdb/node-api',
			bytes: archiveAvailable ? 4096 : null,
			rows: 3,
			groups: 1,
			regions: 1,
			oldest: archiveAvailable ? 1000 : null,
			newest: archiveAvailable ? 2000 : null,
		});
	}
	if (url.pathname === '/api/series') {
		return json({
			groupBy: url.searchParams.get('by') ?? 'event',
			from: 1_700_000_000_000,
			to: 1_700_000_900_000,
			bucketMs: 60_000,
			levels: [{ level: 'error', events: 2 }],
			groups: [{ group: '/aws/app', events: 2 }],
			points: [
				{ t: 1_700_000_000_000, group: '/aws/app', level: 'error', events: 1 },
				{ t: 1_700_000_060_000, group: '/aws/app', level: 'error', events: 1 },
			].map((point, index) =>
				url.searchParams.get('metric') === 'duration'
					? Object.assign(point, { durationMs: 50 + index, requestId: `request-${index}` })
					: point,
			),
			totals: { events: 2, points: 2 },
		});
	}
	if (url.pathname === '/api/log-groups') {
		const groups =
			source === 'archive' ? [{ name: '/aws/archived', archivedEvents: 12 }] : cloudwatchGroups;
		return json({ region: 'us-east-1', endpoint: null, source, groups });
	}
	return Promise.resolve(new Response('not found', { status: 404 }));
}

/**
 * Text of an element with runs of whitespace collapsed, so an assertion does not
 * depend on where the template happens to wrap.
 */
function text(testId: string): string {
	return (screen.getByTestId(testId).textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** JSON response for the stubbed API. */
function json(body: unknown): Promise<Response> {
	return Promise.resolve(
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		}),
	);
}

/** Points the mocked `page.url` at a query string. */
function setUrl(search = ''): void {
	mocks.url = new URL(`http://localhost:5173/${search}`);
}

/** Renders the page and waits for the group list of the first load. */
async function renderPage(): Promise<void> {
	render(Page);
	await waitFor(() => expect(requested.some((url) => url.includes('/api/log-groups'))).toBe(true));
	await waitFor(() => expect(screen.queryByTestId('group-loading')).toBeNull());
}

/** Last URL written through `replaceState`. */
function lastUrl(): URL {
	const call = mocks.replaceState.mock.calls.at(-1);
	if (call === undefined) throw new Error('replaceState was never called');
	return call[0];
}

beforeEach(() => {
	archiveAvailable = true;
	cloudwatchGroups = [{ name: '/aws/app', storedBytes: 2048 }];
	requested = [];
	FakeEventSource.urls = [];
	mocks.replaceState.mockClear();
	localStorage.clear();
	setUrl();
	vi.stubGlobal('fetch', vi.fn(stubApi));
	vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe('page source switch', () => {
	it('hides the archive toggle while the archive is unavailable', async () => {
		archiveAvailable = false;
		setUrl('?region=us-east-1&group=/aws/app');

		await renderPage();

		expect(screen.queryByTestId('source-archive')).toBeNull();
		expect(screen.queryByTestId('source-cloudwatch')).toBeNull();
		expect(screen.queryByTestId('archive-note')).toBeNull();
		expect(screen.queryByTestId('archive-source-badge')).toBeNull();
		// The CloudWatch list is untouched: one row, no archive badge.
		const rows = screen.getAllByTestId('group-row');
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain('/aws/app');
		expect(screen.queryAllByTestId('group-archived-count')).toHaveLength(0);
		expect(requested.some((url) => url.includes('source=archive'))).toBe(false);
	});

	it('offers the toggle once the archive is available', async () => {
		await renderPage();

		expect(screen.getByTestId('source-cloudwatch').getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('source-archive').getAttribute('aria-pressed')).toBe('false');
		const archive = screen.getByTestId('source-archive');
		expect(archive.getAttribute('title')).toContain('/tmp/watch-tail/archive.duckdb');
	});

	it('switches the list and the stream to the archive and mirrors source=archive in the URL', async () => {
		setUrl('?region=us-east-1&group=/aws/app');
		await renderPage();

		await fireEvent.click(screen.getByTestId('source-archive'));

		await waitFor(() => expect(lastUrl().searchParams.get('source')).toBe('archive'));
		// The archive is historic-only, whatever the view was before.
		expect(lastUrl().searchParams.get('mode')).toBe('historic');
		expect(lastUrl().searchParams.get('group')).toBe('/aws/app');
		expect(screen.getByTestId('mode-historic').getAttribute('aria-pressed')).toBe('true');

		// The stream restarts against the archive for the selected group.
		await waitFor(() => {
			const stream = FakeEventSource.urls.at(-1) ?? '';
			expect(stream).toContain('source=archive');
			expect(stream).toContain('mode=historic');
			expect(stream).toContain('group=%2Faws%2Fapp');
		});

		// The group list comes from the archive now.
		await waitFor(() => expect(screen.getAllByTestId('group-archived-count')).toHaveLength(1));
		expect(screen.getByTestId('group-archived-count').textContent?.trim()).toBe('12 archived');
		expect(requested.some((url) => url.includes('source=archive'))).toBe(true);
		expect(screen.getByTestId('archive-source-badge')).toBeTruthy();
		expect(screen.getByTestId('archive-note')).toBeTruthy();
	});

	it('ignores live while the archive is the source', async () => {
		setUrl('?region=us-east-1&group=/aws/app&source=archive');
		await renderPage();

		expect(screen.getByTestId('source-archive').getAttribute('aria-pressed')).toBe('true');
		const streams = FakeEventSource.urls.length;

		await fireEvent.click(screen.getByTestId('mode-live'));

		expect(screen.getByTestId('mode-historic').getAttribute('aria-pressed')).toBe('true');
		expect(FakeEventSource.urls).toHaveLength(streams);
		expect(lastUrl().searchParams.get('source')).toBe('archive');
	});

	it('switches back to CloudWatch and drops the parameter again', async () => {
		setUrl('?region=us-east-1&group=/aws/app&source=archive');
		await renderPage();

		await fireEvent.click(screen.getByTestId('source-cloudwatch'));

		await waitFor(() => expect(lastUrl().searchParams.get('source')).toBeNull());
		await waitFor(() => {
			const stream = FakeEventSource.urls.at(-1) ?? '';
			expect(stream).toContain('group=%2Faws%2Fapp');
			expect(stream).not.toContain('source=archive');
		});
		// The CloudWatch list is back: plain sizes, no archive badge.
		await waitFor(() => expect(screen.queryByTestId('group-archived-count')).toBeNull());
		await waitFor(() => expect(screen.queryByTestId('archive-source-badge')).toBeNull());
		expect(screen.queryByTestId('group-source-badge')).toBeNull();
		expect(screen.getByText('Log groups')).toBeTruthy();
	});

	it('restores the archive view from the URL but falls back when it is unavailable', async () => {
		archiveAvailable = false;
		setUrl('?region=us-east-1&group=/aws/app&source=archive');

		await renderPage();

		expect(screen.queryByTestId('source-archive')).toBeNull();
		expect(lastUrl().searchParams.get('source')).toBeNull();
		expect(FakeEventSource.urls.some((url) => url.includes('source=archive'))).toBe(false);
		const rows = screen.getAllByTestId('group-row');
		expect(rows).toHaveLength(1);
		expect(rows[0].textContent).toContain('/aws/app');
	});
});

describe('page: several groups at once', () => {
	it('adds a group from its checkbox and streams both', async () => {
		// Two groups in the list, one of them selected from the URL.
		cloudwatchGroups = [
			{ name: '/aws/app', storedBytes: 2048 },
			{ name: '/aws/other', storedBytes: 1024 },
		];
		setUrl('?region=us-east-1&group=/aws/app');
		await renderPage();

		FakeEventSource.urls.length = 0;
		// Adding a *second* group is the multi-select case.
		await fireEvent.click(screen.getByTestId('group-check-/aws/other'));
		await waitFor(() => expect(FakeEventSource.urls.length).toBeGreaterThan(0));

		// The stream asks for both groups...
		const streamUrl = decodeURIComponent(FakeEventSource.urls.at(-1) ?? '');
		expect(streamUrl).toContain('groups=/aws/app,/aws/other');
		// ...and the address bar mirrors the list, so the view is shareable.
		expect(lastUrl().searchParams.get('groups')).toBe('/aws/app,/aws/other');
	});

	it('seeds the selection from a groups parameter in the URL', async () => {
		setUrl('?region=us-east-1&groups=/aws/app,/aws/other');
		await renderPage();
		await waitFor(() => expect(FakeEventSource.urls.length).toBeGreaterThan(0));
		expect(FakeEventSource.urls.at(-1)).toContain('groups=');
		expect(screen.getByTestId('selected-count')).toBeTruthy();
	});

	it('replaces the selection when a row is clicked', async () => {
		setUrl('?region=us-east-1&groups=/aws/app,/aws/other');
		await renderPage();
		FakeEventSource.urls.length = 0;
		await fireEvent.click(screen.getAllByTestId('group-row')[0] as HTMLElement);
		await waitFor(() => expect(FakeEventSource.urls.length).toBeGreaterThan(0));
		// One group goes back to the single-group parameter.
		expect(FakeEventSource.urls.at(-1)).toContain('group=');
		expect(FakeEventSource.urls.at(-1)).not.toContain('groups=');
	});
});

describe('page: the event chart', () => {
	it('toggles duration and count without changing the log grouping preference', async () => {
		setUrl('?region=us-east-1&group=/aws/app&source=archive&mode=historic&range=1h');
		await renderPage();
		expect(screen.getByTestId('chart-metric-duration').getAttribute('aria-pressed')).toBe('true');
		await waitFor(() =>
			expect(requested.some((url) => url.includes('metric=duration'))).toBe(true),
		);
		expect(screen.getByTestId('chart-metric-duration').getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('duration-note').textContent).toContain('last event');
		expect(screen.getByTestId('group-toggle').getAttribute('aria-pressed')).toBe('true');
		requested.length = 0;
		await fireEvent.click(screen.getByTestId('chart-metric-count'));
		await waitFor(() => expect(requested.some((url) => url.includes('metric=count'))).toBe(true));
		expect(screen.queryByTestId('duration-note')).toBeNull();
	});

	it('renders the chart above the log view and counts the archive window', async () => {
		setUrl('?region=us-east-1&group=/aws/app&source=archive&mode=historic&range=1h');
		await renderPage();

		expect(screen.getByTestId('event-scatter')).toBeTruthy();
		await waitFor(() => expect(requested.some((url) => url.includes('/api/series'))).toBe(true));
		const seriesUrl = requested.find((url) => url.includes('/api/series')) ?? '';
		expect(seriesUrl).toContain('groups=%2Faws%2Fapp');
		expect(seriesUrl).toContain('source=archive');
		await waitFor(() => expect(text('scatter-summary')).toContain('2 requests'));
	});

	it('sends the level filter to the series request', async () => {
		setUrl('?region=us-east-1&group=/aws/app&source=archive&mode=historic&range=1h');
		await renderPage();
		requested.length = 0;

		await fireEvent.click(screen.getByTestId('level-error'));
		await waitFor(() =>
			expect(
				requested.some((url) => url.includes('/api/series') && url.includes('level=error')),
			).toBe(true),
		);
	});

	it('buckets the streamed lines itself when the source is CloudWatch', async () => {
		setUrl('?region=us-east-1&group=/aws/app&mode=historic&range=1h');
		await renderPage();
		requested.length = 0;
		// Open the stream so it has a target, then check no series request is made.
		await fireEvent.click(screen.getAllByTestId('group-row')[0] as HTMLElement);
		await waitFor(() => expect(screen.getByTestId('event-scatter')).toBeTruthy());
		expect(requested.some((url) => url.includes('/api/series'))).toBe(false);
	});
});

describe('page: chart defaults', () => {
	it('selects duration and requests duration data on first visit', async () => {
		setUrl('?region=us-east-1&group=/aws/app&source=archive&mode=historic&range=1h');
		await renderPage();
		expect(screen.getByTestId('chart-metric-duration').getAttribute('aria-pressed')).toBe('true');
		await waitFor(() =>
			expect(
				requested.some((url) => url.includes('/api/series') && url.includes('metric=duration')),
			).toBe(true),
		);
		await fireEvent.click(screen.getByTestId('chart-metric-count'));
		expect(screen.getByTestId('chart-metric-count').getAttribute('aria-pressed')).toBe('true');
	});
});

describe('page: grouping by request', () => {
	it('asks the archive to count requests by default', async () => {
		setUrl('?region=us-east-1&group=/aws/app&source=archive&mode=historic&range=1h');
		await renderPage();

		await waitFor(() =>
			expect(
				requested.some((url) => url.includes('/api/series') && url.includes('by=request')),
			).toBe(true),
		);
	});

	it('switches the chart to lines, and remembers the choice, when grouping is turned off', async () => {
		setUrl('?region=us-east-1&group=/aws/app&source=archive&mode=historic&range=1h');
		await renderPage();
		await waitFor(() => expect(requested.some((url) => url.includes('/api/series'))).toBe(true));
		requested.length = 0;

		await fireEvent.click(screen.getByTestId('group-toggle'));
		await waitFor(() =>
			expect(requested.some((url) => url.includes('/api/series') && url.includes('by=event'))).toBe(
				true,
			),
		);
		expect(localStorage.getItem('watch-tail:group-requests')).toBe('false');
	});

	it('starts grouped off when the stored preference says so', async () => {
		localStorage.setItem('watch-tail:group-requests', 'false');
		setUrl('?region=us-east-1&group=/aws/app&source=archive&mode=historic&range=1h');
		await renderPage();

		await waitFor(() =>
			expect(requested.some((url) => url.includes('/api/series') && url.includes('by=event'))).toBe(
				true,
			),
		);
		expect(screen.getByTestId('group-toggle').getAttribute('aria-pressed')).toBe('false');
	});
});

describe('page: collapsible group sidebar', () => {
	it('collapses and expands the group list', async () => {
		setUrl('?region=us-east-1&group=/aws/app');
		await renderPage();

		expect(screen.getByTestId('sidebar')).toBeTruthy();
		expect(screen.getByTestId('sidebar-resizer')).toBeTruthy();
		expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('true');

		await fireEvent.click(screen.getByTestId('sidebar-toggle'));

		expect(screen.queryByTestId('sidebar')).toBeNull();
		expect(screen.queryByTestId('sidebar-resizer')).toBeNull();
		expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('false');
		expect(localStorage.getItem('watch-tail:sidebar-open')).toBe('false');

		await fireEvent.click(screen.getByTestId('sidebar-toggle'));
		expect(screen.getByTestId('sidebar')).toBeTruthy();
		expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('true');
		expect(localStorage.getItem('watch-tail:sidebar-open')).toBe('true');
	});

	it('collapses from the chevron on the sidebar seam', async () => {
		setUrl('?region=us-east-1&group=/aws/app');
		await renderPage();

		expect(screen.getByTestId('sidebar-seam-toggle').getAttribute('aria-expanded')).toBe('true');
		await fireEvent.click(screen.getByTestId('sidebar-seam-toggle'));

		expect(screen.queryByTestId('sidebar')).toBeNull();
		expect(screen.getByTestId('sidebar-seam-toggle').getAttribute('aria-expanded')).toBe('false');

		await fireEvent.click(screen.getByTestId('sidebar-seam-toggle'));
		expect(screen.getByTestId('sidebar')).toBeTruthy();
	});

	it('starts collapsed when the stored preference says so, leaving the log view in place', async () => {
		localStorage.setItem('watch-tail:sidebar-open', 'false');
		setUrl('?region=us-east-1&group=/aws/app');
		await renderPage();

		expect(screen.queryByTestId('sidebar')).toBeNull();
		expect(screen.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('false');
		// The log view and its toolbar survive folding the sidebar away.
		expect(screen.getByTestId('log-scroller')).toBeTruthy();
	});
});
