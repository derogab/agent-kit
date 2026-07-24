import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierServer } from "./server.ts";

const STATUS_KEY = "auto-mode";
const ENABLE_OPTION = "Enable auto-mode";
const DISABLE_OPTION = "Disable auto-mode";

export interface AutoModeController {
	isActive(): boolean;
}

export function registerAutoModeControls(
	pi: ExtensionAPI,
	classifierServer: ClassifierServer,
): AutoModeController {
	let active = true;

	function updateStatus(ctx: ExtensionContext, enabled: boolean) {
		active = enabled;
		ctx.ui.setStatus(STATUS_KEY, enabled ? ctx.ui.theme.fg("success", "auto-mode") : undefined);
	}

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx, active);
	});

	pi.registerCommand("auto-mode", {
		description: "Manage Bash policy and classifier checks",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select(
				[
					"Auto-mode checks Bash commands with policy rules and a model classifier.",
					`Current status: ${active ? "enabled" : "disabled"}`,
					"What would you like to do?",
				].join("\n\n"),
				[ENABLE_OPTION, DISABLE_OPTION],
				{ signal: ctx.signal },
			);
			if (choice === undefined) return;
			if (choice === DISABLE_OPTION) {
				updateStatus(ctx, false);
				ctx.ui.notify("Auto-mode is off. Bash commands are no longer checked.", "warning");
				return;
			}
			if (choice !== ENABLE_OPTION) return;

			try {
				await classifierServer.ensureReady(ctx.signal);
				updateStatus(ctx, true);
				ctx.ui.notify("Auto-mode is on. Bash commands are checked.", "info");
			} catch (error) {
				updateStatus(ctx, false);
				ctx.ui.notify(
					`Auto-mode could not start: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	return {
		isActive: () => active,
	};
}
