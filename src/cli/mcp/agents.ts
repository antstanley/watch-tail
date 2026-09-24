/**
 * The agents watch-tail knows how to configure, how to tell whether they are
 * installed, and how to merge a `watch-tail` server entry into their files.
 *
 * Everything is a pure function of the paths and text it is handed: detection
 * takes an `exists`, planning takes the current file contents, so the whole
 * module can be tested against fabricated home directories. Writing files is the
 * caller's job, which keeps this module free of side effects.
 *
 * The registry only lists agents whose configuration format is stable and
 * documented. An agent that is not listed can still be wired up by hand; run
 * `watch-tail mcp init --print` to see the exact entry.
 */
import { join } from 'node:path';

/** Agent config written user-wide or for the current project. */
export type AgentScope = 'user' | 'project';

/** Config file syntax used by an agent. */
type AgentFormat = 'json' | 'toml';

/** Host facts a path decision can depend on. */
export type AgentContext = {
	home: string;
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	/** Project directory, used by project-scoped configuration. */
	cwd: string;
};

/** What exists on disk, or on the PATH, when detection runs. */
export type DetectionIO = {
	exists: (path: string) => boolean;
	/** Optional: a CLI on the PATH is a second signal that an agent is installed. */
	commandExists?: (binary: string) => boolean;
};

/** One configurable agent. */
export type AgentDefinition = {
	/** Stable id used by `--agent`. */
	id: string;
	/** Human name shown in the prompt. */
	name: string;
	format: AgentFormat;
	/** JSON key (or TOML section stem) that holds the server map. */
	serverKey: string;
	/** Where the user-wide config lives. */
	userPath: (ctx: AgentContext) => string;
	/** Where a project config lives, when the agent supports one. */
	projectPath?: (ctx: AgentContext) => string;
	/** Paths whose presence means the agent is installed. */
	detect: (ctx: AgentContext) => string[];
	/** A binary that also means the agent is installed. */
	binary?: string;
	/** Extra fields the agent needs in the server entry (VS Code wants `type`). */
	entryExtras?: Record<string, unknown>;
};

/** Name the server is registered under in every agent. */
const MCP_SERVER_NAME = 'watch-tail';

/** `$XDG_CONFIG_HOME`, or the platform default. */
function xdgConfig(ctx: AgentContext): string {
	return ctx.env.XDG_CONFIG_HOME?.trim() || join(ctx.home, '.config');
}

/** `%APPDATA%` on Windows. */
function appData(ctx: AgentContext): string {
	return ctx.env.APPDATA?.trim() || join(ctx.home, 'AppData', 'Roaming');
}

/** macOS application support directory. */
function macSupport(ctx: AgentContext): string {
	return join(ctx.home, 'Library', 'Application Support');
}

/** VS Code's per-user data directory. */
function vscodeData(ctx: AgentContext): string {
	if (ctx.platform === 'darwin') return join(macSupport(ctx), 'Code');
	if (ctx.platform === 'win32') return join(appData(ctx), 'Code');
	return join(xdgConfig(ctx), 'Code');
}

/** Claude Desktop's data directory. */
function claudeDesktopData(ctx: AgentContext): string {
	if (ctx.platform === 'darwin') return join(macSupport(ctx), 'Claude');
	if (ctx.platform === 'win32') return join(appData(ctx), 'Claude');
	return join(xdgConfig(ctx), 'Claude');
}

/** Every agent this build configures, in the order they are offered. */
export const AGENTS: readonly AgentDefinition[] = [
	{
		id: 'claude-desktop',
		name: 'Claude Desktop',
		format: 'json',
		serverKey: 'mcpServers',
		userPath: (ctx) => join(claudeDesktopData(ctx), 'claude_desktop_config.json'),
		detect: (ctx) => [claudeDesktopData(ctx)],
	},
	{
		id: 'claude-code',
		name: 'Claude Code',
		format: 'json',
		serverKey: 'mcpServers',
		userPath: (ctx) => join(ctx.home, '.claude.json'),
		projectPath: (ctx) => join(ctx.cwd, '.mcp.json'),
		detect: (ctx) => [join(ctx.home, '.claude'), join(ctx.home, '.claude.json')],
		binary: 'claude',
	},
	{
		id: 'cursor',
		name: 'Cursor',
		format: 'json',
		serverKey: 'mcpServers',
		userPath: (ctx) => join(ctx.home, '.cursor', 'mcp.json'),
		projectPath: (ctx) => join(ctx.cwd, '.cursor', 'mcp.json'),
		detect: (ctx) => [join(ctx.home, '.cursor')],
		binary: 'cursor',
	},
	{
		id: 'windsurf',
		name: 'Windsurf',
		format: 'json',
		serverKey: 'mcpServers',
		userPath: (ctx) => join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'),
		detect: (ctx) => [join(ctx.home, '.codeium', 'windsurf')],
		binary: 'windsurf',
	},
	{
		id: 'vscode',
		name: 'VS Code',
		format: 'json',
		serverKey: 'servers',
		userPath: (ctx) => join(vscodeData(ctx), 'User', 'mcp.json'),
		projectPath: (ctx) => join(ctx.cwd, '.vscode', 'mcp.json'),
		detect: (ctx) => [vscodeData(ctx)],
		binary: 'code',
		entryExtras: { type: 'stdio' },
	},
	{
		id: 'gemini',
		name: 'Gemini CLI',
		format: 'json',
		serverKey: 'mcpServers',
		userPath: (ctx) => join(ctx.home, '.gemini', 'settings.json'),
		detect: (ctx) => [join(ctx.home, '.gemini')],
		binary: 'gemini',
	},
	{
		id: 'codex',
		name: 'Codex CLI',
		format: 'toml',
		serverKey: 'mcp_servers',
		userPath: (ctx) => join(ctx.home, '.codex', 'config.toml'),
		detect: (ctx) => [join(ctx.home, '.codex')],
		binary: 'codex',
	},
];

/** Looks up an agent by id. */
export function findAgent(id: string): AgentDefinition | null {
	return AGENTS.find((agent) => agent.id === id) ?? null;
}

/** One agent and whether it was found on this machine. */
export type DetectedAgent = {
	agent: AgentDefinition;
	/** Paths that were checked. */
	paths: string[];
	installed: boolean;
};

/** Checks every known agent against the filesystem and the PATH. */
export function detectAgents(ctx: AgentContext, io: DetectionIO): DetectedAgent[] {
	return AGENTS.map((agent) => {
		const paths = agent.detect(ctx);
		const installed =
			paths.some((path) => io.exists(path)) ||
			(agent.binary !== undefined && io.commandExists?.(agent.binary) === true);
		return { agent, paths, installed };
	});
}

/** The command an agent should run to start the MCP server. */
export type McpCommand = { command: string; args: string[] };

/**
 * Builds the launch command written into every agent config.
 *
 * The default goes through `npx`, so the agent keeps working after watch-tail is
 * upgraded; the version is pinned so the config is reproducible. `--command`
 * and `--args` replace either half for a local build.
 */
export function mcpServerCommand(input: {
	version: string;
	command?: string | null;
	args?: string[] | null;
}): McpCommand {
	const command = input.command?.trim() ?? '';
	return {
		command: command.length > 0 ? command : 'npx',
		args: [
			...(input.args && input.args.length > 0 ? input.args : ['-y', `watch-tail@${input.version}`]),
			'mcp',
		],
	};
}

/** A config file that could not be merged safely. */
export class AgentConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AgentConfigError';
	}
}

/** Canonical JSON with object keys sorted, for order-independent comparison. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (typeof value === 'object' && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/** The entry stored for watch-tail, including any agent-specific extras. */
function serverEntry(agent: AgentDefinition, command: McpCommand): Record<string, unknown> {
	return { ...agent.entryExtras, command: command.command, args: command.args };
}

/** The result of merging the entry into one agent's config file. */
export type ConfigPlan = {
	/** Full new contents of the file. */
	contents: string;
	/** False when the file already held exactly this entry. */
	changed: boolean;
};

/** Merges the entry into a JSON config file. */
function planJsonConfig(agent: AgentDefinition, existing: string, command: McpCommand): ConfigPlan {
	const trimmed = existing.trim();
	let root: Record<string, unknown>;
	if (trimmed.length === 0) {
		root = {};
	} else {
		try {
			const decoded: unknown = JSON.parse(trimmed);
			if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
				throw new AgentConfigError('the config file does not hold a JSON object');
			}
			root = decoded as Record<string, unknown>;
		} catch (error) {
			if (error instanceof AgentConfigError) throw error;
			throw new AgentConfigError(
				`the existing config is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}
	const mapValue = root[agent.serverKey];
	const map =
		typeof mapValue === 'object' && mapValue !== null && !Array.isArray(mapValue)
			? (mapValue as Record<string, unknown>)
			: {};
	const entry = serverEntry(agent, command);
	const changed = canonical(map[MCP_SERVER_NAME]) !== canonical(entry);
	root[agent.serverKey] = { ...map, [MCP_SERVER_NAME]: entry };
	return { contents: `${JSON.stringify(root, null, 2)}\n`, changed };
}

/** Renders a TOML basic string using JSON's own escaping, which TOML shares. */
function quoteToml(value: string): string {
	return JSON.stringify(value);
}

/** Renders the TOML lines for the Codex `[mcp_servers.watch-tail]` section. */
function tomlSection(agent: AgentDefinition, command: McpCommand): string[] {
	return [
		`[${agent.serverKey}.${MCP_SERVER_NAME}]`,
		`command = ${quoteToml(command.command)}`,
		`args = [${command.args.map(quoteToml).join(', ')}]`,
	];
}

/** Replaces a `[section]` block, or appends it when the file does not have one. */
export function replaceTomlSection(text: string, section: string, block: string[]): string {
	const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
	const header = `[${section}]`;
	const start = lines.findIndex((line) => line.trim() === header);
	if (start >= 0) {
		let end = start + 1;
		while (end < lines.length && !lines[end].trimStart().startsWith('[')) end += 1;
		return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n') + '\n';
	}
	const body = lines.length > 0 ? [...lines, '', ...block] : block;
	return body.join('\n') + '\n';
}

/** Merges the entry into a TOML config file (Codex CLI). */
function planTomlConfig(agent: AgentDefinition, existing: string, command: McpCommand): ConfigPlan {
	const section = `${agent.serverKey}.${MCP_SERVER_NAME}`;
	const contents = replaceTomlSection(existing, section, tomlSection(agent, command));
	return { contents, changed: contents !== existing };
}

/**
 * Plans one file write without touching the filesystem.
 *
 * Throws {@link AgentConfigError} when an existing file cannot be merged safely,
 * so a hand-written config is never clobbered.
 */
export function planAgentConfig(input: {
	agent: AgentDefinition;
	existing: string;
	command: McpCommand;
}): ConfigPlan {
	const { agent, existing, command } = input;
	return agent.format === 'toml'
		? planTomlConfig(agent, existing, command)
		: planJsonConfig(agent, existing, command);
}

/** The config file to write for a scope, or `null` when the scope is unsupported. */
export function agentConfigPath(
	agent: AgentDefinition,
	ctx: AgentContext,
	scope: AgentScope,
): string | null {
	if (scope === 'project') return agent.projectPath?.(ctx) ?? null;
	return agent.userPath(ctx);
}

/** A copy-pasteable snippet for an agent that is configured by hand. */
export function agentConfigSnippet(agent: AgentDefinition, command: McpCommand): string {
	const entry = serverEntry(agent, command);
	if (agent.format === 'toml') return `${tomlSection(agent, command).join('\n')}\n`;
	return JSON.stringify({ [agent.serverKey]: { [MCP_SERVER_NAME]: entry } }, null, 2) + '\n';
}
