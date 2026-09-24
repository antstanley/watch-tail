<script lang="ts">
	import { onMount } from 'svelte';
	import { THEMES, THEME_STORAGE_KEY, parseTheme, type ThemeId } from '$lib/themes';

	let selected = $state<ThemeId>('midnight');

	function apply(value: string, persist = true): void {
		selected = parseTheme(value);
		document.documentElement.dataset.theme = selected;
		if (persist) {
			try {
				localStorage.setItem(THEME_STORAGE_KEY, selected);
			} catch {
				// Theme switching still works when storage is unavailable.
			}
		}
	}

	onMount(() => {
		let stored: string | null = null;
		try {
			stored = localStorage.getItem(THEME_STORAGE_KEY);
		} catch {
			// Use the default when storage is unavailable.
		}
		apply(parseTheme(stored), false);
	});
</script>

<label class="flex items-center gap-2 text-xs text-neutral-400">
	<span>Theme</span>
	<select
		aria-label="Colour theme"
		data-testid="theme-select"
		value={selected}
		onchange={(event) => apply(event.currentTarget.value)}
		class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-sky-600"
	>
		{#each ['dark', 'light'] as mode}
			<optgroup label={mode === 'dark' ? 'Dark themes' : 'Light themes'}>
				{#each THEMES.filter((theme) => theme.mode === mode) as theme}
					<option value={theme.id}>{theme.name}</option>
				{/each}
			</optgroup>
		{/each}
	</select>
</label>
