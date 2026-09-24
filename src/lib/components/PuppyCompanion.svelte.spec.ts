import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import PuppyCompanion from './PuppyCompanion.svelte';
import { puppy } from '$lib/puppy.svelte';
import { PUPPY_SLOT_STORAGE_KEY } from '$lib/puppy-slots';

beforeEach(() => {
	localStorage.clear();
	puppy.shown = true;
});

afterEach(() => {
	cleanup();
	puppy.shown = false;
	puppy.pulse = 0;
	puppy.excitement = 0;
	puppy.slot = 'bottom-right';
});

const companion = () => screen.getByTestId('puppy-companion');
const svg = () => screen.getByRole('img');
/** A painted part of the sticker: the only thing that catches the pointer. */
const body = () => svg().querySelector('path') as SVGPathElement;

describe('PuppyCompanion', () => {
	it('sits bottom-right by default and restores a remembered corner', async () => {
		const first = render(PuppyCompanion);
		await tick();
		expect(companion().dataset.slot).toBe('bottom-right');
		first.unmount();

		localStorage.setItem(PUPPY_SLOT_STORAGE_KEY, 'top-left');
		render(PuppyCompanion);
		await tick();
		expect(companion().dataset.slot).toBe('top-left');
	});

	it('keeps the top corners below the header', async () => {
		localStorage.setItem(PUPPY_SLOT_STORAGE_KEY, 'top-right');
		render(PuppyCompanion, { props: { topInset: 48 } });
		await tick();
		// 48px of header plus the 16px margin.
		expect(companion().getAttribute('style')).toMatch(/translate\([\d.]+px, 64px\)/);
	});

	it('gets an excited burst from a click', async () => {
		render(PuppyCompanion);
		await tick();
		await fireEvent.click(body());
		expect(puppy.excitement).toBe(1);
		expect(svg().classList.contains('excited')).toBe(true);
	});

	it('is dragged into the corner it is dropped nearest, showing the corners meanwhile', async () => {
		render(PuppyCompanion);
		await tick();
		expect(screen.queryAllByTestId('puppy-slot')).toHaveLength(0);

		await fireEvent.pointerDown(body(), { button: 0, pointerId: 1, clientX: 940, clientY: 700 });
		await fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 150 });

		const slots = screen.getAllByTestId('puppy-slot');
		expect(slots).toHaveLength(4);
		expect(slots.find((slot) => slot.dataset.landing === 'true')?.dataset.slot).toBe('top-left');

		await fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 150 });
		// The click that ends a drag is not a pat.
		await fireEvent.click(body());

		expect(companion().dataset.slot).toBe('top-left');
		expect(localStorage.getItem(PUPPY_SLOT_STORAGE_KEY)).toBe('top-left');
		expect(screen.queryAllByTestId('puppy-slot')).toHaveLength(0);
		expect(puppy.excitement).toBe(0);
		// A happy wag for the new spot.
		expect(puppy.pulse).toBe(1);
	});

	it('treats a press that barely moves as a click, not a drag', async () => {
		render(PuppyCompanion);
		await tick();
		await fireEvent.pointerDown(body(), { button: 0, pointerId: 1, clientX: 940, clientY: 700 });
		await fireEvent.pointerMove(window, { pointerId: 1, clientX: 942, clientY: 701 });
		expect(screen.queryAllByTestId('puppy-slot')).toHaveLength(0);
		await fireEvent.pointerUp(window, { pointerId: 1, clientX: 942, clientY: 701 });
		await fireEvent.click(body());
		expect(companion().dataset.slot).toBe('bottom-right');
		expect(puppy.excitement).toBe(1);
	});

	it('moves between corners with the arrow keys and gets excited with Enter', async () => {
		render(PuppyCompanion);
		await tick();
		await fireEvent.keyDown(companion(), { key: 'ArrowLeft' });
		expect(companion().dataset.slot).toBe('bottom-left');
		await fireEvent.keyDown(companion(), { key: 'ArrowUp' });
		expect(companion().dataset.slot).toBe('top-left');
		expect(localStorage.getItem(PUPPY_SLOT_STORAGE_KEY)).toBe('top-left');
		expect(puppy.pulse).toBe(2);

		// Already against the edge: nothing moves, nothing wags.
		await fireEvent.keyDown(companion(), { key: 'ArrowUp' });
		expect(puppy.pulse).toBe(2);

		await fireEvent.keyDown(companion(), { key: 'Enter' });
		expect(puppy.excitement).toBe(1);
	});
});
