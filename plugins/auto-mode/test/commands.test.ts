import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { decideByPolicy, parsePolicyConfig, type PolicyConfig } from "../extensions/policy.ts";

const LIST_OPERATORS = ["&&", "||", "|", "|&", ";", "&", "\n"];

function assertFallsThrough(policy: PolicyConfig, commands: string[]) {
	for (const command of commands) {
		assert.equal(decideByPolicy(policy, command), undefined, command);
	}
}

test("every command joined by a list operator must match allow rules", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^cd app$", "^npm test$"] }));
	for (const operator of LIST_OPERATORS) {
		assert.equal(decideByPolicy(policy, "cd app " + operator + " npm test"), "allow", operator);
		assert.equal(decideByPolicy(policy, "cd app " + operator + " npm run build"), undefined, operator);
	}
});

test("control operator variants cannot hide an extra command", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test"] }));
	assertFallsThrough(policy, [
		"npm test&&git push",
		"npm test ||git push",
		"npm test| git push",
		"npm test |&git push",
		"npm test;git push",
		"npm test &git push",
		"npm test\ngit push",
		"npm test\r\ngit push",
		"npm test;;git push",
		"npm test;&git push",
		"npm test;;&git push",
		"npm test \\\n;git push",
		"npm test &&\ngit push",
		"npm test ||\ngit push",
		"npm test |\ngit push",
		"npm test |&\ngit push",
	]);
});

test("deny and ask rules apply on both sides of list operators", () => {
	const denyPolicy = parsePolicyConfig(
		JSON.stringify({ allow: ["^npm test$", "^git push$"], deny: ["^git push$"] }),
	);
	const askPolicy = parsePolicyConfig(
		JSON.stringify({ allow: ["^npm test$", "^git push$"], ask: ["^git push$"] }),
	);

	for (const operator of LIST_OPERATORS) {
		for (const command of ["npm test " + operator + " git push", "git push " + operator + " npm test"]) {
			assert.equal(decideByPolicy(denyPolicy, command), "deny", command);
			assert.equal(decideByPolicy(askPolicy, command), "ask", command);
		}
	}
});

test("nested execution syntax never receives a regex allow", () => {
	const policy = parsePolicyConfig(
		JSON.stringify({ allow: ["^npm test", "^\\(npm test\\)$"] }),
	);
	assertFallsThrough(policy, [
		"npm test $(git push)",
		'npm test "$(git push)"',
		"npm test \x60git push\x60",
		"npm test <(git push)",
		"npm test >(git push)",
		"(npm test)",
		"npm test $((1 + 1))",
		"npm test $[1 + 1]",
		"npm test ${value:-$(git push)}",
		'npm test "${value:-$(git push)}"',
		'npm test "$(printf \'%s\' "$(git push)")"',
		'npm test "${ git push; }"',
		'npm test "${| git push; }"',
	]);
});

test("prompt-string parameter transformations never receive a regex allow", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^printf"] }));
	assertFallsThrough(policy, [
		"printf '%s' ${value@P}",
		'printf \'%s\' "${value@P}"',
		"printf '%s' ${!value@P}",
		"printf '%s' ${values[${index}]@P}",
		'printf \'%s\' "${values[foo}bar]@P}"',
	]);
});

test("quoted and escaped shell syntax remains literal", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^printf"] }));
	for (const command of [
		"printf '%s' '$(git push); \x60git push\x60 | git push'",
		'printf "%s" "left; git push | git push"',
		"printf '%s' '$((1 + 1))'",
		"printf '%s' '$[1 + 1]'",
		"printf '%s' '${ git push; }'",
		"printf '%s' '${value@P}'",
		"printf '%s' '${values[foo}bar]@P}'",
		"printf '%s' '<(git push)'",
		"printf '%s' $'left; git push'",
		'printf "%s" "${HOME}"',
		'printf "%s" "${value:-text}"',
		"printf '%s' left\\;git\\ push",
		"printf '%s' left\\|git\\ push",
		"printf '%s' left\\&git\\ push",
		'printf "%s" "<(git push)"',
		'printf "%s" "\\$(git push)"',
		'printf "%s" "\\${value@P}"',
		'printf "%s" "\\${values[foo}bar]@P}"',
	]) {
		assert.equal(decideByPolicy(policy, command), "allow", command);
	}
});

test("ansi-c quoting cannot desync quote tracking to hide commands", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test"] }));
	assertFallsThrough(policy, [
		"npm test $'\\'' && git push #'",
		"npm test $'\\'' ; git push #'",
		"npm test $'\\'' | git push #'",
		"npm test $'\\'' $(git push) #'",
		"npm test $'unterminated",
		"npm test $'trailing backslash \\",
	]);
});

test("ansi-c quoted arguments stay literal when balanced", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^printf"] }));
	for (const command of [
		"printf '%s' $'left; git push'",
		"printf '%s' $'a\\'b'",
		"printf '%s' $'tab\\tand; git push'",
		"printf '%s' $'\\x27; git push'",
	]) {
		assert.equal(decideByPolicy(policy, command), "allow", command);
	}
});

test("comments cannot hide commands on following lines", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test"] }));
	assert.equal(decideByPolicy(policy, "npm test # harmless comment"), "allow");
	assert.equal(decideByPolicy(policy, "npm test # ; git push is still a comment"), "allow");
	assertFallsThrough(policy, [
		"npm test # harmless comment\ngit push",
		"npm test # backslash does not continue a comment \\\ngit push",
		"npm test && # comment\ngit push",
		"npm test; # comment\ngit push",
		"npm test#not-a-comment;git push",
		"npm test\\ #not-a-comment;git push",
	]);
});

test("comments cannot bypass exact deny or ask rules", () => {
	const denyPolicy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test"], deny: ["^npm test$"] }));
	const askPolicy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test"], ask: ["^npm test$"] }));
	assert.equal(decideByPolicy(denyPolicy, "npm test # comment"), "deny");
	assert.equal(decideByPolicy(askPolicy, "npm test # comment"), "ask");
});

test("malformed shell syntax never receives a regex allow", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test"] }));
	assertFallsThrough(policy, [
		"npm test &&",
		"npm test ||",
		"npm test |",
		"npm test |&",
		"npm test \\",
		"npm test 'unterminated",
		'npm test "unterminated',
		"npm test (",
		"npm test )",
		"npm test && || git push",
		"npm test | | git push",
	]);
});

test("compound shell constructs cannot hide additional commands", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test"] }));
	assertFallsThrough(policy, [
		"npm test; (git push)",
		"npm test && { git push; }",
		"npm test; if true; then git push; fi",
		"npm test; while true; do git push; done",
		"npm test; until false; do git push; done",
		"npm test; for item in one; do git push; done",
		"npm test; case x in x) git push ;; esac",
		"npm test; function run { git push; }; run",
		"npm test; run() { git push; }; run",
	]);
});

test("redirection ampersands are not mistaken for command separators", () => {
	const policy = parsePolicyConfig(
		JSON.stringify({
			allow: [
				"^npm test &>test.log$",
				"^npm test &>>test.log$",
				"^npm test 2>&1$",
				"^npm test 2<&0$",
				"^npm test >&2$",
				"^npm test <&0$",
				"^npm test >\\|test.log$",
			],
		}),
	);
	for (const command of [
		"npm test &>test.log",
		"npm test &>>test.log",
		"npm test 2>&1",
		"npm test 2<&0",
		"npm test >&2",
		"npm test <&0",
		"npm test >|test.log",
	]) {
		assert.equal(decideByPolicy(policy, command), "allow", command);
	}
});

test("expansions in redirections and input bodies cannot hide execution", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test"] }));
	assertFallsThrough(policy, [
		"npm test >$(git push)",
		'npm test >"$(git push)"',
		"npm test 2> >(git push)",
		"npm test <<<$(git push)",
		"npm test <<EOF\n$(git push)\nEOF",
		"npm test &>test.log;git push",
		"npm test 2>&1 && git push",
	]);
});

test("heredoc parsing can never turn an extra command into a regex allow", async () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test"] }));
	const exploit = [
		"npm test <<npm\\ test",
		"npm test '",
		"npm test",
		"# the shell still executes the command below",
		"git push",
		"' \\'",
	].join("\n");

	assertFallsThrough(policy, [
		exploit,
		"npm test <<EOF\nliteral input\nEOF",
		"npm test <<'EOF'\n$(git push)\nEOF",
		"npm test <<-EOF\n\tliteral input\n\tEOF",
		"npm test <<EOF\nliteral input\nEOF\ngit push",
	]);

	const denyPolicy = parsePolicyConfig(JSON.stringify({ allow: ["^npm test"], deny: ["^git push$"] }));
	assert.equal(decideByPolicy(denyPolicy, "npm test <<EOF\nliteral input\nEOF\ngit push"), "deny");
	assert.equal(decideByPolicy(denyPolicy, "npm test 😀 <<EOF\n😀 literal input\nEOF\ngit push"), "deny");
	assert.equal(decideByPolicy(denyPolicy, "npm test <<EOF\n$(git push)\nEOF"), "deny");
	assert.equal(decideByPolicy(denyPolicy, "npm test <<EOF\n`git push`\nEOF"), "deny");
	assert.equal(decideByPolicy(denyPolicy, "npm test <<EOF\n$\\\n(git push)\nEOF"), "deny");
	assert.equal(decideByPolicy(denyPolicy, "npm test <<EOF\n\\$(git push)\nEOF"), undefined);
	assert.equal(decideByPolicy(denyPolicy, "npm test <<'EOF'\ngit push\nEOF"), undefined);
	assert.equal(
		decideByPolicy(denyPolicy, "npm test <<$'\\x45OF'\nsafe\nEOF\ngit push\nx45OF"),
		"deny",
	);
});

test("deny and ask precedence includes nested executable expansions", () => {
	const denyPolicy = parsePolicyConfig(JSON.stringify({ ask: ["^printf"], deny: ["^git push$"] }));
	const askPolicy = parsePolicyConfig(JSON.stringify({ allow: ["^printf"], ask: ["^git push$"] }));
	const commands = [
		"printf x $(git push)",
		'printf x "$(git push)"',
		"printf x `git push`",
		'printf x "`git push`"',
		"printf x <(git push)",
		"printf x >(git push)",
		"printf x ${ git push; }",
		"printf x ${| git push; }",
	];

	for (const command of commands) {
		assert.equal(decideByPolicy(denyPolicy, command), "deny", command);
		assert.equal(decideByPolicy(askPolicy, command), "ask", command);
	}
});

test("parameter prompt detection is bounded to one balanced expansion", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^printf"] }));
	assert.equal(decideByPolicy(policy, "printf ${value} literal@P}"), "allow");
	assert.equal(decideByPolicy(policy, "printf ${values[foo}bar]} literal@P}"), "allow");
	assert.equal(decideByPolicy(policy, 'printf ${value:-"text"}'), "allow");
	assert.equal(decideByPolicy(policy, "printf ${value:-$'\\}'}"), "allow");
	assert.equal(decideByPolicy(policy, "printf ${value:-foo\\}bar}"), "allow");
	assert.equal(decideByPolicy(policy, "printf ${outer:-${inner}}"), "allow");
	assert.equal(decideByPolicy(policy, "printf ${value@P}"), undefined);
	assert.equal(decideByPolicy(policy, "printf ${values[${index}]@P}"), undefined);
	assert.equal(decideByPolicy(policy, "printf ${unterminated"), undefined);

	const command = `printf ${"${value} ".repeat(10_000)}`;
	const started = performance.now();
	assert.equal(decideByPolicy(policy, command), "allow");
	assert.ok(performance.now() - started < 500, "ordinary parameter expansions should be scanned in linear time");
});

test("escaped and unterminated executable expansions fail closed", () => {
	const policy = parsePolicyConfig(JSON.stringify({ allow: ["^printf"] }));
	const tick = "\x60";
	assertFallsThrough(policy, [
		"printf x $(printf \\))",
		"printf x $(printf $'\\)')",
		"printf x $(printf escaped\\)",
		`printf x ${tick}printf \\${tick}${tick}`,
		`printf x ${tick}unterminated`,
	]);
});
