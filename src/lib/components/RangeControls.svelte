<script lang="ts">
	import { ArrowRight } from '@lucide/svelte';
	import {
		fromDateTimeLocal,
		HISTORIC_PRESETS,
		PRESET_LABELS,
		presetLabel,
		toDateTimeLocal,
		type LogMode,
	} from '$lib/time-range';

	type ApplyPayload = {
		mode: LogMode;
		/** Preset name when a preset is active, otherwise an empty string. */
		range: string;
		/** Custom bounds as epoch ms, or `null` when a preset/live window is active. */
		from: number | null;
		to: number | null;
	};

	type Props = {
		/** Active mode, owned by the page. */
		mode?: LogMode;
		/** Active preset, owned by the page. */
		range?: string;
		/** Active custom bounds as epoch ms, owned by the page. */
		from?: number | null;
		to?: number | null;
		/** True when no group is selected, so there is nothing to scope. */
		disabled?: boolean;
		/** True while a historic window is being fetched. */
		loading?: boolean;
		/** True when the source cannot follow live events, such as the local archive. */
		liveDisabled?: boolean;
		/** Called when the user switches mode or applies a range. */
		onApply?: (payload: ApplyPayload) => void;
	};

	let {
		mode = 'live',
		range = '15m',
		from = null,
		to = null,
		disabled = false,
		loading = false,
		liveDisabled = false,
		onApply,
	}: Props = $props();

	/** True when the custom bounds editor is open. */
	let customOpen = $state(false);
	/** Draft values for the `datetime-local` inputs. */
	let customFrom = $state('');
	let customTo = $state('');
	/** Validation message for the custom editor. */
	let customError = $state<string | null>(null);

	/** Rewrites the drafts whenever the active window changes from outside. */
	$effect(() => {
		const start = from ?? (to ?? Date.now()) - 60 * 60 * 1000;
		const end = to ?? Date.now();
		customFrom = toDateTimeLocal(start);
		customTo = toDateTimeLocal(end);
		customOpen = mode === 'historic' && range === '' && from !== null && to !== null;
	});

	/** Starts or stops tailing live. */
	function selectMode(next: LogMode): void {
		if (next === mode) return;
		// A source without live events (the archive) must not open a live window,
		// even if the click arrives from a script rather than a real button.
		if (next === 'live' && liveDisabled) return;
		onApply?.({
			mode: next,
			range: next === 'live' ? '' : range === '' ? '15m' : range,
			from: null,
			to: null,
		});
	}

	/** Applies a preset window. */
	function selectPreset(preset: string): void {
		customError = null;
		onApply?.({ mode: 'historic', range: preset, from: null, to: null });
	}

	/** Opens the custom window editor, seeded from the active window. */
	function openCustom(): void {
		customError = null;
		customOpen = true;
	}

	/** Applies the custom window, rejecting an inverted or unparsable range. */
	function applyCustom(): void {
		const start = fromDateTimeLocal(customFrom);
		const end = fromDateTimeLocal(customTo);
		if (start === null || end === null) {
			customError = 'Pick both a start and an end time.';
			return;
		}
		if (end <= start) {
			customError = 'The end must be after the start.';
			return;
		}
		if (end - start > 14 * 24 * 60 * 60 * 1000) {
			customError = 'CloudWatch Logs only keeps 14 days.';
			return;
		}
		customError = null;
		onApply?.({ mode: 'historic', range: '', from: start, to: end });
	}

	/** True when the custom chip stands for an explicit window with both bounds. */
	let customActive = $derived(mode === 'historic' && range === '' && from !== null && to !== null);
	/** Start bound on the custom chip, formatted for display. */
	let customFromLabel = $derived(from === null ? '' : toDateTimeLocal(from).replace('T', ' '));
	/** End bound on the custom chip, formatted for display. */
	let customToLabel = $derived(to === null ? '' : toDateTimeLocal(to).replace('T', ' '));
	/** Shared classes for the segmented buttons. */
	const chip =
		'rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
</script>

<div class="flex flex-wrap items-center gap-2" data-testid="range-controls">
	<div
		class="flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900 p-0.5"
		role="group"
		aria-label="Tail mode"
	>
		<button
			type="button"
			onclick={() => selectMode('live')}
			aria-pressed={mode === 'live'}
			disabled={liveDisabled}
			title={liveDisabled
				? 'There is nothing to tail: the local archive holds historic windows'
				: undefined}
			data-testid="mode-live"
			class="{chip} {mode === 'live'
				? 'border-sky-700 bg-sky-950/60 text-sky-300'
				: 'border-transparent text-neutral-400 hover:text-neutral-200'} disabled:opacity-40"
		>
			Live
		</button>
		<button
			type="button"
			onclick={() => selectMode('historic')}
			aria-pressed={mode === 'historic'}
			data-testid="mode-historic"
			class="{chip} {mode === 'historic'
				? 'border-amber-700 bg-amber-950/50 text-amber-300'
				: 'border-transparent text-neutral-400 hover:text-neutral-200'}"
		>
			Historic
		</button>
	</div>

	{#if mode === 'historic'}
		<div class="flex flex-wrap items-center gap-1" role="group" aria-label="Historic range">
			{#each HISTORIC_PRESETS as preset (preset)}
				<button
					type="button"
					onclick={() => selectPreset(preset)}
					aria-pressed={range === preset}
					data-testid="preset-{preset}"
					{disabled}
					class="{chip} {range === preset
						? 'border-amber-700 bg-amber-950/50 text-amber-200'
						: 'border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700'} disabled:opacity-40"
				>
					{PRESET_LABELS[preset]}
				</button>
			{/each}
			<button
				type="button"
				onclick={openCustom}
				aria-pressed={range === ''}
				data-testid="preset-custom"
				{disabled}
				class="{chip} {range === ''
					? 'border-amber-700 bg-amber-950/50 text-amber-200'
					: 'border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700'}"
			>
				{#if customActive}
					<span class="inline-flex items-center gap-1">
						<span>{customFromLabel}</span>
						<ArrowRight size="1em" />
						<span>{customToLabel}</span>
					</span>
				{:else}
					Custom…
				{/if}
			</button>
		</div>
	{/if}

	{#if loading}
		<span class="text-xs text-amber-300" data-testid="range-loading">loading window…</span>
	{:else if mode === 'historic' && range !== ''}
		<span class="text-xs text-neutral-500">last {presetLabel(range)}</span>
	{/if}

	{#if customOpen && mode === 'historic'}
		<div
			class="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/70 p-2"
			data-testid="custom-window"
		>
			<label class="flex items-center gap-1 text-xs text-neutral-400">
				From
				<input
					type="datetime-local"
					bind:value={customFrom}
					data-testid="custom-from"
					class="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100"
				/>
			</label>
			<label class="flex items-center gap-1 text-xs text-neutral-400">
				To
				<input
					type="datetime-local"
					bind:value={customTo}
					data-testid="custom-to"
					class="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100"
				/>
			</label>
			<button
				type="button"
				onclick={applyCustom}
				data-testid="custom-apply"
				class="rounded-md border border-sky-800 bg-sky-950/60 px-2 py-1 text-xs font-medium text-sky-200 hover:border-sky-600"
			>
				Apply
			</button>
			{#if customError !== null}
				<span class="text-xs text-red-300" role="alert" data-testid="custom-error"
					>{customError}</span
				>
			{/if}
		</div>
	{/if}
</div>
