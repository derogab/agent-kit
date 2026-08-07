import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_MODELS } from "./model.ts";
import type { ClassifierServer } from "./server.ts";

const STATUS_KEY = "auto-mode";
const STATUS_OPTION = "Status";
const MODEL_OPTION = "Model";
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
	let sessionContext: ExtensionContext | undefined;

	function updateStatus(ctx: ExtensionContext, enabled: boolean) {
		active = enabled;
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const model = classifierServer.getModel();
		const details = [classifierServer.getAddress(), `${model.repository}:${model.size}`]
			.filter((detail): detail is string => detail !== undefined)
			.join(" · ");
		ctx.ui.setStatus(
			STATUS_KEY,
			`${ctx.ui.theme.fg("success", "auto-mode")} ${ctx.ui.theme.fg("muted", `· ${details}`)}`,
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionContext = ctx;
		updateStatus(ctx, active);
	});

	pi.on("session_shutdown", () => {
		sessionContext = undefined;
	});

	classifierServer.onAddressChange(() => {
		if (sessionContext) updateStatus(sessionContext, active);
	});

	pi.registerCommand("auto-mode", {
		description: "Manage Bash policy and classifier checks",
		handler: async (_args, ctx) => {
			const section = await ctx.ui.select("Auto-mode", [STATUS_OPTION, MODEL_OPTION], { signal: ctx.signal });
			if (section === MODEL_OPTION) {
				const choice = await ctx.ui.select(
					`Classifier model: ${classifierServer.getModel().size}`,
					CLASSIFIER_MODELS.map((model) => model.size),
					{ signal: ctx.signal },
				);
				const model = CLASSIFIER_MODELS.find((candidate) => candidate.size === choice);
				if (!model) return;

				try {
					await classifierServer.selectModel(model, ctx.signal);
					ctx.ui.notify(`Classifier model set to ${model.size}.`, "info");
				} catch (error) {
					ctx.ui.notify(
						`Classifier model could not change: ${
							error instanceof Error ? error.message : String(error)
						}`,
						"error",
					);
				} finally {
					updateStatus(ctx, active);
				}
				return;
			}
			if (section !== STATUS_OPTION) return;

			const choice = await ctx.ui.select(
				`Auto-mode status: ${active ? "enabled" : "disabled"}`,
				[ENABLE_OPTION, DISABLE_OPTION],
				{ signal: ctx.signal },
			);
			if (choice === undefined) return;
			if (choice === DISABLE_OPTION) {
				updateStatus(ctx, false);
				try {
					await classifierServer.stop();
					ctx.ui.notify("Auto-mode is off. Bash commands are no longer checked.", "warning");
				} catch (error) {
					ctx.ui.notify(
						`Auto-mode is off, but its classifier server could not stop: ${
							error instanceof Error ? error.message : String(error)
						}`,
						"error",
					);
				}
				return;
			}
			if (choice !== ENABLE_OPTION) return;

			try {
				await classifierServer.ensureReady(ctx.signal);
				updateStatus(ctx, true);
				ctx.ui.notify("Auto-mode is on. Bash commands are checked.", "info");
			} catch (error) {
				updateStatus(ctx, true);
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
