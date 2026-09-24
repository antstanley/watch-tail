/**
 * `watch-tail mcp init` against a fabricated filesystem.
 *
 * The orchestrator takes every side effect as an argument, so these tests cover
 * detection, the selection prompt, writing and the failure paths without
 * touching the machine they run on.
 */
import { describe, expect, it } from 'vitest';
import { runMcpInit, type McpInitDeps, type McpInitInput } from '../src/cli/mcp/run.ts';
import type { CliOptions } from '../src/cli/options.ts';

/** Default `mcp init` options, overridden per test. */
function options(overrides: Partial<CliOptions['mcpInit']> = {}): CliOptions['mcpInit'] {
	return {
		agents: [],
		yes: false,
		print: false,
		scope: 'user',
		command: null,
		args: null,
		...overrides,
	};
}

/** A fake home where Cursor and Codex are installed. */
function harness(overrides: Partial<McpInitDeps> = {}) {
	const files = new Map<string, string>();
	const written: string[] = [];
	const log: string[] = [];
	const warn: string[] = [];
	const installed = new Set(['/home/dev/.cursor', '/home/dev/.codex']);
	const deps: McpInitDeps = {
		ctx: { home: '/home/dev', platform: 'linux', env: {}, cwd: '/work/project' },
		exists: (path) => installed.has(path),
		commandExists: () => false,
		readFile: (path) => {
			const contents = files.get(path);
			if (contents === undefined) throw new Error('ENOENT');
			return contents;
		},
		writeFile: (path, contents) => {
			files.set(path, contents);
			written.push(path);
		},
		ensureDir: () => undefined,
		log: (line) => log.push(line),
		warn: (line) => warn.push(line),
		chooseAgents: async (_message, _choices, initial) => initial,
		...overrides,
	};
	const input: McpInitInput = { version: '0.9.0', options: options() };
	return { files, written, log, warn, deps, input };
}

describe('runMcpInit', () => {
	it('detects installed agents and lists them for --print', async () => {
		const h = harness();
		h.input.options = options({ print: true });
		const code = await runMcpInit(h.input, h.deps);
		expect(code).toBe(0);
		expect(h.written).toEqual([]);
		const text = h.log.join('\n');
		expect(text).toContain('Cursor');
		expect(text).toContain('Codex CLI');
		expect(text).toContain('watch-tail@0.9.0');
	});

	it('writes every detected agent with --yes', async () => {
		const h = harness();
		h.input.options = options({ yes: true });
		expect(await runMcpInit(h.input, h.deps)).toBe(0);
		expect(h.written.toSorted()).toEqual([
			'/home/dev/.codex/config.toml',
			'/home/dev/.cursor/mcp.json',
		]);
		const cursor = JSON.parse(h.files.get('/home/dev/.cursor/mcp.json') ?? '{}') as {
			mcpServers: { 'watch-tail': { command: string; args: string[] } };
		};
		expect(cursor.mcpServers['watch-tail']).toEqual({
			command: 'npx',
			args: ['-y', 'watch-tail@0.9.0', 'mcp'],
		});
		expect(h.files.get('/home/dev/.codex/config.toml')).toContain('[mcp_servers.watch-tail]');
	});

	it('writes only the agents the user selects', async () => {
		const h = harness({ chooseAgents: async () => ['cursor'] });
		expect(await runMcpInit(h.input, h.deps)).toBe(0);
		expect(h.written).toEqual(['/home/dev/.cursor/mcp.json']);
	});

	it('does nothing when the selection is empty', async () => {
		const h = harness({ chooseAgents: async () => [] });
		expect(await runMcpInit(h.input, h.deps)).toBe(1);
		expect(h.written).toEqual([]);
		expect(h.warn.join('\n')).toContain('nothing selected');
	});

	it('reports an unknown --agent id', async () => {
		const h = harness();
		h.input.options = options({ agents: ['nope'], yes: true });
		expect(await runMcpInit(h.input, h.deps)).toBe(2);
		expect(h.warn.join('\n')).toContain('unknown agent "nope"');
	});

	it('says so when nothing is detected', async () => {
		const h = harness({ exists: () => false });
		h.input.options = options({ yes: true });
		expect(await runMcpInit(h.input, h.deps)).toBe(1);
		expect(h.log.join('\n')).toContain('No supported AI agents were found');
	});

	it('is a no-op the second time', async () => {
		const first = harness();
		first.input.options = options({ yes: true });
		await runMcpInit(first.input, first.deps);
		const files = first.files;

		const second = harness({
			readFile: (path) => files.get(path) ?? '',
		});
		second.input.options = options({ yes: true });
		expect(await runMcpInit(second.input, second.deps)).toBe(0);
		expect(second.log.join('\n')).toContain('already has watch-tail configured');
		expect(second.written).toEqual([]);
	});

	it('writes project scope into the current directory', async () => {
		const h = harness();
		h.input.options = options({ agents: ['cursor'], yes: true, scope: 'project' });
		expect(await runMcpInit(h.input, h.deps)).toBe(0);
		expect(h.written).toEqual(['/work/project/.cursor/mcp.json']);
	});

	it('refuses to clobber a config it cannot parse, and reports it', async () => {
		const h = harness({
			readFile: () => '{ broken',
		});
		h.input.options = options({ agents: ['cursor'], yes: true });
		expect(await runMcpInit(h.input, h.deps)).toBe(1);
		expect(h.written).toEqual([]);
		expect(h.warn.join('\n')).toContain('could not update Cursor');
	});

	it('honours a command override in the written config', async () => {
		const h = harness();
		h.input.options = options({
			agents: ['cursor'],
			yes: true,
			command: 'node',
			args: ['/work/dist/cli/bin.js'],
		});
		await runMcpInit(h.input, h.deps);
		const cursor = JSON.parse(h.files.get('/home/dev/.cursor/mcp.json') ?? '{}') as {
			mcpServers: { 'watch-tail': { command: string; args: string[] } };
		};
		expect(cursor.mcpServers['watch-tail']).toEqual({
			command: 'node',
			args: ['/work/dist/cli/bin.js', 'mcp'],
		});
	});
});
