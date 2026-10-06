import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as inject from "../src/inject";

const HTML = `<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8" />
		<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">
	</head>
	<body aria-label="">
	</body>
	<script src="./workbench.js" type="module"></script>
</html>
`;

describe("html transforms", () => {
	it("inserts a stylesheet link inside <head>", () => {
		const out = inject.applyPatch(HTML, "abc");
		expect(inject.isPatched(out)).toBe(true);
		const link = `<link rel="stylesheet" href="./${inject.CSS_FILE}?v=abc">`;
		expect(out.indexOf(link)).toBeGreaterThan(out.indexOf("workbench.desktop.main.css"));
		expect(out.indexOf(link)).toBeLessThan(out.indexOf("</head>"));
	});

	it("is idempotent and round-trips", () => {
		const once = inject.applyPatch(HTML, "a");
		const twice = inject.applyPatch(once, "a");
		expect(twice).toBe(once);
		expect(inject.stripPatch(twice)).toBe(HTML);
	});

	it("leaves unpatched html alone", () => {
		expect(inject.stripPatch(HTML)).toBe(HTML);
	});

	it("rejects html without </head>", () => {
		expect(() => inject.applyPatch("<html></html>")).toThrow(/no <\/head>/);
	});
});

describe("filesystem", () => {
	let root: string;
	let install: inject.Install;
	const product = (sum: string) =>
		`{\n\t"version": "1.134.0",\n\t"checksums": {\n\t\t"vs/code/electron-browser/workbench/workbench.html": "${sum}"\n\t}\n}\n`;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "en-test-"));
		const dir = path.join(root, "out/vs/code/electron-browser/workbench");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "workbench.html"), HTML);
		fs.writeFileSync(path.join(root, "product.json"), product(inject.checksum(HTML)));
		const found = inject.resolveInstall(root);
		if (!found) throw new Error("install not resolved");
		install = found;
	});

	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	it("resolves the legacy electron-sandbox layout", () => {
		const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "en-test-"));
		const dir = path.join(legacy, "out/vs/code/electron-sandbox/workbench");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "workbench.html"), HTML);
		expect(inject.resolveInstall(legacy)?.workbenchHtml).toBe(path.join(dir, "workbench.html"));
		expect(inject.resolveInstall(path.join(legacy, "missing"))).toBeUndefined();
		fs.rmSync(legacy, { recursive: true });
	});

	it("enable writes css, backup and patch; disable restores everything", () => {
		inject.enable(install, "/* css */");
		expect(fs.readFileSync(install.cssFile, "utf8")).toBe("/* css */");
		expect(fs.readFileSync(install.backupFile, "utf8")).toBe(HTML);
		expect(inject.installIsPatched(install)).toBe(true);

		inject.enable(install, "/* css 2 */"); // re-apply keeps a clean backup
		expect(fs.readFileSync(install.backupFile, "utf8")).toBe(HTML);

		inject.disable(install);
		expect(fs.readFileSync(install.workbenchHtml, "utf8")).toBe(HTML);
		expect(fs.existsSync(install.cssFile)).toBe(false);
		expect(fs.existsSync(install.backupFile)).toBe(false);
	});

	it("disable after a VS Code update strips the block instead of restoring a stale backup", () => {
		inject.enable(install, "");
		const updated = HTML.replace("utf-8", "UTF-8");
		fs.writeFileSync(install.workbenchHtml, inject.applyPatch(updated));
		inject.disable(install);
		expect(fs.readFileSync(install.workbenchHtml, "utf8")).toBe(updated);
	});

	it("fixChecksum updates product.json and disable restores it", () => {
		const original = fs.readFileSync(install.productJson, "utf8");
		inject.enable(install, "");
		expect(inject.fixChecksum(install)).toBe(true);
		const patched = fs.readFileSync(install.workbenchHtml);
		expect(fs.readFileSync(install.productJson, "utf8")).toBe(product(inject.checksum(patched)));

		inject.disable(install);
		expect(fs.readFileSync(install.productJson, "utf8")).toBe(original);
	});

	it("checksum matches VS Code's format (unpadded base64 sha256)", () => {
		expect(inject.checksum("")).toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU");
	});

	it("reports permission errors distinctly", () => {
		if (process.getuid?.() === 0) return; // root ignores mode bits
		fs.chmodSync(install.workbenchHtml, 0o444);
		expect(() => inject.enable(install, "")).toThrow(inject.PermissionError);
	});
});

describe("candidateAppRoots", () => {
	it("covers every flavor on every platform", () => {
		for (const platform of ["darwin", "win32", "linux"] as const) {
			const roots = inject.candidateAppRoots(platform, { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "/home/me");
			expect(Object.keys(roots).sort()).toEqual(["insiders", "stable", "vscodium"]);
			for (const list of Object.values(roots)) expect(list.length).toBeGreaterThan(0);
		}
		expect(inject.candidateAppRoots("darwin", {}, "/Users/me").stable[0]).toBe(
			"/Applications/Visual Studio Code.app/Contents/Resources/app",
		);
		expect(inject.candidateAppRoots("win32", { LOCALAPPDATA: "C:\\L" }, "x").insiders[0]).toBe(
			"C:\\L\\Programs\\Microsoft VS Code Insiders\\resources\\app",
		);
	});
});
