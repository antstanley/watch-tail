import {
	FilterLogEventsCommand,
	type CloudWatchLogsClient,
	type FilterLogEventsCommandInput,
	type FilteredLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import type { LogEventDto } from '$lib/types';
import { describeAwsError } from './aws';

/** One value produced by {@link tailLogEvents}. */
export type TailBatch =
	| {
			type: 'events';
			events: LogEventDto[];
			/**
			 * Where the events came from. CloudWatch batches are archived as they
			 * stream; archive batches are not written back. Absent means CloudWatch.
			 */
			origin?: 'archive' | 'cloudwatch';
	  }
	| { type: 'error'; message: string; code?: string }
	| {
			/**
			 * A range CloudWatch was fully read over, reported after the events it
			 * produced, so a consumer that has stored those events can record it.
			 * Only emitted when {@link TailOptions.reportCoverage} is set.
			 */
			type: 'coverage';
			/** Inclusive range the sweep read, epoch ms. */
			start: number;
			end: number;
			/** When the sweep's first request was sent, epoch ms. */
			readAt: number;
			/** Log group the range belongs to, added by a consumer that merges groups. */
			group?: string;
	  }
	| { type: 'end'; reason: TailEndReason };

/** Why a tail stopped on its own. */
export type TailEndReason = 'window-complete' | 'event-limit' | 'repeated-errors';

/** Sleep implementation, injectable so tests never wait on real timers. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Options for {@link tailLogEvents}. */
export type TailOptions = {
	client: CloudWatchLogsClient;
	logGroupName: string;
	startTime: number;
	pollIntervalMs?: number;
	limit?: number;
	filterPattern?: string;
	signal?: AbortSignal;
	sleep?: SleepFn;
	maxConsecutiveErrors?: number;
	logStreamNamePrefix?: string;
	/**
	 * Inclusive end of a historic window. When set, the generator stops once the
	 * window is exhausted instead of tailing forever.
	 */
	endTime?: number | null;
	/** Empty polls tolerated in a historic window before it is called complete (default 2). */
	idlePolls?: number;
	/** Maximum events to yield before stopping (default 10000). */
	maxEvents?: number;
	/**
	 * Yield a `coverage` batch after every completed sweep.
	 *
	 * A sweep is one query from the cursor followed through every `nextToken`
	 * page, so its range (cursor to the window end, or to when it was sent) was
	 * actually read, not one that merely looked read. The batch comes after the
	 * sweep's events: a consumer that stores events as they arrive has stored
	 * them by the time it sees the range. A failed or aborted sweep reports none.
	 */
	reportCoverage?: boolean;
	/** Clock, injectable so tests can pin the time a sweep was sent. */
	now?: () => number;
};

const DEFAULT_SEEN_CAPACITY = 5000;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_LIMIT = 1000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 8;
const MAX_BACKOFF_MS = 15_000;
/** Empty polls that end a historic window: CloudWatch can lag behind ingestion. */
const DEFAULT_IDLE_POLLS = 2;
/** Upper bound on events yielded for one historic window. */
const DEFAULT_MAX_EVENTS = 10_000;

/** Returns true when the value is an abort error raised by the fetch/SDK layer. */
function isAbortError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR';
	}
	return false;
}

/**
 * Abort-aware sleep used by default.
 *
 * Resolves after `ms`, resolves immediately when the signal aborts and always
 * clears its timer. An injected sleep may instead reject on abort, which
 * {@link tailLogEvents} handles by re-checking the signal.
 */
const defaultSleep: SleepFn = (ms, signal) =>
	new Promise<void>((resolve) => {
		if (signal?.aborted === true || !Number.isFinite(ms) || ms <= 0) {
			resolve();
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		(timer as { unref?: () => void }).unref?.();
		signal?.addEventListener('abort', onAbort, { once: true });
	});

/**
 * Bounded first-in-first-out set of event ids.
 *
 * Keeps at most `capacity` ids (default 5000) so memory stays flat on long
 * streams. The oldest id is evicted first.
 */
export class SeenEventIds {
	private readonly ids = new Set<string>();
	private readonly capacity: number;

	constructor(capacity = DEFAULT_SEEN_CAPACITY) {
		const parsed = Number.isFinite(capacity) ? Math.floor(capacity) : DEFAULT_SEEN_CAPACITY;
		this.capacity = parsed > 0 ? parsed : DEFAULT_SEEN_CAPACITY;
	}

	/** True when the id was recorded before. Null and empty ids are never recorded. */
	has(id: string | null): boolean {
		return id !== null && id.length > 0 && this.ids.has(id);
	}

	/** Records an id, evicting the oldest entry when the capacity is reached. */
	add(id: string | null): void {
		if (id === null || id.length === 0 || this.ids.has(id)) return;
		if (this.ids.size >= this.capacity) {
			const oldest = this.ids.values().next();
			if (!oldest.done) this.ids.delete(oldest.value);
		}
		this.ids.add(id);
	}

	/** Number of ids currently remembered. */
	get size(): number {
		return this.ids.size;
	}
}

/**
 * Converts a poll result into the events worth sending downstream.
 *
 * Drops ids seen in earlier polls and duplicates inside the same batch, then
 * records the ids of the accepted events. Events without an id are always kept
 * and never recorded.
 */
export function selectNewEvents(
	events: FilteredLogEvent[] | undefined,
	seen: SeenEventIds,
): LogEventDto[] {
	const selected: LogEventDto[] = [];
	if (events === undefined || events.length === 0) return selected;
	const freshIds = new Set<string>();

	for (const event of events) {
		const id = event.eventId !== undefined && event.eventId.length > 0 ? event.eventId : null;
		if (id !== null) {
			if (seen.has(id) || freshIds.has(id)) continue;
			freshIds.add(id);
		}
		const dto: LogEventDto = {
			id,
			timestamp: typeof event.timestamp === 'number' ? event.timestamp : 0,
			message: event.message ?? '',
		};
		if (event.logStreamName !== undefined) dto.streamName = event.logStreamName;
		if (typeof event.ingestionTime === 'number') dto.ingestionTime = event.ingestionTime;
		selected.push(dto);
	}

	for (const id of freshIds) seen.add(id);
	return selected;
}

/** Highest timestamp in `events`, never lower than `previous`. */
export function nextCursor(previous: number, events: LogEventDto[]): number {
	let cursor = Number.isFinite(previous) ? previous : 0;
	for (const event of events) {
		if (Number.isFinite(event.timestamp) && event.timestamp > cursor) cursor = event.timestamp;
	}
	return cursor;
}

/**
 * Polls `FilterLogEvents` and yields batches as they arrive.
 *
 * `startTime` is inclusive upstream, so the cursor advances to the newest
 * timestamp seen and repeated events are removed by {@link SeenEventIds}.
 * A `nextToken` is followed straight away, so a sweep reads its whole range
 * before the next one starts. Nothing is new in a sweep => sleep
 * `pollIntervalMs`. Errors are yielded as
 * `error` batches and retried with exponential backoff
 * (`pollIntervalMs * 2^consecutiveErrors`, capped at 15000 ms) until
 * `maxConsecutiveErrors` (default 8) failures in a row, then the generator
 * returns. An aborted signal ends the generator without throwing.
 */
export async function* tailLogEvents(options: TailOptions): AsyncGenerator<TailBatch, void, void> {
	const {
		client,
		logGroupName,
		startTime,
		pollIntervalMs = DEFAULT_POLL_MS,
		limit = DEFAULT_LIMIT,
		filterPattern,
		signal,
		sleep = defaultSleep,
		maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS,
		logStreamNamePrefix,
		endTime = null,
		idlePolls = DEFAULT_IDLE_POLLS,
		maxEvents = DEFAULT_MAX_EVENTS,
		reportCoverage = false,
		now = Date.now,
	} = options;

	// A bounded window turns the endless poll loop into a finite scan.
	const historic = typeof endTime === 'number' && Number.isFinite(endTime);
	const windowEnd = historic ? (endTime as number) : null;
	const idlePollsAllowed =
		Number.isFinite(idlePolls) && idlePolls > 0 ? Math.floor(idlePolls) : DEFAULT_IDLE_POLLS;
	const eventCap =
		Number.isFinite(maxEvents) && maxEvents > 0 ? Math.floor(maxEvents) : DEFAULT_MAX_EVENTS;

	const pollMs =
		Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
			? Math.min(Math.round(pollIntervalMs), MAX_BACKOFF_MS)
			: DEFAULT_POLL_MS;
	const pageLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
	const maxErrors =
		Number.isFinite(maxConsecutiveErrors) && maxConsecutiveErrors > 0
			? Math.floor(maxConsecutiveErrors)
			: DEFAULT_MAX_CONSECUTIVE_ERRORS;

	const baseInput: FilterLogEventsCommandInput = { logGroupName, startTime, limit: pageLimit };
	if (windowEnd !== null) baseInput.endTime = windowEnd;
	if (filterPattern !== undefined && filterPattern.length > 0)
		baseInput.filterPattern = filterPattern;
	if (logStreamNamePrefix !== undefined && logStreamNamePrefix.length > 0) {
		baseInput.logStreamNamePrefix = logStreamNamePrefix;
	}

	const isAborted = (): boolean => signal?.aborted === true;

	const wait = async (ms: number): Promise<boolean> => {
		if (isAborted()) return true;
		try {
			await sleep(ms, signal);
		} catch {
			// An injected sleep may reject on abort; the signal decides below.
		}
		return isAborted();
	};

	const seen = new SeenEventIds();
	let cursor = Number.isFinite(startTime) ? startTime : 0;
	let consecutiveErrors = 0;
	let emitted = 0;
	let emptyPolls = 0;
	// One sweep is a query from the cursor plus every page its `nextToken` leads
	// to. CloudWatch can answer a page with no events and a token while it is
	// still searching, so only a sweep without a token has read its whole range.
	let sweepStart = cursor;
	let sweepSentAt = 0;
	let sweepHadEvents = false;
	let nextToken: string | undefined;

	for (;;) {
		if (isAborted()) return;
		try {
			if (nextToken === undefined) {
				sweepStart = cursor;
				sweepSentAt = now();
				sweepHadEvents = false;
			}
			// A fresh input per poll keeps recorded commands free of shared state.
			const input: FilterLogEventsCommandInput = { ...baseInput, startTime: sweepStart };
			if (nextToken !== undefined) input.nextToken = nextToken;
			const response = await client.send(new FilterLogEventsCommand(input), {
				abortSignal: signal,
			});
			consecutiveErrors = 0;
			nextToken =
				typeof response.nextToken === 'string' && response.nextToken.length > 0
					? response.nextToken
					: undefined;
			const events = selectNewEvents(response.events, seen);
			if (events.length > 0) {
				sweepHadEvents = true;
				cursor = nextCursor(cursor, events);
				emitted += events.length;
				yield { type: 'events', events };
				if (historic && emitted >= eventCap) {
					yield { type: 'end', reason: 'event-limit' };
					return;
				}
			}
			// More pages of this sweep: fetch them straight away.
			if (nextToken !== undefined) continue;

			if (reportCoverage) {
				// Nothing newer than the moment the sweep was sent can have been read.
				const end = windowEnd === null ? sweepSentAt : Math.min(windowEnd, sweepSentAt);
				if (end >= sweepStart) {
					yield { type: 'coverage', start: sweepStart, end, readAt: sweepSentAt };
				}
			}
			if (sweepHadEvents) {
				emptyPolls = 0;
				if (windowEnd !== null && cursor >= windowEnd) {
					yield { type: 'end', reason: 'window-complete' };
					return;
				}
				continue;
			}
			// An empty sweep inside a historic window usually means the scan is done,
			// but ingestion can lag, so a couple of empty sweeps are tolerated first.
			if (historic) {
				emptyPolls += 1;
				if (emptyPolls >= idlePollsAllowed) {
					yield { type: 'end', reason: 'window-complete' };
					return;
				}
			}
		} catch (error) {
			if (isAborted() || isAbortError(error)) return;
			consecutiveErrors += 1;
			const described = describeAwsError(error);
			yield { type: 'error', message: described.message, code: described.code };
			if (consecutiveErrors >= maxErrors) {
				if (historic) yield { type: 'end', reason: 'repeated-errors' };
				return;
			}
			const backoff = Math.min(pollMs * 2 ** consecutiveErrors, MAX_BACKOFF_MS);
			if (await wait(backoff)) return;
			continue;
		}
		if (await wait(pollMs)) return;
	}
}
