// Pure stylesheet generation. No `vscode` import so it can be unit tested and
// reused from the uninstall hook.

export type ThemeKind = "dark" | "light" | "highContrast" | "highContrastLight";
export type PaletteName = "spectrum" | "cool" | "themeAccent";
export type SectionBackgrounds = "off" | "guides" | "full";

export interface Settings {
	palette: PaletteName | string[];
	guideWidth: number;
	activeGuideWidth: number;
	tintFolderIcons: boolean;
	dimInactiveGuides: boolean;
	/** Tint indent columns ("guides") or also each row's contents ("full") with depth colors. */
	sectionBackgrounds: SectionBackgrounds;
	/** Tint strength in percent. The active section uses double. */
	sectionOpacity: number;
}

export const DEFAULT_SETTINGS: Settings = {
	palette: "spectrum",
	guideWidth: 1,
	activeGuideWidth: 3,
	tintFolderIcons: true,
	dimInactiveGuides: false,
	sectionBackgrounds: "off",
	sectionOpacity: 8,
};

export const PALETTES: Record<PaletteName, { dark: string[]; light: string[] }> = {
	spectrum: {
		dark: ["#E8A24A", "#5FB3F9", "#B98CF5", "#4CC2A0", "#EF7A85"],
		light: ["#B5650D", "#1F6FC2", "#7B4BC4", "#11806A", "#C23B4A"],
	},
	cool: {
		dark: ["#5FB3F9", "#4CC2C9", "#7C9CF5", "#B98CF5", "#8FD4E8"],
		light: ["#1F6FC2", "#0F7C85", "#3E5BC9", "#7B4BC4", "#2A7FA0"],
	},
	themeAccent: {
		dark: ["#3794FF", "#3080DC", "#296CB9", "#225896", "#1C4473"],
		light: ["#005FB8", "#2E7BC4", "#5C97D0", "#8AB3DC", "#B3CCE6"],
	},
};

/** How many depths get explicit rules. The palette cycles within this range. */
export const MAX_DEPTH = 24;

/**
 * Class VS Code puts on `.monaco-workbench` for each theme kind. Used to scope
 * the color variables so theme switches apply live, without a window reload.
 */
export const THEME_CLASS: Record<ThemeKind, string> = {
	dark: "vs-dark",
	light: "vs",
	highContrast: "hc-black",
	highContrastLight: "hc-light",
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const VIEW = ".explorer-folders-view";
const GUIDE = `${VIEW} .monaco-tl-indent > .indent-guide`;

const clamp = (n: unknown, min: number, max: number, fallback: number): number =>
	typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;

/** Fill in defaults and clamp numbers to the ranges declared in package.json. */
export function normalizeSettings(raw: Partial<Settings>): Settings {
	return {
		palette: raw.palette ?? DEFAULT_SETTINGS.palette,
		guideWidth: clamp(raw.guideWidth, 1, 3, DEFAULT_SETTINGS.guideWidth),
		activeGuideWidth: clamp(raw.activeGuideWidth, 2, 6, DEFAULT_SETTINGS.activeGuideWidth),
		tintFolderIcons: raw.tintFolderIcons ?? DEFAULT_SETTINGS.tintFolderIcons,
		dimInactiveGuides: raw.dimInactiveGuides ?? DEFAULT_SETTINGS.dimInactiveGuides,
		sectionBackgrounds: (["off", "guides", "full"] as const).includes(raw.sectionBackgrounds as SectionBackgrounds)
			? (raw.sectionBackgrounds as SectionBackgrounds)
			: DEFAULT_SETTINGS.sectionBackgrounds,
		sectionOpacity: clamp(raw.sectionOpacity, 3, 30, DEFAULT_SETTINGS.sectionOpacity),
	};
}

/** The list of colors for a palette setting and theme kind. Falls back to spectrum on bad input. */
export function resolvePalette(palette: Settings["palette"], kind: ThemeKind): string[] {
	const isLight = kind === "light" || kind === "highContrastLight";
	if (Array.isArray(palette)) {
		const colors = palette.filter((c) => typeof c === "string" && HEX.test(c.trim())).map((c) => c.trim());
		if (colors.length > 0) return colors;
	} else if (palette in PALETTES) {
		return PALETTES[palette][isLight ? "light" : "dark"];
	}
	return PALETTES.spectrum[isLight ? "light" : "dark"];
}

/** CSS custom properties for one theme kind, scoped to `scope`. */
function variables(settings: Settings, kind: ThemeKind, scope: string): string {
	const colors = resolvePalette(settings.palette, kind);
	const lines = colors.map((c, i) => `\t--en-d${i}: ${c};`);
	lines.push(
		`\t--en-w: ${settings.guideWidth}px;`,
		`\t--en-aw: ${settings.activeGuideWidth}px;`,
		`\t--en-op: ${settings.dimInactiveGuides ? 0.4 : 0.85};`,
		`\t--en-bg: ${settings.sectionOpacity}%;`,
	);
	return `${scope} {\n${lines.join("\n")}\n}`;
}

/**
 * Structural rules. Each rule is generated per depth, with the variable index
 * cycling through `paletteLength`.
 *
 * DOM facts (verified against VS Code 1.134):
 * - A row at `aria-level` L renders L-1 `.indent-guide` elements. Guide
 *   `:nth-child(k)` belongs to the ancestor at level k, i.e. depth k-1.
 * - Guides are drawn with `border-left` on a `box-sizing: border-box` span.
 * - `.active` marks the focused/selected node's subtree when it is an expanded
 *   folder, otherwise its parent's subtree.
 * - Native guide rules are scoped by a per-list id class, so ours need
 *   `!important` to win.
 * - `.monaco-list-row` spans the full width of the view. Selection, focus and
 *   hover set its `background-color` (or the inner `.monaco-tl-row`'s), so the
 *   row tint uses `background-image` and never replaces them.
 *
 * Each guide sets `--en-c` to its depth color, and each row in "full" mode
 * sets `--en-row` to its parent's; the shared rules read from those.
 */
function rules(settings: Settings, paletteLength: number): string {
	const out: string[] = [];
	const v = (depth: number) => `var(--en-d${depth % paletteLength})`;

	out.push(
		`${GUIDE} {\n\topacity: var(--en-op) !important;\n\tborder-left-style: solid !important;\n\tborder-left-width: var(--en-w) !important;\n}`,
		`${GUIDE}.active {\n\topacity: 1 !important;\n\tborder-left-width: var(--en-aw) !important;\n}`,
	);

	out.push(`${GUIDE} { border-left-color: var(--en-c) !important; }`);
	for (let depth = 0; depth < MAX_DEPTH; depth++) {
		out.push(`${GUIDE}:nth-child(${depth + 1}) { --en-c: ${v(depth)}; }`);
	}

	if (settings.sectionBackgrounds !== "off") {
		const tint = (pct: string) => `color-mix(in srgb, var(--en-c) ${pct}, transparent)`;
		// In "full" mode the row itself is tinted edge to edge, so only the
		// active column gets an extra band; tinting every column would double up.
		if (settings.sectionBackgrounds === "guides") {
			out.push(`${GUIDE} { background-color: ${tint("var(--en-bg)")} !important; }`);
		}
		// Guide opacity also applies to its background, so the active band at
		// opacity 1 and double strength stands out.
		out.push(`${GUIDE}.active { background-color: ${tint("calc(var(--en-bg) * 2)")} !important; }`);
	}

	if (settings.sectionBackgrounds === "full") {
		// A row at aria-level L sits in its parent's section, depth L-2. Top-level rows aren't tinted.
		for (let depth = 0; depth < MAX_DEPTH; depth++) {
			out.push(`${VIEW} .monaco-list-row[aria-level="${depth + 2}"] { --en-row: ${v(depth)}; }`);
		}
		// Tint the whole row, edge to edge. It's a background-image so it layers
		// over (rather than replaces) the selection, focus and hover background-color.
		const fill = "color-mix(in srgb, var(--en-row) var(--en-bg), transparent)";
		out.push(
			`${VIEW} .monaco-list-row:not([aria-level="1"]) { background-image: linear-gradient(${fill}, ${fill}) !important; }`,
		);
	}

	if (settings.tintFolderIcons) {
		// A folder at aria-level L owns the guide at depth L-1, so its icon takes that color.
		for (let depth = 0; depth < MAX_DEPTH; depth++) {
			const row = `${VIEW} .monaco-list-row[aria-level="${depth + 1}"]`;
			out.push(`${row} .monaco-tl-twistie.collapsible, ${row} .folder-icon::before { color: ${v(depth)} !important; }`);
		}
	}

	return out.join("\n");
}

/** CSS for a single theme kind, with variables on `.monaco-workbench`. */
export function generateCss(raw: Partial<Settings>, kind: ThemeKind): string {
	const settings = normalizeSettings(raw);
	const n = resolvePalette(settings.palette, kind).length;
	return `${variables(settings, kind, ".monaco-workbench")}\n${rules(settings, n)}\n`;
}

/**
 * The full injected stylesheet: rules once, plus variables for every theme
 * kind scoped by its workbench class. Switching themes needs no reload.
 */
export function generateStylesheet(raw: Partial<Settings>): string {
	const settings = normalizeSettings(raw);
	const kinds = Object.keys(THEME_CLASS) as ThemeKind[];
	// Palettes can differ in length between kinds only for custom arrays, which
	// are shared, so the dark length is representative.
	const n = resolvePalette(settings.palette, "dark").length;
	const vars = kinds.map((k) => variables(settings, k, `.monaco-workbench.${THEME_CLASS[k]}`));
	return `/* Generated by Explorer Nesting Colors. Do not edit. */\n${vars.join("\n")}\n${rules(settings, n)}\n`;
}
