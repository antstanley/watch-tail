import { describe, expect, test } from 'vitest';
import {
	DEFAULT_ARCHIVE_MAX_EVENTS,
	DEFAULT_ARCHIVE_PAGE_SIZE,
	MAX_ARCHIVE_PAGE_SIZE,
	archiveUnavailableMessage,
	tailArchivedEvents,
	type ArchivePageSource,
} from './archive-tail';
import type { ArchivePageRequest } from './archive-sql';
import type { LogEventDto } from '$lib/types';
import type { TailBatch } from './tail';

const TS = Date.UTC(2024, 4, 17, 12, 0, 0);

function event(index: number): LogEventDto {
	return { id: `evt-${index}`, timestamp: TS + index, message: `line ${index}` };
}

/** Archive double that serves `rows` in pages of the requested size. */
function fakeArchive(
	rows: LogEventDto[],
	options: { available?: boolean; error?: string | null } = {},
) {
	const requests: ArchivePageRequest[] = [];
	const archive: ArchivePageSource = {
		available: options.available ?? true,
		error: options.error ?? null,
		async page(request) {
			requests.push(request);
			let start = 0;
			if (request.after !== null) {
				const index = rows.findIndex((row) => row.timestamp === request.after?.timestamp);
				start = index < 0 ? rows.length : index + 1;
			}
			const page = rows.slice(start, start + request.limit);
			const last =
				page.length === 0
					? null
					: { timestamp: page[page.length - 1]!.timestamp, seq: start + page.length };
			return { events: page, last };
		},
	};
	return { archive, requests };
}

async function collect(generator: AsyncGenerator<TailBatch, void, void>): Promise<TailBatch[]> {
	const batches: TailBatch[] = [];
	for await (const batch of generator) batches.push(batch);
	return batches;
}

function tailOptions(archive: ArchivePageSource, overrides: Record<string, unknown> = {}) {
	return {
		archive,
		region: 'af-south-1',
		logGroups: ['/aws/lambda/api'],
		startTime: TS,
		endTime: TS + 1000,
		...overrides,
	};
}

describe('archiveUnavailableMessage', () => {
	test('includes the driver failure', () => {
		expect(
			archiveUnavailableMessage({
				available: false,
				error: 'Cannot find module',
				page: async () => ({ events: [], last: null }),
			}),
		).toBe('The local archive is not available on this machine: Cannot find module');
	});

	test('stays short without a reason', () => {
		expect(
			archiveUnavailableMessage({
				available: false,
				error: null,
				page: async () => ({ events: [], last: null }),
			}),
		).toBe('The local archive is not available on this machine');
	});
});

describe('tailArchivedEvents', () => {
	test('reports one error batch when the archive is unavailable', async () => {
		const batches = await collect(
			tailArchivedEvents(
				tailOptions(fakeArchive([], { available: false, error: 'no duckdb' }).archive),
			),
		);
		expect(batches).toEqual([
			{
				type: 'error',
				message: 'The local archive is not available on this machine: no duckdb',
				code: 'archive-unavailable',
			},
		]);
	});

	test('emits events then window-complete for a single page', async () => {
		const { archive } = fakeArchive([event(0), event(1)]);
		const batches = await collect(tailArchivedEvents(tailOptions(archive)));
		expect(batches).toEqual([
			{ type: 'events', events: [event(0), event(1)], origin: 'archive' },
			{ type: 'end', reason: 'window-complete' },
		]);
	});

	test('reports a failed read instead of calling the window complete', async () => {
		const { archive } = fakeArchive([]);
		archive.page = async () => ({ events: [], last: null, error: 'IO Error' });
		expect(await collect(tailArchivedEvents(tailOptions(archive)))).toEqual([
			{
				type: 'error',
				message: 'The local archive could not be read: IO Error',
				code: 'archive-read-failed',
			},
		]);
	});

	test('ends with window-complete on an empty window', async () => {
		const { archive } = fakeArchive([]);
		expect(await collect(tailArchivedEvents(tailOptions(archive)))).toEqual([
			{ type: 'end', reason: 'window-complete' },
		]);
	});

	test('pages until the window is exhausted', async () => {
		const rows = Array.from({ length: 5 }, (_, index) => event(index));
		const { archive, requests } = fakeArchive(rows);
		const batches = await collect(tailArchivedEvents(tailOptions(archive, { pageSize: 2 })));
		expect(batches.filter((batch) => batch.type === 'events')).toHaveLength(3);
		expect(requests.map((request) => request.limit)).toEqual([2, 2, 2]);
		expect(requests[0]?.after).toBeNull();
		expect(requests[1]?.after).toEqual({ timestamp: TS + 1, seq: 2 });
		expect(batches.at(-1)).toEqual({ type: 'end', reason: 'window-complete' });
	});

	test('stops at the event limit', async () => {
		const rows = Array.from({ length: 10 }, (_, index) => event(index));
		const { archive } = fakeArchive(rows);
		const batches = await collect(
			tailArchivedEvents(tailOptions(archive, { pageSize: 2, maxEvents: 4 })),
		);
		expect(batches.at(-1)).toEqual({ type: 'end', reason: 'event-limit' });
		expect(batches.filter((batch) => batch.type === 'events')).toHaveLength(2);
	});

	test('clamps the page size to the supported range', async () => {
		const { archive, requests } = fakeArchive([event(0)]);
		await collect(tailArchivedEvents(tailOptions(archive, { pageSize: 10_000_000 })));
		expect(requests[0]?.limit).toBe(MAX_ARCHIVE_PAGE_SIZE);
		const tiny = fakeArchive([event(0)]);
		await collect(tailArchivedEvents(tailOptions(tiny.archive, { pageSize: 0 })));
		expect(tiny.requests[0]?.limit).toBe(1);
		expect(DEFAULT_ARCHIVE_PAGE_SIZE).toBeLessThanOrEqual(MAX_ARCHIVE_PAGE_SIZE);
		expect(DEFAULT_ARCHIVE_MAX_EVENTS).toBeGreaterThan(DEFAULT_ARCHIVE_PAGE_SIZE);
	});

	test('passes the level filter through', async () => {
		const { archive, requests } = fakeArchive([]);
		await collect(tailArchivedEvents(tailOptions(archive, { levels: ['error', 'warn'] })));
		expect(requests[0]).toMatchObject({ levels: ['error', 'warn'] });

		const unfiltered = fakeArchive([]);
		await collect(tailArchivedEvents(tailOptions(unfiltered.archive)));
		expect(unfiltered.requests[0]?.levels).toBeNull();
	});

	test('passes the window, search and stream prefix through', async () => {
		const { archive, requests } = fakeArchive([]);
		await collect(
			tailArchivedEvents(
				tailOptions(archive, { search: 'boom', streamPrefix: 'worker', endTime: TS + 5 }),
			),
		);
		expect(requests[0]).toMatchObject({
			region: 'af-south-1',
			logGroups: ['/aws/lambda/api'],
			startTime: TS,
			endTime: TS + 5,
			search: 'boom',
			streamPrefix: 'worker',
		});
	});

	test('stops without an end batch when the client aborts', async () => {
		const controller = new AbortController();
		const { archive } = fakeArchive([event(0)]);
		controller.abort();
		const batches = await collect(
			tailArchivedEvents(tailOptions(archive, { signal: controller.signal, pageSize: 1 })),
		);
		expect(batches).toEqual([]);
	});

	test('keeps yielding while the archive grows', async () => {
		// A second page is served only because the first page filled up: the
		// generator must ask again instead of stopping at the first short read.
		const rows = Array.from({ length: 4 }, (_, index) => event(index));
		const { archive, requests } = fakeArchive(rows);
		const batches = await collect(tailArchivedEvents(tailOptions(archive, { pageSize: 2 })));
		expect(requests).toHaveLength(3);
		expect(
			batches.filter((batch) => batch.type === 'events').flatMap((batch) => batch.events),
		).toHaveLength(4);
	});
});
