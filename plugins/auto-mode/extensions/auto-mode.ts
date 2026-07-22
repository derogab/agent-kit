import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { classifyCommand } from "./classifier.ts";
import { decideByPolicy, mergePolicyConfigs, parsePolicyConfig } from "./policy.ts";
import { lockBashCommand, sanitizeTerminalText } from "./security.ts";

const USER_CONFIG_PATH = join(getAgentDir(), "auto-mode.json");
const COMMAND_CHANGED_REASON = "Auto mode blocked because the Bash command changed while approval was pending";

function bashCommandIsUnchanged(input: { command: string }, command: string): boolean {
	try {
		return input.command === command;
	} catch {
		return false;
	}
}

async function loadPolicyFile(path: string) {
	try {
		return parsePolicyConfig(await readFile(path, "utf8"));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return parsePolicyConfig("{}");
		}
		throw error;
	}
}

async function loadPolicy(ctx: ExtensionContext) {
	const paths = [USER_CONFIG_PATH];
	if (ctx.isProjectTrusted()) {
		paths.push(join(ctx.cwd, CONFIG_DIR_NAME, "auto-mode.json"));
	}
	return mergePolicyConfigs(...(await Promise.all(paths.map(loadPolicyFile))));
}

async function confirmCommand(command: string, ctx: ExtensionContext): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm("Allow Bash command?", sanitizeTerminalText(command));
}

type DecisionSource = "MODEL" | "POLICY";

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<{ command: string; allowed: boolean; source: DecisionSource }>(
		"auto-mode-result",
		(entry, _options, theme) => {
			const result = entry.data ?? { command: "", allowed: false, source: "MODEL" };
			const box = new Box(1, 0, (text) => theme.bg(result.allowed ? "toolSuccessBg" : "toolErrorBg", text));
			box.addChild(
				new Text(`${sanitizeTerminalText(result.command)} ${result.allowed ? "✓" : "✗"} ${result.source}`, 0, 0),
			);
			return box;
		},
	);

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;

		let policyDecision;
		try {
			policyDecision = decideByPolicy(await loadPolicy(ctx), command);
		} catch (error) {
			return {
				block: true,
				reason: `Auto mode configuration error: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		let decision = policyDecision;
		let source: DecisionSource = "POLICY";
		if (decision === undefined) {
			source = "MODEL";
			try {
				decision = await classifyCommand(command, ctx.signal);
			} catch (error) {
				return {
					block: true,
					reason: `Auto mode classifier failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		if (decision === "ask" && !bashCommandIsUnchanged(event.input, command)) {
			return {
				block: true,
				reason: COMMAND_CHANGED_REASON,
			};
		}

		const allowed = decision === "allow" || (decision === "ask" && (await confirmCommand(command, ctx)));
		if (!allowed) {
			pi.appendEntry("auto-mode-result", {
				command,
				allowed,
				source,
			});
			const decisionSource =
				source === "MODEL" ? "the model classifier" : `an auto-mode ${decision} rule`;
			return {
				block: true,
				reason: decision === "ask" ? `Blocked because ${decisionSource} was not confirmed` : `Blocked by ${decisionSource}`,
			};
		}

		if (!bashCommandIsUnchanged(event.input, command)) {
			return {
				block: true,
				reason: COMMAND_CHANGED_REASON,
			};
		}
		try {
			// Freeze the approved command because Pi does not revalidate this shared input after
			// later handlers run.
			lockBashCommand(event.input, command);
		} catch (error) {
			return {
				block: true,
				reason: `Auto mode could not secure Bash command: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		pi.appendEntry("auto-mode-result", {
			command,
			allowed,
			source,
		});
	});
}
