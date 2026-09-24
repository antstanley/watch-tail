import { describe, expect, it } from 'vitest';
import { TEXT_SIZES, TEXT_SIZE_STORAGE_KEY, parseTextSize } from './text-size';

describe('parseTextSize', () => {
	it('accepts every offered size', () => {
		for (const size of TEXT_SIZES) expect(parseTextSize(size.id)).toBe(size.id);
	});

	it('falls back to Default for missing or unknown values', () => {
		expect(parseTextSize(null)).toBe('default');
		expect(parseTextSize('')).toBe('default');
		expect(parseTextSize('gigantic')).toBe('default');
	});

	it('offers Default plus a larger option, in ascending order', () => {
		const ids = TEXT_SIZES.map((size) => size.id);
		expect(ids).toContain('default');
		expect(ids.indexOf('large')).toBeGreaterThan(ids.indexOf('default'));
		expect(ids.indexOf('xlarge')).toBeGreaterThan(ids.indexOf('large'));
	});

	it('namespaces its storage key like the other preferences', () => {
		expect(TEXT_SIZE_STORAGE_KEY.startsWith('watch-tail:')).toBe(true);
	});
});
