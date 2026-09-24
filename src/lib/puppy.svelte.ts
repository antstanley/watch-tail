/**
 * The puppy companion: an optional overlay that wags its tail when something happens.
 *
 * The header button shows and hides it, the layout draws it, and the page and its
 * panels call `wag()` when data arrives or a section collapses or expands. A module
 * singleton keeps them in step without threading props, like the text-size preference.
 */

import {
	DEFAULT_PUPPY_SLOT,
	PUPPY_SLOT_STORAGE_KEY,
	parsePuppySlot,
	type PuppySlot,
} from './puppy-slots';

class PuppyCompanion {
	/** True while the puppy is on screen. */
	shown = $state(false);
	/** Bumped on every wag; the puppy starts a short burst of wagging each time it changes. */
	pulse = $state(0);
	/** Bumped when the puppy is clicked; each change starts an excited burst of wagging. */
	excitement = $state(0);
	/** The screen corner the puppy sits in. */
	slot = $state<PuppySlot>(DEFAULT_PUPPY_SLOT);

	/** Reads the remembered corner; call once on the client. */
	restore(): void {
		try {
			this.slot = parsePuppySlot(localStorage.getItem(PUPPY_SLOT_STORAGE_KEY));
		} catch {
			// Preferences are best-effort: private mode, no storage.
		}
	}

	/** Moves the puppy to a corner and remembers it. */
	moveTo(slot: PuppySlot): void {
		this.slot = slot;
		try {
			localStorage.setItem(PUPPY_SLOT_STORAGE_KEY, slot);
		} catch {
			// Preferences are best-effort: private mode, quota, no storage.
		}
	}

	/** Shows the puppy, or sends it away again. */
	toggle(): void {
		this.shown = !this.shown;
	}

	/**
	 * Asks for a burst of wagging. A no-op while the puppy is hidden. Callers inside
	 * an `$effect` must wrap this in `untrack`, since it reads and writes `pulse`.
	 */
	wag(): void {
		if (this.shown) this.pulse += 1;
	}

	/** Asks for an excited burst: faster, wider and longer. A no-op while hidden. */
	excite(): void {
		if (this.shown) this.excitement += 1;
	}
}

/** One companion per page: the header, the layout and the panels all share it. */
export const puppy = new PuppyCompanion();
