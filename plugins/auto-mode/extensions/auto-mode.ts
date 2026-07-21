import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { buildClassifierContext, parseClassifierDecision } from "./classifier.ts";
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

async function decideByAi(command: string, ctx: ExtensionContext): Promise<"allow" | "ask" | "deny"> {
	if (!ctx.model) {
		throw new Error("no model is selected");
	}

	const classifierContext = buildClassifierContext(command, ctx.cwd);
	const options = {
		signal: ctx.signal,
		reasoning: "medium" as const,
		cacheRetention: "none" as const,
	};
	// ExtensionContext currently exposes a compatibility ModelRegistry, while the backing runtime
	// owns session-scoped provider overrides and custom streams. Feature-detect that runtime and
	// retain the public compatibility path for older Pi releases.
	const registry = ctx.modelRegistry as unknown as {
		completeSimple?: typeof completeSimple;
		runtime?: { completeSimple: typeof completeSimple };
	};
	const sessionRuntime = registry.completeSimple ? registry : registry.runtime;
	let response;
	if (sessionRuntime?.completeSimple) {
		response = await sessionRuntime.completeSimple(ctx.model, classifierContext, options);
	} else {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) throw new Error(auth.error);
		response = await completeSimple(ctx.model, classifierContext, {
			...options,
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
		});
	}

	if (response.stopReason !== "stop") {
		throw new Error(response.errorMessage ?? `classifier stopped: ${response.stopReason}`);
	}

	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
	const decision = parseClassifierDecision(text);
	if (!decision) {
		throw new Error("classifier did not return ALLOW, ASK, or DENY");
	}
	return decision;
}

async function confirmCommand(command: string, ctx: ExtensionContext): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm("Allow Bash command?", sanitizeTerminalText(command));
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<{ command: string; allowed: boolean; source: "AI" | "REGEX" }>(
		"auto-mode-result",
		(entry, _options, theme) => {
			const result = entry.data ?? { command: "", allowed: false, source: "AI" };
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
		let source: "AI" | "REGEX" = "REGEX";
		if (decision === undefined) {
			source = "AI";
			try {
				decision = await decideByAi(command, ctx);
			} catch (error) {
				return {
					block: true,
					reason: `Auto mode AI check failed: ${error instanceof Error ? error.message : String(error)}`,
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
			const decisionSource = source === "AI" ? "the auto-mode AI safety check" : `an auto-mode ${decision} rule`;
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
			// Pi does not revalidate after later handlers mutate this shared input object.
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
