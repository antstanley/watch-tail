<script lang="ts">
	import './layout.css';
	import TextSizeSelect from '$lib/components/TextSizeSelect.svelte';
	import ThemeSelect from '$lib/components/ThemeSelect.svelte';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>watch-tail</title>
</svelte:head>

<!-- The shell owns the viewport: no centred max-width, no page scrolling. Panes fill the rest. -->
<div
	class="flex h-dvh min-h-[30rem] flex-col overflow-hidden bg-neutral-950 font-sans text-neutral-100 antialiased selection:bg-sky-900/60"
>
	<header class="flex-none border-b border-neutral-900 bg-neutral-950/90">
		<div class="flex w-full items-baseline gap-3 px-3 py-2 sm:px-4">
			<span class="text-sm font-semibold tracking-tight">
				watch<span class="text-sky-400">-tail</span>
			</span>
			<span class="hidden text-xs text-neutral-500 sm:inline">
				Tail CloudWatch Logs in the browser
			</span>
			<div class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
				<TextSizeSelect />
				<ThemeSelect />
			</div>
		</div>
	</header>

	<main class="flex min-h-0 w-full flex-1 flex-col gap-3 px-3 py-3 sm:px-4">
		{@render children()}
	</main>
</div>
