<script lang="ts">
	import { Dog } from '@lucide/svelte';
	import { puppy } from '$lib/puppy.svelte';
</script>

<button
	type="button"
	onclick={() => puppy.toggle()}
	aria-pressed={puppy.shown}
	title={puppy.shown ? 'Send the puppy away' : 'Bring out the puppy'}
	data-testid="puppy-toggle"
	class="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors {puppy.shown
		? 'border-sky-700 bg-sky-950/60 text-sky-200'
		: 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'}"
>
	<Dog class="size-3.5" />
	Puppy
</button>
