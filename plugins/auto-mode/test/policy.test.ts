import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildClassifierContext, parseClassifierDecision } from "../extensions/classifier.ts";
import { decideManually, mergePolicyConfigs, parsePolicyConfig } from "../extensions/policy.ts";

test("an empty configuration sends commands to the AI check", () => {
	assert.equal(decideManually(parsePolicyConfig("{}"), "git status"), "ai");
});

test("deny rules take precedence over allow rules", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["git"], deny: ["^git push --force$"] }));
	assert.equal(decideManually(policy, "git push --force"), "deny");
});

test("ask rules take precedence over allow rules", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^git push$"], ask: ["^git push$"] }));
	assert.equal(decideManually(policy, "git push"), "ask");
});

test("deny rules take precedence over ask rules", () => {
	const policy = parsePolicyConfig(JSON.stringify({ ask: ["^git push"], deny: ["^git push --force$"] }));
	assert.equal(decideManually(policy, "git push --force"), "deny");
});

test("user and project rules are combined", () => {
	const user = parsePolicyConfig('{"allow":["^npm test$"],"ask":["^git push$"]}');
	const project = parsePolicyConfig('{"allow":["^pnpm test$"],"deny":["^npm test$"]}');
	const policy = mergePolicyConfigs(user, project);
	assert.equal(decideManually(policy, "npm test"), "deny");
	assert.equal(decideManually(policy, "pnpm test"), "allow");
	assert.equal(decideManually(policy, "git push"), "ask");
});

test("anchored patterns match exact commands after trimming whitespace", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test$"] }));
	assert.equal(decideManually(policy, "  npm test\n"), "allow");
	assert.equal(decideManually(policy, "npm test -- --watch"), "ai");
});

test("regular expression rules match the full command string", () => {
	const policy = parsePolicyConfig(
		JSON.stringify({
			allow: ["^npm (test|run lint)(?:\\s|$)"],
			deny: ["(^|\\s)sudo(\\s|$)"],
		}),
	);
	assert.equal(decideManually(policy, "npm run lint -- --fix"), "allow");
	assert.equal(decideManually(policy, "cd app && sudo make install"), "deny");
});

test("all commands joined by && must match allow rules", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^cd app$", "^npm test$"] }));
	assert.equal(decideManually(policy, "cd app && npm test"), "allow");
	assert.equal(decideManually(policy, "cd app && npm run build"), "ai");
});

test("a full-command allow match does not bypass chained command checks", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test(?:\\s|$)"] }));
	assert.equal(decideManually(policy, "npm test && git push"), "ai");
});

test("all pipeline stages must match allow rules", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^git status$", "^wc -l$"] }));
	assert.equal(decideManually(policy, "git status | wc -l"), "allow");
	assert.equal(decideManually(policy, "git status | head"), "ai");
});

test("deny rules on a chained command take precedence", () => {
	const policy = parsePolicyConfig(
		JSON.stringify({
			allow: ["^npm test$", "^git push$", "^npm test && git push$"],
			deny: ["^git push$"],
		}),
	);
	assert.equal(decideManually(policy, "npm test && git push"), "deny");
});

test("ask rules on a chained command take precedence over allow rules", () => {
	const policy = parsePolicyConfig(
		JSON.stringify({
			allow: ["^npm test$", "^git push$"],
			ask: ["^git push$"],
		}),
	);
	assert.equal(decideManually(policy, "npm test && git push"), "ask");
});

test("quoted and escaped operators are not command separators", () => {
	const policy = parsePolicyConfig(
		JSON.stringify({
			allow: ["^printf 'left \\| right'$", "^printf 'left && right'$", "^printf left\\\\\\|right$", "^wc -c$"],
		}),
	);
	assert.equal(decideManually(policy, "printf 'left | right' | wc -c"), "allow");
	assert.equal(decideManually(policy, "printf 'left && right' && wc -c"), "allow");
	assert.equal(decideManually(policy, "printf left\\|right | wc -c"), "allow");
});

test("|| is not treated as a pipeline", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^git status$", "^git diff$"] }));
	assert.equal(decideManually(policy, "git status || git diff"), "ai");
});

test("invalid configuration fields and patterns are rejected", () => {
	assert.throws(() => parsePolicyConfig('{"extra":[]}'), /unknown configuration field/);
	assert.throws(() => parsePolicyConfig('{"allow":"git status"}'), /array of non-empty strings/);
	assert.throws(() => parsePolicyConfig('{"ask":["["]}'), /invalid regular expression/);
	assert.throws(() => parsePolicyConfig('{"deny":["["]}'), /invalid regular expression/);
});

test("the packaged example is valid", async () => {
	const source = await readFile(new URL("../auto-mode.example.json", import.meta.url), "utf8");
	const policy = parsePolicyConfig(source);
	assert.equal(decideManually(policy, "git status"), "allow");
	assert.equal(decideManually(policy, "git push"), "ask");
	assert.equal(decideManually(policy, "sudo make install"), "deny");
});

test("the classifier receives only its fixed prompt, cwd, and command", () => {
	const context = buildClassifierContext("npm test", "/workspace");
	assert.match(context.systemPrompt, /Return exactly ALLOW, ASK, or DENY\./);
	assert.equal(context.messages.length, 1);
	assert.deepEqual(JSON.parse(context.messages[0].content[0].text), {
		command: "npm test",
		cwd: "/workspace",
	});
});

test("only an exact classifier decision is accepted", () => {
	assert.equal(parseClassifierDecision(" ALLOW\n"), "allow");
	assert.equal(parseClassifierDecision("ASK"), "ask");
	assert.equal(parseClassifierDecision("DENY"), "deny");
	assert.equal(parseClassifierDecision("allow"), undefined);
	assert.equal(parseClassifierDecision("The command is safe: ALLOW"), undefined);
});
