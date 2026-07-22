const UNSAFE_TERMINAL_CHARACTER =
	/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeTerminalText(text: string): string {
	return text.replace(UNSAFE_TERMINAL_CHARACTER, (character) => {
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

export function lockBashCommand(input: { command: string }, command = input.command): void {
	const descriptor = Object.getOwnPropertyDescriptor(input, "command");
	Object.defineProperty(input, "command", {
		configurable: false,
		enumerable: descriptor?.enumerable ?? true,
		value: command,
		writable: false,
	});
}
