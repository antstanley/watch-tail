import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	BUDGET,
	checkPackage,
	packageName,
	staticImports,
	type PackResult,
} from '../scripts/check-package.ts';
import { stripMappingComment, stripSourcemaps } from '../scripts/strip-sourcemaps.ts';

/** A pack result within budget, holding the given files. */
function pack(files: string[], sizes: Partial<PackResult> = {}): PackResult {
	return {
		size: 100_000,
		unpackedSize: 1_000_000,
		entryCount: files.length,
		files: files.map((path) => ({ path, size: 1 })),
		...sizes,
	};
}

const manifest = {
	dependencies: { tmcp: '^1.0.0', '@aws-sdk/client-sts': '^3.0.0' },
	optionalDependencies: { '@duckdb/node-api': '^1.0.0' },
};

describe('staticImports', () => {
	it('reads imports, side-effect imports and re-exports as Rollup emits them', () => {
		const source = [
			'import memoize from "memoize";',
			"import { a as b } from './chunk.js';",
			'import "./shims.js";',
			"export { c } from 'tmcp/tool';",
			'import{d}from"minified"',
		].join('\n');
		expect(staticImports(source)).toEqual([
			'memoize',
			'./chunk.js',
			'./shims.js',
			'tmcp/tool',
			'minified',
		]);
	});

	it('ignores specifier-like text that is not an import statement', () => {
		const source = [
			'const message = "import x from \'types\'";',
			'  // see import docs from "somewhere"',
			'export const from = "not-a-module";',
		].join('\n');
		expect(staticImports(source)).toEqual([]);
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
		};
		const problems = checkPackage(pack(Object.keys(leaky)), manifest, (path) => leaky[path]);
		expect(problems).toEqual([
			'build/server/key.js imports memoize, which is not a dependency',
			'build/server/other.js imports layerchart, which is not a dependency',
		]);
	});

	it('does not read files that are not JavaScript', () => {
		const files = ['README.md', 'build/client/app.css', 'package.json'];
		const problems = checkPackage(pack(files), manifest, () => {
			throw new Error('should not read');
		});
		expect(problems).toEqual([]);
	});
});

describe('stripSourcemaps', () => {
	let dir = '';
	afterEach(() => {
		if (dir !== '') rmSync(dir, { recursive: true, force: true });
	});

	it('drops the mapping comment and reports when there was none', () => {
		expect(stripMappingComment('code();\n//# sourceMappingURL=a.js.map\n')).toBe('code();\n');
		expect(stripMappingComment('code();\n//# sourceMappingURL=a.js.map')).toBe('code();\n');
		expect(stripMappingComment('code();\n')).toBeNull();
	});

	it('deletes nested maps and unlinks their scripts, leaving other files alone', () => {
		dir = mkdtempSync(join(tmpdir(), 'strip-maps-'));
		mkdirSync(join(dir, 'server', 'chunks'), { recursive: true });
		writeFileSync(join(dir, 'index.js'), 'a();\n//# sourceMappingURL=index.js.map\n');
		writeFileSync(join(dir, 'index.js.map'), '{}');
		writeFileSync(join(dir, 'server', 'chunks', 'c.js'), 'c();\n//# sourceMappingURL=c.js.map\n');
		writeFileSync(join(dir, 'server', 'chunks', 'c.js.map'), '{}');
		writeFileSync(join(dir, 'app.css'), 'body{}');

		expect(stripSourcemaps(dir)).toBe(2);
		expect(readdirSync(dir, { recursive: true }).toSorted()).toEqual([
			'app.css',
			'index.js',
			'server',
			join('server', 'chunks'),
			join('server', 'chunks', 'c.js'),
		]);
		expect(readFileSync(join(dir, 'index.js'), 'utf8')).toBe('a();\n');
		expect(readFileSync(join(dir, 'server', 'chunks', 'c.js'), 'utf8')).toBe('c();\n');
	});
});
