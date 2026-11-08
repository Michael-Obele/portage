/**
 * WCAG contrast, measured rather than assumed.
 *
 * The app claims AAA. That is a measurable statement, so this script does the
 * measurement: it parses the token blocks out of `layout.css`, converts OKLCH to
 * sRGB the way a browser does, composites any alpha over its backing surface,
 * and prints the ratio for every text-on-surface and text-on-fill pair that
 * ships.
 *
 * Run: `bun run scripts/contrast.ts` from `apps/desktop`.
 * Exit code is 1 when any pair misses its target, so a CI gate can use it.
 */

const CSS = `${import.meta.dir}/../src/routes/layout.css`;

/** AAA for normal text; AAA for large text is 4.5. Body here is 13 px, so 7. */
const AAA_TEXT = 7;
/** Non-text (focus ring, input borders, UI edges) under 1.4.11. */
const NON_TEXT = 3;

type Rgb = [number, number, number];

function parseOklch(value: string): { l: number; c: number; h: number; a: number } {
	const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)%)?\s*\)/.exec(
		value,
	);
	if (!match) throw new Error(`not an oklch colour: ${value}`);
	return {
		l: Number(match[1]),
		c: Number(match[2]),
		h: Number(match[3]),
		// Missing alpha is 1. A percentage is how the stylesheet writes it.
		a: match[4] === undefined ? 1 : Number(match[4]) / 100,
	};
}

/** OKLCH -> OKLab -> linear sRGB -> gamma-encoded sRGB in 0..1. */
function oklchToRgb(value: string): Rgb {
	const { l, c, h } = parseOklch(value);
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

	const encode = (v: number): number => {
		const clamped = Math.min(1, Math.max(0, v));
		return clamped <= 0.0031308
			? 12.92 * clamped
			: 1.055 * clamped ** (1 / 2.4) - 0.055;
	};
	return [encode(lin[0]), encode(lin[1]), encode(lin[2])];
}

/** Composite a possibly translucent colour over an opaque one. */
function over(fg: string, bg: string): Rgb {
	const { a } = parseOklch(fg);
	const f = oklchToRgb(fg);
	const b = oklchToRgb(bg);
	return [0, 1, 2].map((i) => f[i] * a + b[i] * (1 - a)) as Rgb;
}

/** WCAG relative luminance, from the sRGB values. */
function luminance(rgb: Rgb): number {
	const channel = (v: number): number =>
		v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	const [r, g, b] = rgb.map(channel);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg: string, bg: string, bgOver?: string): number {
	const base = bgOver ?? bg;
	const f = luminance(over(fg, bgOver ?? bg));
	// A translucent fill is composited over whatever it sits on before its
	// luminance is taken, the same way the browser paints it.
	const b = luminance(parseOklch(bg).a < 1 ? over(bg, base) : oklchToRgb(bg));
	const lighter = Math.max(f, b);
	const darker = Math.min(f, b);
	return (lighter + 0.05) / (darker + 0.05);
}

/** Pull the `--name: value;` pairs out of a selector block. */
function readBlock(css: string, selector: string): Map<string, string> {
	const start = css.indexOf(`${selector} {`);
	if (start === -1) throw new Error(`no block for ${selector}`);
	const open = css.indexOf('{', start);
	let depth = 0;
	let end = open;
	for (let i = open; i < css.length; i += 1) {
		if (css[i] === '{') depth += 1;
		else if (css[i] === '}') {
			depth -= 1;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	const tokens = new Map<string, string>();
	for (const line of css.slice(open + 1, end).split('\n')) {
		const match = /^\s*(--[\w-]+)\s*:\s*([^;]+);/.exec(line);
		if (match) tokens.set(match[1], match[2].trim());
	}
	return tokens;
}

interface Pair {
	label: string;
	fg: string;
	bg: string;
	/** When the fill is translucent, the surface it sits on. */
	bgOver?: string;
	target: number;
}

/** Re-alphas an oklch token: `oklch(…)` -> `oklch(… / 10%)`. */
function alpha(value: string, percent: number): string {
	return value.replace(/oklch\(\s*([^)]+?)\s*\)/, (_all, body: string) => {
		const bare = body.split('/')[0]?.trim();
		return `oklch(${bare} / ${percent}%)`;
	});
}

function pairsFor(t: Map<string, string>): Pair[] {
	const get = (name: string): string => {
		const value = t.get(name);
		if (!value) throw new Error(`missing token ${name}`);
		return value;
	};
	const text = (label: string, fg: string, bg: string): Pair => ({
		label,
		fg: get(fg),
		bg: get(bg),
		target: AAA_TEXT,
	});
	return [
		text('foreground on background', '--foreground', '--background'),
		text('foreground on card', '--foreground', '--card'),
		text('foreground on popover', '--foreground', '--popover'),
		// The one that normally fails: muted text is the most-used tone in the app.
		text('muted-foreground on background', '--muted-foreground', '--background'),
		text('muted-foreground on card', '--muted-foreground', '--card'),
		text('muted-foreground on muted', '--muted-foreground', '--muted'),
		text('muted-foreground on sidebar', '--muted-foreground', '--sidebar'),
		text('primary-foreground on primary', '--primary-foreground', '--primary'),
		text('primary on background (link/text use)', '--primary', '--background'),
		text('secondary-foreground on secondary', '--secondary-foreground', '--secondary'),
		text('accent-foreground on accent', '--accent-foreground', '--accent'),
		text('sidebar-foreground on sidebar', '--sidebar-foreground', '--sidebar'),
		text(
			'sidebar-accent-foreground on sidebar-accent',
			'--sidebar-accent-foreground',
			'--sidebar-accent',
		),
		text(
			'sidebar-primary-foreground on sidebar-primary',
			'--sidebar-primary-foreground',
			'--sidebar-primary',
		),
		text('destructive as text on background', '--destructive', '--background'),
		text('destructive as text on card', '--destructive', '--card'),
		text('destructive button label on solid fill', '--destructive-foreground', '--destructive'),
		text('state-copying foreground on fill', '--state-copying-foreground', '--state-copying'),
		text('state-verified foreground on fill', '--state-verified-foreground', '--state-verified'),
		text('state-failed foreground on fill', '--state-failed-foreground', '--state-failed'),
		text('state-skipped foreground on fill', '--state-skipped-foreground', '--state-skipped'),
		text('state-verified as text on background', '--state-verified', '--background'),
		text('state-failed as text on background', '--state-failed', '--background'),
		text('state-copying as text on background', '--state-copying', '--background'),
		// A chart series is a graphical object (1.4.11, 3:1), not text. The chart
		// still ships a written summary and a data table, so colour is never the
		// only way to read the numbers.
		{
			label: 'chart-2 series against background (graphic)',
			fg: get('--chart-2'),
			bg: get('--background'),
			target: NON_TEXT,
		},
		{
			label: 'ring against background (non-text)',
			fg: get('--ring'),
			bg: get('--background'),
			target: NON_TEXT,
		},
		{
			label: 'input edge against background (non-text)',
			fg: get('--input'),
			bg: get('--background'),
			target: NON_TEXT,
		},
		// Decorative separators are exempt from 1.4.11: a table rule is not the
		// only thing that identifies a row. Reported for information, and the
		// interactive boundary above is what carries the requirement.
		{
			label: 'border, decorative separator (exempt)',
			fg: get('--border'),
			bg: get('--background'),
			target: 1,
		},
		{
			label: 'sidebar border, decorative (exempt)',
			fg: get('--sidebar-border'),
			bg: get('--sidebar'),
			target: 1,
		},
	];
}

const css = await Bun.file(CSS).text();
const themes: Array<{ name: string; tokens: Map<string, string> }> = [
	{ name: 'light', tokens: readBlock(css, ':root') },
	{ name: 'dark', tokens: readBlock(css, '.dark') },
];

let failures = 0;
for (const theme of themes) {
	console.log(`\n${theme.name.toUpperCase()}`);
	for (const pair of pairsFor(theme.tokens)) {
		let value: number;
		try {
			value = ratio(pair.fg, pair.bg, pair.bgOver);
		} catch (error) {
			console.log(`  ??   ${pair.label}: ${(error as Error).message}`);
			failures += 1;
			continue;
		}
		const ok = value >= pair.target;
		if (!ok) failures += 1;
		const mark = ok ? 'pass' : 'FAIL';
		console.log(
			`  ${mark}  ${value.toFixed(2).padStart(6)}  (needs ${pair.target})  ${pair.label}`,
		);
	}
}

console.log(
	failures === 0
		? '\nAll pairs meet their target.'
		: `\n${failures} pair(s) miss their target.`,
);
process.exit(failures === 0 ? 0 : 1);
