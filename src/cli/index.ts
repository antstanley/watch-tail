/**
 * `watch-tail` entry point.
 *
 * Responsibilities are deliberately thin: parse, resolve the AWS context, start
 * the packaged server, wait for it to answer, open a browser and translate
 * signals into an exit code. Everything with behaviour worth testing lives in
 * {@link ./options.ts}, {@link ./server.ts}, {@link ./ui.ts} or
 * `$lib/cli/aws.ts`, and the side effects are injectable through {@link CliIo}.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
	buildChildEnv,
	describeChildEnv,
	isEmulatorEndpoint,
	isLocalEnvPresent,
	readConfigText,
	readCredentialsText,
	readLocalEnvValues,
	readProfiles,
	resolveRunRegion,
	signalExitCode,
	suppressLocalEnvValues,
} from '../lib/cli/aws.ts';
import {
	classifyCredentialFailure,
	describeStyle,
	isCredentialFailure,
	loginAdvice,
	readProfileStyle,
} from '../lib/cli/credentials.ts';
import { handleCompletion } from './completions.ts';
import { createHttpBackend } from './mcp/backend.ts';
import { runMcpInit, runMcpServer, type McpInitDeps, type McpServerDeps } from './mcp/run.ts';
import { serveMcp, type McpOutput } from './mcp/stdio.ts';
import { isLoopbackHost, parseCliArgs, usageText, type CliOptions } from './options.ts';
import {
	appRootFromHere,
	findFreePort,
	healthUrl,
	openBrowser as openBrowserDefault,
	startServer,
	stopServer,
	uiUrl,
	waitForHealth,
} from './server.ts';
import {
	describeArchive,
	isHeadless,
	probeCredentials as probeCredentialsDefault,
	readArchive as readArchiveDefault,
	readIdentity as readIdentityDefault,
	runLogin as runLoginDefault,
	shortIdentity,
	type ArchiveProbe,
	type CredentialProbe,
	type IdentityProbe,
} from './preflight.ts';
import { PromptCancelled, createUi, isInteractive, type Ui } from './ui.ts';

/** Filesystem and environment seam for `mcp init`. */
type AgentIo = {
	home: string;
	platform: NodeJS.Platform;
	cwd: string;
	exists: (path: string) => boolean;
	commandExists: (binary: string) => boolean;
	readFile: (path: string) => string;
	writeFile: (path: string, contents: string) => void;
	ensureDir: (dir: string) => void;
};

/** Every side effect the CLI needs, so tests can run it in-process. */
export type CliIo = {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
	env: NodeJS.ProcessEnv;
	/** True when animated output and prompts are safe. */
	interactive: boolean;
	/** Reads the AWS profiles on disk. */
	readProfiles: () => string[];
	/** Reads `~/.aws/config`. */
	readConfigText: () => string;
	/** Package root containing the built server, or `null` when not built. */
	appRoot: string | null;
	/** Version reported by `--version`. */
	version: string;
	/** Opens a URL in the browser. */
	openBrowser: (url: string) => void;
	/** Reads `~/.aws/credentials`. */
	readCredentialsText: () => string;
	/** Reads the emulator settings that sit next to the app, if any. */
	readLocalEnvValues: () => Record<string, string>;
	/** Asks the running app whether it can reach CloudWatch Logs. */
	probeCredentials: (input: { baseUrl: string; region: string | null }) => Promise<CredentialProbe>;
	/** Runs `aws ...` with the terminal attached, so an interactive login works. */
	runLogin: (command: string[]) => Promise<number>;
	/** Asks the app who the resolved credentials belong to (`sts:GetCallerIdentity`). */
	readIdentity: (input: { baseUrl: string; region: string | null }) => Promise<IdentityProbe>;
	/** Asks the app what the local history archive holds. */
	readArchive: (input: { baseUrl: string }) => Promise<ArchiveProbe>;
	/** Health poller. */
	waitForHealth: typeof waitForHealth;
	/** Used for tests that must not spawn a server. */
	startServerImpl: typeof startServer;
	/** Stops a server child; injected so MCP tests never signal a real process. */
	stopServerImpl: typeof stopServer;
	/** Asks the OS for a free port; the MCP server starts its own headless one. */
	findFreePort: () => Promise<number>;
	/** Runs the MCP stdio loop. */
	serveMcp: typeof serveMcp;
	/** Input the MCP server reads. */
	stdin: AsyncIterable<Buffer | string> & { destroy?: () => void };
	/** Output the MCP server writes; reserved for the protocol alone. */
	mcpStdout: McpOutput;
	/** Filesystem and host information for `mcp init`. */
	agentFs: AgentIo;
	spawnImpl: typeof spawn;
	/** Resolves on the next SIGINT/SIGTERM (or when the child exits). */
	waitForStop: (child: ChildProcess) => Promise<number>;
	/** Test seam for the presentation layer. */
	ui?: Ui;
};

/** Reads the version from the package manifest next to the app root. */
export function readVersion(appRoot: string | null): string {
	const fallback = '0.0.0';
	if (appRoot === null) return fallback;
	try {
		const manifest: unknown = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
		if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
			const version = (manifest as { version?: unknown }).version;
			if (typeof version === 'string' && version.length > 0) return version;
		}
	} catch {
		// A missing or unreadable manifest is not worth failing over.
	}
	return fallback;
}

/** Waits for SIGINT/SIGTERM, or for the server to exit on its own. */
function waitForStop(child: ChildProcess): Promise<number> {
	return new Promise<number>((resolveExit) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolveExit(child.exitCode ?? signalExitCode(child.signalCode));
			return;
		}
		let stopping = false;
		const stop = (): void => {
			if (stopping) {
				// A second signal means the server is stuck: stop it hard.
				child.kill('SIGKILL');
				return;
			}
			stopping = true;
			void stopServer(child).then(resolveExit);
		};
		process.on('SIGINT', stop);
		process.on('SIGTERM', stop);
		child.once('close', (code, signal) => {
			process.off('SIGINT', stop);
			process.off('SIGTERM', stop);
			resolveExit(code ?? signalExitCode(signal));
		});
	});
}

/** True when `binary` is an executable found on `PATH`. */
function commandExists(
	binary: string,
	env: NodeJS.ProcessEnv = process.env,
	exists: (path: string) => boolean = existsSync,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const directories = (env.PATH ?? '').split(delimiter).filter((dir) => dir.length > 0);
	const suffixes = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
	for (const directory of directories) {
		for (const suffix of suffixes) {
			if (exists(join(directory, `${binary}${suffix}`))) return true;
		}
	}
	return false;
}

/**
 * Replaces a file without ever leaving it half-written.
 *
 * `mcp init` edits files other programs own and rewrite (Claude Code keeps its
 * whole state in `~/.claude.json`), so the new contents go to a temporary file
 * beside it, take the original's permissions, and are renamed over it.
 */
export function writeFileAtomic(path: string, contents: string): void {
	const temporary = `${path}.watch-tail-${process.pid}.tmp`;
	let mode: number | null = null;
	try {
		mode = statSync(path).mode & 0o777;
	} catch {
		// A new file takes the default permissions.
	}
	try {
		writeFileSync(temporary, contents, { encoding: 'utf8', mode: mode ?? 0o666 });
		if (mode !== null) chmodSync(temporary, mode);
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/** Real process environment for the CLI. */
function defaultIo(): CliIo {
	const appRoot = appRootFromHere();
	return {
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
		env: process.env,
		interactive: isInteractive(),
		readProfiles: () => readProfiles(),
		readConfigText: () => readConfigText(),
		appRoot,
		version: readVersion(appRoot),
		openBrowser: (url) => openBrowserDefault(url),
		readCredentialsText: () => readCredentialsText(),
		readLocalEnvValues: () => (appRoot === null ? {} : readLocalEnvValues(appRoot)),
		probeCredentials: (input) => probeCredentialsDefault(input),
		runLogin: (command) => runLoginDefault(command),
		readIdentity: (input) => readIdentityDefault(input),
		readArchive: (input) => readArchiveDefault(input),
		waitForHealth,
		startServerImpl: startServer,
		stopServerImpl: stopServer,
		findFreePort,
		serveMcp,
		stdin: process.stdin,
		mcpStdout: process.stdout,
		agentFs: {
			home: homedir(),
			platform: process.platform,
			cwd: process.cwd(),
			exists: (path) => existsSync(path),
			commandExists: (binary) => commandExists(binary),
			readFile: (path) => readFileSync(path, 'utf8'),
			writeFile: (path, contents) => writeFileAtomic(path, contents),
			ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
		},
		spawnImpl: spawn,
		waitForStop,
	};
}

/** `AWS_PROFILE` from the environment, trimmed, or `null`. */
export function ambientProfile(env: NodeJS.ProcessEnv): string | null {
	const value = env.AWS_PROFILE?.trim();
	return value !== undefined && value.length > 0 ? value : null;
}

/** Region for this run: explicit flag, then the shell, then the profile. */
export function resolveCliRegion(options: CliOptions, io: CliIo): string | null {
	const resolved = resolveRunRegion({
		region: options.region,
		profile: options.profile,
		base: io.env,
		configText: io.readConfigText(),
	});
	if (resolved !== null) return resolved;
	// Emulator data is written per region and the demo fixtures live in us-east-1,
	// so a local run that resolves nothing opens on the seeded region.
	if (options.endpoint !== null && isEmulatorEndpoint(options.endpoint)) return 'us-east-1';
	return null;
}

/**
 * Asks the running app for one log group and, when AWS refuses because of
 * credentials, offers to run the login command that profile needs.
 *
 * Emulator runs are skipped: `--floci` supplies throwaway keys on purpose.
 */
/**
 * Asks the running app whether it can read logs, and when it cannot because of
 * credentials, decides which profile the run should be using.
 *
 * With no profile in play it asks, because a machine with several profiles is
 * rarely served by the ambient default. The identity check and the login come
 * after the app has been restarted with that profile: only then do they test
 * the profile the user actually chose.
 */
async function assessCredentials(input: {
	options: CliOptions;
	io: CliIo;
	ui: Ui;
	url: string;
	region: string | null;
	/** Profile the server was started with, or `null` when it was left ambient. */
	startProfile: string | null;
}): Promise<
	| { status: 'ok' }
	| { status: 'other'; message: string }
	| {
			status: 'credentials';
			profile: string;
			chosen: string | null;
			message: string;
			code?: string;
	  }
> {
	const { options, io, ui, url, region, startProfile } = input;
	if (options.endpoint !== null) return { status: 'ok' };

	const probe = await io.probeCredentials({ baseUrl: url, region });
	if (probe.ok) return { status: 'ok' };
	if (!probe.credentialProblem || !isCredentialFailure(probe.code, probe.message)) {
		return { status: 'other', message: probe.message };
	}

	ui.warn(`AWS credentials are not usable: ${probe.message}`);

	let profile = startProfile ?? 'default';
	let chosen: string | null = null;
	if (startProfile === null) {
		const profiles = io.readProfiles();
		if (profiles.length > 1) {
			const answer = await ui.choose(
				'Which AWS profile should watch-tail use?',
				profiles.map((name) => ({ value: name, label: name })),
				profiles.includes('default') ? 'default' : profiles[0],
			);
			if (answer !== null && answer !== 'default') {
				chosen = answer;
				profile = answer;
				ui.info(`using profile ${answer}`);
			}
		}
	}

	return { status: 'credentials', profile, chosen, message: probe.message, code: probe.code };
}

/**
 * Offers the login that repairs a credential failure, runs it if accepted, and
 * reports what happened. The profile is the one the app is currently using.
 */
async function offerLogin(input: {
	options: CliOptions;
	io: CliIo;
	ui: Ui;
	profile: string | null;
	failureMessage: string;
	failureCode?: string;
}): Promise<{ login: 'succeeded' | 'declined' | 'failed' | 'none' }> {
	const { io, ui, profile, failureMessage, failureCode } = input;

	const name = profile ?? 'default';
	const style = readProfileStyle(io.readConfigText(), io.readCredentialsText(), name);
	const failure = classifyCredentialFailure(failureMessage, failureCode);
	const advice = loginAdvice({ style, failure, profile, remote: isHeadless(io.env) });

	if (advice === null) {
		ui.info(
			style === 'static'
				? `the ${describeStyle(style)} in profile "${name}" look wrong - check them with \`aws configure --profile ${name}\``
				: `no login command applies to profile "${name}" (${describeStyle(style)})`,
		);
		return { login: 'none' };
	}

	const label = `aws ${advice.command.join(' ')}`;
	const accepted = await ui.confirm(`${advice.hint}. Run \`${label}\` now?`);
	if (!accepted) {
		ui.info(`run it yourself, then press Refresh in the UI: ${label}`);
		return { login: 'declined' };
	}

	ui.info(`running ${label}`);
	const code = await io.runLogin(advice.command);
	if (code !== 0) {
		ui.warn(`${label} exited with code ${code}`);
		ui.info(`log in another terminal, then press Refresh in the UI: ${label}`);
		return { login: 'failed' };
	}
	return { login: 'succeeded' };
}

/** Idle time after which the MCP server's private watch-tail releases the archive file. */
const MCP_ARCHIVE_IDLE_MS = 5000;

/** Runs `watch-tail mcp`: a headless server an agent talks to over stdio. */
async function runMcpWired(options: CliOptions, io: CliIo): Promise<number> {
	const region = resolveCliRegion(options, io);
	const profile = options.profile ?? ambientProfile(io.env);
	let baseEnv = io.env;
	if (options.endpoint === null) {
		// Same guard as the browser path: a checkout's `.env.local` must not send
		// an agent at the emulator unless `--floci` asked for it.
		baseEnv = suppressLocalEnvValues({ env: io.env, values: io.readLocalEnvValues() }).env;
	}
	const childEnv = buildChildEnv({
		base: baseEnv,
		profile: options.profile,
		region,
		endpoint: options.endpoint,
		clearStaticKeys: options.profile === null && profile !== null,
		archive: { enabled: options.archive, path: options.db },
	});
	// DuckDB lets one process hold the archive file. An agent session can last all
	// day, so its private server releases the file between tool calls rather than
	// locking the browser UI (or another agent) out of the archive.
	childEnv.WATCH_TAIL_ARCHIVE_IDLE_MS = String(MCP_ARCHIVE_IDLE_MS);

	const deps: McpServerDeps = {
		startServer: io.startServerImpl,
		waitForHealth: io.waitForHealth,
		stopServer: io.stopServerImpl,
		findFreePort: io.findFreePort,
		serve: io.serveMcp,
		createBackend: createHttpBackend,
		fetchImpl: fetch,
	};
	return runMcpServer(
		{
			version: io.version,
			region,
			url: options.mcpServer.url,
			host: options.host,
			port: options.portGiven ? options.port : null,
			appRoot: io.appRoot,
			childEnv,
			input: io.stdin,
			output: io.mcpStdout,
			stderr: io.stderr,
		},
		deps,
	);
}

/** Runs `watch-tail mcp init`: writes watch-tail into installed agent configs. */
async function runMcpInitWired(options: CliOptions, io: CliIo): Promise<number> {
	const ui = io.ui ?? createUi({ interactive: io.interactive });
	const deps: McpInitDeps = {
		ctx: {
			home: io.agentFs.home,
			platform: io.agentFs.platform,
			env: io.env,
			cwd: io.agentFs.cwd,
		},
		exists: io.agentFs.exists,
		commandExists: io.agentFs.commandExists,
		readFile: io.agentFs.readFile,
		writeFile: io.agentFs.writeFile,
		ensureDir: io.agentFs.ensureDir,
		log: io.stdout,
		warn: io.stderr,
		chooseAgents: (message, choices, initial) => ui.multiChoose(message, choices, initial),
	};
	try {
		return await runMcpInit({ version: io.version, options: options.mcpInit }, deps);
	} catch (error) {
		if (!(error instanceof PromptCancelled)) throw error;
		ui.outro('stopped');
		return 130;
	}
}

/** Runs the CLI and returns its exit code. */
export async function run(argv: string[], overrides: Partial<CliIo> = {}): Promise<number> {
	const io: CliIo = { ...defaultIo(), ...overrides };

	const parsed = parseCliArgs(argv);
	if (!parsed.ok) {
		io.stderr(parsed.error);
		io.stderr(usageText());
		return 2;
	}
	const options = parsed.options;

	if (options.complete !== null) {
		const code = handleCompletion(options.complete, { profiles: io.readProfiles() });
		if (code !== null) return code;
	}
	if (options.help) {
		io.stdout(usageText());
		return 0;
	}
	if (options.version) {
		io.stdout(io.version);
		return 0;
	}
	if (options.list) {
		const profiles = io.readProfiles();
		for (const name of profiles) io.stdout(name);
		if (profiles.length === 0) {
			io.stderr('No profiles found in ~/.aws/config or ~/.aws/credentials.');
		}
		return 0;
	}

	// The MCP entry points are dispatched before the browser path resolves its
	// region and environment: `mcp init` needs neither, and `mcp` resolves its own
	// so a failure to start the headless server is reported on stderr, never on
	// the stdout reserved for the protocol.
	if (options.command === 'mcp-init') return runMcpInitWired(options, io);
	if (options.command === 'mcp') return runMcpWired(options, io);

	const region = resolveCliRegion(options, io);
	// `--profile` wins, then the ambient AWS_PROFILE: the credential check and
	// the login advice both need to know which profile is actually in play.
	const profile = options.profile ?? ambientProfile(io.env);
	let baseEnv = io.env;
	let suppressedLocalEnv: string[] = [];
	if (options.endpoint === null) {
		// The CLI is real-AWS-by-default, so a dev `.env.local` next to the app
		// (which exists in this repository, and in any checkout of it) must not
		// silently redirect the run at floci. `--floci` asks for that explicitly.
		const suppressed = suppressLocalEnvValues({
			env: io.env,
			values: io.readLocalEnvValues(),
		});
		baseEnv = suppressed.env;
		suppressedLocalEnv = suppressed.suppressed;
	}
	const childEnv = buildChildEnv({
		base: baseEnv,
		profile: options.profile,
		region,
		endpoint: options.endpoint,
		clearStaticKeys: options.profile === null && profile !== null,
		archive: { enabled: options.archive, path: options.db },
	});

	if (options.print) {
		for (const line of describeChildEnv(childEnv)) io.stdout(line);
		return 0;
	}

	if (io.appRoot === null) {
		io.stderr('Could not find the built app (build/index.js). Run `pnpm build` first.');
		return 1;
	}

	const ui = io.ui ?? createUi({ interactive: io.interactive });
	const url = uiUrl(options.host, options.port);

	ui.intro('watch-tail - CloudWatch Logs in your browser');
	if (options.endpoint !== null) {
		ui.info(`endpoint ${options.endpoint} (local emulator)`);
	} else if (options.profile !== null) {
		ui.info(`profile ${options.profile}`);
	}
	if (region !== null) ui.info(`region ${region}`);
	if (!isLoopbackHost(options.host)) {
		ui.warn(
			`binding ${options.host}: the app has no authentication and uses your AWS access, so anyone who can reach it can read your logs`,
		);
	}
	if (suppressedLocalEnv.length > 0) {
		ui.warn(
			`ignoring the emulator settings in .env.local (${suppressedLocalEnv.join(', ')}) - pass --floci to use them`,
		);
	} else if (isLocalEnvPresent(io.appRoot) && options.profile !== null) {
		ui.warn('a .env.local with local emulator settings was found; it is ignored for this run');
	}

	ui.startSpinner('starting the local UI...');
	let child = io.startServerImpl({
		appRoot: io.appRoot,
		env: childEnv,
		port: options.port,
		host: options.host,
		verbose: options.verbose,
	});
	try {
		const ready = await io.waitForHealth(healthUrl(url), { fetchImpl: fetch });
		if (!ready) {
			ui.failSpinner(`the server did not answer on ${url}`);
			await stopServer(child);
			return 1;
		}
		ui.stopSpinner(`listening on ${url}`);

		// Report where history is kept before the AWS check: it is the one thing the
		// UI can offer even when credentials are not usable yet.
		if (!options.archive) {
			ui.info('local history off (--no-archive)');
		} else {
			const archive = await io.readArchive({ baseUrl: url });
			if (archive.ok) {
				if (archive.status.available) ui.info(describeArchive(archive.status));
				else ui.warn(describeArchive(archive.status));
			} else {
				ui.warn(`could not read the local history status: ${archive.message}`);
			}
		}

		// Before sending anyone to a UI that cannot load logs, check that AWS will
		// actually answer, and offer the login that fixes it.
		const assessment = await assessCredentials({
			options,
			io,
			ui,
			url,
			region,
			startProfile: profile,
		});
		if (assessment.status === 'other') {
			ui.warn(`could not list log groups: ${assessment.message}`);
		}

		if (assessment.status === 'credentials') {
			// A profile that was not in play needs the app restarted with it: that is
			// the only way to find out whether its credentials already work, and the
			// only way the browser can use it.
			const activeProfile = assessment.chosen === null ? null : assessment.chosen;
			let activeRegion = region;
			let failureMessage = assessment.message;
			let failureCode = assessment.code;

			if (assessment.chosen !== null) {
				activeRegion = resolveRunRegion({
					region: options.region,
					profile: assessment.chosen,
					base: io.env,
					configText: io.readConfigText(),
				});
				ui.info(`restarting with profile ${assessment.chosen}`);
				await stopServer(child);
				child = io.startServerImpl({
					appRoot: io.appRoot,
					env: buildChildEnv({
						base: baseEnv,
						profile: assessment.chosen,
						region: activeRegion,
						endpoint: null,
						archive: { enabled: options.archive, path: options.db },
					}),
					port: options.port,
					host: options.host,
					verbose: options.verbose,
				});
				const healthy = await io.waitForHealth(healthUrl(url), { fetchImpl: fetch });
				if (!healthy) {
					ui.failSpinner(`the server did not come back up on ${url}`);
					await stopServer(child);
					return 1;
				}

				// Now the question is about the chosen profile, not the ambient one.
				const identity = await io.readIdentity({ baseUrl: url, region: activeRegion });
				if (identity.ok) {
					ui.info(
						`profile ${assessment.chosen} already works (${shortIdentity(identity.identity.arn)}) - using it`,
					);
					const stopped = io.waitForStop(child);
					ui.outro(`${url} (Ctrl+C to stop)`);
					if (options.open) io.openBrowser(url);
					const code = await stopped;
					ui.outro('stopped');
					return code;
				}
				failureMessage = identity.message;
				failureCode = identity.code;
			}

			const outcome = await offerLogin({
				options,
				io,
				ui,
				profile: activeProfile ?? assessment.profile,
				failureMessage,
				failureCode,
			});

			if (outcome.login === 'succeeded') {
				const identity = await io.readIdentity({ baseUrl: url, region: activeRegion });
				if (identity.ok) {
					ui.info(
						`signed in as ${shortIdentity(identity.identity.arn)}${activeProfile === null ? '' : ` (${activeProfile})`}`,
					);
				} else {
					ui.warn(`still failing after login: ${identity.message}`);
				}
			} else if (activeProfile !== null) {
				ui.info(`the app is using profile ${activeProfile}; log in, then press Refresh in the UI`);
			}
		}

		// Install signal handlers before advertising Ctrl+C (or opening the UI).
		const stopped = io.waitForStop(child);
		if (options.open) io.openBrowser(url);
		ui.outro(`${url} (Ctrl+C to stop)`);

		const code = await stopped;
		ui.outro('stopped');
		return code;
	} catch (error) {
		if (!(error instanceof PromptCancelled)) throw error;
		// Ctrl+C at a prompt is a stop, not an answer to the question: shut the
		// server down and report it the same way a Ctrl+C at a running server does.
		ui.outro('stopped');
		return await stopServer(child);
	}
}

/**
 * Entry point used by `bin.ts`: runs the CLI and sets the exit code.
 *
 * A cancelled prompt that `run` did not convert into a stop still exits like an
 * interrupted process (130) instead of throwing "the prompt was cancelled" at
 * someone who just pressed Ctrl+C.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	try {
		process.exitCode = await run(argv);
	} catch (error) {
		if (!(error instanceof PromptCancelled)) throw error;
		process.exitCode = 130;
	}
}
