import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decideByPolicy, mergePolicyConfigs, parsePolicyConfig } from "../extensions/policy.ts";

test("an empty configuration has no policy decision", () => {
	assert.equal(decideByPolicy(parsePolicyConfig("{}"), "git status"), undefined);
});

test("deny rules take precedence over allow rules", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["git"], deny: ["^git push --force$"] }));
	assert.equal(decideByPolicy(policy, "git push --force"), "deny");
});

test("ask rules take precedence over allow rules", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^git push$"], ask: ["^git push$"] }));
	assert.equal(decideByPolicy(policy, "git push"), "ask");
});

test("deny rules take precedence over ask rules", () => {
	const policy = parsePolicyConfig(JSON.stringify({ ask: ["^git push"], deny: ["^git push --force$"] }));
	assert.equal(decideByPolicy(policy, "git push --force"), "deny");
});

test("user and project rules are combined", () => {
	const user = parsePolicyConfig('{"allow":["^npm test$"],"ask":["^git push$"]}');
	const project = parsePolicyConfig('{"allow":["^pnpm test$"],"deny":["^npm test$"]}');
	const policy = mergePolicyConfigs(user, project);
	assert.equal(decideByPolicy(policy, "npm test"), "deny");
	assert.equal(decideByPolicy(policy, "pnpm test"), "allow");
	assert.equal(decideByPolicy(policy, "git push"), "ask");
});

test("patterns are matched after surrounding whitespace is trimmed", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test$"] }));
	assert.equal(decideByPolicy(policy, "  npm test\n"), "allow");
	assert.equal(decideByPolicy(policy, "npm test -- --watch"), undefined);
});

test("regular expression patterns can cover command variants", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^npm (test|run lint)(?:\\s|$)"] }));
	assert.equal(decideByPolicy(policy, "npm run lint -- --fix"), "allow");
	assert.equal(decideByPolicy(policy, "pnpm run lint"), undefined);
});

test("invalid configuration shapes are rejected", () => {
	for (const source of [
		"null",
		"[]",
		'"allow"',
		'{"allow":null}',
		'{"allow":{}}',
		'{"allow":[null]}',
		'{"allow":[""]}',
		'{"allow":["   "]}',
		'{"extra":[]}',
		'{"__proto__":[]}',
	]) {
		assert.throws(() => parsePolicyConfig(source), undefined, source);
	}
});

test("invalid regular expression patterns are rejected", () => {
	for (const key of ["allow", "ask", "deny"]) {
		const source = JSON.stringify({ [key]: ["["] });
		assert.throws(() => parsePolicyConfig(source), /invalid regular expression/, key);
	}
});

test("the packaged example is valid", async () => {
	const source = await readFile(new URL("../auto-mode.example.json", import.meta.url), "utf8");
	const policy = parsePolicyConfig(source);
	assert.equal(decideByPolicy(policy, "git status"), "allow");
	assert.equal(decideByPolicy(policy, "git push"), "ask");
	assert.equal(decideByPolicy(policy, "sudo make install"), "deny");
});
