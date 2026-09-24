import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textSize } from './text-size.svelte';
import { TEXT_SIZE_STORAGE_KEY } from './text-size';

beforeEach(() => localStorage.clear());
afterEach(() => {
	delete document.documentElement.dataset.textSize;
	vi.restoreAllMocks();
});

describe('textSize preference', () => {
	it('marks the document and mirrors the measured root font size', () => {
		vi.spyOn(window, 'getComputedStyle').mockReturnValue({
			fontSize: '20px',
		} as CSSStyleDeclaration);

		textSize.apply('large', false);

		expect(document.documentElement.dataset.textSize).toBe('large');
		expect(textSize.rootFontPx).toBe(20);
	});

	it('keeps the base root font size when the browser cannot be measured', () => {
		vi.spyOn(window, 'getComputedStyle').mockReturnValue({
			fontSize: '',
		} as CSSStyleDeclaration);

		textSize.apply('xlarge', false);

		expect(textSize.rootFontPx).toBe(16);
	});

	it('persists the choice and normalises an unknown one', () => {
		textSize.apply('large');
		expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe('large');

		textSize.apply('obsolete');
		expect(document.documentElement.dataset.textSize).toBe('default');
		expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe('default');
	});
});
