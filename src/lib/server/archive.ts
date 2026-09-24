/**
 * Local DuckDB archive of the events the app has streamed.
 *
 * The driver (`@duckdb/node-api` plus its per-platform native binding) is an
 * optional dependency: it is imported lazily, on the first request that needs
 * it, and every failure is turned into an unavailable archive instead of an
 * error. The rest of the app therefore works unchanged on platforms where the
 * binding is missing.
 *
 * One process owns the file: DuckDB allows a single writer, and the SvelteKit
 * server is that writer. Statements are serialised through an internal queue so
 * a stream writing while another request reads cannot interleave on the
 * connection.
 */
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ArchiveLocator, type ArchiveSelection } from './archive-location';
import { setTimeout as delay } from 'node:timers/promises';
import type { LogEventDto } from '$lib/types';
import {
	ARCHIVE_INSERT_CHUNK,
	ARCHIVE_MAX_SEQ_SQL,
	ARCHIVE_SCHEMA,
	ARCHIVE_TOTALS_SQL,
	REQUEST_ID_BACKFILL_LIMIT,
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
	buildSeriesQuery,
	toArchiveParams,
	toCoverageParams,
	toRequestIdBackfillParams,
	type ArchiveCursor,
	type ArchiveGroupRow,
	type ArchivePageRequest,
	type ArchiveSeriesRequest,
	type ArchiveSeriesRow,
	type ArchiveParam,
	type ArchiveTotals,
	type CoverageEntry,
	type CoverageInterval,
} from './archive-sql';

/** Package name of the optional DuckDB driver. */
export const DUCKDB_MODULE = '@duckdb/node-api';

/** Directory name used under the platform data directory. */
export const ARCHIVE_DIR_NAME = 'watch-tail';

/** File name of the archive inside {@link ARCHIVE_DIR_NAME}. */
export const ARCHIVE_FILE_NAME = 'archive.duckdb';

/** Result of one statement, reduced to what the archive reads. */
export type DriverResult = { getRowObjects: () => Record<string, unknown>[] };

/** Connection surface used by {@link LogArchive}. */
export type DriverConnection = {
	run: (sql: string, params?: ArchiveParam[]) => Promise<unknown>;
	runAndReadAll: (sql: string, params?: ArchiveParam[]) => Promise<DriverResult>;
	closeSync?: () => void;
};

/** Instance surface used by {@link LogArchive}. */
export type DriverInstance = { connect: () => Promise<DriverConnection> };

/** Driver surface used by {@link LogArchive}. */
export type Driver = {
	DuckDBInstance: { create: (path: string) => Promise<DriverInstance> };
};

/** Resolves the DuckDB driver; injectable so tests never need the native module. */
export type DriverLoader = () => Promise<Driver>;

/**
 * Imports the optional DuckDB driver.
 *
 * The specifier is held in a variable on purpose: bundlers must leave the
 * import alone so Node resolves it at run time, where a missing binding can be
 * reported as an unavailable archive rather than a build error.
 */
export async function loadDuckDbDriver(): Promise<Driver> {
	const moduleName = DUCKDB_MODULE;
	const loaded = (await import(moduleName)) as Partial<Driver>;
	if (typeof loaded.DuckDBInstance?.create !== 'function') {
		throw new Error(`${DUCKDB_MODULE} did not expose DuckDBInstance.create`);
	}
	return loaded as Driver;
}

/** Archive settings resolved from the environment. */
export type ArchiveConfig = {
	/** False when `WATCH_TAIL_ARCHIVE` turns the archive off. */
	enabled: boolean;
	/** Database file the archive would use. */
	path: string;
};

const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

/** True when an environment value means "off". */
function isDisabled(value: string | undefined): boolean {
	return value !== undefined && DISABLED_VALUES.has(value.trim().toLowerCase());
}

/**
 * True when this process is a test runner.
 *
 * Vitest sets `VITEST`, and `NODE_ENV=test` covers other harnesses. Tests must
 * not append to the archive of the machine they run on, so the archive is off
 * unless a test asks for it through `WATCH_TAIL_ARCHIVE_DB` or
 * `WATCH_TAIL_ARCHIVE=on`.
 */
function isTestProcess(env: Record<string, string | undefined>): boolean {
	return env.VITEST !== undefined || env.NODE_ENV === 'test';
}

/**
 * Resolves the archive file path.
 *
 * `WATCH_TAIL_ARCHIVE_DB` wins; otherwise the file lives in the platform's
 * data directory (`XDG_DATA_HOME`, `%LOCALAPPDATA%` or
 * `~/Library/Application Support`), never in the current directory, so history
 * survives running the CLI from a different folder.
 */
export function resolveArchiveConfig(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): ArchiveConfig {
	const path = env.WATCH_TAIL_ARCHIVE_DB?.trim() ?? '';
	const dataDir =
		env.XDG_DATA_HOME?.trim() ??
		(platform === 'darwin'
			? join(home, 'Library', 'Application Support')
			: platform === 'win32'
				? (env.LOCALAPPDATA?.trim() ?? join(home, 'AppData', 'Local'))
				: join(home, '.local', 'share'));
	const requested = env.WATCH_TAIL_ARCHIVE?.trim() ?? '';
	const enabled = isDisabled(requested)
		? false
		: path.length > 0 || requested.length > 0
			? true
			: !isTestProcess(env);
	return {
		enabled,
		path: path.length > 0 ? path : join(dataDir, ARCHIVE_DIR_NAME, ARCHIVE_FILE_NAME),
	};
}

/** Options accepted by {@link LogArchive.open}. */
export type LogArchiveOptions = {
	/** Database file to create or open. */
	path: string;
	/** Driver loader; defaults to {@link loadDuckDbDriver}. */
	load?: DriverLoader;
	/** Directory creator; injected by tests to avoid touching the filesystem. */
	ensureDir?: (dir: string) => void;
};

/** What the UI and the CLI need to know about the archive. */
export type ArchiveStatus = {
	path: string;
	available: boolean;
	error: string | null;
	bytes: number | null;
	totals: ArchiveTotals;
};

/**
 * Attempts made when the file is locked, and the pause between them.
 *
 * DuckDB releases its lock within about 90 ms of the owning process exiting, so
 * this only covers the restart race (the CLI restarts the server when it
 * switches profile) - it is not a wait for another long-running instance.
 */
export const LOCK_RETRIES = 3;
/** Pause between lock retries. */
export const LOCK_RETRY_MS = 150;

/**
 * A short, non-throwing description of an unknown failure.
 *
 * A conflicting lock is the one failure a user can act on, and DuckDB's own
 * message buries the reason in a pid and a documentation link, so it is
 * reported as what it means for this app.
 */
export function describeOpenError(error: unknown, path: string): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/Could not set lock|Conflicting lock/i.test(message)) {
		return `the archive file ${path} is locked by another process (another watch-tail is using it); use --db to keep a separate file`;
	}
	return message;
}

/** True when the failure is the exclusive file lock. */
function isLockError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Could not set lock|Conflicting lock/i.test(message);
}

/**
 * One DuckDB file holding every event the app has streamed.
 *
 * `open` never throws: a missing driver, a locked file or a corrupt database all
 * produce an instance with `available === false` and the reason on `error`. The
 * read and write methods then behave as no-ops, so callers never have to guard
 * their happy path.
 */
export class LogArchive {
	/** Database file this archive uses. */
	readonly path: string;
	#connection: DriverConnection | null = null;
	#available = false;
	#error: string | null = null;
	#queue: Promise<unknown> = Promise.resolve();

	private constructor(path: string) {
		this.path = path;
	}

	/**
	 * Opens (and creates) the archive.
	 *
	 * Statements are executed in order: the sequence first, then the table, then
	 * the indexes, so an existing file from an older build is upgraded in place.
	 * The request-id backfill runs last, inside the same serialised path, and
	 * cannot fail the open.
	 */
	static async open(options: LogArchiveOptions): Promise<LogArchive> {
		const archive = new LogArchive(options.path);
		const load: DriverLoader = options.load ?? loadDuckDbDriver;
		const ensureDir: (dir: string) => void =
			options.ensureDir ?? ((dir) => mkdirSync(dir, { recursive: true }));
		try {
			ensureDir(dirname(options.path));
			const driver = await load();
			for (let attempt = 1; ; attempt += 1) {
				try {
					const instance = await driver.DuckDBInstance.create(options.path);
					const connection = await instance.connect();
					for (const statement of ARCHIVE_SCHEMA) await connection.run(statement);
					archive.#connection = connection;
					archive.#available = true;
					// Rows written before `request_id` existed hold NULL, which is not a
					// verdict for that column, so they are scanned once here. The call is
					// guarded: a failure is reported on `error` and the open still succeeds.
					await archive.#backfillRequestIds();
					break;
				} catch (error) {
					// A server that just restarted may still be releasing the lock.
					if (attempt >= LOCK_RETRIES || !isLockError(error)) throw error;
					await delay(LOCK_RETRY_MS);
				}
			}
		} catch (error) {
			archive.#available = false;
			archive.#error = describeOpenError(error, options.path);
		}
		return archive;
	}

	/**
	 * An archive that is off by configuration or could not be opened.
	 *
	 * Every method degrades to a no-op, so callers can use one code path for
	 * "no DuckDB on this machine" and "the user asked for no archive".
	 */
	static unavailable(path: string, error: string | null = null): LogArchive {
		const archive = new LogArchive(path);
		archive.#available = false;
		archive.#error = error;
		return archive;
	}

	/** True when the archive can be read and written. */
	get available(): boolean {
		return this.#available;
	}

	/** Why the archive is unavailable, or the last failure, or `null`. */
	get error(): string | null {
		return this.#error;
	}

	/** Runs one task after every task queued before it. */
	#enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = this.#queue.then(task, task);
		this.#queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	/** Runs a statement, returning the failure instead of throwing. */
	async #guard<T>(fallback: T, task: () => Promise<T>): Promise<T> {
		if (this.#connection === null) return fallback;
		return this.#enqueue(async () => {
			try {
				return await task();
			} catch (error) {
				this.#error = error instanceof Error ? error.message : String(error);
				return fallback;
			}
		});
	}

	/**
	 * Migrates the request id of rows written before the column existed.
	 *
	 * It runs inside {@link LogArchive.#guard}, so it shares the serialised
	 * statement queue with every other write and reports a failure on `error`
	 * instead of letting it escape `open`. The watermark is the highest `seq` the
	 * migration has looked at, so a capped or interrupted pass carries on from
	 * there on the next open and no row is scanned twice; a row whose message
	 * holds no id stays NULL, which is the archive's answer for that row.
	 */
	async #backfillRequestIds(): Promise<void> {
		await this.#guard(undefined, async () => {
			const connection = this.#connection;
			if (connection === null) return;
			// Ceiling of the pass: nothing above the highest `seq` exists yet.
			const ceiling = rowToMaxSeq(
				(await connection.runAndReadAll(ARCHIVE_MAX_SEQ_SQL)).getRowObjects()[0],
			);
			if (ceiling === null) return;
			const watermark = rowToBackfillWatermark(
				(await connection.runAndReadAll(buildRequestIdBackfillStateQuery())).getRowObjects()[0],
			);
			// Everything up to the ceiling has been looked at already.
			if (watermark !== null && watermark >= ceiling) return;

			const { sql, params } = buildRequestIdBackfillQuery({
				maxSeq: ceiling,
				afterSeq: watermark,
				limit: REQUEST_ID_BACKFILL_LIMIT,
			});
			const candidates = rowsToBackfillCandidates(
				(await connection.runAndReadAll(sql, params)).getRowObjects(),
			);
			const updates = planRequestIdBackfill(candidates);
			for (let start = 0; start < updates.length; start += ARCHIVE_INSERT_CHUNK) {
				const chunk = updates.slice(start, start + ARCHIVE_INSERT_CHUNK);
				await connection.run(
					buildRequestIdBackfillUpdate(chunk.length),
					toRequestIdBackfillParams(chunk),
				);
			}
			// A pass that ran out of rows has seen everything up to the ceiling; a
			// capped one stopped at the last row it read.
			const scanned =
				candidates.length < REQUEST_ID_BACKFILL_LIMIT ? ceiling : maxSeqOf(candidates);
			await connection.run(buildRequestIdBackfillStateWrite(), [String(scanned ?? ceiling)]);
		});
	}

	/**
	 * Writes one batch of streamed events.
	 *
	 * Batches are split into chunks of {@link ARCHIVE_INSERT_CHUNK} rows, and
	 * `INSERT OR IGNORE` plus the unique index make a repeated scan idempotent.
	 * Failures never propagate: a full disk must not interrupt a log stream.
	 */
	async record(region: string, logGroup: string, events: readonly LogEventDto[]): Promise<number> {
		if (events.length === 0) return 0;
		return this.#guard(0, async () => {
			const connection = this.#connection;
			if (connection === null) return 0;
			let written = 0;
			for (let start = 0; start < events.length; start += ARCHIVE_INSERT_CHUNK) {
				const chunk = events.slice(start, start + ARCHIVE_INSERT_CHUNK);
				await connection.run(
					buildInsertSql(chunk.length),
					toArchiveParams(region, logGroup, chunk),
				);
				written += chunk.length;
			}
			return written;
		});
	}

	/** Reads one page of archived events. */
	async page(
		request: ArchivePageRequest,
	): Promise<{ events: LogEventDto[]; last: ArchiveCursor | null }> {
		const empty = { events: [] as LogEventDto[], last: null };
		return this.#guard(empty, async () => {
			const connection = this.#connection;
			if (connection === null) return empty;
			const { sql, params } = buildPageQuery(request);
			const result = await connection.runAndReadAll(sql, params);
			return rowsToPage(result.getRowObjects());
		});
	}

	/**
	 * Bucketed counts for the chart, per group and level.
	 *
	 * The request is forwarded as it arrives: it carries the grouping that says
	 * whether a mark counts an event or a request.
	 */
	async seriesQuery(request: ArchiveSeriesRequest): Promise<ArchiveSeriesRow[]> {
		return this.#guard([], async () => {
			const connection = this.#connection;
			if (connection === null) return [];
			const { sql, params } = buildSeriesQuery(request);
			const result = await connection.runAndReadAll(sql, params);
			return rowsToSeries(result.getRowObjects());
		});
	}

	/** Aggregate row count and time bounds. */
	async totals(): Promise<ArchiveTotals> {
		return this.#guard(rowToTotals(undefined), async () => {
			const connection = this.#connection;
			if (connection === null) return rowToTotals(undefined);
			const result = await connection.runAndReadAll(ARCHIVE_TOTALS_SQL);
			return rowToTotals(result.getRowObjects()[0]);
		});
	}

	/** Log groups held by the archive, optionally limited to one region. */
	async groups(region: string | null = null): Promise<ArchiveGroupRow[]> {
		return this.#guard([], async () => {
			const connection = this.#connection;
			if (connection === null) return [];
			const { sql, params } = buildGroupsQuery(region);
			const result = await connection.runAndReadAll(sql, params);
			return rowsToGroups(result.getRowObjects());
		});
	}

	/**
	 * The ranges this archive is known to hold, per log group, within a window.
	 *
	 * Coverage is what makes a historic view able to read from the archive
	 * instead of CloudWatch: it says which ranges watch-tail has already queried
	 * and archived, so the request only has to ask AWS for the rest. An
	 * unavailable archive answers an empty map, which sends the caller back to
	 * CloudWatch for everything.
	 */
	async coverage(
		region: string,
		logGroups: readonly string[],
		start: number,
		end: number,
	): Promise<Map<string, CoverageInterval[]>> {
		return this.#guard(new Map<string, CoverageInterval[]>(), async () => {
			const connection = this.#connection;
			if (connection === null) return new Map<string, CoverageInterval[]>();
			const { sql, params } = buildCoverageQuery(region, logGroups, start, end);
			const result = await connection.runAndReadAll(sql, params);
			return rowsToCoverageByGroup(result.getRowObjects());
		});
	}

	/**
	 * Records the ranges a scan actually queried, merging them into what is known.
	 *
	 * One statement per group rewrites that group's intervals: the existing rows
	 * are merged with the new ranges in JavaScript (which is where the adjacency
	 * and overlap rules live) and written back as a small set. The archive is
	 * single-writer, so this is serialised with the streams that are writing log
	 * rows, and a failure is reported on `error` without interrupting a view.
	 */
	async recordCoverage(region: string, entries: readonly CoverageEntry[]): Promise<void> {
		if (entries.length === 0) return;
		await this.#guard<void>(undefined, async () => {
			const connection = this.#connection;
			if (connection === null) return;
			const byGroup = new Map<string, CoverageInterval[]>();
			for (const entry of entries) {
				const list = byGroup.get(entry.logGroup);
				if (list === undefined)
					byGroup.set(entry.logGroup, [{ start: entry.start, end: entry.end }]);
				else list.push({ start: entry.start, end: entry.end });
			}
			for (const [logGroup, intervals] of byGroup) {
				const query = buildCoverageGroupQuery(region, logGroup);
				const existing = await connection.runAndReadAll(query.sql, query.params);
				const known = mergeCoverage(rowsToCoverage(existing.getRowObjects()));
				const merged = mergeCoverage([...known, ...intervals]);
				const removal = buildCoverageDeleteQuery(region, logGroup);
				await connection.run(removal.sql, removal.params);
				for (let start = 0; start < merged.length; start += ARCHIVE_INSERT_CHUNK) {
					const chunk = merged.slice(start, start + ARCHIVE_INSERT_CHUNK);
					await connection.run(
						buildCoverageInsert(chunk.length),
						toCoverageParams(region, logGroup, chunk),
					);
				}
			}
		});
	}

	/** Status for `GET /api/archive`, including the file size on disk. */
	async status(): Promise<ArchiveStatus> {
		const totals = await this.totals();
		let bytes: number | null = null;
		if (this.#available) {
			try {
				bytes = statSync(this.path).size;
			} catch {
				bytes = null;
			}
		}
		return { path: this.path, available: this.#available, error: this.#error, bytes, totals };
	}

	/** Closes the connection. Safe to call twice. */
	async close(): Promise<void> {
		const connection = this.#connection;
		this.#connection = null;
		this.#available = false;
		if (connection?.closeSync === undefined) return;
		await this.#enqueue(async () => {
			connection.closeSync?.();
		});
	}
}

/** A single opening promise per absolute file path prevents duplicate DuckDB writers. */
const sharedArchives = new Map<string, Promise<LogArchive>>();
let archiveLocator = new ArchiveLocator();

/** Opens the selected account/region archive; explicit --db paths remain file overrides. */
export async function getArchive(
	env: Record<string, string | undefined>,
	selection: ArchiveSelection = {},
	load?: DriverLoader,
): Promise<LogArchive> {
	const config = resolveArchiveConfig(env);
	if (!config.enabled) return LogArchive.unavailable(config.path);
	let path = config.path;
	if (!env.WATCH_TAIL_ARCHIVE_DB?.trim()) {
		try {
			path = await archiveLocator.locate(config.path, env, selection);
		} catch (error) {
			return LogArchive.unavailable(
				config.path,
				`Cannot select account archive: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	path = resolve(path);
	let archive = sharedArchives.get(path);
	if (!archive) {
		archive = LogArchive.open({ path, ...(load === undefined ? {} : { load }) });
		sharedArchives.set(path, archive);
	}
	return archive;
}

/** Forgets cached handles and identity mappings; callers close archives before resetting. */
export function resetArchive(): void {
	sharedArchives.clear();
	archiveLocator = new ArchiveLocator();
}
