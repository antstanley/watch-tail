/**
 * Terminal presentation for the CLI.
 *
 * Interactive terminals get the Bombshell (`@clack/prompts`) experience -
 * banner, spinner, autocomplete prompts. Anything else (pipes, CI, `--no-color`)
 * falls back to plain lines, which also keeps the integration tests readable.
 */
import {
	autocomplete,
	cancel,
	confirm,
	intro,
	isCancel,
	log,
	multiselect,
	outro,
	spinner,
} from '@clack/prompts';

/**
 * Thrown when the user cancels a prompt with Ctrl+C.
 *
 * A cancel is not an answer: reading it as "No" is how the CLI used to keep
 * running (server and all) after a Ctrl+C that looked like it did nothing, so
 * the prompt layer raises this instead and the CLI stops cleanly.
 */
export class PromptCancelled extends Error {
	constructor() {
		super('the prompt was cancelled');
		this.name = 'PromptCancelled';
	}
}

export type Ui = {
	/** True when animated output and prompts are safe to use. */
	readonly interactive: boolean;
	intro(text: string): void;
	outro(text: string): void;
	info(text: string): void;
	warn(text: string): void;
	startSpinner(text: string): void;
	stopSpinner(text: string): void;
	failSpinner(text: string): void;
	/**
	 * Asks for a value from `options`.
	 *
	 * Resolves `null` when the question does not apply (no choices, or a
	 * non-interactive run); throws {@link PromptCancelled} when the user cancels.
	 */
	choose(
		message: string,
		options: { value: string; label?: string }[],
		initial?: string | null,
	): Promise<string | null>;
	/**
	 * Asks for several values from `options`.
	 *
	 * Resolves `[]` when there is nothing to ask or the run is not interactive.
	 * Throws {@link PromptCancelled} when the user cancels.
	 */
	multiChoose(
		message: string,
		options: { value: string; label?: string }[],
		initial?: string[],
	): Promise<string[]>;
	/**
	 * Asks a yes/no question; a non-interactive run always answers `false`.
	 *
	 * Throws {@link PromptCancelled} when the user cancels, because "stop" and
	 * "no" are different answers and only one of them ends the process.
	 */
	confirm(message: string, initial?: boolean): Promise<boolean>;
};

/**
 * Decides whether the process can render animated output and ask questions.
 *
 * `NO_COLOR` is deliberately *not* consulted: it asks for no colour, which the
 * prompt library honours on its own, and reading it as "do not prompt" silently
 * disabled the login and profile questions for anyone who sets it.
 */
export function isInteractive(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') return false;
	if (env.WATCH_TAIL_PLAIN === '1') return false;
	return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/**
 * Builds the presentation layer.
 *
 * The non-interactive branch never touches `@clack/prompts`, so piping the CLI
 * into a file or a test harness produces stable, greppable output.
 */
export function createUi(options: { interactive?: boolean } = {}): Ui {
	const interactive = options.interactive ?? isInteractive();
	const spin = interactive ? spinner() : null;

	if (!interactive) {
		return {
			interactive,
			intro: (text) => console.log(text),
			outro: (text) => console.log(text),
			info: (text) => console.log(text),
			warn: (text) => console.warn(`warning: ${text}`),
			startSpinner: (text) => console.log(text),
			stopSpinner: (text) => console.log(text),
			failSpinner: (text) => console.error(text),
			choose: async (_message, choices, initial) => {
				const fallback = initial ?? choices[0]?.value ?? null;
				return fallback;
			},
			multiChoose: async () => [],
			confirm: async () => false,
		};
	}

	return {
		interactive,
		intro: (text) => intro(text),
		outro: (text) => outro(text),
		info: (text) => log.info(text),
		warn: (text) => log.warn(text),
		startSpinner: (text) => spin?.start(text),
		stopSpinner: (text) => spin?.stop(text),
		failSpinner: (text) => {
			spin?.stop();
			log.error(text);
		},
		choose: async (message, choices, initial) => {
			if (choices.length === 0) return null;
			const answer = await autocomplete({
				message,
				options: choices.map((choice) => ({
					value: choice.value,
					label: choice.label ?? choice.value,
				})),
				initialValue: initial ?? undefined,
				maxItems: 12,
			});
			if (isCancel(answer)) {
				cancel('Cancelled.');
				throw new PromptCancelled();
			}
			return String(answer);
		},
		multiChoose: async (message, choices, initial) => {
			if (choices.length === 0) return [];
			const answer = await multiselect({
				message,
				options: choices.map((choice) => ({
					value: choice.value,
					label: choice.label ?? choice.value,
				})),
				initialValues: initial ?? choices.map((choice) => choice.value),
				required: false,
			});
			if (isCancel(answer)) {
				cancel('Cancelled.');
				throw new PromptCancelled();
			}
			return (answer as unknown[]).map((value) => String(value));
		},
		confirm: async (message, initial = true) => {
			const answer = await confirm({ message, initialValue: initial });
			if (isCancel(answer)) {
				cancel('Cancelled.');
				throw new PromptCancelled();
			}
			return answer === true;
		},
	};
}
