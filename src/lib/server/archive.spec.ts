import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	ARCHIVE_FILE_NAME,
	LOCK_RETRIES,
	LogArchive,
	archiveIdleReleaseMs,
	describeOpenError,
	loadDuckDbDriver,
	resolveArchiveConfig,
	type Driver,
	type DriverConnection,
} from './archive';
import {
	ARCHIVE_INSERT_CHUNK,
	ARCHIVE_INSERT_COLUMNS,
	REQUEST_ID_BACKFILL_LIMIT,
	archiveEventKey,
	type ArchiveParam,
} from './archive-sql';
import type { LogEventDto } from '$lib/types';

const TS = Date.UTC(2024, 4, 17, 12, 0, 0);

function event(overrides: Partial<LogEventDto> = {}): LogEventDto {
	return { id: 'evt-1', timestamp: TS, message: 'hello', ...overrides };
}

type Call = { sql: string; params: ArchiveParam[] | undefined };

/**
 * Builds a driver double that records every statement and answers reads from
 * `respond`. Native code is never loaded, so these tests run anywhere.
 */
function fakeDriver(
	options: {
		respond?: (sql: string, params: ArchiveParam[] | undefined) => Record<string, unknown>[];
		failOn?: (sql: string) => string | null;
		createFails?: string;
	} = {},
) {
	const calls: Call[] = [];
	let closes = 0;
	let connects = 0;
	let creates = 0;
	let instanceCloses = 0;
	const connection: DriverConnection = {
		async run(sql, params) {
			const failure = options.failOn?.(sql) ?? null;
			if (failure !== null) throw new Error(failure);
			calls.push({ sql, params });
		},
		async runAndReadAll(sql, params) {
			calls.push({ sql, params });
			return { getRowObjects: () => options.respond?.(sql, params) ?? [] };
		},
		closeSync() {
			closes += 1;
		},
	};
	const driver: Driver = {
		DuckDBInstance: {
			create: async () => {
				if (options.createFails !== undefined) throw new Error(options.createFails);
				creates += 1;
				return {
					connect: async () => {
						connects += 1;
						return connection;
					},
					closeSync() {
						instanceCloses += 1;
					},
				};
			},
		},
	};
	return {
		driver,
		calls,
		statements: () => calls.map((call) => call.sql),
		closes: () => closes,
		connects: () => connects,
		creates: () => creates,
		instanceCloses: () => instanceCloses,
	};
}

describe('resolveArchiveConfig', () => {
	test('uses the platform data directory by default', () => {
		expect(resolveArchiveConfig({}, 'darwin', '/Users/dev')).toEqual({
			enabled: true,
			path: `/Users/dev/Library/Application Support/watch-tail/${ARCHIVE_FILE_NAME}`,
		});
	});

	test('honours XDG_DATA_HOME on linux and LOCALAPPDATA on windows', () => {
		expect(resolveArchiveConfig({ XDG_DATA_HOME: '/data' }, 'linux', '/home/dev').path).toBe(
			`/data/watch-tail/${ARCHIVE_FILE_NAME}`,
		);
		const windows = resolveArchiveConfig(
			{ LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
			'win32',
			'C:\\Users\\dev',
		);
		expect(windows.path).toContain('watch-tail');
	});

	test('falls back to ~/.local/share elsewhere', () => {
		expect(resolveArchiveConfig({}, 'linux', '/home/dev').path).toBe(
			`/home/dev/.local/share/watch-tail/${ARCHIVE_FILE_NAME}`,
		);
	});

	test('prefers an explicit database path', () => {
		expect(
			resolveArchiveConfig({ WATCH_TAIL_ARCHIVE_DB: '/tmp/logs.duckdb' }, 'darwin', '/Users/dev'),
		).toEqual({
			enabled: true,
			path: '/tmp/logs.duckdb',
		});
	});

	test.each(['off', '0', 'false', 'NO', ' off '])('reads %s as disabled', (value) => {
		const config = resolveArchiveConfig({ WATCH_TAIL_ARCHIVE: value }, 'linux', '/home/dev');
		expect(config.enabled).toBe(false);
		expect(config.path.endsWith(ARCHIVE_FILE_NAME)).toBe(true);
	});

	test('any other value keeps the archive on', () => {
		expect(resolveArchiveConfig({ WATCH_TAIL_ARCHIVE: 'on' }, 'linux', '/home/dev').enabled).toBe(
			true,
		);
	});

	test('is off inside a test process, so tests cannot touch a real archive', () => {
		expect(resolveArchiveConfig({ VITEST: 'true' }, 'linux', '/home/dev').enabled).toBe(false);
		expect(resolveArchiveConfig({ NODE_ENV: 'test' }, 'linux', '/home/dev').enabled).toBe(false);
	});

	test('a test can opt in explicitly', () => {
		expect(
			resolveArchiveConfig({ VITEST: 'true', WATCH_TAIL_ARCHIVE: 'on' }, 'linux', '/home/dev')
				.enabled,
		).toBe(true);
		expect(
			resolveArchiveConfig(
				{ VITEST: 'true', WATCH_TAIL_ARCHIVE_DB: '/tmp/t.duckdb' },
				'linux',
				'/home/dev',
			),
		).toMatchObject({ enabled: true, path: '/tmp/t.duckdb' });
		expect(
			resolveArchiveConfig(
				{ VITEST: 'true', WATCH_TAIL_ARCHIVE: 'off', WATCH_TAIL_ARCHIVE_DB: '/tmp/t.duckdb' },
				'linux',
				'/home/dev',
			).enabled,
		).toBe(false);
	});
});

describe('LogArchive.open', () => {
	test('creates the schema in order and reports availability', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/does-not-matter/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		const statements = fake.statements();
		expect(archive.available).toBe(true);
		expect(archive.error).toBeNull();
		expect(fake.connects()).toBe(1);
		expect(statements[0]).toContain('CREATE SEQUENCE IF NOT EXISTS log_events_seq');
		expect(statements[1]).toContain('CREATE TABLE IF NOT EXISTS log_events');
		expect(statements.some((statement) => statement.includes('log_events_time'))).toBe(true);
		// The request-id backfill runs once the schema is in place, so it can read a
		// column that an older file only just grew.
		expect(statements.some((statement) => statement.includes('max(seq) AS maxSeq'))).toBe(true);
		expect(statements.some((statement) => statement.includes('CREATE INDEX'))).toBe(true);
	});

	test('creates the parent directory before opening', async () => {
		const dirs: string[] = [];
		await LogArchive.open({
			path: '/tmp/archive-parent/archive.duckdb',
			load: async () => fakeDriver().driver,
			ensureDir: (dir) => dirs.push(dir),
		});
		expect(dirs).toEqual(['/tmp/archive-parent']);
	});

	test('degrades when the driver cannot be imported', async () => {
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => {
				throw new Error("Cannot find module '@duckdb/node-api'");
			},
			ensureDir: () => undefined,
		});
		expect(archive.available).toBe(false);
		expect(archive.error).toContain('@duckdb/node-api');
		expect(await archive.record('us-east-1', '/g', [event()])).toBe(0);
		expect(
			await archive.page({
				region: 'us-east-1',
				logGroups: ['/g'],
				startTime: 0,
				endTime: TS,
				limit: 10,
			}),
		).toEqual({
			events: [],
			last: null,
		});
		expect(await archive.totals()).toEqual({
			rows: 0,
			groups: 0,
			regions: 0,
			oldest: null,
			newest: null,
		});
		expect(await archive.groups()).toEqual([]);
		expect((await archive.status()).available).toBe(false);
	});

	test('degrades when the database file cannot be opened', async () => {
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fakeDriver({ createFails: 'database is locked' }).driver,
			ensureDir: () => undefined,
		});
		expect(archive.available).toBe(false);
		expect(archive.error).toBe('database is locked');
	});

	test('unavailable() is a silent no-op that keeps the path', async () => {
		const archive = LogArchive.unavailable('/tmp/off.duckdb');
		expect(archive.path).toBe('/tmp/off.duckdb');
		expect(archive.available).toBe(false);
		expect(archive.error).toBeNull();
		expect(await archive.record('us-east-1', '/g', [event()])).toBe(0);
		expect((await archive.status()).error).toBeNull();
	});
});

describe('LogArchive.record', () => {
	test('writes one statement per chunk with flattened parameters', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		const events = Array.from({ length: ARCHIVE_INSERT_CHUNK + 3 }, (_, index) =>
			event({ id: `evt-${index}` }),
		);
		const written = await archive.record('af-south-1', '/aws/lambda/api', events);

		const inserts = fake.calls.filter((call) => call.sql.includes('INSERT OR IGNORE'));
		expect(written).toBe(events.length);
		expect(inserts).toHaveLength(2);
		const paramsPerRow = ARCHIVE_INSERT_COLUMNS.length;
		expect(inserts[0]?.params).toHaveLength(ARCHIVE_INSERT_CHUNK * paramsPerRow);
		expect(inserts[1]?.params).toHaveLength(3 * paramsPerRow);
		expect(inserts[0]?.params?.slice(0, 5)).toEqual([
			'af-south-1',
			'/aws/lambda/api',
			null,
			'evt-0',
			'evt-0',
		]);
	});

	test('skips an empty batch without touching the database', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		const before = fake.calls.length;
		expect(await archive.record('us-east-1', '/g', [])).toBe(0);
		expect(fake.calls).toHaveLength(before);
	});

	test('swallows a write failure and reports it', async () => {
		const fake = fakeDriver({ failOn: (sql) => (sql.includes('INSERT') ? 'disk full' : null) });
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		expect(await archive.record('us-east-1', '/g', [event()])).toBe(0);
		expect(archive.error).toBe('disk full');
		expect(archive.available).toBe(true);
	});
});

describe('LogArchive reads', () => {
	test('maps a page and its cursor', async () => {
		const fake = fakeDriver({
			respond: (sql) =>
				sql.startsWith('SELECT region, log_group, log_stream')
					? [
							{
								region: 'us-east-1',
								log_group: '/g',
								log_stream: 's-1',
								event_key: 'evt-1',
								event_id: 'evt-1',
								timestamp_ms: BigInt(TS),
								ingestion_time_ms: null,
								message: 'hello',
								level: 'error',
								level_source: 'json',
								seq: BigInt(4),
							},
						]
					: [],
		});
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		const page = await archive.page({
			region: 'us-east-1',
			logGroups: ['/g'],
			startTime: TS,
			endTime: TS + 1000,
			limit: 5,
		});
		expect(page.events).toEqual([
			{
				id: 'evt-1',
				timestamp: TS,
				message: 'hello',
				streamName: 's-1',
				level: 'error',
				group: '/g',
			},
		]);
		expect(page.last).toEqual({ timestamp: TS, seq: 4 });
	});

	test('maps totals and groups', async () => {
		const fake = fakeDriver({
			respond: (sql) =>
				sql.includes('count(DISTINCT log_group)')
					? [
							{
								rows: BigInt(7),
								groups: BigInt(2),
								regions: BigInt(1),
								oldest: BigInt(TS),
								newest: BigInt(TS + 5),
							},
						]
					: [
							{
								region: 'us-east-1',
								log_group: '/g',
								events: BigInt(7),
								oldest: BigInt(TS),
								newest: BigInt(TS + 5),
							},
						],
		});
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		expect(await archive.totals()).toEqual({
			rows: 7,
			groups: 2,
			regions: 1,
			oldest: TS,
			newest: TS + 5,
		});
		expect(await archive.groups()).toEqual([
			{ region: 'us-east-1', logGroup: '/g', events: 7, oldest: TS, newest: TS + 5 },
		]);
		expect(await archive.groups('us-east-1')).toHaveLength(1);
	});

	test('status reports a null size when the file is missing', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/definitely-missing-watch-tail-archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		const status = await archive.status();
		expect(status.path).toBe('/tmp/definitely-missing-watch-tail-archive.duckdb');
		expect(status.bytes).toBeNull();
		expect(status.totals.rows).toBe(0);
	});

	test('close closes the connection once and marks the archive unavailable', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		await archive.close();
		await archive.close();
		expect(fake.closes()).toBe(1);
		// Closing the database, not only the connection, is what frees the file lock.
		expect(fake.instanceCloses()).toBe(1);
		expect(archive.available).toBe(false);
	});

	test('a failed page read says so instead of looking like an empty window', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		// The page query is the only statement that fails.
		const connection = await (await fake.driver.DuckDBInstance.create('')).connect();
		const read = connection.runAndReadAll;
		connection.runAndReadAll = async (sql, params) => {
			if (sql.startsWith('SELECT region, log_group, log_stream')) {
				throw new Error('IO Error: read failed');
			}
			return read(sql, params);
		};
		const page = await archive.page({
			region: 'us-east-1',
			logGroups: ['/g'],
			startTime: 0,
			endTime: 1,
			search: null,
			streamPrefix: null,
			levels: null,
			after: null,
			limit: 10,
		});
		expect(page).toEqual({ events: [], last: null, error: 'IO Error: read failed' });
	});
});

/** Waits on a real timer, for the idle release to fire (or not). */
function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('LogArchive idle release', () => {
	test('releases the file when idle and reopens it for the next statement', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
			idleReleaseMs: 20,
		});
		expect(fake.creates()).toBe(1);
		await pause(60);
		expect(fake.instanceCloses()).toBe(1);
		// Still usable: the next statement opens the file again.
		expect(archive.available).toBe(true);
		expect(await archive.record('us-east-1', '/g', [event()])).toBe(1);
		expect(fake.creates()).toBe(2);
		await archive.close();
	});

	test('keeps the file while statements keep coming', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
			idleReleaseMs: 40,
		});
		for (let round = 0; round < 4; round += 1) {
			await pause(15);
			await archive.record('us-east-1', '/g', [event({ id: `e${round}` })]);
		}
		expect(fake.instanceCloses()).toBe(0);
		await archive.close();
	});

	test('reports a lock taken while released, and recovers once it clears', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
			idleReleaseMs: 10,
		});
		await pause(40);
		const create = fake.driver.DuckDBInstance.create;
		fake.driver.DuckDBInstance.create = async () => {
			throw new Error('IO Error: Could not set lock on file');
		};
		expect(await archive.record('us-east-1', '/g', [event()])).toBe(0);
		expect(archive.error).toContain('locked by another process');
		fake.driver.DuckDBInstance.create = create;
		expect(await archive.record('us-east-1', '/g', [event()])).toBe(1);
		await archive.close();
	});

	test('stays open without the option', async () => {
		const fake = fakeDriver();
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		await pause(30);
		expect(fake.instanceCloses()).toBe(0);
		await archive.close();
	});

	test('reads the idle time from the environment', () => {
		expect(archiveIdleReleaseMs({})).toBe(0);
		expect(archiveIdleReleaseMs({ WATCH_TAIL_ARCHIVE_IDLE_MS: '5000' })).toBe(5000);
		expect(archiveIdleReleaseMs({ WATCH_TAIL_ARCHIVE_IDLE_MS: 'soon' })).toBe(0);
		expect(archiveIdleReleaseMs({ WATCH_TAIL_ARCHIVE_IDLE_MS: '-1' })).toBe(0);
	});
});

describe('LogArchive request-id backfill', () => {
	/** Candidates the fake backfill scan returns, in `seq` order. */
	const candidates = [
		{
			event_key: 'k1',
			region: 'af-south-1',
			log_group: '/g',
			message: 'RequestId: 1a2b3c4d',
			seq: BigInt(3),
		},
		{
			event_key: 'k2',
			region: 'af-south-1',
			log_group: '/g',
			message: 'no id on this line',
			seq: BigInt(4),
		},
	];

	test('fills the ids of rows written before the column existed', async () => {
		const fake = fakeDriver({
			respond: (sql) => {
				if (sql.includes('max(seq)')) return [{ maxSeq: BigInt(4) }];
				if (sql.includes('FROM archive_meta')) return [];
				if (sql.includes('request_id IS NULL')) return candidates;
				return [];
			},
		});
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});

		expect(archive.available).toBe(true);
		expect(archive.error).toBeNull();
		// One statement for the row that has an id, none for the row that has not.
		const updates = fake.calls.filter((call) => call.sql.startsWith('UPDATE log_events'));
		expect(updates).toHaveLength(1);
		expect(updates[0]?.params).toEqual(['af-south-1', '/g', 'k1', '1a2b3c4d']);
		// The watermark is the highest `seq` the pass looked at.
		const state = fake.calls.find((call) =>
			call.sql.includes('INSERT OR REPLACE INTO archive_meta'),
		);
		expect(state?.params).toEqual(['4']);
	});

	test('does not scan again once the watermark has caught up', async () => {
		const fake = fakeDriver({
			respond: (sql) => {
				if (sql.includes('max(seq)')) return [{ maxSeq: BigInt(9) }];
				if (sql.includes('FROM archive_meta')) return [{ value: '9' }];
				return [];
			},
		});
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		expect(archive.available).toBe(true);
		expect(fake.calls.some((call) => call.sql.includes('request_id IS NULL'))).toBe(false);
		expect(fake.calls.some((call) => call.sql.includes('INSERT OR REPLACE'))).toBe(false);
	});

	test('stops a capped pass at the last row it read and chunks its updates', async () => {
		const rows = Array.from({ length: REQUEST_ID_BACKFILL_LIMIT }, (_, index) => ({
			event_key: `k${index}`,
			region: 'af-south-1',
			log_group: '/g',
			message: `RequestId: 1a2b3c4d-${index}`,
			seq: BigInt(index + 1),
		}));
		const fake = fakeDriver({
			respond: (sql) => {
				if (sql.includes('max(seq)')) return [{ maxSeq: BigInt(50_000) }];
				if (sql.includes('FROM archive_meta')) return [];
				if (sql.includes('request_id IS NULL')) return rows;
				return [];
			},
		});
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});

		expect(archive.available).toBe(true);
		const updates = fake.calls.filter((call) => call.sql.startsWith('UPDATE log_events'));
		expect(updates).toHaveLength(REQUEST_ID_BACKFILL_LIMIT / ARCHIVE_INSERT_CHUNK);
		const state = fake.calls.find((call) =>
			call.sql.includes('INSERT OR REPLACE INTO archive_meta'),
		);
		// Capped at the row budget: the next open carries on from here.
		expect(state?.params).toEqual([String(REQUEST_ID_BACKFILL_LIMIT)]);
	});

	test('reports a failed backfill without failing the open', async () => {
		const fake = fakeDriver({
			respond: (sql) => {
				if (sql.includes('max(seq)')) throw new Error('table log_events is gone');
				return [];
			},
		});
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		expect(archive.available).toBe(true);
		expect(archive.error).toBe('table log_events is gone');
	});
});

describe('loadDuckDbDriver', () => {
	test('loads the real module when it is installed, and rejects when it is not', async () => {
		// The driver is an optional dependency, so both outcomes are valid here:
		// either it loads and exposes the factory, or the import fails.
		const installed = await loadDuckDbDriver().catch(() => null);
		expect(installed === null || typeof installed.DuckDBInstance.create === 'function').toBe(true);
	});
});

/** True when the optional DuckDB driver is installed on this machine. */
const driverInstalled = await loadDuckDbDriver().then(
	() => true,
	() => false,
);

describe.skipIf(!driverInstalled)('LogArchive against a real database file', () => {
	test('writes, de-duplicates, pages and searches', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'watch-tail-archive-'));
		const path = join(dir, 'archive.duckdb');
		const archive = await LogArchive.open({ path });
		try {
			expect(archive.available).toBe(true);
			const sameTimestamp = [
				event({ id: 'a', timestamp: TS, message: 'first line' }),
				event({ id: 'b', timestamp: TS, message: 'second line' }),
				event({ id: 'c', timestamp: TS + 1, message: 'ERROR third line' }),
			];
			expect(await archive.record('af-south-1', '/aws/lambda/api', sameTimestamp)).toBe(3);
			// Re-scanning the same window must not duplicate rows.
			await archive.record('af-south-1', '/aws/lambda/api', sameTimestamp);
			await archive.record('eu-west-1', '/aws/lambda/other', [
				event({ id: 'd', timestamp: TS + 2, message: 'other region' }),
			]);

			expect(await archive.totals()).toEqual({
				rows: 4,
				groups: 2,
				regions: 2,
				oldest: TS,
				newest: TS + 2,
			});

			const first = await archive.page({
				region: 'af-south-1',
				logGroups: ['/aws/lambda/api'],
				startTime: TS,
				endTime: TS + 10,
				limit: 2,
			});
			expect(first.events.map((item) => item.id)).toEqual(['a', 'b']);
			expect(first.last).toEqual({ timestamp: TS, seq: Number(first.last?.seq) });

			// Equal timestamps must not repeat or skip: the cursor breaks the tie.
			const second = await archive.page({
				region: 'af-south-1',
				logGroups: ['/aws/lambda/api'],
				startTime: TS,
				endTime: TS + 10,
				after: first.last,
				limit: 2,
			});
			expect(second.events.map((item) => item.id)).toEqual(['c']);

			const searched = await archive.page({
				region: 'af-south-1',
				logGroups: ['/aws/lambda/api'],
				startTime: TS,
				endTime: TS + 10,
				search: 'error',
				limit: 10,
			});
			expect(searched.events.map((item) => item.message)).toEqual(['ERROR third line']);

			const literal = await archive.page({
				region: 'af-south-1',
				logGroups: ['/aws/lambda/api'],
				startTime: TS,
				endTime: TS + 10,
				search: '%',
				limit: 10,
			});
			expect(literal.events).toEqual([]);

			// Levels are derived once on the way in and stored with their provenance.
			await archive.record('af-south-1', '/aws/lambda/api', [
				event({ id: 'level-json', timestamp: TS + 4, message: '{"level":"error","msg":"boom"}' }),
				event({ id: 'level-text', timestamp: TS + 5, message: 'WARN slow upstream' }),
				event({
					id: 'level-none',
					timestamp: TS + 6,
					message: '\tat com.example.Handler.invoke(Handler.java:41)',
				}),
			]);
			const all = await archive.page({
				region: 'af-south-1',
				logGroups: ['/aws/lambda/api'],
				startTime: TS + 4,
				endTime: TS + 6,
				limit: 10,
			});
			expect(all.events.map((item) => [item.id, item.level])).toEqual([
				['level-json', 'error'],
				['level-text', 'warn'],
				['level-none', null],
			]);

			const onlyErrors = await archive.page({
				region: 'af-south-1',
				logGroups: ['/aws/lambda/api'],
				startTime: TS,
				endTime: TS + 10,
				levels: ['error'],
				limit: 10,
			});
			// 'c' is the text-detected ERROR line recorded earlier, so both detection
			// paths are covered by one filter.
			expect(onlyErrors.events.map((item) => item.id)).toEqual(['c', 'level-json']);

			const warnings = await archive.page({
				region: 'af-south-1',
				logGroups: ['/aws/lambda/api'],
				startTime: TS,
				endTime: TS + 10,
				levels: ['warn', 'error'],
				limit: 10,
			});
			expect(warnings.events.map((item) => item.level).toSorted()).toEqual([
				'error',
				'error',
				'warn',
			]);

			// Rows stored before the level columns existed stay NULL, and a NULL level
			// is never returned by a level filter.
			expect(all.events.some((item) => item.level === null)).toBe(true);

			const groups = await archive.groups('eu-west-1');
			expect(groups).toEqual([
				{
					region: 'eu-west-1',
					logGroup: '/aws/lambda/other',
					events: 1,
					oldest: TS + 2,
					newest: TS + 2,
				},
			]);

			// Events without a CloudWatch id are keyed by content, so a re-scan is still idempotent.
			await archive.record('af-south-1', '/aws/lambda/api', [
				event({ id: null, timestamp: TS + 3, message: 'synthetic' }),
			]);
			await archive.record('af-south-1', '/aws/lambda/api', [
				event({ id: null, timestamp: TS + 3, message: 'synthetic' }),
			]);
			const after = await archive.page({
				region: 'af-south-1',
				logGroups: ['/aws/lambda/api'],
				startTime: TS + 3,
				endTime: TS + 3,
				limit: 10,
			});
			expect(after.events).toHaveLength(1);
			expect(after.events[0]?.id).toBe(
				archiveEventKey(event({ id: null, timestamp: TS + 3, message: 'synthetic' })),
			);
		} finally {
			await archive.close();
			rmSync(dir, { recursive: true, force: true });
		}
		expect(existsSync(path)).toBe(false);
	});

	test('buckets counts per group and level for the chart', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'watch-tail-series-'));
		const archive = await LogArchive.open({ path: join(dir, 'archive.duckdb') });
		const base = Date.UTC(2024, 4, 17, 12, 0, 0);
		try {
			await archive.record('af-south-1', '/a', [
				event({ id: 'a1', timestamp: base + 1_000, message: '{"level":"error","msg":"boom"}' }),
				event({ id: 'a2', timestamp: base + 2_000, message: '{"level":"info","msg":"ok"}' }),
				event({ id: 'a3', timestamp: base + 12_000, message: 'WARN slow' }),
				event({ id: 'a4', timestamp: base + 12_500, message: '\tat Handler.java:41' }),
			]);
			await archive.record('af-south-1', '/b', [
				event({ id: 'b1', timestamp: base + 15_000, message: '{"level":"error","msg":"other"}' }),
			]);

			const rows = await archive.seriesQuery({
				region: 'af-south-1',
				logGroups: ['/a', '/b'],
				startTime: base,
				endTime: base + 30_000,
				bucketMs: 10_000,
			});
			// Two buckets for /a (0-10s and 10-20s) and one for /b, with the NULL
			// level reported as `unknown` instead of being dropped.
			expect(rows.map((row) => [row.t - base, row.group, row.level, row.events])).toEqual([
				[0, '/a', 'error', 1],
				[0, '/a', 'info', 1],
				[10_000, '/a', 'unknown', 1],
				[10_000, '/a', 'warn', 1],
				[10_000, '/b', 'error', 1],
			]);

			const filtered = await archive.seriesQuery({
				region: 'af-south-1',
				logGroups: ['/a', '/b'],
				startTime: base,
				endTime: base + 30_000,
				bucketMs: 10_000,
				levels: ['error'],
			});
			expect(filtered.map((row) => [row.group, row.level, row.events])).toEqual([
				['/a', 'error', 1],
				['/b', 'error', 1],
			]);

			const singleGroup = await archive.seriesQuery({
				region: 'af-south-1',
				logGroups: ['/b'],
				startTime: base,
				endTime: base + 30_000,
				bucketMs: 10_000,
			});
			expect(singleGroup.map((row) => row.group)).toEqual(['/b']);
		} finally {
			await archive.close();
			rmSync(dir, { recursive: true, force: true });
		}
		expect(existsSync(join(dir, 'archive.duckdb'))).toBe(false);
	});
});

describe('describeOpenError and the lock retry', () => {
	test('explains a conflicting lock in terms the user can act on', () => {
		const duckdbMessage = `IO Error: Could not set lock on file "/tmp/archive.duckdb": Conflicting lock is held in /usr/bin/node (PID 123) by user stan. See also https://duckdb.org/docs/stable/connect/concurrency`;
		const described = describeOpenError(new Error(duckdbMessage), '/tmp/archive.duckdb');
		expect(described).toContain('/tmp/archive.duckdb is locked by another process');
		expect(described).toContain('--db');
		expect(described).not.toContain('duckdb.org');
	});

	test('passes any other failure through unchanged', () => {
		expect(describeOpenError(new Error('Cannot find module @duckdb/node-api'), '/x')).toBe(
			'Cannot find module @duckdb/node-api',
		);
		expect(describeOpenError('disk full', '/x')).toBe('disk full');
	});

	test('retries a locked archive and succeeds once the lock clears', async () => {
		let attempts = 0;
		const driver: Driver = {
			DuckDBInstance: {
				create: async () => {
					attempts += 1;
					if (attempts < LOCK_RETRIES) {
						throw new Error('IO Error: Could not set lock on file "/tmp/a.duckdb"');
					}
					return {
						connect: async () =>
							fakeDriver()
								.driver.DuckDBInstance.create('/x')
								.then((i) => i.connect())
								.then(() => ({
									run: async () => undefined,
									runAndReadAll: async () => ({ getRowObjects: () => [] }),
								})),
					};
				},
			},
		};
		const archive = await LogArchive.open({
			path: '/tmp/a.duckdb',
			load: async () => driver,
			ensureDir: () => undefined,
		});
		expect(attempts).toBe(LOCK_RETRIES);
		expect(archive.available).toBe(true);
	});

	test('reports the lock message when it never clears', async () => {
		const archive = await LogArchive.open({
			path: '/tmp/locked.duckdb',
			load: async () =>
				fakeDriver({ createFails: 'IO Error: Could not set lock on file "/x"' }).driver,
			ensureDir: () => undefined,
		});
		expect(archive.available).toBe(false);
		expect(archive.error).toContain('locked by another process');
	});
});

/** Driver instance with the close the real driver exposes and the type omits. */
type ClosableInstance = { connect: () => Promise<DriverConnection>; closeSync?: () => void };

/**
 * Runs statements against an archive file no {@link LogArchive} holds open.
 *
 * The spec uses it to put a file into the state an older build left behind, and
 * to read back what the archive wrote (the `archive_meta` watermark, for
 * instance), which the archive API does not expose.
 */
async function runRaw(
	path: string,
	statements: readonly (readonly [string, readonly ArchiveParam[]])[],
): Promise<void> {
	const driver = await loadDuckDbDriver();
	const instance = (await driver.DuckDBInstance.create(path)) as ClosableInstance;
	const connection = await instance.connect();
	try {
		for (const [sql, params] of statements) await connection.run(sql, [...params]);
	} finally {
		connection.closeSync?.();
		instance.closeSync?.();
	}
}

/** Reads one statement from a closed archive file. */
async function readRaw(path: string, sql: string): Promise<Record<string, unknown>[]> {
	const driver = await loadDuckDbDriver();
	const instance = (await driver.DuckDBInstance.create(path)) as ClosableInstance;
	const connection = await instance.connect();
	try {
		const result = await connection.runAndReadAll(sql);
		return result.getRowObjects();
	} finally {
		connection.closeSync?.();
		instance.closeSync?.();
	}
}

describe.skipIf(!driverInstalled)('request ids against a real database file', () => {
	test('fills the ids of an archive written before the column existed', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'watch-tail-backfill-'));
		const path = join(dir, 'archive.duckdb');
		try {
			const first = await LogArchive.open({ path });
			await first.record('af-south-1', '/g', [
				event({ id: 'k1', timestamp: TS, message: '{"message":"ok","requestId":"req-9f2c"}' }),
				event({ id: 'k2', timestamp: TS + 1, message: 'boom RequestId: 1a2b3c4d' }),
				event({ id: 'k3', timestamp: TS + 2, message: 'plain line' }),
			]);
			await first.close();

			// What an older build left behind: rows without ids and no watermark.
			await runRaw(path, [
				['UPDATE log_events SET request_id = NULL', []],
				['DELETE FROM archive_meta', []],
			]);

			const second = await LogArchive.open({ path });
			expect(second.available).toBe(true);
			expect(second.error).toBeNull();
			const page = await second.page({
				region: 'af-south-1',
				logGroups: ['/g'],
				startTime: TS,
				endTime: TS + 10,
				limit: 10,
			});
			expect(page.events.map((entry) => [entry.id, entry.requestId])).toEqual([
				['k1', 'req-9f2c'],
				['k2', '1a2b3c4d'],
				// Nothing to detect: the row stays NULL, and no property is sent.
				['k3', undefined],
			]);
			await second.close();

			// The watermark is the highest `seq` the pass looked at, and the row it
			// could not fill stayed NULL rather than becoming an empty string.
			expect(await readRaw(path, 'SELECT key, value FROM archive_meta')).toEqual([
				{ key: 'request_id_backfill', value: '3' },
			]);
			expect(
				await readRaw(path, 'SELECT event_key, request_id FROM log_events ORDER BY seq'),
			).toEqual([
				{ event_key: 'k1', request_id: 'req-9f2c' },
				{ event_key: 'k2', request_id: '1a2b3c4d' },
				{ event_key: 'k3', request_id: null },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('counts one mark per request', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'watch-tail-request-series-'));
		const base = Date.UTC(2024, 4, 17, 12, 0, 0);
		const archive = await LogArchive.open({ path: join(dir, 'archive.duckdb') });
		try {
			await archive.record('af-south-1', '/a', [
				event({
					id: 'r1',
					timestamp: base + 1_000,
					message: '{"requestId":"req-1","level":"info"}',
				}),
				event({
					id: 'r2',
					timestamp: base + 2_000,
					message: '{"requestId":"req-1","level":"error"}',
				}),
				event({
					id: 'r3',
					timestamp: base + 3_000,
					message: '{"requestId":"req-1","level":"info"}',
				}),
				event({ id: 'x1', timestamp: base + 4_000, message: '{"level":"warn"}' }),
				event({ id: 'x2', timestamp: base + 14_000, message: 'no id, no level' }),
			]);

			const request = {
				region: 'af-south-1',
				logGroups: ['/a'],
				startTime: base,
				endTime: base + 30_000,
				bucketMs: 10_000,
				by: 'request' as const,
			};
			const rows = await archive.seriesQuery(request);
			// Three lines of req-1 are one mark, at their first line, coloured by the
			// error among them; a line with no request id is a request of its own.
			expect(rows.map((row) => [row.t - base, row.group, row.level, row.events])).toEqual([
				[0, '/a', 'error', 1],
				[0, '/a', 'warn', 1],
				[10_000, '/a', 'unknown', 1],
			]);

			const errors = await archive.seriesQuery({ ...request, levels: ['error'] });
			// The filter selects a request by its worst level, so the warn-only and the
			// unlevelled requests are out.
			expect(errors.map((row) => [row.t - base, row.level, row.events])).toEqual([[0, 'error', 1]]);

			// The event form still counts every line, so the old answer is unchanged.
			const events = await archive.seriesQuery({ ...request, by: 'event' });
			expect(events.map((row) => [row.level, row.events]).toSorted()).toEqual([
				['error', 1],
				['info', 2],
				['unknown', 1],
				['warn', 1],
			]);
		} finally {
			await archive.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('LogArchive coverage', () => {
	/** Opens an archive whose driver answers coverage reads from `rows`. */
	async function coverageArchive(
		rows: Record<string, unknown>[] = [],
	): Promise<{ archive: LogArchive; fake: ReturnType<typeof fakeDriver> }> {
		const fake = fakeDriver({
			respond: (sql) => (sql.includes('FROM archive_coverage') ? rows : []),
		});
		const archive = await LogArchive.open({
			path: '/tmp/archive.duckdb',
			load: async () => fake.driver,
			ensureDir: () => undefined,
		});
		return { archive, fake };
	}

	test('reads and merges the coverage of a window', async () => {
		const { archive } = await coverageArchive([
			{ log_group: '/g', start_ms: BigInt(10), end_ms: BigInt(20) },
			{ log_group: '/g', start_ms: BigInt(21), end_ms: BigInt(30) },
			{ log_group: '/other', start_ms: BigInt(5), end_ms: BigInt(6) },
		]);
		const coverage = await archive.coverage('us-east-1', ['/g', '/other'], 0, 100);
		expect(coverage.get('/g')).toEqual([{ start: 10, end: 30 }]);
		expect(coverage.get('/other')).toEqual([{ start: 5, end: 6 }]);
	});

	test('merges new coverage into what the group already had', async () => {
		const { archive, fake } = await coverageArchive([{ start_ms: BigInt(10), end_ms: BigInt(20) }]);
		await archive.recordCoverage('us-east-1', [{ logGroup: '/g', start: 21, end: 30 }]);

		const insert = fake.calls.find((call) => call.sql.startsWith('INSERT INTO archive_coverage'));
		expect(insert?.params).toEqual(['us-east-1', '/g', 10n, 30n]);
		const removal = fake.calls.find((call) => call.sql.startsWith('DELETE FROM archive_coverage'));
		expect(removal?.params).toEqual(['us-east-1', '/g']);
	});

	test('writes the new range when the group had none', async () => {
		const { archive, fake } = await coverageArchive([]);
		await archive.recordCoverage('us-east-1', [{ logGroup: '/g', start: 1, end: 2 }]);
		const insert = fake.calls.find((call) => call.sql.startsWith('INSERT INTO archive_coverage'));
		expect(insert?.params).toEqual(['us-east-1', '/g', 1n, 2n]);
	});

	test('does nothing without entries', async () => {
		const { archive, fake } = await coverageArchive();
		await archive.recordCoverage('us-east-1', []);
		const changed = fake.calls.filter(
			(call) =>
				call.sql.startsWith('INSERT INTO archive_coverage') ||
				call.sql.startsWith('DELETE FROM archive_coverage'),
		);
		expect(changed).toEqual([]);
	});

	test('an unavailable archive reports no coverage and swallows a write', async () => {
		const archive = LogArchive.unavailable('/tmp/archive.duckdb', 'no driver');
		expect(await archive.coverage('us-east-1', ['/g'], 0, 100)).toEqual(new Map());
		await expect(
			archive.recordCoverage('us-east-1', [{ logGroup: '/g', start: 1, end: 2 }]),
		).resolves.toBeUndefined();
	});
});

describe.skipIf(!driverInstalled)('LogArchive coverage against a real database file', () => {
	test('records, merges and reads coverage per group', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'watch-tail-coverage-'));
		const path = join(dir, 'archive.duckdb');
		const archive = await LogArchive.open({ path });
		try {
			expect(archive.available).toBe(true);

			await archive.recordCoverage('af-south-1', [
				{ logGroup: '/aws/lambda/api', start: TS, end: TS + 100 },
				{ logGroup: '/aws/lambda/api', start: TS + 101, end: TS + 200 },
				{ logGroup: '/aws/lambda/other', start: TS, end: TS + 50 },
			]);
			// Adjacent ranges merge in SQL as well as in the code that plans them.
			expect(await archive.coverage('af-south-1', ['/aws/lambda/api'], TS, TS + 200)).toEqual(
				new Map([['/aws/lambda/api', [{ start: TS, end: TS + 200 }]]]),
			);

			// A later scan that closes the gap leaves one range.
			await archive.recordCoverage('af-south-1', [
				{ logGroup: '/aws/lambda/api', start: TS + 200, end: TS + 400 },
			]);
			expect(await archive.coverage('af-south-1', ['/aws/lambda/api'], 0, TS + 1000)).toEqual(
				new Map([['/aws/lambda/api', [{ start: TS, end: TS + 400 }]]]),
			);

			// The window query clips to what overlaps and keeps groups apart.
			expect(
				await archive.coverage(
					'af-south-1',
					['/aws/lambda/api', '/aws/lambda/other'],
					TS + 40,
					TS + 60,
				),
			).toEqual(
				new Map([
					['/aws/lambda/api', [{ start: TS, end: TS + 400 }]],
					['/aws/lambda/other', [{ start: TS, end: TS + 50 }]],
				]),
			);
			// Another region is a different archive slice.
			expect(await archive.coverage('eu-west-1', ['/aws/lambda/api'], 0, TS + 1000)).toEqual(
				new Map(),
			);
		} finally {
			await archive.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
