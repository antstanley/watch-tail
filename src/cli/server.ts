/**
 * Process management for the CLI: locate the built SvelteKit server, start it
 * with the resolved environment, wait until it answers, and open the browser.
 *
 * Every value that can be computed without side effects is a separate pure
 * helper so it can be unit tested.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the adapter-node server lives inside the package. */
const SERVER_ENTRY = join('build', 'index.js');

/**
 * How long the server may wait for open connections when it stops, in seconds.
 *
 * The app ends its own event streams when it is asked to stop, so its graceful
 * shutdown normally completes at once; this is the outer bound for anything else
 * that is still connected. adapter-node's default is thirty seconds, which is
 * what made a Ctrl+C look like it had not stopped the server.
 */
export const SHUTDOWN_TIMEOUT_SECONDS = 2;

/**
 * Walks up from the compiled CLI file until it finds `build/index.js`.
 *
 * Works both from `dist/cli/` in an installed package and from `src/cli/` in
 * the repository, and returns `null` when the app has not been built yet.
 */
export function findAppRoot(startDir: string, levels = 4): string | null {
	let current = resolve(startDir);
	for (let depth = 0; depth <= levels; depth += 1) {
		if (existsSync(join(current, SERVER_ENTRY)) && existsSync(join(current, 'package.json'))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

/** App root as seen from this module. */
export function appRootFromHere(metaUrl: string = import.meta.url): string | null {
	return findAppRoot(dirname(fileURLToPath(metaUrl)));
}

/** The URL the UI is served on, as a user would type it. */
export function uiUrl(host: string, port: number): string {
	const display = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
	return `http://${display}:${port}`;
}

/** Health endpoint used to detect readiness. */
export function healthUrl(baseUrl: string): string {
	return new URL('/api/health', baseUrl).toString();
}

/**
 * Asks the operating system for a free TCP port on `host`.
 *
 * The MCP server runs a private watch-tail on a port of its own, and several
 * agents can each start one, so a fixed port would collide. The socket is closed
 * before the port is handed back: the gap is small and the health check catches
 * the rare race.
 */
export function findFreePort(host = '127.0.0.1'): Promise<number> {
	return new Promise<number>((resolvePort, reject) => {
		const probe = createServer();
		probe.once('error', (error) => {
			probe.close();
			reject(error);
		});
		probe.listen(0, host, () => {
			const address = probe.address();
			const port = typeof address === 'object' && address !== null ? address.port : 0;
			probe.close(() => {
				if (port > 0) resolvePort(port);
				else reject(new Error('the operating system did not return a free port'));
			});
		});
	});
}

/** Command that opens `url` in the platform browser. */
export function browserCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
): {
	command: string;
	args: string[];
} {
	if (platform === 'darwin') return { command: 'open', args: [url] };
	if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
	return { command: 'xdg-open', args: [url] };
}

export type StartServerInput = {
	/** Package root that contains `build/index.js`. */
	appRoot: string;
	/** Environment for the server, already resolved by the caller. */
	env: NodeJS.ProcessEnv;
	port: number;
	host: string;
	/** Let the server write to this terminal instead of hiding its output. */
	verbose?: boolean;
};

/** Starts the production server and returns its handle. */
export function startServer(input: StartServerInput): ChildProcess {
	const env: NodeJS.ProcessEnv = {
		...input.env,
		PORT: String(input.port),
		HOST: input.host,
		ORIGIN: uiUrl(input.host, input.port),
		SHUTDOWN_TIMEOUT: String(SHUTDOWN_TIMEOUT_SECONDS),
	};
	const child = spawn(process.execPath, [join(input.appRoot, SERVER_ENTRY)], {
		cwd: input.appRoot,
		env,
		// Never give the server a terminal descriptor. It starts while the CLI's
		// spinner owns raw mode; Node snapshots inherited terminal settings and
		// restores them on exit. A profile restart would therefore restore raw
		// mode behind the CLI's back and stop Ctrl+C from generating SIGINT.
		stdio: ['ignore', input.verbose === true ? 'pipe' : 'ignore', 'pipe'],
		shell: false,
	});
	// Forward output without sharing ownership of the terminal. The CLI alone
	// handles input, including in verbose mode; server errors remain visible.
	child.stdout?.pipe(process.stdout, { end: false });
	child.stderr?.pipe(process.stderr, { end: false });
	// The spinner can call process.exit() directly on Ctrl+C, before readiness
	// checks finish and before waitForStop installs its signal handlers.
	const stopOnExit = (): void => {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
	};
	process.once('exit', stopOnExit);
	child.once('close', () => process.off('exit', stopOnExit));
	return child;
}

/**
 * Polls `/api/health` until the server answers or the timeout expires.
 *
 * The endpoint reports the app's own state, so readiness does not depend on AWS
 * credentials being valid.
 */
export async function waitForHealth(
	url: string,
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		fetchImpl?: typeof fetch;
		signal?: AbortSignal;
	} = {},
): Promise<boolean> {
	const { timeoutMs = 20_000, intervalMs = 150, fetchImpl = fetch, signal } = options;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted === true) return false;
		try {
			const response = await fetchImpl(url, { signal: signal ?? AbortSignal.timeout(2000) });
			if (response.ok) return true;
		} catch {
			// Not up yet (or still compiling): keep polling.
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
	}
	return false;
}

/** Opens `url` in the browser, ignoring failures (headless machines). */
export function openBrowser(
	url: string,
	options: { platform?: NodeJS.Platform; spawnImpl?: typeof spawn } = {},
): void {
	const { platform = process.platform, spawnImpl = spawn } = options;
	const { command, args } = browserCommand(url, platform);
	try {
		const child = spawnImpl(command, args, { stdio: 'ignore', detached: true, shell: false });
		child.on('error', () => undefined);
		child.unref();
	} catch {
		// Opening a browser is a convenience, never a failure.
	}
}

/**
 * Stops the server: SIGTERM first, SIGKILL after `graceMs`.
 *
 * Resolves with the exit code the CLI should report.
 */
export function stopServer(child: ChildProcess, graceMs = 3000): Promise<number> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(child.exitCode ?? 0);
	}
	return new Promise<number>((resolveExit) => {
		const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
		timer.unref?.();
		child.once('close', (code, signal) => {
			clearTimeout(timer);
			resolveExit(code ?? (signal === null ? 0 : 130));
		});
		child.kill('SIGTERM');
	});
}
