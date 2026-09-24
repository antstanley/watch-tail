import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LogGroupList from './LogGroupList.svelte';
import type { LogGroupSummary } from '$lib/types';

// Auto-cleanup only runs when vitest globals are enabled, which they are not here.
afterEach(() => cleanup());

const GROUPS: LogGroupSummary[] = [
	{
		name: '/aws/lambda/checkout',
		arn: 'arn:aws:logs:us-east-1:1:log-group:/aws/lambda/checkout',
		storedBytes: 2048,
	},
	{ name: '/aws/lambda/orders', storedBytes: 0 },
];

describe('LogGroupList', () => {
	it('shows a loading skeleton while the request is in flight', () => {
		render(LogGroupList, { props: { loading: true, region: 'us-east-1' } });

		expect(screen.getByTestId('group-loading')).toBeTruthy();
		expect(screen.getByText(/loading log groups/i)).toBeTruthy();
		expect(screen.queryAllByTestId('group-row')).toHaveLength(0);
	});

	it('shows the empty state with region and seed context', () => {
		render(LogGroupList, { props: { groups: [], region: 'eu-west-1' } });

		const empty = screen.getByTestId('group-empty');
		expect(empty.textContent).toContain('eu-west-1');
		expect(empty.textContent).toContain('pnpm seed');
	});

	it('shows the API error message', () => {
		render(LogGroupList, {
			props: {
				region: 'us-east-1',
				error: 'Could not list log groups in us-east-1: Access denied.',
			},
		});

		expect(screen.getByRole('alert').textContent).toContain('Access denied');
		expect(screen.queryAllByTestId('group-row')).toHaveLength(0);
	});

	it('renders the groups with their stored size', () => {
		render(LogGroupList, { props: { groups: GROUPS, region: 'us-east-1' } });

		expect(screen.getAllByTestId('group-row')).toHaveLength(2);
		expect(screen.getByText('2 KiB')).toBeTruthy();
		expect(screen.getByText('0 B')).toBeTruthy();
	});

	it('filters by search text, case-insensitively', async () => {
		render(LogGroupList, { props: { groups: GROUPS, region: 'us-east-1' } });

		await fireEvent.input(screen.getByLabelText('Search log groups'), {
			target: { value: 'CHECKOUT' },
		});

		expect(screen.getAllByTestId('group-row')).toHaveLength(1);
		expect(screen.queryByText('/aws/lambda/orders')).toBeNull();
	});

	it('shows a message when nothing matches the search', async () => {
		render(LogGroupList, { props: { groups: GROUPS, region: 'us-east-1' } });

		await fireEvent.input(screen.getByLabelText('Search log groups'), {
			target: { value: 'nothing' },
		});

		expect(screen.getByTestId('group-no-match').textContent).toContain('nothing');
	});

	it('calls the select handler with the group name on click', async () => {
		const onSelect = vi.fn<(name: string) => void>();
		render(LogGroupList, { props: { groups: GROUPS, region: 'us-east-1', onSelect } });

		await fireEvent.click(screen.getByText('/aws/lambda/orders'));

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith('/aws/lambda/orders');
	});

	it('calls the refresh handler on click', async () => {
		const onRefresh = vi.fn<() => void>();
		render(LogGroupList, { props: { groups: GROUPS, region: 'us-east-1', onRefresh } });

		await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it('renders at most maxRows rows and says so', () => {
		const many: LogGroupSummary[] = Array.from({ length: 8 }, (_value, index) => ({
			name: `/aws/lambda/app-${index}`,
		}));
		render(LogGroupList, { props: { groups: many, region: 'us-east-1', maxRows: 3 } });

		expect(screen.getAllByTestId('group-row')).toHaveLength(3);
		expect(screen.getByTestId('group-truncated').textContent).toContain('Showing first 3 of 8');
	});
});

const ARCHIVED: LogGroupSummary[] = [
	{
		name: '/aws/lambda/checkout',
		archivedEvents: 1234,
		archivedOldest: Date.UTC(2024, 0, 2, 3, 4, 5),
		archivedNewest: Date.UTC(2024, 0, 2, 4, 5, 6),
	},
	{ name: '/aws/lambda/orders' },
];

describe('LogGroupList archive view', () => {
	it('shows how much each group holds locally', () => {
		render(LogGroupList, { props: { groups: ARCHIVED, region: 'us-east-1', source: 'archive' } });

		// Only the group with archived events gets a badge.
		const badges = screen.getAllByTestId('group-archived-count');
		expect(badges).toHaveLength(1);
		expect(badges[0].textContent?.trim()).toBe('1,234 archived');
		expect(badges[0].getAttribute('title')).toBe(
			'2024-01-02T03:04:05.000Z \u2192 2024-01-02T04:05:06.000Z',
		);
		// The span needs room, so it lives next to the badge and is hidden when narrow.
		expect(screen.getByTestId('group-archived-span').textContent?.trim()).toBe(
			'2024-01-02T03:04:05.000Z \u2192 2024-01-02T04:05:06.000Z',
		);
		// It follows the list's width (a container query), not the window's: a wide window with the
		// default sidebar used to show it and squeeze the group name out of the row.
		const span = screen.getByTestId('group-archived-span');
		expect(span.className).toContain('hidden');
		expect(span.className).toContain('@2xl:inline');
		expect(span.className).not.toMatch(/(^|\s)xl:inline/);
		expect(span.closest('ul')?.className).toContain('@container');
		// The name can shrink, but never to nothing.
		const name = screen.getAllByTestId('group-row')[0].querySelector('.font-mono');
		expect(name?.className).toContain('min-w-16');
		expect(screen.getByTestId('group-source-badge').textContent?.trim()).toBe('local');
	});

	it('keeps the CloudWatch list free of archive badges', () => {
		render(LogGroupList, { props: { groups: ARCHIVED, region: 'us-east-1' } });

		expect(screen.queryAllByTestId('group-archived-count')).toHaveLength(0);
		expect(screen.queryByTestId('group-source-badge')).toBeNull();
		expect(screen.queryByTestId('group-archived-span')).toBeNull();
		// The header lives on the panel now; the list still reports its own totals.
		expect(screen.getByTestId('group-count').textContent).toContain('2');
	});

	it('shows a hint instead of an error when the archive is empty', () => {
		render(LogGroupList, { props: { groups: [], region: 'eu-west-1', source: 'archive' } });

		const empty = screen.getByTestId('group-empty');
		expect(empty.textContent).toContain('Nothing archived for eu-west-1 yet');
		expect(empty.textContent).toContain('stream a group from CloudWatch once');
		expect(screen.queryByTestId('group-error')).toBeNull();
		expect(empty.className).not.toContain('red');
	});
});

describe('LogGroupList multi-select', () => {
	it('renders one checkbox per row, all unchecked when nothing is selected', () => {
		render(LogGroupList, { props: { groups: GROUPS, region: 'us-east-1', selected: [] } });

		const boxes = screen.getAllByTestId(/^group-check-/);
		expect(boxes).toHaveLength(2);
		expect(boxes.every((box) => (box as HTMLInputElement).checked === false)).toBe(true);
		// Each checkbox carries an accessible name for its group.
		expect(
			(screen.getByLabelText('Include /aws/lambda/checkout in the selection') as HTMLInputElement)
				.checked,
		).toBe(false);
		expect(screen.queryByTestId('selected-count')).toBeNull();
	});

	it('clicking a row selects only that group and does not toggle', async () => {
		const onSelect = vi.fn<(name: string) => void>();
		const onToggle = vi.fn<(name: string) => void>();
		render(LogGroupList, {
			props: { groups: GROUPS, region: 'us-east-1', selected: [], onSelect, onToggle },
		});

		await fireEvent.click(screen.getByText('/aws/lambda/orders'));

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith('/aws/lambda/orders');
		expect(onToggle).not.toHaveBeenCalled();
	});

	it('clicking a checkbox toggles that group and does not select the row', async () => {
		const onSelect = vi.fn<(name: string) => void>();
		const onToggle = vi.fn<(name: string) => void>();
		render(LogGroupList, {
			props: { groups: GROUPS, region: 'us-east-1', selected: [], onSelect, onToggle },
		});

		await fireEvent.click(screen.getByTestId('group-check-/aws/lambda/orders'));

		expect(onToggle).toHaveBeenCalledTimes(1);
		expect(onToggle).toHaveBeenCalledWith('/aws/lambda/orders');
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('highlights every selected group and reports how many are selected', () => {
		render(LogGroupList, {
			props: {
				groups: GROUPS,
				region: 'us-east-1',
				selected: ['/aws/lambda/checkout', '/aws/lambda/orders'],
			},
		});

		const rows = screen.getAllByTestId('group-row');
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.className).toContain('border-sky-800');
			expect(row.getAttribute('aria-current')).toBe('true');
		}
		expect(
			(screen.getByTestId('group-check-/aws/lambda/checkout') as HTMLInputElement).checked,
		).toBe(true);
		expect((screen.getByTestId('group-check-/aws/lambda/orders') as HTMLInputElement).checked).toBe(
			true,
		);
		expect(screen.getByTestId('selected-count').textContent?.trim()).toBe('2 selected');
	});

	it('leaves unselected rows unhighlighted in a multi-selection', () => {
		render(LogGroupList, {
			props: { groups: GROUPS, region: 'us-east-1', selected: ['/aws/lambda/orders'] },
		});

		const rows = screen.getAllByTestId('group-row');
		expect(rows[0].className).not.toContain('border-sky-800');
		expect(rows[0].getAttribute('aria-current')).toBeNull();
		expect(rows[1].className).toContain('border-sky-800');
		// A single selection keeps the header unchanged.
		expect(screen.queryByTestId('selected-count')).toBeNull();
	});

	it('keeps the archived count pill with checkboxes present', () => {
		render(LogGroupList, { props: { groups: ARCHIVED, region: 'us-east-1', source: 'archive' } });

		expect(screen.getAllByTestId('group-archived-count')).toHaveLength(1);
		expect(screen.getAllByTestId(/^group-check-/)).toHaveLength(2);
	});

	it('keeps the archive empty state', () => {
		render(LogGroupList, { props: { groups: [], region: 'eu-west-1', source: 'archive' } });

		expect(screen.getByTestId('group-empty').textContent).toContain(
			'Nothing archived for eu-west-1 yet',
		);
		expect(screen.queryAllByTestId(/^group-check-/)).toHaveLength(0);
	});
});
