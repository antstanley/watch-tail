import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PuppyLogo from './PuppyLogo.svelte';

// Auto-cleanup only runs when vitest globals are enabled, which they are not here.
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/** A reduced-motion preference the test can flip, as the operating system would. */
function motionPreference(reduce: boolean): { set: (next: boolean) => void } {
	const listeners = new Set<() => void>();
	const query = {
		get matches() {
			return reduce;
		},
		addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
		removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
	};
	vi.spyOn(window, 'matchMedia').mockReturnValue(query as unknown as MediaQueryList);
	return {
		set(next) {
			reduce = next;
			for (const listener of listeners) listener();
		},
	};
}

const excitedNow = () => logo().classList.contains('excited');

/** The logo's root `<svg>`. */
function logo(): SVGSVGElement {
	return screen.getByRole('img') as unknown as SVGSVGElement;
}

const wagging = () => logo().classList.contains('active');

/**
 * jsdom runs no CSS animations, so a finished wag cycle is simulated by firing
 * `animationiteration` on every tail layer; only one of them listens.
 */
async function finishCycle(): Promise<void> {
	for (const tail of logo().querySelectorAll('.tail')) await fireEvent.animationIteration(tail);
}

describe('PuppyLogo', () => {
	it('is an image named by its title', () => {
		render(PuppyLogo, { props: { title: 'Good dog' } });
		expect(screen.getByRole('img', { name: 'Good dog' })).toBeTruthy();
	});

	it('wags straight away when told to wag always', async () => {
		render(PuppyLogo, { props: { wag: 'always' } });
		await tick();
		expect(wagging()).toBe(true);
	});

	it('wags for two cycles each time the pulse changes, then stops at centre', async () => {
		const view = render(PuppyLogo, { props: { wag: 'off', pulse: 0 } });
		await tick();
		expect(wagging()).toBe(false);

		await view.rerender({ pulse: 1 });
		expect(wagging()).toBe(true);
		await finishCycle();
		expect(wagging()).toBe(true);
		await finishCycle();
		expect(wagging()).toBe(false);
	});

	it('wags while hovered and finishes its swing after the pointer leaves', async () => {
		render(PuppyLogo, { props: { wag: 'hover' } });
		await fireEvent.pointerEnter(logo());
		expect(wagging()).toBe(true);

		await fireEvent.pointerLeave(logo());
		// Still mid-swing: it only stops once the cycle brings the tail back to centre.
		expect(wagging()).toBe(true);
		await finishCycle();
		expect(wagging()).toBe(false);
	});

	it('runs a faster, wider excited wag for five cycles when excited from rest', async () => {
		const view = render(PuppyLogo, { props: { wag: 'off', excite: 0 } });
		await tick();
		await view.rerender({ excite: 1 });
		expect(wagging()).toBe(true);
		expect(logo().classList.contains('excited')).toBe(true);
		expect(logo().getAttribute('style')).toContain('--excited-speed: 260ms');
		expect(logo().getAttribute('style')).toContain('--excited-amp: 24deg');

		for (let cycle = 0; cycle < 4; cycle += 1) await finishCycle();
		expect(logo().classList.contains('excited')).toBe(true);
		await finishCycle();
		expect(logo().classList.contains('excited')).toBe(false);
		expect(wagging()).toBe(false);
	});

	it('waits for the tail to reach centre before switching a calm wag to an excited one', async () => {
		const view = render(PuppyLogo, { props: { wag: 'off', pulse: 0, excite: 0 } });
		await tick();
		await view.rerender({ pulse: 1 });
		await view.rerender({ excite: 1 });
		// Mid-swing: still the calm wag.
		expect(logo().classList.contains('excited')).toBe(false);
		await finishCycle();
		expect(logo().classList.contains('excited')).toBe(true);
		expect(wagging()).toBe(true);
	});

	it('starts the excited count again when excited mid-burst, switching at the next centre', async () => {
		const view = render(PuppyLogo, { props: { wag: 'off', excite: 0 } });
		await tick();
		await view.rerender({ excite: 1 });
		for (let cycle = 0; cycle < 3; cycle += 1) await finishCycle();
		await view.rerender({ excite: 2 });

		// One cycle to reach centre, then five fresh excited wags.
		for (let cycle = 0; cycle < 5; cycle += 1) await finishCycle();
		expect(excitedNow()).toBe(true);
		await finishCycle();
		expect(excitedNow()).toBe(false);
		expect(wagging()).toBe(false);
	});

	it('hands back to the calm wag after an excited burst when it wags always', async () => {
		const view = render(PuppyLogo, { props: { wag: 'always', excite: 0 } });
		await tick();
		await view.rerender({ excite: 1 });
		expect(excitedNow()).toBe(false);
		await finishCycle();
		expect(excitedNow()).toBe(true);
		for (let cycle = 0; cycle < 5; cycle += 1) await finishCycle();
		expect(excitedNow()).toBe(false);
		expect(wagging()).toBe(true);
	});

	it('lets a pulse during an excited burst run out alongside it', async () => {
		const view = render(PuppyLogo, { props: { wag: 'off', pulse: 0, excite: 0 } });
		await tick();
		await view.rerender({ excite: 1 });
		await view.rerender({ pulse: 1 });
		for (let cycle = 0; cycle < 4; cycle += 1) await finishCycle();
		expect(wagging()).toBe(true);
		await finishCycle();
		expect(wagging()).toBe(false);
	});

	it('neither wags nor saves up wags while reduced motion is on', async () => {
		const preference = motionPreference(true);
		const view = render(PuppyLogo, { props: { wag: 'off', pulse: 0, excite: 0 } });
		await tick();
		await view.rerender({ pulse: 1 });
		await view.rerender({ excite: 1 });
		expect(wagging()).toBe(false);

		// Nothing owed plays once motion is allowed again.
		preference.set(false);
		await tick();
		expect(wagging()).toBe(false);
	});

	it('stops at once and forgets owed wags when reduced motion is switched on mid-wag', async () => {
		const preference = motionPreference(false);
		const view = render(PuppyLogo, { props: { wag: 'off', pulse: 0, excite: 0 } });
		await tick();
		await view.rerender({ pulse: 1 });
		await view.rerender({ excite: 1 });
		expect(wagging()).toBe(true);

		preference.set(true);
		await tick();
		expect(wagging()).toBe(false);
		preference.set(false);
		await tick();
		expect(wagging()).toBe(false);
	});

	it('resumes an always-on wag once reduced motion is switched off', async () => {
		const preference = motionPreference(true);
		render(PuppyLogo, { props: { wag: 'always' } });
		await tick();
		expect(wagging()).toBe(false);
		preference.set(false);
		await tick();
		expect(wagging()).toBe(true);
	});

	it('draws the die-cut sticker by default, without floating wag marks', () => {
		render(PuppyLogo);
		expect(logo().querySelector('filter')).not.toBeNull();
		expect(logo().querySelector('.marks')).toBeNull();
	});

	it('draws the flat style with its wag marks when the sticker is off', () => {
		render(PuppyLogo, { props: { sticker: false } });
		expect(logo().querySelector('filter')).toBeNull();
		expect(logo().querySelector('.marks')).not.toBeNull();
	});

	it('gives each logo on a page its own shadow filter', () => {
		render(PuppyLogo);
		render(PuppyLogo);
		const ids = [...document.querySelectorAll('filter')].map((filter) => filter.id);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});
});
