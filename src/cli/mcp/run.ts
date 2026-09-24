/**
 * Orchestration for the two MCP entry points.
 *
 * `runMcpServer` owns the lifetime of a private watch-tail server: it starts one
 * on a free port (or attaches to a URL), serves MCP over stdio, and stops the
 * server when stdin closes or a signal arrives. `runMcpInit` detects installed
 * agents, asks which ones to configure, and writes the merge plan from
 * `agents.ts`. Both take their side effects as arguments, so they can be driven
 * in a test without a process, a terminal or a filesystem.
 */
import { dirname } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { CliOptions } from '../options.ts';
import { healthUrl, uiUrl } from '../server.ts';
import type { startServer, waitForHealth } from '../server.ts';
import type { createHttpBackend } from './backend.ts';
import { createWatchTailServer } from './tools.ts';
import type { McpOutput, ServeMcpOptions } from './stdio.ts';
import {
	AGENTS,
	AgentConfigError,
	agentConfigPath,
	agentConfigSnippet,
	detectAgents,
	findAgent,
	mcpServerCommand,
	planAgentConfig,
	type AgentContext,
	type AgentDefinition,
	type McpCommand,
} from './agents.ts';

/** Dependencies of {@link runMcpServer}. */
export type McpServerDeps = {
	startServer: typeof startServer;
	waitForHealth: typeof waitForHealth;
	stopServer: (child: ChildProcess) => Promise<number>;
	findFreePort: () => Promise<number>;
	serve: (options: ServeMcpOptions) => Promise<void>;
	createBackend: typeof createHttpBackend;
	fetchImpl: typeof fetch;
	/** Subscribes to stop signals; returns an unsubscribe. */
	subscribeSignals?: (handler: () => void) => () => void;
};

/** Everything {@link runMcpServer} needs, already resolved. */
export type McpServerInput = {
	version: string;
	/** Region passed to tools that do not name one. */
	region: string | null;
	/** Attach to an existing server, or `null` to start a private one. */
	url: string | null;
	host: string;
	/** Private server port, or `null` to pick a free one. */
	port: number | null;
	appRoot: string | null;
	/** Environment for the private server. */
	childEnv: NodeJS.ProcessEnv;
	input: AsyncIterable<Buffer | string> & { destroy?: () => void };
	output: McpOutput;
	stderr: (line: string) => void;
};

/** Subscribes to the signals that should stop the server. */
function defaultSignals(handler: () => void): () => void {
	const events: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
	for (const event of events) process.on(event, handler);
	return () => {
		for (const event of events) process.off(event, handler);
	};
}

/** Renders a thrown value as a message. */
function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Placeholder for the stop resolver until a promise installs the real one. */
const noop = (): void => undefined;

/**
 * Serves MCP over stdio until the agent closes the connection.
 *
 * Nothing but protocol responses is written to `output`: the headless server is
 * started with its own stdout hidden, and every diagnostic goes to `stderr`.
 */
export async function runMcpServer(input: McpServerInput, deps: McpServerDeps): Promise<number> {
	let child: ChildProcess | null = null;
	let url = input.url;

	if (url === null) {
		if (input.appRoot === null) {
			input.stderr('Could not find the built app (build/index.js). Run `pnpm build` first.');
			return 1;
		}
		let port: number;
		try {
			port = input.port ?? (await deps.findFreePort());
		} catch (error) {
			input.stderr(`could not find a free port for the headless server: ${describe(error)}`);
			return 1;
		}
		url = uiUrl(input.host, port);
		child = deps.startServer({
			appRoot: input.appRoot,
			env: input.childEnv,
			port,
			host: input.host,
			verbose: false,
		});
		const ready = await deps.waitForHealth(healthUrl(url), { fetchImpl: deps.fetchImpl });
		if (!ready) {
			input.stderr(`the headless watch-tail server did not answer on ${url}`);
			await deps.stopServer(child);
			return 1;
		}
	} else {
		const ready = await deps.waitForHealth(healthUrl(url), {
			fetchImpl: deps.fetchImpl,
			timeoutMs: 3000,
		});
		if (!ready) {
			input.stderr(`no watch-tail server answered at ${url}`);
			return 1;
		}
	}

	const backend = deps.createBackend({ baseUrl: url, fetchImpl: deps.fetchImpl });
	const server = createWatchTailServer({
		backend,
		version: input.version,
		region: input.region,
	});

	let releaseStop: () => void = noop;
	const stopped = new Promise<void>((resolve) => {
		releaseStop = resolve;
	});
	const onSignal = (): void => {
		input.input.destroy?.();
		releaseStop();
	};
	const unsubscribe = (deps.subscribeSignals ?? defaultSignals)(onSignal);

	try {
		await Promise.race([
			deps.serve({
				input: input.input,
				output: input.output,
				server,
				onError: (error) => input.stderr(`watch-tail mcp: ${describe(error)}`),
			}),
			stopped,
		]);
	} finally {
		unsubscribe();
		if (child !== null) await deps.stopServer(child);
	}
	return 0;
}

/** Dependencies of {@link runMcpInit}. */
export type McpInitDeps = {
	ctx: AgentContext;
	exists: (path: string) => boolean;
	commandExists: (binary: string) => boolean;
	readFile: (path: string) => string;
	writeFile: (path: string, contents: string) => void;
	ensureDir: (dir: string) => void;
	log: (line: string) => void;
	warn: (line: string) => void;
	/** Multi-select prompt; a non-interactive run resolves an empty list. */
	chooseAgents: (
		message: string,
		options: { value: string; label: string }[],
		initial: string[],
	) => Promise<string[]>;
};

/** Everything {@link runMcpInit} needs, already resolved. */
export type McpInitInput = {
	version: string;
	options: CliOptions['mcpInit'];
};

/** One agent that will be configured, with the file it writes. */
type Target = { agent: AgentDefinition; path: string };

/** Resolves the agents named by `--agent`, reporting unknown ids. */
function namedTargets(
	ids: string[],
	ctx: AgentContext,
	scope: CliOptions['mcpInit']['scope'],
	warn: (line: string) => void,
): Target[] | null {
	const targets: Target[] = [];
	for (const id of ids) {
		const agent = findAgent(id);
		if (agent === null) {
			warn(`unknown agent "${id}" (known: ${AGENTS.map((entry) => entry.id).join(', ')})`);
			return null;
		}
		const path = agentConfigPath(agent, ctx, scope);
		if (path === null) {
			warn(`${agent.name} has no ${scope} configuration`);
			continue;
		}
		targets.push({ agent, path });
	}
	return targets;
}

/** Resolves every detected agent, at the requested scope. */
function detectedTargets(
	ctx: AgentContext,
	scope: CliOptions['mcpInit']['scope'],
	deps: McpInitDeps,
): Target[] {
	const targets: Target[] = [];
	for (const detected of detectAgents(ctx, deps)) {
		if (!detected.installed) continue;
		const path = agentConfigPath(detected.agent, ctx, scope);
		if (path === null) continue;
		targets.push({ agent: detected.agent, path });
	}
	return targets;
}

/** Reads a config file, treating a missing one as empty. */
function readExisting(path: string, deps: McpInitDeps): string {
	try {
		return deps.readFile(path);
	} catch {
		return '';
	}
}

/** Writes the merge plan for one agent, returning whether anything changed. */
function applyTarget(
	target: Target,
	command: McpCommand,
	deps: McpInitDeps,
): 'written' | 'unchanged' | 'failed' {
	const existing = readExisting(target.path, deps);
	let plan;
	try {
		plan = planAgentConfig({ agent: target.agent, existing, command });
	} catch (error) {
		if (error instanceof AgentConfigError) {
			deps.warn(`could not update ${target.agent.name}: ${error.message}`);
			return 'failed';
		}
		throw error;
	}
	if (!plan.changed) {
		deps.log(`${target.agent.name} already has watch-tail configured (${target.path})`);
		return 'unchanged';
	}
	try {
		deps.ensureDir(dirname(target.path));
		deps.writeFile(target.path, plan.contents);
	} catch (error) {
		deps.warn(`could not write ${target.path}: ${describe(error)}`);
		return 'failed';
	}
	deps.log(`configured ${target.agent.name} (${target.path})`);
	return 'written';
}

/**
 * `watch-tail mcp init`: detect installed agents, ask which to configure, and
 * write the `watch-tail` MCP server into their configuration.
 *
 * Exit codes: 0 when every selected agent is configured (or already was), 1 when
 * nothing was detected or a write failed, 2 for an unknown `--agent` id.
 */
export async function runMcpInit(input: McpInitInput, deps: McpInitDeps): Promise<number> {
	const command = mcpServerCommand({
		version: input.version,
		command: input.options.command,
		args: input.options.args,
	});
	const { ctx } = deps;

	let targets: Target[];
	if (input.options.agents.length > 0) {
		const resolved = namedTargets(input.options.agents, ctx, input.options.scope, deps.warn);
		if (resolved === null) return 2;
		targets = resolved;
	} else {
		targets = detectedTargets(ctx, input.options.scope, deps);
		if (targets.length === 0) {
			deps.log('No supported AI agents were found on this machine.');
			deps.log(`Known agents: ${AGENTS.map((agent) => agent.id).join(', ')}.`);
			deps.log('Pass --agent <id> to configure one anyway, or --print to see the config.');
			return 1;
		}
		deps.log(`Found ${targets.length} agent${targets.length === 1 ? '' : 's'}:`);
		for (const target of targets) deps.log(`  - ${target.agent.name} (${target.path})`);
	}

	if (input.options.print) {
		for (const target of targets) {
			deps.log(`\n# ${target.agent.name} - ${target.path}`);
			deps.log(agentConfigSnippet(target.agent, command).trimEnd());
		}
		return 0;
	}

	let chosen: Target[];
	if (input.options.yes) {
		chosen = targets;
	} else {
		const ids = await deps.chooseAgents(
			'Which agents should watch-tail be configured in?',
			targets.map((target) => ({ value: target.agent.id, label: target.agent.name })),
			targets.map((target) => target.agent.id),
		);
		const selected = new Set(ids);
		chosen = targets.filter((target) => selected.has(target.agent.id));
		if (chosen.length === 0) {
			deps.warn('nothing selected: no agent was configured (pass --yes to skip the question)');
			return 1;
		}
	}

	let failures = 0;
	for (const target of chosen) {
		if (applyTarget(target, command, deps) === 'failed') failures += 1;
	}

	if (failures > 0) {
		deps.warn(`${failures} agent${failures === 1 ? '' : 's'} could not be configured`);
		return 1;
	}
	const executable = [command.command, ...command.args].join(' ');
	deps.log(`\nRestart the configured agent so it picks up watch-tail (${executable}).`);
	return 0;
}
