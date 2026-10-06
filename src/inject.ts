// Patch, back up and restore VS Code's workbench.html. No `vscode` import: the
// uninstall hook runs this under plain Node.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MARKER_START = "<!-- explorer-nesting:start -->";
export const MARKER_END = "<!-- explorer-nesting:end -->";
export const CSS_FILE = "explorer-nesting.css";
export const BACKUP_SUFFIX = ".explorer-nesting.bak";

/** workbench.html relative to `appRoot`, newest layout first. */
const WORKBENCH_RELATIVE = [
	"out/vs/code/electron-browser/workbench/workbench.html",
	"out/vs/code/electron-sandbox/workbench/workbench.html",
];
const CHECKSUM_KEYS = WORKBENCH_RELATIVE.map((p) => p.replace(/^out\//, ""));

export type Flavor = "stable" | "insiders" | "vscodium";

export interface Install {
	appRoot: string;
	workbenchHtml: string;
	cssFile: string;
	backupFile: string;
	productJson: string;
}

/** Locate workbench.html under an app root (`vscode.env.appRoot`). */
export function resolveInstall(appRoot: string): Install | undefined {
	for (const rel of WORKBENCH_RELATIVE) {
		const workbenchHtml = path.join(appRoot, rel);
		if (fs.existsSync(workbenchHtml)) {
			const dir = path.dirname(workbenchHtml);
			return {
				appRoot,
				workbenchHtml,
				cssFile: path.join(dir, CSS_FILE),
				backupFile: workbenchHtml + BACKUP_SUFFIX,
				productJson: path.join(appRoot, "product.json"),
			};
		}
	}
	return undefined;
}

/**
 * Well-known app roots for each platform and flavor. Only needed where
 * `vscode.env.appRoot` is unavailable (the uninstall hook).
 */
export function candidateAppRoots(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
): Record<Flavor, string[]> {
	if (platform === "darwin") {
		const app = (name: string) => [
			`/Applications/${name}.app/Contents/Resources/app`,
			path.join(home, `Applications/${name}.app/Contents/Resources/app`),
		];
		return {
			stable: app("Visual Studio Code"),
			insiders: app("Visual Studio Code - Insiders"),
			vscodium: app("VSCodium"),
		};
	}
	if (platform === "win32") {
		const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
		const pf = env.ProgramFiles ?? "C:\\Program Files";
		const w = (dir: string) => [
			path.win32.join(local, "Programs", dir, "resources", "app"),
			path.win32.join(pf, dir, "resources", "app"),
		];
		return {
			stable: w("Microsoft VS Code"),
			insiders: w("Microsoft VS Code Insiders"),
			vscodium: w("VSCodium"),
		};
	}
	return {
		stable: [
			"/usr/share/code/resources/app",
			"/opt/visual-studio-code/resources/app",
			"/snap/code/current/usr/share/code/resources/app",
		],
		insiders: [
			"/usr/share/code-insiders/resources/app",
			"/snap/code-insiders/current/usr/share/code-insiders/resources/app",
		],
		vscodium: [
			"/usr/share/codium/resources/app",
			"/opt/vscodium-bin/resources/app",
			"/snap/codium/current/usr/share/codium/resources/app",
		],
	};
}

/** Every install found on disk, across flavors. */
export function findInstalls(roots: Record<Flavor, string[]> = candidateAppRoots()): Install[] {
	return Object.values(roots)
		.flat()
		.map(resolveInstall)
		.filter((i): i is Install => i !== undefined);
}

// ---- pure HTML transforms -------------------------------------------------

export function isPatched(html: string): boolean {
	return html.includes(MARKER_START);
}

/** Remove our block (and the newline before it) if present. */
export function stripPatch(html: string): string {
	const start = html.indexOf(MARKER_START);
	const end = html.indexOf(MARKER_END);
	if (start === -1 || end === -1 || end < start) return html;
	let from = start;
	while (from > 0 && (html[from - 1] === "\t" || html[from - 1] === " ")) from--;
	if (html[from - 1] === "\n") from--;
	return html.slice(0, from) + html.slice(end + MARKER_END.length);
}

/**
 * Insert a `<link>` to the generated stylesheet before `</head>`. The CSP
 * allows `style-src 'self'` but not inline scripts, so a sibling stylesheet is
 * the most robust injection. A cache-busting query makes reloads pick up
 * regenerated CSS.
 */
export function applyPatch(html: string, version = Date.now().toString(36)): string {
	const clean = stripPatch(html);
	const idx = clean.lastIndexOf("</head>");
	if (idx === -1) throw new Error("workbench.html has no </head>; unknown layout");
	const block = `\t${MARKER_START}\n\t\t<link rel="stylesheet" href="./${CSS_FILE}?v=${version}">\n\t${MARKER_END}\n\t`;
	return clean.slice(0, idx) + block + clean.slice(idx);
}

// ---- filesystem operations ------------------------------------------------

export class PermissionError extends Error {
	constructor(
		readonly file: string,
		cause: unknown,
	) {
		super(`No permission to write ${file}`, { cause });
	}
}

function write(file: string, data: string): void {
	try {
		fs.writeFileSync(file, data, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw new PermissionError(file, err);
		throw err;
	}
}

export function installIsPatched(install: Install): boolean {
	return isPatched(fs.readFileSync(install.workbenchHtml, "utf8"));
}

/**
 * Write the stylesheet and patch workbench.html. Backs up the unpatched HTML
 * first, refreshing the backup if VS Code was updated since the last one.
 */
export function enable(install: Install, css: string): void {
	const current = fs.readFileSync(install.workbenchHtml, "utf8");
	const pristine = stripPatch(current);
	if (!fs.existsSync(install.backupFile) || fs.readFileSync(install.backupFile, "utf8") !== pristine) {
		write(install.backupFile, pristine);
	}
	write(install.cssFile, css);
	write(install.workbenchHtml, applyPatch(current));
}

/** Rewrite just the stylesheet. Takes effect on the next window reload. */
export function writeCss(install: Install, css: string): void {
	write(install.cssFile, css);
}

/**
 * Undo `enable`. Restores from the backup when it matches the current HTML
 * minus our block; otherwise (VS Code updated underneath us) only strips the
 * block, since the stale backup belongs to an older version.
 */
export function disable(install: Install): void {
	const current = fs.readFileSync(install.workbenchHtml, "utf8");
	const stripped = stripPatch(current);
	let restored = stripped;
	if (fs.existsSync(install.backupFile)) {
		const backup = fs.readFileSync(install.backupFile, "utf8");
		if (backup === stripped) restored = backup;
	}
	if (restored !== current) write(install.workbenchHtml, restored);
	fs.rmSync(install.cssFile, { force: true });
	fs.rmSync(install.backupFile, { force: true });
	restoreChecksum(install);
}

// ---- optional checksum fix ------------------------------------------------

/** The format VS Code uses in product.json: base64 sha256 without padding. */
export function checksum(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("base64").replace(/=+$/, "");
}

function checksumKey(install: Install): string | undefined {
	const rel = path.relative(path.join(install.appRoot, "out"), install.workbenchHtml).split(path.sep).join("/");
	return CHECKSUM_KEYS.includes(rel) ? rel : undefined;
}

const PRODUCT_BACKUP_SUFFIX = ".explorer-nesting.bak";

/**
 * Update product.json so VS Code's integrity check passes, which stops the
 * "installation appears to be corrupt" warning. Keeps a backup of
 * product.json so `disable` can put it back. Returns false if product.json
 * has no checksum for workbench.html.
 */
export function fixChecksum(install: Install): boolean {
	const key = checksumKey(install);
	if (!key || !fs.existsSync(install.productJson)) return false;
	const raw = fs.readFileSync(install.productJson, "utf8");
	const product = JSON.parse(raw) as { checksums?: Record<string, string> };
	if (!product.checksums?.[key]) return false;
	const backup = install.productJson + PRODUCT_BACKUP_SUFFIX;
	if (!fs.existsSync(backup)) write(backup, raw);
	const old = product.checksums[key];
	const next = checksum(fs.readFileSync(install.workbenchHtml));
	// Replace the value textually to keep the file's formatting byte-for-byte.
	write(install.productJson, raw.replace(old, next));
	return true;
}

function restoreChecksum(install: Install): void {
	const backup = install.productJson + PRODUCT_BACKUP_SUFFIX;
	if (!fs.existsSync(backup)) return;
	const original = JSON.parse(fs.readFileSync(backup, "utf8")) as { version?: string };
	const current = JSON.parse(fs.readFileSync(install.productJson, "utf8")) as { version?: string };
	// Only restore if the backup is from this VS Code version; an update replaces product.json anyway.
	if (original.version === current.version) write(install.productJson, fs.readFileSync(backup, "utf8"));
	fs.rmSync(backup, { force: true });
}
