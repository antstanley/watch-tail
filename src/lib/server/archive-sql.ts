/**
 * SQL and row mapping for the local DuckDB archive.
 *
 * DuckDB is a native dependency and is loaded lazily by `archive.ts`; everything
 * in this file is plain text and pure functions so the archive can be unit
 * tested without the driver. Column order matters: {@link ARCHIVE_INSERT_COLUMNS}
 * is the contract with {@link toArchiveParams}, and the `SELECT` in
 * {@link buildPageQuery} uses the same names as {@link rowsToPage}.
 *
 * `level` and `request_id` are both derived from the message on the way in, and
 * both may be NULL in an archive written by an older build. NULL does not mean
 * the same thing for the two columns: for `level` it is a verdict ("this line
 * carries no level"), while for `request_id` it means "not looked at yet", since
 * the client can still detect an id in the message it renders. {@link rowsToPage}
 * and the request-id backfill below are written from that difference.
 */
import { eventDurationMs } from '$lib/request-duration';
import { createHash } from 'node:crypto';
import {
	LEVEL_RANK,
	detectLevelWithSource,
	detectRequestId,
	isLogLevel,
	type LogLevel,
} from '$lib/log-buffer';
import type { LogEventDto, SeriesGroupBy, SeriesLevel, SeriesMetric } from '$lib/types';

/** A value that can be bound to a `?` placeholder. */
export type ArchiveParam = string | number | bigint | null;

/**
 * Statements that bring a database file up to the current schema.
 *
 * Every statement is idempotent so an existing archive can be opened by a newer
 * build without a migration step. `seq` orders events by arrival, which keeps
 * paging stable when many events share a millisecond timestamp.
 */
export const ARCHIVE_SCHEMA: readonly string[] = [
	`CREATE SEQUENCE IF NOT EXISTS log_events_seq`,
	`CREATE TABLE IF NOT EXISTS log_events (
		region VARCHAR NOT NULL,
		log_group VARCHAR NOT NULL,
		log_stream VARCHAR,
		event_key VARCHAR NOT NULL,
		event_id VARCHAR,
		timestamp_ms BIGINT NOT NULL,
		ingestion_time_ms BIGINT,
		message VARCHAR NOT NULL,
		level VARCHAR,
		level_source VARCHAR,
		request_id VARCHAR,
		seq BIGINT NOT NULL DEFAULT nextval('log_events_seq'),
		archived_at TIMESTAMP NOT NULL DEFAULT now()
	)`,
	// Additive migration for files written before the level columns existed; a
	// fresh table already has them, and `IF NOT EXISTS` makes both paths safe.
	`ALTER TABLE log_events ADD COLUMN IF NOT EXISTS level VARCHAR`,
	`ALTER TABLE log_events ADD COLUMN IF NOT EXISTS level_source VARCHAR`,
	`ALTER TABLE log_events ADD COLUMN IF NOT EXISTS request_id VARCHAR`,
	// State that belongs to the file rather than to a log line. It holds the
	// request-id backfill watermark: the highest `seq` the one-time migration of
	// pre-column archives has reached, so an interrupted run resumes there.
	`CREATE TABLE IF NOT EXISTS archive_meta (key VARCHAR PRIMARY KEY, value VARCHAR)`,
	// The time ranges the archive is known to hold, per log group. A range is
	// recorded only for an unfiltered CloudWatch scan that ran to completion, so
	// "covered" means "watch-tail queried CloudWatch over this range", which is
	// what lets a later view read history from here instead of calling AWS.
	`CREATE TABLE IF NOT EXISTS archive_coverage (
		region VARCHAR NOT NULL,
		log_group VARCHAR NOT NULL,
		start_ms BIGINT NOT NULL,
		end_ms BIGINT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS archive_coverage_key ON archive_coverage (region, log_group, start_ms)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS log_events_unique ON log_events (region, log_group, event_key)`,
	`CREATE INDEX IF NOT EXISTS log_events_time ON log_events (region, log_group, timestamp_ms)`,
];

/** Columns written by {@link buildInsertSql}, in binding order. */
export const ARCHIVE_INSERT_COLUMNS: readonly string[] = [
	'region',
	'log_group',
	'log_stream',
	'event_key',
	'event_id',
	'timestamp_ms',
	'ingestion_time_ms',
	'message',
	'level',
	'level_source',
	// Detected fields are appended last so a reader can pair a parameter with its
	// column by reading the list from the top.
	'request_id',
];

/** Largest number of rows in one `INSERT`; longer batches are chunked. */
export const ARCHIVE_INSERT_CHUNK = 500;

/** Escape character used with `LIKE`/`ILIKE` so user input cannot inject wildcards. */
const LIKE_ESCAPE = '\\';

/**
 * Stable identity of an event inside one log group.
 *
 * CloudWatch event ids are unique per log group and are reused as the key;
 * events without an id (floci and LocalStack omit them) get a deterministic
 * hash of timestamp, stream and message, so re-scanning the same window is
 * idempotent instead of duplicating rows.
 */
export function archiveEventKey(event: LogEventDto): string {
	if (event.id !== null && event.id.length > 0) return event.id;
	const digest = createHash('sha256')
		.update(`${event.timestamp}\u0000${event.streamName ?? ''}\u0000${event.message}`)
		.digest('hex');
	return `h:${digest.slice(0, 32)}`;
}

/** Renders `count` placeholder rows, one group of columns per row. */
function placeholderRows(count: number): string {
	const row = `(${ARCHIVE_INSERT_COLUMNS.map(() => '?').join(', ')})`;
	return Array.from({ length: count }, () => row).join(', ');
}

/**
 * Builds a multi-row `INSERT OR IGNORE`, so events already archived are skipped
 * by the unique index instead of raising.
 */
export function buildInsertSql(rowCount: number): string {
	if (!Number.isInteger(rowCount) || rowCount < 1) {
		throw new RangeError(`rowCount must be a positive integer, received ${String(rowCount)}`);
	}
	return `INSERT OR IGNORE INTO log_events (${ARCHIVE_INSERT_COLUMNS.join(', ')}) VALUES ${placeholderRows(rowCount)}`;
}

/**
 * Flattens events into the parameter list {@link buildInsertSql} expects.
 *
 * The request id is detected here, exactly like the level, so the archive holds
 * what a reader of the line would see rather than whatever a writer claimed.
 */
export function toArchiveParams(
	region: string,
	logGroup: string,
	events: readonly LogEventDto[],
): ArchiveParam[] {
	const params: ArchiveParam[] = [];
	for (const event of events) {
		// The level is detected once, on the way in: a declared payload level wins
		// over the text heuristic, and a line with no signal is stored as NULL
		// rather than being labelled `info`.
		const detected = detectLevelWithSource(event.message);
		params.push(
			region,
			logGroup,
			event.streamName ?? null,
			archiveEventKey(event),
			event.id ?? null,
			BigInt(Math.round(event.timestamp)),
			event.ingestionTime === undefined ? null : BigInt(Math.round(event.ingestionTime)),
			event.message,
			detected.level,
			detected.source,
			// A line with no request id is stored as NULL, never as an empty string:
			// "no id" and "an id that happens to be empty" must not look alike.
			detectRequestId(event.message),
		);
	}
	return params;
}

/** Position of the last row of a page: timestamps repeat, `seq` never does. */
export type ArchiveCursor = { timestamp: number; seq: number };

/** One page of archived events. */
export type ArchivePageRequest = {
	region: string;
	/** Log groups to read; one statement covers all of them. */
	logGroups: readonly string[];
	startTime: number;
	endTime: number;
	/** Case-insensitive substring of the message, or `null` for everything. */
	search?: string | null;
	/** Log stream name prefix, or `null` for every stream. */
	streamPrefix?: string | null;
	/** Levels to include, or `null` for every level. */
	levels?: readonly LogLevel[] | null;
	/** Skip events up to and including this cursor, or `null` for the first page. */
	after?: ArchiveCursor | null;
	limit: number;
};

/** Column list shared by {@link buildPageQuery} and {@link rowsToPage}. */
const PAGE_COLUMNS = `region, log_group, log_stream, event_key, event_id, timestamp_ms, ingestion_time_ms, message, level, level_source, request_id, seq`;

/** Escapes `LIKE` metacharacters so a search term is matched literally. */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `${LIKE_ESCAPE}${match}`);
}

/**
 * Builds one keyset page of archived events.
 *
 * Ordering is `(timestamp_ms, seq)`, and the cursor compares the same tuple, so
 * pages never repeat or skip a row even when thousands of events share a
 * timestamp.
 */
export function buildPageQuery(request: ArchivePageRequest): {
	sql: string;
	params: ArchiveParam[];
} {
	const limit = Math.max(1, Math.round(request.limit));
	const groups = request.logGroups.length > 0 ? request.logGroups : [''];
	const where: string[] = [
		'region = ?',
		`log_group IN (${groups.map(() => '?').join(', ')})`,
		'timestamp_ms >= ?',
		'timestamp_ms <= ?',
	];
	const params: ArchiveParam[] = [
		request.region,
		...groups,
		BigInt(Math.round(request.startTime)),
		BigInt(Math.round(request.endTime)),
	];

	const search = request.search?.trim() ?? '';
	if (search.length > 0) {
		where.push(`message ILIKE ? ESCAPE '${LIKE_ESCAPE}'`);
		params.push(`%${escapeLike(search)}%`);
	}
	const prefix = request.streamPrefix?.trim() ?? '';
	if (prefix.length > 0) {
		where.push(`log_stream LIKE ? ESCAPE '${LIKE_ESCAPE}'`);
		params.push(`${escapeLike(prefix)}%`);
	}
	const levels = request.levels ?? [];
	if (levels.length > 0) {
		// A level filter is an explicit request for known levels, so rows whose
		// level is NULL are left out rather than silently included.
		where.push(`level IN (${levels.map(() => '?').join(', ')})`);
		params.push(...levels);
	}
	const after = request.after ?? null;
	if (after !== null) {
		where.push('(timestamp_ms > ? OR (timestamp_ms = ? AND seq > ?))');
		params.push(
			BigInt(Math.round(after.timestamp)),
			BigInt(Math.round(after.timestamp)),
			BigInt(Math.round(after.seq)),
		);
	}
	params.push(BigInt(limit));

	return {
		sql: `SELECT ${PAGE_COLUMNS} FROM log_events WHERE ${where.join(' AND ')} ORDER BY timestamp_ms, seq LIMIT ?`,
		params,
	};
}

/** Converts a DuckDB value (which may be a bigint) into a JS number. */
function toNumber(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'bigint') return Number(value);
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** Converts a nullable DuckDB string column into `string` or `null`. */
function toNullableString(value: unknown): string | null {
	if (typeof value === 'string') return value.length > 0 ? value : null;
	return null;
}

/** Reads one column from a row object, tolerating case differences. */
function pick(row: Record<string, unknown>, column: string): unknown {
	if (column in row) return row[column];
	const upper = column.toUpperCase();
	if (upper in row) return row[upper];
	return undefined;
}

/**
 * Maps query rows onto wire events plus the cursor of the last row.
 *
 * Rows without a usable timestamp are dropped rather than rendered as 1970.
 */
export function rowsToPage(rows: readonly Record<string, unknown>[]): {
	events: LogEventDto[];
	last: ArchiveCursor | null;
} {
	const events: LogEventDto[] = [];
	let last: ArchiveCursor | null = null;
	for (const row of rows) {
		const timestamp = toNumber(pick(row, 'timestamp_ms'));
		const seq = toNumber(pick(row, 'seq'));
		if (timestamp === null || seq === null) continue;
		const rawLevel = pick(row, 'level');
		const group = toNullableString(pick(row, 'log_group'));
		const event: LogEventDto = {
			id: toNullableString(pick(row, 'event_key')),
			timestamp,
			message: typeof pick(row, 'message') === 'string' ? (pick(row, 'message') as string) : '',
			// Explicit `null` on the wire: the archive knows the line has no level,
			// which is different from a client that never asked.
			level: isLogLevel(rawLevel) ? rawLevel : null,
		};
		if (group !== null) event.group = group;
		// A stored request id is sent only when there is one. An archive written
		// before the column existed holds NULL for every row, and the client can
		// still detect an id in the message it renders, so "no stored id" must not
		// be sent as a verdict. That is the opposite of `level`, where NULL is the
		// archive's own answer and is sent as an explicit `null`.
		const requestId = toNullableString(pick(row, 'request_id'));
		if (requestId !== null) event.requestId = requestId;
		const streamName = toNullableString(pick(row, 'log_stream'));
		if (streamName !== null) event.streamName = streamName;
		const ingestionTime = toNumber(pick(row, 'ingestion_time_ms'));
		if (ingestionTime !== null) event.ingestionTime = ingestionTime;
		events.push(event);
		last = { timestamp, seq };
	}
	return { events, last };
}

/** Totals shown by `GET /api/archive`. */
export type ArchiveTotals = {
	rows: number;
	groups: number;
	regions: number;
	oldest: number | null;
	newest: number | null;
};

/** One log group held by the archive. */
export type ArchiveGroupRow = {
	region: string;
	logGroup: string;
	events: number;
	oldest: number | null;
	newest: number | null;
};

/** Aggregate query behind {@link ArchiveTotals}. */
export const ARCHIVE_TOTALS_SQL = `SELECT count(*) AS rows, count(DISTINCT log_group) AS groups, count(DISTINCT region) AS regions, min(timestamp_ms) AS oldest, max(timestamp_ms) AS newest FROM log_events`;

/** Log groups held by the archive, optionally limited to one region. */
export function buildGroupsQuery(region: string | null): {
	sql: string;
	params: ArchiveParam[];
} {
	const where = region === null || region.length === 0 ? '' : 'WHERE region = ?';
	return {
		sql: `SELECT region, log_group, count(*) AS events, min(timestamp_ms) AS oldest, max(timestamp_ms) AS newest FROM log_events ${where} GROUP BY region, log_group ORDER BY region, log_group`,
		params: where === '' ? [] : [region],
	};
}

/** Maps the single row of {@link ARCHIVE_TOTALS_SQL}. */
export function rowToTotals(row: Record<string, unknown> | undefined): ArchiveTotals {
	if (row === undefined) return { rows: 0, groups: 0, regions: 0, oldest: null, newest: null };
	return {
		rows: toNumber(pick(row, 'rows')) ?? 0,
		groups: toNumber(pick(row, 'groups')) ?? 0,
		regions: toNumber(pick(row, 'regions')) ?? 0,
		oldest: toNumber(pick(row, 'oldest')),
		newest: toNumber(pick(row, 'newest')),
	};
}

/** Maps the rows of {@link buildGroupsQuery}. */
export function rowsToGroups(rows: readonly Record<string, unknown>[]): ArchiveGroupRow[] {
	const groups: ArchiveGroupRow[] = [];
	for (const row of rows) {
		const region = pick(row, 'region');
		const logGroup = pick(row, 'log_group');
		if (typeof region !== 'string' || typeof logGroup !== 'string') continue;
		groups.push({
			region,
			logGroup,
			events: toNumber(pick(row, 'events')) ?? 0,
			oldest: toNumber(pick(row, 'oldest')),
			newest: toNumber(pick(row, 'newest')),
		});
	}
	return groups;
}

/**
 * A contiguous range of time the archive is known to hold for one log group.
 *
 * `start` and `end` are inclusive epoch milliseconds.
 */
export type CoverageInterval = { start: number; end: number };

/** One group's coverage, as used when recording it. */
export type CoverageEntry = CoverageInterval & { logGroup: string };

/** Drops intervals that are not a usable, ordered range. */
function isUsableInterval(interval: CoverageInterval): boolean {
	return (
		Number.isFinite(interval.start) &&
		Number.isFinite(interval.end) &&
		interval.end >= interval.start
	);
}

/**
 * Merges overlapping or adjacent intervals into the fewest ranges.
 *
 * Adjacency counts (`next.start === current.end + 1`) so two scans that met
 * exactly leave one range rather than two, which keeps the table small. The
 * input is not mutated.
 */
export function mergeCoverage(intervals: readonly CoverageInterval[]): CoverageInterval[] {
	const sorted = intervals
		.filter(isUsableInterval)
		.map((interval) => ({ start: interval.start, end: interval.end }))
		.toSorted((a, b) => a.start - b.start || a.end - b.end);
	const merged: CoverageInterval[] = [];
	for (const interval of sorted) {
		const last = merged.at(-1);
		if (last !== undefined && interval.start <= last.end + 1) {
			if (interval.end > last.end) last.end = interval.end;
		} else {
			merged.push(interval);
		}
	}
	return merged;
}

/** The parts of `[start, end]` that `intervals` do cover, clipped to the range. */
export function intersectCoverage(
	start: number,
	end: number,
	intervals: readonly CoverageInterval[],
): CoverageInterval[] {
	const covered: CoverageInterval[] = [];
	for (const interval of mergeCoverage(intervals)) {
		const clippedStart = Math.max(start, interval.start);
		const clippedEnd = Math.min(end, interval.end);
		if (clippedStart <= clippedEnd) covered.push({ start: clippedStart, end: clippedEnd });
	}
	return covered;
}

/** The parts of `[start, end]` that `intervals` do not cover, in order. */
export function subtractCoverage(
	start: number,
	end: number,
	intervals: readonly CoverageInterval[],
): CoverageInterval[] {
	const uncovered: CoverageInterval[] = [];
	let cursor = start;
	for (const interval of mergeCoverage(intervals)) {
		if (interval.end < cursor) continue;
		if (interval.start > end) break;
		if (interval.start > cursor) uncovered.push({ start: cursor, end: interval.start - 1 });
		cursor = Math.max(cursor, interval.end + 1);
		if (cursor > end) return uncovered;
	}
	if (cursor <= end) uncovered.push({ start: cursor, end });
	return uncovered;
}

/**
 * How long CloudWatch is given to finish ingesting a moment before a read of it
 * counts as complete.
 *
 * Events can be ingested well after their timestamp (agents batch and retry), so
 * a range read at time `t` is only trusted up to `t - COVERAGE_SETTLE_MS`. The
 * rest of the range is left uncovered and is fetched from CloudWatch again next
 * time, which is what keeps a late event from being hidden behind the archive.
 */
export const COVERAGE_SETTLE_MS = 5 * 60_000;

/**
 * The part of a read range that had settled when it was read, or `null`.
 *
 * `readAt` is when the CloudWatch query started: anything newer than
 * `readAt - settleMs` may still have been arriving.
 */
export function settleCoverage(
	interval: CoverageInterval,
	readAt: number,
	settleMs: number = COVERAGE_SETTLE_MS,
): CoverageInterval | null {
	const settled = { start: interval.start, end: Math.min(interval.end, readAt - settleMs) };
	return isUsableInterval(settled) ? settled : null;
}

/** Reads the coverage intervals of several groups that overlap a window. */
export function buildCoverageQuery(
	region: string,
	logGroups: readonly string[],
	start: number,
	end: number,
): { sql: string; params: ArchiveParam[] } {
	const groups = logGroups.length > 0 ? logGroups : [''];
	return {
		sql: `SELECT log_group, start_ms, end_ms FROM archive_coverage WHERE region = ? AND log_group IN (${groups.map(() => '?').join(', ')}) AND end_ms >= ? AND start_ms <= ? ORDER BY log_group, start_ms`,
		params: [region, ...groups, BigInt(Math.round(start)), BigInt(Math.round(end))],
	};
}

/** Maps rows of `start_ms`/`end_ms` onto coverage intervals. */
export function rowsToCoverage(rows: readonly Record<string, unknown>[]): CoverageInterval[] {
	const intervals: CoverageInterval[] = [];
	for (const row of rows) {
		const start = toNumber(pick(row, 'start_ms'));
		const end = toNumber(pick(row, 'end_ms'));
		if (start !== null && end !== null) intervals.push({ start, end });
	}
	return intervals;
}

/** Maps {@link buildCoverageQuery} rows onto merged intervals per log group. */
export function rowsToCoverageByGroup(
	rows: readonly Record<string, unknown>[],
): Map<string, CoverageInterval[]> {
	const byGroup = new Map<string, CoverageInterval[]>();
	for (const row of rows) {
		const group = pick(row, 'log_group');
		const start = toNumber(pick(row, 'start_ms'));
		const end = toNumber(pick(row, 'end_ms'));
		if (typeof group !== 'string' || start === null || end === null) continue;
		const list = byGroup.get(group);
		if (list === undefined) byGroup.set(group, [{ start, end }]);
		else list.push({ start, end });
	}
	for (const [group, intervals] of byGroup) byGroup.set(group, mergeCoverage(intervals));
	return byGroup;
}

/** Every coverage interval of one group, for a merge-on-write. */
export function buildCoverageGroupQuery(
	region: string,
	logGroup: string,
): { sql: string; params: ArchiveParam[] } {
	return {
		sql: 'SELECT start_ms, end_ms FROM archive_coverage WHERE region = ? AND log_group = ? ORDER BY start_ms',
		params: [region, logGroup],
	};
}

/** Removes every coverage interval of one group, before the merged set is written. */
export function buildCoverageDeleteQuery(
	region: string,
	logGroup: string,
): { sql: string; params: ArchiveParam[] } {
	return {
		sql: 'DELETE FROM archive_coverage WHERE region = ? AND log_group = ?',
		params: [region, logGroup],
	};
}

/** Builds a multi-row insert of coverage intervals. */
export function buildCoverageInsert(rowCount: number): string {
	if (!Number.isInteger(rowCount) || rowCount < 1) {
		throw new RangeError(`rowCount must be a positive integer, received ${String(rowCount)}`);
	}
	const row = '(?, ?, ?, ?)';
	return `INSERT INTO archive_coverage (region, log_group, start_ms, end_ms) VALUES ${Array.from({ length: rowCount }, () => row).join(', ')}`;
}

/** Flattens merged intervals into the parameters {@link buildCoverageInsert} expects. */
export function toCoverageParams(
	region: string,
	logGroup: string,
	intervals: readonly CoverageInterval[],
): ArchiveParam[] {
	const params: ArchiveParam[] = [];
	for (const interval of intervals) {
		params.push(
			region,
			logGroup,
			BigInt(Math.round(interval.start)),
			BigInt(Math.round(interval.end)),
		);
	}
	return params;
}

/**
 * Row budget of one request-id backfill pass.
 *
 * The pass runs on every open, so it has to stay cheap. 20000 messages is a
 * fraction of a second of regex work, and an archive with more than that scans
 * the rest on the next open, because the watermark moves.
 */
export const REQUEST_ID_BACKFILL_LIMIT = 20_000;

/** `archive_meta` key holding the request-id backfill watermark. */
const REQUEST_ID_BACKFILL_KEY = 'request_id_backfill';

/** Highest `seq` in the archive: the ceiling of a backfill pass. */
export const ARCHIVE_MAX_SEQ_SQL = `SELECT max(seq) AS maxSeq FROM log_events`;

/** Reads the single row of {@link ARCHIVE_MAX_SEQ_SQL}; `null` for an empty archive. */
export function rowToMaxSeq(row: Record<string, unknown> | undefined): number | null {
	return row === undefined ? null : toNumber(pick(row, 'maxSeq'));
}

/** Statement that reads the backfill watermark; no row means it never ran. */
export function buildRequestIdBackfillStateQuery(): string {
	return `SELECT value FROM archive_meta WHERE key = '${REQUEST_ID_BACKFILL_KEY}'`;
}

/** Statement that stores the backfill watermark, which is the highest scanned `seq`. */
export function buildRequestIdBackfillStateWrite(): string {
	return `INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('${REQUEST_ID_BACKFILL_KEY}', ?)`;
}

/** Reads the watermark row; an absent row or junk means "scan from the start". */
export function rowToBackfillWatermark(row: Record<string, unknown> | undefined): number | null {
	const value = row === undefined ? null : toNumber(pick(row, 'value'));
	return value === null || value < 0 ? null : value;
}

/** One archived row the backfill has to look at. */
export type RequestIdBackfillCandidate = {
	/** Arrival order of the row; the watermark is a `seq`. */
	seq: number;
	region: string;
	logGroup: string;
	eventKey: string;
	message: string;
};

/** One row whose request id has been detected and must be written back. */
export type RequestIdBackfillUpdate = {
	region: string;
	logGroup: string;
	eventKey: string;
	requestId: string;
};

/** Bound of one backfill scan. */
export type RequestIdBackfillScan = {
	/** Highest `seq` the pass may look at. */
	maxSeq: number;
	/** Watermark of the previous pass: rows at or below it were looked at already. */
	afterSeq?: number | null;
	/** Maximum number of rows to look at. */
	limit: number;
};

/**
 * Builds the scan that finds rows archived before `request_id` existed.
 *
 * `seq` is selected although the update does not need it: the caller stores
 * where the pass stopped. `afterSeq` skips the range a previous pass already
 * looked at, which is what lets a capped pass resume - a message with no request
 * id stays NULL for ever, so without the lower bound every pass would start on
 * the same id-less rows and never reach the rows above them.
 */
export function buildRequestIdBackfillQuery(request: RequestIdBackfillScan): {
	sql: string;
	params: ArchiveParam[];
} {
	const limit = Math.max(1, Math.round(request.limit));
	// A watermark of 0 is where the first pass starts, so it adds no clause.
	const scanned = request.afterSeq ?? 0;
	const after = scanned > 0 ? ' AND seq > ?' : '';
	const params: ArchiveParam[] = [BigInt(Math.round(request.maxSeq))];
	if (scanned > 0) params.push(BigInt(Math.round(scanned)));
	params.push(BigInt(limit));
	return {
		sql: `SELECT event_key, log_group, region, message, seq FROM log_events WHERE seq <= ?${after} AND request_id IS NULL ORDER BY seq LIMIT ?`,
		params,
	};
}

/** Maps the rows of {@link buildRequestIdBackfillQuery}, dropping unusable ones. */
export function rowsToBackfillCandidates(
	rows: readonly Record<string, unknown>[],
): RequestIdBackfillCandidate[] {
	const candidates: RequestIdBackfillCandidate[] = [];
	for (const row of rows) {
		const seq = toNumber(pick(row, 'seq'));
		const region = pick(row, 'region');
		const logGroup = pick(row, 'log_group');
		const eventKey = pick(row, 'event_key');
		const message = pick(row, 'message');
		if (
			seq === null ||
			typeof region !== 'string' ||
			typeof logGroup !== 'string' ||
			typeof eventKey !== 'string' ||
			typeof message !== 'string'
		) {
			continue;
		}
		candidates.push({ seq, region, logGroup, eventKey, message });
	}
	return candidates;
}

/** Highest `seq` of a scanned set, or `null` when nothing was scanned. */
export function maxSeqOf(candidates: readonly RequestIdBackfillCandidate[]): number | null {
	let highest: number | null = null;
	for (const candidate of candidates) {
		if (highest === null || candidate.seq > highest) highest = candidate.seq;
	}
	return highest;
}

/**
 * Detects the request id of every candidate.
 *
 * A message that yields no id is dropped rather than written as an empty string:
 * it is a finished row, not a failure, and the watermark moves past it so it is
 * never looked at again.
 */
export function planRequestIdBackfill(
	candidates: readonly RequestIdBackfillCandidate[],
): RequestIdBackfillUpdate[] {
	const updates: RequestIdBackfillUpdate[] = [];
	for (const candidate of candidates) {
		const requestId = detectRequestId(candidate.message);
		if (requestId === null) continue;
		updates.push({
			region: candidate.region,
			logGroup: candidate.logGroup,
			eventKey: candidate.eventKey,
			requestId,
		});
	}
	return updates;
}

/**
 * Builds one `UPDATE ... FROM (VALUES ...)` that writes many ids at once.
 *
 * One statement per chunk instead of one per row keeps a 20000-row pass down to
 * a handful of statements, and the predicate is an exact row match on the unique
 * index (`region`, `log_group`, `event_key`).
 */
export function buildRequestIdBackfillUpdate(rowCount: number): string {
	if (!Number.isInteger(rowCount) || rowCount < 1) {
		throw new RangeError(`rowCount must be a positive integer, received ${String(rowCount)}`);
	}
	const rows = Array.from({ length: rowCount }, () => '(?, ?, ?, ?)').join(', ');
	return `UPDATE log_events SET request_id = v.request_id FROM (VALUES ${rows}) AS v(region, log_group, event_key, request_id) WHERE log_events.region = v.region AND log_events.log_group = v.log_group AND log_events.event_key = v.event_key`;
}

/** Flattens updates into the parameter list {@link buildRequestIdBackfillUpdate} expects. */
export function toRequestIdBackfillParams(
	updates: readonly RequestIdBackfillUpdate[],
): ArchiveParam[] {
	const params: ArchiveParam[] = [];
	for (const update of updates) {
		params.push(update.region, update.logGroup, update.eventKey, update.requestId);
	}
	return params;
}

/** One bucket of the chart series query. */
export type ArchiveSeriesRow = {
	durationMs?: number;
	requestId?: string;
	/** Bucket start, epoch ms. */
	t: number;
	group: string;
	/** Level of the events in this bucket; `unknown` when the level is NULL. */
	level: SeriesLevel;
	/** Events in the bucket, or requests when the query counted requests. */
	events: number;
};

/** Request for {@link buildSeriesQuery}. */
export type ArchiveSeriesRequest = {
	metric?: SeriesMetric;
	region: string;
	logGroups: readonly string[];
	startTime: number;
	endTime: number;
	/** Bucket width in ms; the caller derives it from the window. */
	bucketMs: number;
	/** Levels to count, or `null` for every level. */
	levels?: readonly LogLevel[] | null;
	/**
	 * What one mark counts. `event` (the default) counts lines, which is the
	 * statement this app has always run; `request` counts requests, so an incident
	 * reads as the number of affected requests instead of the number of lines
	 * they wrote.
	 */
	by?: SeriesGroupBy;
};

/** Levels and their rank, highest first; `unknown` is left to the `ELSE` branch. */
function rankArms(): [string, number][] {
	return Object.entries(LEVEL_RANK).filter(([level]) => level !== 'unknown');
}

/**
 * SQL `CASE` that turns a level into its severity rank.
 *
 * Generated from {@link LEVEL_RANK} so the ranks have one source of truth: the
 * statement and the UI cannot disagree about which level is worse.
 */
function levelRankCase(expression: string): string {
	const arms = rankArms().map(([level, rank]) => `WHEN '${level}' THEN ${rank}`);
	return `CASE ${expression} ${arms.join(' ')} ELSE ${LEVEL_RANK.unknown} END`;
}

/** SQL `CASE` that turns a severity rank back into a level name. */
function levelNameCase(expression: string): string {
	const arms = rankArms().map(([level, rank]) => `WHEN ${rank} THEN '${level}'`);
	return `CASE ${expression} ${arms.join(' ')} ELSE 'unknown' END`;
}

/** The `WHERE` clause both series forms share: one region, one window, one or more groups. */
function seriesScope(
	request: ArchiveSeriesRequest,
	groups: readonly string[],
): { where: string[]; params: ArchiveParam[] } {
	return {
		where: [
			'region = ?',
			`log_group IN (${groups.map(() => '?').join(', ')})`,
			'timestamp_ms >= ?',
			'timestamp_ms <= ?',
		],
		params: [
			request.region,
			...groups,
			BigInt(Math.round(request.startTime)),
			BigInt(Math.round(request.endTime)),
		],
	};
}

/**
 * Builds the bucketed counts behind the chart.
 *
 * One statement returns every series. The bucket is plain integer arithmetic on
 * `timestamp_ms`, so it cannot drift with a time zone; NULL levels are reported
 * as `unknown` rather than dropped; and a level filter matches only rows that
 * carry one of the requested levels.
 *
 * `by: 'request'` selects the request form below; `by: 'event'` (the default)
 * keeps the event form unchanged.
 */
export function buildSeriesQuery(request: ArchiveSeriesRequest): {
	sql: string;
	params: ArchiveParam[];
} {
	const bucketMs = Math.max(1, Math.round(request.bucketMs));
	const groups = request.logGroups.length > 0 ? request.logGroups : [''];
	const scope = seriesScope(request, groups);
	if (request.metric === 'duration')
		return buildDurationSeriesQuery(request, scope.where, scope.params);
	if (request.by === 'request') {
		return buildRequestSeriesQuery(request, bucketMs, scope.where, scope.params);
	}
	// Bind order follows the statement: the bucket arithmetic appears in the
	// SELECT clause before the `WHERE`, so its two placeholders come first.
	const params: ArchiveParam[] = [BigInt(bucketMs), BigInt(bucketMs), ...scope.params];
	const where = scope.where.slice();
	const levels = request.levels ?? [];
	if (levels.length > 0) {
		where.push(`level IN (${levels.map(() => '?').join(', ')})`);
		params.push(...levels);
	}
	return {
		sql: `SELECT CAST(floor(timestamp_ms / ?) * ? AS BIGINT) AS bucket, log_group, coalesce(level, 'unknown') AS level, count(*) AS events FROM log_events WHERE ${where.join(' AND ')} GROUP BY bucket, log_group, level ORDER BY bucket, log_group, level`,
		params,
	};
}

/**
 * Builds the request form: one mark per request instead of one per line.
 *
 * `coalesce(request_id, event_key)` makes a line with no request id a request of
 * its own, so no line is dropped. A request is placed at its FIRST line
 * (`min(timestamp_ms)`) and counted once, and it takes the WORST level of its
 * lines (`max` of the ranks). A level filter selects on that same worst level in
 * the `HAVING`: asking for errors keeps every request that logged one, whatever
 * else it logged, and drops the requests that stayed below it.
 *
 * BIND ORDER: DuckDB binds `?` positionally in statement text order, and the CTE
 * comes first, so the parameters are the scope ones, then one rank per requested
 * level (the RANKS, not the level names), and the bucket width LAST - the
 * opposite of the event form above.
 */
function buildRequestSeriesQuery(
	request: ArchiveSeriesRequest,
	bucketMs: number,
	where: readonly string[],
	scopeParams: readonly ArchiveParam[],
): { sql: string; params: ArchiveParam[] } {
	const levels = request.levels ?? [];
	const having =
		levels.length > 0 ? ` HAVING level_rank IN (${levels.map(() => '?').join(', ')})` : '';
	const params: ArchiveParam[] = [
		...scopeParams,
		...levels.map((level) => LEVEL_RANK[level]),
		BigInt(bucketMs),
		BigInt(bucketMs),
	];
	const sql = [
		'WITH requests AS (',
		`SELECT coalesce(request_id, event_key) AS request_key, log_group, min(timestamp_ms) AS start_ms, max(${levelRankCase(`coalesce(level, 'unknown')`)}) AS level_rank`,
		`FROM log_events WHERE ${where.join(' AND ')}`,
		`GROUP BY request_key, log_group${having})`,
		`SELECT CAST(floor(start_ms / ?) * ? AS BIGINT) AS bucket, log_group, ${levelNameCase('level_rank')} AS level, count(*) AS events`,
		'FROM requests GROUP BY bucket, log_group, level ORDER BY bucket, log_group, level',
	].join(' ');
	return { sql, params };
}

/** Duration points are not bucketed: one point at each request's first observed timestamp. */
function buildDurationSeriesQuery(
	request: ArchiveSeriesRequest,
	where: readonly string[],
	scopeParams: readonly ArchiveParam[],
): { sql: string; params: ArchiveParam[] } {
	const levels = request.levels ?? [];
	const having = levels.length ? ` HAVING level_rank IN (${levels.map(() => '?').join(', ')})` : '';
	return {
		sql: `WITH requests AS (
			SELECT request_id, log_group, min(timestamp_ms) AS start_ms,
			max(timestamp_ms) - min(timestamp_ms) AS duration_ms,
			first(message ORDER BY timestamp_ms DESC, seq DESC) AS last_message,
			max(${levelRankCase("coalesce(level, 'unknown')")}) AS level_rank
			FROM log_events WHERE ${where.join(' AND ')} AND request_id IS NOT NULL AND request_id <> ''
			GROUP BY request_id, log_group${having})
			SELECT start_ms AS bucket, log_group, ${levelNameCase('level_rank')} AS level,
			1 AS events, request_id, duration_ms, last_message FROM requests ORDER BY bucket, log_group, request_id`,
		params: [...scopeParams, ...levels.map((level) => LEVEL_RANK[level])],
	};
}

/** Maps the rows of {@link buildSeriesQuery} onto chart points. */
export function rowsToSeries(rows: readonly Record<string, unknown>[]): ArchiveSeriesRow[] {
	const points: ArchiveSeriesRow[] = [];
	for (const row of rows) {
		const t = toNumber(pick(row, 'bucket'));
		const group = pick(row, 'log_group');
		const level = pick(row, 'level');
		if (t === null || typeof group !== 'string') continue;
		points.push({
			t,
			group,
			level: typeof level === 'string' && level.length > 0 ? (level as SeriesLevel) : 'unknown',
			events: toNumber(pick(row, 'events')) ?? 0,
			...(typeof row.request_id === 'string'
				? {
						requestId: row.request_id,
						durationMs:
							(toNumber(row.duration_ms) ?? 0) +
							eventDurationMs(typeof row.last_message === 'string' ? row.last_message : ''),
					}
				: {}),
		});
	}
	return points;
}
