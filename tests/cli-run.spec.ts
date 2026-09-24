import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { run, type CliIo } from '../src/cli/index.ts';
import { PromptCancelled, type Ui } from '../src/cli/ui.ts';
import type { startServer } from '../src/cli/server.ts';

/** Records everything the UI would have shown. */
function recorder(
	options: {
		confirm?: boolean[];
		choose?: (string | null)[];
		multi?: string[][];
		/** Which prompt the user cancels with Ctrl+C, if any. */
		cancel?: 'choose' | 'confirm' | 'multi';
	} = {},
): Ui & { lines: string[]; asked: string[]; choices: string[] } {
	const lines: string[] = [];
	const asked: string[] = [];
	const choices: string[] = [];
	const confirms = [...(options.confirm ?? [])];
	const chosen = [...(options.choose ?? [])];
	const multi = [...(options.multi ?? [])];
	const push = (text: string) => lines.push(text);
	return {
		choices,
		lines,
		asked,
		interactive: false,
		intro: push,
		outro: push,
		info: push,
		warn: (text) => lines.push(`warn: ${text}`),
		startSpinner: push,
		stopSpinner: push,
		failSpinner: push,
		choose: async (message, items, initial) => {
			asked.push(message);
			if (options.cancel === 'choose') throw new PromptCancelled();
			if (chosen.length > 0) return chosen.shift() as string | null;
			return initial ?? items[0]?.value ?? null;
		},
		multiChoose: async (message, items, initial) => {
			asked.push(message);
			if (options.cancel === 'multi') throw new PromptCancelled();
			if (multi.length > 0) return multi.shift() as string[];
			return initial ?? items.map((item) => item.value);
		},
		confirm: async (message) => {
			asked.push(message);
			if (options.cancel === 'confirm') throw new PromptCancelled();
			return confirms.length > 0 ? (confirms.shift() as boolean) : false;
		},
	};
}

type Harness = {
	io: Partial<CliIo>;
	ui: Ui & { lines: string[] };
	out: string[];
	err: string[];
	started: { env: NodeJS.ProcessEnv; port: number; host: string }[];
	opened: string[];
};

/** Builds a CLI harness with every side effect captured. */
function harness(overrides: Partial<CliIo> = {}): Harness {
	const ui = recorder();
	const out: string[] = [];
	const err: string[] = [];
	const started: Harness['started'] = [];
	const opened: string[] = [];
	const io: Partial<CliIo> = {
		stdout: (line) => out.push(line),
		stderr: (line) => err.push(line),
		// Explicit, so the advice does not depend on the CI platform (Linux has no
		// DISPLAY, which would add --remote).
		env: { PATH: '/usr/bin', AWS_CONFIG_FILE: '/nonexistent/config', WATCH_TAIL_HEADLESS: '0' },
		interactive: false,
		readProfiles: () => overrides.readProfiles?.() ?? ['default', 'acme-prod'],
		readConfigText: () =>
			overrides.readConfigText?.() ?? '[profile acme-prod]\nregion = eu-west-1\n',
		appRoot: '/tmp/watch-tail-app',
		version: '1.2.3',
		openBrowser: (url) => opened.push(url),
		readCredentialsText: () => overrides.readCredentialsText?.() ?? '',
		readLocalEnvValues: () => overrides.readLocalEnvValues?.() ?? {},
		probeCredentials: (input) =>
			(overrides.probeCredentials ?? (async () => ({ ok: true })))(input),
		runLogin: (command) => (overrides.runLogin ?? (async () => 0))(command),
		readIdentity: (input) =>
			(overrides.readIdentity ?? (async () => ({ ok: false, message: 'unavailable' })))(input),
		readArchive: (input) =>
			(overrides.readArchive ?? (async () => ({ ok: false, message: 'unavailable' })))(input),
		waitForHealth: async () => true,
		startServerImpl: ((input) => {
			started.push({ env: input.env, port: input.port, host: input.host });
			return {
				kill: () => true,
				exitCode: null,
				signalCode: null,
				once: (event: string, listener: () => void) => {
					if (event === 'close') setTimeout(listener, 0);
					return undefined;
				},
			} as unknown as ChildProcess;
		}) as typeof startServer,
		waitForStop: async () => 0,
		ui,
		...overrides,
	};
	return { io, ui, out, err, started, opened };
}

describe('run: informational modes', () => {
	it('prints usage for --help', async () => {
		const h = harness();
		expect(await run(['--help'], h.io)).toBe(0);
		expect(h.out.join('\n')).toContain('watch-tail');
		expect(h.err).toHaveLength(0);
	});

	it('prints the version', async () => {
		const h = harness();
		expect(await run(['--version'], h.io)).toBe(0);
		expect(h.out).toEqual(['1.2.3']);
	});

	it('lists profiles', async () => {
		const h = harness();
		expect(await run(['--list'], h.io)).toBe(0);
		expect(h.out).toEqual(['default', 'acme-prod']);
	});

	it('notes when no profiles exist', async () => {
		const h = harness({ readProfiles: () => [] });
		expect(await run(['--list'], h.io)).toBe(0);
		expect(h.err.join('\n')).toContain('No profiles found');
	});

	it('fails with exit 2 and usage on a bad flag', async () => {
		const h = harness();
		expect(await run(['--nope'], h.io)).toBe(2);
		expect(h.err[0]).toContain('nope');
		expect(h.err.join('\n')).toContain('Usage');
	});
});

describe('run: --print', () => {
	it('shows the AWS environment for a profile run', async () => {
		const h = harness();
		expect(await run(['--print', '--profile', 'acme-prod'], h.io)).toBe(0);
		const text = h.out.join('\n');
		expect(text).toContain('AWS_PROFILE=acme-prod');
		expect(text).toContain('AWS_ENDPOINT_URL=');
		expect(text).toContain('AWS_REGION=eu-west-1');
	});

	it('shows the emulator endpoint and credentials for --floci', async () => {
		const h = harness();
		expect(await run(['--print', '--floci'], h.io)).toBe(0);
		const text = h.out.join('\n');
		expect(text).toContain('AWS_ENDPOINT_URL=http://localhost:4566');
		expect(text).toContain('AWS_ACCESS_KEY_ID=test');
		expect(text).toContain('AWS_REGION=us-east-1');
	});
});

describe('run: serving', () => {
	it('starts the server, waits for health and opens the browser', async () => {
		const h = harness();
		expect(await run(['--port', '4600', '--profile', 'acme-prod'], h.io)).toBe(0);

		expect(h.started).toHaveLength(1);
		expect(h.started[0].port).toBe(4600);
		expect(h.started[0].host).toBe('127.0.0.1');
		expect(h.started[0].env.AWS_PROFILE).toBe('acme-prod');
		expect(h.opened).toEqual(['http://127.0.0.1:4600']);
		expect(h.ui.lines.join('\n')).toContain('http://127.0.0.1:4600');
	});

	it('does not open a browser with --no-open', async () => {
		const h = harness();
		await run(['--no-open'], h.io);
		expect(h.opened).toHaveLength(0);
	});

	it('warns when binding a non-loopback interface', async () => {
		const h = harness();
		await run(['--host', '0.0.0.0', '--no-open'], h.io);
		expect(h.ui.lines.join('\n')).toContain('warn: binding 0.0.0.0');
	});

	it('exits 1 when the app is not built', async () => {
		const h = harness({ appRoot: null });
		expect(await run([], h.io)).toBe(1);
		expect(h.err.join('\n')).toContain('pnpm build');
		expect(h.started).toHaveLength(0);
	});

	it('exits 1 and stops the server when it never answers', async () => {
		const killed: string[] = [];
		const h = harness({
			waitForHealth: async () => false,
			startServerImpl: ((input) => {
				void input;
				return {
					kill: (signal?: string) => {
						killed.push(signal ?? 'SIGTERM');
						return true;
					},
					exitCode: null,
					signalCode: null,
					once: (event: string, listener: () => void) => {
						if (event === 'close') setTimeout(listener, 0);
						return undefined;
					},
				} as unknown as ChildProcess;
			}) as typeof startServer,
		});

		expect(await run(['--no-open'], h.io)).toBe(1);
		expect(h.ui.lines.join('\n')).toContain('did not answer');
		await vi.waitFor(() => expect(killed.length).toBeGreaterThan(0));
	});
});

describe('run: completions', () => {
	it('prints a completion script for a shell', async () => {
		const h = harness();
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		expect(await run(['complete', 'zsh'], h.io)).toBe(0);
		const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
		log.mockRestore();
		expect(printed).toContain('watch-tail');
	});
});

/** Fake STS identity that starts broken and starts working once a login runs. */
function identityState(initial: 'broken' | 'works', loginFixes = true) {
	const state = { works: initial === 'works' };
	return {
		state,
		read: () =>
			state.works
				? {
						ok: true as const,
						identity: {
							arn: 'arn:aws:sts::111111111111:assumed-role/AWSResolvedSSO_Admin/me',
							account: '111111111111',
							userId: 'AROAEXAMPLE:me',
							region: 'af-south-1',
							endpoint: null,
						},
					}
				: { ok: false as const, code: 'missing-credentials', message: 'no usable credentials' },
		login: () => {
			if (loginFixes) state.works = true;
		},
	};
}

describe('run: credential preflight', () => {
	const SSO_CONFIG = '[profile acme-prod]\nsso_session = acme\nregion = eu-west-1\n';

	/** A harness whose first probe fails, then succeeds after a login. */
	function credentialHarness(options: {
		probeResults: Awaited<ReturnType<NonNullable<CliIo['probeCredentials']>>>[];
		answers?: boolean[];
		loginCode?: number;
		identity?: ReturnType<typeof identityState>;
	}) {
		const h = harness({
			readConfigText: () => SSO_CONFIG,
			ui: undefined,
		});
		const ui = recorder({ confirm: options.answers ?? [true] });
		let call = 0;
		const logins: string[][] = [];
		h.io.ui = ui;
		h.io.probeCredentials = async () => {
			const result = options.probeResults[Math.min(call, options.probeResults.length - 1)];
			call += 1;
			return result;
		};
		const identity = options.identity ?? identityState('broken');
		h.io.readIdentity = async () => identity.read();
		h.io.runLogin = async (command) => {
			logins.push(command);
			const code = options.loginCode ?? 0;
			if (code === 0) identity.login();
			return code;
		};
		return { ...h, ui, logins, identity, probeCalls: () => call };
	}

	const failure = {
		ok: false as const,
		code: 'missing-credentials',
		message:
			"The SSO session token associated with profile=acme-prod was not found or is invalid. To refresh this SSO session run 'aws sso login'",
		credentialProblem: true,
	};

	it('offers `aws sso login` for an SSO profile and retries after it succeeds', async () => {
		const h = credentialHarness({ probeResults: [failure, { ok: true }] });

		expect(await run(['--profile', 'acme-prod', '--no-open'], h.io)).toBe(0);

		expect(h.logins).toEqual([['sso', 'login', '--profile', 'acme-prod']]);
		expect(h.ui.asked.join(' ')).toContain('aws sso login --profile acme-prod');
		// the result is confirmed with STS rather than another log query
		expect(h.ui.lines.join('\n')).toContain('signed in as AWSResolvedSSO_Admin');
		expect(h.identity.state.works).toBe(true);
		expect(h.probeCalls()).toBe(1);
	});

	it('prints the command instead of running it when declined', async () => {
		const h = credentialHarness({ probeResults: [failure], answers: [false] });

		expect(await run(['--profile', 'acme-prod', '--no-open'], h.io)).toBe(0);

		expect(h.logins).toEqual([]);
		expect(h.ui.lines.join('\n')).toContain('run it yourself');
		expect(h.ui.lines.join('\n')).toContain('aws sso login --profile acme-prod');
	});

	it('reports a login that fails', async () => {
		const h = credentialHarness({ probeResults: [failure], loginCode: 1 });

		expect(await run(['--profile', 'acme-prod', '--no-open'], h.io)).toBe(0);

		expect(h.ui.lines.join('\n')).toContain('exited with code 1');
	});

	it('reports credentials that still fail after logging in', async () => {
		const h = credentialHarness({
			probeResults: [failure],
			identity: identityState('broken', false),
		});

		expect(await run(['--profile', 'acme-prod', '--no-open'], h.io)).toBe(0);

		expect(h.ui.lines.join('\n')).toContain('still failing after login: no usable credentials');
	});

	it('does not offer a login when the API fails for another reason', async () => {
		const h = credentialHarness({
			probeResults: [
				{ ok: false, code: 'unreachable', message: 'connection refused', credentialProblem: true },
			],
		});

		expect(await run([], h.io)).toBe(0);

		expect(h.ui.asked).toEqual([]);
		expect(h.ui.lines.join('\n')).toContain('could not list log groups');
	});

	it('adds --remote when there is no browser', async () => {
		const base = harness();
		const h = credentialHarness({ probeResults: [failure], answers: [true] });
		h.io.env = { ...base.io.env, WATCH_TAIL_HEADLESS: '1' };

		expect(await run(['--profile', 'acme-prod', '--no-open'], h.io)).toBe(0);

		expect(h.logins).toEqual([['sso', 'login', '--profile', 'acme-prod', '--remote']]);
	});

	it('skips the check entirely for an emulator endpoint', async () => {
		const h = credentialHarness({ probeResults: [failure] });

		expect(await run(['--floci', '--no-open'], h.io)).toBe(0);

		expect(h.probeCalls()).toBe(0);
		expect(h.ui.asked).toEqual([]);
	});
});

describe("run: the app's .env.local", () => {
	const LOCAL_ENV = {
		AWS_ENDPOINT_URL: 'http://localhost.floci.io:4566',
		AWS_ACCESS_KEY_ID: 'test',
		AWS_SECRET_ACCESS_KEY: 'test',
	};

	it('does not let a dev .env.local redirect a normal run at the emulator', async () => {
		const h = harness({ readLocalEnvValues: () => LOCAL_ENV });

		expect(await run(['--no-open'], h.io)).toBe(0);

		const env = h.started[0].env;
		expect(env.AWS_ENDPOINT_URL).toBe('');
		expect(env.AWS_ACCESS_KEY_ID).toBe('');
		expect(h.ui.lines.join('\n')).toContain('ignoring the emulator settings in .env.local');
	});

	it('keeps the emulator settings when --floci asks for them', async () => {
		const h = harness({ readLocalEnvValues: () => LOCAL_ENV });

		expect(await run(['--floci', '--no-open'], h.io)).toBe(0);

		const env = h.started[0].env;
		expect(env.AWS_ENDPOINT_URL).toBe('http://localhost:4566');
		expect(env.AWS_ACCESS_KEY_ID).toBe('test');
		expect(h.ui.lines.join('\n')).not.toContain('ignoring the emulator settings');
	});

	it('lets an exported variable win over the file', async () => {
		const h = harness({ readLocalEnvValues: () => LOCAL_ENV });
		h.io.env = { ...h.io.env, AWS_ENDPOINT_URL: 'http://localhost:9999' };

		await run(['--no-open'], h.io);

		expect(h.started[0].env.AWS_ENDPOINT_URL).toBe('http://localhost:9999');
	});

	it('says nothing when there is no .env.local', async () => {
		const h = harness();

		await run(['--no-open'], h.io);

		expect(h.ui.lines.join('\n')).not.toContain('ignoring the emulator settings');
	});
});

describe('run: choosing a profile when credentials fail', () => {
	const failure = {
		ok: false as const,
		code: 'missing-credentials',
		message: 'Your session has expired. Please reauthenticate.',
		credentialProblem: true,
	};
	const CONFIG = [
		'[default]',
		'region = us-west-1',
		'login_session = arn:aws:iam::111111111111:user/me',
		'',
		'[profile acme-prod]',
		'sso_session = acme',
		'region = eu-west-1',
		'',
	].join('\n');

	/** A run where the first probe fails and later probes depend on the profile. */
	function profileHarness(options: {
		choose?: (string | null)[];
		confirm?: boolean[];
		profiles?: string[];
		probes?: Awaited<ReturnType<NonNullable<CliIo['probeCredentials']>>>[];
		identity?: ReturnType<typeof identityState>;
	}) {
		const h = harness({
			readConfigText: () => CONFIG,
			readProfiles: () => options.profiles ?? ['default', 'acme-prod'],
		});
		const ui = recorder({ confirm: options.confirm ?? [true], choose: options.choose ?? [] });
		let call = 0;
		const logins: string[][] = [];
		h.io.ui = ui;
		h.io.probeCredentials = async () => {
			const results = options.probes ?? [failure, { ok: true }];
			const result = results[Math.min(call, results.length - 1)];
			call += 1;
			return result;
		};
		const identity = options.identity ?? identityState('broken');
		h.io.readIdentity = async () => identity.read();
		h.io.runLogin = async (command) => {
			logins.push(command);
			identity.login();
			return 0;
		};
		return { ...h, ui, logins, identity };
	}

	it('asks which profile to use and logs in with the one chosen', async () => {
		const h = profileHarness({ choose: ['acme-prod'] });

		expect(await run(['--no-open'], h.io)).toBe(0);

		expect(h.ui.asked.join(' ')).toContain('Which AWS profile');
		expect(h.logins).toEqual([['sso', 'login', '--profile', 'acme-prod']]);
		// the app is restarted so it actually runs as that profile
		expect(h.started).toHaveLength(2);
		expect(h.started[1].env.AWS_PROFILE).toBe('acme-prod');
		expect(h.ui.lines.join('\n')).toContain('signed in as AWSResolvedSSO_Admin (acme-prod)');
	});

	it('keeps the default profile when that is what the user picks', async () => {
		const h = profileHarness({ choose: ['default'] });

		expect(await run(['--no-open'], h.io)).toBe(0);

		expect(h.logins).toEqual([['login']]);
		expect(h.started).toHaveLength(1);
		expect(h.ui.lines.join('\n')).toContain('signed in as AWSResolvedSSO_Admin');
	});

	it('does not ask when only one profile exists', async () => {
		const h = profileHarness({ profiles: ['default'] });

		await run(['--no-open'], h.io);

		expect(h.ui.asked.join(' ')).not.toContain('Which AWS profile');
		expect(h.logins).toEqual([['login']]);
	});

	it('does not ask when the profile was given explicitly', async () => {
		const h = profileHarness({ profiles: ['default', 'acme-prod'] });

		await run(['--profile', 'acme-prod', '--no-open'], h.io);

		expect(h.ui.asked.join(' ')).not.toContain('Which AWS profile');
		expect(h.logins).toEqual([['sso', 'login', '--profile', 'acme-prod']]);
	});

	it('does not ask when AWS_PROFILE is set', async () => {
		const h = profileHarness({});
		h.io.env = { ...h.io.env, AWS_PROFILE: 'acme-prod' };

		await run(['--no-open'], h.io);

		expect(h.ui.asked.join(' ')).not.toContain('Which AWS profile');
		expect(h.logins).toEqual([['sso', 'login', '--profile', 'acme-prod']]);
	});

	it('reports a profile that still fails after logging in', async () => {
		const identity = identityState('broken', false);
		const h = profileHarness({ choose: ['acme-prod'], probes: [failure], identity });

		expect(await run(['--no-open'], h.io)).toBe(0);

		expect(h.ui.lines.join('\n')).toContain('still failing after login: no usable credentials');
	});
});

describe('run: declining the login after choosing a profile', () => {
	it('restarts with the chosen profile and says so, without claiming a failure', async () => {
		const failure = {
			ok: false as const,
			code: 'missing-credentials',
			message: 'Your session has expired. Please reauthenticate.',
			credentialProblem: true,
		};
		const h = harness({
			readConfigText: () => '[profile beyond-mzansi]\nregion = af-south-1\n',
			readProfiles: () => ['default', 'beyond-mzansi'],
		});
		const ui = recorder({ confirm: [false], choose: ['beyond-mzansi'] });
		let probes = 0;
		h.io.ui = ui;
		h.io.probeCredentials = async () => {
			probes += 1;
			return failure;
		};
		h.io.runLogin = async () => 0;

		expect(await run(['--no-open'], h.io)).toBe(0);

		expect(h.started).toHaveLength(2);
		// the chosen profile's own region, not the one from the previous run
		expect(h.started[1].env.AWS_PROFILE).toBe('beyond-mzansi');
		expect(h.started[1].env.AWS_REGION).toBe('af-south-1');
		// `ui` is the recorder this test installed; `h.ui` is the harness's own.
		expect(ui.lines.join('\n')).toContain('the app is using profile beyond-mzansi');
		expect(ui.lines.join('\n')).not.toContain('still failing');
		// declined: nothing is probed a second time
		expect(probes).toBe(1);
	});
});

describe('run: the chosen profile may already work', () => {
	const failure = {
		ok: false as const,
		code: 'missing-credentials',
		message: 'Your session has expired. Please reauthenticate.',
		credentialProblem: true,
	};
	const IDENTITY = {
		arn: 'arn:aws:sts::111111111111:assumed-role/AWSResolvedSSO_Admin/me',
		account: '111111111111',
		userId: 'AROAEXAMPLE:me',
		region: 'af-south-1',
		endpoint: null,
	};

	/** A failing probe plus a profile picker, with STS answering for the choice. */
	function harnessForIdentity(identity: Awaited<ReturnType<NonNullable<CliIo['readIdentity']>>>) {
		const h = harness({
			readConfigText: () => '[profile beyond-mzansi]\nsso_session = x\nregion = af-south-1\n',
			readProfiles: () => ['default', 'beyond-mzansi'],
			readIdentity: async () => identity,
		});
		const ui = recorder({ confirm: [true], choose: ['beyond-mzansi'] });
		h.io.ui = ui;
		h.io.probeCredentials = async () => failure;
		const logins: string[][] = [];
		h.io.runLogin = async (command) => {
			logins.push(command);
			return 0;
		};
		return { ...h, ui, logins };
	}

	it('skips the login when that profile already has usable credentials', async () => {
		const h = harnessForIdentity({ ok: true, identity: IDENTITY });

		expect(await run(['--no-open'], h.io)).toBe(0);

		expect(h.logins).toEqual([]);
		expect(h.ui.asked.join(' ')).not.toContain('Run `aws sso login');
		expect(h.ui.lines.join('\n')).toContain('already works (AWSResolvedSSO_Admin)');
		// and the app runs as that profile
		expect(h.started).toHaveLength(2);
		expect(h.started[1].env.AWS_PROFILE).toBe('beyond-mzansi');
	});

	it('offers the login when that profile has nothing usable', async () => {
		const h = harnessForIdentity({
			ok: false,
			code: 'missing-credentials',
			message: 'The SSO session token associated with profile=beyond-mzansi was not found',
		});

		expect(await run(['--no-open'], h.io)).toBe(0);

		expect(h.logins).toEqual([['sso', 'login', '--profile', 'beyond-mzansi']]);
		expect(h.ui.asked.join(' ')).toContain('aws sso login --profile beyond-mzansi');
		expect(h.ui.lines.join('\n')).not.toContain('already works');
	});
});

/** Status payload double, at module scope so it is not rebuilt per test. */
const status = (overrides: Record<string, unknown> = {}) => ({
	path: '/tmp/archive.duckdb',
	available: true,
	error: null,
	bytes: 1024,
	rows: 0,
	groups: 0,
	regions: 0,
	oldest: null,
	newest: null,
	...overrides,
});

describe('run: the local history archive', () => {
	it('tells the user where history is kept and how much there is', async () => {
		const h = harness({
			readArchive: async () => ({ ok: true, status: status({ rows: 1234 }) as never }),
		});
		expect(await run(['--no-open'], h.io)).toBe(0);
		const lines = h.ui.lines.join('\n');
		expect(lines).toContain('history 1,234 events at /tmp/archive.duckdb');
	});

	it('reports an empty archive without sounding broken', async () => {
		const h = harness({ readArchive: async () => ({ ok: true, status: status() as never }) });
		await run(['--no-open'], h.io);
		expect(h.ui.lines.join('\n')).toContain('no events yet');
	});

	it('warns when the archive is unavailable', async () => {
		const h = harness({
			readArchive: async () => ({
				ok: true,
				status: status({ available: false, error: 'Cannot find module @duckdb/node-api' }) as never,
			}),
		});
		await run(['--no-open'], h.io);
		expect(h.ui.lines.join('\n')).toContain(
			'warn: local history unavailable: Cannot find module @duckdb/node-api',
		);
	});

	it('warns when the app does not answer the archive question', async () => {
		const h = harness({
			readArchive: async () => ({ ok: false, message: 'ECONNREFUSED' }),
		});
		await run(['--no-open'], h.io);
		expect(h.ui.lines.join('\n')).toContain(
			'warn: could not read the local history status: ECONNREFUSED',
		);
	});

	it('does not ask about the archive with --no-archive', async () => {
		const asked: string[] = [];
		const h = harness({
			readArchive: async (input) => {
				asked.push(input.baseUrl);
				return { ok: true, status: status() as never };
			},
		});
		await run(['--no-open', '--no-archive'], h.io);
		expect(asked).toEqual([]);
		expect(h.ui.lines.join('\n')).toContain('local history off (--no-archive)');
	});

	it('passes the history settings to the server', async () => {
		const plain = harness();
		await run(['--no-open'], plain.io);
		expect(plain.started[0]?.env.WATCH_TAIL_ARCHIVE).toBe('');
		expect(plain.started[0]?.env.WATCH_TAIL_ARCHIVE_DB).toBe('');

		const custom = harness();
		await run(['--no-open', '--db', '/tmp/mine.duckdb'], custom.io);
		expect(custom.started[0]?.env.WATCH_TAIL_ARCHIVE_DB).toBe('/tmp/mine.duckdb');

		const off = harness();
		await run(['--no-open', '--no-archive'], off.io);
		expect(off.started[0]?.env.WATCH_TAIL_ARCHIVE).toBe('off');
	});

	it('prints the history settings with --print so a run is reproducible', async () => {
		const h = harness();
		expect(await run(['--print', '--db', '/tmp/mine.duckdb'], h.io)).toBe(0);
		const text = h.out.join('\n');
		expect(text).toContain('WATCH_TAIL_ARCHIVE_DB=/tmp/mine.duckdb');
		expect(text).toContain('WATCH_TAIL_ARCHIVE=');

		const hm = harness();
		await run(['--print', '--no-archive'], hm.io);
		expect(hm.out.join('\n')).toContain('WATCH_TAIL_ARCHIVE=off');
	});
});

describe('run: cancelling a prompt with Ctrl+C', () => {
	const FAILURE = {
		ok: false as const,
		code: 'missing-credentials',
		message: 'Your session has expired. Please reauthenticate.',
		credentialProblem: true,
	};

	/**
	 * Runs the CLI with credentials that fail, so it reaches a prompt, and with a
	 * user who presses Ctrl+C at that prompt.
	 */
	async function cancelAt(where: 'choose' | 'confirm'): Promise<{
		code: number;
		ui: Ui & { lines: string[] };
		kills: string[];
	}> {
		const h = harness({
			readConfigText: () => '[profile acme-prod]\nregion = eu-west-1\n',
			readProfiles: () => ['default', 'acme-prod'],
		});
		const ui = recorder({ cancel: where, choose: ['default'] });
		const kills: string[] = [];
		h.io.ui = ui;
		h.io.probeCredentials = async () => FAILURE;
		h.io.startServerImpl = ((input) => {
			h.started.push({ env: input.env, port: input.port, host: input.host });
			return {
				kill: (signal?: NodeJS.Signals) => {
					kills.push(signal ?? 'none');
					return true;
				},
				exitCode: null,
				signalCode: null,
				// A real server shuts down gracefully on SIGTERM: `close` arrives
				// with code 0 and no signal, which is what `stopServer` reports.
				once: (event: string, listener: (code: number | null, signal: string | null) => void) => {
					if (event === 'close') setTimeout(() => listener(0, null), 0);
				},
			} as unknown as ChildProcess;
		}) as typeof startServer;

		const code = await run(['--no-open'], h.io);
		return { code, ui, kills };
	}

	it('stops the server and reports the stop when the login question is cancelled', async () => {
		const { code, ui, kills } = await cancelAt('confirm');

		expect(code).toBe(0);
		expect(kills).toContain('SIGTERM');
		expect(ui.lines.join('\n')).toContain('stopped');
	});

	it('stops the server when the profile picker is cancelled', async () => {
		const { code, ui, kills } = await cancelAt('choose');

		expect(code).toBe(0);
		expect(kills).toContain('SIGTERM');
		expect(ui.lines.join('\n')).toContain('stopped');
	});

	it('never reports a cancelled prompt as a failure', async () => {
		const { code, ui } = await cancelAt('confirm');

		expect(code).toBe(0);
		expect(ui.lines.join('\n')).not.toContain('still failing');
	});
});

/** An `agentFs` double where Cursor and Codex are installed. */
function agentFs(): Partial<CliIo>['agentFs'] & { files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		home: '/home/dev',
		platform: 'linux',
		cwd: '/work/project',
		exists: (path) => path === '/home/dev/.cursor' || path === '/home/dev/.codex',
		commandExists: () => false,
		readFile: (path) => {
			const contents = files.get(path);
			if (contents === undefined) throw new Error('ENOENT');
			return contents;
		},
		writeFile: (path, contents) => files.set(path, contents),
		ensureDir: () => undefined,
	};
}

describe('run: the MCP entry points', () => {
	it('starts a private headless server for `mcp`', async () => {
		const h = harness();
		const stopped: string[] = [];
		const served: unknown[] = [];
		h.io.findFreePort = async () => 4601;
		h.io.stopServerImpl = (async () => {
			stopped.push('stop');
			return 0;
		}) as CliIo['stopServerImpl'];
		h.io.serveMcp = (async (options) => {
			served.push(options);
		}) as CliIo['serveMcp'];
		h.io.stdin = { async *[Symbol.asyncIterator]() {} };
		h.io.mcpStdout = { write: () => true };

		expect(await run(['mcp', '--profile', 'acme-prod'], h.io)).toBe(0);

		expect(h.started).toHaveLength(1);
		expect(h.started[0]?.port).toBe(4601);
		expect(h.started[0]?.env.AWS_PROFILE).toBe('acme-prod');
		// The private server lets go of the archive between tool calls.
		expect(h.started[0]?.env.WATCH_TAIL_ARCHIVE_IDLE_MS).toBe('5000');
		expect(served).toHaveLength(1);
		expect(stopped).toHaveLength(1);
	});

	it('writes detected agents for `mcp init --yes`', async () => {
		const h = harness();
		const fs = agentFs();
		h.io.agentFs = fs;

		expect(await run(['mcp', 'init', '--yes'], h.io)).toBe(0);
		expect([...fs.files.keys()].toSorted()).toEqual([
			'/home/dev/.codex/config.toml',
			'/home/dev/.cursor/mcp.json',
		]);
		expect(h.err).toHaveLength(0);
	});

	it('prints the configuration for `mcp init --print` without writing', async () => {
		const h = harness();
		const fs = agentFs();
		h.io.agentFs = fs;

		expect(await run(['mcp', 'init', '--print'], h.io)).toBe(0);
		expect(fs.files.size).toBe(0);
		expect(h.out.join('\n')).toContain('watch-tail@1.2.3');
	});

	it('writes only the agent the user selects', async () => {
		const h = harness();
		const fs = agentFs();
		h.io.agentFs = fs;
		h.io.ui = recorder({ multi: [['codex']] });

		expect(await run(['mcp', 'init'], h.io)).toBe(0);
		expect([...fs.files.keys()]).toEqual(['/home/dev/.codex/config.toml']);
	});

	it('reports an unknown agent id with exit code 2', async () => {
		const h = harness();
		h.io.agentFs = agentFs();

		expect(await run(['mcp', 'init', '--agent', 'nope', '--yes'], h.io)).toBe(2);
		expect(h.err.join('\n')).toContain('unknown agent');
	});

	it('turns a cancelled agent picker into a stop, not a failure', async () => {
		const h = harness();
		const fs = agentFs();
		h.io.agentFs = fs;
		h.io.ui = recorder({ cancel: 'multi' });

		expect(await run(['mcp', 'init'], h.io)).toBe(130);
		expect(fs.files.size).toBe(0);
	});
});
