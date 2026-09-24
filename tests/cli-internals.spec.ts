import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PROGRAM, SHELLS, completionScript } from '../src/cli/completions.ts';
import { ambientProfile, readVersion, resolveCliRegion, type CliIo } from '../src/cli/index.ts';
import { browserCommand, findAppRoot } from '../src/cli/server.ts';
import manifest from '../package.json' with { type: 'json' };
import { describeArchive, readArchive } from '../src/cli/preflight.ts';
import type { ArchiveStatusResponse } from '../src/lib/types.ts';
import { defaults } from '../src/cli/options.ts';

const created: string[] = [];

/** Creates a throwaway directory tree. */
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'watch-tail-'));
	created.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('findAppRoot', () => {
	it('walks up to the directory that holds the built server', () => {
		const rootDir = tempDir();
		mkdirSync(join(rootDir, 'build'), { recursive: true });
		mkdirSync(join(rootDir, 'dist', 'cli'), { recursive: true });
		writeFileSync(join(rootDir, 'build', 'index.js'), '');
		writeFileSync(join(rootDir, 'package.json'), '{"name":"watch-tail"}');

		expect(findAppRoot(join(rootDir, 'dist', 'cli'))).toBe(rootDir);
	});

	it('returns null when the app was never built', () => {
		expect(findAppRoot(tempDir())).toBeNull();
	});
});

describe('browserCommand', () => {
	it('uses the platform opener', () => {
		expect(browserCommand('http://localhost:4517', 'darwin')).toEqual({
			command: 'open',
			args: ['http://localhost:4517'],
		});
		expect(browserCommand('http://localhost:4517', 'win32').command).toBe('cmd');
		expect(browserCommand('http://localhost:4517', 'linux')).toEqual({
			command: 'xdg-open',
			args: ['http://localhost:4517'],
		});
	});
});

describe('readVersion', () => {
	it('reads the manifest next to the app root', () => {
		const appRoot = tempDir();
		writeFileSync(join(appRoot, 'package.json'), '{"name":"watch-tail","version":"9.9.9"}');
		expect(readVersion(appRoot)).toBe('9.9.9');
	});

	it('falls back when there is no manifest', () => {
		expect(readVersion(null)).toBe('0.0.0');
		expect(readVersion(tempDir())).toBe('0.0.0');
	});
});

/** Minimal io for {@link resolveCliRegion}. */
function regionIo(env: NodeJS.ProcessEnv, configText = ''): CliIo {
	return {
		stdout: () => undefined,
		stderr: () => undefined,
		env,
		interactive: false,
		readProfiles: () => [],
		readConfigText: () => configText,
		appRoot: null,
		version: '0.0.0',
		openBrowser: () => undefined,
		readCredentialsText: () => '',
		readLocalEnvValues: () => ({}),
		probeCredentials: async () => ({ ok: true }),
		runLogin: async () => 0,
		readIdentity: async () => ({ ok: false, message: 'unavailable' }),
		readArchive: async () => ({ ok: false, message: 'unavailable' }),
		waitForHealth: async () => true,
		startServerImpl: (() => {
			throw new Error('not used');
		}) as CliIo['startServerImpl'],
		stopServerImpl: (async () => 0) as CliIo['stopServerImpl'],
		findFreePort: async () => 4519,
		serveMcp: (async () => undefined) as CliIo['serveMcp'],
		stdin: { async *[Symbol.asyncIterator]() {} },
		mcpStdout: { write: () => true },
		agentFs: {
			home: '/home/dev',
			platform: 'linux',
			cwd: '/work',
			exists: () => false,
			commandExists: () => false,
			readFile: () => '',
			writeFile: () => undefined,
			ensureDir: () => undefined,
		},
		spawnImpl: (() => {
			throw new Error('not used');
		}) as CliIo['spawnImpl'],
		waitForStop: async () => 0,
	};
}

describe('resolveCliRegion', () => {
	it('prefers the flag, then the environment, then the profile', () => {
		const config = '[profile acme]\nregion = eu-central-1\n';

		expect(
			resolveCliRegion(
				{ ...defaults(), region: 'ap-south-1', profile: 'acme' },
				regionIo({}, config),
			),
		).toBe('ap-south-1');
		expect(
			resolveCliRegion(
				{ ...defaults(), profile: 'acme' },
				regionIo({ AWS_REGION: 'us-west-2' }, config),
			),
		).toBe('us-west-2');
		expect(resolveCliRegion({ ...defaults(), profile: 'acme' }, regionIo({}, config))).toBe(
			'eu-central-1',
		);
	});

	it('defaults a local emulator run to the seeded region', () => {
		expect(
			resolveCliRegion({ ...defaults(), endpoint: 'http://localhost:4566' }, regionIo({})),
		).toBe('us-east-1');
	});

	it('leaves the region unset when nothing resolves for real AWS', () => {
		expect(resolveCliRegion(defaults(), regionIo({}))).toBeNull();
	});
});

describe('shell completions', () => {
	it('offers the supported shells and program name', () => {
		expect([...SHELLS]).toEqual(['zsh', 'bash', 'fish', 'powershell']);
		expect(PROGRAM).toBe('watch-tail');
	});

	it('prints a script that knows the program name', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		completionScript('zsh');
		const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
		log.mockRestore();

		expect(printed).toContain('watch-tail');
		expect(printed.length).toBeGreaterThan(100);
	});
});

describe('package manifest', () => {
	it('installs the CLI under both names', () => {
		expect(Object.keys(manifest.bin).toSorted()).toEqual(['watch-tail', 'wt']);
		for (const target of Object.values(manifest.bin)) {
			expect(target).toBe('./dist/cli/bin.js');
		}
	});
});

describe('ambientProfile', () => {
	it('reads AWS_PROFILE, trimming and treating blanks as absent', () => {
		expect(ambientProfile({ AWS_PROFILE: 'acme-prod' })).toBe('acme-prod');
		expect(ambientProfile({ AWS_PROFILE: '  acme-prod  ' })).toBe('acme-prod');
		expect(ambientProfile({ AWS_PROFILE: '' })).toBeNull();
		expect(ambientProfile({ AWS_PROFILE: '   ' })).toBeNull();
		expect(ambientProfile({})).toBeNull();
	});
});

/** Status payload double, at module scope so it is not rebuilt per test. */
const status = (overrides: Partial<ArchiveStatusResponse> = {}): ArchiveStatusResponse => ({
	path: '/home/dev/.local/share/watch-tail/archive.duckdb',
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

describe('the local history status', () => {
	it('describes a usable archive with its count and path', () => {
		expect(describeArchive(status({ rows: 1234 }))).toBe(
			'history 1,234 events at /home/dev/.local/share/watch-tail/archive.duckdb',
		);
		expect(describeArchive(status({ rows: 1 }))).toContain('1 event at');
	});

	it('says so when the archive is empty', () => {
		expect(describeArchive(status())).toContain('no events yet');
	});

	it('reports why an unavailable archive is unavailable', () => {
		expect(
			describeArchive(status({ available: false, error: 'Cannot find module @duckdb/node-api' })),
		).toBe('local history unavailable: Cannot find module @duckdb/node-api');
		expect(describeArchive(status({ available: false, error: null }))).toContain(
			'unavailable: unknown reason',
		);
	});

	it('readArchive returns the payload from /api/archive', async () => {
		const fetchImpl = (async (input: unknown) => {
			expect(String(input)).toBe('http://127.0.0.1:4517/api/archive');
			return new Response(JSON.stringify(status({ rows: 7 })), { status: 200 });
		}) as unknown as typeof fetch;
		expect(await readArchive({ baseUrl: 'http://127.0.0.1:4517', fetchImpl })).toEqual({
			ok: true,
			status: status({ rows: 7 }),
		});
	});

	it('readArchive reports a failure instead of throwing', async () => {
		const badStatus = (async () =>
			new Response('nope', { status: 500 })) as unknown as typeof fetch;
		expect(await readArchive({ baseUrl: 'http://localhost:1', fetchImpl: badStatus })).toEqual({
			ok: false,
			message: 'HTTP 500',
		});
		const rejects = (async () => {
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch;
		const failed = await readArchive({ baseUrl: 'http://localhost:1', fetchImpl: rejects });
		expect(failed.ok).toBe(false);
		expect(failed.ok ? '' : failed.message).toContain('ECONNREFUSED');
	});
});
