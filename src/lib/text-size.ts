/**
 * Text sizes offered in the header, for readers who need the interface larger.
 *
 * The actual font sizes live in `text-size.css`: they scale the root element so
 * every rem-based size follows together. Keeping only the ids and labels here
 * leaves one source of truth for what each option looks like.
 */
export const TEXT_SIZES = [
	{ id: 'small', name: 'Small' },
	{ id: 'default', name: 'Default' },
	{ id: 'large', name: 'Large' },
	{ id: 'xlarge', name: 'Extra large' },
] as const;
export type TextSizeId = (typeof TEXT_SIZES)[number]['id'];
export const TEXT_SIZE_STORAGE_KEY = 'watch-tail:text-size';

/** Unknown or obsolete preferences fall back to Default. */
export function parseTextSize(value: string | null): TextSizeId {
	return TEXT_SIZES.find((size) => size.id === value)?.id ?? 'default';
}
