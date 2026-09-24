import { describe, expect, test } from 'vitest';
import {
	HISTORIC_PRESETS,
	PRESET_LABELS,
	describeWindow,
	formatWindowBound,
	fromDateTimeLocal,
	isHistoricPreset,
	presetDurationMs,
	presetLabel,
	toDateTimeLocal,
} from './time-range';

describe('presets', () => {
	test('lists the documented presets with labels', () => {
		expect([...HISTORIC_PRESETS]).toEqual(['15m', '1h', '3h', '12h', '24h', '5d']);
		for (const preset of HISTORIC_PRESETS) {
			expect(PRESET_LABELS[preset].length).toBeGreaterThan(0);
			expect(presetDurationMs(preset)).toBeGreaterThan(0);
		}
		expect(presetDurationMs('5d')).toBe(5 * 24 * 60 * 60 * 1000);
		expect(isHistoricPreset('24h')).toBe(true);
		expect(isHistoricPreset('24')).toBe(false);
		expect(presetLabel('3h')).toBe('3 hours');
		expect(presetLabel('7h')).toBe('7h');
	});
});

describe('datetime-local conversion', () => {
	test('round-trips an epoch value through the input format', () => {
		const value = Date.UTC(2024, 4, 10, 12, 34, 0);
		const local = new Date(value);
		local.setSeconds(0, 0);
		const text = toDateTimeLocal(local.getTime());

		expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		expect(fromDateTimeLocal(text)).toBe(local.getTime());
	});

	test('rejects empty and unparsable input', () => {
		expect(fromDateTimeLocal('')).toBeNull();
		expect(fromDateTimeLocal('   ')).toBeNull();
		expect(fromDateTimeLocal('not a date')).toBeNull();
	});
});

describe('formatWindowBound', () => {
	const now = Date.UTC(2024, 4, 10, 12, 0, 0);
	test('shows a bare time for today and a dated time otherwise', () => {
		expect(formatWindowBound(now, now)).toMatch(/^\d{2}:\d{2}$/);
		expect(formatWindowBound(now - 3 * 24 * 60 * 60 * 1000, now)).not.toMatch(/^\d{2}:\d{2}$/);
	});
});

describe('describeWindow', () => {
	const now = Date.UTC(2024, 4, 10, 12, 0, 0);

	test('describes a live tail before the ready frame arrives', () => {
		expect(describeWindow(null, now)).toMatchObject({
			mode: 'live',
			preset: null,
			from: null,
			to: null,
		});
	});

	test('describes a live window with its start time', () => {
		const summary = describeWindow({ mode: 'live', startTime: now - 60_000, endTime: null }, now);
		expect(summary.mode).toBe('live');
		expect(summary.from).toBeNull();
		expect(summary.to).toBeNull();
		expect(summary.title).toContain('Live since');
	});

	test('names the preset for a historic window', () => {
		const summary = describeWindow(
			{
				mode: 'historic',
				startTime: now - 24 * 60 * 60 * 1000,
				endTime: now,
				preset: '24h',
				clamped: false,
			},
			now,
		);
		expect(summary.mode).toBe('historic');
		expect(summary.preset).toBe('24 hours');
		expect(summary.from).not.toBeNull();
		expect(summary.to).not.toBeNull();
		expect(summary.clamped).toBe(false);
	});

	test('falls back to explicit bounds for a custom window', () => {
		const summary = describeWindow(
			{ mode: 'historic', startTime: now - 90 * 60 * 1000, endTime: now, preset: null },
			now,
		);
		expect(summary.preset).toBeNull();
		expect(summary.from).not.toBeNull();
		expect(summary.to).not.toBeNull();
	});

	test('flags a clamped window', () => {
		const summary = describeWindow(
			{ mode: 'historic', startTime: now - 1000, endTime: now, preset: '15m', clamped: true },
			now,
		);
		expect(summary.clamped).toBe(true);
		expect(summary.title).toContain('14 days');
	});
});
