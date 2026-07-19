import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	getAgentDir,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildClassifierContext, parseClassifierDecision } from "./classifier.ts";
import { decideManually, parsePolicyConfig } from "./policy.ts";

const CONFIG_PATH = join(getAgentDir(), "auto-mode.json");

async function loadPolicy() {
	try {
		return parsePolicyConfig(await readFile(CONFIG_PATH, "utf8"));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return parsePolicyConfig("{}");
		}
		throw error;
	}
}

async function checkWithAi(command: string, ctx: ExtensionContext): Promise<"allow" | "deny"> {
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
		maxTokens: 64,
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
		throw new Error("classifier did not return ALLOW or DENY");
	}
	return decision;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		let manualDecision;
		try {
			manualDecision = decideManually(await loadPolicy(), event.input.command);
		} catch (error) {
			return {
				block: true,
				reason: `Auto mode configuration error: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		if (manualDecision === "deny") {
			return { block: true, reason: "Blocked by an auto-mode deny rule" };
		}
		if (manualDecision === "allow") return;

		try {
			const aiDecision = await checkWithAi(event.input.command, ctx);
			if (aiDecision === "deny") {
				return { block: true, reason: "Blocked by the auto-mode AI safety check" };
			}
		} catch (error) {
			return {
				block: true,
				reason: `Auto mode AI check failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	});
}
