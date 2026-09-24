/**
 * The MCP surface, driven through tmcp's own dispatch.
 *
 * These tests call `server.receive` exactly as the stdio loop does, so they cover
 * the schema conversion, argument validation and result framing an agent sees,
 * including the protocol revision negotiation.
 */
import { describe, expect, it, vi } from 'vitest';
import { createWatchTailServer, formatEvent } from '../src/cli/mcp/tools.ts';
import type { McpBackend, SearchResult } from '../src/cli/mcp/backend.ts';

/** A backend that answers every tool with canned data. */
function fakeBackend(overrides: Partial<McpBackend> = {}): McpBackend {
	const search: SearchResult = {
		region: 'us-east-1',
		source: 'archive',
		groups: ['/aws/lambda/checkout'],
		events: [
			{
				id: 'e1',
				timestamp: 1_700_000_000_000,
				message: 'boom',
				level: 'error',
				group: '/aws/lambda/checkout',
			},
		],
		truncated: false,
		reason: 'window-complete',
		error: null,
	};
	return {
		archiveStatus: async () => ({
			path: '/tmp/archive.duckdb',
			available: true,
			error: null,
			bytes: 2048,
			rows: 12,
			groups: 2,
			regions: 1,
			oldest: 1,
			newest: 2,
		}),
		listLogGroups: async () => ({
			region: 'us-east-1',
			endpoint: null,
			source: 'archive',
			groups: [{ name: '/aws/lambda/checkout', archivedEvents: 4 }],
		}),
		identity: async () => ({
			arn: 'arn:aws:sts::111111111111:assumed-role/Admin/me',
			account: '111111111111',
			userId: 'AROA:me',
			region: 'us-east-1',
			endpoint: null,
		}),
		search: async () => search,
		count: async () => [
			{ t: 1_700_000_000_000, group: '/aws/lambda/checkout', level: 'error', events: 2 },
		],
		...overrides,
	};
}

/** A backend method that always rejects with a code, for the failure paths. */
function alwaysFails(message: string, code: string): () => Promise<never> {
	return () => Promise.reject(Object.assign(new Error(message), { code }));
}

/** One JSON-RPC request against the server, as the transport would send it. */
async function rpc(
	server: ReturnType<typeof createWatchTailServer>,
	method: string,
	params?: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
	const message = { jsonrpc: '2.0', id: 1, method, params } as Parameters<typeof server.receive>[0];
	const response = await server.receive(message, { sessionInfo: {} });
	return response as { result?: unknown; error?: { code: number; message: string } };
}

/** Parses the text content of a tools/call result. */
function textOf(result: unknown): unknown {
	const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
	return JSON.parse(content[0]?.text ?? 'null');
}

describe('the watch-tail MCP server', () => {
	it('answers the session handshake with a supported revision', async () => {
		const server = createWatchTailServer({ backend: fakeBackend(), version: '0.9.0' });
		const response = await rpc(server, 'initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'test', version: '1.0.0' },
		});
		const result = response.result as { protocolVersion: string; serverInfo: { name: string } };
		expect(result.protocolVersion).toBe('2025-06-18');
		expect(result.serverInfo.name).toBe('watch-tail');
	});

	it('serves a request that carries the 2026-07-28 per-request metadata', async () => {
		// The 2026-07-28 revision is stateless: the client names the revision and
		// its capabilities on every request instead of negotiating a session.
		const server = createWatchTailServer({ backend: fakeBackend(), version: '0.9.0' });
		const response = await server.receive(
			{
				jsonrpc: '2.0',
				id: 7,
				method: 'tools/list',
				params: {
					_meta: {
						'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						'io.modelcontextprotocol/clientCapabilities': {},
					},
				},
			},
			{},
		);
		const tools = (response as { result: { tools: { name: string }[] } }).result.tools;
		expect(tools.map((tool) => tool.name)).toContain('search_logs');
	});

	it('falls back to its own revision for an unknown one', async () => {
		const server = createWatchTailServer({ backend: fakeBackend(), version: '0.9.0' });
		const response = await rpc(server, 'initialize', {
			protocolVersion: '1999-01-01',
			capabilities: {},
			clientInfo: { name: 'test', version: '1.0.0' },
		});
		expect((response.result as { protocolVersion: string }).protocolVersion).not.toBe('1999-01-01');
	});

	it('lists the watch-tail tools', async () => {
		const server = createWatchTailServer({ backend: fakeBackend(), version: '0.9.0' });
		const response = await rpc(server, 'tools/list');
		const tools = (response.result as { tools: { name: string }[] }).tools;
		expect(tools.map((tool) => tool.name).toSorted()).toEqual([
			'archive_status',
			'count_logs',
			'get_identity',
			'list_log_groups',
			'search_logs',
		]);
	});

	it('reports the archive status', async () => {
		const server = createWatchTailServer({ backend: fakeBackend(), version: '0.9.0' });
		const response = await rpc(server, 'tools/call', { name: 'archive_status', arguments: {} });
		expect(textOf(response.result)).toMatchObject({ rows: 12, available: true });
	});

	it('passes a default region to a tool that does not name one', async () => {
		const archiveStatus = vi.fn<McpBackend['archiveStatus']>(fakeBackend().archiveStatus);
		const server = createWatchTailServer({
			backend: fakeBackend({ archiveStatus }),
			version: '0.9.0',
			region: 'eu-west-1',
		});
		await rpc(server, 'tools/call', { name: 'archive_status', arguments: {} });
		expect(archiveStatus).toHaveBeenCalledWith({ region: 'eu-west-1' });
	});

	it('defaults a search to cloudwatch and formats the events', async () => {
		const search = vi.fn<McpBackend['search']>(fakeBackend().search);
		const server = createWatchTailServer({ backend: fakeBackend({ search }), version: '0.9.0' });
		const response = await rpc(server, 'tools/call', {
			name: 'search_logs',
			arguments: { groups: ['/aws/lambda/checkout'], search: 'boom' },
		});
		expect(search).toHaveBeenCalledWith(
			expect.objectContaining({
				groups: ['/aws/lambda/checkout'],
				// The default source matches the UI's Historic mode, and is
				// archive-first on the server.
				source: 'cloudwatch',
				search: 'boom',
				levels: null,
				max: 500,
			}),
		);
		const parsed = textOf(response.result) as { count: number; events: { time: string }[] };
		expect(parsed.count).toBe(1);
		expect(parsed.events[0].time).toBe('2023-11-14T22:13:20.000Z');
	});

	it('applies level filters only to an archive search', async () => {
		const search = vi.fn<McpBackend['search']>(fakeBackend().search);
		const server = createWatchTailServer({ backend: fakeBackend({ search }), version: '0.9.0' });
		await rpc(server, 'tools/call', {
			name: 'search_logs',
			arguments: { groups: ['g'], source: 'archive', level: 'error,warn' },
		});
		expect(search).toHaveBeenCalledWith(
			expect.objectContaining({ source: 'archive', levels: ['error', 'warn'] }),
		);
	});

	it('accepts a comma-separated group list', async () => {
		const search = vi.fn<McpBackend['search']>(fakeBackend().search);
		const server = createWatchTailServer({ backend: fakeBackend({ search }), version: '0.9.0' });
		await rpc(server, 'tools/call', {
			name: 'search_logs',
			arguments: { groups: 'a,b', source: 'cloudwatch', filterPattern: 'ERROR' },
		});
		expect(search).toHaveBeenCalledWith(
			expect.objectContaining({ groups: ['a', 'b'], source: 'cloudwatch', filterPattern: 'ERROR' }),
		);
	});

	it('rejects a tool call that does not match the schema', async () => {
		const server = createWatchTailServer({ backend: fakeBackend(), version: '0.9.0' });
		const response = await rpc(server, 'tools/call', { name: 'search_logs', arguments: {} });
		expect(response.error ?? (response.result as { isError?: boolean })).toBeTruthy();
	});

	it('reports a backend failure as a tool error', async () => {
		const server = createWatchTailServer({
			backend: fakeBackend({
				archiveStatus: async () => {
					throw Object.assign(new Error('archive is off'), { code: 'archive-unavailable' });
				},
			}),
			version: '0.9.0',
		});
		const response = await rpc(server, 'tools/call', { name: 'archive_status', arguments: {} });
		const result = response.result as { isError?: boolean; content: { text: string }[] };
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain('archive is off');
		expect(result.content[0]?.text).toContain('archive-unavailable');
	});

	it('suggests the local archive when a CloudWatch search fails', async () => {
		const failing = alwaysFails('no usable credentials', 'missing-credentials');
		const server = createWatchTailServer({
			backend: fakeBackend({ search: failing }),
			version: '0.9.0',
		});
		const response = await rpc(server, 'tools/call', {
			name: 'search_logs',
			arguments: { groups: ['g'] },
		});
		const text = (response.result as { content: { text: string }[] }).content[0]?.text ?? '';
		expect(text).toContain('missing-credentials');
		expect(text).toContain('source="archive"');
	});

	it('does not suggest the archive when an archive search fails', async () => {
		const failing = alwaysFails('archive is off', 'archive-unavailable');
		const server = createWatchTailServer({
			backend: fakeBackend({ search: failing }),
			version: '0.9.0',
		});
		const response = await rpc(server, 'tools/call', {
			name: 'search_logs',
			arguments: { groups: ['g'], source: 'archive' },
		});
		const text = (response.result as { content: { text: string }[] }).content[0]?.text ?? '';
		expect(text).toContain('archive is off');
		expect(text).not.toContain('source="archive"');
	});

	it('answers an unknown method with a JSON-RPC error', async () => {
		const server = createWatchTailServer({ backend: fakeBackend(), version: '0.9.0' });
		const response = await rpc(server, 'does/not/exist');
		expect(response.error?.code).toBe(-32_601);
	});
});

describe('formatEvent', () => {
	it('adds an ISO timestamp and normalises the optional fields', () => {
		expect(formatEvent({ id: 'x', timestamp: 0, message: 'hi' })).toEqual({
			timestamp: 0,
			time: '1970-01-01T00:00:00.000Z',
			group: null,
			stream: null,
			level: null,
			requestId: null,
			message: 'hi',
		});
	});
});
