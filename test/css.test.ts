import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	generateCss,
	generateStylesheet,
	MAX_DEPTH,
	normalizeSettings,
	PALETTES,
	type PaletteName,
	resolvePalette,
} from "../src/css";

describe("resolvePalette", () => {
	it("picks the dark or light variant by theme kind", () => {
		expect(resolvePalette("cool", "dark")).toEqual(PALETTES.cool.dark);
		expect(resolvePalette("cool", "highContrast")).toEqual(PALETTES.cool.dark);
		expect(resolvePalette("cool", "light")).toEqual(PALETTES.cool.light);
		expect(resolvePalette("cool", "highContrastLight")).toEqual(PALETTES.cool.light);
	});

	it("uses a custom array for every theme and drops invalid entries", () => {
		const custom = ["#fff", " #123456 ", "red", "#12345"];
		expect(resolvePalette(custom, "dark")).toEqual(["#fff", "#123456"]);
		expect(resolvePalette(custom, "light")).toEqual(["#fff", "#123456"]);
	});

	it("falls back to spectrum for unknown names and empty arrays", () => {
		expect(resolvePalette("nope" as PaletteName, "dark")).toEqual(PALETTES.spectrum.dark);
		expect(resolvePalette([], "light")).toEqual(PALETTES.spectrum.light);
	});
});

describe("normalizeSettings", () => {
	it("fills defaults", () => {
		expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
	});

	it("clamps widths to the declared ranges", () => {
		const s = normalizeSettings({ guideWidth: 9, activeGuideWidth: 0 });
		expect(s.guideWidth).toBe(3);
		expect(s.activeGuideWidth).toBe(2);
	});
});

describe("generateCss", () => {
	const css = generateCss({}, "dark");

	it("defines one variable per palette color", () => {
		PALETTES.spectrum.dark.forEach((c, i) => {
			expect(css).toContain(`--en-d${i}: ${c};`);
		});
		expect(css).not.toContain("--en-d5:");
	});

	it("colors guide n with palette[(n-1) % length], cycling", () => {
		expect(css).toContain(".indent-guide:nth-child(1) { --en-c: var(--en-d0); }");
		expect(css).toContain(".indent-guide:nth-child(5) { --en-c: var(--en-d4); }");
		expect(css).toContain(".indent-guide:nth-child(6) { --en-c: var(--en-d0); }");
		expect(css).toContain(`.indent-guide:nth-child(${MAX_DEPTH}) {`);
	});

	it("sets widths and opacity", () => {
		expect(css).toContain("--en-w: 1px;");
		expect(css).toContain("--en-aw: 3px;");
		expect(css).toContain("--en-op: 0.85;");
		expect(css).toMatch(/\.indent-guide\.active \{[^}]*opacity: 1 !important;[^}]*border-left-width: var\(--en-aw\)/);
		expect(generateCss({ dimInactiveGuides: true }, "dark")).toContain("--en-op: 0.4;");
		expect(generateCss({ guideWidth: 2, activeGuideWidth: 5 }, "dark")).toMatch(/--en-w: 2px;[\s\S]*--en-aw: 5px;/);
	});

	it("tints folder twisties by the depth of the guide they own", () => {
		expect(css).toContain('.monaco-list-row[aria-level="1"] .monaco-tl-twistie.collapsible');
		expect(css).toMatch(/aria-level="2"\][^{]*\{ color: var\(--en-d1\) !important; \}/);
		expect(generateCss({ tintFolderIcons: false }, "dark")).not.toContain("monaco-tl-twistie");
	});

	it("never recolors labels or selection", () => {
		for (const s of [css, generateStylesheet({ palette: ["#f00"] })]) {
			expect(s).not.toMatch(/label|monaco-icon-name|selected|focused/);
		}
	});

	it("cycles a custom palette of a different length", () => {
		const custom = generateCss({ palette: ["#111111", "#222222"] }, "light");
		expect(custom).toContain(".indent-guide:nth-child(3) { --en-c: var(--en-d0); }");
	});
});

describe("section backgrounds", () => {
	it("is off by default", () => {
		expect(generateCss({}, "dark")).not.toContain("background");
	});

	it("guides: tints each indent column, doubled when active", () => {
		const css = generateCss({ sectionBackgrounds: "guides", sectionOpacity: 12 }, "dark");
		expect(css).toContain("--en-bg: 12%;");
		expect(css).toContain(
			".indent-guide { background-color: color-mix(in srgb, var(--en-c) var(--en-bg), transparent) !important; }",
		);
		expect(css).toContain(
			".indent-guide.active { background-color: color-mix(in srgb, var(--en-c) calc(var(--en-bg) * 2), transparent)",
		);
		expect(css).not.toContain("monaco-tl-contents");
	});

	it("full: tints each whole row with its parent's depth color, skipping top level", () => {
		const css = generateCss({ sectionBackgrounds: "full", tintFolderIcons: false }, "dark");
		expect(css).toContain('.monaco-list-row[aria-level="2"] { --en-row: var(--en-d0); }');
		expect(css).toContain('.monaco-list-row[aria-level="7"] { --en-row: var(--en-d0); }');
		expect(css).toContain('.monaco-list-row:not([aria-level="1"]) { background-image: linear-gradient(');
		expect(css).not.toContain('[aria-level="1"] {');
	});

	it("full: tints only the active column, since the row already covers the others", () => {
		const css = generateCss({ sectionBackgrounds: "full" }, "dark");
		expect(css).toContain(".indent-guide.active { background-color:");
		expect(css).not.toContain(".indent-guide { background-color:");
	});

	it("never overrides the background-color that carries selection and hover", () => {
		for (const mode of ["guides", "full"] as const) {
			const css = generateCss({ sectionBackgrounds: mode }, "dark");
			expect(css).not.toMatch(/\.monaco-tl-row[^{]*\{[^}]*background-color/);
			expect(css).not.toMatch(/\.monaco-list-row[^{>]*\{[^}]*background-color/);
		}
	});

	it("clamps opacity and rejects unknown modes", () => {
		expect(normalizeSettings({ sectionOpacity: 90 }).sectionOpacity).toBe(30);
		expect(normalizeSettings({ sectionBackgrounds: "rows" as never }).sectionBackgrounds).toBe("off");
	});
});

describe("generateStylesheet", () => {
	it("scopes a palette variant to each theme kind's workbench class", () => {
		const css = generateStylesheet({ palette: "spectrum" });
		expect(css).toMatch(new RegExp(`\\.monaco-workbench\\.vs-dark \\{\\s*--en-d0: ${PALETTES.spectrum.dark[0]}`));
		expect(css).toMatch(new RegExp(`\\.monaco-workbench\\.vs \\{\\s*--en-d0: ${PALETTES.spectrum.light[0]}`));
		expect(css).toMatch(new RegExp(`\\.monaco-workbench\\.hc-black \\{\\s*--en-d0: ${PALETTES.spectrum.dark[0]}`));
		expect(css).toMatch(new RegExp(`\\.monaco-workbench\\.hc-light \\{\\s*--en-d0: ${PALETTES.spectrum.light[0]}`));
	});
});

// Neighboring depths (including the wrap from last to first) should differ in
// lightness, not only hue, so they stay distinguishable for color-blind users.
function lightness(hex: string): number {
	const n = Number.parseInt(hex.slice(1), 16);
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	const y = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
	// CIE L* (0-100)
	return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (y * 24389) / 27;
}

// The design-supplied spectrum and cool palettes don't meet this yet: some
// neighbors differ by under 1-2 L*. Kept as specified pending a design call;
// `it.fails` flips to a failure once they're fixed, so remove entries then.
const KNOWN_LOW_LIGHTNESS_GAP = new Set(["spectrum/dark", "spectrum/light", "cool/dark", "cool/light"]);

describe("preset palettes", () => {
	for (const [name, variants] of Object.entries(PALETTES)) {
		for (const [variant, colors] of Object.entries(variants)) {
			const test = KNOWN_LOW_LIGHTNESS_GAP.has(`${name}/${variant}`) ? it.fails : it;
			test(`${name}/${variant}: neighbors differ in lightness by >= 3 L*`, () => {
				const gaps = colors.map((c, i) => Math.abs(lightness(c) - lightness(colors[(i + 1) % colors.length])));
				expect(Math.min(...gaps), gaps.map((g) => g.toFixed(1)).join(" ")).toBeGreaterThanOrEqual(3);
			});
		}
	}
});
