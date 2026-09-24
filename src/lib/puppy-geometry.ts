/**
 * SVG geometry for the Labrador puppy companion, ported one-to-one from the p5.js
 * sketch it was designed in. Everything is in that sketch's 800-unit space; the
 * component only lays these shapes out in layers.
 */

export const INK = '#3d2a1e';
export const GOLD = '#ecb667';
export const SHADE = '#cf8d45';
export const CREAM = '#fce7c0';

// Colour-pass line weight, and the extra width the fat outline pass adds.
export const LINE = 9;
export const OUTLINE = LINE + 18;

// The tail pivots here: the point where it grows out of the rump.
export const TAIL_PIVOT = { x: 596, y: 450 };

// Head placement: translate, rotate (degrees), scale. Line weights inside the head
// are divided by HEAD_SCALE so they match the body.
export const HEAD_SCALE = 1.25;
export const HEAD_TRANSFORM = `translate(316 300) rotate(${(-0.14 * 180) / Math.PI}) scale(${HEAD_SCALE})`;

type Step = [number, number] | [number, number, number, number, number, number];

const f = (n: number) => +n.toFixed(2);

// A path of straight [x, y] and cubic [cx1, cy1, cx2, cy2, x, y] steps. Like p5,
// an open path still fills (implicitly closed) but its closing edge is not stroked.
function path(start: [number, number], steps: Step[], close = true): string {
	let d = `M${f(start[0])} ${f(start[1])}`;
	for (const s of steps)
		d += s.length === 2 ? ` L${s.map(f).join(' ')}` : ` C${s.map(f).join(' ')}`;
	return close ? `${d} Z` : d;
}

function leg(x: number, topL = 540, topR = 540) {
	return {
		d: path(
			[x, topL],
			[
				[x, 598],
				[x - 28, 602, x - 34, 640, x + 2, 642],
				[x + 26, 644, x + 50, 644, x + 54, 628],
				[x + 58, 614, x + 52, 604, x + 52, 598],
				[x + 52, topR],
			],
			false,
		),
		// Paints out the belly line where a near leg joins the body.
		patch: `M${x + 4.5} ${topL - 9} L${x + 47.5} ${topR - 9} L${x + 47.5} ${topR + 4} L${x + 4.5} ${topL + 4} Z`,
		toes: `M${x + 4} 628 L${x + 4} 641 M${x + 24} 628 L${x + 24} 642`,
	};
}

export const farLegs = [leg(340), leg(542)].map((l) => l.d);
export const nearLegs = [leg(280, 552, 563.5), leg(488, 568.4, 560)];

export const body = path(
	[262, 430],
	[
		[320, 380, 470, 378, 540, 390],
		[598, 402, 622, 470, 592, 525],
		[566, 566, 500, 572, 430, 568],
		[340, 566, 262, 566, 244, 520],
		[230, 485, 236, 450, 262, 430],
	],
);
export const haunch = 'M486 440 C534 420 582 456 574 520';

/** A point on a cubic Bézier, one axis at a time (p5's `bezierPoint`). */
function bezierPoint(a: number, b: number, c: number, d: number, t: number): number {
	return (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;
}

/** The tangent of a cubic Bézier, one axis at a time (p5's `bezierTangent`). */
function bezierTangent(a: number, b: number, c: number, d: number, t: number): number {
	return 3 * (1 - t) ** 2 * (b - a) + 6 * (1 - t) * t * (c - b) + 3 * t ** 2 * (d - c);
}

// The thick, tapering "otter" tail: offset both sides of a cubic centreline, with
// a round cap at the tip and the base left open so it merges into the rump.
function tailPath(): string {
	const [x0, y0, x1, y1, x2, y2, x3, y3] = [596, 450, 662, 440, 704, 386, 700, 300];
	const n = 40;
	const left: [number, number][] = [];
	const right: [number, number][] = [];
	let tip = { x: 0, y: 0, w: 0, a: 0 };
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		const w = 30 + (14 - 30) * t;
		const x = bezierPoint(x0, x1, x2, x3, t);
		const y = bezierPoint(y0, y1, y2, y3, t);
		const tx = bezierTangent(x0, x1, x2, x3, t);
		const ty = bezierTangent(y0, y1, y2, y3, t);
		const m = Math.hypot(tx, ty) || 1;
		left.push([x - (ty / m) * w, y + (tx / m) * w]);
		right.push([x + (ty / m) * w, y - (tx / m) * w]);
		tip = { x, y, w, a: Math.atan2(tx, -ty) };
	}
	const cap: [number, number][] = [];
	for (let k = 1; k < 12; k++) {
		const a = tip.a - (Math.PI * k) / 12;
		cap.push([tip.x + Math.cos(a) * tip.w, tip.y + Math.sin(a) * tip.w]);
	}
	const pts = [...left, ...cap, ...right.toReversed()];
	return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join(' ');
}
export const tail = tailPath();

// Wag marks bracketing the tail tip: arcs around (700, 314), angles in degrees.
function arc(cx: number, cy: number, r: number, from: number, to: number): string {
	const p = (deg: number) =>
		[cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)].map(f);
	const [sx, sy] = p(from);
	const [ex, ey] = p(to);
	return `M${sx} ${sy} A${r} ${r} 0 0 1 ${ex} ${ey}`;
}
export const wagMarks = [
	arc(700, 314, 56, 196, 246),
	arc(700, 314, 80, 202, 240),
	arc(700, 314, 56, -66, -16),
	arc(700, 314, 80, -60, -22),
];

// Head parts, in head-local coordinates centred on (0, 0).
export const head = path(
	[-112, 10],
	[
		[-120, -72, -62, -112, 0, -112],
		[62, -112, 120, -72, 112, 10],
		[106, 72, 60, 104, 0, 104],
		[-60, 104, -106, 72, -112, 10],
	],
);
export const ears = [-1, 1].map((s) =>
	path(
		[s * 72, -88],
		[
			[s * 120, -96, s * 154, -40, s * 150, 22],
			[s * 147, 66, s * 120, 86, s * 102, 66],
			[s * 82, 44, s * 64, -20, s * 72, -88],
		],
	),
);
export const muzzle = path(
	[-58, 52],
	[
		[-60, 18, -26, 10, 0, 14],
		[26, 10, 60, 18, 58, 52],
		[56, 84, 26, 96, 0, 96],
		[-26, 96, -56, 84, -58, 52],
	],
);
export const nose = path(
	[0, 44],
	[
		[-20, 44, -26, 30, -19, 22],
		[-11, 15, 11, 15, 19, 22],
		[26, 30, 20, 44, 0, 44],
	],
);
export const eyes = [-1, 1].map((s) => ({ x: s * 44, y: -10 }));
export const brows = ['M-68 -44 C-60 -56 -40 -64 -26 -62', 'M68 -44 C60 -56 40 -64 26 -62'];
export const mouth = 'M0 44 L0 58 M0 58 C-4 70 -20 72 -27 62 M0 58 C4 70 20 72 27 62';

// Die-cut sticker border: how far the white margin runs past the ink outline.
export const STICKER = OUTLINE + 36;

// A cutter can't follow every nook, so the sticker margin bridges the gap between
// the front and back legs with a gentle scallop.
export const legBridge = 'M380 548 L500 548 L500 650 C470 636 410 636 380 650 Z';

// Art bounds, with room for the tail to swing and the sticker margin.
export const VIEWBOX = '76 90 784 630';
