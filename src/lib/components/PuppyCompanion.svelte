<script lang="ts">
	import { onMount } from 'svelte';
	import PuppyLogo from './PuppyLogo.svelte';
	import { VIEWBOX } from '$lib/puppy-geometry';
	import { puppy } from '$lib/puppy.svelte';
	import {
		PUPPY_SLOTS,
		nearestSlot,
		slotPosition,
		stepSlot,
		type PuppySlot,
	} from '$lib/puppy-slots';

	type Props = {
		/** Space kept clear above the top slots, so the puppy never covers the header. */
		topInset?: number;
	};

	let { topInset = 0 }: Props = $props();

	/** The puppy's size on screen; the height follows the artwork's aspect ratio. */
	const WIDTH = 128;
	const [, , viewBoxWidth = 1, viewBoxHeight = 1] = VIEWBOX.split(' ').map(Number);
	const HEIGHT = (WIDTH * viewBoxHeight) / viewBoxWidth;
	const MARGIN = 16;
	/** Pointer travel, in pixels, that turns a press into a drag instead of a click. */
	const DRAG_THRESHOLD = 4;

	let viewportWidth = $state(0);
	let viewportHeight = $state(0);
	/** Where the puppy is while held, or `null` when it sits in its slot. */
	let held = $state<{ x: number; y: number } | null>(null);
	/** True once a press has moved far enough to be a drag. */
	let dragging = $state(false);
	/** Set by a drag so the click that ends it is not taken as a click on the puppy. */
	let dragEnded = false;
	let grab = { x: 0, y: 0 };
	let pressedAt = { x: 0, y: 0 };

	const viewport = $derived({ width: viewportWidth, height: viewportHeight });

	function slotAt(slot: PuppySlot): { x: number; y: number } {
		return slotPosition(
			slot,
			viewport,
			{ width: WIDTH, height: HEIGHT },
			{ margin: MARGIN, top: topInset },
		);
	}

	const home = $derived(slotAt(puppy.slot));
	const position = $derived(held ?? home);
	/** The slot a drop would land in right now. */
	const landing = $derived(
		held === null
			? puppy.slot
			: nearestSlot({ x: held.x + WIDTH / 2, y: held.y + HEIGHT / 2 }, viewport),
	);

	onMount(() => puppy.restore());

	function clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), Math.max(min, max));
	}

	function onpointerdown(event: PointerEvent): void {
		if (event.button !== 0) return;
		// No text selection or native drag while the puppy is carried.
		event.preventDefault();
		// Keep receiving the pointer (and the grabbing cursor) however fast it moves.
		try {
			(event.target as Element).setPointerCapture?.(event.pointerId);
		} catch {
			// Capture is a nicety; the window listeners still see every move.
		}
		grab = { x: event.clientX - home.x, y: event.clientY - home.y };
		pressedAt = { x: event.clientX, y: event.clientY };
		dragEnded = false;
		held = { ...home };
	}

	function onpointermove(event: PointerEvent): void {
		if (held === null) return;
		const travel = Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
		if (!dragging && travel < DRAG_THRESHOLD) return;
		dragging = true;
		held = {
			x: clamp(event.clientX - grab.x, 0, viewportWidth - WIDTH),
			y: clamp(event.clientY - grab.y, 0, viewportHeight - HEIGHT),
		};
	}

	function onpointerup(): void {
		if (held === null) return;
		if (dragging) {
			puppy.moveTo(landing);
			// A happy wag for the new spot.
			puppy.wag();
			dragEnded = true;
		}
		held = null;
		dragging = false;
	}

	function onpointercancel(): void {
		held = null;
		dragging = false;
	}

	/** A click that was not the end of a drag: an excited burst of wagging. */
	function onclick(): void {
		if (dragEnded) {
			dragEnded = false;
			return;
		}
		puppy.excite();
	}

	/** Enter or Space pets the puppy; the arrow keys send it to a neighbouring corner. */
	function onkeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			puppy.excite();
			return;
		}
		const next = stepSlot(puppy.slot, event.key);
		if (next === null) return;
		event.preventDefault();
		if (next === puppy.slot) return;
		puppy.moveTo(next);
		puppy.wag();
	}
</script>

<svelte:window
	bind:innerWidth={viewportWidth}
	bind:innerHeight={viewportHeight}
	{onpointermove}
	{onpointerup}
	{onpointercancel}
/>

{#if puppy.shown}
	{#if dragging}
		<!-- The corners it can land in, the current landing spot highlighted. -->
		{#each PUPPY_SLOTS as slot (slot)}
			{@const spot = slotAt(slot)}
			<div
				class="slot rounded-2xl border-2 border-dashed {slot === landing
					? 'border-sky-400 bg-sky-400/15'
					: 'border-neutral-500/60 bg-neutral-500/10'}"
				style="transform: translate({spot.x}px, {spot.y}px); width: {WIDTH}px; height: {HEIGHT}px"
				data-testid="puppy-slot"
				data-slot={slot}
				data-landing={slot === landing ? 'true' : undefined}
			></div>
		{/each}
	{/if}

	<div
		role="button"
		tabindex="0"
		aria-label="The watch-tail puppy. Click to make it wag; drag it, or use the arrow keys, to move it to another corner."
		class="companion rounded-2xl outline-offset-2 focus-visible:outline-2 focus-visible:outline-sky-500"
		class:dragging
		style="transform: translate({position.x}px, {position.y}px)"
		data-testid="puppy-companion"
		data-slot={puppy.slot}
		{onpointerdown}
		{onclick}
		{onkeydown}
	>
		<PuppyLogo
			wag="off"
			pulse={puppy.pulse}
			excite={puppy.excitement}
			marks={false}
			size={WIDTH}
			title="The watch-tail puppy"
		/>
	</div>
{/if}

<style>
	.companion,
	.slot {
		position: fixed;
		top: 0;
		left: 0;
	}

	.companion {
		z-index: 50;
		/* Only the painted sticker catches the pointer (below), so the space around it stays click-through. */
		pointer-events: none;
		touch-action: none;
		/* A little overshoot as it springs into a corner. */
		transition: transform 320ms cubic-bezier(0.34, 1.4, 0.64, 1);
	}

	.companion.dragging {
		transition: none;
	}

	.companion :global(svg) {
		pointer-events: none;
	}

	.companion :global(svg > g) {
		pointer-events: visiblePainted;
		cursor: grab;
	}

	.companion.dragging :global(svg > g) {
		cursor: grabbing;
	}

	.slot {
		z-index: 40;
		pointer-events: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.companion {
			transition: none;
		}
	}
</style>
