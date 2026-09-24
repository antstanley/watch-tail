/**
 * Replays the local archive as the same batch stream the CloudWatch tailer
 * produces, so `/api/stream` can serve history through one code path.
 *
 * The window is fixed (there is nothing to poll: the rows are already on disk),
 * so the generator always ends by itself and the route reports the usual
 * `window-complete` / `event-limit` reasons.
 */
import type { LogLevel } from '$lib/log-buffer';
import type { LogEventDto } from '$lib/types';
import type { ArchiveCursor, ArchivePageRequest } from './archive-sql';
import type { TailBatch } from './tail';

/** The part of {@link LogArchive} this generator needs. */
export type ArchivePageSource = {
	available: boolean;
	error: string | null;
	page: (
		request: ArchivePageRequest,
	) => Promise<{ events: LogEventDto[]; last: ArchiveCursor | null }>;
};

/** Page size used when the caller does not ask for one. */
export const DEFAULT_ARCHIVE_PAGE_SIZE = 1000;
/** Upper bound on one page, so a huge window cannot exhaust memory. */
export const MAX_ARCHIVE_PAGE_SIZE = 5000;
/** Events one archive request may return before it stops (matches the tailer). */
export const DEFAULT_ARCHIVE_MAX_EVENTS = 10_000;

/** Options for {@link tailArchivedEvents}. */
export type ArchivedTailOptions = {
	archive: ArchivePageSource;
	region: string;
	/** Log groups to replay; all of them are read in one pass. */
	logGroups: readonly string[];
	/** Inclusive start of the window, epoch ms. */
	startTime: number;
	/** Inclusive end of the window, epoch ms. */
	endTime: number;
	/** Case-insensitive substring of the message, or `null`. */
	search?: string | null;
	/** Log stream prefix, or `null` for every stream. */
	streamPrefix?: string | null;
	/** Levels to include, or `null` for every level. */
	levels?: readonly LogLevel[] | null;
	pageSize?: number;
	maxEvents?: number;
	signal?: AbortSignal;
};

/** Message shown when DuckDB is missing or the file cannot be opened. */
export function archiveUnavailableMessage(archive: ArchivePageSource): string {
	const reason = archive.error;
	const base = 'The local archive is not available on this machine';
	return reason === null || reason.length === 0 ? base : `${base}: ${reason}`;
}

/**
 * Yields archived events for one window, oldest first.
 *
 * An unavailable archive produces a single `error` batch instead of throwing, so
 * the browser shows a normal stream error. An aborted signal ends the generator
 * without yielding an `end` batch, which is what the route treats as a
 * client disconnect.
 */
export async function* tailArchivedEvents(
	options: ArchivedTailOptions,
): AsyncGenerator<TailBatch, void, void> {
	const {
		archive,
		region,
		logGroups,
		startTime,
		endTime,
		search = null,
		streamPrefix = null,
		levels = null,
		signal,
	} = options;
	if (!archive.available) {
		yield {
			type: 'error',
			message: archiveUnavailableMessage(archive),
			code: 'archive-unavailable',
		};
		return;
	}

	const requestedPageSize = options.pageSize ?? DEFAULT_ARCHIVE_PAGE_SIZE;
	const pageSize = Math.min(
		Math.max(
			Number.isFinite(requestedPageSize)
				? Math.round(requestedPageSize)
				: DEFAULT_ARCHIVE_PAGE_SIZE,
			1,
		),
		MAX_ARCHIVE_PAGE_SIZE,
	);
	const requestedMax = options.maxEvents ?? DEFAULT_ARCHIVE_MAX_EVENTS;
	const maxEvents =
		Number.isFinite(requestedMax) && requestedMax > 0
			? Math.floor(requestedMax)
			: DEFAULT_ARCHIVE_MAX_EVENTS;

	let cursor: ArchiveCursor | null = null;
	let emitted = 0;
	for (;;) {
		if (signal?.aborted === true) return;
		const page = await archive.page({
			region,
			logGroups,
			startTime,
			endTime,
			search,
			streamPrefix,
			levels,
			after: cursor,
			limit: pageSize,
		});
		if (page.events.length === 0) {
			yield { type: 'end', reason: 'window-complete' };
			return;
		}
		emitted += page.events.length;
		// `origin` marks these as already archived, so a view that mixes the two
		// sources never writes them back.
		yield { type: 'events', events: page.events, origin: 'archive' };
		cursor = page.last;
		// A short page or an unusable cursor means there is nothing left to read.
		if (cursor === null || page.events.length < pageSize) {
			yield { type: 'end', reason: 'window-complete' };
			return;
		}
		if (emitted >= maxEvents) {
			yield { type: 'end', reason: 'event-limit' };
			return;
		}
	}
}
