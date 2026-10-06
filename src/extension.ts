import * as fs from "node:fs";
import * as vscode from "vscode";
import { generateStylesheet, type Settings } from "./css";
import * as inject from "./inject";

const SECTION = "explorerNesting";
const STATE_ENABLED = "explorerNesting.enabled";
const STATE_PREVIOUS = "explorerNesting.previousWorkbenchSettings";

/** Workbench settings we force while enabled, restored on disable. */
type PreviousSettings = { indent: number | undefined; renderIndentGuides: string | undefined };

function readSettings(): Partial<Settings> {
	const c = vscode.workspace.getConfiguration(SECTION);
	return {
		palette: c.get("palette"),
		guideWidth: c.get("guideWidth"),
		activeGuideWidth: c.get("activeGuideWidth"),
		tintFolderIcons: c.get("tintFolderIcons"),
		dimInactiveGuides: c.get("dimInactiveGuides"),
		sectionBackgrounds: c.get("sectionBackgrounds"),
		sectionOpacity: c.get("sectionOpacity"),
	};
}

function getInstall(): inject.Install {
	const install = inject.resolveInstall(vscode.env.appRoot);
	if (!install) throw new Error(`Could not find workbench.html under ${vscode.env.appRoot}`);
	return install;
}

async function reportError(err: unknown): Promise<void> {
	if (err instanceof inject.PermissionError) {
		const hint =
			process.platform === "darwin"
				? "Grant VS Code App Management permission (System Settings → Privacy & Security), or move it to a folder you own."
				: process.platform === "win32"
					? "Use the per-user installer, or run VS Code as administrator once."
					: "Make the VS Code install directory writable by your user, or use a per-user install.";
		await vscode.window.showErrorMessage(`Explorer Nesting: ${err.message}. ${hint}`);
		return;
	}
	await vscode.window.showErrorMessage(`Explorer Nesting: ${err instanceof Error ? err.message : String(err)}`);
}

async function promptReload(message: string): Promise<void> {
	const choice = await vscode.window.showInformationMessage(message, "Reload Window");
	if (choice) await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

/** Patch workbench.html with the current settings, then optionally fix the checksum. */
function apply(install: inject.Install): void {
	inject.enable(install, generateStylesheet(readSettings()));
	if (vscode.workspace.getConfiguration(SECTION).get<boolean>("fixChecksums")) inject.fixChecksum(install);
}

async function writeIndent(): Promise<void> {
	const indent = vscode.workspace.getConfiguration(SECTION).get<number>("indent", 12);
	await vscode.workspace.getConfiguration("workbench.tree").update("indent", indent, vscode.ConfigurationTarget.Global);
}

async function forceWorkbenchSettings(ctx: vscode.ExtensionContext): Promise<void> {
	const tree = vscode.workspace.getConfiguration("workbench.tree");
	if (!ctx.globalState.get<PreviousSettings>(STATE_PREVIOUS)) {
		const previous: PreviousSettings = {
			indent: tree.inspect<number>("indent")?.globalValue,
			renderIndentGuides: tree.inspect<string>("renderIndentGuides")?.globalValue,
		};
		await ctx.globalState.update(STATE_PREVIOUS, previous);
	}
	await tree.update("renderIndentGuides", "always", vscode.ConfigurationTarget.Global);
	await writeIndent();
}

async function restoreWorkbenchSettings(ctx: vscode.ExtensionContext): Promise<void> {
	const previous = ctx.globalState.get<PreviousSettings>(STATE_PREVIOUS);
	if (!previous) return;
	const tree = vscode.workspace.getConfiguration("workbench.tree");
	await tree.update("indent", previous.indent, vscode.ConfigurationTarget.Global);
	await tree.update("renderIndentGuides", previous.renderIndentGuides, vscode.ConfigurationTarget.Global);
	await ctx.globalState.update(STATE_PREVIOUS, undefined);
}

async function enableCommand(ctx: vscode.ExtensionContext): Promise<void> {
	try {
		apply(getInstall());
		await forceWorkbenchSettings(ctx);
		await ctx.globalState.update(STATE_ENABLED, true);
		await promptReload(
			"Explorer Nesting enabled. Reload to apply. VS Code may then warn that your installation is corrupt; that is expected (see README).",
		);
	} catch (err) {
		await reportError(err);
	}
}

async function disableCommand(ctx: vscode.ExtensionContext): Promise<void> {
	try {
		inject.disable(getInstall());
		await restoreWorkbenchSettings(ctx);
		await ctx.globalState.update(STATE_ENABLED, false);
		await promptReload("Explorer Nesting disabled and workbench.html restored. Reload to apply.");
	} catch (err) {
		await reportError(err);
	}
}

async function reloadCommand(ctx: vscode.ExtensionContext): Promise<void> {
	if (!ctx.globalState.get<boolean>(STATE_ENABLED)) {
		await vscode.window.showWarningMessage("Explorer Nesting is not enabled. Run 'Explorer Nesting: Enable' first.");
		return;
	}
	try {
		apply(getInstall());
		await vscode.commands.executeCommand("workbench.action.reloadWindow");
	} catch (err) {
		await reportError(err);
	}
}

/** On startup: re-apply after a VS Code update wiped the patch, or refresh stale CSS. */
async function checkOnStartup(ctx: vscode.ExtensionContext): Promise<void> {
	if (!ctx.globalState.get<boolean>(STATE_ENABLED)) return;
	try {
		const install = getInstall();
		if (!inject.installIsPatched(install)) {
			const choice = await vscode.window.showInformationMessage(
				"Explorer Nesting: VS Code was updated and the nesting colors were removed. Re-apply them?",
				"Re-apply",
				"Disable",
			);
			if (choice === "Re-apply") {
				apply(install);
				await promptReload("Explorer Nesting re-applied. Reload to apply.");
			} else if (choice === "Disable") {
				await disableCommand(ctx);
			}
			return;
		}
		const css = generateStylesheet(readSettings());
		const current = fs.existsSync(install.cssFile) ? fs.readFileSync(install.cssFile, "utf8") : "";
		if (css !== current) {
			apply(install);
			await promptReload("Explorer Nesting: settings changed since the last reload. Reload to apply.");
		}
	} catch (err) {
		await reportError(err);
	}
}

async function onConfigChange(ctx: vscode.ExtensionContext, e: vscode.ConfigurationChangeEvent): Promise<void> {
	if (!e.affectsConfiguration(SECTION) || !ctx.globalState.get<boolean>(STATE_ENABLED)) return;
	try {
		if (e.affectsConfiguration(`${SECTION}.indent`)) await writeIndent();
		const visual = [
			"palette",
			"guideWidth",
			"activeGuideWidth",
			"tintFolderIcons",
			"dimInactiveGuides",
			"sectionBackgrounds",
			"sectionOpacity",
			"fixChecksums",
		];
		if (visual.some((k) => e.affectsConfiguration(`${SECTION}.${k}`))) {
			apply(getInstall());
			await promptReload("Explorer Nesting settings changed. Reload to apply.");
		}
	} catch (err) {
		await reportError(err);
	}
}

export function activate(ctx: vscode.ExtensionContext): void {
	ctx.subscriptions.push(
		vscode.commands.registerCommand("explorerNesting.enable", () => enableCommand(ctx)),
		vscode.commands.registerCommand("explorerNesting.disable", () => disableCommand(ctx)),
		vscode.commands.registerCommand("explorerNesting.reload", () => reloadCommand(ctx)),
		vscode.workspace.onDidChangeConfiguration((e) => onConfigChange(ctx, e)),
		// Theme switches need no work: the stylesheet scopes a palette variant to
		// each theme kind's workbench class, so the switch applies live.
	);
	void checkOnStartup(ctx);
}

export function deactivate(): void {}
