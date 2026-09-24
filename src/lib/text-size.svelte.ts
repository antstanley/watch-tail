/**
 * Text-size preference for the whole page.
 *
 * The header select writes here and the stylesheet does the visual scaling off
 * the `data-text-size` attribute. The root font size the browser resolved is
 * mirrored onto a rune so the rem-derived layout maths — the log column handles
 * — can follow the same scale. A module singleton keeps the header and the
 * viewer in step without threading props.
 */

import { TEXT_SIZE_STORAGE_KEY, parseTextSize } from './text-size';

/** Browser default root font size, and the baseline used while rendering on the server. */
const BASE_ROOT_FONT_PX = 16;

/** Reads the font size the text-size stylesheet resolved, tolerating a bare test DOM. */
function measureRootFontPx(): number {
	const measured = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
	return Number.isFinite(measured) && measured > 0 ? measured : BASE_ROOT_FONT_PX;
}

class TextSizePreference {
	/** Root font size in pixels: 16 until a size is applied on the client. */
	rootFontPx = $state(BASE_ROOT_FONT_PX);

	/**
	 * Applies a text size. The data attribute drives the stylesheet and the
	 * measured root font size keeps the pixel maths in step; the choice is
	 * persisted unless `persist` is false.
	 */
	apply(value: string | null, persist = true): void {
		const id = parseTextSize(value);
		if (typeof document !== 'undefined') {
			document.documentElement.dataset.textSize = id;
			this.rootFontPx = measureRootFontPx();
		}
		if (!persist) return;
		try {
			localStorage.setItem(TEXT_SIZE_STORAGE_KEY, id);
		} catch {
			// Preferences are best-effort: private mode, quota, no storage.
		}
	}
}

/** One preference per page: the header select and the viewer both read it. */
export const textSize = new TextSizePreference();
