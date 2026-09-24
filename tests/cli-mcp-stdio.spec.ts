/**
 * The stdio framing loop.
 *
 * The loop is what an agent actually measures: newline-delimited JSON in, one
 * JSON response per line out, with stdout reserved for the protocol. These tests
 * drive the real tmcp server over an in-memory stream.
 */
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { serveMcp, sanitizeInitializeResponse } from '../src/cli/mcp/stdio.ts';
import { createWatchTailServer } from '../src/cli/mcp/tools.ts';
import type { McpBackend } from '../src/cli/mcp/backend.ts';

/** A backend with no interesting answers; the tests only inspect the framing. */
const backend: McpBackend = {
	archiveStatus: async () => ({
		path: '/tmp/a.duckdb',
		available: true,
		error: null,
		bytes: 1,
		rows: 0,
		groups: 0,
		regions: 0,
		oldest: null,
		newest: null,
	}),
	listLogGroups: async () => ({
		region: 'us-east-1',
		endpoint: null,
		source: 'archive',
		groups: [],
	}),
	identity: async () => ({
		arn: 'arn:aws:iam::1:user/x',
		account: '000000000001',
		userId: 'A:x',
		region: 'us-east-1',
		endpoint: null,
	}),
	search: async () => ({
		region: 'us-east-1',
		source: 'archive',
		groups: [],
		events: [],
		truncated: false,
		reason: 'window-complete',
		error: null,
	}),
	count: async () => [],
};

/** Runs the loop over the given input and returns the lines written. */
async function run(input: string[]): Promise<{ lines: unknown[]; errors: unknown[] }> {
	const lines: unknown[] = [];
	const errors: unknown[] = [];
	const server = createWatchTailServer({ backend, version: '0.9.0' });
	await serveMcp({
		input: Readable.from(input),
		output: {
			write: (chunk) => {
				lines.push(JSON.parse(chunk.trim()));
				return true;
			},
		},
		server,
		onError: (error) => errors.push(error),
	});
	return { lines, errors };
}

/** A request line. */
function line(id: number, method: string, params?: unknown): string {
	return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

describe('serveMcp', () => {
	it('answers requests in order, one JSON line each', async () => {
		const { lines } = await run([
			line(1, 'initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'test', version: '1.0.0' },
			}),
			line(2, 'tools/list'),
		]);
		expect(lines).toHaveLength(2);
		expect((lines[0] as { id: number }).id).toBe(1);
		expect((lines[1] as { id: number }).id).toBe(2);
	});

	it('narrows the initialize result to the protocol fields', async () => {
		const { lines } = await run([
			line(1, 'initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'test', version: '1.0.0' },
			}),
		]);
		const result = (lines[0] as { result: Record<string, unknown> }).result;
		expect(result).not.toHaveProperty('adapter');
		expect(result.protocolVersion).toBe('2025-06-18');
		expect(result.capabilities).toBeDefined();
		expect(result.serverInfo).toBeDefined();
		expect(typeof result.instructions).toBe('string');
	});

	it('writes nothing for a notification', async () => {
		const { lines } = await run([
			`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
		]);
		expect(lines).toHaveLength(0);
	});

	it('answers a malformed line with a parse error', async () => {
		const { lines } = await run(['not json\n']);
		expect(lines).toEqual([
			{ jsonrpc: '2.0', id: null, error: { code: -32_700, message: 'Parse error' } },
		]);
	});

	it('handles a message split across two chunks', async () => {
		const request = line(1, 'ping');
		const { lines } = await run([request.slice(0, 12), request.slice(12)]);
		expect(lines).toHaveLength(1);
		expect((lines[0] as { id: number }).id).toBe(1);
	});

	it('handles a final line without a trailing newline', async () => {
		const { lines } = await run([JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' })]);
		expect(lines).toHaveLength(1);
		expect((lines[0] as { id: number }).id).toBe(4);
	});

	it('waits for the output to drain before writing on', async () => {
		const server = createWatchTailServer({ backend, version: '0.9.0' });
		const writes: string[] = [];
		let drains = 0;
		const write = vi.fn<(chunk: string) => boolean>((chunk) => {
			writes.push(chunk);
			return false;
		});
		const once = vi.fn<(event: 'drain', listener: () => void) => undefined>((_event, listener) => {
			drains += 1;
			setTimeout(listener, 0);
			return undefined;
		});
		await serveMcp({
			input: Readable.from([line(1, 'ping'), line(2, 'ping')]),
			output: { write, once },
			server,
		});
		expect(writes).toHaveLength(2);
		expect(drains).toBe(2);
	});
});

describe('sanitizeInitializeResponse', () => {
	it('drops option keys tmcp spreads into the result', () => {
		expect(
			sanitizeInitializeResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: '2025-06-18',
					adapter: {},
					pagination: {},
					capabilities: { tools: {} },
					serverInfo: { name: 'watch-tail', version: '0.9.0' },
					instructions: 'hello',
				},
			}),
		).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: {
				protocolVersion: '2025-06-18',
				capabilities: { tools: {} },
				serverInfo: { name: 'watch-tail', version: '0.9.0' },
				instructions: 'hello',
			},
		});
	});

	it('leaves anything that is not a result object alone', () => {
		const error = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } };
		expect(sanitizeInitializeResponse(error)).toBe(error);
		expect(sanitizeInitializeResponse(null)).toBeNull();
	});
});
