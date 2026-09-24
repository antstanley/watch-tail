/**
 * The headless MCP server lifecycle.
 *
 * `runMcpServer` starts a private watch-tail on a free port (or attaches to one),
 * serves MCP over stdio, and stops the server when stdin closes. These tests
 * drive every side effect through a double, so no process is spawned.
 */
import { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runMcpServer, type McpServerDeps, type McpServerInput } from '../src/cli/mcp/run.ts';
import { serveMcp, type ServeMcpOptions } from '../src/cli/mcp/stdio.ts';
import type { McpBackend } from '../src/cli/mcp/backend.ts';
import type { StartServerInput } from '../src/cli/server.ts';

/** A backend whose archive status is always readable. */
const backend: McpBackend = {
	archiveStatus: async () => ({
		path: '/tmp/a.duckdb',
		available: true,
		error: null,
		bytes: 1,
		rows: 7,
		groups: 1,
		regions: 1,
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

/** A child-process double that reports a clean exit. */
function fakeChild(): ChildProcess {
	return {
		kill: () => true,
		exitCode: null,
		signalCode: null,
		once: () => undefined,
	} as unknown as ChildProcess;
}

/** Records every dependency call. */
function harness(overrides: Partial<McpServerDeps> = {}) {
	const started: StartServerInput[] = [];
	const stopped: number[] = [];
	const stderr: string[] = [];
	let serveOptions: ServeMcpOptions | undefined;
	const deps: McpServerDeps = {
		startServer: (input) => {
			started.push(input);
			return fakeChild();
		},
		waitForHealth: async () => true,
		stopServer: async () => {
			stopped.push(1);
			return 0;
		},
		findFreePort: async () => 4599,
		serve: async (options) => {
			serveOptions = options;
		},
		createBackend: () => backend,
		fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
		subscribeSignals: () => () => undefined,
		...overrides,
	};
	const input: McpServerInput = {
		version: '0.9.0',
		region: 'eu-west-1',
		url: null,
		host: '127.0.0.1',
		port: null,
		appRoot: '/app',
		childEnv: { AWS_PROFILE: 'acme' },
		input: Readable.from([]),
		output: { write: () => true },
		stderr: (line) => stderr.push(line),
	};
	return { deps, input, started, stopped, stderr, serveOptions: () => serveOptions };
}

describe('runMcpServer', () => {
	it('starts a private server on a free port and stops it afterwards', async () => {
		const h = harness();
		expect(await runMcpServer(h.input, h.deps)).toBe(0);
		expect(h.started).toHaveLength(1);
		expect(h.started[0]?.port).toBe(4599);
		expect(h.started[0]?.env).toEqual({ AWS_PROFILE: 'acme' });
		expect(h.started[0]?.verbose).toBe(false);
		expect(h.stopped).toHaveLength(1);
	});

	it('uses an explicit --port when one was given', async () => {
		const h = harness();
		h.input.port = 4700;
		await runMcpServer(h.input, h.deps);
		expect(h.started[0]?.port).toBe(4700);
	});

	it('attaches to --url without starting a server', async () => {
		const h = harness();
		h.input.url = 'http://127.0.0.1:4517';
		expect(await runMcpServer(h.input, h.deps)).toBe(0);
		expect(h.started).toEqual([]);
		expect(h.stopped).toEqual([]);
	});

	it('fails when the app is not built and no URL was given', async () => {
		const h = harness();
		h.input.appRoot = null;
		expect(await runMcpServer(h.input, h.deps)).toBe(1);
		expect(h.stderr.join('\n')).toContain('pnpm build');
		expect(h.started).toEqual([]);
	});

	it('fails and stops the server when it never answers', async () => {
		const h = harness({ waitForHealth: async () => false });
		expect(await runMcpServer(h.input, h.deps)).toBe(1);
		expect(h.stderr.join('\n')).toContain('did not answer');
		expect(h.stopped).toHaveLength(1);
	});

	it('reports an unreachable --url', async () => {
		const h = harness({ waitForHealth: async () => false });
		h.input.url = 'http://127.0.0.1:1';
		expect(await runMcpServer(h.input, h.deps)).toBe(1);
		expect(h.stderr.join('\n')).toContain('no watch-tail server answered');
	});

	it('serves the tmcp server it built, over the injected streams', async () => {
		const h = harness();
		const lines: unknown[] = [];
		h.input.input = Readable.from([
			`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'archive_status', arguments: {} } })}\n`,
		]);
		h.input.output = {
			write: (chunk) => {
				lines.push(JSON.parse(chunk.trim()));
				return true;
			},
		};
		h.deps.serve = (options) => serveMcp(options);

		expect(await runMcpServer(h.input, h.deps)).toBe(0);
		const result = (lines[0] as { result: { content: { text: string }[] } }).result;
		expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({ rows: 7 });
		expect(h.stopped).toHaveLength(1);
	});
});
