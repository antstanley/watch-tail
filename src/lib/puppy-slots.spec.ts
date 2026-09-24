import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PUPPY_SLOT,
	PUPPY_SLOTS,
	nearestSlot,
	parsePuppySlot,
	slotPosition,
	stepSlot,
} from './puppy-slots';

const viewport = { width: 1200, height: 800 };
const puppy = { width: 128, height: 100 };
const insets = { margin: 16, top: 48 };

describe('parsePuppySlot', () => {
	it('accepts every known slot', () => {
		for (const slot of PUPPY_SLOTS) expect(parsePuppySlot(slot)).toBe(slot);
	});

	it('falls back to bottom-right for anything else', () => {
		expect(DEFAULT_PUPPY_SLOT).toBe('bottom-right');
		expect(parsePuppySlot(null)).toBe('bottom-right');
		expect(parsePuppySlot('middle')).toBe('bottom-right');
	});
});

describe('slotPosition', () => {
	it('puts each corner a margin in from the edges, and the top ones below the header', () => {
		expect(slotPosition('top-left', viewport, puppy, insets)).toEqual({ x: 16, y: 64 });
		expect(slotPosition('top-right', viewport, puppy, insets)).toEqual({ x: 1056, y: 64 });
		expect(slotPosition('bottom-left', viewport, puppy, insets)).toEqual({ x: 16, y: 684 });
		expect(slotPosition('bottom-right', viewport, puppy, insets)).toEqual({ x: 1056, y: 684 });
	});

	it('never pushes the puppy past the top-left margin on a tiny screen', () => {
		const tiny = { width: 100, height: 90 };
		expect(slotPosition('bottom-right', tiny, puppy, insets)).toEqual({ x: 16, y: 64 });
	});
});

describe('nearestSlot', () => {
	it('picks the corner of the quarter the centre is in', () => {
		expect(nearestSlot({ x: 100, y: 100 }, viewport)).toBe('top-left');
		expect(nearestSlot({ x: 1100, y: 100 }, viewport)).toBe('top-right');
		expect(nearestSlot({ x: 100, y: 700 }, viewport)).toBe('bottom-left');
		expect(nearestSlot({ x: 1100, y: 700 }, viewport)).toBe('bottom-right');
	});

	it('sends the exact middle to the bottom-right', () => {
		expect(nearestSlot({ x: 600, y: 400 }, viewport)).toBe('bottom-right');
	});
});

describe('stepSlot', () => {
	it('moves along one axis per arrow key', () => {
		expect(stepSlot('bottom-right', 'ArrowLeft')).toBe('bottom-left');
		expect(stepSlot('bottom-left', 'ArrowUp')).toBe('top-left');
		expect(stepSlot('top-left', 'ArrowRight')).toBe('top-right');
		expect(stepSlot('top-right', 'ArrowDown')).toBe('bottom-right');
	});

	it('stays put against an edge, and ignores other keys', () => {
		expect(stepSlot('top-left', 'ArrowUp')).toBe('top-left');
		expect(stepSlot('top-left', 'Enter')).toBeNull();
	});
});
