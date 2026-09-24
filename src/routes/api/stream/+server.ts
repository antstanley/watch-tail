import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { type RequestEvent } from '@sveltejs/kit';
import { apiError } from '$lib/server/api';
import { registerLiveStream } from '$lib/server/live-streams';
import { getArchive, type LogArchive } from '$lib/server/archive';
import { tailArchivedEvents } from '$lib/server/archive-tail';
import {
	intersectCoverage,
	mergeCoverage,
	settleCoverage,
	subtractCoverage,
	type CoverageEntry,
	type CoverageInterval,
} from '$lib/server/archive-sql';
import {
	REGION_PARAM_HINT,
	createLogsClient,
	describeAwsError,
	parseRegionParam,
	resolveAwsConfig,
	resolveEffectiveRegion,
	type AwsConfig,
} from '$lib/server/aws';
import { readEnv } from '$lib/server/env';
import { clampPollMs, resolveWindow } from '$lib/server/filter';
import { parseGroupParams } from '$lib/server/group-params';
import { mergeTails } from '$lib/server/multi-tail';
import { SOURCE_PARAM_HINT, parseSourceParam } from '$lib/server/source';
import { sseFrame } from '$lib/server/sse';
import { tailLogEvents, type TailBatch } from '$lib/server/tail';
import { LEVEL_PARAM_HINT, parseLevelParam, withDetections } from '$lib/server/level-filter';
import type { LogLevel } from '$lib/log-buffer';
import type {
	LogEventDto,
	StreamEndPayload,
	StreamErrorPayload,
	StreamLogPayload,
	StreamPingPayload,
	StreamReadyPayload,
	StreamSource,
} from '$lib/types';

/** Send a `ping` after this much silence. */
const PING_INTERVAL_MS = 15_000;
/** Stop the stream after this many consecutive failed polls. */
const MAX_CONSECUTIVE_ERRORS = 8;
/** Bounds for the archive `pageSize` parameter. */
const ARCHIVE_PAGE_LIMITS = { min: 1, max: 5000 };
/** Bounds for the archive `max` parameter (events per request). */
const ARCHIVE_MAX_LIMITS = { min: 1, max: 100_000 };

const SSE_HEADERS: Record<string, string> = {
	'content-type': 'text/event-stream; charset=utf-8',
	'cache-control': 'no-cache, no-transform',
	connection: 'keep-alive',
	'x-accel-buffering': 'no',
};

/**
 * Tags every event of one tail with its log group and where it came from.
 *
 * A merged multi-group stream has to say which group each line came from, both
 * for the archive and for the group column in the viewer. `origin` is what keeps
 * a mixed archive/CloudWatch view from writing archived rows back.
 */
async function* taggedEvents(
	source: AsyncGenerator<TailBatch, void, void>,
	group: string,
	origin: 'archive' | 'cloudwatch',
): AsyncGenerator<TailBatch, void, void> {
	for await (const batch of source) {
		// A coverage range is recorded under its group, like the events before it.
		if (batch.type === 'coverage') {
			yield { ...batch, group };
			continue;
		}
		if (batch.type !== 'events') {
			yield batch;
			continue;
		}
		const events: LogEventDto[] = [];
		for (const event of batch.events) events.push({ ...event, group });
		yield { type: 'events', events, origin };
	}
}

/**
 * Writes one batch to the archive, under the right group.
 *
 * A merged multi-group stream tags every event with its own group, so a batch
 * that mixes groups is split; a single-group stream falls back to the group the
 * request named. Answers `false` when any row was not stored, which is what
 * stops the stream from recording coverage it cannot back up.
 */
async function recordBatch(
	archive: LogArchive,
	region: string,
	groupNames: readonly string[],
	events: readonly LogEventDto[],
): Promise<boolean> {
	const fallback = groupNames[0] ?? '';
	const byGroup = new Map<string, LogEventDto[]>();
	for (const event of events) {
		const group = event.group ?? fallback;
		const bucket = byGroup.get(group);
		if (bucket === undefined) byGroup.set(group, [event]);
		else bucket.push(event);
	}
	let stored = true;
	for (const [group, groupEvents] of byGroup) {
		const written = await archive.record(region, group, groupEvents);
		if (written !== groupEvents.length) stored = false;
	}
	return stored;
}

/**
 * Collects the ranges a stream read from CloudWatch, per log group.
 *
 * Each range arrives after the events it produced, and the pump has archived
 * those by then, so a range seen here is backed by stored rows. Only the part
 * that had settled when it was read is kept, and ranges are merged as they
 * arrive so a long live tail holds a handful of intervals, not one per poll.
 */
class CoverageCollector {
	readonly #byGroup = new Map<string, CoverageInterval[]>();

	add(group: string, range: { start: number; end: number; readAt: number }): void {
		const settled = settleCoverage(range, range.readAt);
		if (settled === null) return;
		this.#byGroup.set(group, mergeCoverage([...(this.#byGroup.get(group) ?? []), settled]));
	}

	entries(): CoverageEntry[] {
		const entries: CoverageEntry[] = [];
		for (const [logGroup, intervals] of this.#byGroup) {
			for (const interval of intervals) entries.push({ logGroup, ...interval });
		}
		return entries;
	}
}

/** One request's event feed plus the resources it owns. */
type Feed = {
	/** Region the feed reads, resolved for the response. */
	region: string;
	/** Log groups the feed covers, in request order. */
	groupNames: readonly string[];
	/** Batch generator the pump pulls from. */
	generator: AsyncGenerator<TailBatch, void, void>;
	/** Releases what the feed opened; called once, when the stream ends. */
	release: () => void;
};

/** Everything {@link resolveFeed} needs to pick a source. */
type FeedRequest = {
	source: StreamSource;
	config: AwsConfig;
	env: Record<string, string | undefined>;
	/** Log groups this feed covers; more than one is merged. */
	groupNames: readonly string[];
	startTime: number;
	/** Inclusive end of a historic window, or `null` for a live tail. */
	endTime: number | null;
	filterPattern: string | undefined;
	/** Archive-only substring search. */
	search: string | null;
	/** Archive-only level filter, or `null` for every level. */
	levels: readonly LogLevel[] | null;
	/** Archive-only page size, or `null` for the tailer default. */
	pageSize: number | null;
	/** Event cap of a historic window, or `null` for the tailer default. */
	maxEvents: number | null;
	pollIntervalMs: number;
	signal: AbortSignal;
};

/**
 * Parses a positive integer parameter within `limits`.
 *
 * Returns `null` for a missing value (meaning "use the default") and for an
 * unusable one, so a typo falls back to the default instead of failing the
 * stream; an out-of-range value is clamped rather than rejected.
 */
function parseBoundedInt(
	value: string | null,
	limits: { min: number; max: number },
): number | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed)) return null;
	return Math.min(Math.max(Math.round(parsed), limits.min), limits.max);
}

/**
 * Creates the CloudWatch Logs client and resolves the region it reads.
 *
 * Returns an `apiError` response the route can send unchanged when either step
 * fails (a missing region is the common case), so both the plain and the hybrid
 * feed build the client the same way.
 */
async function openCloudWatch(
	config: AwsConfig,
): Promise<{ client: CloudWatchLogsClient; region: string } | Response> {
	let client: CloudWatchLogsClient;
	try {
		client = createLogsClient(config);
	} catch (error) {
		const described = describeAwsError(error);
		return apiError(502, described.message, described.code);
	}
	try {
		return { client, region: await resolveEffectiveRegion(client, config) };
	} catch (error) {
		client.destroy();
		const described = describeAwsError(error);
		return apiError(502, described.message, described.code);
	}
}

/**
 * Builds the feed for a request.
 *
 * The archive path never creates a CloudWatch client, so browsing history works
 * with no credentials and no network; it does need a region, because archived
 * rows are stored per region. Failures come back as an `apiError` response the
 * route returns unchanged.
 */
async function resolveFeed(request: FeedRequest): Promise<Feed | Response> {
	const { source, config, env, groupNames, startTime, endTime, signal } = request;

	if (source === 'archive') {
		const region = config.region ?? '';
		if (region === '') {
			return apiError(
				400,
				'Query parameter "region" is required when source=archive',
				'missing-region-param',
			);
		}
		const archive: LogArchive = await getArchive(env, { region, readOnly: true });
		return {
			region,
			groupNames,
			generator: tailArchivedEvents({
				archive,
				region,
				logGroups: groupNames,
				startTime,
				endTime: endTime ?? Date.now(),
				search: request.search,
				levels: request.levels,
				// Kept null when absent, so the archive-tail defaults stay the source
				// of truth for a caller that does not page explicitly.
				...(request.pageSize === null ? {} : { pageSize: request.pageSize }),
				...(request.maxEvents === null ? {} : { maxEvents: request.maxEvents }),
				signal,
			}),
			release: () => undefined,
		};
	}

	const opened = await openCloudWatch(config);
	if (opened instanceof Response) return opened;
	const { client, region } = opened;

	// A read range is what a later view answers from the archive instead of
	// CloudWatch. It is only trustworthy without a filter pattern, which would
	// archive a subset of the events the range actually holds.
	const reportCoverage = (request.filterPattern ?? '').length === 0;

	// One group reads one call, so a multi-group view runs a tail per group and
	// merges them into a single batch stream.
	const tails = groupNames.map((group) =>
		taggedEvents(
			tailLogEvents({
				client,
				logGroupName: group,
				startTime,
				endTime,
				pollIntervalMs: request.pollIntervalMs,
				filterPattern: request.filterPattern,
				signal,
				maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
				reportCoverage,
				...(request.maxEvents === null ? {} : { maxEvents: request.maxEvents }),
			}),
			group,
			'cloudwatch',
		),
	);
	return {
		region,
		groupNames,
		generator: mergeTails(tails),
		release: () => client.destroy(),
	};
}

/**
 * Builds a historic CloudWatch view that reads the archive wherever it can.
 *
 * For each group the window is split against the archive's coverage: ranges the
 * archive already holds are replayed locally, and only the gaps are fetched from
 * CloudWatch. That is what makes re-searching a window that was streamed before
 * fast and offline-first, without ever dropping events the archive never saw -
 * the gaps are always filled from AWS.
 *
 * Each gap is recorded as coverage once CloudWatch has been read over it and
 * its events are stored, so the next view of the same window is answered from
 * the archive (all but its last few minutes, which may still be arriving).
 */
async function resolveHybridFeed(request: FeedRequest): Promise<Feed | Response> {
	const { config, env, groupNames, startTime, filterPattern, pollIntervalMs, signal } = request;
	const { maxEvents, pageSize } = request;
	const end = request.endTime ?? Date.now();

	const opened = await openCloudWatch(config);
	if (opened instanceof Response) return opened;
	const { client, region } = opened;
	// Select the archive with the region the request actually reads, which the
	// client resolves from the profile when no region parameter was given.
	const archive: LogArchive = await getArchive(env, { region, readOnly: true });

	const coverage = await archive.coverage(region, groupNames, startTime, end);
	const generators: AsyncGenerator<TailBatch, void, void>[] = [];

	for (const group of groupNames) {
		const intervals = coverage.get(group) ?? [];
		for (const covered of intersectCoverage(startTime, end, intervals)) {
			generators.push(
				taggedEvents(
					tailArchivedEvents({
						archive,
						region,
						logGroups: [group],
						startTime: covered.start,
						endTime: covered.end,
						...(pageSize === null ? {} : { pageSize }),
						...(maxEvents === null ? {} : { maxEvents }),
						signal,
					}),
					group,
					'archive',
				),
			);
		}
		for (const gap of subtractCoverage(startTime, end, intervals)) {
			generators.push(
				taggedEvents(
					tailLogEvents({
						client,
						logGroupName: group,
						startTime: gap.start,
						endTime: gap.end,
						pollIntervalMs,
						filterPattern,
						signal,
						maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
						reportCoverage: true,
						...(maxEvents === null ? {} : { maxEvents }),
					}),
					group,
					'cloudwatch',
				),
			);
		}
	}

	return {
		region,
		groupNames,
		generator: mergeTails(generators),
		release: () => client.destroy(),
	};
}

/**
 * `GET /api/stream` - server-sent events for one log group.
 *
 * Emits `ready` first, then `log` per batch, `ping` after 15 s of silence and
 * a final `end`. `source=cloudwatch` (the default) polls CloudWatch Logs with
 * the ambient credentials; `source=archive` replays the local DuckDB archive and
 * needs neither credentials nor a region parameter resolution.
 *
 * The stream is cancelled through `request.signal`, and every timer and listener
 * is removed so the dev server can exit.
 */
export const GET = async ({ url, request }: RequestEvent): Promise<Response> => {
	const groupSelection = parseGroupParams(
		url.searchParams.get('group'),
		url.searchParams.get('groups'),
	);
	if (!groupSelection.ok) return apiError(400, groupSelection.message, groupSelection.code);
	const groupNames = groupSelection.names;

	const parsedRegion = parseRegionParam(url.searchParams.get('region'));
	if (!parsedRegion.ok) return apiError(400, REGION_PARAM_HINT, 'invalid-region');

	const source = parseSourceParam(url.searchParams.get('source'));
	if (source === null) return apiError(400, SOURCE_PARAM_HINT, 'invalid-source');

	const env = readEnv();
	const config = resolveAwsConfig(env, parsedRegion.region);
	const filterPattern = url.searchParams.get('filterPattern')?.trim();
	const search = url.searchParams.get('search')?.trim() ?? '';
	const levels = parseLevelParam(url.searchParams.get('level'));
	if (levels === undefined) return apiError(400, LEVEL_PARAM_HINT, 'invalid-level');
	if (levels !== null && source !== 'archive') {
		return apiError(
			400,
			'The "level" filter applies to source=archive; use filterPattern to filter CloudWatch',
			'invalid-level',
		);
	}
	const streamWindow = resolveWindow(
		{
			// The archive holds a fixed window, so a request without a mode is historic.
			mode: url.searchParams.get('mode') ?? (source === 'archive' ? 'historic' : null),
			range: url.searchParams.get('range'),
			from: url.searchParams.get('from'),
			to: url.searchParams.get('to'),
			startTime: url.searchParams.get('startTime'),
			lookback: url.searchParams.get('lookback'),
			now: Date.now(),
			// The archive holds data CloudWatch has already forgotten, so its windows
			// are not clamped to 14 days.
		},
		source === 'archive' ? { maxLookbackMs: null } : {},
	);
	if (!streamWindow.ok) return apiError(400, streamWindow.message, streamWindow.code);
	if (source === 'archive' && streamWindow.mode === 'live') {
		return apiError(
			400,
			'The local archive only serves historic windows: use mode=historic, or source=cloudwatch to tail live',
			'invalid-mode',
		);
	}

	const bodyAbort = new AbortController();
	// A historic CloudWatch view reads the archive wherever it is already held and
	// only calls AWS for the gaps. A filter pattern rules it out: it archives a
	// subset of a range, so the archive cannot answer the range on its own.
	const hybrid =
		source === 'cloudwatch' &&
		streamWindow.mode === 'historic' &&
		(filterPattern ?? '').length === 0;
	const feedRequest: FeedRequest = {
		source,
		config,
		env,
		groupNames,
		startTime: streamWindow.startTime,
		endTime: streamWindow.endTime,
		filterPattern,
		search: search.length === 0 ? null : search,
		levels,
		pageSize: parseBoundedInt(url.searchParams.get('pageSize'), ARCHIVE_PAGE_LIMITS),
		maxEvents: parseBoundedInt(url.searchParams.get('max'), ARCHIVE_MAX_LIMITS),
		pollIntervalMs: clampPollMs(url.searchParams.get('poll')),
		signal: bodyAbort.signal,
	};
	const feed = hybrid ? await resolveHybridFeed(feedRequest) : await resolveFeed(feedRequest);
	if (feed instanceof Response) return feed;

	// Only the CloudWatch feed writes: reading the archive must not touch it.
	const archive = source === 'cloudwatch' ? await getArchive(env, { region: feed.region }) : null;

	const encoder = new TextEncoder();
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
	/** Removes this stream from the server's registry of open streams. */
	let unregisterStream: (() => void) | undefined;
	let closed = false;
	let pingTimer: ReturnType<typeof setTimeout> | undefined;
	let cleanedUp = false;

	const clearPing = (): void => {
		if (pingTimer !== undefined) {
			clearTimeout(pingTimer);
			pingTimer = undefined;
		}
	};

	const armPing = (): void => {
		if (closed) return;
		clearPing();
		pingTimer = setTimeout(() => {
			pingTimer = undefined;
			if (closed) return;
			const payload: StreamPingPayload = { at: Date.now() };
			enqueue(sseFrame('ping', payload), false);
			armPing();
		}, PING_INTERVAL_MS);
		(pingTimer as { unref?: () => void }).unref?.();
	};

	const enqueue = (chunk: string, rearm = true): void => {
		if (closed || streamController === undefined) return;
		try {
			streamController.enqueue(encoder.encode(chunk));
		} catch {
			// The consumer closed the stream between the flag check and the write.
			closed = true;
			return;
		}
		if (rearm) armPing();
	};

	const closeStream = (): void => {
		closed = true;
		try {
			streamController?.close();
		} catch {
			// Already closed or errored.
		}
	};

	const writeEnd = (reason: string): void => {
		clearPing();
		const payload: StreamEndPayload = { reason };
		// Best effort: the client may already be gone, so errors are swallowed.
		try {
			streamController?.enqueue(encoder.encode(sseFrame('end', payload)));
		} catch {
			// Enqueue after close.
		}
		closeStream();
	};

	const onAbort = (): void => {
		bodyAbort.abort();
	};

	const cleanup = (): void => {
		if (cleanedUp) return;
		cleanedUp = true;
		clearPing();
		unregisterStream?.();
		unregisterStream = undefined;
		request.signal.removeEventListener('abort', onAbort);
		feed.release();
	};

	// A historic CloudWatch view can merge several tails (one per group, or per
	// gap and archived range), so the requested cap is enforced across all of them
	// here. The archive source already stops at its own cap.
	const eventCap =
		source === 'cloudwatch' && streamWindow.mode === 'historic' ? feedRequest.maxEvents : null;

	const pump = async (): Promise<void> => {
		let consecutiveErrors = 0;
		let reason = 'completed';
		let sent = 0;
		const coverage = new CoverageCollector();
		// One unstored batch means the archive cannot vouch for what it was read over.
		let archiveComplete = true;
		try {
			for await (const batch of feed.generator) {
				if (closed || bodyAbort.signal.aborted) break;
				if (batch.type === 'events') {
					// Every event is completed with the fields the archive stores: a live
					// event gets its level and request id detected here, and a row read
					// from the archive keeps the level it was stored with (possibly
					// `null`) while a missing request id is detected from its message.
					const events = withDetections(batch.events);
					const remaining = eventCap === null ? events.length : eventCap - sent;
					const shown = remaining < events.length ? events.slice(0, remaining) : events;
					const payload: StreamLogPayload = { events: shown };
					consecutiveErrors = 0;
					sent += shown.length;
					enqueue(sseFrame('log', payload));
					// Archiving is part of the stream: awaiting keeps the order and lets
					// the archive serialise its own writes. It never throws. A merged
					// multi-group stream tags each event with its own group, so the rows
					// land under the right log group. Events replayed from the archive
					// already live there, so they are not written back. The whole batch
					// is stored even past the cap: it was read, and it is still true.
					if (archive !== null && batch.origin !== 'archive') {
						const stored = await recordBatch(archive, feed.region, feed.groupNames, events);
						if (!stored) archiveComplete = false;
					}
					if (eventCap !== null && sent >= eventCap) {
						reason = 'event-limit';
						break;
					}
				} else if (batch.type === 'coverage') {
					// Every event of this range came before it and has been stored.
					coverage.add(batch.group ?? feed.groupNames[0] ?? '', batch);
				} else if (batch.type === 'end') {
					// A finite (historic) window reports why it finished; a live tail
					// only ends because the client went away.
					reason = batch.reason;
					break;
				} else {
					const payload: StreamErrorPayload = { message: batch.message };
					if (batch.code !== undefined) payload.code = batch.code;
					consecutiveErrors += 1;
					enqueue(sseFrame('error', payload));
				}
			}
			if (reason === 'completed') {
				if (bodyAbort.signal.aborted) reason = 'client-disconnected';
				else if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) reason = 'repeated-errors';
			}
			// Remember what was read from CloudWatch and stored, so the next view of
			// this window can be answered from the archive. Only ranges whose events
			// were all written count, whatever ended the stream.
			const covered = coverage.entries();
			if (archive !== null && archiveComplete && covered.length > 0) {
				await archive.recordCoverage(feed.region, covered);
			}
		} catch (error) {
			const described = describeAwsError(error);
			const payload: StreamErrorPayload = { message: described.message };
			if (described.code !== undefined) payload.code = described.code;
			enqueue(sseFrame('error', payload));
			reason = 'failed';
		} finally {
			cleanup();
		}
		writeEnd(reason);
	};

	request.signal.addEventListener('abort', onAbort, { once: true });

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
			const payload: StreamReadyPayload = {
				region: feed.region,
				logGroupName: feed.groupNames[0] ?? '',
				groups: [...feed.groupNames],
				// The archive reads a local file, so there is no AWS endpoint to report.
				endpoint: source === 'archive' ? null : config.endpoint,
				source,
				startTime: streamWindow.startTime,
				endTime: streamWindow.endTime,
				mode: streamWindow.mode,
				preset: streamWindow.preset,
				clamped: streamWindow.clamped,
			};
			enqueue(sseFrame('ready', payload));
			armPing();
			// A live tail is the connection that keeps a graceful shutdown waiting,
			// so the server can end it the moment it is asked to stop.
			unregisterStream = registerLiveStream(() => writeEnd('server-stopping'));
			void pump();
		},
		cancel() {
			bodyAbort.abort();
			clearPing();
			closeStream();
			cleanup();
		},
	});

	return new Response(stream, { headers: SSE_HEADERS });
};
