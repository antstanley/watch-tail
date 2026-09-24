/**
 * HTTP client the headless MCP server uses to talk to a running watch-tail.
 *
 * The MCP server is a thin client on purpose: starting the built SvelteKit app
 * and proxying to it means every source (archive, CloudWatch), every filter and
 * every error mapping stays in one place, and the compiled CLI never has to pull
 * in the server's `$lib`-aliased modules.
 *
 * `search` consumes the same server-sent event stream the browser reads; the
 * parser is a pure function so the framing can be tested without a network.
 */
import type {
	ApiErrorBody,
	ArchiveStatusResponse,
	IdentityResponse,
	LogEventDto,
	LogGroupsResponse,
	SeriesPoint,
} from '../../lib/types.ts';

/** A failed request, carrying the API's own error code when there is one. */
export class ApiRequestError extends Error {
	readonly code: string | undefined;
	readonly status: number;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = 'ApiRequestError';
		this.status = status;
		this.code = code;
	}
}

/** What one search reads, and how. */
type SearchInput = {
	region: string | null;
	/** Log groups to read; one or more. */
	groups: string[];
	/** Where the events come from. */
	source: 'archive' | 'cloudwatch';
	/** Archive-only case-insensitive substring of the message. */
	search?: string | null;
	/** Archive-only levels to keep. */
	levels?: string[] | null;
	/** Window start, as the server parses it (duration, epoch ms or ISO 8601). */
	from?: string | null;
	/** Window end, same forms as `from`. */
	to?: string | null;
	/** A preset window (`15m`, `1h`, ...) used when `from`/`to` are absent. */
	range?: string | null;
	/** CloudWatch-only filter pattern. */
	filterPattern?: string | null;
	/** Archive-only rows per page. */
	pageSize?: number | null;
	/** Cap on events for this request. */
	max?: number | null;
	/** Aborts the underlying request. */
	signal?: AbortSignal;
};

/** What one search found. */
export type SearchResult = {
	region: string | null;
	source: string;
	groups: string[];
	events: LogEventDto[];
	/** True when the server stopped at the event cap rather than the window end. */
	truncated: boolean;
	/** Why the stream ended (`window-complete`, `event-limit`, ...). */
	reason: string | null;
	/** A stream error (an unavailable archive, for example), or `null`. */
	error: string | null;
};

/** One parsed server-sent event. */
export type SseFrame = { event: string; data: unknown };

/** The operations the MCP tools need from a watch-tail server. */
export type McpBackend = {
	archiveStatus(input: {
		region: string | null;
		signal?: AbortSignal;
	}): Promise<ArchiveStatusResponse>;
	listLogGroups(input: {
		region: string | null;
		prefix?: string | null;
		limit?: number | null;
		source: 'archive' | 'cloudwatch';
		signal?: AbortSignal;
	}): Promise<LogGroupsResponse>;
	identity(input: { region: string | null; signal?: AbortSignal }): Promise<IdentityResponse>;
	search(input: SearchInput): Promise<SearchResult>;
	count(input: {
		region: string | null;
		groups: string[];
		from?: string | null;
		to?: string | null;
		range?: string | null;
		levels?: string[] | null;
		bucket?: string | null;
		by?: string | null;
		metric?: string | null;
		signal?: AbortSignal;
	}): Promise<SeriesPoint[]>;
};

/** Parses one SSE frame (the text between blank lines) into an event and payload. */
export function parseSseFrame(raw: string): SseFrame | null {
	let event = 'message';
	const dataLines: string[] = [];
	for (const line of raw.split('\n')) {
		if (line.length === 0 || line.startsWith(':')) continue;
		if (line.startsWith('event:')) {
			event = line.slice('event:'.length).trim();
			continue;
		}
		if (line.startsWith('data:')) {
			const value = line.slice('data:'.length);
			dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
		}
	}
	if (dataLines.length === 0) return null;
	const text = dataLines.join('\n');
	let data: unknown = text;
	try {
		data = JSON.parse(text);
	} catch {
		// A non-JSON payload is passed through as its raw text.
	}
	return { event, data };
}

/** Parses every complete frame in `text`. */
export function parseSseFrames(text: string): SseFrame[] {
	const frames: SseFrame[] = [];
	for (const block of text.replaceAll('\r\n', '\n').split('\n\n')) {
		const frame = parseSseFrame(block);
		if (frame !== null) frames.push(frame);
	}
	return frames;
}

/** What a finished search stream held. */
export type StreamOutcome = {
	region: string | null;
	source: string;
	groups: string[];
	events: LogEventDto[];
	reason: string | null;
	error: string | null;
};

/** Folds one parsed frame into the outcome being collected. */
function applyFrame(outcome: StreamOutcome, frame: SseFrame): void {
	const data = frame.data as Record<string, unknown> | null;
	if (frame.event === 'ready' && data !== null) {
		if (typeof data.region === 'string') outcome.region = data.region;
		if (typeof data.source === 'string') outcome.source = data.source;
		if (Array.isArray(data.groups))
			outcome.groups = data.groups.filter((group) => typeof group === 'string');
		return;
	}
	if (frame.event === 'log' && data !== null && Array.isArray(data.events)) {
		for (const event of data.events) outcome.events.push(event as LogEventDto);
		return;
	}
	if (frame.event === 'error' && data !== null) {
		const message = typeof data.message === 'string' ? data.message : 'unknown stream error';
		outcome.error = message;
		return;
	}
	if (frame.event === 'end' && data !== null && typeof data.reason === 'string') {
		outcome.reason = data.reason;
	}
}

/**
 * Reads a `/api/stream` response to completion.
 *
 * The route always ends an archive or historic window on its own, and its `end`
 * frame says why, so the reader never has to guess when to stop.
 */
export async function collectStream(response: Response): Promise<StreamOutcome> {
	const outcome: StreamOutcome = {
		region: null,
		source: 'cloudwatch',
		groups: [],
		events: [],
		reason: null,
		error: null,
	};
	const body = response.body;
	if (body === null) {
		for (const frame of parseSseFrames(await response.text())) applyFrame(outcome, frame);
		return outcome;
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf('\n\n');
			while (boundary >= 0) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const frame = parseSseFrame(block.replaceAll('\r\n', '\n'));
				if (frame !== null) applyFrame(outcome, frame);
				boundary = buffer.indexOf('\n\n');
			}
		}
	} finally {
		reader.releaseLock();
	}
	buffer += decoder.decode();
	const rest = parseSseFrame(buffer.replaceAll('\r\n', '\n'));
	if (rest !== null) applyFrame(outcome, rest);
	return outcome;
}

/** Reads the API error envelope from a failed response, if it holds one. */
async function readApiError(response: Response): Promise<ApiRequestError> {
	let body: ApiErrorBody | null = null;
	try {
		body = (await response.json()) as ApiErrorBody;
	} catch {
		body = null;
	}
	const message = body?.error ?? `watch-tail answered HTTP ${response.status}`;
	return new ApiRequestError(message, response.status, body?.code);
}

/** Builds a URL with only the parameters that have a value. */
function buildUrl(baseUrl: string, path: string, params: Record<string, string | null>): URL {
	const url = new URL(path, baseUrl);
	for (const [key, value] of Object.entries(params)) {
		if (value !== null && value !== '') url.searchParams.set(key, value);
	}
	return url;
}

/** True when a window bound was actually supplied. */
function isSet(value: string | null | undefined): value is string {
	return value !== null && value !== undefined && value.trim().length > 0;
}

/** An HTTP implementation of {@link McpBackend}. */
export function createHttpBackend(input: {
	baseUrl: string;
	fetchImpl?: typeof fetch;
}): McpBackend {
	const { baseUrl, fetchImpl = fetch } = input;

	async function getJson<T>(url: URL, signal?: AbortSignal): Promise<T> {
		const response = await fetchImpl(url, { signal });
		if (!response.ok) throw await readApiError(response);
		return (await response.json()) as T;
	}

	return {
		async archiveStatus({ region, signal }) {
			return getJson<ArchiveStatusResponse>(buildUrl(baseUrl, '/api/archive', { region }), signal);
		},
		async listLogGroups({ region, prefix, limit, source, signal }) {
			return getJson<LogGroupsResponse>(
				buildUrl(baseUrl, '/api/log-groups', {
					region,
					prefix: prefix ?? null,
					limit: limit === null || limit === undefined ? null : String(limit),
					source,
				}),
				signal,
			);
		},
		async identity({ region, signal }) {
			return getJson<IdentityResponse>(buildUrl(baseUrl, '/api/identity', { region }), signal);
		},
		async search(request) {
			const groups = request.groups;
			// A tool search is always a bounded window. Saying so explicitly matters
			// for `source=cloudwatch`: without `mode=historic` the route would tail
			// live, which never ends (the call would hang) and skips the archive.
			const customWindow = isSet(request.from) && isSet(request.to);
			const url = buildUrl(baseUrl, '/api/stream', {
				region: request.region,
				source: request.source,
				mode: 'historic',
				...(groups.length === 1 ? { group: groups[0] } : { groups: groups.join(',') }),
				...(request.source === 'archive'
					? {
							search: request.search ?? null,
							level: request.levels && request.levels.length > 0 ? request.levels.join(',') : null,
							pageSize:
								request.pageSize === null || request.pageSize === undefined
									? null
									: String(request.pageSize),
						}
					: { filterPattern: request.filterPattern ?? null }),
				from: request.from ?? null,
				to: request.to ?? null,
				range: customWindow ? null : (request.range ?? null),
				max: request.max === null || request.max === undefined ? null : String(request.max),
			});
			const response = await fetchImpl(url, { signal: request.signal });
			if (!response.ok) throw await readApiError(response);
			const outcome = await collectStream(response);
			return {
				region: outcome.region,
				source: outcome.source,
				groups: outcome.groups.length > 0 ? outcome.groups : groups,
				// Several groups, and the archived and CloudWatch parts of one window,
				// stream side by side, so batches arrive interleaved. The sort is
				// stable: events with one timestamp keep the order they arrived in.
				events: outcome.events.toSorted((a, b) => a.timestamp - b.timestamp),
				truncated: outcome.reason === 'event-limit',
				reason: outcome.reason,
				error: outcome.error,
			};
		},
		async count(request) {
			const groups = request.groups;
			const customWindow = isSet(request.from) && isSet(request.to);
			const url = buildUrl(baseUrl, '/api/series', {
				region: request.region,
				source: 'archive',
				...(groups.length === 1 ? { group: groups[0] } : { groups: groups.join(',') }),
				from: request.from ?? null,
				to: request.to ?? null,
				range: customWindow ? null : (request.range ?? null),
				level: request.levels && request.levels.length > 0 ? request.levels.join(',') : null,
				bucket: request.bucket ?? null,
				by: request.by ?? null,
				metric: request.metric ?? null,
			});
			return getJson<SeriesPoint[]>(url, request.signal);
		},
	};
}
