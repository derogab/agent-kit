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

const USER_CONFIG_PATH = join(getAgentDir(), "auto-mode.json");

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

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}

	const response = await completeSimple(ctx.model, buildClassifierContext(command, ctx.cwd), {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		signal: ctx.signal,
		reasoning: "medium",
		cacheRetention: "none",
	});

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
	return ctx.ui.confirm("Allow Bash command?", command);
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<{ command: string; allowed: boolean; source: "AI" | "REGEX" }>(
		"auto-mode-result",
		(entry, _options, theme) => {
			const result = entry.data ?? { command: "", allowed: false, source: "AI" };
			const box = new Box(1, 0, (text) => theme.bg(result.allowed ? "toolSuccessBg" : "toolErrorBg", text));
			box.addChild(new Text(`${result.command} ${result.allowed ? "✓" : "✗"} ${result.source}`, 0, 0));
			return box;
		},
	);

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		let policyDecision;
		try {
			policyDecision = decideByPolicy(await loadPolicy(ctx), event.input.command);
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
				decision = await decideByAi(event.input.command, ctx);
			} catch (error) {
				return {
					block: true,
					reason: `Auto mode AI check failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		const allowed = decision === "allow" || (decision === "ask" && (await confirmCommand(event.input.command, ctx)));
		pi.appendEntry("auto-mode-result", {
			command: event.input.command,
			allowed,
			source,
		});
		if (!allowed) {
			const decisionSource = source === "AI" ? "the auto-mode AI safety check" : `an auto-mode ${decision} rule`;
			return {
				block: true,
				reason: decision === "ask" ? `Blocked because ${decisionSource} was not confirmed` : `Blocked by ${decisionSource}`,
			};
		}
	});
}
