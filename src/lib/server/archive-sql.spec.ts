import { describe, expect, test } from 'vitest';
import {
	ARCHIVE_INSERT_CHUNK,
	ARCHIVE_INSERT_COLUMNS,
	ARCHIVE_MAX_SEQ_SQL,
	ARCHIVE_SCHEMA,
	ARCHIVE_TOTALS_SQL,
	archiveEventKey,
	buildCoverageDeleteQuery,
	buildCoverageGroupQuery,
	buildCoverageInsert,
	buildCoverageQuery,
	buildGroupsQuery,
	buildInsertSql,
	buildPageQuery,
	buildRequestIdBackfillQuery,
	buildRequestIdBackfillStateQuery,
	buildRequestIdBackfillStateWrite,
	buildRequestIdBackfillUpdate,
	buildSeriesQuery,
	escapeLike,
	intersectCoverage,
	maxSeqOf,
	mergeCoverage,
	planRequestIdBackfill,
	rowToBackfillWatermark,
	rowToMaxSeq,
	rowToTotals,
	rowsToBackfillCandidates,
	rowsToCoverage,
	rowsToCoverageByGroup,
	rowsToGroups,
	rowsToPage,
	rowsToSeries,
	subtractCoverage,
	toArchiveParams,
	toCoverageParams,
	toRequestIdBackfillParams,
} from './archive-sql';
import type { LogEventDto } from '$lib/types';

const REGION = 'af-south-1';
const GROUP = '/aws/lambda/checkout';
const TS = Date.UTC(2024, 4, 17, 12, 0, 0);

function event(overrides: Partial<LogEventDto> = {}): LogEventDto {
	return { id: 'evt-1', timestamp: TS, message: 'hello', ...overrides };
}

describe('archiveEventKey', () => {
	test('uses the CloudWatch event id when there is one', () => {
		expect(archiveEventKey(event())).toBe('evt-1');
	});

	test('hashes timestamp, stream and message when the id is missing', () => {
		const key = archiveEventKey(event({ id: null, streamName: 's-1' }));
		expect(key.startsWith('h:')).toBe(true);
		expect(key).toHaveLength(34);
		expect(archiveEventKey(event({ id: null, streamName: 's-1' }))).toBe(key);
	});

	test('changes when any part of the hashed content changes', () => {
		const base = archiveEventKey(event({ id: null, streamName: 's-1' }));
		expect(archiveEventKey(event({ id: null, streamName: 's-2' }))).not.toBe(base);
		expect(archiveEventKey(event({ id: null, streamName: 's-1', message: 'other' }))).not.toBe(
			base,
		);
		expect(archiveEventKey(event({ id: null, streamName: 's-1', timestamp: TS + 1 }))).not.toBe(
			base,
		);
	});

	test('treats an empty id as missing', () => {
		expect(archiveEventKey(event({ id: '' })).startsWith('h:')).toBe(true);
	});
});

describe('schema', () => {
	test('is idempotent and keeps the de-duplication index', () => {
		expect(ARCHIVE_SCHEMA.every((statement) => statement.includes('IF NOT EXISTS'))).toBe(true);
		expect(
			ARCHIVE_SCHEMA.some((statement) =>
				statement.includes('CREATE UNIQUE INDEX IF NOT EXISTS log_events_unique'),
			),
		).toBe(true);
		expect(ARCHIVE_SCHEMA.some((statement) => statement.includes('log_events_time'))).toBe(true);
		// The level columns are created for new files and migrated into old ones.
		expect(ARCHIVE_SCHEMA.some((statement) => statement.includes('level VARCHAR'))).toBe(true);
		expect(
			ARCHIVE_SCHEMA.some((statement) =>
				statement.includes('ALTER TABLE log_events ADD COLUMN IF NOT EXISTS level_source VARCHAR'),
			),
		).toBe(true);
		// The request id is created and migrated the same way.
		expect(ARCHIVE_SCHEMA.some((statement) => statement.includes('request_id VARCHAR'))).toBe(true);
		expect(
			ARCHIVE_SCHEMA.some((statement) =>
				statement.includes('ALTER TABLE log_events ADD COLUMN IF NOT EXISTS request_id VARCHAR'),
			),
		).toBe(true);
		// The file remembers its own migrations in a small key/value table.
		expect(
			ARCHIVE_SCHEMA.some((statement) =>
				statement.includes('CREATE TABLE IF NOT EXISTS archive_meta (key VARCHAR PRIMARY KEY'),
			),
		).toBe(true);
		// Coverage is what a historic view reads instead of calling CloudWatch.
		expect(
			ARCHIVE_SCHEMA.some((statement) =>
				statement.includes('CREATE TABLE IF NOT EXISTS archive_coverage'),
			),
		).toBe(true);
	});
});

describe('coverage intervals', () => {
	test('merges overlapping and adjacent ranges, without mutating the input', () => {
		const input = [
			{ start: 30, end: 40 },
			{ start: 10, end: 20 },
			{ start: 21, end: 29 }, // adjacent to both neighbours
			{ start: 100, end: 110 },
			{ start: 50, end: 45 }, // inverted, dropped
		];
		expect(mergeCoverage(input)).toEqual([
			{ start: 10, end: 40 },
			{ start: 100, end: 110 },
		]);
		expect(input).toEqual([
			{ start: 30, end: 40 },
			{ start: 10, end: 20 },
			{ start: 21, end: 29 },
			{ start: 100, end: 110 },
			{ start: 50, end: 45 },
		]);
	});

	test('intersects coverage with a window, clipping the edges', () => {
		const intervals = [
			{ start: 0, end: 100 },
			{ start: 300, end: 400 },
		];
		expect(intersectCoverage(50, 350, intervals)).toEqual([
			{ start: 50, end: 100 },
			{ start: 300, end: 350 },
		]);
		expect(intersectCoverage(500, 600, intervals)).toEqual([]);
	});

	test('subtracts coverage from a window, leaving the gaps', () => {
		expect(subtractCoverage(0, 1000, [{ start: 200, end: 300 }])).toEqual([
			{ start: 0, end: 199 },
			{ start: 301, end: 1000 },
		]);
		expect(
			subtractCoverage(0, 1000, [
				{ start: -50, end: 100 },
				{ start: 900, end: 5000 },
			]),
		).toEqual([{ start: 101, end: 899 }]);
		expect(subtractCoverage(0, 1000, [])).toEqual([{ start: 0, end: 1000 }]);
		expect(subtractCoverage(0, 1000, [{ start: 0, end: 1000 }])).toEqual([]);
	});

	test('builds the window query with one placeholder per group', () => {
		const { sql, params } = buildCoverageQuery(REGION, [GROUP, 'other'], 10, 99);
		expect(sql).toContain('log_group IN (?, ?)');
		expect(sql).toContain('end_ms >= ? AND start_ms <= ?');
		expect(params).toEqual([REGION, GROUP, 'other', 10n, 99n]);
	});

	test('maps a single group of rows and drops unusable ones', () => {
		expect(
			rowsToCoverage([
				{ start_ms: 1n, end_ms: 2n },
				{ start_ms: null, end_ms: 3n },
				{ start_ms: 4n, end_ms: 5n },
			]),
		).toEqual([
			{ start: 1, end: 2 },
			{ start: 4, end: 5 },
		]);
	});

	test('maps rows to merged intervals per group', () => {
		const map = rowsToCoverageByGroup([
			{ log_group: GROUP, start_ms: 10n, end_ms: 20n },
			{ log_group: GROUP, start_ms: 21n, end_ms: 30n },
			{ log_group: 'other', start_ms: 5n, end_ms: 6n },
			{ log_group: null, start_ms: 1n, end_ms: 2n }, // unusable, dropped
		]);
		expect(map.get(GROUP)).toEqual([{ start: 10, end: 30 }]);
		expect(map.get('other')).toEqual([{ start: 5, end: 6 }]);
	});

	test('builds the merge-on-write statements', () => {
		const group = buildCoverageGroupQuery(REGION, GROUP);
		expect(group.sql).toContain('WHERE region = ? AND log_group = ?');
		expect(group.params).toEqual([REGION, GROUP]);
		const removal = buildCoverageDeleteQuery(REGION, GROUP);
		expect(removal.sql).toContain('DELETE FROM archive_coverage');
		expect(buildCoverageInsert(2)).toContain('VALUES (?, ?, ?, ?), (?, ?, ?, ?)');
		expect(toCoverageParams(REGION, GROUP, [{ start: 1, end: 2 }])).toEqual([
			REGION,
			GROUP,
			1n,
			2n,
		]);
	});
});

describe('buildInsertSql', () => {
	test('emits one placeholder row per event, in column order', () => {
		const sql = buildInsertSql(2);
		expect(sql.startsWith('INSERT OR IGNORE INTO log_events (')).toBe(true);
		expect(sql).toContain(`(${ARCHIVE_INSERT_COLUMNS.map(() => '?').join(', ')})`);
		expect(sql.match(/\(\?, \?/g)).toHaveLength(2);
	});

	test('rejects a non-positive row count', () => {
		expect(() => buildInsertSql(0)).toThrow(RangeError);
		expect(() => buildInsertSql(1.5)).toThrow(RangeError);
	});

	test('chunks stay under the driver placeholder budget', () => {
		expect(buildInsertSql(ARCHIVE_INSERT_CHUNK).match(/\(\?, \?/g)).toHaveLength(
			ARCHIVE_INSERT_CHUNK,
		);
	});
});

describe('toArchiveParams', () => {
	test('flattens events in column order with bigint timestamps', () => {
		const params = toArchiveParams(REGION, GROUP, [
			event({
				streamName: 's-1',
				ingestionTime: TS + 5,
				message: 'done RequestId: 1a2b3c4d',
			}),
		]);
		expect(params).toEqual([
			REGION,
			GROUP,
			's-1',
			'evt-1',
			'evt-1',
			BigInt(TS),
			BigInt(TS + 5),
			'done RequestId: 1a2b3c4d',
			null,
			null,
			'1a2b3c4d',
		]);
		expect(params).toHaveLength(ARCHIVE_INSERT_COLUMNS.length);
		expect(ARCHIVE_INSERT_COLUMNS.at(-1)).toBe('request_id');
	});

	test('detects a declared request id as well as a printed one', () => {
		const declared = toArchiveParams(REGION, GROUP, [
			event({ message: '{"request_id":"req-9f2c","msg":"ok"}' }),
		]);
		expect(declared.at(-1)).toBe('req-9f2c');
	});

	test('stores NULL, never an empty string, when a line has no request id', () => {
		expect(toArchiveParams(REGION, GROUP, [event({ message: 'hello' })]).at(-1)).toBeNull();
		// A value too short to be an id is not one either, so the column cannot hold
		// "" or a stray character by accident.
		expect(toArchiveParams(REGION, GROUP, [event({ message: 'RequestId: ab' })]).at(-1)).toBeNull();
	});

	test('binds null for fields CloudWatch omits', () => {
		const params = toArchiveParams(REGION, GROUP, [event({ id: null, message: '' })]);
		expect(params[2]).toBeNull();
		expect(params[3]).toMatch(/^h:/);
		expect(params[4]).toBeNull();
		expect(params[6]).toBeNull();
		expect(params[8]).toBeNull();
		expect(params[9]).toBeNull();
		expect(params[10]).toBeNull();
	});

	test('flattens several events in one list', () => {
		const params = toArchiveParams(REGION, GROUP, [event(), event({ id: 'evt-2' })]);
		expect(params).toHaveLength(2 * ARCHIVE_INSERT_COLUMNS.length);
		expect(params[3]).toBe('evt-1');
		expect(params[ARCHIVE_INSERT_COLUMNS.length + 3]).toBe('evt-2');
	});
});

describe('escapeLike', () => {
	test('escapes wildcards and the escape character', () => {
		expect(escapeLike('100%_done')).toBe('100\\%\\_done');
		expect(escapeLike('back\\slash')).toBe('back\\\\slash');
		expect(escapeLike('plain')).toBe('plain');
	});
});

describe('buildPageQuery', () => {
	test('filters on region, group and window and ends with the limit', () => {
		const { sql, params } = buildPageQuery({
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS + 1000,
			limit: 200,
		});
		expect(sql).toContain('WHERE region = ? AND log_group IN (?)');
		expect(sql).toContain('ORDER BY timestamp_ms, seq LIMIT ?');
		expect(sql).not.toContain('ILIKE');
		expect(params).toEqual([REGION, GROUP, BigInt(TS), BigInt(TS + 1000), BigInt(200)]);
	});

	test('adds the search term as an escaped substring match', () => {
		const { sql, params } = buildPageQuery({
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS,
			search: '50% off',
			limit: 10,
		});
		expect(sql).toContain("message ILIKE ? ESCAPE '\\'");
		expect(params[4]).toBe('%50\\% off%');
	});

	test('ignores a blank search term', () => {
		const { sql } = buildPageQuery({
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS,
			search: '   ',
			limit: 10,
		});
		expect(sql).not.toContain('ILIKE');
	});

	test('adds a stream prefix filter', () => {
		const { sql, params } = buildPageQuery({
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS,
			streamPrefix: 'worker',
			limit: 10,
		});
		expect(sql).toContain("log_stream LIKE ? ESCAPE '\\'");
		expect(params[4]).toBe('worker%');
	});

	test('pages after a cursor with a tuple comparison', () => {
		const { sql, params } = buildPageQuery({
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS + 10,
			after: { timestamp: TS + 3, seq: 42 },
			limit: 5,
		});
		expect(sql).toContain('(timestamp_ms > ? OR (timestamp_ms = ? AND seq > ?))');
		expect(params.slice(-4)).toEqual([BigInt(TS + 3), BigInt(TS + 3), BigInt(42), BigInt(5)]);
	});

	test('clamps a silly limit to a usable positive value', () => {
		const { params } = buildPageQuery({
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS,
			limit: 0,
		});
		expect(params.at(-1)).toBe(BigInt(1));
	});
});

describe('rowsToPage', () => {
	test('maps rows, numbers and bigints alike, and reports the last cursor', () => {
		const page = rowsToPage([
			{
				timestamp_ms: BigInt(TS),
				seq: BigInt(7),
				message: 'first',
				log_stream: '/stream/one',
				event_key: 'evt-1',
				ingestion_time_ms: BigInt(TS + 1),
				level: 'error',
				request_id: 'req-9f2c',
			},
			{ timestamp_ms: TS + 5, seq: 8, message: 'second', log_stream: null, event_key: null },
		]);
		expect(page.events).toEqual([
			{
				id: 'evt-1',
				timestamp: TS,
				message: 'first',
				streamName: '/stream/one',
				ingestionTime: TS + 1,
				level: 'error',
				requestId: 'req-9f2c',
			},
			{ id: null, timestamp: TS + 5, message: 'second', level: null },
		]);
		expect(page.last).toEqual({ timestamp: TS + 5, seq: 8 });
	});

	test('filters by one or several levels', () => {
		const single = buildPageQuery({
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS,
			levels: ['error'],
			limit: 10,
		});
		expect(single.sql).toContain('level IN (?)');
		expect(single.params).toContain('error');

		const many = buildPageQuery({
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS,
			levels: ['error', 'warn'],
			limit: 10,
		});
		expect(many.sql).toContain('level IN (?, ?)');
		expect(many.params.slice(-3, -1)).toEqual(['error', 'warn']);
	});

	test('adds no level clause without a filter', () => {
		const { sql } = buildPageQuery({
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS,
			limit: 10,
		});
		expect(sql).not.toContain('level IN');
	});

	test('sends a stored request id only when there is one', () => {
		const page = rowsToPage([
			{ timestamp_ms: TS, seq: 1, message: 'grouped', request_id: 'req-1' },
			// A row written before the column existed: NULL is not a verdict, because
			// the client can still detect an id in the message it renders.
			{ timestamp_ms: TS, seq: 2, message: 'legacy', request_id: null },
			{ timestamp_ms: TS, seq: 3, message: 'empty', request_id: '' },
			{ timestamp_ms: TS, seq: 4, message: 'missing' },
		]);
		expect(page.events.map((entry) => entry.requestId)).toEqual([
			'req-1',
			undefined,
			undefined,
			undefined,
		]);
		expect('requestId' in (page.events[1] as LogEventDto)).toBe(false);
		expect(page.events.every((entry) => entry.level === null)).toBe(true);
	});

	test('maps an unknown or missing stored level to null', () => {
		const page = rowsToPage([
			{ timestamp_ms: TS, seq: 1, message: 'junk level', level: 'shouty' },
			{ timestamp_ms: TS, seq: 2, message: 'no level' },
			{ timestamp_ms: TS, seq: 3, message: 'known', level: 'warn' },
		]);
		expect(page.events.map((entry) => entry.level)).toEqual([null, null, 'warn']);
	});

	test('skips rows without a usable timestamp or sequence', () => {
		const page = rowsToPage([
			{ timestamp_ms: null, seq: 1, message: 'no timestamp' },
			{ timestamp_ms: TS, seq: null, message: 'no seq' },
			{ timestamp_ms: TS, seq: 2, message: 'kept' },
		]);
		expect(page.events).toHaveLength(1);
		expect(page.last).toEqual({ timestamp: TS, seq: 2 });
	});

	test('returns an empty page for no rows', () => {
		expect(rowsToPage([])).toEqual({ events: [], last: null });
	});

	test('accepts upper-case column names', () => {
		const page = rowsToPage([{ TIMESTAMP_MS: TS, SEQ: 1, MESSAGE: 'up' }]);
		expect(page.events[0]?.message).toBe('up');
	});
});

describe('totals and groups', () => {
	test('maps the aggregate row', () => {
		expect(
			rowToTotals({ rows: BigInt(12), groups: BigInt(2), regions: 1, oldest: TS, newest: TS + 9 }),
		).toEqual({ rows: 12, groups: 2, regions: 1, oldest: TS, newest: TS + 9 });
	});

	test('reports an empty archive', () => {
		expect(rowToTotals(undefined)).toEqual({
			rows: 0,
			groups: 0,
			regions: 0,
			oldest: null,
			newest: null,
		});
		expect(rowToTotals({ rows: 0, groups: 0, regions: 0, oldest: null, newest: null }).rows).toBe(
			0,
		);
	});

	test('totals come from one aggregate query', () => {
		expect(ARCHIVE_TOTALS_SQL).toContain('FROM log_events');
		expect(ARCHIVE_TOTALS_SQL).toContain('min(timestamp_ms)');
	});

	test('groups query is unfiltered without a region', () => {
		const all = buildGroupsQuery(null);
		expect(all.sql).not.toContain('WHERE');
		expect(all.params).toEqual([]);
	});

	test('groups query filters by region', () => {
		const scoped = buildGroupsQuery(REGION);
		expect(scoped.sql).toContain('WHERE region = ?');
		expect(scoped.params).toEqual([REGION]);
	});

	test('maps group rows and drops unusable ones', () => {
		const groups = rowsToGroups([
			{ region: REGION, log_group: GROUP, events: BigInt(3), oldest: TS, newest: TS + 2 },
			{ region: null, log_group: GROUP, events: BigInt(1) },
			{ region: REGION, log_group: GROUP, events: '2', oldest: null, newest: null },
		]);
		expect(groups).toEqual([
			{ region: REGION, logGroup: GROUP, events: 3, oldest: TS, newest: TS + 2 },
			{ region: REGION, logGroup: GROUP, events: 2, oldest: null, newest: null },
		]);
	});

	test('binds the bucket width before the window, matching the statement order', () => {
		const { sql, params } = buildSeriesQuery({
			region: REGION,
			logGroups: [GROUP, '/other'],
			startTime: TS,
			endTime: TS + 60_000,
			bucketMs: 10_000,
		});
		expect(sql).toContain('CAST(floor(timestamp_ms / ?) * ? AS BIGINT) AS bucket');
		expect(sql).toContain('log_group IN (?, ?)');
		expect(sql).toContain("coalesce(level, 'unknown') AS level");
		expect(params).toEqual([
			BigInt(10_000),
			BigInt(10_000),
			REGION,
			GROUP,
			'/other',
			BigInt(TS),
			BigInt(TS + 60_000),
		]);
	});

	test('adds the level filter after the window', () => {
		const { sql, params } = buildSeriesQuery({
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS + 60_000,
			bucketMs: 1_000,
			levels: ['error', 'warn'],
		});
		expect(sql).toContain('level IN (?, ?)');
		expect(params.slice(-2)).toEqual(['error', 'warn']);
	});

	test('maps series rows and normalises a missing level', () => {
		const rows = rowsToSeries([
			{ bucket: BigInt(TS), log_group: GROUP, level: 'error', events: BigInt(4) },
			{ bucket: TS + 10_000, log_group: GROUP, level: null, events: 2 },
			{ bucket: null, log_group: GROUP, level: 'error', events: 1 },
			{ bucket: TS, log_group: null, level: 'error', events: 1 },
		]);
		expect(rows).toEqual([
			{ t: TS, group: GROUP, level: 'error', events: 4 },
			{ t: TS + 10_000, group: GROUP, level: 'unknown', events: 2 },
		]);
	});
});

describe('request-id backfill', () => {
	test('scans the rows written before the column existed, up to a ceiling', () => {
		const { sql, params } = buildRequestIdBackfillQuery({ maxSeq: 42, limit: 100 });
		expect(sql).toContain(
			'SELECT event_key, log_group, region, message, seq FROM log_events WHERE seq <= ? AND request_id IS NULL ORDER BY seq LIMIT ?',
		);
		expect(params).toEqual([BigInt(42), BigInt(100)]);
	});

	test('skips the range a previous pass already scanned', () => {
		const { sql, params } = buildRequestIdBackfillQuery({ maxSeq: 42, afterSeq: 7, limit: 5 });
		expect(sql).toContain('WHERE seq <= ? AND seq > ? AND request_id IS NULL');
		// The ceiling binds first, then the watermark, then the row budget.
		expect(params).toEqual([BigInt(42), BigInt(7), BigInt(5)]);
	});

	test('treats a zero watermark as "scan from the start"', () => {
		const { sql, params } = buildRequestIdBackfillQuery({ maxSeq: 3, afterSeq: 0, limit: 1 });
		expect(sql).not.toContain('seq > ?');
		expect(params).toEqual([BigInt(3), BigInt(1)]);
	});

	test('reads the ceiling and the stored watermark', () => {
		expect(ARCHIVE_MAX_SEQ_SQL).toBe('SELECT max(seq) AS maxSeq FROM log_events');
		expect(rowToMaxSeq({ maxSeq: BigInt(9) })).toBe(9);
		expect(rowToMaxSeq({ maxSeq: null })).toBeNull();
		expect(rowToMaxSeq(undefined)).toBeNull();
		expect(buildRequestIdBackfillStateQuery()).toContain(
			"SELECT value FROM archive_meta WHERE key = 'request_id_backfill'",
		);
		expect(buildRequestIdBackfillStateWrite()).toContain(
			"INSERT OR REPLACE INTO archive_meta (key, value) VALUES ('request_id_backfill', ?)",
		);
	});

	test('reads the watermark, and treats junk as "never scanned"', () => {
		expect(rowToBackfillWatermark({ value: '12' })).toBe(12);
		expect(rowToBackfillWatermark({ value: BigInt(12) })).toBe(12);
		expect(rowToBackfillWatermark({ value: null })).toBeNull();
		expect(rowToBackfillWatermark({ value: 'later' })).toBeNull();
		expect(rowToBackfillWatermark(undefined)).toBeNull();
	});

	test('maps candidate rows, dropping unusable ones and reporting the last seq', () => {
		const candidates = rowsToBackfillCandidates([
			{
				event_key: 'k1',
				region: 'r',
				log_group: '/a',
				message: 'RequestId: 1a2b3c4d',
				seq: BigInt(3),
			},
			{ event_key: null, region: 'r', log_group: '/a', message: 'msg', seq: 4 },
			{ event_key: 'k2', region: 'r', log_group: '/a', message: 'msg', seq: null },
		]);
		expect(candidates).toEqual([
			{ seq: 3, region: 'r', logGroup: '/a', eventKey: 'k1', message: 'RequestId: 1a2b3c4d' },
		]);
		expect(maxSeqOf(candidates)).toBe(3);
		expect(maxSeqOf([])).toBeNull();
	});

	test('plans an update only for the messages that yield an id', () => {
		const updates = planRequestIdBackfill([
			{ seq: 1, region: 'r', logGroup: '/a', eventKey: 'k1', message: 'RequestId: 1a2b3c4d' },
			{ seq: 2, region: 'r', logGroup: '/a', eventKey: 'k2', message: 'no id in this line' },
			{ seq: 3, region: 'r', logGroup: '/a', eventKey: 'k3', message: '{"requestId":"req-9f2c"}' },
		]);
		// A message with no id is left alone: NULL is the answer for that row, and the
		// watermark moves past it so it is not looked at again.
		expect(updates).toEqual([
			{ region: 'r', logGroup: '/a', eventKey: 'k1', requestId: '1a2b3c4d' },
			{ region: 'r', logGroup: '/a', eventKey: 'k3', requestId: 'req-9f2c' },
		]);
	});

	test('writes many ids in one statement, keyed by the unique index', () => {
		const sql = buildRequestIdBackfillUpdate(2);
		expect(sql.startsWith('UPDATE log_events SET request_id = v.request_id FROM (VALUES ')).toBe(
			true,
		);
		expect(sql).toContain('AS v(region, log_group, event_key, request_id)');
		expect(sql).toContain('log_events.region = v.region AND log_events.log_group = v.log_group');
		expect(sql.match(/\(\?, \?, \?, \?\)/g)).toHaveLength(2);
		expect(() => buildRequestIdBackfillUpdate(0)).toThrow(RangeError);
		expect(() => buildRequestIdBackfillUpdate(1.5)).toThrow(RangeError);
		expect(
			toRequestIdBackfillParams([
				{ region: 'r', logGroup: '/a', eventKey: 'k1', requestId: 'id-1' },
			]),
		).toEqual(['r', '/a', 'k1', 'id-1']);
	});
});

describe('request-mode series', () => {
	test('counts one mark per request, at its first line, coloured by its worst level', () => {
		const { sql, params } = buildSeriesQuery({
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS + 60_000,
			bucketMs: 10_000,
			by: 'request',
		});
		expect(sql).toContain(
			'SELECT coalesce(request_id, event_key) AS request_key, log_group, min(timestamp_ms) AS start_ms',
		);
		expect(sql).toContain('GROUP BY request_key, log_group)');
		expect(sql).toContain(
			"max(CASE coalesce(level, 'unknown') WHEN 'error' THEN 4 WHEN 'warn' THEN 3 WHEN 'info' THEN 2 WHEN 'debug' THEN 1 ELSE 0 END) AS level_rank",
		);
		expect(sql).toContain(
			"SELECT CAST(floor(start_ms / ?) * ? AS BIGINT) AS bucket, log_group, CASE level_rank WHEN 4 THEN 'error' WHEN 3 THEN 'warn' WHEN 2 THEN 'info' WHEN 1 THEN 'debug' ELSE 'unknown' END AS level, count(*) AS events",
		);
		expect(sql).not.toContain('HAVING');
		// Bind order follows the statement text: the CTE comes first, so its scope
		// parameters come first and the bucket width comes LAST - the opposite of the
		// event form, which binds the bucket width first.
		expect(params).toEqual([
			REGION,
			GROUP,
			BigInt(TS),
			BigInt(TS + 60_000),
			BigInt(10_000),
			BigInt(10_000),
		]);
	});

	test('selects a request by its worst level, binding the ranks', () => {
		const { sql, params } = buildSeriesQuery({
			region: REGION,
			logGroups: [GROUP, '/other'],
			startTime: TS,
			endTime: TS + 60_000,
			bucketMs: 1_000,
			levels: ['error', 'debug'],
			by: 'request',
		});
		expect(sql).toContain('HAVING level_rank IN (?, ?)');
		expect(sql).not.toContain('level IN (');
		expect(params).toEqual([
			REGION,
			GROUP,
			'/other',
			BigInt(TS),
			BigInt(TS + 60_000),
			4,
			1,
			BigInt(1_000),
			BigInt(1_000),
		]);
	});

	test('keeps the event form when by is event or absent', () => {
		const base = {
			region: REGION,
			logGroups: [GROUP],
			startTime: TS,
			endTime: TS,
			bucketMs: 1_000,
		};
		expect(buildSeriesQuery({ ...base, by: 'event' })).toEqual(buildSeriesQuery(base));
		expect(buildSeriesQuery(base).params[0]).toBe(BigInt(1_000));
	});
});
