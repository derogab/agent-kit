import assert from "node:assert/strict";
import test from "node:test";
import { lockBashCommand, sanitizeTerminalText } from "../extensions/security.ts";

test("terminal control characters are escaped before display", () => {
	const command = "printf '\x1b]52;c;clipboard\x07\x1b[31mred\x1b[0m\rnext\nline\tend\x9b2J'";
	const sanitized = sanitizeTerminalText(command);

	assert.equal(
		sanitized,
		"printf '\\u001b]52;c;clipboard\\u0007\\u001b[31mred\\u001b[0m\\rnext\\nline\\tend\\u009b2J'",
	);
	assert.doesNotMatch(sanitized, /[\u0000-\u001f\u007f-\u009f]/);
});

test("Unicode bidirectional controls are escaped before display", () => {
	const command = "printf '\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069'";
	const sanitized = sanitizeTerminalText(command);

	assert.equal(
		sanitized,
		"printf '\\u061c\\u200e\\u200f\\u202a\\u202b\\u202c\\u202d\\u202e\\u2066\\u2067\\u2068\\u2069'",
	);
	assert.doesNotMatch(sanitized, /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
});

test("an approved Bash command cannot be changed by a later handler", () => {
	const input = { command: "npm test", timeout: 30 };

	lockBashCommand(input);

	assert.throws(() => {
		input.command = "rm -rf /";
	}, TypeError);
	assert.throws(() => {
		delete (input as { command?: string }).command;
	}, TypeError);
	assert.equal(input.command, "npm test");
	assert.equal(input.timeout, 30);
});
