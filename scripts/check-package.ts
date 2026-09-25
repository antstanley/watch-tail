#!/usr/bin/env node
/**
 * Checks the npm tarball before it ships: it must stay within its size budget,
 * carry no source maps or pre-compressed copies, and import at runtime only the
 * packages it declares.
 *
 * The budget exists because 0.5.0 tripled the package without anyone noticing
 * (layerchart compiled into the server build, plus maps and .gz/.br copies of
 * all of it). The import check exists because everything the UI uses is bundled
 * into `build/`, so a package can move to devDependencies only when no shipped
 * file still imports it, or anything it drags in.
 *
 * Run after `pnpm build`; `--ignore-scripts` keeps `npm pack` from rebuilding.
 *
 * Usage:
 *   node scripts/check-package.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

/** Budgets in bytes, as npm reports them. Raise them deliberately, not to get CI green. */
export const BUDGET = { tarball: 600_000, unpacked: 2_000_000 };

/** Files that must never ship: source maps and pre-compressed copies. */
const FORBIDDEN = /\.(?:map|gz|br)$/;

export type PackFile = { path: string; size: number };

/** The parts of `npm pack --json` this check reads. */
export type PackResult = {
	size: number;
	unpackedSize: number;
	entryCount: number;
	files: PackFile[];
};

export type Manifest = {
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

/**
 * Module specifiers of the static imports and re-exports in `source`.
 *
 * Only statements that start a line are read, which is how Rollup emits them;
 * this keeps strings and comments inside bundled code from matching.
 */
export function staticImports(source: string): string[] {
	const pattern = /^[ \t]*(?:import|export)\b(?:[^'"\n;]*?\bfrom)?[ \t]*['"]([^'"\n]+)['"]/gm;
	return [...source.matchAll(pattern)].map((match) => match[1]);
}

/** The package a bare specifier resolves to, or `null` for relative, builtin or `#` imports. */
export function packageName(specifier: string): string | null {
	if (/^(?:\.|\/|#|node:|data:)/.test(specifier)) return null;
	const parts = specifier.split('/');
	const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
	return builtinModules.includes(name) ? null : name;
}

const kb = (bytes: number) => `${(bytes / 1000).toFixed(0)} kB`;

/** Every problem with the packed tarball; empty when it is fit to ship. */
export function checkPackage(
	pack: PackResult,
	manifest: Manifest,
	readShipped: (path: string) => string,
): string[] {
	const problems: string[] = [];
	if (pack.size > BUDGET.tarball) {
		problems.push(`tarball is ${kb(pack.size)}, over the ${kb(BUDGET.tarball)} budget`);
	}
	if (pack.unpackedSize > BUDGET.unpacked) {
		problems.push(
			`unpacked size is ${kb(pack.unpackedSize)}, over the ${kb(BUDGET.unpacked)} budget`,
		);
	}

	const forbidden = pack.files.filter((file) => FORBIDDEN.test(file.path));
	if (forbidden.length > 0) {
		problems.push(
			`${String(forbidden.length)} source maps or pre-compressed files would ship, e.g. ${forbidden[0].path}`,
		);
	}

	const declared = new Set(
		[manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies].flatMap(
			(deps) => Object.keys(deps ?? {}),
		),
	);
	const undeclared = new Map<string, string>();
	for (const file of pack.files) {
		if (!/\.[cm]?js$/.test(file.path)) continue;
		for (const specifier of staticImports(readShipped(file.path))) {
			const name = packageName(specifier);
			if (name !== null && !declared.has(name) && !undeclared.has(name)) {
				undeclared.set(name, file.path);
			}
		}
	}
	for (const [name, path] of undeclared) {
		problems.push(`${path} imports ${name}, which is not a dependency`);
	}
	return problems;
}

function main(): number {
	const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
		encoding: 'utf8',
	});
	const [pack] = JSON.parse(output) as PackResult[];
	const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest;
	const problems = checkPackage(pack, manifest, (path) => readFileSync(path, 'utf8'));

	console.log(
		`watch-tail package: ${kb(pack.size)} packed (budget ${kb(BUDGET.tarball)}), ` +
			`${kb(pack.unpackedSize)} unpacked (budget ${kb(BUDGET.unpacked)}), ` +
			`${String(pack.entryCount)} files`,
	);
	for (const problem of problems) console.error(`✗ ${problem}`);
	return problems.length === 0 ? 0 : 1;
}

// Type-stripped by Node: the guard keeps `import` in tests from running main.
if (process.argv[1] !== undefined && process.argv[1].endsWith('check-package.ts')) {
	process.exitCode = main();
}
