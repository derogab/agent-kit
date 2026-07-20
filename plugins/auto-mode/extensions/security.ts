const TERMINAL_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/g;

export function sanitizeTerminalText(text: string): string {
	return text.replace(TERMINAL_CONTROL_CHARACTER, (character) => {
		switch (character) {
			case "\n":
				return "\\n";
			case "\r":
				return "\\r";
			case "\t":
				return "\\t";
			default:
				return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
		}
	});
}

export function lockBashCommand(input: { command: string }): void {
	Object.defineProperty(input, "command", {
		configurable: false,
		enumerable: true,
		value: input.command,
		writable: false,
	});
}
