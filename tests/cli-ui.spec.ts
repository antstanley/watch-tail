/**
 * Cancelling a prompt must not be read as an answer.
 *
 * `@clack/prompts` reports Ctrl+C as a cancel symbol, not as "no". Answering
 * `false`/`null` for it is what used to leave the CLI running (server and all)
 * after a Ctrl+C that looked like it did nothing, so the prompt layer raises
 * `PromptCancelled` and the caller stops.
 */
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ answer: null as unknown }));
const CANCEL = Symbol('clack-cancel');

vi.mock('@clack/prompts', () => ({
	intro: () => undefined,
	outro: () => undefined,
	cancel: () => undefined,
	log: {
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
		success: () => undefined,
	},
	spinner: () => ({ start: () => undefined, stop: () => undefined }),
	isCancel: (value: unknown) => value === CANCEL,
	confirm: async () => state.answer,
	autocomplete: async () => state.answer,
	multiselect: async () => state.answer,
}));

const { PromptCancelled, createUi } = await import('../src/cli/ui.ts');

describe('createUi: a cancelled prompt', () => {
	it('throws for the profile picker instead of resolving null', async () => {
		state.answer = CANCEL;
		const ui = createUi({ interactive: true });
		await expect(ui.choose('which profile?', [{ value: 'default' }])).rejects.toBeInstanceOf(
			PromptCancelled,
		);
	});

	it('throws for a yes/no question instead of answering no', async () => {
		state.answer = CANCEL;
		const ui = createUi({ interactive: true });
		await expect(ui.confirm('run the login?')).rejects.toBeInstanceOf(PromptCancelled);
	});

	it('throws for a multi-select instead of answering nothing', async () => {
		state.answer = CANCEL;
		const ui = createUi({ interactive: true });
		await expect(ui.multiChoose('which agents?', [{ value: 'cursor' }])).rejects.toBeInstanceOf(
			PromptCancelled,
		);
	});

	it('returns the chosen values from a multi-select', async () => {
		state.answer = ['cursor', 'codex'];
		const ui = createUi({ interactive: true });
		await expect(ui.multiChoose('which agents?', [{ value: 'cursor' }])).resolves.toEqual([
			'cursor',
			'codex',
		]);
	});

	it('still answers yes and no normally', async () => {
		const ui = createUi({ interactive: true });
		state.answer = true;
		await expect(ui.confirm('run the login?')).resolves.toBe(true);
		state.answer = false;
		await expect(ui.confirm('run the login?')).resolves.toBe(false);
	});

	it('never prompts in a non-interactive run, and never throws', async () => {
		state.answer = CANCEL;
		const ui = createUi({ interactive: false });
		await expect(ui.confirm('run the login?')).resolves.toBe(false);
		// A non-interactive run answers with the initial choice rather than asking.
		await expect(ui.choose('which profile?', [{ value: 'acme-prod' }], 'acme-prod')).resolves.toBe(
			'acme-prod',
		);
	});
});
