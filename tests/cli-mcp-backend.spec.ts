/**
 * The HTTP backend and the server-sent-event reader.
 *
 * The MCP server never touches the network directly: it proxies the running
 * watch-tail app, so these tests pin the URL it builds, the SSE framing it
 * understands and how an API error is surfaced.
 */
import { describe, expect, it } from 'vitest';
import {
	ApiRequestError,
	collectStream,
	createHttpBackend,
	parseSseFrame,
	parseSseFrames,
} from '../src/cli/mcp/backend.ts';

/** A fetch double that records the URL and returns `response` (or calls it). */
function fakeFetch(response: Response | (() => Response)): {
	fetchImpl: typeof fetch;
	urls: string[];
} {
	const urls: string[] = [];
	const fetchImpl = (async (input: unknown) => {
		urls.push(String(input));
		return typeof response === 'function' ? response() : response;
	}) as unknown as typeof fetch;
	return { fetchImpl, urls };
}

describe('the SSE parser', () => {
	it('reads an event name and a JSON payload', () => {
		expect(parseSseFrame('event: ready\ndata: {"region":"us-east-1"}')).toEqual({
			event: 'ready',
			data: { region: 'us-east-1' },
		});
	});

	it('ignores comments and blank lines, and defaults the event name', () => {
		expect(parseSseFrame(': keep-alive\n\ndata: 1')).toEqual({ event: 'message', data: 1 });
		expect(parseSseFrame(': nothing')).toBeNull();
	});

	it('splits a whole body into frames', () => {
		const body = 'event: ready\ndata: {}\n\nevent: end\ndata: {"reason":"window-complete"}\n\n';
		expect(parseSseFrames(body)).toEqual([
			{ event: 'ready', data: {} },
			{ event: 'end', data: { reason: 'window-complete' } },
		]);
	});
});

describe('collectStream', () => {
	const body = [
		'event: ready\ndata: {"region":"eu-west-1","source":"archive","groups":["g1","g2"]}',
		'',
		'event: log\ndata: {"events":[{"id":"a","timestamp":1,"message":"one"},{"id":"b","timestamp":2,"message":"two"}]}',
		'',
		'event: ping\ndata: {"at":1}',
		'',
		'event: log\ndata: {"events":[{"id":"c","timestamp":3,"message":"three"}]}',
		'',
		'event: end\ndata: {"reason":"event-limit"}',
		'',
	].join('\n');

	it('folds ready, log and end frames into one outcome', async () => {
		const outcome = await collectStream(new Response(body));
		expect(outcome.region).toBe('eu-west-1');
		expect(outcome.source).toBe('archive');
		expect(outcome.groups).toEqual(['g1', 'g2']);
		expect(outcome.events.map((event) => event.message)).toEqual(['one', 'two', 'three']);
		expect(outcome.reason).toBe('event-limit');
		expect(outcome.error).toBeNull();
	});

	it('captures a stream error frame', async () => {
		const errorBody =
			'event: error\ndata: {"message":"archive is off","code":"archive-unavailable"}\n\n';
		const outcome = await collectStream(new Response(errorBody));
		expect(outcome.error).toBe('archive is off');
	});

	it('reads a response without a streamable body', async () => {
		const response = { body: null, text: async () => body } as unknown as Response;
		expect((await collectStream(response)).events).toHaveLength(3);
	});
});

describe('createHttpBackend', () => {
	it('searches the archive and turns the stream into events', async () => {
		const sse = [
			'event: ready\ndata: {"region":"us-east-1","source":"archive","groups":["/aws/lambda/a"]}',
			'',
			'event: log\ndata: {"events":[{"id":"1","timestamp":10,"message":"boom"}]}',
			'',
			'event: end\ndata: {"reason":"window-complete"}',
			'',
		].join('\n');
		const { fetchImpl, urls } = fakeFetch(new Response(sse));
		const backend = createHttpBackend({ baseUrl: 'http://127.0.0.1:4519', fetchImpl });

		const result = await backend.search({
			region: 'us-east-1',
			groups: ['/aws/lambda/a'],
			source: 'archive',
			search: 'boom',
			levels: ['error', 'warn'],
			from: '1h',
			max: 100,
		});

		const url = new URL(urls[0]);
		expect(url.pathname).toBe('/api/stream');
		expect(url.searchParams.get('source')).toBe('archive');
		// A tool search is a bounded window, exactly like the UI's historic view.
		expect(url.searchParams.get('mode')).toBe('historic');
		expect(url.searchParams.get('group')).toBe('/aws/lambda/a');
		expect(url.searchParams.get('search')).toBe('boom');
		expect(url.searchParams.get('level')).toBe('error,warn');
		expect(url.searchParams.get('max')).toBe('100');
		expect(result.events).toHaveLength(1);
		expect(result.truncated).toBe(false);
	});

	it('asks CloudWatch for a historic window, not a live tail', async () => {
		const { fetchImpl, urls } = fakeFetch(
			() => new Response('event: end\ndata: {"reason":"window-complete"}\n\n'),
		);
		const backend = createHttpBackend({ baseUrl: 'http://x', fetchImpl });
		await backend.search({
			region: 'us-east-1',
			groups: ['a'],
			source: 'cloudwatch',
			from: '1000',
			to: '2000',
			filterPattern: 'ERROR',
		});
		const url = new URL(urls[0]);
		expect(url.searchParams.get('source')).toBe('cloudwatch');
		// Without this the route defaults to live and the call never returns.
		expect(url.searchParams.get('mode')).toBe('historic');
		expect(url.searchParams.get('from')).toBe('1000');
		expect(url.searchParams.get('to')).toBe('2000');
		expect(url.searchParams.has('range')).toBe(false);
	});

	it('sends a preset range only when no custom window is given', async () => {
		const { fetchImpl, urls } = fakeFetch(
			() => new Response('event: end\ndata: {"reason":"window-complete"}\n\n'),
		);
		const backend = createHttpBackend({ baseUrl: 'http://x', fetchImpl });
		await backend.search({ region: null, groups: ['a'], source: 'archive', range: '24h' });
		expect(new URL(urls[0]).searchParams.get('range')).toBe('24h');
	});

	it('sends several groups as one comma-separated parameter', async () => {
		const { fetchImpl, urls } = fakeFetch(
			() => new Response('event: end\ndata: {"reason":"window-complete"}\n\n'),
		);
		const backend = createHttpBackend({ baseUrl: 'http://x', fetchImpl });
		await backend.search({
			region: null,
			groups: ['a', 'b'],
			source: 'cloudwatch',
			filterPattern: 'ERROR',
		});
		const url = new URL(urls[0]);
		expect(url.searchParams.get('groups')).toBe('a,b');
		expect(url.searchParams.has('group')).toBe(false);
		expect(url.searchParams.get('filterPattern')).toBe('ERROR');
	});

	it('returns events oldest first, however the batches arrived', async () => {
		const body = [
			'event: log\ndata: {"events":[{"id":"b","timestamp":20,"message":"late"}]}\n\n',
			'event: log\ndata: {"events":[{"id":"a","timestamp":10,"message":"early"},{"id":"c","timestamp":20,"message":"tie"}]}\n\n',
			'event: end\ndata: {"reason":"window-complete"}\n\n',
		].join('');
		const { fetchImpl } = fakeFetch(() => new Response(body));
		const backend = createHttpBackend({ baseUrl: 'http://x', fetchImpl });
		const result = await backend.search({ region: null, groups: ['a', 'b'], source: 'cloudwatch' });
		expect(result.events.map((event) => event.id)).toEqual(['a', 'b', 'c']);
	});

	it('flags a search that hit the event cap as truncated', async () => {
		const { fetchImpl } = fakeFetch(new Response('event: end\ndata: {"reason":"event-limit"}\n\n'));
		const backend = createHttpBackend({ baseUrl: 'http://x', fetchImpl });
		const result = await backend.search({ region: null, groups: ['a'], source: 'archive' });
		expect(result.truncated).toBe(true);
	});

	it('surfaces the API error envelope as an ApiRequestError', async () => {
		const { fetchImpl } = fakeFetch(
			new Response(JSON.stringify({ error: 'no region', code: 'missing-region-param' }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			}),
		);
		const backend = createHttpBackend({ baseUrl: 'http://x', fetchImpl });
		const failure = await backend
			.search({ region: null, groups: ['a'], source: 'archive' })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ApiRequestError);
		expect((failure as ApiRequestError).code).toBe('missing-region-param');
		expect((failure as ApiRequestError).status).toBe(400);
	});

	it('reports the archive status and identity', async () => {
		const { fetchImpl, urls } = fakeFetch(
			() => new Response(JSON.stringify({ available: true, rows: 3 }), { status: 200 }),
		);
		const backend = createHttpBackend({ baseUrl: 'http://x', fetchImpl });
		await backend.archiveStatus({ region: 'eu-west-1' });
		await backend.identity({ region: null });
		expect(urls[0]).toBe('http://x/api/archive?region=eu-west-1');
		expect(urls[1]).toBe('http://x/api/identity');
	});

	it('counts archived events through /api/series', async () => {
		const { fetchImpl, urls } = fakeFetch(new Response(JSON.stringify([]), { status: 200 }));
		const backend = createHttpBackend({ baseUrl: 'http://x', fetchImpl });
		await backend.count({ region: 'us-east-1', groups: ['a', 'b'], levels: ['error'] });
		const url = new URL(urls[0]);
		expect(url.pathname).toBe('/api/series');
		expect(url.searchParams.get('source')).toBe('archive');
		expect(url.searchParams.get('groups')).toBe('a,b');
		expect(url.searchParams.get('level')).toBe('error');
	});
});
