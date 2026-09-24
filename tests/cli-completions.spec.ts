import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROGRAM, SHELLS, handleCompletion } from '../src/cli/completions.ts';

/** Runs a completion request and returns everything it printed. */
function complete(words: string[], profiles: string[] = []): string {
	let printed = '';
	const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
		printed += String(chunk);
		return true;
	});
	const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
		printed += `${args.map(String).join(' ')}\n`;
	});
	try {
		handleCompletion(words, { profiles });
	} finally {
		stdout.mockRestore();
		log.mockRestore();
	}
	return printed;
}

afterEach(() => vi.restoreAllMocks());

describe('completion protocol', () => {
	it('offers the root flags', () => {
		const output = complete(['--', '--']);
		for (const flag of [
			'--profile',
			'--region',
			'--endpoint',
			'--floci',
			'--port',
			'--host',
			'--open',
			'--no-open',
			'--print',
			'--list',
			'--verbose',
			'--help',
			'--version',
		]) {
			expect(output).toContain(flag);
		}
	});

	it('filters by the typed prefix', () => {
		const output = complete(['--', '--pro']);
		expect(output).toContain('--profile');
		expect(output).not.toContain('--region');
	});

	it('completes the region values', () => {
		const output = complete(['--', '--region=']);
		expect(output).toContain('us-east-1');
		expect(output).toContain('af-south-1');
	});

	it('completes the profile names the user actually has', () => {
		const output = complete(['--', '--profile='], ['default', 'acme-prod']);
		expect(output).toContain('acme-prod');
		expect(output).toContain('AWS profile');
	});

	it('completes the emulator endpoint and the default port', () => {
		expect(complete(['--', '--endpoint='])).toContain('http://localhost:4566');
		expect(complete(['--', '--port='])).toContain('4517');
	});

	it('offers the subcommands for a bare word', () => {
		const output = complete(['--', '']);
		expect(output).toContain('complete');
		expect(output).toContain('mcp');
	});

	it('offers the mcp init subcommand and its flags', () => {
		expect(complete(['--', 'mcp', ''])).toContain('init');
		const flags = complete(['--', 'mcp', '--']);
		for (const flag of ['--url', '--agent', '--yes', '--scope', '--command', '--args']) {
			expect(flags).toContain(flag);
		}
		expect(complete(['--', 'mcp', '--agent='])).toContain('cursor');
	});

	it('completes the shell names after `complete`', () => {
		const output = complete(['--', 'complete', '']);
		for (const shell of SHELLS) expect(output).toContain(shell);
	});

	it('prints a script for every supported shell', () => {
		for (const shell of SHELLS) {
			const output = complete([shell]);
			expect(output.length).toBeGreaterThan(100);
			expect(output).toContain(PROGRAM);
		}
	});

	it('ignores words that are not a completion request', () => {
		expect(handleCompletion([], {})).toBeNull();
		expect(handleCompletion(['nope'], {})).toBeNull();
	});
});
