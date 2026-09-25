#!/usr/bin/env node
/**
 * Removes the source maps adapter-node writes into `build/`.
 *
 * adapter-node hard-codes `sourcemap: true`, and its maps point at the
 * intermediate `.svelte-kit/output` code rather than `src/`, so they help little
 * while making up over half of the npm package. This deletes every `.map` file
 * and the `sourceMappingURL` comment that would otherwise point at it.
 *
 * Usage:
 *   node scripts/strip-sourcemaps.ts [dir]   # defaults to build/
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Drops `//# sourceMappingURL=` lines; returns `null` when there is none. */
export function stripMappingComment(source: string): string | null {
	const stripped = source.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, '');
	return stripped === source ? null : stripped;
}

/** Deletes maps under `dir` and unlinks them from their scripts; returns the count removed. */
export function stripSourcemaps(dir: string): number {
	let removed = 0;
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		if (entry.name.endsWith('.map')) {
			rmSync(path);
			removed++;
		} else if (/\.[cm]?js$/.test(entry.name)) {
			const stripped = stripMappingComment(readFileSync(path, 'utf8'));
			if (stripped !== null) writeFileSync(path, stripped);
		}
	}
	return removed;
}

// Type-stripped by Node: the guard keeps `import` in tests from running main.
if (process.argv[1] !== undefined && process.argv[1].endsWith('strip-sourcemaps.ts')) {
	const dir = process.argv[2] ?? 'build';
	console.log(`removed ${String(stripSourcemaps(dir))} source maps from ${dir}/`);
}
