import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-auto-mode-test-"));
const agentDirectory = join(fixtureRoot, "agent");
const userConfigPath = join(agentDirectory, "auto-mode.json");
const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDirectory;
mkdirSync(agentDirectory);

const { default: autoMode } = await import("../extensions/auto-mode.ts");

const faux = createFauxCore({
	api: "auto-mode-test",
	provider: "auto-mode-test",
	models: [{ id: "classifier", name: "Classifier" }],
});
const runtime = await ModelRuntime.create({
	authPath: join(agentDirectory, "auth.json"),
	modelsPath: null,
	allowModelNetwork: false,
});
const fauxModel = faux.getModel();
runtime.registerProvider("auto-mode-test", {
	api: faux.api,
	apiKey: "test-key",
	baseUrl: fauxModel.baseUrl,
	streamSimple: faux.streamSimple,
	models: [
		{
			id: fauxModel.id,
			name: fauxModel.name,
			reasoning: fauxModel.reasoning,
			input: fauxModel.input,
			cost: fauxModel.cost,
			contextWindow: fauxModel.contextWindow,
			maxTokens: fauxModel.maxTokens,
		},
	],
});
const model = runtime.getModel("auto-mode-test", "classifier");
assert.ok(model);
const modelRegistry = new ModelRegistry(runtime);

after(() => {
	if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
	rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
	rmSync(userConfigPath, { force: true });
	faux.setResponses([]);
});

interface RecordedEntry {
	type: string;
	data: { command: string; allowed: boolean; source: "AI" | "REGEX" };
}

function createHarness() {
	let handler: ((event: any, context: any) => Promise<any>) | undefined;
	let renderer: ((entry: any, options: any, theme: any) => { render(width: number): string[] }) | undefined;
	const entries: RecordedEntry[] = [];

	autoMode({
		on(event: string, callback: typeof handler) {
			if (event === "tool_call") handler = callback;
		},
		registerEntryRenderer(type: string, callback: typeof renderer) {
			assert.equal(type, "auto-mode-result");
			renderer = callback;
		},
		appendEntry(type: string, data: RecordedEntry["data"]) {
			entries.push({ type, data });
		},
	} as never);

	assert.ok(handler);
	assert.ok(renderer);
	return { handler, renderer, entries };
}

function createContext(cwd: string, overrides: Record<string, unknown> = {}) {
	return {
		cwd,
		model,
		modelRegistry,
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

function queueDecision(decision: "ALLOW" | "ASK" | "DENY") {
	faux.setResponses([fauxAssistantMessage(decision)]);
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

test("regex decisions run before AI with deny, ask, allow precedence", async () => {
	writeUserConfig({
		allow: ["^echo (allow|ask|deny)$"],
		ask: ["^echo (ask|deny)$"],
		deny: ["^echo deny$"],
	});
	const cwd = createCwd("regex-decisions");
	const confirmations: string[] = [];
	const context = createContext(cwd, {
		ui: {
			confirm: async (_title: string, command: string) => {
				confirmations.push(command);
				return true;
			},
		},
	});
	const callsBefore = faux.state.callCount;

	for (const [command, allowed] of [
		["echo allow", true],
		["echo ask", true],
		["echo deny", false],
	] as const) {
		const { handler, entries } = createHarness();
		const result = await handler(bashEvent(command), context);
		assert.equal(result?.block, allowed ? undefined : true, command);
		assert.deepEqual(entries, [
			{ type: "auto-mode-result", data: { command, allowed, source: "REGEX" } },
		]);
	}

	assert.deepEqual(confirmations, ["echo ask"]);
	assert.equal(faux.state.callCount, callsBefore);
});

test("ask decisions fail closed when confirmation is declined or unavailable", async () => {
	writeUserConfig({ ask: ["^deploy$"] });
	const cwd = createCwd("regex-ask-failures");
	for (const [name, context] of [
		["declined", createContext(cwd, { ui: { confirm: async () => false } })],
		["no UI", createContext(cwd, { hasUI: false })],
	] as const) {
		const { handler, entries } = createHarness();
		const result = await handler(bashEvent("deploy"), context);
		assert.deepEqual(result, {
			block: true,
			reason: "Blocked because an auto-mode ask rule was not confirmed",
		}, name);
		assert.equal(entries[0].data.allowed, false, name);
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

test("AI decisions use the session provider and an isolated classifier request", async () => {
	const cwd = createCwd("ai-request");
	const abortController = new AbortController();
	let request: { context: any; options: any } | undefined;
	faux.setResponses([
		(context, options) => {
			request = { context, options };
			return fauxAssistantMessage("ALLOW");
		},
	]);
	const { handler, entries } = createHarness();
	const result = await handler(
		bashEvent("npm test"),
		createContext(cwd, { signal: abortController.signal }),
	);

	assert.equal(result, undefined);
	assert.deepEqual(entries, [
		{ type: "auto-mode-result", data: { command: "npm test", allowed: true, source: "AI" } },
	]);
	assert.ok(request);
	assert.match(request.context.systemPrompt, /Return exactly ALLOW, ASK, or DENY/);
	assert.equal(request.context.messages.length, 1);
	const input = JSON.parse(request.context.messages[0].content[0].text);
	assert.equal(input.command, "npm test");
	assert.equal(input.cwd, realpathSync(cwd));
	assert.equal(request.options.reasoning, "medium");
	assert.equal(request.options.cacheRetention, "none");
	assert.equal(request.options.signal, abortController.signal);
});

test("every AI decision and failure mode fails or confirms explicitly", async () => {
	const cwd = createCwd("ai-outcomes");
	for (const [response, confirmed, allowed] of [
		["ALLOW", false, true],
		["ASK", true, true],
		["ASK", false, false],
		["DENY", false, false],
	] as const) {
		queueDecision(response);
		const { handler, entries } = createHarness();
		const result = await handler(
			bashEvent("npm test"),
			createContext(cwd, { ui: { confirm: async () => confirmed } }),
		);
		assert.equal(result?.block, allowed ? undefined : true, `${response}/${confirmed}`);
		assert.equal(entries[0].data.allowed, allowed, `${response}/${confirmed}`);
		assert.equal(entries[0].data.source, "AI");
	}

	faux.setResponses([fauxAssistantMessage("ALLOW.")]);
	const invalid = await createHarness().handler(bashEvent("npm test"), createContext(cwd));
	assert.match(invalid.reason, /classifier did not return ALLOW, ASK, or DENY/);

	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" })]);
	const providerError = await createHarness().handler(bashEvent("npm test"), createContext(cwd));
	assert.match(providerError.reason, /provider failed/);

	const noModel = await createHarness().handler(bashEvent("npm test"), createContext(cwd, { model: undefined }));
	assert.match(noModel.reason, /no model is selected/);

	queueDecision("ASK");
	const noUi = await createHarness().handler(bashEvent("npm test"), createContext(cwd, { hasUI: false }));
	assert.match(noUi.reason, /was not confirmed/);
});

test("older Pi contexts retain the authenticated compatibility completion path", async (t) => {
	const legacy = registerFauxProvider({ api: "auto-mode-legacy-test", provider: "auto-mode-legacy-test" });
	t.after(() => legacy.unregister());
	legacy.setResponses([fauxAssistantMessage("ALLOW")]);
	const legacyRegistry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "legacy-key", headers: { "x-test": "yes" } }),
	};
	const context = createContext(createCwd("legacy-provider"), {
		model: legacy.getModel(),
		modelRegistry: legacyRegistry,
	});
	const allowed = await createHarness().handler(bashEvent("npm test"), context);
	assert.equal(allowed, undefined);

	const authFailure = await createHarness().handler(
		bashEvent("npm test"),
		createContext(createCwd("legacy-auth-failure"), {
			model: legacy.getModel(),
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "missing credentials" }) },
		}),
	);
	assert.match(authFailure.reason, /missing credentials/);
});

test("the command is pinned before asynchronous AI and confirmation checks", { timeout: 2_000 }, async () => {
	const cwd = createCwd("mutation-lock");

	const aiStarted = deferred<void>();
	const releaseAi = deferred<void>();
	faux.setResponses([
		async () => {
			aiStarted.resolve();
			await releaseAi.promise;
			return fauxAssistantMessage("ALLOW");
		},
	]);
	const aiHarness = createHarness();
	const aiEvent = bashEvent("echo safe");
	const aiResult = aiHarness.handler(aiEvent, createContext(cwd));
	await aiStarted.promise;
	let aiMutationError: unknown;
	try {
		aiEvent.input.command = "echo changed";
	} catch (error) {
		aiMutationError = error;
	}
	releaseAi.resolve();
	await aiResult;
	assert.ok(aiMutationError instanceof TypeError);
	assert.equal(aiEvent.input.command, "echo safe");
	assert.equal(aiHarness.entries[0].data.command, "echo safe");

	const confirmationStarted = deferred<void>();
	const releaseConfirmation = deferred<boolean>();
	queueDecision("ASK");
	const askHarness = createHarness();
	const askEvent = bashEvent("deploy safe");
	const askResult = askHarness.handler(
		askEvent,
		createContext(cwd, {
			ui: {
				confirm: async () => {
					confirmationStarted.resolve();
					return releaseConfirmation.promise;
				},
			},
		}),
	);
	await confirmationStarted.promise;
	let askMutationError: unknown;
	try {
		askEvent.input.command = "deploy changed";
	} catch (error) {
		askMutationError = error;
	}
	releaseConfirmation.resolve(true);
	await askResult;
	assert.ok(askMutationError instanceof TypeError);
	assert.equal(askEvent.input.command, "deploy safe");
	assert.equal(askHarness.entries[0].data.command, "deploy safe");
});

test("a Bash input that cannot be pinned is blocked before policy or AI", async () => {
	const { handler, entries } = createHarness();
	const event = bashEvent("npm test");
	Object.defineProperty(event.input, "command", {
		configurable: false,
		enumerable: false,
		get: () => "npm test",
	});
	const result = await handler(event, createContext(createCwd("unfreezable-input")));
	assert.match(result.reason, /^Auto mode could not secure Bash command:/);
	assert.deepEqual(entries, []);
});

test("pinning uses the exact command snapshot even when an earlier handler installed a getter", async () => {
	writeUserConfig({ allow: ["^echo safe$"] });
	const { handler, entries } = createHarness();
	const event = bashEvent("echo safe");
	let reads = 0;
	Object.defineProperty(event.input, "command", {
		configurable: true,
		enumerable: true,
		get: () => (reads++ === 0 ? "echo safe" : "echo changed"),
	});
	const result = await handler(event, createContext(createCwd("getter-input")));
	assert.equal(result, undefined);
	assert.equal(event.input.command, "echo safe");
	assert.equal(entries[0].data.command, "echo safe");
});

test("result rendering sanitizes the command and shows source and outcome", () => {
	const { renderer } = createHarness();
	const backgrounds: string[] = [];
	const component = renderer(
		{ data: { command: "printf \u001b[31mred", allowed: false, source: "AI" } },
		{},
		{
			bg(name: string, text: string) {
				backgrounds.push(name);
				return text;
			},
		},
	);
	const rendered = component.render(80).join("\n");
	assert.match(rendered, /printf \\u001b\[31mred ✗ AI/);
	assert.ok(backgrounds.every((name) => name === "toolErrorBg"));
});
