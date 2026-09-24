import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CloudWatchLogsClient, FilteredLogEvent } from '@aws-sdk/client-cloudwatch-logs';
import type { RequestEvent } from '@sveltejs/kit';
import type * as AwsServer from '$lib/server/aws';
import { REGION_PARAM_HINT } from '$lib/server/aws';
import { GET } from './+server';

type FakeSend = (command: unknown, options?: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
	send: vi.fn<FakeSend>(),
	region: vi.fn<() => Promise<string>>(),
	destroy: vi.fn<() => void>(),
	failCreate: { current: false },
}));
const envState = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));

vi.mock('$lib/server/env', () => ({ readEnv: () => envState.current }));
vi.mock('$lib/server/aws', async (importOriginal) => {
	const actual = await importOriginal<typeof AwsServer>();
	return {
		...actual,
		createLogsClient: () => {
			if (mocks.failCreate.current) throw new Error('Region is missing');
			return {
				send: mocks.send,
				config: { region: mocks.region },
				destroy: mocks.destroy,
			} as unknown as CloudWatchLogsClient;
		},
	};
});

/** Archive double: the route must never touch a real DuckDB file from a test. */
const archiveState = {
	selections: [] as unknown[],
	available: true,
	error: null as string | null,
	pages: [] as { events: unknown[]; last: { timestamp: number; seq: number } | null }[],
	requests: [] as Record<string, unknown>[],
	records: [] as { region: string; group: string; events: unknown[] }[],
	/** Coverage the archive already holds, keyed by log group. */
	coverage: new Map<string, { start: number; end: number }[]>(),
	coverageQueries: [] as { region: string; groups: string[]; start: number; end: number }[],
	recordedCoverage: [] as {
		region: string;
		entries: { logGroup: string; start: number; end: number }[];
	}[],
};

function resetArchive(): void {
	archiveState.available = true;
	archiveState.selections = [];
	archiveState.error = null;
	archiveState.pages = [];
	archiveState.requests = [];
	archiveState.records = [];
	archiveState.coverage = new Map();
	archiveState.coverageQueries = [];
	archiveState.recordedCoverage = [];
}

vi.mock('$lib/server/archive', () => ({
	getArchive: async (_env: unknown, selection: unknown) => {
		archiveState.selections.push(selection);
		return {
			path: '/tmp/watch-tail-test/archive.duckdb',
			available: archiveState.available,
			error: archiveState.error,
			async page(request: Record<string, unknown>) {
				archiveState.requests.push(request);
				return archiveState.pages.shift() ?? { events: [], last: null };
			},
			async record(region: string, group: string, events: unknown[]) {
				archiveState.records.push({ region, group, events });
				return events.length;
			},
			async coverage(region: string, groups: string[], start: number, end: number) {
				archiveState.coverageQueries.push({ region, groups: [...groups], start, end });
				const found = new Map<string, { start: number; end: number }[]>();
				for (const group of groups) {
					const intervals = archiveState.coverage.get(group);
					if (intervals !== undefined) found.set(group, intervals);
				}
				return found;
			},
			async recordCoverage(
				region: string,
				entries: { logGroup: string; start: number; end: number }[],
			) {
				archiveState.recordedCoverage.push({
					region,
					entries: entries.map((entry) => ({ ...entry })),
				});
			},
		};
	},
}));

type Frame = { event: string; data: unknown };
type PollResult = { events: FilteredLogEvent[] } | Error;

/** Builds a CloudWatch event for a poll result. */
function event(id: string, timestamp: number, message = 'line'): FilteredLogEvent {
	return {
		eventId: id,
		timestamp,
		message,
		logStreamName: `stream-${id}`,
		ingestionTime: timestamp + 1,
	};
}

/** Queues the responses the fake client returns in order. */
function queueSend(results: PollResult[]): void {
	let index = 0;
	mocks.send.mockImplementation(async () => {
		const result = results[index] ?? { events: [] };
		index += 1;
		if (result instanceof Error) throw result;
		return result;
	});
}

/** Builds a minimal RequestEvent for the SSE handler. */
function requestEvent(params: Record<string, string>, signal?: AbortSignal): RequestEvent {
	const url = new URL('http://localhost/api/stream');
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	const request = new Request(url, signal === undefined ? undefined : { signal });
	return { url, request } as unknown as RequestEvent;
}

/** Parses one SSE block into a frame. */
function parseBlock(block: string): Frame[] {
	const lines = block.split('\n');
	const eventLine = lines.find((line) => line.startsWith('event: '));
	const dataLine = lines.find((line) => line.startsWith('data: '));
	if (eventLine === undefined || dataLine === undefined) return [];
	return [{ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) }];
}

type Reader = { frames: Frame[]; done: Promise<void>; cancel: () => Promise<void> };

/** Reads the SSE body in the background and collects the parsed frames. */
function startReading(response: Response): Reader {
	const body = response.body;
	if (body === null) throw new Error('the response has no body');
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const frames: Frame[] = [];
	const done = (async () => {
		let buffer = '';
		for (;;) {
			const { value, done: finished } = await reader.read();
			if (finished) break;
			buffer += decoder.decode(value, { stream: true });
			const blocks = buffer.split('\n\n');
			buffer = blocks.pop() ?? '';
			for (const block of blocks) frames.push(...parseBlock(block));
		}
	})();
	return { frames, done, cancel: () => reader.cancel() };
}

/** Waits for a predicate on real timers; used instead of sleeping blindly. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('condition timed out');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Rejects when a promise does not settle in time. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		}),
	]);
}

/** Starts a stream, waits for its first frames and aborts the client. */
async function readReady(
	params: Record<string, string>,
): Promise<{ frames: Frame[]; send: typeof mocks.send }> {
	const controller = new AbortController();
	const response = await GET(requestEvent(params, controller.signal));
	expect(response.status).toBe(200);
	const reader = startReading(response);
	await withTimeout(
		waitFor(() => reader.frames.length > 0),
		2000,
		'ready frame',
	);
	controller.abort();
	await withTimeout(reader.done, 2000, 'stream end');
	return { frames: reader.frames, send: mocks.send };
}

describe('GET /api/stream', () => {
	beforeEach(() => {
		envState.current = { AWS_REGION: 'eu-west-1' };
		mocks.send.mockReset();
		mocks.region.mockReset();
		mocks.region.mockResolvedValue('us-west-1');
		mocks.destroy.mockReset();
		mocks.failCreate.current = false;
		resetArchive();
		queueSend([{ events: [] }]);
	});

	test.each([[''], ['?region=eu-west-1'], ['?group='], ['?group=%20%20']])(
		'returns 400 for %s',
		async (query) => {
			const url = new URL(`http://localhost/api/stream${query}`);
			const response = await GET({
				url,
				request: new Request(url),
			} as unknown as RequestEvent);
			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string; code?: string };
			expect(body.code).toBe('missing-group');
			expect(body.error).toContain('group');
			expect(mocks.send).not.toHaveBeenCalled();
		},
	);

	test('streams ready, log and end frames', async () => {
		queueSend([{ events: [event('e1', 1000, 'hello')] }]);
		const controller = new AbortController();
		const response = await GET(
			requestEvent({ group: '/aws/lambda/demo', region: 'us-west-2' }, controller.signal),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
		expect(response.headers.get('connection')).toBe('keep-alive');
		expect(response.headers.get('x-accel-buffering')).toBe('no');

		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.some((frame) => frame.event === 'log')),
			2000,
			'log frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');

		expect(reader.frames.map((frame) => frame.event)).toEqual(['ready', 'log', 'end']);
		expect(reader.frames[0].data).toEqual({
			region: 'us-west-2',
			logGroupName: '/aws/lambda/demo',
			groups: ['/aws/lambda/demo'],
			endpoint: null,
			source: 'cloudwatch',
			startTime: expect.any(Number),
			endTime: null,
			mode: 'live',
			preset: null,
			clamped: false,
		});
		expect(reader.frames[1].data).toEqual({
			events: [
				{
					id: 'e1',
					timestamp: 1000,
					message: 'hello',
					streamName: 'stream-e1',
					ingestionTime: 1001,
					// Every CloudWatch event is tagged with its group, so a merged
					// multi-group stream can label lines and archive them correctly.
					group: '/aws/lambda/demo',
					// A live event carries no level of its own: the server detected none.
					level: null,
					// Nor a request id: nothing in "hello" looks like one.
					requestId: null,
				},
			],
		});
		expect(reader.frames[2].data).toEqual({ reason: 'client-disconnected' });

		const command = mocks.send.mock.calls[0][0] as {
			input: { logGroupName: string; limit: number };
		};
		expect(command.input.logGroupName).toBe('/aws/lambda/demo');
		expect(command.input.limit).toBe(1000);
		expect(mocks.destroy).toHaveBeenCalled();
	});

	test('uses the ambient region when none is supplied', async () => {
		envState.current = {};
		const { frames } = await readReady({ group: 'demo' });
		expect((frames[0].data as { region: string }).region).toBe('us-west-1');
	});

	test('accepts an explicit region parameter', async () => {
		const { frames } = await readReady({ group: 'demo', region: 'us-west-2' });
		expect((frames[0].data as { region: string }).region).toBe('us-west-2');
		expect(mocks.region).not.toHaveBeenCalled();
	});

	test('returns 400 for a malformed region', async () => {
		const url = new URL('http://localhost/api/stream?group=demo&region=US-EAST-1');
		const response = await GET({
			url,
			request: new Request(url),
		} as unknown as RequestEvent);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: REGION_PARAM_HINT, code: 'invalid-region' });
		expect(mocks.send).not.toHaveBeenCalled();
	});

	test('returns 502 with missing-region when no client can be created', async () => {
		mocks.failCreate.current = true;
		const response = await GET(requestEvent({ group: 'demo' }));
		expect(response.status).toBe(502);
		const body = (await response.json()) as { code?: string; error: string };
		expect(body.code).toBe('missing-region');
		expect(body.error).toContain('No AWS region is configured');
	});

	test('reports a missing region from the tailer as an error frame', async () => {
		mocks.send.mockImplementation(async () => {
			throw new Error('Region is missing');
		});
		const controller = new AbortController();
		const response = await GET(requestEvent({ group: 'demo', poll: '250' }, controller.signal));
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.some((frame) => frame.event === 'error')),
			2000,
			'error frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');
		const error = reader.frames.find((frame) => frame.event === 'error');
		expect(error?.data).toEqual({
			message: 'No AWS region is configured. Set AWS_REGION or add a region to your AWS profile.',
			code: 'missing-region',
		});
	});

	test('reports the local endpoint in the ready frame', async () => {
		envState.current = {
			AWS_DEFAULT_REGION: 'us-east-1',
			AWS_ENDPOINT_URL: 'http://localhost:4566',
		};
		const { frames } = await readReady({ group: 'demo' });
		expect(frames[0]).toEqual({
			event: 'ready',
			data: {
				region: 'us-east-1',
				logGroupName: 'demo',
				groups: ['demo'],
				endpoint: 'http://localhost:4566',
				source: 'cloudwatch',
				startTime: expect.any(Number),
				endTime: null,
				mode: 'live',
				preset: null,
				clamped: false,
			},
		});
	});

	test('honours an explicit startTime', async () => {
		const startTime = Date.now() - 60_000;
		const { frames, send } = await readReady({ group: 'demo', startTime: String(startTime) });
		expect(frames[0].data).toEqual({
			region: 'eu-west-1',
			logGroupName: 'demo',
			groups: ['demo'],
			endpoint: null,
			source: 'cloudwatch',
			startTime,
			endTime: null,
			mode: 'live',
			preset: null,
			clamped: false,
		});
		const command = send.mock.calls[0][0] as { input: { startTime: number } };
		expect(command.input.startTime).toBe(startTime);
	});

	test('falls back to the lookback window and clamps a bad poll interval', async () => {
		const before = Date.now();
		const { frames, send } = await readReady({ group: 'demo', lookback: '2h', poll: 'nonsense' });
		const after = Date.now();
		const startTime = (frames[0].data as { startTime: number }).startTime;
		expect(startTime).toBeGreaterThanOrEqual(before - 2 * 60 * 60 * 1000 - 1000);
		expect(startTime).toBeLessThanOrEqual(after - 2 * 60 * 60 * 1000 + 1000);
		const command = send.mock.calls[0][0] as { input: { startTime: number } };
		expect(command.input.startTime).toBe(startTime);
	});

	test('forwards the filter pattern', async () => {
		const { send } = await readReady({ group: 'demo', filterPattern: '?ERROR ?WARN' });
		const command = send.mock.calls[0][0] as { input: { filterPattern?: string } };
		expect(command.input.filterPattern).toBe('?ERROR ?WARN');
	});

	test('sends an error frame when CloudWatch Logs fails', async () => {
		mocks.send.mockImplementation(async () => {
			throw new Error('connect ECONNREFUSED 127.0.0.1:4566');
		});
		const controller = new AbortController();
		const response = await GET(requestEvent({ group: 'demo', poll: '250' }, controller.signal));
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.some((frame) => frame.event === 'error')),
			2000,
			'error frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');
		const error = reader.frames.find((frame) => frame.event === 'error');
		expect(error?.data).toEqual({ message: expect.any(String), code: 'unreachable' });
		expect(reader.frames.at(-1)).toEqual({ event: 'end', data: { reason: 'client-disconnected' } });
	});

	test('closes the stream when the client cancels the body', async () => {
		const response = await GET(requestEvent({ group: 'demo' }));
		const reader = startReading(response);
		await withTimeout(reader.cancel(), 2000, 'cancel');
		await withTimeout(reader.done, 2000, 'stream end');
		expect(mocks.destroy).toHaveBeenCalled();
		expect(reader.frames.every((frame) => frame.event === 'ready')).toBe(true);
	});

	test('pings after 15 s of silence', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const controller = new AbortController();
			const response = await GET(requestEvent({ group: 'demo', poll: '250' }, controller.signal));
			const reader = startReading(response);
			await vi.advanceTimersByTimeAsync(16_000);
			expect(reader.frames.map((frame) => frame.event)).toContain('ping');
			const ping = reader.frames.find((frame) => frame.event === 'ping');
			expect(ping?.data).toEqual({ at: expect.any(Number) });
			controller.abort();
			await vi.advanceTimersByTimeAsync(1000);
			await reader.done;
			expect(reader.frames.at(-1)).toEqual({
				event: 'end',
				data: { reason: 'client-disconnected' },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	test('ends with repeated-errors after too many failures', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			mocks.send.mockImplementation(async () => {
				throw new Error('connect ECONNREFUSED 127.0.0.1:4566');
			});
			const response = await GET(requestEvent({ group: 'demo', poll: '250' }));
			const reader = startReading(response);
			// Bounded steps of fake time until the tailer gives up and the stream ends.
			for (let step = 0; step < 400 && reader.frames.at(-1)?.event !== 'end'; step += 1) {
				await vi.advanceTimersByTimeAsync(1000);
			}
			await reader.done;
			const errorFrames = reader.frames.filter((frame) => frame.event === 'error');
			expect(errorFrames).toHaveLength(8);
			expect(reader.frames.at(-1)).toEqual({
				event: 'end',
				data: { reason: 'repeated-errors' },
			});
			expect(mocks.send).toHaveBeenCalledTimes(8);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('historic windows', () => {
	/** Reads a historic stream until its `end` frame, then cancels the body. */
	async function readHistoricUntilEnd(params: Record<string, string>): Promise<Frame[]> {
		const controller = new AbortController();
		const response = await GET(requestEvent(params, controller.signal));
		expect(response.status).toBe(200);
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.some((frame) => frame.event === 'end')),
			3000,
			'end frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');
		return reader.frames;
	}

	/** Reads the ready frame for a historic request. */
	async function readHistoric(params: Record<string, string>): Promise<{
		ready: StreamReady;
		frames: Frame[];
	}> {
		const controller = new AbortController();
		const response = await GET(requestEvent(params, controller.signal));
		if (response.status !== 200) {
			throw new Error(`expected 200, got ${response.status}: ${await response.text()}`);
		}
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.length > 0),
			2000,
			'ready frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');
		return { ready: reader.frames[0].data as StreamReady, frames: reader.frames };
	}

	type StreamReady = {
		mode: string;
		startTime: number;
		endTime: number | null;
		preset: string | null;
		clamped: boolean;
	};

	test('reports the preset window in the ready frame and asks CloudWatch for it', async () => {
		queueSend([{ events: [] }]);
		const { ready } = await readHistoric({
			group: '/aws/lambda/demo',
			mode: 'historic',
			range: '24h',
		});

		expect(ready.mode).toBe('historic');
		expect(ready.preset).toBe('24h');
		expect(ready.endTime).not.toBeNull();
		expect((ready.endTime ?? 0) - ready.startTime).toBe(24 * 60 * 60 * 1000);

		// Other streams can still be polling, so find the command for this window.
		const command = mocks.send.mock.calls
			.map((call) => call[0] as { input: { startTime?: number; endTime?: number } })
			.find((candidate) => candidate.input.endTime === ready.endTime);
		expect(command?.input.startTime).toBe(ready.startTime);
	});

	test('accepts a custom from/to window', async () => {
		queueSend([{ events: [] }]);
		const to = Date.now() - 60 * 60 * 1000;
		const from = to - 90 * 60 * 1000;
		const { ready } = await readHistoric({
			group: '/aws/lambda/demo',
			mode: 'historic',
			from: String(from),
			to: String(to),
		});

		expect(ready.mode).toBe('historic');
		expect(ready.preset).toBeNull();
		expect(ready.startTime).toBe(from);
		expect(ready.endTime).toBe(to);
		expect(ready.clamped).toBe(false);
	});

	test('flags a clamped window', async () => {
		queueSend([{ events: [] }]);
		const { ready } = await readHistoric({
			group: '/aws/lambda/demo',
			mode: 'historic',
			from: String(Date.now() - 40 * 24 * 60 * 60 * 1000),
			to: String(Date.now()),
		});

		expect(ready.clamped).toBe(true);
		expect(ready.endTime).not.toBeNull();
		expect(ready.startTime).toBeGreaterThanOrEqual((ready.endTime ?? 0) - 14 * 24 * 60 * 60 * 1000);
	});

	test('ends with the tailer reason once a window is exhausted', async () => {
		queueSend([{ events: [event('e1', 1000, 'historic line')] }]);
		const frames = await readHistoricUntilEnd({
			group: '/aws/lambda/demo',
			mode: 'historic',
			range: '15m',
		});

		expect(frames.map((frame) => frame.event)).toEqual(['ready', 'log', 'end']);
		expect(frames.at(-1)?.data).toEqual({ reason: 'window-complete' });
	});

	test.each([
		['window', { range: '15m' }, 'invalid-mode'],
		['historic', { range: '5days' }, 'invalid-range'],
		['historic', { from: 'nope', to: 'nope' }, 'invalid-time'],
		['historic', { from: '1h' }, 'invalid-window'],
		['historic', { from: '1000', to: '999' }, 'invalid-window'],
	])('returns 400 for mode=%s %o', async (mode, params, code) => {
		const url = new URL('http://localhost/api/stream');
		url.searchParams.set('group', 'demo');
		url.searchParams.set('mode', mode);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

		const response = await GET({ url, request: new Request(url) } as unknown as RequestEvent);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; code?: string };
		expect(body.code).toBe(code);
		expect(body.error.length).toBeGreaterThan(0);
		expect(body.error).not.toContain('    at '); // never a stack trace
	});

	test('keeps live mode infinite even with a lookback', async () => {
		queueSend([{ events: [] }]);
		const { ready } = await readHistoric({ group: '/aws/lambda/demo', lookback: '30m' });
		expect(ready.mode).toBe('live');
		expect(ready.endTime).toBeNull();
	});

	test('an absent mode means live, so from/to are ignored', async () => {
		// The UI and the MCP server both send `mode=historic` for a bounded
		// window; this pins the default so a caller that forgets it gets an
		// endless live tail (which is what the MCP server used to do).
		queueSend([{ events: [] }]);
		const { ready } = await readHistoric({
			group: '/aws/lambda/demo',
			from: '1000',
			to: '2000',
		});
		expect(ready.mode).toBe('live');
		expect(ready.endTime).toBeNull();
	});
});

describe('GET /api/stream source=archive', () => {
	beforeEach(() => {
		envState.current = { AWS_REGION: 'eu-west-1' };
		mocks.send.mockReset();
		resetArchive();
		queueSend([{ events: [] }]);
	});

	test('replays archived events and never calls CloudWatch', async () => {
		archiveState.pages = [
			{
				events: [{ id: 'a1', timestamp: 1000, message: 'from the archive' }],
				last: { timestamp: 1000, seq: 1 },
			},
		];
		const controller = new AbortController();
		const response = await GET(
			requestEvent(
				{ group: '/aws/lambda/demo', region: 'af-south-1', source: 'archive' },
				controller.signal,
			),
		);
		expect(response.status).toBe(200);
		const reader = startReading(response);
		await withTimeout(reader.done, 2000, 'archive stream end');

		expect(mocks.send).not.toHaveBeenCalled();
		expect(reader.frames.map((frame) => frame.event)).toEqual(['ready', 'log', 'end']);
		expect(reader.frames[0]?.data).toMatchObject({
			source: 'archive',
			region: 'af-south-1',
			logGroupName: '/aws/lambda/demo',
			groups: ['/aws/lambda/demo'],
			endpoint: null,
			mode: 'historic',
		});
		// Every streamed event carries both detected fields: `level: null` means the
		// line had no level and `requestId: null` that it names no request.
		expect(reader.frames[1]?.data).toEqual({
			events: [
				{ id: 'a1', timestamp: 1000, message: 'from the archive', level: null, requestId: null },
			],
		});
		expect(reader.frames[2]?.data).toEqual({ reason: 'window-complete' });
		// Reading the archive must not write to it.
		expect(archiveState.records).toEqual([]);
	});

	test('defaults to historic and passes the window and the search term', async () => {
		const controller = new AbortController();
		const response = await GET(
			requestEvent(
				{
					group: '/aws/lambda/demo',
					region: 'af-south-1',
					source: 'archive',
					range: '1h',
					search: 'boom',
				},
				controller.signal,
			),
		);
		const reader = startReading(response);
		await withTimeout(reader.done, 2000, 'archive stream end');

		const request = archiveState.requests[0] as {
			region: string;
			logGroups: string[];
			search: string | null;
		};
		expect(request.region).toBe('af-south-1');
		expect(request.logGroups).toEqual(['/aws/lambda/demo']);
		expect(request.search).toBe('boom');
		expect(reader.frames[0]?.data).toMatchObject({ preset: '1h' });
	});

	test('refuses a live request against the archive', async () => {
		const response = await GET(
			requestEvent({
				group: '/aws/lambda/demo',
				region: 'af-south-1',
				source: 'archive',
				mode: 'live',
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: 'invalid-mode' });
		expect(archiveState.requests).toEqual([]);
	});

	test('requires a region, because archived rows are stored per region', async () => {
		envState.current = {};
		const response = await GET(requestEvent({ group: '/aws/lambda/demo', source: 'archive' }));
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: 'missing-region-param' });
	});

	test('rejects an unknown source', async () => {
		const response = await GET(requestEvent({ group: '/aws/lambda/demo', source: 'duckdb' }));
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: 'invalid-source' });
	});

	test('reports an unavailable archive as a stream error', async () => {
		archiveState.available = false;
		archiveState.error = 'Cannot find module @duckdb/node-api';
		const controller = new AbortController();
		const response = await GET(
			requestEvent(
				{ group: '/aws/lambda/demo', region: 'af-south-1', source: 'archive' },
				controller.signal,
			),
		);
		const reader = startReading(response);
		await withTimeout(reader.done, 2000, 'archive stream end');

		expect(reader.frames.map((frame) => frame.event)).toEqual(['ready', 'error', 'end']);
		expect(reader.frames[1]?.data).toMatchObject({
			code: 'archive-unavailable',
			message: expect.stringContaining('@duckdb/node-api'),
		});
		expect(mocks.send).not.toHaveBeenCalled();
	});

	test('detects the level and the request id of live events before sending them', async () => {
		queueSend([
			{
				events: [
					event('e1', 1000, '{"level":"warn","msg":"slow upstream","requestId":"req-9f2c"}'),
					event('e2', 1001, 'ERROR upstream 503 RequestId: 1a2b3c4d'),
					event('e3', 1002, '\tat Handler.java:41'),
				],
			},
		]);
		const controller = new AbortController();
		const response = await GET(requestEvent({ group: '/aws/lambda/demo' }, controller.signal));
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.length > 1),
			2000,
			'log frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');

		const payload = reader.frames[1]?.data as {
			events: { id: string; level: string | null; requestId: string | null }[];
		};
		expect(payload.events.map((entry) => [entry.id, entry.level, entry.requestId])).toEqual([
			['e1', 'warn', 'req-9f2c'],
			['e2', 'error', '1a2b3c4d'],
			['e3', null, null],
		]);
		// The archive stores what the client was shown.
		const archived = archiveState.records[0]?.events as
			| { level?: string | null; requestId?: string | null }[]
			| undefined;
		expect(archived?.map((entry) => entry.level)).toEqual(['warn', 'error', null]);
		expect(archived?.map((entry) => entry.requestId)).toEqual(['req-9f2c', '1a2b3c4d', null]);
	});

	test('keeps what the archive stored when replaying it', async () => {
		archiveState.pages = [
			{
				events: [
					{
						id: 'a1',
						timestamp: 1000,
						message: 'ERROR looking, but stored as debug RequestId: 1a2b3c4d',
						level: 'debug',
						requestId: 'req-stored',
					},
					{
						id: 'a2',
						timestamp: 1001,
						message: '{"level":"warn","requestId":"req-from-message"}',
						level: 'warn',
					},
					{
						id: 'a3',
						timestamp: 1002,
						message: 'nothing stored, but RequestId: 1a2b3c4d here',
						level: null,
						requestId: null,
					},
				],
				last: { timestamp: 1002, seq: 3 },
			},
		];
		const controller = new AbortController();
		const response = await GET(
			requestEvent(
				{ group: '/aws/lambda/demo', region: 'af-south-1', source: 'archive' },
				controller.signal,
			),
		);
		const reader = startReading(response);
		await withTimeout(reader.done, 2000, 'archive stream end');

		const payload = reader.frames[1]?.data as {
			events: { id: string; level: string | null; requestId: string | null }[];
		};
		// A stored level and a stored request id are verdicts and are not re-guessed,
		// a missing request id is detected from the message, and a row written before
		// the column existed is detected here too.
		expect(payload.events.map((entry) => [entry.id, entry.level, entry.requestId])).toEqual([
			['a1', 'debug', 'req-stored'],
			['a2', 'warn', 'req-from-message'],
			['a3', null, null],
		]);
	});

	test('passes the level filter to the archive reader', async () => {
		const controller = new AbortController();
		const response = await GET(
			requestEvent(
				{ group: '/aws/lambda/demo', region: 'af-south-1', source: 'archive', level: 'error,warn' },
				controller.signal,
			),
		);
		const reader = startReading(response);
		await withTimeout(reader.done, 2000, 'archive stream end');
		expect(archiveState.requests[0]).toMatchObject({ levels: ['error', 'warn'] });
		expect(archiveState.selections).toEqual([{ region: 'af-south-1', readOnly: true }]);
	});

	test('rejects an unknown level, and rejects level on CloudWatch', async () => {
		const bad = await GET(
			requestEvent({
				group: '/aws/lambda/demo',
				source: 'archive',
				region: 'af-south-1',
				level: 'shouty',
			}),
		);
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ code: 'invalid-level' });

		const misplaced = await GET(requestEvent({ group: '/aws/lambda/demo', level: 'error' }));
		expect(misplaced.status).toBe(400);
		const body = (await misplaced.json()) as { code: string; error: string };
		expect(body.code).toBe('invalid-level');
		expect(body.error).toContain('filterPattern');
		expect(archiveState.requests).toEqual([]);
		expect(archiveState.records).toEqual([]);
	});

	test('treats a blank level as no filter', async () => {
		const controller = new AbortController();
		const response = await GET(
			requestEvent(
				{ group: '/aws/lambda/demo', region: 'af-south-1', source: 'archive', level: ' , ' },
				controller.signal,
			),
		);
		const reader = startReading(response);
		await withTimeout(reader.done, 2000, 'archive stream end');
		expect(archiveState.requests[0]).toMatchObject({ levels: null });
	});

	test('reads several archived groups in one pass', async () => {
		const controller = new AbortController();
		const response = await GET(
			requestEvent(
				{
					groups: '/aws/lambda/one,/aws/lambda/two',
					region: 'af-south-1',
					source: 'archive',
				},
				controller.signal,
			),
		);
		const reader = startReading(response);
		await withTimeout(reader.done, 2000, 'archive stream end');
		expect(archiveState.requests).toHaveLength(1);
		expect(archiveState.requests[0]).toMatchObject({
			logGroups: ['/aws/lambda/one', '/aws/lambda/two'],
		});
		expect(reader.frames[0]?.data).toMatchObject({
			groups: ['/aws/lambda/one', '/aws/lambda/two'],
			logGroupName: '/aws/lambda/one',
		});
	});

	test('refuses a selection that is too large, and reports the limit', async () => {
		const tooMany = Array.from({ length: 11 }, (_, index) => `/g${index}`).join(',');
		const response = await GET(
			requestEvent({ groups: tooMany, source: 'archive', region: 'af-south-1' }),
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { code: string; error: string };
		expect(body.code).toBe('too-many-groups');
		expect(body.error).toContain('10');
		expect(archiveState.requests).toEqual([]);
	});

	test('runs one CloudWatch tail per group and merges them', async () => {
		// Two groups, one event each: the merged stream must carry both, labelled
		// with their own group, and end once.
		const perGroup: Record<string, unknown[]> = {
			'/aws/lambda/one': [{ events: [event('n1', 1000, 'first group')] }],
			'/aws/lambda/two': [{ events: [event('n2', 1001, 'second group')] }],
		};
		const seen: string[] = [];
		mocks.send.mockImplementation(async (command: unknown) => {
			const input = (command as { input: { logGroupName: string } }).input;
			seen.push(input.logGroupName);
			const queue = perGroup[input.logGroupName] ?? [];
			return queue.shift() ?? { events: [] };
		});

		const controller = new AbortController();
		const response = await GET(
			requestEvent(
				{
					groups: '/aws/lambda/one,/aws/lambda/two',
					region: 'af-south-1',
					mode: 'historic',
					range: '15m',
				},
				controller.signal,
			),
		);
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.filter((frame) => frame.event === 'log').length >= 2),
			4000,
			'merged log frames',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');

		const events = reader.frames
			.filter((frame) => frame.event === 'log')
			.flatMap((frame) => (frame.data as { events: { message: string; group?: string }[] }).events);
		expect(events.map((entry) => entry.message).toSorted()).toEqual([
			'first group',
			'second group',
		]);
		expect(events.map((entry) => entry.group).toSorted()).toEqual([
			'/aws/lambda/one',
			'/aws/lambda/two',
		]);
		// Both groups were polled (each repeatedly, until its window ends), and the
		// ready frame names both.
		expect([...new Set(seen)].toSorted()).toEqual(['/aws/lambda/one', '/aws/lambda/two']);
		expect(reader.frames[0]?.data).toMatchObject({
			groups: ['/aws/lambda/one', '/aws/lambda/two'],
			logGroupName: '/aws/lambda/one',
		});
		// Every event is archived under its own group.
		const recorded = archiveState.records.map((record) => record.group).toSorted();
		expect(recorded).toEqual(['/aws/lambda/one', '/aws/lambda/two']);
	});

	test('archives every batch of a CloudWatch stream', async () => {
		queueSend([{ events: [event('e1', 1000, 'first'), event('e2', 1001, 'second')] }]);
		const controller = new AbortController();
		const response = await GET(
			requestEvent({ group: '/aws/lambda/demo', region: 'af-south-1' }, controller.signal),
		);
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => archiveState.records.length > 0),
			2000,
			'archive write',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');

		expect(archiveState.records).toHaveLength(1);
		expect(archiveState.selections).toEqual([{ region: 'af-south-1' }]);
		expect(archiveState.records[0]?.region).toBe('af-south-1');
		expect(archiveState.records[0]?.group).toBe('/aws/lambda/demo');
		expect(archiveState.records[0]?.events).toHaveLength(2);
		expect(archiveState.requests).toEqual([]);
	});

	test('passes pageSize and max through to the archive reader', async () => {
		const controller = new AbortController();
		const response = await GET(
			requestEvent(
				{
					group: '/aws/lambda/demo',
					region: 'af-south-1',
					source: 'archive',
					pageSize: '250',
					max: '4000',
				},
				controller.signal,
			),
		);
		const reader = startReading(response);
		await withTimeout(reader.done, 2000, 'archive stream end');
		expect(archiveState.requests[0]).toMatchObject({ limit: 250 });
	});

	test('clamps an extreme page size, the minimum, and falls back on nonsense', async () => {
		const huge = new AbortController();
		const first = startReading(
			await GET(
				requestEvent(
					{
						group: '/aws/lambda/demo',
						region: 'af-south-1',
						source: 'archive',
						pageSize: '999999',
					},
					huge.signal,
				),
			),
		);
		await withTimeout(first.done, 2000, 'archive stream end');
		expect(archiveState.requests[0]).toMatchObject({ limit: 5000 });

		resetArchive();
		const negative = startReading(
			await GET(
				requestEvent({
					group: '/aws/lambda/demo',
					region: 'af-south-1',
					source: 'archive',
					pageSize: '-5',
				}),
			),
		);
		await withTimeout(negative.done, 2000, 'archive stream end');
		expect(archiveState.requests[0]).toMatchObject({ limit: 1 });

		// An unparsable value is not an error: the archive default applies.
		resetArchive();
		const nonsense = startReading(
			await GET(
				requestEvent({
					group: '/aws/lambda/demo',
					region: 'af-south-1',
					source: 'archive',
					pageSize: 'wide',
					max: 'lots',
				}),
			),
		);
		await withTimeout(nonsense.done, 2000, 'archive stream end');
		expect(archiveState.requests[0]).toMatchObject({ limit: 1000 });
	});
});

describe('historic views that prefer the archive', () => {
	beforeEach(() => {
		envState.current = { AWS_REGION: 'eu-west-1' };
		mocks.send.mockReset();
		mocks.region.mockReset();
		mocks.region.mockResolvedValue('us-west-1');
		mocks.destroy.mockReset();
		resetArchive();
		queueSend([{ events: [] }]);
	});

	/** Reads a historic stream until its `end` frame. */
	async function readToEnd(params: Record<string, string>): Promise<Frame[]> {
		const controller = new AbortController();
		const response = await GET(requestEvent(params, controller.signal));
		expect(response.status).toBe(200);
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => reader.frames.some((frame) => frame.event === 'end')),
			4000,
			'end frame',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');
		return reader.frames;
	}

	const GROUP = '/aws/lambda/demo';
	const TO = Date.now() - 60_000;
	const FROM = TO - 60_000;

	test('serves a fully covered window from the archive, without calling CloudWatch', async () => {
		archiveState.coverage.set(GROUP, [{ start: FROM, end: TO }]);
		archiveState.pages = [
			{
				events: [{ id: 'a1', timestamp: FROM + 1000, message: 'from the archive' }],
				last: { timestamp: FROM + 1000, seq: 1 },
			},
		];

		const frames = await readToEnd({
			group: GROUP,
			mode: 'historic',
			from: String(FROM),
			to: String(TO),
		});

		expect(mocks.send).not.toHaveBeenCalled();
		expect(frames.map((frame) => frame.event)).toEqual(['ready', 'log', 'end']);
		expect(frames.at(-1)?.data).toEqual({ reason: 'window-complete' });
		expect(archiveState.requests[0]).toMatchObject({
			region: 'eu-west-1',
			logGroups: [GROUP],
			startTime: FROM,
			endTime: TO,
		});
		// Replayed rows are already in the archive; they are never written back.
		expect(archiveState.records).toEqual([]);
		expect(archiveState.recordedCoverage).toEqual([]);
	});

	test('reads the archive for the covered part and CloudWatch for the gap', async () => {
		const MID = FROM + 30_000;
		archiveState.coverage.set(GROUP, [{ start: FROM, end: MID }]);
		archiveState.pages = [
			{
				events: [{ id: 'a1', timestamp: FROM + 1000, message: 'archived' }],
				last: { timestamp: FROM + 1000, seq: 1 },
			},
		];
		// One event at the window end completes the CloudWatch scan at once.
		queueSend([{ events: [event('cw1', TO, 'from aws')] }]);

		const frames = await readToEnd({
			group: GROUP,
			mode: 'historic',
			from: String(FROM),
			to: String(TO),
			poll: '250',
		});

		// The archive answered the covered half...
		expect(archiveState.requests[0]).toMatchObject({ startTime: FROM, endTime: MID });
		// ...and AWS was only asked for the gap.
		const command = mocks.send.mock.calls[0][0] as {
			input: { startTime: number; endTime?: number };
		};
		expect(command.input.startTime).toBe(MID + 1);
		expect(command.input.endTime).toBe(TO);

		const payloads = frames.filter((frame) => frame.event === 'log');
		const messages = payloads.flatMap(
			(frame) => (frame.data as { events: { message: string }[] }).events,
		);
		expect(messages.map((entry) => entry.message)).toEqual(['archived', 'from aws']);
		// The gap is now recorded, so the next view of this window is local.
		expect(archiveState.recordedCoverage).toEqual([
			{ region: 'eu-west-1', entries: [{ logGroup: GROUP, start: MID + 1, end: TO }] },
		]);
	});

	test('falls back to CloudWatch for a window the archive never saw, and records it', async () => {
		queueSend([{ events: [event('e1', TO, 'historic')] }]);

		const frames = await readToEnd({
			group: GROUP,
			mode: 'historic',
			from: String(FROM),
			to: String(TO),
			poll: '250',
		});

		expect(mocks.send).toHaveBeenCalled();
		expect(archiveState.coverageQueries[0]).toMatchObject({ region: 'eu-west-1', groups: [GROUP] });
		expect(frames.at(-1)?.data).toEqual({ reason: 'window-complete' });
		expect(archiveState.recordedCoverage).toEqual([
			{ region: 'eu-west-1', entries: [{ logGroup: GROUP, start: FROM, end: TO }] },
		]);
	});

	test('a filter pattern keeps the request on CloudWatch', async () => {
		archiveState.coverage.set(GROUP, [{ start: FROM, end: TO }]);
		queueSend([{ events: [event('e1', TO, 'ERROR historic')] }]);

		await readToEnd({
			group: GROUP,
			mode: 'historic',
			from: String(FROM),
			to: String(TO),
			filterPattern: 'ERROR',
			poll: '250',
		});

		expect(archiveState.coverageQueries).toEqual([]);
		expect(archiveState.requests).toEqual([]);
		const command = mocks.send.mock.calls[0][0] as { input: { filterPattern?: string } };
		expect(command.input.filterPattern).toBe('ERROR');
	});

	test('records what a live tail queried, so later historic views can use it', async () => {
		const controller = new AbortController();
		const response = await GET(requestEvent({ group: GROUP, poll: '250' }, controller.signal));
		const reader = startReading(response);
		await withTimeout(
			waitFor(() => mocks.send.mock.calls.length > 0),
			2000,
			'first poll',
		);
		controller.abort();
		await withTimeout(reader.done, 2000, 'stream end');

		expect(archiveState.recordedCoverage).toHaveLength(1);
		const recorded = archiveState.recordedCoverage[0];
		expect(recorded.region).toBe('eu-west-1');
		expect(recorded.entries[0].logGroup).toBe(GROUP);
		expect(recorded.entries[0].start).toBeLessThanOrEqual(recorded.entries[0].end);
	});
});
