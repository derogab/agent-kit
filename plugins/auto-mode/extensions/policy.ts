export interface PolicyConfig {
	allow: string[];
	deny: string[];
}

export type ManualDecision = "allow" | "deny" | "ai";

const POLICY_KEYS = ["allow", "deny"] as const;

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
		deny: policies.flatMap((policy) => policy.deny),
	};
}

function matchesPattern(patterns: string[], command: string): boolean {
	return patterns.some((pattern) => new RegExp(pattern).test(command));
}

export function decideManually(policy: PolicyConfig, command: string): ManualDecision {
	const normalized = command.trim();

	if (matchesPattern(policy.deny, normalized)) {
		return "deny";
	}
	if (matchesPattern(policy.allow, normalized)) {
		return "allow";
	}
	return "ai";
}
