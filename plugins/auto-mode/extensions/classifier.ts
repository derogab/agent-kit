import { CLASSIFIER_MODEL } from "./model.ts";

export { CLASSIFIER_MODEL } from "./model.ts";

export type ClassifierDecision = "allow" | "deny";

interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: unknown;
			reasoning_content?: unknown;
		};
	}>;
}

function escapeXml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Keep untrusted commands inside the boundary format expected by the classifier. */
export function formatClassifierInput(command: string): string {
	return `<untrusted_output>\n${escapeXml(command)}\n</untrusted_output>`;
}

/**
 * The classifier is a binary risk detector. Only its exact no-risk label permits execution;
 * every risk label blocks the command.
 */
export function parseClassifierDecision(output: string): ClassifierDecision | undefined {
	const matches = [...output.matchAll(/<risks>([\s\S]*?)<\/risks>/g)];
	if (matches.length !== 1) return undefined;

	const risk = matches[0][1].trim();
	if (!risk) return undefined;
	return risk === "No_Risk" ? "allow" : "deny";
}

export async function classifyCommand(
	command: string,
	endpoint: string,
	signal?: AbortSignal,
): Promise<ClassifierDecision> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: CLASSIFIER_MODEL,
			messages: [{ role: "user", content: formatClassifierInput(command) }],
			temperature: 0,
			max_tokens: 2048,
			stream: false,
		}),
		signal,
	});

	if (!response.ok) {
		throw new Error(`classifier server returned HTTP ${response.status}`);
	}

	const payload = (await response.json()) as ChatCompletionResponse;
	const message = payload.choices?.[0]?.message;
	const outputs = [message?.content, message?.reasoning_content].filter(
		(output): output is string => typeof output === "string" && output.trim() !== "",
	);
	if (outputs.length === 0) {
		throw new Error("classifier server returned no text");
	}

	const decisions = outputs
		.map(parseClassifierDecision)
		.filter((decision): decision is ClassifierDecision => decision !== undefined);
	if (decisions.length === 0) {
		throw new Error("classifier did not return one well-formed <risks> result");
	}

	// Some llama.cpp chat templates separate reasoning from the final content. If both
	// contain labels, a risk in either field must win over No_Risk.
	return decisions.includes("deny") ? "deny" : "allow";
}
