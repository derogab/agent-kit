import { maskHereDocumentBodies, normalizeExpandableHereDocumentBody } from "./shell.ts";

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
	nestedParts: string[];
	canAutoAllow: boolean;
	failClosed: boolean;
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
	if (rest.startsWith("|") && command[index - 1] === ">") return undefined;
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

function readParenthesized(command: string, openingParenthesis: number) {
	let depth = 1;
	let quote: "'" | '"' | undefined;
	let ansiQuote = false;
	let comment = false;
	let atWordStart = true;
	const wordExpansionParentheses: boolean[] = [];
	for (let cursor = openingParenthesis + 1; cursor < command.length; cursor += 1) {
		const character = command[cursor];
		if (comment) {
			if (character !== "\n") continue;
			comment = false;
			atWordStart = true;
			continue;
		}
		if (quote) {
			if (character === "\\" && (quote === '"' || ansiQuote)) cursor += 1;
			else if (character === quote) {
				quote = undefined;
				ansiQuote = false;
			}
			continue;
		}
		if (character === "\\") {
			if (command[cursor + 1] !== "\n") atWordStart = false;
			cursor += 1;
			continue;
		}
		if (character === "$" && command[cursor + 1] === "'") {
			quote = "'";
			ansiQuote = true;
			atWordStart = false;
			cursor += 1;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			atWordStart = false;
			continue;
		}
		if (character === "#" && atWordStart) {
			comment = true;
			continue;
		}
		if (character === " " || character === "\t" || character === "\n") {
			atWordStart = true;
			continue;
		}
		if (character === "(") {
			const previous = command[cursor - 1];
			wordExpansionParentheses.push(previous !== undefined && "$<>?*+@!".includes(previous));
			depth += 1;
			atWordStart = true;
			continue;
		}
		if (character === ")") {
			depth -= 1;
			if (depth === 0) return { body: command.slice(openingParenthesis + 1, cursor), end: cursor };
			atWordStart = !(wordExpansionParentheses.pop() ?? false);
			continue;
		}
		// Other shell metacharacters separate words; ordinary characters continue one.
		atWordStart = character === ";" || character === "&" || character === "|" || character === "<" || character === ">";
	}
	return undefined;
}

function readBacktick(command: string, openingBacktick: number) {
	for (let cursor = openingBacktick + 1; cursor < command.length; cursor += 1) {
		if (command[cursor] === "\\") {
			cursor += 1;
			continue;
		}
		if (command[cursor] === "`") return { body: command.slice(openingBacktick + 1, cursor), end: cursor };
	}
	return undefined;
}

interface ParameterExpansion {
	content: string;
	end: number;
	commandBody?: string;
	promptTransform: boolean;
}

function readParameterExpansion(command: string, dollar: number): ParameterExpansion | undefined {
	let bracketDepth = 0;
	let nestedBraces = 0;
	let quote: "'" | '"' | undefined;
	let ansiQuote = false;
	for (let cursor = dollar + 2; cursor < command.length; cursor += 1) {
		const character = command[cursor];
		if (quote) {
			if (character === "\\" && (quote === '"' || ansiQuote)) cursor += 1;
			else if (character === quote) {
				quote = undefined;
				ansiQuote = false;
			}
			continue;
		}
		if (character === "\\") {
			cursor += 1;
			continue;
		}
		if (character === "$" && command[cursor + 1] === "'") {
			quote = "'";
			ansiQuote = true;
			cursor += 1;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "[") {
			bracketDepth += 1;
			continue;
		}
		if (character === "]" && bracketDepth > 0) {
			bracketDepth -= 1;
			continue;
		}
		if (character === "$" && command[cursor + 1] === "{") {
			nestedBraces += 1;
			cursor += 1;
			continue;
		}
		if (nestedBraces > 0) {
			if (character === "}") nestedBraces -= 1;
			continue;
		}
		if (character !== "}" || bracketDepth > 0) continue;

		const content = command.slice(dollar + 2, cursor);
		const marker = content[0];
		return {
			content,
			end: cursor,
			commandBody:
				marker === "|"
					? content.slice(1)
					: marker === " " || marker === "\t" || marker === "\n"
						? content
						: undefined,
			promptTransform: content.endsWith("@P"),
		};
	}
	return undefined;
}

// Extract commands conservatively for policy matching. Ambiguous executable syntax must not
// earn a regex allow, and contexts that could hide an exact deny or ask match fail closed.
function analyzeCommand(command: string, nestedExecutable = false): CommandAnalysis {
	const masked = maskHereDocumentBodies(command);
	const source = masked.source;
	const parts: string[] = [];
	const nestedParts: string[] = [];
	let start = 0;
	let quote: "'" | '"' | undefined;
	let ansiQuote = false;
	let commentStart: number | undefined;
	let atWordStart = true;
	const wordExpansionParentheses: boolean[] = [];
	let canAutoAllow = !masked.hasHereDocument && masked.complete;
	let failClosed = false;
	let sawOperator = false;
	let lastOperatorCanTerminate = false;

	const addNested = (body: string) => {
		const nested = analyzeCommand(body.trim(), true);
		nestedParts.push(...nested.parts, ...nested.nestedParts);
		if (nested.failClosed) failClosed = true;
	};
	const scanExpandableHereDocumentBody = (body: string) => {
		for (let index = 0; index < body.length; index += 1) {
			const character = body[index];
			if (character === "`") {
				const expansion = readBacktick(body, index);
				if (expansion) {
					addNested(expansion.body);
					index = expansion.end;
				}
				continue;
			}
			if (character !== "$") continue;

			if (body[index + 1] === "(" && body[index + 2] !== "(") {
				const expansion = readParenthesized(body, index + 1);
				if (expansion) {
					addNested(expansion.body);
					index = expansion.end;
				}
				continue;
			}
			if (body[index + 1] !== "{") continue;

			const expansion = readParameterExpansion(body, index);
			if (!expansion) continue;
			if (expansion.commandBody !== undefined) addNested(expansion.commandBody);
			else scanExpandableHereDocumentBody(expansion.content);
			index = expansion.end;
		}
	};
	for (const body of masked.expandableHereDocumentBodies) {
		// Quotes and comments are ordinary text in an unquoted heredoc body. Normalize the
		// backslashes that can suppress expansion, then inspect only executable expansions.
		scanExpandableHereDocumentBody(normalizeExpandableHereDocumentBody(body));
	}
	const handleParameterExpansion = (index: number) => {
		const expansion = readParameterExpansion(source, index);
		if (!expansion) {
			canAutoAllow = false;
			return undefined;
		}
		if (expansion.commandBody !== undefined) {
			canAutoAllow = false;
			addNested(expansion.commandBody);
		} else if (
			expansion.content.includes("$(") ||
			expansion.content.includes("`") ||
			expansion.content.includes("<(") ||
			expansion.content.includes(">(")
		) {
			const nested = analyzeCommand(expansion.content, true);
			nestedParts.push(...nested.nestedParts);
			if (nested.failClosed) failClosed = true;
			canAutoAllow = false;
		}
		if (expansion.promptTransform) canAutoAllow = false;
		return expansion.end;
	};

	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];

		if (commentStart !== undefined) {
			if (character !== "\n") continue;
		}

		if (quote) {
			if (character === "\\" && (quote !== "'" || ansiQuote)) {
				index += 1;
			} else if (character === quote) {
				quote = undefined;
				ansiQuote = false;
			} else if (quote === '"' && character === "`") {
				const expansion = readBacktick(source, index);
				canAutoAllow = false;
				if (expansion) {
					addNested(expansion.body);
					index = expansion.end;
				}
			} else if (quote === '"' && character === "$" && source[index + 1] === "(") {
				canAutoAllow = false;
				if (source[index + 2] !== "(") {
					const expansion = readParenthesized(source, index + 1);
					if (expansion) {
						addNested(expansion.body);
						index = expansion.end;
					}
				}
			} else if (quote === '"' && character === "$" && source[index + 1] === "{") {
				const end = handleParameterExpansion(index);
				if (end !== undefined) index = end;
			}
			continue;
		}

		if (character === "\\") {
			if (index + 1 >= source.length) canAutoAllow = false;
			if (source[index + 1] !== "\n") atWordStart = false;
			index += 1;
			continue;
		}
		if (character === "$" && source[index + 1] === "'") {
			quote = "'";
			ansiQuote = true;
			atWordStart = false;
			index += 1;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			atWordStart = false;
			continue;
		}
		if (character === "#" && atWordStart) {
			commentStart = index;
			continue;
		}
		if (
			nestedExecutable &&
			character === "c" &&
			atWordStart &&
			/^(?:(?:!|coproc)(?:[ \t]+|$))*$/.test(source.slice(start, index).trim()) &&
			source.startsWith("case", index) &&
			(index + 4 === source.length || /\s/.test(source[index + 4]))
		) {
			// A case pattern's `)` is context-sensitive and can be mistaken for the end of an
			// enclosing command substitution, including after shell prefixes. Block instead of
			// trusting partial analysis.
			failClosed = true;
		}
		if (character === " " || character === "\t") {
			atWordStart = true;
			continue;
		}
		if (character === "`") {
			canAutoAllow = false;
			const expansion = readBacktick(source, index);
			if (expansion) {
				addNested(expansion.body);
				index = expansion.end;
			}
			atWordStart = false;
			continue;
		}
		if ((character === "$" || character === "<" || character === ">") && source[index + 1] === "(") {
			canAutoAllow = false;
			if (!(character === "$" && source[index + 2] === "(")) {
				const expansion = readParenthesized(source, index + 1);
				if (expansion) {
					addNested(expansion.body);
					index = expansion.end;
				}
			}
			atWordStart = false;
			continue;
		}
		if (character === "$" && source[index + 1] === "[") {
			canAutoAllow = false;
			atWordStart = false;
			continue;
		}
		if (character === "$" && source[index + 1] === "{") {
			const end = handleParameterExpansion(index);
			if (end !== undefined) index = end;
			atWordStart = false;
			continue;
		}
		if (character === "(") {
			canAutoAllow = false;
			const previous = source[index - 1];
			wordExpansionParentheses.push(previous !== undefined && "$<>?*+@!".includes(previous));
			atWordStart = true;
			continue;
		}
		if (character === ")") {
			canAutoAllow = false;
			atWordStart = !(wordExpansionParentheses.pop() ?? false);
			continue;
		}

		const operator = readControlOperator(source, index);
		if (!operator) {
			atWordStart = character === "<" || character === ">" || (character === "|" && command[index - 1] === ">");
			continue;
		}

		const part = source.slice(start, commentStart ?? index).trim();
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
		commentStart = undefined;
		atWordStart = true;
	}

	if (quote) canAutoAllow = false;

	const finalPart = source.slice(start, commentStart).trim();
	if (finalPart) {
		parts.push(finalPart);
	} else if (!lastOperatorCanTerminate) {
		canAutoAllow = false;
	}
	if (parts.length === 0) return { parts: [command], nestedParts, canAutoAllow: false, failClosed };
	return { parts, nestedParts, canAutoAllow, failClosed };
}

export function decideByPolicy(policy: PolicyConfig, command: string): PolicyDecision | undefined {
	const normalized = command.trim();
	const { parts, nestedParts, canAutoAllow, failClosed } = analyzeCommand(normalized);
	const policyCandidates = [normalized, ...parts, ...nestedParts];

	if (failClosed) return "deny";
	if (policyCandidates.some((part) => matchesPattern(policy.deny, part))) {
		return "deny";
	}
	if (policyCandidates.some((part) => matchesPattern(policy.ask, part))) {
		return "ask";
	}
	if (canAutoAllow && parts.every((part) => matchesPattern(policy.allow, part))) {
		return "allow";
	}
	return undefined;
}
