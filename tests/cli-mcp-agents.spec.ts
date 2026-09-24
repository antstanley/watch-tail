/**
 * Agent detection and configuration planning.
 *
 * The module is pure, so every case runs against fabricated home directories and
 * config text: detection takes an `exists`, planning takes the current contents.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
	AGENTS,
	AgentConfigError,
	agentConfigPath,
	agentConfigSnippet,
	detectAgents,
	findAgent,
	mcpServerCommand,
	planAgentConfig,
	replaceTomlSection,
	type AgentContext,
} from '../src/cli/mcp/agents.ts';

/** A Linux home with nothing installed. */
function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
	return {
		home: '/home/dev',
		platform: 'linux',
		env: {},
		cwd: '/work/project',
		...overrides,
	};
}

/** An `exists` built from a set of paths. */
function existsFrom(paths: string[]): (path: string) => boolean {
	const set = new Set(paths);
	return (path) => set.has(path);
}

describe('mcpServerCommand', () => {
	it('defaults to a version-pinned npx invocation', () => {
		expect(mcpServerCommand({ version: '0.9.0' })).toEqual({
			command: 'npx',
			args: ['-y', 'watch-tail@0.9.0', 'mcp'],
		});
	});

	it('honours a command and argument override, still appending mcp', () => {
		expect(
			mcpServerCommand({
				version: '0.9.0',
				command: 'node',
				args: ['/work/dist/cli/bin.js'],
			}),
		).toEqual({ command: 'node', args: ['/work/dist/cli/bin.js', 'mcp'] });
	});

	it('treats a blank command as the default', () => {
		expect(mcpServerCommand({ version: '0.9.0', command: '   ' }).command).toBe('npx');
	});
});

describe('detectAgents', () => {
	it('finds only the agents whose paths exist', () => {
		const detected = detectAgents(ctx(), {
			exists: existsFrom(['/home/dev/.cursor', '/home/dev/.codex']),
		});
		const installed = detected.filter((entry) => entry.installed).map((entry) => entry.agent.id);
		expect(installed).toEqual(['cursor', 'codex']);
	});

	it('treats a binary on the PATH as installed', () => {
		const detected = detectAgents(ctx(), {
			exists: () => false,
			commandExists: (binary) => binary === 'claude',
		});
		expect(detected.find((entry) => entry.agent.id === 'claude-code')?.installed).toBe(true);
	});

	it('uses the macOS application support directory', () => {
		const mac = ctx({ platform: 'darwin' });
		const claude = findAgent('claude-desktop');
		expect(claude?.userPath(mac)).toBe(
			'/home/dev/Library/Application Support/Claude/claude_desktop_config.json',
		);
	});

	it('uses %APPDATA% on Windows', () => {
		const win = ctx({ platform: 'win32', env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' } });
		expect(findAgent('vscode')?.userPath(win)).toBe(
			join('C:\\Users\\dev\\AppData\\Roaming', 'Code', 'User', 'mcp.json'),
		);
	});
});

describe('agentConfigPath', () => {
	it('resolves a project path only where the agent supports one', () => {
		const context = ctx();
		expect(agentConfigPath(findAgent('cursor')!, context, 'project')).toBe(
			'/work/project/.cursor/mcp.json',
		);
		expect(agentConfigPath(findAgent('cursor')!, context, 'user')).toBe(
			'/home/dev/.cursor/mcp.json',
		);
		expect(agentConfigPath(findAgent('windsurf')!, context, 'project')).toBeNull();
	});
});

describe('planAgentConfig: JSON agents', () => {
	const cursor = findAgent('cursor')!;
	const command = { command: 'npx', args: ['-y', 'watch-tail@0.9.0', 'mcp'] };

	it('creates the entry in an empty config', () => {
		const plan = planAgentConfig({ agent: cursor, existing: '', command });
		expect(plan.changed).toBe(true);
		const parsed = JSON.parse(plan.contents) as {
			mcpServers: { 'watch-tail': { command: string; args: string[] } };
		};
		expect(parsed.mcpServers['watch-tail']).toEqual(command);
	});

	it('keeps other servers and top-level keys', () => {
		const existing = JSON.stringify({
			theme: 'dark',
			mcpServers: { other: { command: 'foo' } },
		});
		const plan = planAgentConfig({ agent: cursor, existing, command });
		const parsed = JSON.parse(plan.contents) as {
			theme: string;
			mcpServers: Record<string, unknown>;
		};
		expect(parsed.theme).toBe('dark');
		expect(parsed.mcpServers.other).toEqual({ command: 'foo' });
		expect(parsed.mcpServers['watch-tail']).toEqual(command);
	});

	it('is idempotent', () => {
		const first = planAgentConfig({ agent: cursor, existing: '', command });
		const second = planAgentConfig({ agent: cursor, existing: first.contents, command });
		expect(second.changed).toBe(false);
		expect(second.contents).toBe(first.contents);
	});

	it('never clobbers a config it cannot parse', () => {
		expect(() => planAgentConfig({ agent: cursor, existing: '{ not json', command })).toThrow(
			AgentConfigError,
		);
	});

	it('adds the type field VS Code needs', () => {
		const vscode = findAgent('vscode')!;
		const plan = planAgentConfig({ agent: vscode, existing: '', command });
		const parsed = JSON.parse(plan.contents) as {
			servers: { 'watch-tail': { type: string; command: string } };
		};
		expect(parsed.servers['watch-tail'].type).toBe('stdio');
	});
});

describe('the Codex TOML config', () => {
	const codex = findAgent('codex')!;
	const command = { command: 'npx', args: ['-y', 'watch-tail@0.9.0', 'mcp'] };

	it('appends a section to an existing file', () => {
		const contents = replaceTomlSection('model = "gpt"\n', 'mcp_servers.watch-tail', [
			'[mcp_servers.watch-tail]',
			'command = "npx"',
		]);
		expect(contents).toBe('model = "gpt"\n\n[mcp_servers.watch-tail]\ncommand = "npx"\n');
	});

	it('replaces an existing section without touching its neighbours', () => {
		const existing = [
			'[mcp_servers.other]',
			'command = "foo"',
			'',
			'[mcp_servers.watch-tail]',
			'command = "old"',
			'args = []',
			'',
			'[other]',
			'key = 1',
			'',
		].join('\n');
		const plan = planAgentConfig({ agent: codex, existing, command });
		expect(plan.contents).toContain('command = "npx"');
		expect(plan.contents).toContain('[mcp_servers.other]');
		expect(plan.contents).toContain('[other]\nkey = 1');
		expect(plan.contents).not.toContain('command = "old"');

		const again = planAgentConfig({ agent: codex, existing: plan.contents, command });
		expect(again.changed).toBe(false);
	});

	it('writes a snippet for --print', () => {
		expect(agentConfigSnippet(codex, command)).toContain('[mcp_servers.watch-tail]');
	});
});

describe('the registry', () => {
	it('has unique ids and human names', () => {
		const ids = AGENTS.map((agent) => agent.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const agent of AGENTS) expect(agent.name.length).toBeGreaterThan(0);
	});

	it('knows the agents this build targets', () => {
		expect(AGENTS.map((agent) => agent.id).toSorted()).toEqual([
			'claude-code',
			'claude-desktop',
			'codex',
			'cursor',
			'gemini',
			'vscode',
			'windsurf',
		]);
	});
});
