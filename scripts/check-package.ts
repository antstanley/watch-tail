#!/usr/bin/env node
/**
 * Checks the npm tarball before it ships: it must hold a built app and CLI, stay
 * within its size budget, carry no source maps or pre-compressed copies, and
 * import at runtime only the packages it declares.
 *
 * The budget exists because 0.5.0 tripled the package without anyone noticing
 * (layerchart compiled into the server build, plus maps and .gz/.br copies of
 * all of it). The import check exists because everything the UI uses is bundled
 * into `build/`, so a package can move to devDependencies only when no shipped
 * file still imports it, or anything it drags in.
 *
 * Run after `pnpm build`; `--ignore-scripts` keeps `npm pack` from rebuilding,
 * which is also why a missing build fails the check instead of shrinking it.
 *
 * Usage:
 *   node scripts/check-package.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { initSync, parse } from 'es-module-lexer';

/** Budgets in bytes, as npm reports them. Raise them deliberately, not to get CI green. */
export const BUDGET = { tarball: 600_000, unpacked: 2_000_000 };

/** Files that must never ship: source maps and pre-compressed copies. */
const FORBIDDEN = /\.(?:map|gz|br)$/;

/** Entry points of a built package, besides the `bin` targets: the server the CLI starts. */
const REQUIRED = ['build/index.js', 'build/handler.js'];

export type PackFile = { path: string; size: number };

/** The parts of `npm pack --json` this check reads. */
export type PackResult = {
	size: number;
	unpackedSize: number;
	entryCount: number;
	files: PackFile[];
};

export type Manifest = {
	bin?: string | Record<string, string>;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

/**
 * Module specifiers `source` imports: static imports, re-exports, and dynamic
 * `import()` calls with a literal string. A dynamic import of a computed name
 * (such as the optional DuckDB driver) cannot be resolved here and is skipped.
 *
 * es-module-lexer tokenises the module, so imports on any line or several to a
 * line are found, and text in strings and comments is not mistaken for one.
 */
export function moduleImports(source: string): string[] {
	initSync();
	const [imports] = parse(source);
	return imports.flatMap((entry) => (entry.n === undefined ? [] : [entry.n]));
}

/**
 * The package a bare specifier resolves to, or `null` for relative paths, `#`
 * subpath imports, builtins and URL-style specifiers (`node:`, `data:`,
 * `https:`, `file:`, ...).
 */
export function packageName(specifier: string): string | null {
	if (/^(?:\.|\/|#|[a-z][a-z0-9+.-]*:)/i.test(specifier)) return null;
	const parts = specifier.split('/');
	const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
	return builtinModules.includes(name) ? null : name;
}

const kb = (bytes: number) => `${(bytes / 1000).toFixed(0)} kB`;

/** Files the package must contain: the built server plus every `bin` target. */
export function requiredFiles(manifest: Manifest): string[] {
	const bin = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
	return [...new Set([...REQUIRED, ...bin.map((path) => path.replace(/^\.\//, ''))])];
}

/** Every problem with the packed tarball; empty when it is fit to ship. */
export function checkPackage(
	pack: PackResult,
	manifest: Manifest,
	readShipped: (path: string) => string,
): string[] {
	const problems: string[] = [];
	const shipped = new Set(pack.files.map((file) => file.path));
	const missing = requiredFiles(manifest).filter((path) => !shipped.has(path));
	if (missing.length > 0) {
		problems.push(`${missing.join(', ')} would not ship; run \`pnpm build\` first`);
	}
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
		let specifiers: string[];
		try {
			specifiers = moduleImports(readShipped(file.path));
		} catch (error) {
			problems.push(`${file.path} could not be parsed for imports: ${String(error)}`);
			continue;
		}
		for (const specifier of specifiers) {
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
