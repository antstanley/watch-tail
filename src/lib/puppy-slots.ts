/**
 * Where the puppy companion can sit: one of the four screen corners.
 *
 * Pure geometry, so the drag-and-snap behaviour can be tested without a DOM:
 * where each slot puts the puppy, which slot a drop lands in, and where the
 * arrow keys send it.
 */

export const PUPPY_SLOTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

export type PuppySlot = (typeof PUPPY_SLOTS)[number];

export const DEFAULT_PUPPY_SLOT: PuppySlot = 'bottom-right';

export const PUPPY_SLOT_STORAGE_KEY = 'watch-tail:puppy-slot';

type Size = { width: number; height: number };
type Point = { x: number; y: number };

/** Reads a stored slot, falling back to the default for anything unknown. */
export function parsePuppySlot(value: string | null): PuppySlot {
	return PUPPY_SLOTS.find((slot) => slot === value) ?? DEFAULT_PUPPY_SLOT;
}

/**
 * Top-left corner of the puppy in a slot. `margin` keeps it off the edges and
 * `top` is the space reserved above it (the header), so the top slots never
 * cover the header controls.
 */
export function slotPosition(
	slot: PuppySlot,
	viewport: Size,
	puppy: Size,
	insets: { margin: number; top: number },
): Point {
	const left = slot.endsWith('left');
	const upper = slot.startsWith('top');
	return {
		x: left ? insets.margin : Math.max(insets.margin, viewport.width - puppy.width - insets.margin),
		y: upper
			? insets.top + insets.margin
			: Math.max(insets.top + insets.margin, viewport.height - puppy.height - insets.margin),
	};
}

/** The slot a drop lands in: the corner of the screen quarter the puppy's centre is in. */
export function nearestSlot(centre: Point, viewport: Size): PuppySlot {
	const vertical = centre.y < viewport.height / 2 ? 'top' : 'bottom';
	const horizontal = centre.x < viewport.width / 2 ? 'left' : 'right';
	return `${vertical}-${horizontal}`;
}

/** Where an arrow key sends the puppy; `null` for any other key. */
export function stepSlot(slot: PuppySlot, key: string): PuppySlot | null {
	const [vertical, horizontal] = slot.split('-') as ['top' | 'bottom', 'left' | 'right'];
	switch (key) {
		case 'ArrowUp':
			return `top-${horizontal}`;
		case 'ArrowDown':
			return `bottom-${horizontal}`;
		case 'ArrowLeft':
			return `${vertical}-left`;
		case 'ArrowRight':
			return `${vertical}-right`;
		default:
			return null;
	}
}
