import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

function createRuntime() {
	const eventBus = new EventEmitter();
	const subscriptions: Array<() => void> = [];
	const handlers = new Map<string, Array<(event: any, context: any) => any>>();
	const commands: Array<{ name: string; handler: (args: string, context: any) => Promise<void> }> = [];
	const selections: string[] = [];
	const confirmations: string[] = [];
	let status: string | undefined;
	const context = {
		cwd: fixtureRoot,
		hasUI: true,
		isProjectTrusted: () => false,
		ui: {
			notify() {},
			select: async () => selections.shift(),
			confirm: async (_title: string, command: string) => {
				confirmations.push(command);
				return true;
			},
			setStatus: (_key: string, text: string | undefined) => { status = text; },
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	async function emit(event: string, reason?: string) {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, reason }, context);
	}
	return {
		commands,
		confirmations,
		emit,
		handlers,
		loadCopy(factory = autoMode) {
			// Each copy gets a separate API wrapper over the runtime's shared event bus.
			factory({
				events: {
					emit: (channel: string, data: unknown) => eventBus.emit(channel, data),
					on: (channel: string, handler: (data: unknown) => void) => {
						eventBus.on(channel, handler);
						const unsubscribe = () => { eventBus.off(channel, handler); };
						subscriptions.push(unsubscribe);
						return unsubscribe;
					},
				},
				on(event: string, handler: (event: any, context: any) => any) {
					const callbacks = handlers.get(event) ?? [];
					callbacks.push(handler);
					handlers.set(event, callbacks);
				},
				registerCommand(name: string, options: { handler: (args: string, context: any) => Promise<void> }) {
					commands.push({ name, handler: options.handler });
				},
			} as never, { loadModel: () => null });
		},
		async unload() {
			await emit("session_shutdown");
			// Pi invalidates the runtime and removes its subscriptions before reloading.
			for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
			handlers.clear();
			commands.length = 0;
		},
		async choose(...choices: string[]) {
			assert.equal(commands.length, 1);
			selections.push(...choices);
			await commands[0].handler("", context);
		},
		async checkCommand(command: string) {
			const event = { type: "tool_call", toolName: "bash", toolCallId: "test", input: { command } };
			for (const handler of handlers.get("tool_call") ?? []) {
				const result = await handler(event, context);
				if (result?.block) return result;
			}
		},
		get status() { return status; },
	};
}

function assertSingleRegistration(runtime: ReturnType<typeof createRuntime>) {
	assert.deepEqual(runtime.commands.map((command) => command.name), ["auto-mode"]);
	assert.equal(runtime.handlers.get("session_start")?.length, 2);
	assert.equal(runtime.handlers.get("session_shutdown")?.length, 2);
	assert.equal(runtime.handlers.get("tool_call")?.length, 1);
}

const { default: projectAutoMode } = await import(new URL("../extensions/auto-mode.ts?project", import.meta.url).href);

test("duplicate copies register one command, server lifecycle, and Bash guard", async (t) => {
	assert.notEqual(projectAutoMode, autoMode);
	const runtime = createRuntime();
	t.after(() => runtime.unload());
	writeFileSync(join(agentDirectory, "auto-mode.json"), JSON.stringify({ deny: ["^blocked$"] }));
	runtime.loadCopy();
	runtime.loadCopy(projectAutoMode);
	runtime.loadCopy();
	assertSingleRegistration(runtime);
	await runtime.emit("session_start", "startup");
	assert.equal(await runtime.checkCommand("unmatched"), undefined);
	assert.deepEqual(runtime.confirmations, ["unmatched"]);

	await runtime.choose("Status", "Disable auto-mode");
	assert.equal(runtime.status, undefined);
	assert.equal(await runtime.checkCommand("blocked"), undefined);
	assert.equal(await runtime.checkCommand("unmatched"), undefined);
	assert.deepEqual(runtime.confirmations, ["unmatched"]);

	// Session changes must not release the claim while the handlers still exist.
	await runtime.emit("session_shutdown");
	runtime.loadCopy(projectAutoMode);
	await runtime.emit("session_start", "switch");
	assertSingleRegistration(runtime);
	await runtime.choose("Status", "Enable auto-mode");
	assert.equal((await runtime.checkCommand("blocked")).block, true);
});

test("duplicate copies register again after reload and restore the enabled preference", async (t) => {
	const runtime = createRuntime();
	t.after(() => runtime.unload());
	writeFileSync(join(agentDirectory, "auto-mode.json"), JSON.stringify({ deny: ["^blocked$"] }));
	runtime.loadCopy();
	runtime.loadCopy(projectAutoMode);
	await runtime.emit("session_start", "startup");
	await runtime.choose("Status", "Disable auto-mode");

	for (const factories of [[projectAutoMode, autoMode], [autoMode, projectAutoMode]]) {
		await runtime.unload();
		for (const factory of factories) runtime.loadCopy(factory);
		assertSingleRegistration(runtime);
		await runtime.emit("session_start", "reload");
		assert.equal(runtime.status, undefined);
		assert.equal(await runtime.checkCommand("blocked"), undefined);
		await runtime.choose("Status", "Enable auto-mode");
		assert.equal((await runtime.checkCommand("blocked")).block, true);
		await runtime.choose("Status", "Disable auto-mode");
	}
});

test("duplicate registration guards keep separate Pi runtimes independent", async (t) => {
	const first = createRuntime();
	const second = createRuntime();
	t.after(() => first.unload());
	t.after(() => second.unload());
	writeFileSync(join(agentDirectory, "auto-mode.json"), JSON.stringify({ deny: ["^blocked$"] }));
	for (const runtime of [first, second]) {
		runtime.loadCopy();
		runtime.loadCopy(projectAutoMode);
		assertSingleRegistration(runtime);
		await runtime.emit("session_start", "startup");
		assert.equal((await runtime.checkCommand("blocked")).block, true);
	}
	await first.choose("Status", "Disable auto-mode");
	assert.equal(await first.checkCommand("blocked"), undefined);
	assert.equal((await second.checkCommand("blocked")).block, true);
	assert.notEqual(second.status, undefined);
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
			events: new EventEmitter(),
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
		assert.equal(staticOnly.status, "\x1b[38;5;208m⛨\x1b[39m policies only");
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
		events: new EventEmitter(),
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
