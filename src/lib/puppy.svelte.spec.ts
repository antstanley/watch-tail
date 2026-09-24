import { afterEach, describe, expect, it } from 'vitest';
import { puppy } from './puppy.svelte';

afterEach(() => {
	localStorage.clear();
	puppy.shown = false;
	puppy.pulse = 0;
	puppy.excitement = 0;
	puppy.slot = 'bottom-right';
});

describe('puppy companion state', () => {
	it('starts hidden and toggles in and out', () => {
		expect(puppy.shown).toBe(false);
		puppy.toggle();
		expect(puppy.shown).toBe(true);
		puppy.toggle();
		expect(puppy.shown).toBe(false);
	});

	it('only gets excited while shown', () => {
		puppy.excite();
		expect(puppy.excitement).toBe(0);
		puppy.toggle();
		puppy.excite();
		expect(puppy.excitement).toBe(1);
	});

	it('remembers the corner it is moved to, and falls back for a bad stored value', () => {
		puppy.moveTo('top-left');
		expect(localStorage.getItem('watch-tail:puppy-slot')).toBe('top-left');
		puppy.slot = 'bottom-right';
		puppy.restore();
		expect(puppy.slot).toBe('top-left');

		localStorage.setItem('watch-tail:puppy-slot', 'on-the-sofa');
		puppy.restore();
		expect(puppy.slot).toBe('bottom-right');
	});

	it('only wags while shown', () => {
		puppy.wag();
		expect(puppy.pulse).toBe(0);
		puppy.toggle();
		puppy.wag();
		puppy.wag();
		expect(puppy.pulse).toBe(2);
	});
});
