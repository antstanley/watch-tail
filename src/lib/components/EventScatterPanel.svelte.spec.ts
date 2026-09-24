import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EventScatter from './EventScatter.svelte';
import EventScatterPanel from './EventScatterPanel.svelte';
import { STORAGE_KEYS } from '$lib/resize';
import type { SeriesPoint } from '$lib/types';

// layerchart needs browser APIs jsdom lacks; src/lib/test-setup-client.ts stubs them.

afterEach(() => cleanup());
beforeEach(() => {
	try {
		localStorage.clear();
	} catch {
		// Storage is optional in these tests.
	}
});

const BASE = Date.UTC(2024, 4, 17, 12, 0, 0);
const MINUTE = 60_000;

function points(): SeriesPoint[] {
	const rows: SeriesPoint[] = [];
	for (let index = 0; index < 4; index += 1) {
		rows.push({ t: BASE + index * MINUTE, group: '/a', level: 'error', events: 2 });
		rows.push({ t: BASE + index * MINUTE, group: '/a', level: 'info', events: 1 });
	}
	return rows;
}

/** A chart loader whose promise is resolved by the test. */
function deferChart(): {
	load: () => Promise<{ default: typeof EventScatter }>;
	resolve: () => void;
} {
	let release: (() => void) | undefined;
	const load = (): Promise<{ default: typeof EventScatter }> =>
		new Promise((resolve) => {
			release = () => resolve({ default: EventScatter });
		});
	return { load, resolve: () => release?.() };
}

function props(overrides: Record<string, unknown> = {}) {
	return {
		points: points(),
		from: BASE,
		to: BASE + 4 * MINUTE,
		bucketMs: MINUTE,
		// The app fetches this chunk lazily; a test injects it so the assertions do
		// not depend on the bundler resolving a dynamic import.
		loadChart: async () => ({ default: EventScatter }),
		...overrides,
	};
}

/**
 * Text of an element with runs of whitespace collapsed.
 *
 * The header wraps its summary across lines, and a browser renders that as one
 * space, so an assertion must not depend on where the formatter broke it.
 */
function text(testId: string): string {
	return (screen.getByTestId(testId).textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('EventScatterPanel', () => {
	it('summarises the window and each level in the header', () => {
		render(EventScatterPanel, { props: props() });
		// Grouping by request is the default, so the summary counts requests.
		expect(text('scatter-summary')).toContain('12 requests');
		expect(text('scatter-legend-error')).toContain('Error');
		expect(text('scatter-legend-info')).toContain('Info');
		expect(text('scatter-hint')).toContain('drag to zoom');
	});

	it('names the groups when the view holds more than one', () => {
		render(EventScatterPanel, { props: props({ groups: ['/a', '/b'] }) });
		expect(text('scatter-groups')).toContain('2 groups');
	});

	it('shows a placeholder until the chart chunk arrives', async () => {
		const deferred = deferChart();
		const { container } = render(EventScatterPanel, { props: props({ loadChart: deferred.load }) });

		// Nothing is drawn yet, and the header is already useful.
		expect(container.querySelector('[data-testid="scatter-chart"]')).toBeNull();
		expect(screen.getByTestId('scatter-summary')).toBeTruthy();
		deferred.resolve();
		await waitFor(() =>
			expect(container.querySelector('[data-testid="scatter-chart"]')).not.toBeNull(),
		);
	});

	it('reports a failure to fetch the chart without breaking the panel', async () => {
		render(EventScatterPanel, {
			props: props({
				loadChart: async () => {
					throw new Error('chunk unavailable');
				},
			}),
		});
		await waitFor(() => expect(screen.getByTestId('scatter-error')).toBeTruthy());
		expect(screen.getByTestId('scatter-summary')).toBeTruthy();
	});

	it('loads the chart on demand, once the panel is open', async () => {
		const { container } = render(EventScatterPanel, { props: props() });
		// The header is there immediately; the chart chunk arrives afterwards.
		expect(screen.getByTestId('scatter-summary')).toBeTruthy();
		await waitFor(() =>
			expect(container.querySelector('[data-testid="scatter-chart"]')).not.toBeNull(),
		);
		expect(container.querySelector('.lc-root-container')).not.toBeNull();
	});

	it('collapses to the header and back, remembering the choice', async () => {
		const { container } = render(EventScatterPanel, { props: props() });
		await waitFor(() =>
			expect(container.querySelector('[data-testid="scatter-chart"]')).not.toBeNull(),
		);

		await fireEvent.click(screen.getByTestId('scatter-toggle'));
		expect(container.querySelector('[data-testid="scatter-chart"]')).toBeNull();
		expect(screen.getByTestId('scatter-toggle').getAttribute('aria-expanded')).toBe('false');
		expect(screen.getByTestId('scatter-summary')).toBeTruthy();
		expect(localStorage.getItem(STORAGE_KEYS.chartOpen)).toBe('0');

		await fireEvent.click(screen.getByTestId('scatter-toggle'));
		await waitFor(() =>
			expect(container.querySelector('[data-testid="scatter-chart"]')).not.toBeNull(),
		);
		expect(localStorage.getItem(STORAGE_KEYS.chartOpen)).toBe('1');
	});

	it('starts collapsed when the preference says so', async () => {
		localStorage.setItem(STORAGE_KEYS.chartOpen, '0');
		const { container } = render(EventScatterPanel, { props: props() });
		await waitFor(() =>
			expect(screen.getByTestId('scatter-toggle').getAttribute('aria-expanded')).toBe('false'),
		);
		expect(container.querySelector('[data-testid="scatter-chart"]')).toBeNull();
	});

	it('grows into the space it is given while it is open', () => {
		render(EventScatterPanel, { props: props({ fill: true }) });

		const section = screen.getByTestId('event-scatter');
		expect(section.className).toContain('flex-1');
	});

	it('keeps its header height when collapsed, even when asked to fill', async () => {
		localStorage.setItem(STORAGE_KEYS.chartOpen, '0');
		render(EventScatterPanel, { props: props({ fill: true }) });
		await waitFor(() =>
			expect(screen.getByTestId('scatter-toggle').getAttribute('aria-expanded')).toBe('false'),
		);

		// A collapsed chart must not stretch, or it would push the panel below it to the bottom.
		const section = screen.getByTestId('event-scatter');
		expect(section.className).toContain('shrink-0');
		expect(section.className).not.toContain('flex-1');
	});

	it('draws an empty chart with a no-data overlay when the window has no events', async () => {
		const { container } = render(EventScatterPanel, { props: props({ points: [] }) });
		await waitFor(() =>
			expect(container.querySelector('[data-testid="scatter-chart"]')).not.toBeNull(),
		);
		expect(screen.getByTestId('scatter-empty').textContent?.trim()).toBe('No data');
	});

	it('reports a loading count while the archive is being queried', () => {
		render(EventScatterPanel, { props: props({ loading: true }) });
		expect(screen.getByTestId('scatter-loading')).toBeTruthy();
	});

	it('forwards the brush and the reset', async () => {
		const onBrush = vi.fn<(range: { from: number; to: number } | null) => void>();
		const rendered = render(EventScatterPanel, { props: props({ onBrush }) });
		await waitFor(() =>
			expect(rendered.container.querySelector('[data-testid="scatter-chart"]')).not.toBeNull(),
		);

		// Reset zoom in the host calls the panel, which clears the chart's brush.
		(rendered.component as unknown as { reset: () => void }).reset();
		expect(onBrush).toHaveBeenCalledWith(null);
	});
});

describe('EventScatterPanel: what a mark stands for', () => {
	const marks: SeriesPoint[] = [
		{ t: 1_700_000_000_000, group: '/aws/app', level: 'error', events: 3 },
		{ t: 1_700_000_060_000, group: '/aws/app', level: 'info', events: 1 },
	];

	it('counts requests by default', () => {
		render(EventScatterPanel, { props: { points: marks, from: 0, to: 1, bucketMs: 60_000 } });
		expect(text('scatter-summary')).toContain('4 requests');
	});

	it('counts lines when grouping is off', () => {
		render(EventScatterPanel, {
			props: { points: marks, from: 0, to: 1, bucketMs: 60_000, byRequest: false, metric: 'count' },
		});
		expect(text('scatter-summary')).toContain('4 events');
	});
});
