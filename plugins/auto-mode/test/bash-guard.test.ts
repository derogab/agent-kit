import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach, type TestContext } from "node:test";
import { CLASSIFIER_ENDPOINT, CLASSIFIER_MODEL } from "../extensions/classifier.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-auto-mode-guard-test-"));
const agentDirectory = join(fixtureRoot, "agent");
const userConfigPath = join(agentDirectory, "auto-mode.json");
const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDirectory;
mkdirSync(agentDirectory);

const { registerBashGuard } = await import("../extensions/bash-guard.ts");

after(() => {
	if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
	rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
	rmSync(userConfigPath, { force: true });
});

type DecisionSource = "MODEL" | "POLICY";

interface RecordedEntry {
	type: string;
	data: { command: string; allowed: boolean; source: DecisionSource };
}

interface RecordedRequest {
	input: string | URL | Request;
	init?: RequestInit;
}

function createHarness() {
	let handler: ((event: any, context: any) => Promise<any>) | undefined;
	const entries: RecordedEntry[] = [];

	registerBashGuard({
		on(event: string, callback: typeof handler) {
			assert.equal(event, "tool_call");
			handler = callback;
		},
		appendEntry(type: string, data: RecordedEntry["data"]) {
			entries.push({ type, data });
		},
	} as never, { isActive: () => true });

	assert.ok(handler);
	return { handler, entries };
}

function createContext(cwd: string, overrides: Record<string, unknown> = {}) {
	return {
		cwd,
		signal: undefined,
		hasUI: true,
		isProjectTrusted: () => false,
		ui: { confirm: async () => true },
		...overrides,
	};
}

function createCwd(name: string) {
	const cwd = join(fixtureRoot, name);
	mkdirSync(cwd, { recursive: true });
	return cwd;
}

function bashEvent(command: string) {
	return { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command } };
}

function writeUserConfig(config: unknown) {
	writeFileSync(userConfigPath, typeof config === "string" ? config : JSON.stringify(config));
}

function completion(risk: string): Response {
	return new Response(
		JSON.stringify({
			choices: [{ message: { content: `<analysis>Classification.</analysis><risks>${risk}</risks>` } }],
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

function mockClassifier(t: TestContext, responses: Array<Response | Error | (() => Promise<Response>)>) {
	const requests: RecordedRequest[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ input, init });
			const response = responses.shift();
			if (!response) throw new Error("unexpected classifier request");
			if (response instanceof Error) throw response;
			return typeof response === "function" ? response() : response;
		}) as typeof fetch,
	);
	return requests;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("only Bash tool calls are handled", async () => {
	const { handler, entries } = createHarness();
	const result = await handler(
		{ type: "tool_call", toolCallId: "call-1", toolName: "read", input: { path: "README.md" } },
		createContext(createCwd("non-bash")),
	);
	assert.equal(result, undefined);
	assert.deepEqual(entries, []);
});

test("policy decisions run before the model with deny, ask, allow precedence", async (t) => {
	writeUserConfig({
		allow: ["^echo (allow|ask|deny)$"],
		ask: ["^echo (ask|deny)$"],
		deny: ["^echo deny$"],
	});
	const requests = mockClassifier(t, []);
	const cwd = createCwd("policy-decisions");
	const confirmations: string[] = [];
	const context = createContext(cwd, {
		ui: {
			confirm: async (_title: string, command: string) => {
				confirmations.push(command);
				return true;
			},
		},
	});

	for (const [command, allowed] of [
		["echo allow", true],
		["echo ask", true],
		["echo deny", false],
	] as const) {
		const { handler, entries } = createHarness();
		const result = await handler(bashEvent(command), context);
		assert.equal(result?.block, allowed ? undefined : true, command);
		assert.deepEqual(entries, [
			{ type: "auto-mode-result", data: { command, allowed, source: "POLICY" } },
		]);
	}

	assert.deepEqual(confirmations, ["echo ask"]);
	assert.equal(requests.length, 0);
});

test("ask rules fail closed when confirmation is declined or unavailable", async () => {
	writeUserConfig({ ask: ["^deploy$"] });
	const cwd = createCwd("policy-ask-failures");
	for (const [name, context] of [
		["declined", createContext(cwd, { ui: { confirm: async () => false } })],
		["no UI", createContext(cwd, { hasUI: false })],
	] as const) {
		const { handler, entries } = createHarness();
		const event = bashEvent("deploy");
		const before = Object.getOwnPropertyDescriptor(event.input, "command");
		const result = await handler(event, context);
		assert.deepEqual(result, {
			block: true,
			reason: "Blocked because an auto-mode ask rule was not confirmed",
		}, name);
		assert.equal(entries[0].data.allowed, false, name);
		assert.deepEqual(Object.getOwnPropertyDescriptor(event.input, "command"), before, name);
	}
});

test("user and trusted project policy files are loaded on every call", async () => {
	writeUserConfig({ allow: ["^npm test$"] });
	const cwd = createCwd("combined-policy");
	const projectDirectory = join(cwd, ".pi");
	mkdirSync(projectDirectory);
	writeFileSync(join(projectDirectory, "auto-mode.json"), JSON.stringify({ deny: ["^npm test$"] }));

	for (const [trusted, allowed] of [
		[true, false],
		[false, true],
	] as const) {
		const { handler, entries } = createHarness();
		const result = await handler(
			bashEvent("npm test"),
			createContext(cwd, { isProjectTrusted: () => trusted }),
		);
		assert.equal(result?.block, allowed ? undefined : true, String(trusted));
		assert.equal(entries[0].data.allowed, allowed, String(trusted));
	}

	writeUserConfig("not JSON");
	const invalidUser = await createHarness().handler(bashEvent("npm test"), createContext(cwd));
	assert.match(invalidUser.reason, /^Auto mode configuration error:/);

	writeUserConfig({ allow: ["^npm test$"] });
	writeFileSync(join(projectDirectory, "auto-mode.json"), "not JSON");
	const invalidProject = await createHarness().handler(
		bashEvent("npm test"),
		createContext(cwd, { isProjectTrusted: () => true }),
	);
	assert.match(invalidProject.reason, /^Auto mode configuration error:/);
});

test("unmatched commands use the dedicated classifier server", async (t) => {
	const abortController = new AbortController();
	const requests = mockClassifier(t, [completion("No_Risk")]);
	const { handler, entries } = createHarness();
	const result = await handler(
		bashEvent("npm test"),
		createContext(createCwd("model-request"), { signal: abortController.signal }),
	);

	assert.equal(result, undefined);
	assert.deepEqual(entries, [
		{ type: "auto-mode-result", data: { command: "npm test", allowed: true, source: "MODEL" } },
	]);
	assert.equal(requests[0].input, CLASSIFIER_ENDPOINT);
	assert.equal(requests[0].init?.signal, abortController.signal);
	const body = JSON.parse(String(requests[0].init?.body));
	assert.equal(body.model, CLASSIFIER_MODEL);
	assert.deepEqual(body.messages, [
		{ role: "user", content: "<untrusted_output>\nnpm test\n</untrusted_output>" },
	]);
});

test("model risks and every classifier failure mode block", async (t) => {
	const malformed = new Response(JSON.stringify({ choices: [{ message: { content: "No_Risk" } }] }));
	const unavailable = new Response("unavailable", { status: 503 });
	mockClassifier(t, [completion("Hazardous_Action_Generation"), malformed, unavailable, new Error("offline")]);
	const cwd = createCwd("model-failures");

	const riskyHarness = createHarness();
	const risky = await riskyHarness.handler(bashEvent("rm -rf /"), createContext(cwd));
	assert.match(risky.reason, /Blocked by the model classifier/);
	assert.deepEqual(riskyHarness.entries, [
		{ type: "auto-mode-result", data: { command: "rm -rf /", allowed: false, source: "MODEL" } },
	]);

	for (const expected of [/well-formed <risks>/, /HTTP 503/, /offline/]) {
		const { handler, entries } = createHarness();
		const result = await handler(bashEvent("npm test"), createContext(cwd));
		assert.match(result.reason, expected);
		assert.match(result.reason, /^Auto mode classifier failed:/);
		assert.deepEqual(entries, []);
	}
});

test("the command is sealed only after model or confirmation approval", { timeout: 2_000 }, async (t) => {
	const modelStarted = deferred<void>();
	const releaseModel = deferred<void>();
	mockClassifier(t, [async () => {
		modelStarted.resolve();
		await releaseModel.promise;
		return completion("No_Risk");
	}]);

	const modelHarness = createHarness();
	const modelEvent = bashEvent("echo safe");
	const modelResult = modelHarness.handler(modelEvent, createContext(createCwd("mutation-lock")));
	await modelStarted.promise;
	assert.equal(Object.getOwnPropertyDescriptor(modelEvent.input, "command")?.writable, true);
	assert.equal(modelHarness.entries.length, 0);
	releaseModel.resolve();
	assert.equal(await modelResult, undefined);
	assert.equal(Object.getOwnPropertyDescriptor(modelEvent.input, "command")?.writable, false);
	assert.throws(() => {
		modelEvent.input.command = "echo changed";
	}, TypeError);

	writeUserConfig({ ask: ["^deploy safe$"] });
	const confirmationStarted = deferred<void>();
	const releaseConfirmation = deferred<boolean>();
	const askHarness = createHarness();
	const askEvent = bashEvent("deploy safe");
	const askResult = askHarness.handler(
		askEvent,
		createContext(createCwd("confirmation-lock"), {
			ui: {
				confirm: async () => {
					confirmationStarted.resolve();
					return releaseConfirmation.promise;
				},
			},
		}),
	);
	await confirmationStarted.promise;
	assert.equal(Object.getOwnPropertyDescriptor(askEvent.input, "command")?.writable, true);
	releaseConfirmation.resolve(true);
	assert.equal(await askResult, undefined);
	assert.equal(Object.getOwnPropertyDescriptor(askEvent.input, "command")?.writable, false);
});

test("a command changed while model approval is pending is blocked", { timeout: 2_000 }, async (t) => {
	const modelStarted = deferred<void>();
	const releaseModel = deferred<void>();
	mockClassifier(t, [async () => {
		modelStarted.resolve();
		await releaseModel.promise;
		return completion("No_Risk");
	}]);

	const { handler, entries } = createHarness();
	const event = bashEvent("echo safe");
	const resultPromise = handler(event, createContext(createCwd("mutation-during-check")));
	await modelStarted.promise;
	event.input.command = "echo changed";
	releaseModel.resolve();
	const result = await resultPromise;

	assert.match(result.reason, /command changed while approval was pending/);
	assert.equal(event.input.command, "echo changed");
	assert.equal(Object.getOwnPropertyDescriptor(event.input, "command")?.writable, true);
	assert.deepEqual(entries, []);
});

test("a Bash input that cannot be sealed is blocked only after approval", async () => {
	writeUserConfig({ allow: ["^npm test$"] });
	const { handler, entries } = createHarness();
	const event = bashEvent("npm test");
	Object.defineProperty(event.input, "command", {
		configurable: false,
		enumerable: false,
		get: () => "npm test",
	});
	const result = await handler(event, createContext(createCwd("unfreezable-input")));
	assert.match(result.reason, /^Auto mode could not secure Bash command:/);
	assert.equal(Object.getOwnPropertyDescriptor(event.input, "command")?.get?.(), "npm test");
	assert.deepEqual(entries, []);
});

test("sealing uses the exact command snapshot from a stable getter", async () => {
	writeUserConfig({ allow: ["^echo safe$"] });
	const { handler, entries } = createHarness();
	const event = bashEvent("echo safe");
	let reads = 0;
	Object.defineProperty(event.input, "command", {
		configurable: true,
		enumerable: true,
		get: () => {
			reads++;
			return "echo safe";
		},
	});
	const result = await handler(event, createContext(createCwd("getter-input")));
	assert.equal(result, undefined);
	assert.equal(reads, 2);
	assert.equal(event.input.command, "echo safe");
	assert.equal(entries[0].data.command, "echo safe");
});

test("an unreadable command fails the integrity check without changing its input", async () => {
	writeUserConfig({ allow: ["^echo safe$"] });
	const { handler, entries } = createHarness();
	const event = bashEvent("echo safe");
	let reads = 0;
	Object.defineProperty(event.input, "command", {
		configurable: true,
		enumerable: false,
		get: () => {
			if (reads++ === 0) return "echo safe";
			throw new Error("unreadable command");
		},
	});
	const before = Object.getOwnPropertyDescriptor(event.input, "command");
	const result = await handler(event, createContext(createCwd("unreadable-input")));
	assert.match(result.reason, /command changed while approval was pending/);
	assert.deepEqual(Object.getOwnPropertyDescriptor(event.input, "command"), before);
	assert.deepEqual(entries, []);
});

test("deny decisions leave the Bash input descriptor unchanged", async () => {
	writeUserConfig({ deny: ["^npm test$"] });
	const { handler } = createHarness();
	const event = bashEvent("npm test");
	const before = Object.getOwnPropertyDescriptor(event.input, "command");
	const result = await handler(event, createContext(createCwd("denied-input")));
	assert.match(result.reason, /Blocked by an auto-mode deny rule/);
	assert.deepEqual(Object.getOwnPropertyDescriptor(event.input, "command"), before);
	event.input.command = "npm run lint";
	assert.equal(event.input.command, "npm run lint");
});
