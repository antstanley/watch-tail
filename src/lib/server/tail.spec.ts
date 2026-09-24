import { describe, expect, test, vi, type Mock } from 'vitest';
import {
	type CloudWatchLogsClient,
	type FilterLogEventsCommand,
	type FilteredLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import {
	SeenEventIds,
	nextCursor,
	selectNewEvents,
	tailLogEvents,
	type SleepFn,
	type TailBatch,
	type TailOptions,
} from './tail';

/** Builds a CloudWatch event for a poll result. */
function event(id: string | null, timestamp: number, message = 'line'): FilteredLogEvent {
	const value: FilteredLogEvent = { timestamp, message };
	if (id !== null) value.eventId = id;
	value.logStreamName = `stream-${id ?? 'none'}`;
	value.ingestionTime = timestamp + 1;
	return value;
}

type PollResult = { events: FilteredLogEvent[] } | Error;
type FakeSend = (command: unknown, options?: unknown) => Promise<unknown>;

/** Fake client that returns each queued poll result in order, then empty pages. */
function queueClient(results: PollResult[]): {
	client: CloudWatchLogsClient;
	send: Mock<FakeSend>;
} {
	let index = 0;
	const send = vi.fn<FakeSend>(async (_command: unknown) => {
		const result = results[index] ?? { events: [] };
		index += 1;
		if (result instanceof Error) throw result;
		return result;
	});
	return { client: { send } as unknown as CloudWatchLogsClient, send };
}

type CollectResult = {
	batches: TailBatch[];
	sleeps: number[];
	controller: AbortController;
};

/** Runs the tailer with an instant sleep spy and stops once `stopAfter` returns true. */
async function collect(
	options: Omit<TailOptions, 'signal' | 'sleep'>,
	stopAfter: (batches: TailBatch[]) => boolean,
): Promise<CollectResult> {
	const controller = new AbortController();
	const batches: TailBatch[] = [];
	const sleeps: number[] = [];
	const sleep = vi.fn<SleepFn>(async (ms: number) => {
		sleeps.push(ms);
	});
	for await (const batch of tailLogEvents({
		...options,
		signal: controller.signal,
		sleep,
	})) {
		batches.push(batch);
		if (stopAfter(batches)) controller.abort();
	}
	return { batches, sleeps, controller };
}

const GROUP = '/aws/lambda/demo';

describe('selectNewEvents', () => {
	test('maps SDK events onto the wire type', () => {
		const seen = new SeenEventIds();
		const selected = selectNewEvents([event('e1', 1000, 'hello')], seen);
		expect(selected).toEqual([
			{ id: 'e1', timestamp: 1000, message: 'hello', streamName: 'stream-e1', ingestionTime: 1001 },
		]);
	});

	test('drops events already seen in an earlier poll', () => {
		const seen = new SeenEventIds();
		selectNewEvents([event('e1', 1000), event('e2', 1000)], seen);
		const second = selectNewEvents([event('e1', 1000), event('e2', 1000), event('e3', 1000)], seen);
		expect(second.map((dto) => dto.id)).toEqual(['e3']);
		expect(selectNewEvents([event('e3', 1000)], seen)).toEqual([]);
	});

	test('drops duplicates inside a single batch', () => {
		const seen = new SeenEventIds();
		const selected = selectNewEvents([event('e1', 1), event('e1', 1), event('e2', 2)], seen);
		expect(selected.map((dto) => dto.id)).toEqual(['e1', 'e2']);
		expect(seen.size).toBe(2);
	});

	test('keeps events without an id without poisoning the seen set', () => {
		const seen = new SeenEventIds();
		const first = selectNewEvents([event(null, 1000, 'no id')], seen);
		const second = selectNewEvents([event(null, 2000, 'no id again')], seen);
		expect(first).toEqual([
			{
				id: null,
				timestamp: 1000,
				message: 'no id',
				streamName: 'stream-none',
				ingestionTime: 1001,
			},
		]);
		expect(second).toHaveLength(1);
		expect(seen.size).toBe(0);
	});

	test('tolerates missing fields and non-numeric timestamps', () => {
		const seen = new SeenEventIds();
		const selected = selectNewEvents(
			[{ eventId: 'e1' }, { eventId: 'e2', timestamp: Number.NaN, message: 'x' }],
			seen,
		);
		expect(selected[0].timestamp).toBe(0);
		expect(selected[0].message).toBe('');
		expect(selected[0].streamName).toBeUndefined();
		expect(selected[0].ingestionTime).toBeUndefined();
	});

	test('returns an empty list for a missing event array', () => {
		expect(selectNewEvents(undefined, new SeenEventIds())).toEqual([]);
		expect(selectNewEvents([], new SeenEventIds())).toEqual([]);
	});
});

describe('nextCursor', () => {
	test('returns the newest timestamp and never moves backwards', () => {
		const events = selectNewEvents([event('e1', 1000), event('e2', 3000)], new SeenEventIds());
		expect(nextCursor(0, events)).toBe(3000);
		expect(nextCursor(5000, events)).toBe(5000);
		expect(nextCursor(2000, [])).toBe(2000);
	});

	test('ignores non-finite timestamps', () => {
		expect(nextCursor(10, [{ id: 'e1', timestamp: Number.NaN, message: '' }])).toBe(10);
		expect(nextCursor(Number.NaN, [])).toBe(0);
	});
});

describe('SeenEventIds', () => {
	test('evicts the oldest id when the capacity is reached', () => {
		const seen = new SeenEventIds(2);
		seen.add('a');
		seen.add('b');
		seen.add('c');
		expect(seen.size).toBe(2);
		expect(seen.has('a')).toBe(false);
		expect(seen.has('b')).toBe(true);
		expect(seen.has('c')).toBe(true);
	});

	test('never records null or empty ids', () => {
		const seen = new SeenEventIds(10);
		seen.add(null);
		seen.add('');
		expect(seen.size).toBe(0);
		expect(seen.has(null)).toBe(false);
	});

	test('does not grow past the default capacity', () => {
		const seen = new SeenEventIds();
		for (let index = 0; index < 5001; index += 1) seen.add(`e${index}`);
		expect(seen.size).toBe(5000);
		expect(seen.has('e0')).toBe(false);
		expect(seen.has('e1')).toBe(true);
	});

	test('falls back to the default capacity for invalid values', () => {
		expect(new SeenEventIds(0).size).toBe(0);
		const seen = new SeenEventIds(-5);
		seen.add('a');
		expect(seen.has('a')).toBe(true);
	});
});

describe('tailLogEvents', () => {
	test('yields only new events, advances the cursor and sleeps between empty polls', async () => {
		const poll1 = [event('e1', 1000, 'first'), event('e2', 2000, 'second')];
		const poll3 = [event('e2', 2000, 'second'), event('e3', 3000, 'third')];
		const { client, send } = queueClient([{ events: poll1 }, { events: [] }, { events: poll3 }]);
		const { batches, sleeps, controller } = await collect(
			{
				client,
				logGroupName: GROUP,
				startTime: 500,
				pollIntervalMs: 1000,
				filterPattern: '?ERROR',
				logStreamNamePrefix: '2024',
			},
			(collected) => collected.filter((batch) => batch.type === 'events').length >= 2,
		);

		expect(batches).toHaveLength(2);
		expect(batches[0]).toEqual({
			type: 'events',
			events: [
				{
					id: 'e1',
					timestamp: 1000,
					message: 'first',
					streamName: 'stream-e1',
					ingestionTime: 1001,
				},
				{
					id: 'e2',
					timestamp: 2000,
					message: 'second',
					streamName: 'stream-e2',
					ingestionTime: 2001,
				},
			],
		});
		expect(batches[1]).toEqual({
			type: 'events',
			events: [
				{
					id: 'e3',
					timestamp: 3000,
					message: 'third',
					streamName: 'stream-e3',
					ingestionTime: 3001,
				},
			],
		});

		expect(send).toHaveBeenCalledTimes(3);
		const inputs = send.mock.calls.map((call) => (call[0] as FilterLogEventsCommand).input);
		expect(inputs[0]).toEqual({
			logGroupName: GROUP,
			startTime: 500,
			limit: 1000,
			filterPattern: '?ERROR',
			logStreamNamePrefix: '2024',
		});
		expect(inputs[1].startTime).toBe(2000);
		expect(inputs[2].startTime).toBe(2000);
		expect(send.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });

		// The empty poll is the only place where the loop waited.
		expect(sleeps).toEqual([1000]);
	});

	test('ends without throwing when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const { client, send } = queueClient([{ events: [event('e1', 1)] }]);
		const batches: TailBatch[] = [];
		for await (const batch of tailLogEvents({
			client,
			logGroupName: GROUP,
			startTime: 0,
			signal: controller.signal,
			sleep: async () => {},
		})) {
			batches.push(batch);
		}
		expect(batches).toEqual([]);
		expect(send).not.toHaveBeenCalled();
	});

	test('wakes up and ends when the signal aborts during a sleep', async () => {
		const controller = new AbortController();
		const { client } = queueClient([{ events: [] }]);
		const sleep = vi.fn<SleepFn>(
			(_ms: number, signal?: AbortSignal) =>
				new Promise<void>((resolve) => {
					signal?.addEventListener('abort', () => resolve(), { once: true });
				}),
		);
		const batches: TailBatch[] = [];
		const iterator = tailLogEvents({
			client,
			logGroupName: GROUP,
			startTime: 0,
			signal: controller.signal,
			sleep,
		})[Symbol.asyncIterator]();
		const pending = iterator.next();
		await vi.waitFor(() => {
			expect(sleep).toHaveBeenCalledTimes(1);
		});
		controller.abort();
		const result = await pending;
		expect(result.done).toBe(true);
		expect(batches).toEqual([]);
	});

	test('ends when a sleep rejects because of an abort', async () => {
		const controller = new AbortController();
		const { client } = queueClient([{ events: [] }]);
		let calls = 0;
		const sleep: SleepFn = async () => {
			calls += 1;
			if (calls >= 2) {
				controller.abort();
				throw new Error('aborted');
			}
		};
		const batches: TailBatch[] = [];
		for await (const batch of tailLogEvents({
			client,
			logGroupName: GROUP,
			startTime: 0,
			signal: controller.signal,
			sleep,
		})) {
			batches.push(batch);
		}
		expect(calls).toBe(2);
		expect(batches).toEqual([]);
	});

	test('uses the real default sleep, which wakes up on abort', async () => {
		const controller = new AbortController();
		const { client } = queueClient([{ events: [] }]);
		const started = Date.now();
		const iterator = tailLogEvents({
			client,
			logGroupName: GROUP,
			startTime: 0,
			pollIntervalMs: 15_000,
			signal: controller.signal,
		})[Symbol.asyncIterator]();
		const pending = iterator.next();
		await new Promise((resolve) => setTimeout(resolve, 50));
		controller.abort();
		const result = await pending;
		expect(result.done).toBe(true);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	test('emits error batches and backs off exponentially before recovering', async () => {
		const failure = new Error('connect ECONNREFUSED 127.0.0.1:4566');
		const { client } = queueClient([failure, failure, { events: [event('e1', 1000, 'later')] }]);
		const { batches, sleeps } = await collect(
			{ client, logGroupName: GROUP, startTime: 0, pollIntervalMs: 1000 },
			(collected) => collected.some((batch) => batch.type === 'events'),
		);

		expect(batches).toHaveLength(3);
		expect(batches[0]).toEqual({
			type: 'error',
			message: expect.any(String),
			code: 'unreachable',
		});
		expect(batches[1].type).toBe('error');
		expect(batches[2]).toEqual({
			type: 'events',
			events: [
				{
					id: 'e1',
					timestamp: 1000,
					message: 'later',
					streamName: 'stream-e1',
					ingestionTime: 1001,
				},
			],
		});
		expect(sleeps).toEqual([2000, 4000]);
	});

	test('caps the backoff at 15000 ms', async () => {
		const failure = new Error('ThrottlingException');
		const { client } = queueClient([failure, failure, failure, failure, failure, failure]);
		const { sleeps } = await collect(
			{ client, logGroupName: GROUP, startTime: 0, pollIntervalMs: 5000, maxConsecutiveErrors: 6 },
			() => false,
		);
		expect(sleeps).toEqual([10_000, 15_000, 15_000, 15_000, 15_000]);
	});

	test('stops after maxConsecutiveErrors failures in a row', async () => {
		const failure = new Error('connect ECONNREFUSED');
		const { client, send } = queueClient([failure, failure, failure, failure]);
		const { batches, sleeps } = await collect(
			{ client, logGroupName: GROUP, startTime: 0, pollIntervalMs: 500, maxConsecutiveErrors: 3 },
			() => false,
		);
		expect(batches).toHaveLength(3);
		expect(batches.every((batch) => batch.type === 'error')).toBe(true);
		expect(send).toHaveBeenCalledTimes(3);
		expect(sleeps).toEqual([1000, 2000]);
	});

	test('resets the error counter after a successful poll', async () => {
		const failure = new Error('boom');
		const { client } = queueClient([
			failure,
			{ events: [event('e1', 1, 'ok')] },
			failure,
			failure,
			failure,
		]);
		const { batches } = await collect(
			{ client, logGroupName: GROUP, startTime: 0, maxConsecutiveErrors: 3, pollIntervalMs: 250 },
			() => false,
		);
		expect(batches.map((batch) => batch.type)).toEqual([
			'error',
			'events',
			'error',
			'error',
			'error',
		]);
	});

	test('never busy-loops while idle', async () => {
		const controller = new AbortController();
		const { client, send } = queueClient([]);
		let sleeps = 0;
		const sleep: SleepFn = async () => {
			sleeps += 1;
			if (sleeps >= 3) controller.abort();
		};
		const batches: TailBatch[] = [];
		for await (const batch of tailLogEvents({
			client,
			logGroupName: GROUP,
			startTime: 0,
			pollIntervalMs: 250,
			signal: controller.signal,
			sleep,
		})) {
			batches.push(batch);
		}
		expect(sleeps).toBe(3);
		expect(send).toHaveBeenCalledTimes(3);
		expect(batches).toEqual([]);
	});

	test('omits optional filters and defaults when they are not set', async () => {
		const { client, send } = queueClient([{ events: [event('e1', 1)] }]);
		await collect({ client, logGroupName: GROUP, startTime: 10 }, (batches) => batches.length > 0);
		const input = (send.mock.calls[0][0] as FilterLogEventsCommand).input;
		expect(input).toEqual({ logGroupName: GROUP, startTime: 10, limit: 1000 });
		expect(input.filterPattern).toBeUndefined();
		expect(input.logStreamNamePrefix).toBeUndefined();
	});
});

describe('historic windows', () => {
	test('stops after the window is exhausted', async () => {
		const { client, send } = queueClient([{ events: [event('a', 1_000), event('b', 1_100)] }]);

		const { batches, sleeps } = await collect(
			{ client, logGroupName: GROUP, startTime: 0, endTime: 5_000 },
			() => false,
		);

		const events = batches.filter((batch) => batch.type === 'events');
		expect(events).toHaveLength(1);
		expect(batches.at(-1)).toEqual({ type: 'end', reason: 'window-complete' });
		// One empty page is followed by a sleep, the second one completes the scan.
		expect(sleeps).toHaveLength(1);
		// The end bound is handed to CloudWatch on every poll.
		for (const call of send.mock.calls) {
			const command = call[0] as { input?: { endTime?: number } };
			expect(command.input?.endTime).toBe(5_000);
		}
	});

	test('an end bound is only sent for historic windows', async () => {
		const { client, send } = queueClient([{ events: [event('a', 1_000)] }]);

		await collect({ client, logGroupName: GROUP, startTime: 0 }, (batches) => batches.length > 0);

		const command = send.mock.calls[0][0] as { input?: { endTime?: number } };
		expect(command.input?.endTime).toBeUndefined();
	});

	test('stops at the event cap', async () => {
		const { client } = queueClient([
			{ events: [event('a', 1_000), event('b', 1_001)] },
			{ events: [event('c', 1_002)] },
		]);

		const { batches } = await collect(
			{ client, logGroupName: GROUP, startTime: 0, endTime: 9_999, maxEvents: 2 },
			() => false,
		);

		expect(batches.at(-1)).toEqual({ type: 'end', reason: 'event-limit' });
	});

	test('honours idlePolls for the completion decision', async () => {
		const { client } = queueClient([{ events: [event('a', 1_000)] }]);

		const { batches, sleeps } = await collect(
			{ client, logGroupName: GROUP, startTime: 0, endTime: 5_000, idlePolls: 1 },
			() => false,
		);

		expect(batches.at(-1)).toEqual({ type: 'end', reason: 'window-complete' });
		// With `idlePolls: 1` the first empty page ends the scan, so nothing slept.
		expect(sleeps).toHaveLength(0);
	});

	test('reports repeated errors and stops', async () => {
		const { client } = queueClient([new Error('boom'), new Error('boom')]);

		const { batches } = await collect(
			{ client, logGroupName: GROUP, startTime: 0, endTime: 5_000, maxConsecutiveErrors: 2 },
			() => false,
		);

		expect(batches.map((batch) => batch.type)).toEqual(['error', 'error', 'end']);
		expect(batches.at(-1)).toEqual({ type: 'end', reason: 'repeated-errors' });
	});

	test('a live tail never yields an end batch on its own', async () => {
		const { client } = queueClient([{ events: [event('a', 1_000)] }]);

		const { batches } = await collect(
			{ client, logGroupName: GROUP, startTime: 0 },
			(collected) => collected.length >= 1,
		);

		expect(batches).toHaveLength(1);
		expect(batches[0].type).toBe('events');
	});

	test('a live tail keeps polling after an empty page instead of ending', async () => {
		const { client, send } = queueClient([{ events: [] }, { events: [event('late', 2_000)] }]);
		const controller = new AbortController();
		const batches: TailBatch[] = [];
		const sleep = vi.fn<SleepFn>(async () => {
			if (batches.length >= 1) controller.abort();
		});

		for await (const batch of tailLogEvents({
			client,
			logGroupName: GROUP,
			startTime: 0,
			sleep,
			signal: controller.signal,
		})) {
			batches.push(batch);
		}

		expect(batches.map((batch) => batch.type)).toEqual(['events']);
		expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	test('an abort during a historic scan stops without an end batch', async () => {
		const { client } = queueClient([{ events: [event('a', 1_000)] }]);

		// `collect` aborts its own signal once the predicate matches, so the scan
		// stops mid-window and never reports completion.
		const { batches, controller } = await collect(
			{ client, logGroupName: GROUP, startTime: 0, endTime: 5_000 },
			(collected) => collected.length >= 1,
		);

		expect(controller.signal.aborted).toBe(true);
		expect(batches.at(-1)?.type).toBe('events');
	});
});

describe('tailLogEvents coverage reporting', () => {
	test('reports the range each historic poll covered', async () => {
		const { client } = queueClient([{ events: [event('a', 1_000)] }]);
		const polls: [number, number][] = [];
		await collect(
			{
				client,
				logGroupName: GROUP,
				startTime: 0,
				endTime: 5_000,
				onPoll: (start, end) => polls.push([start, end]),
			},
			(collected) => collected.some((batch) => batch.type === 'end'),
		);
		expect(polls[0]).toEqual([0, 5_000]);
	});

	test('a live poll reports up to now', async () => {
		const before = Date.now();
		const { client } = queueClient([{ events: [event('a', 1_000)] }]);
		const polls: [number, number][] = [];
		await collect(
			{
				client,
				logGroupName: GROUP,
				startTime: 0,
				onPoll: (start, end) => polls.push([start, end]),
			},
			(collected) => collected.length >= 1,
		);
		const [start, end] = polls[0];
		expect(start).toBe(0);
		expect(end).toBeGreaterThanOrEqual(before);
	});

	test('a failed poll never reports coverage', async () => {
		const { client } = queueClient([new Error('boom')]);
		const polls: [number, number][] = [];
		await collect(
			{
				client,
				logGroupName: GROUP,
				startTime: 0,
				endTime: 5_000,
				maxConsecutiveErrors: 1,
				onPoll: (start, end) => polls.push([start, end]),
			},
			(collected) => collected.some((batch) => batch.type === 'end'),
		);
		expect(polls).toEqual([]);
	});
});
