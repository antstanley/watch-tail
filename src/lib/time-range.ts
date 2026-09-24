/**
 * Historic time-range helpers shared by the server and the browser.
 *
 * The preset list lives here so the API and the picker can never drift apart.
 * Everything is pure; nothing here touches the DOM.
 */

/** Preset windows offered by the historic range picker. */
export const HISTORIC_PRESETS = ['15m', '1h', '3h', '12h', '24h', '5d'] as const;
export type HistoricPreset = (typeof HISTORIC_PRESETS)[number];

/** Tail either the live end of a group or a fixed historic window. */
export type LogMode = 'live' | 'historic';

/** Human labels for the preset chips. */
export const PRESET_LABELS: Record<HistoricPreset, string> = {
	'15m': '15 min',
	'1h': '1 hour',
	'3h': '3 hours',
	'12h': '12 hours',
	'24h': '24 hours',
	'5d': '5 days',
};

const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
	w: 7 * 24 * 60 * 60 * 1000,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i;

/** True when the value is one of the offered presets. */
export function isHistoricPreset(value: string): value is HistoricPreset {
	return (HISTORIC_PRESETS as readonly string[]).includes(value);
}

/** Duration of a preset window in milliseconds. */
export function presetDurationMs(preset: HistoricPreset): number {
	const match = DURATION_PATTERN.exec(preset);
	const amount = match === null ? 0 : Number(match[1]);
	const unit = match === null ? 0 : (UNIT_MS[match[2].toLowerCase()] ?? 0);
	return amount * unit;
}

/** Label for a preset, falling back to the raw value. */
export function presetLabel(preset: string): string {
	return isHistoricPreset(preset) ? PRESET_LABELS[preset] : preset;
}

/**
 * Converts epoch milliseconds to the `YYYY-MM-DDTHH:mm` string a
 * `datetime-local` input expects, in the browser's local time zone.
 */
/** Zero-pads a number for the `datetime-local` format. */
function pad(value: number): string {
	return String(value).padStart(2, '0');
}

export function toDateTimeLocal(epochMs: number): string {
	const date = new Date(epochMs);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Converts a `datetime-local` value back to epoch milliseconds.
 *
 * The string is timezone-less, so it is interpreted in local time; `NaN` input
 * returns `null`.
 */
export function fromDateTimeLocal(value: string): number | null {
	if (typeof value !== 'string' || value.trim() === '') return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

/** Formats a window bound for display, for example `14:05` or `10 May 14:05`. */
export function formatWindowBound(epochMs: number, now: number): string {
	const date = new Date(epochMs);
	const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
	const sameDay = new Date(now).toDateString() === date.toDateString();
	if (sameDay) return time;
	const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
	return `${day} ${time}`;
}

/** What the toolbar chip needs to describe the active window. */
export type WindowSummary = {
	mode: LogMode;
	/** Preset the window came from, or `null` for a custom range or a live tail. */
	preset: string | null;
	/** Formatted start bound, or `null` for a live tail. */
	from: string | null;
	/** Formatted end bound, or `null` for a live tail. */
	to: string | null;
	title: string;
	/** True when the server clamped the requested window. */
	clamped: boolean;
};

/**
 * Describes the window reported by the server's `ready` event.
 *
 * Live tails report the lookback window; historic tails report the resolved
 * range, naming the preset when one was used.
 */
export function describeWindow(
	ready: {
		mode?: LogMode;
		startTime?: number;
		endTime?: number | null;
		preset?: string | null;
		clamped?: boolean;
	} | null,
	now: number,
): WindowSummary {
	if (ready === null || ready.startTime === undefined) {
		return {
			mode: 'live',
			preset: null,
			from: null,
			to: null,
			title: 'Tailing new events',
			clamped: false,
		};
	}
	const clamped = ready.clamped === true;
	if (ready.mode !== 'historic' || ready.endTime === null || ready.endTime === undefined) {
		return {
			mode: 'live',
			preset: null,
			from: null,
			to: null,
			title: `Live since ${formatWindowBound(ready.startTime, now)}`,
			clamped,
		};
	}
	const from = formatWindowBound(ready.startTime, now);
	const to = formatWindowBound(ready.endTime, now);
	const preset =
		ready.preset === null || ready.preset === undefined ? null : presetLabel(ready.preset);
	return {
		mode: 'historic',
		preset,
		from,
		to,
		title: clamped
			? 'Historic window, clamped to the last 14 days that CloudWatch Logs keeps'
			: 'Historic window',
		clamped,
	};
}
