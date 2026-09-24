<script lang="ts">
	import { untrack } from 'svelte';
	import {
		CREAM,
		GOLD,
		HEAD_SCALE,
		HEAD_TRANSFORM,
		INK,
		LINE,
		OUTLINE,
		SHADE,
		STICKER,
		TAIL_PIVOT,
		VIEWBOX,
		body,
		brows,
		ears,
		eyes,
		farLegs,
		haunch,
		head,
		legBridge,
		mouth,
		muzzle,
		nearLegs,
		nose,
		tail,
		wagMarks,
	} from '$lib/puppy-geometry';

	type Props = {
		/** When the tail wags on its own: all the time, while hovered, or never. */
		wag?: 'always' | 'hover' | 'off';
		/** Change this number to trigger a short burst of wagging. */
		pulse?: number;
		/** Change this number for an excited burst: faster, wider and longer. */
		excite?: number;
		/** Duration of one full wag (left, right, back to centre), in ms. */
		speed?: number;
		/** How far the tail swings either side of centre, in degrees. */
		amplitude?: number;
		/** Show the drawn wag marks while the tail is still (flat style only). */
		marks?: boolean;
		/** Die-cut sticker look: a white margin and a soft drop shadow. */
		sticker?: boolean;
		size?: number | string;
		title?: string;
	};

	let {
		wag = 'hover',
		pulse = 0,
		excite = 0,
		speed = 520,
		amplitude = 14,
		marks = true,
		sticker = true,
		size = 64,
		title = 'A Labrador puppy wagging its tail',
	}: Props = $props();

	/** Full wags in an excited burst, and how much faster and wider they swing. */
	const EXCITED_CYCLES = 5;
	const EXCITED_SPEEDUP = 0.5;
	const EXCITED_EXTRA_SWING = 10;

	let hovering = $state(false);
	let bursts = $state(0);
	let active = $state(false);
	/** True while the excited wag is the one running. */
	let excited = $state(false);
	let excitedLeft = $state(0);
	/** An excited burst asked for mid-wag, waiting for the tail to reach centre. */
	let excitePending = $state(false);

	const wants = $derived(
		wag === 'always' ||
			(wag === 'hover' && hovering) ||
			bursts > 0 ||
			excitedLeft > 0 ||
			excitePending,
	);

	$effect(() => {
		if (wants) active = true;
	});

	// Each new pulse value buys two more full wags.
	let seenPulse: number | undefined;
	$effect(() => {
		const p = pulse;
		if (seenPulse !== undefined && p !== seenPulse) bursts = 2;
		seenPulse = p;
	});

	// Each new excite value starts an excited burst. Changing a running animation's
	// speed makes the tail jump, so the excited wag is its own animation, and it only
	// takes over (or hands back) at the end of a cycle, with the tail at centre.
	let seenExcite: number | undefined;
	$effect(() => {
		const e = excite;
		if (seenExcite !== undefined && e !== seenExcite) {
			if (untrack(() => active)) excitePending = true;
			else {
				excited = true;
				excitedLeft = EXCITED_CYCLES;
			}
		}
		seenExcite = e;
	});

	// Only stop or change pace at the end of a cycle, when the tail is back at centre,
	// so it never snaps back mid-swing.
	function oniteration(): void {
		if (bursts > 0) bursts -= 1;
		if (excitePending) {
			excitePending = false;
			excited = true;
			excitedLeft = EXCITED_CYCLES;
			return;
		}
		if (excited) {
			excitedLeft -= 1;
			if (excitedLeft === 0) excited = false;
		}
		if (!wants) active = false;
	}

	const headLine = (w: number) => w / HEAD_SCALE;

	/** Wag timing and swing for the keyframes, plus the point the tail rotates around. */
	const animationVars = $derived(
		`--wag-speed: ${speed}ms; --wag-amp: ${amplitude}deg; ` +
			`--excited-speed: ${speed * EXCITED_SPEEDUP}ms; ` +
			`--excited-amp: ${amplitude + EXCITED_EXTRA_SWING}deg; ` +
			`--tail-pivot: ${TAIL_PIVOT.x}px ${TAIL_PIVOT.y}px`,
	);

	// Several logos can share a page, so each needs its own filter id.
	const uid = $props.id();
	const shadowId = `puppy-shadow-${uid}`;
</script>

<svg
	viewBox={VIEWBOX}
	width={size}
	role="img"
	aria-label={title}
	class:active
	class:excited
	style={animationVars}
	onpointerenter={() => (hovering = true)}
	onpointerleave={() => (hovering = false)}
>
	<title>{title}</title>

	{#if sticker}
		<defs>
			<filter id={shadowId} x="-10%" y="-10%" width="120%" height="130%">
				<feDropShadow dx="0" dy="7" stdDeviation="7" flood-color={INK} flood-opacity="0.3" />
			</filter>
		</defs>

		<!-- 0. The sticker: a white margin around the whole silhouette. It's one group,
		     so the drop shadow is cast by the combined shape and never falls on the
		     sticker itself where the swinging tail overlaps the body. -->
		<g filter="url(#{shadowId})" fill="#fff" stroke="#fff" stroke-width={STICKER}>
			{#each farLegs as d (d)}<path {d} />{/each}
			<path d={body} />
			{#each nearLegs as l (l.d)}<path d={l.d} />{/each}
			<path d={legBridge} stroke="none" />
			<g transform={HEAD_TRANSFORM} stroke-width={headLine(STICKER)}>
				<path d={head} />
				{#each ears as d (d)}<path {d} />{/each}
				<path d={muzzle} />
			</g>
			<g class="tail"><path d={tail} /></g>
		</g>
	{/if}

	<!-- 1. Fat ink silhouette of everything except the tail: the bold outer contour. -->
	<g fill={INK} stroke={INK} stroke-width={OUTLINE}>
		{#each farLegs as d (d)}<path {d} />{/each}
		<path d={body} />
		{#each nearLegs as l (l.d)}<path d={l.d} />{/each}
		<g transform={HEAD_TRANSFORM} stroke-width={headLine(OUTLINE)}>
			<path d={head} />
			{#each ears as d (d)}<path {d} />{/each}
			<path d={muzzle} />
		</g>
	</g>

	<!-- 2. The tail's own silhouette, swinging with it. -->
	<g class="tail" onanimationiteration={oniteration}>
		<path d={tail} fill={INK} stroke={INK} stroke-width={OUTLINE} />
	</g>

	<!-- 3. Colour, back to front. The body is painted over the tail's base, so the
	     pivot stays hidden however far the tail swings. -->
	<g stroke={INK} stroke-width={LINE}>
		{#each farLegs as d (d)}<path {d} fill={SHADE} />{/each}
	</g>

	<g class="tail">
		<path d={tail} fill={GOLD} stroke={INK} stroke-width={LINE} />
	</g>

	<g stroke={INK} stroke-width={LINE}>
		<path d={body} fill={GOLD} />
		<path d={haunch} fill="none" stroke-width="6" />
		{#each nearLegs as l (l.d)}
			<path d={l.d} fill={GOLD} />
			<path d={l.patch} fill={GOLD} stroke="none" />
			<path d={l.toes} fill="none" stroke-width="6" />
		{/each}
	</g>

	<g transform={HEAD_TRANSFORM} stroke={INK} stroke-width={headLine(LINE)}>
		<path d={head} fill={GOLD} />
		{#each ears as d (d)}<path {d} fill={SHADE} />{/each}
		<path d={muzzle} fill={CREAM} />
		<path d={nose} fill={INK} />
		<ellipse cx="-7" cy="25" rx="5" ry="3" fill={CREAM} stroke="none" />
		{#each eyes as e (e.x)}
			<ellipse cx={e.x} cy={e.y} rx="18" ry="21" fill={INK} stroke="none" />
			<ellipse cx={e.x + 7} cy={e.y - 10} rx="7.5" ry="8" fill="#fff" stroke="none" />
			<circle cx={e.x - 8} cy={e.y + 12} r="3" fill="#fff" stroke="none" />
		{/each}
		<g fill="none" stroke-width={headLine(6)}>
			{#each brows as d (d)}<path {d} />{/each}
			<path d={mouth} />
		</g>
	</g>

	<!-- A die-cut sticker is one clean silhouette, so floating marks are flat-style only. -->
	{#if marks && !sticker}
		<g class="marks" fill="none" stroke={INK} stroke-width="8">
			{#each wagMarks as d (d)}<path {d} />{/each}
		</g>
	{/if}
</svg>

<style>
	svg {
		display: block;
		height: auto;
		overflow: visible;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.tail {
		transform-box: view-box;
		transform-origin: var(--tail-pivot);
	}

	.active .tail {
		animation: wag var(--wag-speed) infinite;
	}

	/* A different animation name, so switching restarts it cleanly from centre. */
	.active.excited .tail {
		animation: wag-excited var(--excited-speed) infinite;
	}

	/* Starts and ends at centre, so the wag can stop cleanly after any cycle. */
	@keyframes wag {
		0% {
			transform: rotate(0deg);
			animation-timing-function: ease-out;
		}
		25% {
			transform: rotate(calc(var(--wag-amp) * -1));
			animation-timing-function: ease-in-out;
		}
		75% {
			transform: rotate(var(--wag-amp));
			animation-timing-function: ease-in;
		}
		100% {
			transform: rotate(0deg);
		}
	}

	/* The same swing, only wider (and run faster by the rule above). */
	@keyframes wag-excited {
		0% {
			transform: rotate(0deg);
			animation-timing-function: ease-out;
		}
		25% {
			transform: rotate(calc(var(--excited-amp) * -1));
			animation-timing-function: ease-in-out;
		}
		75% {
			transform: rotate(var(--excited-amp));
			animation-timing-function: ease-in;
		}
		100% {
			transform: rotate(0deg);
		}
	}

	/* The motion itself says "wagging", so the drawn marks step aside. */
	.marks {
		transition: opacity 120ms;
	}
	.active .marks {
		opacity: 0;
	}

	@media (prefers-reduced-motion: reduce) {
		.active .tail,
		.active.excited .tail {
			animation: none;
		}
		.active .marks {
			opacity: 1;
		}
	}
</style>
