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

export function decideByPolicy(policy: PolicyConfig, command: string): PolicyDecision | undefined {
	const candidate = command.trim();

	if (matchesPattern(policy.deny, candidate)) return "deny";
	if (matchesPattern(policy.ask, candidate)) return "ask";
	if (matchesPattern(policy.allow, candidate)) return "allow";
	return undefined;
}
