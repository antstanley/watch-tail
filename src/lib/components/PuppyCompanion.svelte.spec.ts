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

/** Pointer steps for one pointer (id 1 unless given), the primary button held while moving. */
const press = (x: number, y: number, pointerId = 1) =>
	fireEvent.pointerDown(body(), { button: 0, buttons: 1, pointerId, clientX: x, clientY: y });
const move = (x: number, y: number, pointerId = 1, buttons = 1) =>
	fireEvent.pointerMove(window, { buttons, pointerId, clientX: x, clientY: y });
const release = (x: number, y: number, pointerId = 1) =>
	fireEvent.pointerUp(window, { button: 0, buttons: 0, pointerId, clientX: x, clientY: y });

const slotsShown = () => screen.queryAllByTestId('puppy-slot').length > 0;

/** The `translate(x, y)` the puppy is drawn at. */
function drawnAt(): { x: number; y: number } {
	const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(
		companion().getAttribute('style') ?? '',
	);
	if (match === null) throw new Error('the puppy has no position');
	return { x: Number(match[1]), y: Number(match[2]) };
}

/** Lets the timers queued by a release run. */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

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

		await press(940, 700);
		await move(200, 150);

		const slots = screen.getAllByTestId('puppy-slot');
		expect(slots).toHaveLength(4);
		expect(slots.find((slot) => slot.dataset.landing === 'true')?.dataset.slot).toBe('top-left');

		await release(200, 150);
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
		await press(940, 700);
		await move(942, 701);
		expect(screen.queryAllByTestId('puppy-slot')).toHaveLength(0);
		await release(942, 701);
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

	it('is grabbed where it is drawn, even while still springing into its corner', async () => {
		render(PuppyCompanion);
		await tick();
		// Mid-spring: drawn at (500, 300), although its slot is the bottom-right corner.
		companion().getBoundingClientRect = () =>
			({ left: 500, top: 300, right: 628, bottom: 403, width: 128, height: 103 }) as DOMRect;
		await press(520, 320);
		expect(drawnAt()).toEqual({ x: 500, y: 300 });
		await move(620, 420);
		// The same spot of the sticker stays under the pointer: no jump.
		expect(drawnAt()).toEqual({ x: 600, y: 400 });
	});

	it('stays inside the window however far it is dragged', async () => {
		render(PuppyCompanion);
		await tick();
		await press(940, 700);
		await move(5000, 5000);
		const { x, y } = drawnAt();
		expect(x).toBeLessThanOrEqual(window.innerWidth - 128);
		expect(y).toBeLessThanOrEqual(window.innerHeight);
		await move(-5000, -5000);
		expect(drawnAt()).toEqual({ x: 0, y: 0 });
	});

	it('follows the window when it is resized', async () => {
		const width = window.innerWidth;
		render(PuppyCompanion);
		await tick();
		try {
			window.innerWidth = 800;
			window.dispatchEvent(new Event('resize'));
			await tick();
			expect(drawnAt().x).toBe(800 - 128 - 16);
		} finally {
			window.innerWidth = width;
			window.dispatchEvent(new Event('resize'));
		}
	});

	it('lets go when the release goes missing, instead of sticking to the cursor', async () => {
		render(PuppyCompanion);
		await tick();
		await press(940, 700);
		await move(200, 150);
		expect(slotsShown()).toBe(true);

		// The button is no longer held (a context menu took the release).
		await move(300, 200, 1, 0);
		expect(slotsShown()).toBe(false);
		await move(100, 100, 1, 0);
		await release(100, 100);
		expect(companion().dataset.slot).toBe('bottom-right');
		expect(localStorage.getItem(PUPPY_SLOT_STORAGE_KEY)).toBeNull();
	});

	it('cancels a drag when the pointer is cancelled or its capture is lost', async () => {
		render(PuppyCompanion);
		await tick();
		await press(940, 700);
		await move(200, 150);
		await fireEvent.pointerCancel(window, { pointerId: 1 });
		expect(slotsShown()).toBe(false);

		await press(940, 700);
		await move(200, 150);
		await fireEvent.lostPointerCapture(companion(), { pointerId: 1 });
		expect(slotsShown()).toBe(false);
		await release(200, 150);
		expect(companion().dataset.slot).toBe('bottom-right');
	});

	it('ignores every pointer but the one carrying it', async () => {
		render(PuppyCompanion);
		await tick();
		// jsdom draws everything at (0, 0), so this grabs the puppy 40px into its box.
		await press(40, 40, 1);
		// A second finger neither drags it nor restarts the drag.
		await move(200, 150, 2);
		expect(slotsShown()).toBe(false);
		await move(200, 650, 1);
		const carried = drawnAt();
		await press(900, 100, 2);
		expect(drawnAt()).toEqual(carried);
		await release(900, 100, 2);
		expect(slotsShown()).toBe(true);

		await release(200, 650, 1);
		expect(companion().dataset.slot).toBe('bottom-left');
	});

	it('drops nothing when it is sent away mid-drag', async () => {
		render(PuppyCompanion);
		await tick();
		await press(940, 700);
		await move(200, 150);
		puppy.shown = false;
		await tick();
		await release(200, 150);
		expect(puppy.slot).toBe('bottom-right');
		expect(localStorage.getItem(PUPPY_SLOT_STORAGE_KEY)).toBeNull();
	});

	it('only swallows the click that ends a drag, not a later one', async () => {
		render(PuppyCompanion);
		await tick();
		// A touch drag: no click follows the release.
		await press(940, 700);
		await move(200, 150);
		await release(200, 150);
		await nextTask();
		// A later click with no press of its own (assistive technology) still counts.
		await fireEvent.click(companion());
		expect(puppy.excitement).toBe(1);
	});
});
