import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogLevel } from '$lib/log-buffer';
import LogViewer from './LogViewer.svelte';
import { puppy } from '$lib/puppy.svelte';
import type { LogEventDto } from '$lib/types';

// Auto-cleanup only runs when vitest globals are enabled, which they are not here.
afterEach(() => {
	cleanup();
	localStorage.clear();
});

const LINES: LogEventDto[] = [
	{
		id: 'a',
		timestamp: Date.UTC(2024, 0, 2, 3, 4, 5, 678),
		message: 'ERROR keep this line',
		streamName: 'stream-1',
	},
	{
		id: 'b',
		timestamp: Date.UTC(2024, 0, 2, 3, 4, 6, 0),
		message: 'harmless noise',
		streamName: 'stream-2',
	},
];

describe('LogViewer', () => {
	it('renders the provided lines with time, stream name and level', () => {
		render(LogViewer, {
			props: {
				lines: LINES,
				group: '/aws/app',
				region: 'us-east-1',
				status: 'live',
				receivedCount: 2,
			},
		});

		const rows = screen.getAllByTestId('log-line');
		expect(rows).toHaveLength(2);
		expect(screen.getByText('ERROR keep this line')).toBeTruthy();
		expect(screen.getByText('stream-1')).toBeTruthy();
		expect(screen.getByText('03:04:05.678')).toBeTruthy();
		expect(rows[0].dataset.level).toBe('error');
		// 'harmless noise' carries no level word, so it is honestly unknown rather
		// than being labelled info.
		expect(rows[1].dataset.level).toBe('unknown');
		expect(screen.getByText('ERROR keep this line').className).toContain('text-red-400');
	});

	it('hides lines that do not match the filter', () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app', filter: 'KEEP' } });

		expect(screen.getAllByTestId('log-line')).toHaveLength(1);
		expect(screen.queryByText('harmless noise')).toBeNull();
	});

	it('calls the toolbar handlers for pause, clear and auto-scroll', async () => {
		const onPauseToggle = vi.fn<() => void>();
		const onClear = vi.fn<() => void>();
		const onAutoScrollToggle = vi.fn<() => void>();
		render(LogViewer, {
			props: { lines: LINES, group: '/aws/app', onPauseToggle, onClear, onAutoScrollToggle },
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Auto-scroll' }));

		expect(onPauseToggle).toHaveBeenCalledTimes(1);
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(onAutoScrollToggle).toHaveBeenCalledTimes(1);
	});

	it('reports filter typing and shows Resume while paused', async () => {
		const onFilterChange = vi.fn<(value: string) => void>();
		render(LogViewer, {
			props: { lines: LINES, group: '/aws/app', paused: true, onFilterChange },
		});

		expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();

		await fireEvent.input(screen.getByLabelText('Filter log lines'), { target: { value: 'boom' } });

		expect(onFilterChange).toHaveBeenCalledWith('boom');
	});

	it('shows the idle prompt when no group is selected', () => {
		render(LogViewer, { props: {} });

		expect(screen.getByTestId('viewer-idle')).toBeTruthy();
		expect(screen.queryAllByTestId('log-line')).toHaveLength(0);
	});

	it('shows the waiting state for a selected group without lines', () => {
		render(LogViewer, { props: { lines: [], group: '/aws/app', status: 'live' } });

		expect(screen.getByTestId('viewer-empty').textContent).toContain(
			'Waiting for events from /aws/app',
		);
	});

	it('shows a stream error with group and region context', () => {
		render(LogViewer, {
			props: {
				lines: LINES,
				group: '/aws/app',
				region: 'us-east-1',
				status: 'error',
				error: { message: 'No log groups found' },
			},
		});

		expect(screen.getByRole('alert').textContent).toContain(
			'No log groups found (/aws/app in us-east-1)',
		);
		// The buffered lines stay visible while an error is shown.
		expect(screen.getAllByTestId('log-line')).toHaveLength(2);
	});
});

describe('LogViewer JSON handling', () => {
	const JSON_LINE: LogEventDto = {
		id: 'j',
		timestamp: Date.UTC(2024, 0, 2, 3, 4, 5, 678),
		message: '{"level":"info","order":{"id":"ord_1","items":[1,2]}}',
		streamName: 'stream-json',
	};

	it('pretty-prints JSON messages by default', () => {
		render(LogViewer, { props: { lines: [JSON_LINE], group: '/aws/app', region: 'us-east-1' } });

		const message = screen.getByTestId('log-message');
		expect(message.textContent).toContain('{\n  "level": "info",');
		// Colouring comes from token spans, so the raw text is split across elements.
		expect(message.querySelectorAll('span').length).toBeGreaterThan(3);
		expect(message.className).toContain('whitespace-pre');
	});

	it('renders the raw line when the JSON toggle is switched off', async () => {
		render(LogViewer, { props: { lines: [JSON_LINE], group: '/aws/app' } });

		await fireEvent.click(screen.getByTestId('json-toggle'));

		expect(screen.getByTestId('log-message').textContent).toBe(JSON_LINE.message);
		expect(screen.getByTestId('json-toggle').getAttribute('aria-pressed')).toBe('false');
	});

	it('leaves non-JSON lines untouched', () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });

		expect(screen.getByText('ERROR keep this line').textContent).toBe('ERROR keep this line');
	});
});

/** Class list of the first rendered message cell. */
function firstMessageClass(): string {
	return screen.getAllByTestId('log-message')[0].className;
}

describe('LogViewer layout controls', () => {
	it('does not wrap long lines by default and wraps them when toggled', async () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });

		const canvas = screen.getByTestId('log-canvas');
		expect(canvas.className).toContain('w-max');
		expect(firstMessageClass()).toContain('whitespace-pre');
		expect(firstMessageClass()).not.toContain('whitespace-pre-wrap');

		await fireEvent.click(screen.getByTestId('wrap-toggle'));

		expect(screen.getByTestId('log-canvas').className).toContain('w-full');
		expect(firstMessageClass()).toContain('whitespace-pre-wrap');
	});

	it('truncates a long Lambda stream name so the message stays visible', () => {
		const longStream =
			'2026/09/11/watch-tail-demo-backend-WhatsAppApiWebh0okFnE1B794-V02WQc7jN0VN[$LATEST]a2561676c1814e2d8bf96571caf8fb57';
		render(LogViewer, {
			props: {
				lines: [{ ...LINES[0], streamName: longStream }],
				group: '/aws/lambda/demo',
			},
		});

		const stream = screen.getByTestId('log-stream');
		expect(stream.className).toContain('truncate');
		expect(stream.getAttribute('title')).toBe(longStream);
		expect(stream.getAttribute('style')).toContain('width');
		expect(screen.getByTestId('log-message').textContent).toContain('ERROR keep this line');
	});

	it('exposes the prefix resizer with separator semantics', () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });

		const handle = screen.getByTestId('prefix-resizer');
		expect(handle.getAttribute('role')).toBe('separator');
		expect(handle.getAttribute('aria-orientation')).toBe('vertical');
		expect(handle.getAttribute('aria-label')).toBe('Resize stream column');
		expect(handle.getAttribute('tabindex')).toBe('0');
		expect(Number(handle.getAttribute('aria-valuenow'))).toBe(224);
	});

	it('resizes the prefix column with the arrow keys and with a pointer drag', async () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });

		const handle = screen.getByTestId('prefix-resizer');
		await fireEvent.keyDown(handle, { key: 'ArrowRight' });
		expect(Number(handle.getAttribute('aria-valuenow'))).toBe(240);

		await fireEvent.keyDown(handle, { key: 'ArrowLeft' });
		await fireEvent.keyDown(handle, { key: 'ArrowLeft' });
		expect(Number(handle.getAttribute('aria-valuenow'))).toBe(208);

		await fireEvent(handle, new MouseEvent('pointerdown', { clientX: 300, bubbles: true }));
		await fireEvent(handle, new MouseEvent('pointermove', { clientX: 360, bubbles: true }));
		await fireEvent(handle, new MouseEvent('pointerup', { clientX: 360, bubbles: true }));
		expect(Number(handle.getAttribute('aria-valuenow'))).toBe(268);
	});

	it('resizes and restores timestamp and group widths, keeping the stream handle aligned', async () => {
		const props = { lines: LINES, group: '/aws/app', groups: ['/aws/app', '/aws/other'] };
		const view = render(LogViewer, { props });
		await fireEvent.keyDown(screen.getByTestId('timestamp-resizer'), { key: 'ArrowRight' });
		await fireEvent.keyDown(screen.getByTestId('group-resizer'), { key: 'ArrowRight' });
		expect(localStorage.getItem('watch-tail:timestamp-width')).toBe('136');
		expect(localStorage.getItem('watch-tail:group-width')).toBe('160');
		expect(screen.getByTestId('prefix-resizer').style.left).toBe('544px');
		expect(screen.getAllByTestId('log-group')[0]?.style.width).toBe('160px');
		view.unmount();
		render(LogViewer, { props });
		await waitFor(() =>
			expect(screen.getByTestId('timestamp-resizer').getAttribute('aria-valuenow')).toBe('136'),
		);
		expect(screen.getByTestId('group-resizer').getAttribute('aria-valuenow')).toBe('160');
	});

	it('persists the view preferences in localStorage', async () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });

		await fireEvent.click(screen.getByTestId('json-toggle'));
		await fireEvent.click(screen.getByTestId('wrap-toggle'));
		await fireEvent.keyDown(screen.getByTestId('prefix-resizer'), { key: 'ArrowRight' });

		expect(localStorage.getItem('watch-tail:json-view')).toBe('false');
		expect(localStorage.getItem('watch-tail:wrap')).toBe('true');
		expect(localStorage.getItem('watch-tail:prefix-width')).toBe('240');
	});

	it('restores the stored preferences on mount', async () => {
		localStorage.setItem('watch-tail:json-view', 'false');
		localStorage.setItem('watch-tail:wrap', 'true');
		localStorage.setItem('watch-tail:prefix-width', '320');

		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });
		await Promise.resolve();

		expect(screen.getByTestId('json-toggle').getAttribute('aria-pressed')).toBe('false');
		expect(screen.getByTestId('log-canvas').className).toContain('w-full');
		expect(Number(screen.getByTestId('prefix-resizer').getAttribute('aria-valuenow'))).toBe(320);
	});
});

describe('LogViewer window chip', () => {
	const ready = {
		region: 'us-east-1',
		logGroupName: '/aws/app',
		groups: ['/aws/app'],
		endpoint: null,
		source: 'cloudwatch' as const,
		startTime: Date.UTC(2024, 4, 10, 11, 0, 0),
		endTime: Date.UTC(2024, 4, 10, 12, 0, 0),
		mode: 'historic' as const,
		preset: '1h',
		clamped: false,
	};

	it('shows a live chip by default', () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });
		expect(screen.getByTestId('window-chip').textContent).toContain('live');
	});

	it('shows the historic preset and bounds', () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app', mode: 'historic', ready } });

		const chip = screen.getByTestId('window-chip');
		expect(chip.textContent).toContain('1 hour');
		// The bounds are joined by an arrow icon, not a text glyph.
		expect(chip.querySelector('svg.lucide-arrow-right')).toBeTruthy();
	});

	it('flags a clamped window and a completed scan', () => {
		render(LogViewer, {
			props: {
				lines: LINES,
				group: '/aws/app',
				mode: 'historic',
				ready: { ...ready, clamped: true },
				endReason: 'window-complete',
			},
		});

		expect(screen.getByTestId('window-clamped').textContent).toContain('14-day');
		expect(screen.getByTestId('window-complete').textContent).toContain('window complete');
	});

	it('does not claim completion for a live tail', () => {
		render(LogViewer, {
			props: { lines: LINES, group: '/aws/app', endReason: 'client-disconnected' },
		});
		expect(screen.queryByTestId('window-complete')).toBeNull();
	});
});

describe('LogViewer archive mode', () => {
	const archiveReady = {
		region: 'us-east-1',
		logGroupName: '/aws/app',
		groups: ['/aws/app'],
		endpoint: null,
		source: 'archive' as const,
		startTime: Date.UTC(2024, 4, 10, 11, 0, 0),
		endTime: Date.UTC(2024, 4, 10, 12, 0, 0),
		mode: 'historic' as const,
		preset: '1h',
		clamped: false,
	};
	const ARCHIVE_PATH = '/Users/dev/Library/Application Support/watch-tail/archive.duckdb';

	it('marks the events as locally archived and names the database file', () => {
		render(LogViewer, {
			props: {
				lines: LINES,
				group: '/aws/app',
				mode: 'historic',
				ready: archiveReady,
				archivePath: ARCHIVE_PATH,
			},
		});

		const badge = screen.getByTestId('archive-badge');
		expect(badge.textContent?.trim()).toBe('local archive');
		expect(badge.getAttribute('title')).toContain('Locally archived events');
		expect(badge.getAttribute('title')).toContain(ARCHIVE_PATH);
	});

	it('renders no archive indicator for CloudWatch events', () => {
		render(LogViewer, {
			props: {
				lines: LINES,
				group: '/aws/app',
				mode: 'historic',
				ready: { ...archiveReady, source: 'cloudwatch' },
			},
		});

		expect(screen.queryByTestId('archive-badge')).toBeNull();
	});

	it('never shows a live, connecting or reconnecting badge for the archive', () => {
		for (const status of ['connecting', 'live', 'reconnecting'] as const) {
			const { unmount } = render(LogViewer, {
				props: { lines: LINES, group: '/aws/app', mode: 'historic', ready: archiveReady, status },
			});

			const badge = screen.getByTestId('status-badge');
			expect(badge.dataset.status).toBe('idle');
			expect(badge.textContent?.trim()).toBe('idle');
			unmount();
		}
	});

	it('ends on the neutral ended pill when the archived window completes', () => {
		render(LogViewer, {
			props: {
				lines: LINES,
				group: '/aws/app',
				mode: 'historic',
				ready: archiveReady,
				status: 'ended',
				endReason: 'window-complete',
			},
		});

		const badge = screen.getByTestId('status-badge');
		expect(badge.dataset.status).toBe('ended');
		expect(badge.className).toContain('neutral');
		expect(screen.getByTestId('window-complete')).toBeTruthy();
	});

	it('still reports a real archive failure', () => {
		render(LogViewer, {
			props: {
				lines: [],
				group: '/aws/app',
				region: 'us-east-1',
				mode: 'historic',
				ready: archiveReady,
				status: 'error',
				error: { message: 'Cannot find module @duckdb/node-api', code: 'archive-unavailable' },
			},
		});

		expect(screen.getByTestId('status-badge').dataset.status).toBe('error');
		expect(screen.getByRole('alert').textContent).toContain('@duckdb/node-api');
	});

	it('says the archived window is empty instead of waiting for live events', () => {
		render(LogViewer, {
			props: { lines: [], group: '/aws/app', mode: 'historic', ready: archiveReady },
		});

		const empty = screen.getByTestId('viewer-empty').textContent ?? '';
		expect(empty).toContain('No archived events for /aws/app');
		expect(empty).not.toContain('Waiting for events');
	});
});

/** Renders the viewer with pretty-printing off, which is when lines become expandable. */
async function renderWithJsonOff(lines: LogEventDto[]) {
	render(LogViewer, { props: { lines, group: '/aws/app' } });
	await fireEvent.click(screen.getByTestId('json-toggle'));
	return screen.getAllByTestId('log-line');
}

describe('LogViewer expandable JSON lines', () => {
	const JSON_LINE: LogEventDto = {
		id: 'j1',
		timestamp: Date.UTC(2024, 0, 2, 3, 4, 5, 678),
		message: '{"level":"info","order":{"id":"ord_1"}}',
		streamName: 'stream-1',
	};
	const PREFIXED_LINE: LogEventDto = {
		id: 'j2',
		timestamp: Date.UTC(2024, 0, 2, 3, 4, 6, 0),
		message: '2026-01-01 INFO {"level":"warn","msg":"slow"}',
		streamName: 'stream-2',
	};
	const PLAIN_LINE: LogEventDto = {
		id: 'j3',
		timestamp: Date.UTC(2024, 0, 2, 3, 4, 7, 0),
		message: 'START RequestId: 8f2c Version: $LATEST',
		streamName: 'stream-3',
	};

	it('marks only lines that carry JSON as expandable', async () => {
		const rows = await renderWithJsonOff([JSON_LINE, PREFIXED_LINE, PLAIN_LINE]);

		expect(rows[0].dataset.expandable).toBe('true');
		expect(rows[1].dataset.expandable).toBe('true');
		expect(rows[2].dataset.expandable).toBeUndefined();
		expect(rows[2].getAttribute('role')).toBeNull();
	});

	it('shows a line as JSON when clicked, and closes it when clicked again', async () => {
		const rows = await renderWithJsonOff([JSON_LINE, PLAIN_LINE]);

		expect(screen.queryByTestId('log-json-expanded')).toBeNull();
		expect(rows[0].getAttribute('aria-expanded')).toBe('false');

		await fireEvent.click(rows[0]);

		const expanded = screen.getByTestId('log-json-expanded');
		expect(expanded.textContent).toContain('{\n  "level": "info",');
		expect(rows[0].getAttribute('aria-expanded')).toBe('true');
		expect(rows[0].dataset.expanded).toBe('true');
		// the raw line stays visible above the parsed block
		expect(screen.getAllByTestId('log-message')[0].textContent).toBe(JSON_LINE.message);

		await fireEvent.click(rows[0]);

		expect(screen.queryByTestId('log-json-expanded')).toBeNull();
		expect(rows[0].getAttribute('aria-expanded')).toBe('false');
	});

	it('extracts the payload from a line with a prefix, leaving the rest out', async () => {
		const rows = await renderWithJsonOff([PREFIXED_LINE]);

		await fireEvent.click(rows[0]);

		const expanded = screen.getByTestId('log-json-expanded');
		expect(expanded.textContent).toContain('"level": "warn"');
		expect(expanded.textContent).not.toContain('2026-01-01');
	});

	it('opens and closes with the keyboard', async () => {
		const rows = await renderWithJsonOff([JSON_LINE]);

		await fireEvent.keyDown(rows[0], { key: 'Enter' });
		expect(screen.getByTestId('log-json-expanded')).toBeTruthy();

		await fireEvent.keyDown(rows[0], { key: ' ' });
		expect(screen.queryByTestId('log-json-expanded')).toBeNull();
	});

	it('does nothing when a line without JSON is clicked', async () => {
		const rows = await renderWithJsonOff([PLAIN_LINE]);

		await fireEvent.click(rows[0]);

		expect(screen.queryByTestId('log-json-expanded')).toBeNull();
	});

	it('leaves lines alone while pretty-printing is on', () => {
		render(LogViewer, { props: { lines: [JSON_LINE], group: '/aws/app' } });

		const row = screen.getAllByTestId('log-line')[0];
		expect(row.dataset.expandable).toBeUndefined();
		// pretty-printed inline instead, so there is nothing to expand
		expect(screen.getByTestId('log-message').textContent).toContain('{\n  "level": "info",');
	});
});

describe('LogViewer level filter', () => {
	const LINES_WITH_LEVELS = [
		{
			id: 'a',
			timestamp: 1_700_000_000_000,
			message: '{"level":"error","msg":"boom"}',
			level: 'error' as const,
		},
		{
			id: 'b',
			timestamp: 1_700_000_001_000,
			message: '{"level":"warn","msg":"slow"}',
			level: 'warn' as const,
		},
		{
			id: 'c',
			timestamp: 1_700_000_002_000,
			message: '{"level":"info","msg":"ok"}',
			level: 'info' as const,
		},
		{ id: 'd', timestamp: 1_700_000_003_000, message: '\tat Handler.java:41', level: null },
	];

	it('shows every level until a chip is chosen', () => {
		render(LogViewer, { props: { lines: LINES_WITH_LEVELS, group: '/aws/app' } });
		expect(screen.getAllByTestId('log-line')).toHaveLength(4);
		expect(screen.getByTestId('level-all').getAttribute('aria-pressed')).toBe('true');
	});

	it('narrows to one level when its chip is pressed', async () => {
		render(LogViewer, { props: { lines: LINES_WITH_LEVELS, group: '/aws/app' } });
		await fireEvent.click(screen.getByTestId('level-error'));

		expect(screen.getAllByTestId('log-line')).toHaveLength(1);
		expect(screen.getByText(/boom/)).toBeTruthy();
		expect(screen.getByTestId('level-error').getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('visible-count').textContent).toContain('1 shown');
	});

	it('leaves unclassified lines out of a level filter, and back in with All', async () => {
		render(LogViewer, { props: { lines: LINES_WITH_LEVELS, group: '/aws/app' } });
		await fireEvent.click(screen.getByTestId('level-warn'));
		expect(screen.queryByText(/Handler.java/)).toBeNull();

		await fireEvent.click(screen.getByTestId('level-all'));
		expect(screen.getAllByTestId('log-line')).toHaveLength(4);
	});

	it('counts loaded lines per level on the chips', () => {
		render(LogViewer, { props: { lines: LINES_WITH_LEVELS, group: '/aws/app' } });
		expect(screen.getByTestId('level-error').textContent).toContain('1');
		expect(screen.getByTestId('level-info').textContent).toContain('1');
		// No debug line is loaded, so the chip shows no count.
		expect(screen.getByTestId('level-debug').textContent).not.toMatch(/\d/);
	});

	it('prefers the level the server detected over a fresh guess', () => {
		// The text says ERROR, the server said debug: the stored level wins.
		render(LogViewer, {
			props: {
				lines: [
					{ id: 'x', timestamp: 1, message: 'ERROR looking, but debug', level: 'debug' as const },
				],
				group: '/aws/app',
			},
		});
		expect(screen.getAllByTestId('log-line')[0]?.dataset.level).toBe('debug');
	});
});

describe('LogViewer group column', () => {
	const TWO_GROUPS = [
		{ id: 'a', timestamp: 1_700_000_000_000, message: 'from one', group: '/aws/lambda/one' },
		{ id: 'b', timestamp: 1_700_000_001_000, message: 'from two', group: '/aws/lambda/two' },
	];

	it('adds a group column only when several groups are in view', () => {
		const single = render(LogViewer, {
			props: { lines: TWO_GROUPS, group: '/aws/lambda/one', groups: ['/aws/lambda/one'] },
		});
		expect(screen.queryAllByTestId('log-group')).toHaveLength(0);
		single.unmount();

		render(LogViewer, {
			props: {
				lines: TWO_GROUPS,
				group: '/aws/lambda/one',
				groups: ['/aws/lambda/one', '/aws/lambda/two'],
			},
		});
		const cells = screen.getAllByTestId('log-group');
		expect(cells.map((cell) => cell.textContent)).toEqual(['/aws/lambda/one', '/aws/lambda/two']);
	});

	it('labels lines from the group that produced them', () => {
		render(LogViewer, {
			props: {
				lines: TWO_GROUPS,
				// A selected group is what makes the viewer show lines at all.
				group: '/aws/lambda/one',
				groups: ['/aws/lambda/one', '/aws/lambda/two'],
			},
		});
		const rows = screen.getAllByTestId('log-line');
		expect(rows[0]?.textContent).toContain('/aws/lambda/one');
		expect(rows[1]?.textContent).toContain('/aws/lambda/two');
	});
});

describe('LogViewer controlled level filter', () => {
	const LEVEL_LINES = [
		{
			id: 'a',
			timestamp: 1_700_000_000_000,
			message: '{"level":"error","msg":"boom"}',
			level: 'error' as const,
		},
		{
			id: 'b',
			timestamp: 1_700_000_001_000,
			message: '{"level":"info","msg":"ok"}',
			level: 'info' as const,
		},
	];

	it('uses the level it is given and reports changes upwards', async () => {
		const onLevelChange = vi.fn<(level: LogLevel | null) => void>();
		render(LogViewer, {
			props: { lines: LEVEL_LINES, group: '/aws/app', level: 'error', onLevelChange },
		});
		// The parent's filter is applied: only the error line is visible.
		expect(screen.getAllByTestId('log-line')).toHaveLength(1);

		await fireEvent.click(screen.getByTestId('level-all'));
		expect(onLevelChange).toHaveBeenCalledWith(null);
		await fireEvent.click(screen.getByTestId('level-info'));
		expect(onLevelChange).toHaveBeenCalledWith('info');
	});

	it('keeps owning the filter when no level prop is passed', async () => {
		render(LogViewer, { props: { lines: LINES, group: '/aws/app' } });
		expect(screen.getAllByTestId('log-line')).toHaveLength(2);
		await fireEvent.click(screen.getByTestId('level-error'));
		expect(screen.getAllByTestId('log-line')).toHaveLength(1);
	});
});

describe('LogViewer: grouping by request', () => {
	const REQUEST_LINES: LogEventDto[] = [
		{
			id: 'a',
			timestamp: Date.UTC(2024, 0, 2, 3, 4, 5, 0),
			message: '{"requestId":"req-1","level":"info","msg":"started"}',
			level: 'info',
			requestId: 'req-1',
			streamName: 'stream-1',
		},
		{
			id: 'b',
			timestamp: Date.UTC(2024, 0, 2, 3, 4, 5, 500),
			message: '{"requestId":"req-1","level":"error","msg":"failed"}',
			level: 'error',
			requestId: 'req-1',
			streamName: 'stream-1',
		},
		{
			id: 'c',
			timestamp: Date.UTC(2024, 0, 2, 3, 4, 6, 0),
			message: 'a line with no request at all',
		},
	];

	it('shows one row per request by default, with its worst level', () => {
		render(LogViewer, { props: { lines: REQUEST_LINES, group: '/aws/app', status: 'live' } });

		const groups = screen.getAllByTestId('log-request-group');
		expect(groups).toHaveLength(1);
		expect(groups[0]?.getAttribute('data-request-id')).toBe('req-1');
		expect(groups[0]?.getAttribute('data-level')).toBe('error');
		expect(screen.getByTestId('request-group-count').textContent).toContain('2 lines');
		expect(screen.getByTestId('request-group-level').textContent).toContain('Error');
		expect(screen.getByTestId('request-group-span').textContent).toContain('500ms');
		// The worst line is what the collapsed row previews.
		expect(screen.getByTestId('request-group-preview').textContent).toContain('failed');
		// The request's lines are hidden until the row is opened, and the loose line stays.
		expect(screen.queryAllByTestId('log-line')).toHaveLength(1);
		expect(screen.getByTestId('request-count').textContent).toContain('1 requests');
	});

	it('opens a request to show every line it holds', async () => {
		render(LogViewer, { props: { lines: REQUEST_LINES, group: '/aws/app', status: 'live' } });

		await fireEvent.click(screen.getByTestId('request-group-summary'));
		const children = screen.getAllByTestId('log-line');
		expect(children).toHaveLength(3);
		expect(screen.getAllByTestId('log-line')[1]?.getAttribute('data-request-child')).toBe('true');
		expect(screen.getByTestId('log-request-group').getAttribute('data-expanded')).toBe('true');
	});

	it('shows one row per line when grouping is off', () => {
		render(LogViewer, {
			props: { lines: REQUEST_LINES, group: '/aws/app', status: 'live', groupRequests: false },
		});

		expect(screen.queryAllByTestId('log-request-group')).toHaveLength(0);
		expect(screen.getAllByTestId('log-line')).toHaveLength(3);
		expect(screen.queryAllByTestId('request-count')).toHaveLength(0);
	});

	it('renders a request with a single line as that line', () => {
		render(LogViewer, {
			props: {
				lines: [REQUEST_LINES[2] as LogEventDto],
				group: '/aws/app',
				status: 'live',
			},
		});
		expect(screen.queryAllByTestId('log-request-group')).toHaveLength(0);
		expect(screen.getAllByTestId('log-line')).toHaveLength(1);
	});

	it('reports the toggle, so the page can own the preference', async () => {
		const onGroupToggle = vi.fn<() => void>();
		render(LogViewer, {
			props: { lines: REQUEST_LINES, group: '/aws/app', status: 'live', onGroupToggle },
		});
		await fireEvent.click(screen.getByTestId('group-toggle'));
		expect(onGroupToggle).toHaveBeenCalledTimes(1);
	});
});

it('expands and highlights a chart-selected request and scrolls vertically to it', async () => {
	const lines = [
		{ id: 'before', timestamp: 100, message: 'before' },
		{
			id: 'start',
			timestamp: 1000,
			message: 'start',
			requestId: 'chosen',
			group: 'app',
			level: 'info' as const,
		},
		{
			id: 'end',
			timestamp: 2000,
			message: 'end',
			requestId: 'chosen',
			group: 'app',
			level: 'error' as const,
		},
	];
	const { rerender } = render(LogViewer, { props: { lines, autoScroll: false, group: 'app' } });
	const scroller = screen.getByTestId('log-scroller');
	scroller.scrollLeft = 50;
	const rect = vi
		.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
		.mockImplementation(function (this: HTMLElement) {
			return { top: this.dataset.chartSelected === 'true' ? 400 : 100 } as DOMRect;
		});
	try {
		await rerender({
			selection: {
				point: { t: 1000, group: 'app', level: 'error', events: 1, requestId: 'chosen' },
				bucketMs: 1000,
				byRequest: true,
				fallbackGroup: '',
			},
		});
		await waitFor(() => expect(scroller.scrollTop).toBe(292));
		expect(scroller.scrollLeft).toBe(50);
		expect(screen.getByTestId('log-request-group').dataset.expanded).toBe('true');
		expect(
			screen.getAllByTestId('log-line').filter((row) => row.dataset.chartSelected === 'true'),
		).toHaveLength(2);
		scroller.scrollTop = 123;
		await rerender({ lines: [...lines, { id: 'new', timestamp: 3000, message: 'incoming' }] });
		expect(scroller.scrollTop).toBe(123);
		await rerender({ filter: 'no matches' });
		expect(screen.getByTestId('chart-selection-status').textContent).toContain('0 of 2');
	} finally {
		rect.mockRestore();
	}
});

describe('LogViewer: the puppy companion', () => {
	afterEach(() => {
		puppy.shown = false;
		puppy.pulse = 0;
	});

	it('gives the puppy a wag each time a JSON line opens or closes', async () => {
		puppy.shown = true;
		const rows = await renderWithJsonOff([
			{
				id: 'p1',
				timestamp: Date.UTC(2024, 0, 2, 3, 4, 5),
				message: '{"level":"info","msg":"woof"}',
				streamName: 'stream-1',
			},
		]);
		await fireEvent.click(rows[0]);
		await fireEvent.click(rows[0]);
		expect(puppy.pulse).toBe(2);
	});
});
