/**
 * Command-line surface of the `watch-tail` CLI.
 *
 * Parsing is pure so it can be unit tested: nothing here spawns a process or
 * touches the network. {@link parseCliArgs} never throws - it returns a
 * discriminated result the entry point turns into an exit code.
 *
 * The CLI has three entry points. `serve` (the default) runs the browser UI;
 * `mcp` runs the headless MCP server an agent talks to over stdio; `mcp init`
 * writes watch-tail into the configuration of agents found on this machine.
 */
import { parse } from '@bomb.sh/args';

/** Port the local UI listens on unless `--port` is given. */
export const DEFAULT_PORT = 4517;
/** Loopback default: the app proxies your AWS permissions, so keep it local. */
export const DEFAULT_HOST = '127.0.0.1';
/** Local emulator the `--floci` shorthand points at. */
export const FLOCI_ENDPOINT = 'http://localhost:4566';

/** Which entry point the command line selected. */
type CliCommand = 'serve' | 'mcp' | 'mcp-init';

/** Settings for `watch-tail mcp` (the headless MCP server). */
type McpServerOptions = {
	/**
	 * Use a watch-tail that is already running at this URL instead of starting a
	 * private headless one. `null` means "start my own".
	 */
	url: string | null;
};

/** Where an agent's configuration is written. */
type AgentScope = 'user' | 'project';

/** Settings for `watch-tail mcp init`. */
type McpInitOptions = {
	/** Agent ids named with `--agent`, or an empty list to detect and ask. */
	agents: string[];
	/** Configure every detected agent without asking. */
	yes: boolean;
	/** Print the configuration instead of writing it. */
	print: boolean;
	/** Write user-wide configuration or configuration for the current project. */
	scope: AgentScope;
	/** Launch executable written into the agent config, or `null` for the default. */
	command: string | null;
	/** Arguments written before `mcp`, or `null` for the default. */
	args: string[] | null;
};

export type CliOptions = {
	/** Which entry point this invocation runs. */
	command: CliCommand;
	/** AWS profile passed to the server as `AWS_PROFILE`. */
	profile: string | null;
	/** Region override passed to the server as `AWS_REGION`. */
	region: string | null;
	/** TCP port for the local UI. */
	port: number;
	/** True when `--port` was given, rather than defaulted. */
	portGiven: boolean;
	/** Interface to bind. Anything but loopback prints a warning. */
	host: string;
	/** Emulator endpoint (floci, LocalStack), or `null` for real AWS. */
	endpoint: string | null;
	/** Open the browser once the server is ready. */
	open: boolean;
	/** Print the child environment (or agent config) and exit. */
	print: boolean;
	/** List the AWS profiles found on disk and exit. */
	list: boolean;
	/** Show usage. */
	help: boolean;
	/** Show the version. */
	version: boolean;
	/** Extra logging. */
	verbose: boolean;
	/** Keep the local history archive on (default). `--no-archive` turns it off. */
	archive: boolean;
	/** Database file for the local history archive, or `null` for the default. */
	db: string | null;
	/** `complete <shell>` / `complete -- <words>` payload, or `null`. */
	complete: string[] | null;
	/** Settings for `watch-tail mcp`; ignored by the other entry points. */
	mcpServer: McpServerOptions;
	/** Settings for `watch-tail mcp init`; ignored by the other entry points. */
	mcpInit: McpInitOptions;
};

export type ParseCliResult = { ok: true; options: CliOptions } | { ok: false; error: string };

/** Flags accepted by the parser; anything else is reported as unknown. */
const KNOWN_FLAGS = new Set([
	'_',
	'profile',
	'p',
	'region',
	'r',
	'port',
	'host',
	'endpoint',
	'floci',
	'open',
	'no-open',
	'print',
	'list',
	'help',
	'h',
	'version',
	'v',
	'verbose',
	'archive',
	'no-archive',
	'db',
	// MCP entry points.
	'url',
	'agent',
	'yes',
	'scope',
	'command',
	'args',
]);

const STRING_FLAGS = [
	'profile',
	'region',
	'port',
	'host',
	'endpoint',
	'db',
	'url',
	'agent',
	'scope',
	'command',
	'args',
] as const;

const BOOLEAN_FLAGS = [
	'floci',
	'open',
	'no-open',
	'print',
	'list',
	'help',
	'version',
	'verbose',
	'archive',
	'no-archive',
	'yes',
] as const;

function asString(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return null;
}

function asFlag(value: unknown): boolean {
	return value === true || value === 'true';
}

/** Splits a comma-separated list, trimming blanks. */
function asList(value: string | null): string[] {
	if (value === null) return [];
	return value
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/** Splits a whitespace-separated argument list, trimming blanks. */
function asWords(value: string | null): string[] | null {
	if (value === null) return null;
	const words = value.split(/\s+/).filter((word) => word.length > 0);
	return words.length > 0 ? words : null;
}

/**
 * Parses `watch-tail` arguments.
 *
 * Accepts `--flag value` and `--flag=value`, short aliases (`-p`, `-r`, `-h`,
 * `-v`), and the boolean negations `--open` / `--no-open`. `mcp` and
 * `mcp init` select the other entry points and must be the first words.
 */
export function parseCliArgs(argv: string[]): ParseCliResult {
	// `complete` is the shell-completion protocol, not a normal invocation. It is
	// matched against the raw words so the literal `--` separating the two
	// completion modes survives.
	if (argv[0] === 'complete') {
		return { ok: true, options: { ...defaults(), complete: argv.slice(1) } };
	}

	const words = argv.filter((word) => word !== '--');

	let command: CliCommand = 'serve';
	let rest = words;
	if (words[0] === 'mcp') {
		if (words[1] === 'init') {
			command = 'mcp-init';
			rest = words.slice(2);
		} else {
			command = 'mcp';
			rest = words.slice(1);
		}
	}

	const parsed = parseFlags(rest);
	if (!parsed.ok) return parsed;

	const positionals = Array.isArray(parsed.parsed._) ? (parsed.parsed._ as unknown[]) : [];
	if (positionals.length > 0) {
		return { ok: false, error: unexpected(positionals[0], command) };
	}

	const options = buildOptions(parsed.parsed, command);
	if (!options.ok) return options;
	return { ok: true, options: options.options };
}

/** The message shown for a stray positional argument. */
function unexpected(value: unknown, command: CliCommand): string {
	if (command === 'serve' && value === 'mcp') return 'Unexpected argument "mcp"';
	if (command === 'mcp' && value === 'init') return 'Unexpected argument "init"';
	return `Unexpected argument "${String(value)}". Run watch-tail --help for usage.`;
}

/** Runs `@bomb.sh/args` and rejects anything the CLI does not know. */
function parseFlags(
	words: string[],
): { ok: true; parsed: Record<string, unknown> } | { ok: false; error: string } {
	let parsed: Record<string, unknown>;
	try {
		parsed = parse(words, {
			alias: { p: 'profile', r: 'region', h: 'help', v: 'version' },
			boolean: [...BOOLEAN_FLAGS],
			string: [...STRING_FLAGS],
			default: { open: true },
		}) as Record<string, unknown>;
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}

	const unknown = Object.keys(parsed).filter((key) => !KNOWN_FLAGS.has(key));
	if (unknown.length > 0) return { ok: false, error: `Unknown option "${unknown[0]}"` };
	return { ok: true, parsed };
}

/** Turns parsed flags into {@link CliOptions}, validating what has a range. */
function buildOptions(
	parsed: Record<string, unknown>,
	command: CliCommand,
): { ok: true; options: CliOptions } | { ok: false; error: string } {
	const portRaw = asString(parsed.port);
	const port = portRaw === null ? DEFAULT_PORT : parsePortValue(portRaw);
	if (port === null) return { ok: false, error: `Invalid --port "${portRaw}": expected 1-65535` };

	const scopeRaw = asString(parsed.scope);
	if (scopeRaw !== null && scopeRaw !== 'user' && scopeRaw !== 'project') {
		return { ok: false, error: `Invalid --scope "${scopeRaw}": expected user or project` };
	}

	const endpoint = asFlag(parsed.floci) ? FLOCI_ENDPOINT : asString(parsed.endpoint);

	return {
		ok: true,
		options: {
			command,
			profile: asString(parsed.profile),
			region: asString(parsed.region),
			port,
			portGiven: portRaw !== null,
			host: asString(parsed.host) ?? DEFAULT_HOST,
			endpoint,
			open: !asFlag(parsed['no-open']) && parsed.open !== false,
			print: asFlag(parsed.print),
			list: asFlag(parsed.list),
			help: asFlag(parsed.help),
			version: asFlag(parsed.version),
			verbose: asFlag(parsed.verbose),
			archive: !asFlag(parsed['no-archive']) && parsed.archive !== false,
			db: asString(parsed.db),
			complete: null,
			mcpServer: { url: asString(parsed.url) },
			mcpInit: {
				agents: asList(asString(parsed.agent)),
				yes: asFlag(parsed.yes),
				print: asFlag(parsed.print),
				scope: scopeRaw === 'project' ? 'project' : 'user',
				command: asString(parsed.command),
				args: asWords(asString(parsed.args)),
			},
		},
	};
}

/** Defaults used by tests and by the `complete` short-circuit. */
export function defaults(): CliOptions {
	return {
		command: 'serve',
		profile: null,
		region: null,
		port: DEFAULT_PORT,
		portGiven: false,
		host: DEFAULT_HOST,
		endpoint: null,
		open: true,
		print: false,
		list: false,
		help: false,
		version: false,
		verbose: false,
		archive: true,
		db: null,
		complete: null,
		mcpServer: { url: null },
		mcpInit: {
			agents: [],
			yes: false,
			print: false,
			scope: 'user',
			command: null,
			args: null,
		},
	};
}

/** Parses a port, returning `null` when it is not a usable TCP port. */
export function parsePortValue(value: string): number | null {
	const trimmed = value.trim();
	if (!/^\d{1,5}$/.test(trimmed)) return null;
	const port = Number(trimmed);
	return port >= 1 && port <= 65535 ? port : null;
}

/** True when the host is loopback only. */
export function isLoopbackHost(host: string): boolean {
	return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** Usage text shown by `--help` and after an argument error. */
export function usageText(): string {
	return `watch-tail - tail CloudWatch Logs in your browser

Usage
  watch-tail [options]            (also installed as \`wt\`)

Options
  -p, --profile <name>   AWS profile to use (default: ambient credentials)
  -r, --region <code>    Region to open on (default: profile region, else AWS_REGION)
      --endpoint <url>   Point the app at a local emulator instead of AWS
      --floci            Shorthand for --endpoint ${FLOCI_ENDPOINT}
      --port <number>    Port for the local UI (default ${DEFAULT_PORT})
      --host <address>   Interface to bind (default ${DEFAULT_HOST}, loopback only)
      --no-open          Do not open a browser window
      --print            Print the environment that would be used, then exit
      --list             List the AWS profiles found on disk, then exit
      --verbose          Log the server's own output
      --db <path>        Explicit archive file (default: per account and region)
      --no-archive       Do not keep a local history archive
  -h, --help             Show this help
  -v, --version          Show the version

Headless MCP server (for AI agents)
  watch-tail mcp                 Serve watch-tail to an agent over stdio
      --url <url>           Use a watch-tail already running at this URL

Configure installed agents
  watch-tail mcp init            Detect agents and write watch-tail into them
      --agent <ids>      Configure these agents (comma separated), skipping detection
      --yes              Configure every detected agent without asking
      --print            Print the configuration instead of writing it
      --scope <scope>    Where to write: user (default) or project
      --command <exe>    Executable written into the agent config (default: npx)
      --args <args>      Arguments written before \`mcp\` (default: -y watch-tail@<version>)

Shell completions
  watch-tail complete <shell>      Print a completion script (zsh, bash, fish, powershell)
  watch-tail complete -- <words>   Completion protocol used by the generated script

Examples
  npx watch-tail
  npx watch-tail --profile my-profile --region eu-west-1
  npx watch-tail --floci --port 4600 --no-open
  npx watch-tail --db ./logs.duckdb      (history in a file you choose)
  npx watch-tail mcp                     (headless server an agent starts)
  npx watch-tail mcp init                (write the agent configuration)

Everything the app streams is also archived to a local DuckDB file, so the UI can
browse history later without calling AWS. Use --no-archive to switch that off, or
--db to keep the archive somewhere else. The database needs the optional DuckDB
driver: when it is missing, the app runs exactly as before, without history.

The app streams whatever your ambient AWS credentials can read. Credentials are
resolved by the AWS SDK (SSO, shared config, environment, instance role); the CLI
never stores them.`;
}
