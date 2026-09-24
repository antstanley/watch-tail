<script lang="ts">
	import { onMount } from 'svelte';
	import {
		TEXT_SIZES,
		TEXT_SIZE_STORAGE_KEY,
		parseTextSize,
		type TextSizeId,
	} from '$lib/text-size';
	import { textSize } from '$lib/text-size.svelte';

	let selected = $state<TextSizeId>(parseTextSize(null));

	function apply(value: string, persist = true): void {
		selected = parseTextSize(value);
		textSize.apply(selected, persist);
	}

	onMount(() => {
		let stored: string | null = null;
		try {
			stored = localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
		} catch {
			// Use the default when storage is unavailable.
		}
		apply(parseTextSize(stored), false);
	});
</script>

<label class="flex items-center gap-2 text-xs text-neutral-400">
	<span>Text size</span>
	<select
		aria-label="Text size"
		data-testid="text-size-select"
		value={selected}
		onchange={(event) => apply(event.currentTarget.value)}
		class="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-sky-600"
	>
		{#each TEXT_SIZES as size (size.id)}
			<option value={size.id}>{size.name}</option>
		{/each}
	</select>
</label>
