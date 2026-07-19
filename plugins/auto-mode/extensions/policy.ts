export interface PolicyConfig {
	allow: string[];
	ask: string[];
	deny: string[];
}

export type PolicyDecision = "allow" | "ask" | "deny";

const POLICY_KEYS = ["allow", "ask", "deny"] as const;

function readStringArray(config: Record<string, unknown>, key: (typeof POLICY_KEYS)[number]): string[] {
	const value = config[key];
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		throw new Error(`${key} must be an array of non-empty strings`);
	}
	return value as string[];
}

export function parsePolicyConfig(source: string): PolicyConfig {
	const parsed = JSON.parse(source) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("configuration must be a JSON object");
	}

	const config = parsed as Record<string, unknown>;
	const unknownKeys = Object.keys(config).filter((key) => !POLICY_KEYS.includes(key as (typeof POLICY_KEYS)[number]));
	if (unknownKeys.length > 0) {
		throw new Error(`unknown configuration field: ${unknownKeys.join(", ")}`);
	}

	const policy = {
		allow: readStringArray(config, "allow"),
		ask: readStringArray(config, "ask"),
		deny: readStringArray(config, "deny"),
	};

	for (const key of POLICY_KEYS) {
		for (const pattern of policy[key]) {
			try {
				new RegExp(pattern);
			} catch {
				throw new Error(`${key} contains an invalid regular expression: ${pattern}`);
			}
		}
	}

	return policy;
}

export function mergePolicyConfigs(...policies: PolicyConfig[]): PolicyConfig {
	return {
		allow: policies.flatMap((policy) => policy.allow),
		ask: policies.flatMap((policy) => policy.ask),
		deny: policies.flatMap((policy) => policy.deny),
	};
}

function matchesPattern(patterns: string[], command: string): boolean {
	return patterns.some((pattern) => new RegExp(pattern).test(command));
}

function splitCompoundCommand(command: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let quote: "'" | '"' | "`" | undefined;
	let parenthesisDepth = 0;

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];

		if (quote) {
			if (character === "\\" && quote !== "'") {
				index += 1;
			} else if (character === quote) {
				quote = undefined;
			}
			continue;
		}

		if (character === "\\") {
			if (index + 1 >= command.length) return [command];
			index += 1;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			continue;
		}
		if (character === "(") {
			parenthesisDepth += 1;
			continue;
		}
		if (character === ")" && parenthesisDepth > 0) {
			parenthesisDepth -= 1;
			continue;
		}
		if (parenthesisDepth > 0) continue;

		let operatorLength = 0;
		if (character === "&" && command[index + 1] === "&") {
			operatorLength = 2;
		} else if (character === "|" && command[index - 1] !== "|" && command[index + 1] !== "|") {
			operatorLength = 1;
		}
		if (operatorLength === 0) continue;

		const part = command.slice(start, index).trim();
		if (!part) return [command];
		parts.push(part);
		index += operatorLength - 1;
		start = index + 1;
	}

	if (quote || parenthesisDepth > 0) return [command];

	const finalPart = command.slice(start).trim();
	if (!finalPart) return [command];
	parts.push(finalPart);
	return parts;
}

export function decideByPolicy(policy: PolicyConfig, command: string): PolicyDecision | undefined {
	const normalized = command.trim();
	const parts = splitCompoundCommand(normalized);

	if ([normalized, ...parts].some((part) => matchesPattern(policy.deny, part))) {
		return "deny";
	}
	if ([normalized, ...parts].some((part) => matchesPattern(policy.ask, part))) {
		return "ask";
	}
	if (parts.every((part) => matchesPattern(policy.allow, part))) {
		return "allow";
	}
	return undefined;
}
