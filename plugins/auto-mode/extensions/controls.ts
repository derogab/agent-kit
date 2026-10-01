import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_MODELS } from "./model.ts";
import { loadEnabledPreference, saveEnabledPreference } from "./preferences.ts";
import type { ClassifierServer } from "./server.ts";

const STATUS_KEY = "auto-mode";
const STATUS_OPTION = "Status";
const MODEL_OPTION = "Model";
const NO_MODEL_OPTION = "No model";
const ENABLE_OPTION = "Enable auto-mode";
const DISABLE_OPTION = "Disable auto-mode";

export interface AutoModeController {
	isActive(): boolean;
}

export interface AutoModeControlsDependencies {
	loadEnabled?: typeof loadEnabledPreference;
	saveEnabled?: typeof saveEnabledPreference;
}

export function registerAutoModeControls(
	pi: ExtensionAPI,
	classifierServer: ClassifierServer,
	dependencies: AutoModeControlsDependencies = {},
): AutoModeController {
	const saveEnabled = dependencies.saveEnabled ?? saveEnabledPreference;
	let active = (dependencies.loadEnabled ?? loadEnabledPreference)();
	let sessionContext: ExtensionContext | undefined;

	function updateStatus(ctx: ExtensionContext, enabled: boolean) {
		active = enabled;
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const model = classifierServer.getModel();
		const details = model
			? [`${model.repository}:${model.size}`, classifierServer.getAddress()]
				.filter((detail): detail is string => detail !== undefined)
				.join(" · ")
			: "policies only";
		const shield = model ? ctx.ui.theme.fg("success", "⛨") : "\x1b[38;5;208m⛨\x1b[39m";
		ctx.ui.setStatus(STATUS_KEY, `${shield} ${ctx.ui.theme.fg("muted", details)}`);
	}

	function setEnabled(ctx: ExtensionContext, enabled: boolean) {
		updateStatus(ctx, enabled);
		try {
			saveEnabled(enabled);
		} catch (error) {
			ctx.ui.notify(
				`Auto-mode status could not be saved and may reset after a reload or restart: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"error",
			);
		}
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
					`Classifier model: ${classifierServer.getModel()?.size ?? NO_MODEL_OPTION}`,
					[NO_MODEL_OPTION, ...CLASSIFIER_MODELS.map((model) => model.size)],
					{ signal: ctx.signal },
				);
				const model = choice === NO_MODEL_OPTION
					? null
					: CLASSIFIER_MODELS.find((candidate) => candidate.size === choice);
				if (model === undefined) return;

				try {
					await classifierServer.selectModel(model, ctx.signal);
					ctx.ui.notify(
						model ? `Classifier model set to ${model.size}.` : "No model selected. Only static policy rules are used.",
						"info",
					);
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
				setEnabled(ctx, false);
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

			setEnabled(ctx, true);
			try {
				if (classifierServer.getModel()) await classifierServer.ensureReady(ctx.signal);
				ctx.ui.notify("Auto-mode is on. Bash commands are checked.", "info");
			} catch (error) {
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
