<script lang="ts">
	/**
	 * The chart itself: a scatter of event counts over time, one series per level,
	 * with a time brush.
	 *
	 * This component is the only place that imports layerchart, and it is loaded
	 * on demand by `EventScatterPanel`, so the charting library is never part of
	 * the first load. layerchart renders client-side only: its internals touch
	 * `window` while importing and its `ssr: true` path overflows the stack, so the
	 * server sends the wrapper and the chart appears once mounted.
	 */
	import { ScatterChart, Points, Tooltip, type BrushState, type ChartState } from 'layerchart';
	import { SERIES_LEVEL_COLOR } from '$lib/series-buckets';
	import type { SeriesPoint, SeriesMetric } from '$lib/types';

	/** A brushed time range, in epoch milliseconds. */
	export type BrushRange = { from: number; to: number };

	type Props = {
		onSelect?: (point: SeriesPoint) => void;
		metric?: SeriesMetric;
		/** Bucketed counts for the window; one row per bucket, group and level. */
		points?: SeriesPoint[];
		/** Inclusive start of the window, epoch ms. */
		from?: number;
		/** Inclusive end of the window, epoch ms. */
		to?: number;
		/** Chart height in px. */
		height?: number;
		/** True to fill the parent's height instead of using `height`. */
		fill?: boolean;
		/** Called with the brushed range when the drag ends, or `null` on clear. */
		onBrush?: (range: BrushRange | null) => void;
		/** Called while dragging, for a preview that does not re-scope anything. */
		onBrushPreview?: (range: BrushRange | null) => void;
	};

	let {
		metric = 'count',
		points = [],
		from = 0,
		to = 0,
		height = 200,
		fill = false,
		onBrush,
		onBrushPreview,
		onSelect,
	}: Props = $props();

	/**
	 * layerchart's series shape: a key, a label, a colour and the rows of that
	 * series. One series per level is what makes a spike readable as errors or as
	 * noise.
	 */
	let series = $derived.by(() => {
		const byLevel = new Map<string, SeriesPoint[]>();
		for (const point of points) {
			const bucket = byLevel.get(point.level);
			if (bucket === undefined) byLevel.set(point.level, [point]);
			else bucket.push(point);
		}
		return [...byLevel.entries()].map(([level, rows]) => ({
			key: level,
			label: level,
			color: SERIES_LEVEL_COLOR[level as keyof typeof SERIES_LEVEL_COLOR],
			data: rows,
		}));
	});

	/** Keep the slowest request clear of the chart edge, including all-zero spans. */
	let durationCeiling = $derived(
		Math.max(1, points.reduce((max, point) => Math.max(max, point.durationMs ?? 0), 0) * 1.1),
	);

	/** layerchart's chart context, which owns the brush state. */
	let chartContext = $state<ChartState | undefined>(undefined);

	/** Reads a brushed domain pair into epoch milliseconds. */
	function readBrush(brush: BrushState): BrushRange | null {
		const [start, end] = brush.x ?? [];
		if (!brush.active || start === null || start === undefined) return null;
		if (end === null || end === undefined) return null;
		const fromMs = start instanceof Date ? start.getTime() : Number(start);
		const toMs = end instanceof Date ? end.getTime() : Number(end);
		if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
		return { from: Math.min(fromMs, toMs), to: Math.max(fromMs, toMs) };
	}

	/**
	 * layerchart fires `onChange` for every drag move and `onBrushEnd` once on
	 * release. Only the release re-scopes the log view: acting on every move would
	 * restart the stream and reload the chart while the pointer is still down.
	 */
	function handleBrushMove(event: { brush: BrushState }): void {
		onBrushPreview?.(readBrush(event.brush));
	}

	/** The gesture is over: this is the range to zoom to. */
	function handleBrushEnd(event: { brush: BrushState }): void {
		onBrushPreview?.(null);
		onBrush?.(readBrush(event.brush));
	}

	/** Clears the brush and any zoom it applied. */
	export function reset(): void {
		chartContext?.brush?.reset();
		onBrush?.(null);
	}

	/** x axis tick label: wall clock time. */
	function clockLabel(value: unknown): string {
		if (value === null || value === undefined) return '';
		const ms = value instanceof Date ? value.getTime() : Number(value);
		if (!Number.isFinite(ms)) return '';
		return new Date(ms).toISOString().slice(11, 19);
	}
</script>

<div
	class="w-full {fill ? 'h-full' : ''}"
	style={fill ? undefined : `height: ${height}px`}
	data-testid="scatter-chart"
>
	<ScatterChart
		bind:context={chartContext}
		data={points}
		x={(point: SeriesPoint) => new Date(point.t)}
		y={metric === 'duration' ? 'durationMs' : 'events'}
		yDomain={metric === 'duration' ? [0, durationCeiling] : undefined}
		{series}
		xDomain={[new Date(from), new Date(to)]}
		padding={{ top: 8, right: 12, bottom: 24, left: metric === 'duration' ? 72 : 40 }}
		grid={{ x: true, y: true }}
		props={{
			points: { r: 3, stroke: 'var(--color-neutral-950)', strokeWidth: 1, fillOpacity: 0.9 },
			// Per-axis config lives under `props`: an `axis={{ x, y }}` object is
			// silently ignored by layerchart 2.5.
			xAxis: { format: clockLabel, tickSpacing: 90, tickOcclusion: true },
			yAxis: {
				format:
					metric === 'duration' ? (value: number) => `${value.toLocaleString()} ms` : 'integer',
				tickSpacing: 24,
				ticks: 4,
			},
		}}
		brush={{
			axis: 'x',
			// The host re-scopes its own log view; layerchart must not also zoom.
			zoomOnBrush: false,
			// A thirty second floor keeps a small drag from zooming to a sliver of a
			// millisecond.
			minExtent: { x: 30_000 },
			clickToReset: true,
			onChange: handleBrushMove,
			onBrushEnd: handleBrushEnd,
		}}
	>
		{#snippet marks({ context })}
			{#each context.series.visibleSeries as series (series.key)}
				<Points seriesKey={series.key} r={5}>
					{#snippet children({ points })}
						{#each points as point}
							<circle
								cx={point.x}
								cy={point.y}
								r={point.r}
								fill={series.color}
								stroke="var(--color-neutral-950)"
								stroke-width="1"
								class="cursor-pointer focus:stroke-neutral-100 focus:stroke-2"
								role="button"
								tabindex="0"
								data-testid="scatter-point"
								aria-label={`Show ${point.data.requestId ?? `${point.data.events} ${point.data.level} events`} in ${point.data.group} at ${clockLabel(point.data.t)}`}
								onpointerdowncapture={(event) => event.stopPropagation()}
								onclick={(event) => {
									event.stopPropagation();
									onSelect?.(point.data);
								}}
								onkeydown={(event) => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										event.stopPropagation();
										onSelect?.(point.data);
									}
								}}
							/>
						{/each}
					{/snippet}
				</Points>
			{/each}
		{/snippet}
		{#snippet tooltip()}
			<!--
				The tooltip is styled here instead of being left to layerchart: its own
				background and text colour come from `--color-surface-*` variables that
				only its framework presets (shadcn-svelte, Skeleton, daisyUI) define, so
				without one the tooltip renders fully transparent with black text - on
				this dark chart that is unreadable. The classes below are Tailwind
				utilities, which come after layerchart's `@layer components`, so they win.
			-->
			<Tooltip.Root
				classes={{
					container:
						'rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 shadow-lg',
					content: 'text-xs',
				}}
			>
				{#snippet children({ data }: { data: SeriesPoint })}
					<Tooltip.Header value={data.level} color={SERIES_LEVEL_COLOR[data.level]} />
					<Tooltip.List>
						<Tooltip.Item label="time" value={data.t} format={clockLabel} />
						<Tooltip.Item label="group" value={data.group} />
						{#if metric === 'duration'}
							<Tooltip.Item label="request" value={data.requestId ?? ''} />
							<Tooltip.Item
								label="duration (ms)"
								value={data.durationMs ?? 0}
								format={(value: number) =>
									value.toLocaleString(undefined, { maximumFractionDigits: 3 })}
							/>
						{:else}
							<Tooltip.Item label="events" value={data.events} format="integer" />
						{/if}
					</Tooltip.List>
				{/snippet}
			</Tooltip.Root>
		{/snippet}
	</ScatterChart>
</div>

<style>
	/* Axis labels inherit the palette without an SVG outline obscuring small text. */
	.w-full :global(.lc-text) {
		fill: var(--color-neutral-400);
		stroke: none;
	}

	.w-full :global(.lc-highlight-point),
	.w-full :global(.lc-highlight-line) {
		pointer-events: none;
	}
</style>
