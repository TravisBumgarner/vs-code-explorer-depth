// Runs under plain Node via the `vscode:uninstall` hook, after VS Code restarts
// following an uninstall. There is no `vscode` API here, so it scans the
// well-known install locations and restores any it finds patched.

import * as fs from "node:fs";
import * as inject from "./inject";

for (const install of inject.findInstalls()) {
	try {
		if (inject.installIsPatched(install) || fs.existsSync(install.backupFile)) inject.disable(install);
	} catch (err) {
		console.error(`explorer-nesting: could not restore ${install.workbenchHtml}:`, err);
	}
}
