/**
 * Pure helpers for the drag-resizable columns in the UI.
 *
 * The components own the pointer events and the persistence; everything that can
 * be reasoned about without a DOM lives here so it can be unit tested.
 */

/** `localStorage` keys, prefixed so they are easy to spot in a browser. */
export const STORAGE_KEYS = {
	sidebarWidth: 'watch-tail:sidebar-width',
	sidebarOpen: 'watch-tail:sidebar-open',
	prefixWidth: 'watch-tail:prefix-width',
	timestampWidth: 'watch-tail:timestamp-width',
	groupWidth: 'watch-tail:group-width',
	wrap: 'watch-tail:wrap',
	jsonView: 'watch-tail:json-view',
	chartOpen: 'watch-tail:chart-open',
	groupRequests: 'watch-tail:group-requests',
} as const;

/** Default width of the group-list pane, in rem (matches the original layout). */
export const SIDEBAR_WIDTH = { defaultRem: 22, minRem: 16, maxVw: 44 } as const;

/** Width constraints for the log line prefix (timestamp + stream name). */
export const PREFIX_WIDTH = { defaultRem: 14, minRem: 4, maxRem: 40 } as const;

/** Arrow-key step for both resizers, in pixels. */
export const RESIZE_STEP_PX = 16;

/** Clamps `value` into `[min, max]`; non-finite input falls back to `min`. */
export function clampWidth(value: number, min: number, max: number): number {
	const lower = Math.min(min, max);
	const upper = Math.max(min, max);
	if (Number.isNaN(value)) return lower;
	return Math.min(Math.max(value, lower), upper);
}

/**
 * Reads a persisted width.
 *
 * Stored values are CSS pixels, so this returns a number or `fallback` when the
 * value is missing, unreadable or outside the allowed range.
 */
export function parseStoredWidth(
	raw: string | null | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (typeof raw !== 'string' || raw.trim() === '') return clampWidth(fallback, min, max);
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return clampWidth(fallback, min, max);
	return clampWidth(parsed, min, max);
}

/** Width for a left-edge drag: the handle moves right, the column grows. */
export function widthFromPointer(input: {
	startWidth: number;
	startX: number;
	currentX: number;
	min: number;
	max: number;
}): number {
	const { startWidth, startX, currentX, min, max } = input;
	return clampWidth(startWidth + (currentX - startX), min, max);
}

/** Width after an arrow key: ArrowLeft shrinks, ArrowRight grows, others are ignored. */
export function widthFromKey(input: {
	width: number;
	key: string;
	step?: number;
	min: number;
	max: number;
}): number {
	const { width, key, step = RESIZE_STEP_PX, min, max } = input;
	if (key !== 'ArrowLeft' && key !== 'ArrowRight') return clampWidth(width, min, max);
	const delta = key === 'ArrowLeft' ? -step : step;
	return clampWidth(width + delta, min, max);
}

/** Converts a CSS pixel width to `rem` for use in a Tailwind `style` attribute. */
export function pxToRem(px: number, rootFontSize = 16): string {
	const rem = px / rootFontSize;
	return `${Number.isInteger(rem) ? rem : Number(rem.toFixed(3))}rem`;
}

/** Parses a `rem` value into CSS pixels. */
export function remToPx(rem: number, rootFontSize = 16): number {
	return rem * rootFontSize;
}
