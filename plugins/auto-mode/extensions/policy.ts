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

interface CommandAnalysis {
	parts: string[];
	canAutoAllow: boolean;
}

interface ControlOperator {
	length: number;
	canTerminate: boolean;
}

function readControlOperator(command: string, index: number): ControlOperator | undefined {
	const rest = command.slice(index);
	if (rest.startsWith(";;&")) return { length: 3, canTerminate: true };
	if (rest.startsWith("&&") || rest.startsWith("||") || rest.startsWith("|&")) {
		return { length: 2, canTerminate: false };
	}
	if (rest.startsWith(";;") || rest.startsWith(";&")) return { length: 2, canTerminate: true };
	if (rest.startsWith(";")) return { length: 1, canTerminate: true };
	if (rest.startsWith("|")) return { length: 1, canTerminate: false };
	if (rest.startsWith("\n")) return { length: 1, canTerminate: true };
	if (
		rest.startsWith("&") &&
		command[index - 1] !== ">" &&
		command[index - 1] !== "<" &&
		command[index + 1] !== ">"
	) {
		return { length: 1, canTerminate: true };
	}
	return undefined;
}

function analyzeCommand(command: string): CommandAnalysis {
	const parts: string[] = [];
	let start = 0;
	let quote: "'" | '"' | undefined;
	let canAutoAllow = true;
	let sawOperator = false;
	let lastOperatorCanTerminate = false;

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];

		if (quote) {
			if (character === "\\" && quote !== "'") {
				index += 1;
			} else if (character === quote) {
				quote = undefined;
			} else if (
				quote === '"' &&
				(character === "`" || (character === "$" && command[index + 1] === "("))
			) {
				canAutoAllow = false;
			}
			continue;
		}

		if (character === "\\") {
			if (index + 1 >= command.length) canAutoAllow = false;
			index += 1;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (
			character === "`" ||
			character === "(" ||
			character === ")" ||
			((character === "$" || character === "<" || character === ">") && command[index + 1] === "(")
		) {
			canAutoAllow = false;
			continue;
		}

		const operator = readControlOperator(command, index);
		if (!operator) continue;

		const part = command.slice(start, index).trim();
		if (part) {
			parts.push(part);
			sawOperator = true;
			lastOperatorCanTerminate = operator.canTerminate;
		} else if (character !== "\n" || !sawOperator) {
			canAutoAllow = false;
			lastOperatorCanTerminate = operator.canTerminate;
		}
		index += operator.length - 1;
		start = index + 1;
	}

	if (quote) canAutoAllow = false;

	const finalPart = command.slice(start).trim();
	if (finalPart) {
		parts.push(finalPart);
	} else if (!lastOperatorCanTerminate) {
		canAutoAllow = false;
	}
	if (parts.length === 0) return { parts: [command], canAutoAllow: false };
	return { parts, canAutoAllow };
}

export function decideByPolicy(policy: PolicyConfig, command: string): PolicyDecision | undefined {
	const normalized = command.trim();
	const { parts, canAutoAllow } = analyzeCommand(normalized);

	if ([normalized, ...parts].some((part) => matchesPattern(policy.deny, part))) {
		return "deny";
	}
	if ([normalized, ...parts].some((part) => matchesPattern(policy.ask, part))) {
		return "ask";
	}
	if (canAutoAllow && parts.every((part) => matchesPattern(policy.allow, part))) {
		return "allow";
	}
	return undefined;
}
