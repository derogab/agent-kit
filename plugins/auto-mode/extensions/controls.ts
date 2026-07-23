import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { downloadClassifierModel, findCachedClassifierModel } from "./model.ts";

const STATUS_KEY = "auto-mode";
const ENABLE_OPTION = "Enable auto-mode";
const DISABLE_OPTION = "Disable auto-mode";

export interface AutoModeController {
	isActive(): boolean;
}

export interface AutoModeControlsDependencies {
	downloadModel?: typeof downloadClassifierModel;
	findCachedModel?: typeof findCachedClassifierModel;
}

export function registerAutoModeControls(
	pi: ExtensionAPI,
	dependencies: AutoModeControlsDependencies = {},
): AutoModeController {
	let active = true;
	const downloadModel = dependencies.downloadModel ?? downloadClassifierModel;
	const findCachedModel = dependencies.findCachedModel ?? findCachedClassifierModel;

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
				if (!(await findCachedModel())) {
					const confirmed =
						ctx.hasUI &&
						(await ctx.ui.confirm(
							"Download auto-mode model?",
							"The classifier model is not in the Hugging Face cache. Download it now? (about 5.6 GB)",
							{ signal: ctx.signal },
						));
					if (!confirmed) {
						updateStatus(ctx, false);
						ctx.ui.notify("Auto-mode cannot start without its classifier model.", "warning");
						return;
					}

					ctx.ui.notify("Downloading the auto-mode classifier model...", "info");
					await downloadModel({ signal: ctx.signal });
				}

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
