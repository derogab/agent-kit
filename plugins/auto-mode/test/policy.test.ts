import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildClassifierContext, parseClassifierDecision } from "../extensions/classifier.ts";
import { decideManually, parsePolicyConfig } from "../extensions/policy.ts";

test("an empty configuration sends commands to the AI check", () => {
	assert.equal(decideManually(parsePolicyConfig("{}"), "git status"), "ai");
});

test("deny rules take precedence over allow rules", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allowPatterns: ["git"], denyCommands: ["git push --force"] }));
	assert.equal(decideManually(policy, "git push --force"), "deny");
});

test("exact commands ignore surrounding whitespace", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allowCommands: ["npm test"] }));
	assert.equal(decideManually(policy, "  npm test\n"), "allow");
	assert.equal(decideManually(policy, "npm test -- --watch"), "ai");
});

test("regular expression rules match the full command string", () => {
	const policy = parsePolicyConfig(
		JSON.stringify({
			allowPatterns: ["^npm (test|run lint)(?:\\s|$)"],
			denyPatterns: ["(^|\\s)sudo(\\s|$)"],
		}),
	);
	assert.equal(decideManually(policy, "npm run lint -- --fix"), "allow");
	assert.equal(decideManually(policy, "cd app && sudo make install"), "deny");
});

test("invalid configuration fields and patterns are rejected", () => {
	assert.throws(() => parsePolicyConfig('{"allows":["git status"]}'), /unknown configuration field/);
	assert.throws(() => parsePolicyConfig('{"allowCommands":"git status"}'), /array of non-empty strings/);
	assert.throws(() => parsePolicyConfig('{"denyPatterns":["["]}'), /invalid regular expression/);
});

test("the packaged example is valid", async () => {
	const source = await readFile(new URL("../auto-mode.example.json", import.meta.url), "utf8");
	const policy = parsePolicyConfig(source);
	assert.equal(decideManually(policy, "git status"), "allow");
	assert.equal(decideManually(policy, "sudo make install"), "deny");
});

test("the classifier receives only its fixed prompt, cwd, and command", () => {
	const context = buildClassifierContext("npm test", "/workspace");
	assert.equal(context.messages.length, 1);
	assert.deepEqual(JSON.parse(context.messages[0].content[0].text), {
		command: "npm test",
		cwd: "/workspace",
	});
});

test("only an exact classifier decision is accepted", () => {
	assert.equal(parseClassifierDecision(" ALLOW\n"), "allow");
	assert.equal(parseClassifierDecision("DENY"), "deny");
	assert.equal(parseClassifierDecision("allow"), undefined);
	assert.equal(parseClassifierDecision("The command is safe: ALLOW"), undefined);
});
