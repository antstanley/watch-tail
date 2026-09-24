/**
 * The MCP tool catalogue, built on `tmcp`.
 *
 * tmcp owns the protocol: it negotiates the client's protocol revision (including
 * the latest `2026-07-28`), advertises capabilities, validates arguments against
 * the valibot schemas below and frames the responses. This module only says what
 * watch-tail can do and how a tool call maps onto the backend.
 *
 * The schemas are the contract an agent sees, so every field carries a
 * description; validation failures are reported by tmcp as tool errors rather
 * than reaching the handlers.
 */
import { McpServer } from 'tmcp';
import { defineTool } from 'tmcp/tool';
import { tool } from 'tmcp/utils';
import { ValibotJsonSchemaAdapter } from '@tmcp/adapter-valibot';
import * as v from 'valibot';
import type { LogEventDto, SeriesPoint } from '../../lib/types.ts';
import type { McpBackend, SearchResult } from './backend.ts';

/** Guidance sent to the agent when it connects. */
const MCP_INSTRUCTIONS = `watch-tail serves CloudWatch Logs and its local DuckDB archive.
Every search is a bounded, historic window, like the UI's Historic mode. source="cloudwatch" is the
default and is archive-first: it reads the archive for the ranges it holds and only calls AWS for
the gaps, so it is fast and complete. Use source="archive" to stay entirely on this machine (no AWS
calls, and no 14-day limit - the archive keeps history CloudWatch has already dropped). Start with
archive_status to see what is stored and which regions it covers, then list_log_groups to find a
group, then search_logs or count_logs. CloudWatch has no level field, so use filterPattern with
source="cloudwatch". Timestamps are epoch milliseconds in JSON, and every event also carries an ISO
8601 time.`;

/** Shared property descriptions. */
const REGION = 'AWS region. Defaults to the region the server resolved (profile or AWS_REGION).';
const GROUPS =
	'One or more log group names. Call list_log_groups first; a comma-separated string is accepted too.';
const SOURCE =
	'Where to read: "cloudwatch" (AWS, the default; reads the archive first for historic windows) or "archive" (local DuckDB only, no AWS calls).';

/** Source used when a tool call does not name one. */
const DEFAULT_SOURCE = 'cloudwatch';
const FROM =
	'Window start: a duration ("30m", "2h"), epoch milliseconds, or an ISO 8601 timestamp.';
const TO = 'Window end, in the same forms as from. Defaults to now.';
const RANGE = 'Preset window when from/to are absent: 15m, 1h, 3h, 12h, 24h or 5d.';
const LEVELS = 'Archive only: comma-separated levels to keep: error, warn, info, debug.';

/** A field that is optional and documented. */
function described<T extends v.GenericSchema>(schema: T, description: string) {
	return v.optional(v.pipe(schema, v.description(description)));
}

const regionField = described(v.string(), REGION);
const sourceField = v.optional(
	v.pipe(v.picklist(['archive', 'cloudwatch']), v.description(SOURCE)),
);
const windowFields = {
	from: described(v.string(), FROM),
	to: described(v.string(), TO),
	range: described(v.string(), RANGE),
};

/** Normalises a comma-separated string or an array into a de-duplicated list. */
function toList(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	const items = Array.isArray(value) ? value : value.split(',');
	const list: string[] = [];
	for (const item of items) {
		const trimmed = item.trim();
		if (trimmed.length > 0) list.push(trimmed);
	}
	return [...new Set(list)];
}

/** One event as the agent sees it, with a readable timestamp beside the epoch. */
export type McpEvent = {
	timestamp: number;
	time: string;
	group: string | null;
	stream: string | null;
	level: string | null;
	requestId: string | null;
	message: string;
};

/** Formats one event for the agent. */
export function formatEvent(event: LogEventDto): McpEvent {
	return {
		timestamp: event.timestamp,
		time: new Date(event.timestamp).toISOString(),
		group: event.group ?? null,
		stream: event.streamName ?? null,
		level: event.level ?? null,
		requestId: event.requestId ?? null,
		message: event.message,
	};
}

/** Renders a value as pretty JSON for the MCP text content. */
function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/** A short, readable message for a backend failure. */
/**
 * Turns a thrown value into the text of a tool error.
 *
 * A failed CloudWatch search is the common case on a machine without working
 * AWS credentials, so it says how to get an answer from the local archive
 * instead.
 */
function failureText(error: unknown, source?: 'archive' | 'cloudwatch'): string {
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as { code?: unknown }).code;
	const base =
		typeof code === 'string' && code.length > 0
			? `watch-tail error: ${message} (code: ${code})`
			: `watch-tail error: ${message}`;
	return source === 'cloudwatch'
		? `${base}. If these events are already stored locally, retry with source="archive".`
		: base;
}

/** Everything the server needs to answer a tool call. */
export type WatchTailServerInput = {
	backend: McpBackend;
	/** Version of watch-tail, reported as the server version. */
	version: string;
	/** Region used by tools that do not name one. */
	region?: string | null;
};

/**
 * Builds the tmcp server with the watch-tail tools registered.
 *
 * The valibot adapter turns each schema into the JSON Schema the client validates
 * against, and validates the arguments before the handler runs.
 */
export function createWatchTailServer(input: WatchTailServerInput): McpServer<v.GenericSchema> {
	const { backend } = input;
	const defaultRegion = input.region ?? null;
	const server = new McpServer(
		{
			name: 'watch-tail',
			version: input.version,
			description: 'Search CloudWatch Logs and the local watch-tail archive.',
		},
		{
			adapter: new ValibotJsonSchemaAdapter(),
			capabilities: { tools: {} },
			instructions: MCP_INSTRUCTIONS,
		},
	);

	server.tools([
		defineTool(
			{
				name: 'archive_status',
				description:
					'Report what the local watch-tail archive holds: database path, availability, event count, distinct log groups and regions, and the oldest and newest event. Use it to decide whether a search can run offline.',
				schema: v.object({ region: regionField }),
			},
			async ({ region }) => {
				try {
					const status = await backend.archiveStatus({ region: region ?? defaultRegion });
					return tool.text(json(status));
				} catch (error) {
					return tool.error(failureText(error));
				}
			},
		),
		defineTool(
			{
				name: 'list_log_groups',
				description:
					'List log group names visible to watch-tail, either from the local archive or from CloudWatch Logs. Archive listings also carry how many events are stored for each group.',
				schema: v.object({
					region: regionField,
					prefix: described(v.string(), 'Only groups whose name starts with this.'),
					limit: described(
						v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)),
						'Maximum groups to return (1-1000).',
					),
					source: sourceField,
				}),
			},
			async ({ region, prefix, limit, source }) => {
				try {
					const result = await backend.listLogGroups({
						region: region ?? defaultRegion,
						prefix: prefix ?? null,
						limit: limit ?? null,
						source: source ?? DEFAULT_SOURCE,
					});
					return tool.text(
						json({
							region: result.region,
							source: result.source,
							endpoint: result.endpoint,
							count: result.groups.length,
							groups: result.groups,
						}),
					);
				} catch (error) {
					return tool.error(failureText(error));
				}
			},
		),
		defineTool(
			{
				name: 'search_logs',
				description:
					'Search log events over a time window and return them, oldest first. Defaults to source="cloudwatch", which reads the local archive first and only calls AWS for ranges it does not already hold; source="archive" stays entirely local. Archive searches also accept a case-insensitive substring (search) and level filters; CloudWatch searches accept a filterPattern. The result says whether it was truncated at the event limit.',
				schema: v.object({
					groups: v.pipe(v.union([v.string(), v.array(v.string())]), v.description(GROUPS)),
					region: regionField,
					source: sourceField,
					search: described(v.string(), 'Archive only: case-insensitive substring of the message.'),
					level: described(v.union([v.string(), v.array(v.string())]), LEVELS),
					...windowFields,
					filterPattern: described(
						v.string(),
						'CloudWatch only: a CloudWatch Logs filter pattern.',
					),
					limit: described(
						v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
						'Maximum events to return (1-100000).',
					),
				}),
			},
			async ({ groups, region, source, search, level, from, to, range, filterPattern, limit }) => {
				const resolvedSource = source ?? DEFAULT_SOURCE;
				try {
					const result: SearchResult = await backend.search({
						region: region ?? defaultRegion,
						groups: toList(groups),
						source: resolvedSource,
						search: search ?? null,
						levels: resolvedSource === 'archive' ? toList(level) : null,
						from: from ?? null,
						to: to ?? null,
						range: range ?? null,
						filterPattern: resolvedSource === 'cloudwatch' ? (filterPattern ?? null) : null,
						max: limit ?? 500,
					});
					const text = json({
						region: result.region,
						source: result.source,
						groups: result.groups,
						count: result.events.length,
						truncated: result.truncated,
						reason: result.reason,
						error: result.error,
						events: result.events.map(formatEvent),
					});
					return result.error === null ? tool.text(text) : tool.error(text);
				} catch (error) {
					return tool.error(failureText(error, resolvedSource));
				}
			},
		),
		defineTool(
			{
				name: 'count_logs',
				description:
					'Count archived events per time bucket, per log group and level, without returning the events. Use it to find a spike (or to size a window) before a search. Archive only.',
				schema: v.object({
					groups: v.pipe(v.union([v.string(), v.array(v.string())]), v.description(GROUPS)),
					region: regionField,
					...windowFields,
					level: described(v.union([v.string(), v.array(v.string())]), LEVELS),
					bucket: described(
						v.string(),
						'Bucket width as a duration or milliseconds. Chosen automatically when omitted.',
					),
					by: v.optional(
						v.pipe(
							v.picklist(['event', 'request']),
							v.description('Count lines (event) or requests (request).'),
						),
					),
				}),
			},
			async ({ groups, region, from, to, range, level, bucket, by }) => {
				try {
					const points: SeriesPoint[] = await backend.count({
						region: region ?? defaultRegion,
						groups: toList(groups),
						from: from ?? null,
						to: to ?? null,
						range: range ?? null,
						levels: toList(level),
						bucket: bucket ?? null,
						by: by ?? null,
					});
					return tool.text(json({ count: points.length, points }));
				} catch (error) {
					return tool.error(failureText(error));
				}
			},
		),
		defineTool(
			{
				name: 'get_identity',
				description:
					'Call STS GetCallerIdentity and report the account and ARN the ambient credentials belong to. Useful before a CloudWatch search, or to confirm which account an archive belongs to.',
				schema: v.object({ region: regionField }),
			},
			async ({ region }) => {
				try {
					const identity = await backend.identity({ region: region ?? defaultRegion });
					return tool.text(json(identity));
				} catch (error) {
					return tool.error(failureText(error));
				}
			},
		),
	]);

	return server;
}
