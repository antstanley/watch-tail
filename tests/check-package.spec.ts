import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	BUDGET,
	checkPackage,
	moduleImports,
	packageName,
	requiredFiles,
	type PackResult,
} from '../scripts/check-package.ts';
import { stripMappingComment, stripSourcemaps } from '../scripts/strip-sourcemaps.ts';

/** The entry points of a built package, for this manifest. */
const BUILT = ['build/index.js', 'build/handler.js', 'dist/cli/bin.js'];

/** A built pack result within budget, holding the entry points plus `files`. */
function pack(files: string[], sizes: Partial<PackResult> = {}): PackResult {
	const paths = [...new Set([...BUILT, ...files])];
	return {
		size: 100_000,
		unpackedSize: 1_000_000,
		entryCount: paths.length,
		files: paths.map((path) => ({ path, size: 1 })),
		...sizes,
	};
}

const manifest = {
	bin: { 'watch-tail': './dist/cli/bin.js', wt: './dist/cli/bin.js' },
	dependencies: { tmcp: '^1.0.0', '@aws-sdk/client-sts': '^3.0.0' },
	optionalDependencies: { '@duckdb/node-api': '^1.0.0' },
};

describe('moduleImports', () => {
	it('reads imports, side-effect imports and re-exports as Rollup emits them', () => {
		const source = [
			'import memoize from "memoize";',
			"import { a as b } from './chunk.js';",
			'import "./shims.js";',
			"export { c } from 'tmcp/tool';",
			"export * from 'star';",
			'import{d}from"minified"',
		].join('\n');
		expect(moduleImports(source)).toEqual([
			'memoize',
			'./chunk.js',
			'./shims.js',
			'tmcp/tool',
			'star',
			'minified',
		]);
	});

	it('finds imports a line-based scan would miss', () => {
		const source = [
			'import {',
			'\ta,',
			'\tb,',
			"} from 'multi-line';",
			"import{c}from'first';import{d}from'second';",
			"run();import e from 'after-code';",
			"const open = await import('dynamic');",
		].join('\n');
		expect(moduleImports(source)).toEqual([
			'multi-line',
			'first',
			'second',
			'after-code',
			'dynamic',
		]);
	});

	it('skips dynamic imports of computed names and import.meta', () => {
		const source = 'const m = await import(name);\nconst url = import.meta.url;';
		expect(moduleImports(source)).toEqual([]);
	});

	it('ignores specifier-like text in strings, templates and comments', () => {
		const source = [
			'const message = "import x from \'types\'";',
			'  // see import docs from "somewhere"',
			"/* import y from 'block' */",
			'const t = `',
			"import z from 'template';",
			'`;',
			'export const from = "not-a-module";',
		].join('\n');
		expect(moduleImports(source)).toEqual([]);
	});
});

describe('packageName', () => {
	it('names plain and scoped packages, including subpaths', () => {
		expect(packageName('valibot')).toBe('valibot');
		expect(packageName('tmcp/utils')).toBe('tmcp');
		expect(packageName('@aws-sdk/client-sts')).toBe('@aws-sdk/client-sts');
		expect(packageName('@tmcp/adapter-valibot/extra')).toBe('@tmcp/adapter-valibot');
	});

	it('skips relative, builtin and subpath-import specifiers', () => {
		for (const specifier of ['./a.js', '../b.js', '/abs.js', 'node:fs', 'fs', 'http', '#server']) {
			expect(packageName(specifier)).toBeNull();
		}
	});

	it('skips URL-style specifiers', () => {
		for (const specifier of [
			'https://x/y.js',
			'file:///a.js',
			'data:text/javascript,',
			'virtual:x',
		]) {
			expect(packageName(specifier)).toBeNull();
		}
	});
});

describe('requiredFiles', () => {
	it('lists the built server and each bin target once', () => {
		expect(requiredFiles(manifest)).toEqual(BUILT);
	});

	it('accepts a single-string bin', () => {
		expect(requiredFiles({ bin: 'cli.js' })).toEqual([
			'build/index.js',
			'build/handler.js',
			'cli.js',
		]);
	});
});

describe('checkPackage', () => {
	const sources: Record<string, string> = {
		'build/index.js': "import { handler } from './handler.js';\nimport 'node:fs';",
		'dist/cli/bin.js': "import { tool } from 'tmcp/tool';\nimport sts from '@aws-sdk/client-sts';",
		'build/server/archive.js': "import duck from '@duckdb/node-api';",
	};
	const read = (path: string) => sources[path] ?? '';

	it('passes a lean package that imports only what it declares', () => {
		expect(checkPackage(pack(Object.keys(sources)), manifest, read)).toEqual([]);
	});

	it('fails a package that has not been built, however small it is', () => {
		const unbuilt: PackResult = {
			size: 20_000,
			unpackedSize: 50_000,
			entryCount: 2,
			files: [
				{ path: 'README.md', size: 1 },
				{ path: 'package.json', size: 1 },
			],
		};
		expect(checkPackage(unbuilt, manifest, read)).toEqual([
			'build/index.js, build/handler.js, dist/cli/bin.js would not ship; run `pnpm build` first',
		]);
	});

	it('fails a package over either size budget', () => {
		const problems = checkPackage(
			pack([], { size: BUDGET.tarball + 1, unpackedSize: BUDGET.unpacked + 1 }),
			manifest,
			read,
		);
		expect(problems).toHaveLength(2);
		expect(problems[0]).toMatch(/^tarball is .* over the .* budget$/);
		expect(problems[1]).toMatch(/^unpacked size is .* over the .* budget$/);
	});

	it('fails when source maps or pre-compressed copies would ship', () => {
		const files = ['build/client/app.js.br', 'build/client/app.js.gz', 'build/index.js.map'];
		expect(checkPackage(pack(files), manifest, read)).toEqual([
			'3 source maps or pre-compressed files would ship, e.g. build/client/app.js.br',
		]);
	});

	it('names a shipped file that imports an undeclared package, once per package', () => {
		const leaky: Record<string, string> = {
			'build/server/key.js': "import memoize from 'memoize';",
			'build/server/other.js': "import memoize from 'memoize';\nimport x from 'layerchart';",
			'dist/cli/ui.js': "const open = await import('open');",
		};
		const problems = checkPackage(pack(Object.keys(leaky)), manifest, (path) => leaky[path] ?? '');
		expect(problems).toEqual([
			'build/server/key.js imports memoize, which is not a dependency',
			'build/server/other.js imports layerchart, which is not a dependency',
			'dist/cli/ui.js imports open, which is not a dependency',
		]);
	});

	it('reports a shipped script it cannot parse instead of skipping it', () => {
		const broken = (path: string) => (path === 'build/index.js' ? 'import {' : '');
		const problems = checkPackage(pack([]), manifest, broken);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/^build\/index\.js could not be parsed for imports: /);
	});

	it('does not read files that are not JavaScript', () => {
		const files = ['README.md', 'build/client/app.css', 'package.json'];
		const problems = checkPackage(pack(files), manifest, (path) => {
			if (!path.endsWith('.js')) throw new Error(`should not read ${path}`);
			return '';
		});
		expect(problems).toEqual([]);
	});
});

describe('stripSourcemaps', () => {
	let dir = '';
	afterEach(() => {
		if (dir !== '') rmSync(dir, { recursive: true, force: true });
	});

	it('drops the trailing mapping comment and reports when there was none', () => {
		expect(stripMappingComment('code();\n//# sourceMappingURL=a.js.map\n')).toBe('code();\n');
		expect(stripMappingComment('code();\n//# sourceMappingURL=a.js.map')).toBe('code();\n');
		expect(stripMappingComment('code();\n//@ sourceMappingURL=a.js.map\n')).toBe('code();\n');
		expect(stripMappingComment('code();\n')).toBeNull();
	});

	it('leaves the same text alone when it is not the trailing comment', () => {
		const inTemplate = 'const s = `\n//# sourceMappingURL=keep.js.map\nmore`;\nrun(s);\n';
		expect(stripMappingComment(inTemplate)).toBeNull();
		const endsInTemplate = 'const s = `\n//# sourceMappingURL=keep.js.map`;';
		expect(stripMappingComment(endsInTemplate)).toBeNull();
	});

	it('drops the trailing comment of a stylesheet', () => {
		const css = 'body{}\n/*# sourceMappingURL=app.css.map */\n';
		expect(stripMappingComment(css, true)).toBe('body{}\n');
		expect(stripMappingComment('body{}\n', true)).toBeNull();
	});

	it('deletes nested maps and unlinks their files, leaving other files alone', () => {
		dir = mkdtempSync(join(tmpdir(), 'strip-maps-'));
		mkdirSync(join(dir, 'server', 'chunks'), { recursive: true });
		writeFileSync(join(dir, 'index.js'), 'a();\n//# sourceMappingURL=index.js.map\n');
		writeFileSync(join(dir, 'index.js.map'), '{}');
		writeFileSync(join(dir, 'server', 'chunks', 'c.mjs'), 'c();\n//# sourceMappingURL=c.mjs.map\n');
		writeFileSync(join(dir, 'server', 'chunks', 'c.mjs.map'), '{}');
		writeFileSync(join(dir, 'app.css'), 'body{}\n/*# sourceMappingURL=app.css.map */');
		writeFileSync(join(dir, 'app.css.map'), '{}');
		writeFileSync(join(dir, 'robots.txt'), '//# sourceMappingURL=not-code\n');

		expect(stripSourcemaps(dir)).toBe(3);
		expect(readdirSync(dir, { recursive: true }).toSorted()).toEqual([
			'app.css',
			'index.js',
			'robots.txt',
			'server',
			join('server', 'chunks'),
			join('server', 'chunks', 'c.mjs'),
		]);
		expect(readFileSync(join(dir, 'index.js'), 'utf8')).toBe('a();\n');
		expect(readFileSync(join(dir, 'server', 'chunks', 'c.mjs'), 'utf8')).toBe('c();\n');
		expect(readFileSync(join(dir, 'app.css'), 'utf8')).toBe('body{}\n');
		expect(readFileSync(join(dir, 'robots.txt'), 'utf8')).toBe('//# sourceMappingURL=not-code\n');
	});
});
