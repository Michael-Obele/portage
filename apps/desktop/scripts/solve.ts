/**
 * Solve for the OKLCH lightness that hits a contrast target.
 *
 * Guessing new token values is how a palette drifts. This binary-searches L at a
 * fixed chroma and hue, so every replacement in `layout.css` is the *minimum*
 * change that reaches the target and no further.
 *
 * Run: `bun run scripts/solve.ts`
 */
import { readFileSync } from 'node:fs';

type Rgb = [number, number, number];

function toRgb(l: number, c: number, h: number): Rgb {
	const hRad = (h * Math.PI) / 180;
	const a = c * Math.cos(hRad);
	const b = c * Math.sin(hRad);
	const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = l - 0.0894841775 * a - 1.291485548 * b;
	const l3 = l_ ** 3;
	const m3 = m_ ** 3;
	const s3 = s_ ** 3;
	const lin: Rgb = [
		4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
		-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
		-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
	];
	const enc = (v: number): number => {
		const x = Math.min(1, Math.max(0, v));
		return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
	};
	return [enc(lin[0]), enc(lin[1]), enc(lin[2])];
}

function lum(l: number, c: number, h: number): number {
	const ch = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	const [r, g, b] = toRgb(l, c, h).map(ch);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function cr(a: number, b: number): number {
	const hi = Math.max(a, b);
	const lo = Math.min(a, b);
	return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(`${import.meta.dir}/../src/routes/layout.css`, 'utf8');

function token(block: ':root' | '.dark', name: string): { l: number; c: number; h: number } {
	const start = css.indexOf(`${block} {`);
	const slice = css.slice(start, css.indexOf('\n}', start));
	const line = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`).exec(slice);
	if (!line) throw new Error(`no token ${name} in ${block}`);
	return { l: Number(line[1]), c: Number(line[2]), h: Number(line[3]) };
}

/** The L at which `fg` reaches `target` against `bgL`, staying on the same hue. */
function solve(
	fgC: number,
	fgH: number,
	bgL: number,
	bgC: number,
	bgH: number,
	target: number,
	darker: boolean,
): number {
	let lo = 0;
	let hi = 1;
	const bg = lum(bgL, bgC, bgH);
	for (let i = 0; i < 60; i += 1) {
		const mid = (lo + hi) / 2;
		const value = cr(lum(mid, fgC, fgH), bg);
		// `darker` means contrast rises as L falls (light background).
		if (darker ? value >= target : value <= target) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

interface Job {
	label: string;
	theme: ':root' | '.dark';
	fg: string;
	bg: string;
	target: number;
	/** Contrast rises as L falls (a dark foreground on a light surface). */
	darker: boolean;
}

const jobs: Job[] = [
	// Light: muted text is the most used tone in the app and it was only 4.4:1.
	{ label: 'LIGHT muted-foreground on muted', theme: ':root', fg: 'muted-foreground', bg: 'muted', target: 7.1, darker: true },
	{ label: 'LIGHT destructive on card', theme: ':root', fg: 'destructive', bg: 'card', target: 7.1, darker: true },
	{ label: 'LIGHT destructive on background', theme: ':root', fg: 'destructive', bg: 'background', target: 7.1, darker: true },
	{ label: 'LIGHT state-copying fill (white text)', theme: ':root', fg: 'state-copying', bg: 'foreground', target: 7.1, darker: true },
	{ label: 'LIGHT state-verified fill (white text)', theme: ':root', fg: 'state-verified', bg: 'foreground', target: 7.1, darker: true },
	{ label: 'LIGHT state-failed fill (white text)', theme: ':root', fg: 'state-failed', bg: 'foreground', target: 7.1, darker: true },
	{ label: 'LIGHT state-skipped fill (white text)', theme: ':root', fg: 'state-skipped', bg: 'foreground', target: 7.1, darker: true },
	{ label: 'LIGHT state-copying as text', theme: ':root', fg: 'state-copying', bg: 'background', target: 7.1, darker: true },
	{ label: 'LIGHT state-verified as text', theme: ':root', fg: 'state-verified', bg: 'background', target: 7.1, darker: true },
	{ label: 'LIGHT state-failed as text', theme: ':root', fg: 'state-failed', bg: 'background', target: 7.1, darker: true },
	{ label: 'LIGHT input edge (non-text)', theme: ':root', fg: 'input', bg: 'background', target: 3.05, darker: true },
	{ label: 'LIGHT border-strong (non-text)', theme: ':root', fg: 'border', bg: 'background', target: 3.05, darker: true },
	// Dark: muted text was 6.0 on `muted`, and destructive text 6.4.
	{ label: 'DARK muted-foreground on muted', theme: '.dark', fg: 'muted-foreground', bg: 'muted', target: 7.1, darker: false },
	{ label: 'DARK destructive on background', theme: '.dark', fg: 'destructive', bg: 'background', target: 7.1, darker: false },
	{ label: 'DARK destructive on card', theme: '.dark', fg: 'destructive', bg: 'card', target: 7.1, darker: false },
	{ label: 'DARK state-failed fill', theme: '.dark', fg: 'state-failed', bg: 'background', target: 7.1, darker: false },
	{ label: 'DARK input edge (non-text)', theme: '.dark', fg: 'input', bg: 'background', target: 3.05, darker: false },
	{ label: 'DARK border-strong (non-text)', theme: '.dark', fg: 'border', bg: 'background', target: 3.05, darker: false },
];

for (const job of jobs) {
	let fg: { l: number; c: number; h: number };
	let bg: { l: number; c: number; h: number };
	try {
		fg = token(job.theme, job.fg);
		bg = token(job.theme, job.bg);
	} catch (error) {
		console.log(`${job.label}: ${(error as Error).message}`);
		continue;
	}
	// `input` and `border` carry alpha; solve against the page instead.
	const solved = solve(fg.c, fg.h, bg.l, bg.c, bg.h, job.target, job.darker);
	console.log(
		`${job.label}\n   --${job.fg}: oklch(${solved.toFixed(3)} ${fg.c} ${fg.h})   (was L=${fg.l})`,
	);
}
