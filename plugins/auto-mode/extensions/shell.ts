interface HereDocument {
	delimiter: string;
	stripTabs: boolean;
	expandBody: boolean;
}

export interface MaskedShellSource {
	source: string;
	hasHereDocument: boolean;
	complete: boolean;
	expandableHereDocumentBodies: string[];
}

/** Apply the backslash rules that matter before scanning an unquoted heredoc body for expansions. */
export function normalizeExpandableHereDocumentBody(body: string): string {
	let normalized = "";
	for (let index = 0; index < body.length; index += 1) {
		const character = body[index];
		if (character !== "\\" || index + 1 >= body.length) {
			normalized += character;
			continue;
		}

		const next = body[index + 1];
		if (next === "\n") {
			index += 1;
			continue;
		}
		if (next === "\\" || next === "$" || next === "`") {
			normalized += "  ";
			index += 1;
			continue;
		}
		normalized += character;
	}
	return normalized;
}

function readHereDocument(source: string, start: number, stripTabs: boolean) {
	let index = start;
	while (source[index] === " " || source[index] === "\t") index += 1;

	let delimiter = "";
	let quote: "'" | '"' | undefined;
	let ansiQuote = false;
	let quoted = false;
	let active = false;
	for (; index < source.length; index += 1) {
		const character = source[index];
		if (quote === "'") {
			if (character === "\\" && ansiQuote && index + 1 < source.length) {
				// ANSI-C escapes can change the delimiter (for example, `\x45OF` becomes
				// `EOF`). Decoding all Bash forms here would be error-prone, so fail closed.
				return undefined;
			} else if (character === "'") {
				quote = undefined;
				ansiQuote = false;
			} else {
				delimiter += character;
			}
			active = true;
			continue;
		}
		if (quote === '"') {
			if (character === '"') {
				quote = undefined;
			} else if (character === "\\" && index + 1 < source.length) {
				const next = source[index + 1];
				if (next === "$" || next === "`" || next === '"' || next === "\\") {
					delimiter += next;
					index += 1;
				} else if (next === "\n") {
					index += 1;
				} else {
					delimiter += character;
				}
			} else {
				delimiter += character;
			}
			active = true;
			continue;
		}
		if (character === "\\") {
			active = true;
			if (index + 1 >= source.length) return undefined;
			if (source[index + 1] !== "\n") {
				delimiter += source[index + 1];
				quoted = true;
			}
			index += 1;
			continue;
		}
		if (character === "$" && (source[index + 1] === "'" || source[index + 1] === '"')) {
			// Locale-translated `$"..."` delimiters cannot be resolved without Bash's catalog.
			if (source[index + 1] === '"') return undefined;
			quote = source[index + 1] as "'" | '"';
			ansiQuote = quote === "'";
			quoted = true;
			active = true;
			index += 1;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			quoted = true;
			active = true;
			continue;
		}
		if (/\s/.test(character) || ";&|()<>".includes(character)) break;
		delimiter += character;
		active = true;
	}

	if (!active || quote) return undefined;
	return { document: { delimiter, stripTabs, expandBody: !quoted } satisfies HereDocument, end: index };
}

function maskRange(characters: string[], start: number, end: number) {
	for (let index = start; index < end; index += 1) {
		if (characters[index] !== "\n") characters[index] = " ";
	}
}

function startsHereDocument(source: string, index: number): boolean {
	return (
		source[index] === "<" &&
		source[index - 1] !== "<" &&
		source[index + 1] === "<" &&
		source[index + 2] !== "<"
	);
}

function startsShellComment(source: string, index: number): boolean {
	return (
		source[index] === "#" &&
		(index === 0 || /\s/.test(source[index - 1]) || ";&|()<>".includes(source[index - 1]))
	);
}

/**
 * Replace heredoc bodies and terminator lines with whitespace while preserving source offsets
 * and newlines. The shell scanners can then inspect commands after a heredoc without treating
 * literal input as shell syntax.
 */
export function maskHereDocumentBodies(source: string): MaskedShellSource {
	// Scanner offsets use JavaScript string indices (UTF-16 code units), so the mutable copy must too.
	const masked = source.split("");
	const pending: HereDocument[] = [];
	let quote: "'" | '"' | undefined;
	let ansiQuote = false;
	let comment = false;
	let atWordStart = true;
	const wordExpansionParentheses: boolean[] = [];
	let expansionParentheses = 0;
	// Each entry is the parenthesis depth to which its nested `$(` closes.
	const commandSubstitutions: number[] = [];
	const arithmeticExpansions: number[] = [];
	const quotedExpansions: number[] = [];
	let hasHereDocument = false;
	const expandableHereDocumentBodies: string[] = [];
	const insideCommandSubstitution = () => {
		const commandDepth = commandSubstitutions.at(-1);
		const arithmeticDepth = arithmeticExpansions.at(-1);
		return commandDepth !== undefined && (arithmeticDepth === undefined || commandDepth > arithmeticDepth);
	};

	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];

		if (comment) {
			if (character !== "\n") continue;
			comment = false;
		}

		if (quote) {
			if (quote === '"' && source.startsWith("$(", index)) {
				const arithmetic = source[index + 2] === "(";
				const baseDepth = expansionParentheses;
				if (arithmetic) arithmeticExpansions.push(baseDepth);
				else commandSubstitutions.push(baseDepth);
				quotedExpansions.push(baseDepth);
				expansionParentheses += arithmetic ? 2 : 1;
				quote = undefined;
				atWordStart = false;
				index += arithmetic ? 2 : 1;
			} else if (character === "\\" && (quote !== "'" || ansiQuote)) {
				index += 1;
			} else if (character === quote) {
				quote = undefined;
				ansiQuote = false;
			}
			continue;
		}

		if (expansionParentheses > 0 && !(character === "\n" && pending.length > 0)) {
			if (character === "\\") {
				index += 1;
			} else if (character === "$" && source[index + 1] === "'") {
				quote = "'";
				ansiQuote = true;
				index += 1;
			} else if (character === "'" || character === '"') {
				quote = character;
			} else if (insideCommandSubstitution() && startsShellComment(source, index)) {
				comment = true;
			} else if (source.startsWith("$((", index)) {
				arithmeticExpansions.push(expansionParentheses);
				expansionParentheses += 2;
				index += 2;
			} else if (source.startsWith("$(", index) && source[index + 2] !== "(") {
				commandSubstitutions.push(expansionParentheses);
				expansionParentheses += 1;
				index += 1;
			} else if (insideCommandSubstitution() && startsHereDocument(source, index)) {
				hasHereDocument = true;
				const stripTabs = source[index + 2] === "-";
				const parsed = readHereDocument(source, index + (stripTabs ? 3 : 2), stripTabs);
				if (!parsed) {
					return { source: masked.join(""), hasHereDocument, complete: false, expandableHereDocumentBodies };
				}
				pending.push(parsed.document);
				index = parsed.end - 1;
				atWordStart = false;
			} else if (character === "(") {
				expansionParentheses += 1;
			} else if (character === ")") {
				expansionParentheses -= 1;
				if (arithmeticExpansions.at(-1) === expansionParentheses) {
					arithmeticExpansions.pop();
				}
				if (commandSubstitutions.at(-1) === expansionParentheses) {
					commandSubstitutions.pop();
				}
				if (quotedExpansions.at(-1) === expansionParentheses) {
					quotedExpansions.pop();
					quote = '"';
				}
			}
			continue;
		}
		if (source.startsWith("$((", index)) {
			arithmeticExpansions.push(0);
			expansionParentheses = 2;
			atWordStart = false;
			index += 2;
			continue;
		}
		if (source.startsWith("((", index)) {
			arithmeticExpansions.push(0);
			expansionParentheses = 2;
			atWordStart = false;
			index += 1;
			continue;
		}

		if (character === "\\") {
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
			comment = true;
			continue;
		}

		if (startsHereDocument(source, index)) {
			hasHereDocument = true;
			const stripTabs = source[index + 2] === "-";
			const parsed = readHereDocument(source, index + (stripTabs ? 3 : 2), stripTabs);
			if (!parsed) {
				return { source: masked.join(""), hasHereDocument, complete: false, expandableHereDocumentBodies };
			}
			pending.push(parsed.document);
			index = parsed.end - 1;
			atWordStart = false;
			continue;
		}

		if (character === "\n" && pending.length > 0) {
			let bodyStart = index + 1;
			for (const document of pending) {
				const documentBodyStart = bodyStart;
				let found = false;
				while (bodyStart <= source.length) {
					const lineStart = bodyStart;
					const newline = source.indexOf("\n", bodyStart);
					const lineEnd = newline === -1 ? source.length : newline;
					const line = source.slice(bodyStart, lineEnd);
					const compared = document.stripTabs ? line.replace(/^\t+/, "") : line;
					maskRange(masked, bodyStart, newline === -1 ? lineEnd : lineEnd + 1);
					bodyStart = newline === -1 ? source.length + 1 : newline + 1;
					if (compared === document.delimiter) {
						if (document.expandBody) {
							expandableHereDocumentBodies.push(source.slice(documentBodyStart, lineStart));
						}
						found = true;
						break;
					}
					if (newline === -1) break;
				}
				if (!found) {
					return { source: masked.join(""), hasHereDocument, complete: false, expandableHereDocumentBodies };
				}
			}
			pending.length = 0;
			index = bodyStart - 1;
			atWordStart = true;
			continue;
		}

		if (character === "(") {
			const previous = source[index - 1];
			wordExpansionParentheses.push(previous !== undefined && "$<>?*+@!".includes(previous));
			atWordStart = true;
		} else if (character === ")") {
			atWordStart = !(wordExpansionParentheses.pop() ?? false);
		} else if (character === "\n" || character === ";" || character === "&" || character === "|") {
			atWordStart = true;
		} else if (character === " " || character === "\t" || character === "<" || character === ">") {
			atWordStart = true;
		} else {
			atWordStart = false;
		}
	}

	return {
		source: masked.join(""),
		hasHereDocument,
		complete: pending.length === 0,
		expandableHereDocumentBodies,
	};
}
