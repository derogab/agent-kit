export interface PolicyConfig {
	allowCommands: string[];
	allowPatterns: string[];
	denyCommands: string[];
	denyPatterns: string[];
}

export type ManualDecision = "allow" | "deny" | "ai";

const POLICY_KEYS = ["allowCommands", "allowPatterns", "denyCommands", "denyPatterns"] as const;

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
		allowCommands: readStringArray(config, "allowCommands"),
		allowPatterns: readStringArray(config, "allowPatterns"),
		denyCommands: readStringArray(config, "denyCommands"),
		denyPatterns: readStringArray(config, "denyPatterns"),
	};

	for (const [key, patterns] of [
		["allowPatterns", policy.allowPatterns],
		["denyPatterns", policy.denyPatterns],
	] as const) {
		for (const pattern of patterns) {
			try {
				new RegExp(pattern);
			} catch {
				throw new Error(`${key} contains an invalid regular expression: ${pattern}`);
			}
		}
	}

	return policy;
}

function matchesPattern(patterns: string[], command: string): boolean {
	return patterns.some((pattern) => new RegExp(pattern).test(command));
}

export function decideManually(policy: PolicyConfig, command: string): ManualDecision {
	const normalized = command.trim();

	if (policy.denyCommands.includes(normalized) || matchesPattern(policy.denyPatterns, normalized)) {
		return "deny";
	}
	if (policy.allowCommands.includes(normalized) || matchesPattern(policy.allowPatterns, normalized)) {
		return "allow";
	}
	return "ai";
}
