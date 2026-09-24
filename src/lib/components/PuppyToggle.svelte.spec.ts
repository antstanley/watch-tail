import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PuppyCompanion from './PuppyCompanion.svelte';
import PuppyToggle from './PuppyToggle.svelte';
import { puppy } from '$lib/puppy.svelte';

afterEach(() => {
	cleanup();
	puppy.shown = false;
	puppy.pulse = 0;
});

describe('PuppyToggle and PuppyCompanion', () => {
	it('brings the puppy out from the header button and sends it away again', async () => {
		render(PuppyToggle);
		render(PuppyCompanion);
		const button = screen.getByRole('button', { name: 'Puppy' });
		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(screen.queryByTestId('puppy-companion')).toBeNull();

		await fireEvent.click(button);
		expect(button.getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByTestId('puppy-companion')).toBeTruthy();
		expect(screen.getByRole('img', { name: 'The watch-tail puppy' })).toBeTruthy();

		await fireEvent.click(button);
		expect(button.getAttribute('aria-pressed')).toBe('false');
		expect(screen.queryByTestId('puppy-companion')).toBeNull();
	});

	it('sits still until something asks it to wag', async () => {
		puppy.shown = true;
		render(PuppyCompanion);
		await tick();
		const svg = screen.getByRole('img');
		expect(svg.classList.contains('active')).toBe(false);

		puppy.wag();
		await tick();
		expect(svg.classList.contains('active')).toBe(true);
	});
});
