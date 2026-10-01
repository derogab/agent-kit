import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-auto-mode-composition-test-"));
const agentDirectory = join(fixtureRoot, "agent");
const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDirectory;
mkdirSync(agentDirectory);

const { default: autoMode } = await import("../extensions/auto-mode.ts");

after(() => {
	if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
	rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
	rmSync(join(agentDirectory, "auto-mode-settings.json"), { force: true });
});

test("enabled state and no-model selection survive reloads, restarts, and session changes", async (t) => {
	const settingsPath = join(agentDirectory, "auto-mode-settings.json");
	let startupAttempts = 0;
	writeFileSync(join(agentDirectory, "auto-mode.json"), JSON.stringify({ deny: ["^blocked$"] }));

	function createInstance() {
		const handlers = new Map<string, Array<(event: any, context: any) => any>>();
		let command: { handler: (args: string, context: any) => Promise<void> } | undefined;
		let status: string | undefined;
		const selections: string[] = [];
		const context = {
			cwd: fixtureRoot,
			hasUI: true,
			isProjectTrusted: () => false,
			ui: {
				notify() {},
				select: async () => selections.shift(),
				setStatus: (_key: string, text: string | undefined) => { status = text; },
				theme: { fg: (_color: string, text: string) => text },
			},
		};
		autoMode({
			on(event: string, callback: (event: any, context: any) => any) {
				const callbacks = handlers.get(event) ?? [];
				callbacks.push(callback);
				handlers.set(event, callbacks);
			},
			registerCommand(_name: string, options: typeof command) { command = options; },
		} as never, {
			findCachedModel: async () => {
				startupAttempts += 1;
				throw new Error("classifier unavailable in test");
			},
		});
		assert.ok(command);
		const registeredCommand = command;
		async function emit(event: string, reason?: string) {
			for (const handler of handlers.get(event) ?? []) await handler({ type: event, reason }, context);
		}
		t.after(() => emit("session_shutdown"));
		return {
			emit,
			async choose(...choices: string[]) {
				selections.push(...choices);
				await registeredCommand.handler("", context);
			},
			checkCommand() {
				return handlers.get("tool_call")![0]({
					type: "tool_call", toolName: "bash", toolCallId: "test", input: { command: "blocked" },
				}, context);
			},
			get status() { return status; },
		};
	}

	const original = createInstance();
	await original.choose("Status", "Disable auto-mode");
	await original.emit("session_shutdown");
	assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).enabled, false);

	for (const reason of ["reload", "startup"]) {
		const restored = createInstance();
		await restored.emit("session_start", reason);
		assert.equal(restored.status, undefined);
		assert.equal(await restored.checkCommand(), undefined);
		await restored.choose("Model", "4B");
		await restored.emit("session_shutdown");
		await restored.emit("session_start", "switch");
		assert.equal(restored.status, undefined);
		assert.equal(startupAttempts, 0);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { enabled: false, model: "4B" });
		await restored.emit("session_shutdown");
	}

	const enabled = createInstance();
	await enabled.emit("session_start", "startup");
	await enabled.choose("Status", "Enable auto-mode");
	assert.equal(enabled.status, "⛨ inclusionAI/SingGuard-NSFA-4B-GGUF:4B");
	assert.equal((await enabled.checkCommand()).block, true);
	await enabled.emit("session_shutdown");
	assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).enabled, true);

	const restarted = createInstance();
	const previousAttempts = startupAttempts;
	await restarted.emit("session_start", "startup");
	assert.equal(startupAttempts, previousAttempts + 1);
	assert.equal(restarted.status, "⛨ inclusionAI/SingGuard-NSFA-4B-GGUF:4B");
	assert.equal((await restarted.checkCommand()).block, true);

	await restarted.choose("Model", "No model");
	await restarted.emit("session_shutdown");
	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { enabled: true, model: null });
	const attemptsBeforeStaticOnly = startupAttempts;
	for (const reason of ["reload", "startup"]) {
		const staticOnly = createInstance();
		await staticOnly.emit("session_start", reason);
		assert.equal(staticOnly.status, "\x1b[38;5;208m⛨\x1b[39m static only");
		assert.equal((await staticOnly.checkCommand()).block, true);
		await staticOnly.choose("Status", "Disable auto-mode");
		assert.equal(await staticOnly.checkCommand(), undefined);
		await staticOnly.choose("Status", "Enable auto-mode");
		assert.equal((await staticOnly.checkCommand()).block, true);
		await staticOnly.emit("session_shutdown");
		assert.equal(startupAttempts, attemptsBeforeStaticOnly);
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { enabled: true, model: null });
	}
});

test("the composition root connects the server, controls, and guard", async () => {
	let toolCallHandler: ((event: any, context: any) => Promise<any>) | undefined;
	let sessionStartHandlers = 0;
	let sessionShutdownHandlers = 0;
	let command: { handler: (args: string, context: any) => Promise<void> } | undefined;

	autoMode({
		on(event: string, callback: typeof toolCallHandler) {
			if (event === "tool_call") toolCallHandler = callback;
			if (event === "session_start") sessionStartHandlers += 1;
			if (event === "session_shutdown") sessionShutdownHandlers += 1;
		},
		registerCommand(name: string, options: typeof command) {
			assert.equal(name, "auto-mode");
			command = options;
		},
	} as never);

	assert.ok(toolCallHandler);
	assert.equal(sessionStartHandlers, 2);
	assert.equal(sessionShutdownHandlers, 2);
	assert.ok(command);

	let status: string | undefined;
	const selections = ["Status", "Disable auto-mode"];
	await command.handler("", {
		signal: undefined,
		hasUI: true,
		ui: {
			notify() {},
			select: async () => selections.shift(),
			setStatus: (_key: string, text: string | undefined) => {
				status = text;
			},
			theme: { fg: (_color: string, text: string) => text },
		},
	});

	writeFileSync(join(agentDirectory, "auto-mode.json"), JSON.stringify({ deny: ["^rm -rf /$"] }));
	const result = await toolCallHandler(
		{ type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "rm -rf /" } },
		{
			cwd: fixtureRoot,
			signal: undefined,
			hasUI: true,
			isProjectTrusted: () => false,
			ui: { confirm: async () => true },
		},
	);

	assert.equal(status, undefined);
	assert.equal(result, undefined);
});
