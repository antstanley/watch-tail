import { describe, expect, test } from 'vitest';
import {
	PREFIX_WIDTH,
	RESIZE_STEP_PX,
	SIDEBAR_WIDTH,
	STORAGE_KEYS,
	clampWidth,
	parseStoredWidth,
	pxToRem,
	remToPx,
	widthFromKey,
	widthFromPointer,
} from './resize';

describe('clampWidth', () => {
	test('clamps into range', () => {
		expect(clampWidth(10, 4, 40)).toBe(10);
		expect(clampWidth(2, 4, 40)).toBe(4);
		expect(clampWidth(99, 4, 40)).toBe(40);
	});

	test('handles inverted bounds and non-finite values', () => {
		expect(clampWidth(10, 40, 4)).toBe(10);
		expect(clampWidth(Number.NaN, 4, 40)).toBe(4);
		expect(clampWidth(Number.POSITIVE_INFINITY, 4, 40)).toBe(40);
		expect(clampWidth(Number.NEGATIVE_INFINITY, 4, 40)).toBe(4);
	});
});

describe('parseStoredWidth', () => {
	const { minRem, maxRem, defaultRem } = PREFIX_WIDTH;
	test('reads a stored pixel width', () => {
		expect(parseStoredWidth('240', remToPx(defaultRem), remToPx(minRem), remToPx(maxRem))).toBe(
			240,
		);
	});

	test('falls back for missing, blank and unreadable values', () => {
		const fallback = remToPx(defaultRem);
		for (const raw of [null, undefined, '', '   ', 'wide', 'NaN']) {
			expect(parseStoredWidth(raw, fallback, remToPx(minRem), remToPx(maxRem))).toBe(fallback);
		}
	});

	test('clamps out-of-range values instead of trusting them', () => {
		expect(parseStoredWidth('0', 224, 64, 640)).toBe(64);
		expect(parseStoredWidth('9999', 224, 64, 640)).toBe(640);
	});
});

describe('widthFromPointer', () => {
	test('grows with a rightward drag and shrinks with a leftward drag', () => {
		expect(
			widthFromPointer({ startWidth: 224, startX: 100, currentX: 140, min: 64, max: 640 }),
		).toBe(264);
		expect(
			widthFromPointer({ startWidth: 224, startX: 100, currentX: 60, min: 64, max: 640 }),
		).toBe(184);
	});

	test('respects the bounds', () => {
		expect(
			widthFromPointer({ startWidth: 224, startX: 0, currentX: -500, min: 64, max: 640 }),
		).toBe(64);
		expect(
			widthFromPointer({ startWidth: 224, startX: 0, currentX: 5000, min: 64, max: 640 }),
		).toBe(640);
	});
});

describe('widthFromKey', () => {
	test('steps by 16px in both directions and ignores other keys', () => {
		expect(widthFromKey({ width: 224, key: 'ArrowRight', min: 64, max: 640 })).toBe(
			224 + RESIZE_STEP_PX,
		);
		expect(widthFromKey({ width: 224, key: 'ArrowLeft', min: 64, max: 640 })).toBe(
			224 - RESIZE_STEP_PX,
		);
		expect(widthFromKey({ width: 224, key: 'Enter', min: 64, max: 640 })).toBe(224);
	});

	test('clamps at the bounds', () => {
		expect(widthFromKey({ width: 66, key: 'ArrowLeft', min: 64, max: 640 })).toBe(64);
		expect(widthFromKey({ width: 636, key: 'ArrowRight', min: 64, max: 640 })).toBe(640);
	});
});

describe('units and constants', () => {
	test('converts pixels to rem and back', () => {
		expect(pxToRem(224)).toBe('14rem');
		expect(pxToRem(240)).toBe('15rem');
		expect(remToPx(14)).toBe(224);
	});

	test('exposes the layout defaults and storage keys', () => {
		expect(SIDEBAR_WIDTH.defaultRem).toBe(22);
		expect(PREFIX_WIDTH.defaultRem).toBe(14);
		expect(STORAGE_KEYS.prefixWidth).toBe('watch-tail:prefix-width');
		expect(STORAGE_KEYS.sidebarWidth).toBe('watch-tail:sidebar-width');
		expect(STORAGE_KEYS.sidebarOpen).toBe('watch-tail:sidebar-open');
		expect(STORAGE_KEYS.logOpen).toBe('watch-tail:log-open');
	});
});
