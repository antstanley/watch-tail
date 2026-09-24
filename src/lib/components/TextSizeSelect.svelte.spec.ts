import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TextSizeSelect from './TextSizeSelect.svelte';
import { TEXT_SIZES, TEXT_SIZE_STORAGE_KEY } from '$lib/text-size';

beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	delete document.documentElement.dataset.textSize;
});

describe('TextSizeSelect', () => {
	it('offers every text size', () => {
		render(TextSizeSelect);
		expect(screen.getAllByRole('option')).toHaveLength(TEXT_SIZES.length);
	});

	it('starts on Default and marks the document before any choice', () => {
		render(TextSizeSelect);
		expect((screen.getByLabelText('Text size') as HTMLSelectElement).value).toBe('default');
		expect(document.documentElement.dataset.textSize).toBe('default');
	});

	it('applies the choice immediately and restores it on the next visit', async () => {
		const view = render(TextSizeSelect);
		await fireEvent.change(screen.getByLabelText('Text size'), { target: { value: 'large' } });
		expect(document.documentElement.dataset.textSize).toBe('large');
		expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe('large');
		view.unmount();
		render(TextSizeSelect);
		expect((screen.getByLabelText('Text size') as HTMLSelectElement).value).toBe('large');
	});

	it('falls back when a saved size no longer exists', () => {
		localStorage.setItem(TEXT_SIZE_STORAGE_KEY, 'obsolete');
		render(TextSizeSelect);
		expect(document.documentElement.dataset.textSize).toBe('default');
		expect((screen.getByLabelText('Text size') as HTMLSelectElement).value).toBe('default');
	});

	it('still switches when storage is blocked', async () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		render(TextSizeSelect);
		await fireEvent.change(screen.getByLabelText('Text size'), { target: { value: 'xlarge' } });
		expect(document.documentElement.dataset.textSize).toBe('xlarge');
	});
});
