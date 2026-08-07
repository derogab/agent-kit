import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
	findFreePort,
	registerClassifierServer,
	type ClassifierServerDependencies,
} from "../extensions/server.ts";
import {
	CLASSIFIER_ALIAS,
	CLASSIFIER_MODELS,
	DEFAULT_CLASSIFIER_MODEL,
	type ClassifierModel,
} from "../extensions/model.ts";

class FakeProcess extends EventEmitter {
	exitCode: number | null = null;
	readonly pid: number = 4242;
	readonly signals: Array<NodeJS.Signals | number | undefined> = [];

	kill(signal?: NodeJS.Signals | number): boolean {
		this.signals.push(signal);
		this.exitCode = 0;
		this.emit("exit", 0, signal ?? null);
		return true;
	}

	crash(code = 1): void {
		this.exitCode = code;
		this.emit("exit", code, null);
	}
}

const tempRegistryDirs: string[] = [];

after(() => {
	for (const directory of tempRegistryDirs) rmSync(directory, { force: true, recursive: true });
});

function tempRegistryDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "auto-mode-registry-"));
	tempRegistryDirs.push(directory);
	return directory;
}

function createHarness(dependencies: ClassifierServerDependencies) {
	let sessionStart: ((event: any, context: any) => void) | undefined;
	let sessionShutdown: (() => Promise<void>) | undefined;
	const notifications: Array<{ message: string; type?: string }> = [];
	const killedPids: Array<{ pid: number; signal: NodeJS.Signals }> = [];
	const registryDirectory = dependencies.registryDirectory ?? tempRegistryDir();
	const classifierServer = registerClassifierServer({
		on(event: string, handler: any) {
			if (event === "session_start") sessionStart = handler;
			if (event === "session_shutdown") sessionShutdown = handler;
		},
	} as never, {
		// Treat every recorded pid as dead by default so tests exercise the
		// spawn path unless they opt into sharing, and never signal real processes.
		isProcessAlive: () => false,
		killProcess: (pid, signal) => killedPids.push({ pid, signal }),
		loadModel: () => DEFAULT_CLASSIFIER_MODEL,
		saveModel: () => {},
		...dependencies,
		registryDirectory,
	});

	assert.ok(sessionStart);
	assert.ok(sessionShutdown);
	const context = {
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
	};
	return {
		classifierServer,
		context,
		killedPids,
		notifications,
		registryDirectory,
		sessionShutdown,
		sessionStart,
	};
}

function healthyResponse(): Promise<Response> {
	return Promise.resolve(new Response('{"status":"ok"}'));
}

test("a free non-default localhost port is allocated", async () => {
	const port = await findFreePort();
	assert.equal(Number.isInteger(port), true);
	assert.ok(port > 0 && port <= 65_535);
	assert.notEqual(port, 8080);
});

test("the remembered model is restored when the server is registered", async () => {
	const model = CLASSIFIER_MODELS.find((candidate) => candidate.size === "2B");
	assert.ok(model);
	const harness = createHarness({ loadModel: () => model });

	assert.equal(harness.classifierServer.getModel(), model);

	await harness.sessionShutdown();
});

test("session startup launches llama serve on the allocated port", async () => {
	const child = new FakeProcess();
	let invocation: { command: string; args: readonly string[] } | undefined;
	let healthEndpoint: string | URL | Request | undefined;
	let downloadCalled = false;
	let cachedModel: ClassifierModel | undefined;
	const harness = createHarness({
		findCachedModel: async (model) => {
			cachedModel = model;
			return "/cache/model.gguf";
		},
		downloadModel: async () => {
			downloadCalled = true;
			return "/cache/model.gguf";
		},
		findFreePort: async () => 49_152,
		spawnServer: (command, args) => {
			invocation = { command, args };
			return child as unknown as ChildProcess;
		},
		fetch: (async (input) => {
			healthEndpoint = input;
			return healthyResponse();
		}) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	const endpoint = await harness.classifierServer.ensureReady();

	assert.equal(downloadCalled, false);
	assert.equal(cachedModel, DEFAULT_CLASSIFIER_MODEL);
	assert.equal(harness.classifierServer.getModel(), DEFAULT_CLASSIFIER_MODEL);
	assert.equal(endpoint, "http://127.0.0.1:49152/v1/chat/completions");
	assert.equal(healthEndpoint, "http://127.0.0.1:49152/health");
	assert.deepEqual(invocation, {
		command: "llama",
		args: [
			"serve",
			"--host",
			"127.0.0.1",
			"--port",
			"49152",
			"--model",
			"/cache/model.gguf",
			"--alias",
			CLASSIFIER_ALIAS,
		],
	});

	await harness.sessionShutdown();
});

test("the server address is published while running and cleared on stop", async () => {
	const child = new FakeProcess();
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		findFreePort: async () => 49_166,
		spawnServer: () => child as unknown as ChildProcess,
		fetch: (async () => healthyResponse()) as typeof fetch,
	});
	const addresses: Array<string | undefined> = [];
	harness.classifierServer.onAddressChange((address) => addresses.push(address));
	const ignored: Array<string | undefined> = [];
	const unsubscribe = harness.classifierServer.onAddressChange((address) => ignored.push(address));

	assert.equal(harness.classifierServer.getAddress(), undefined);

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await harness.classifierServer.ensureReady();

	assert.equal(harness.classifierServer.getAddress(), "127.0.0.1:49166");
	assert.deepEqual(addresses, ["127.0.0.1:49166"]);
	assert.deepEqual(ignored, ["127.0.0.1:49166"]);

	unsubscribe();
	await harness.sessionShutdown();

	assert.equal(harness.classifierServer.getAddress(), undefined);
	assert.deepEqual(addresses, ["127.0.0.1:49166", undefined]);
	assert.deepEqual(ignored, ["127.0.0.1:49166"]);
});

test("a missing model is downloaded before the server starts", async () => {
	const child = new FakeProcess();
	let downloadSignal: AbortSignal | undefined;
	let downloadedModel: ClassifierModel | undefined;
	let spawnCount = 0;
	const harness = createHarness({
		findCachedModel: async () => undefined,
		downloadModel: async (model, options) => {
			downloadedModel = model;
			downloadSignal = options?.signal;
			return "/cache/downloaded.gguf";
		},
		findFreePort: async () => 49_153,
		spawnServer: () => {
			spawnCount += 1;
			return child as unknown as ChildProcess;
		},
		fetch: (async () => healthyResponse()) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await harness.classifierServer.ensureReady();

	assert.ok(downloadSignal);
	assert.equal(downloadSignal.aborted, false);
	assert.equal(downloadedModel, DEFAULT_CLASSIFIER_MODEL);
	assert.equal(spawnCount, 1);
	assert.deepEqual(harness.notifications, [{
		message: "Downloading the auto-mode classifier model in the background...",
		type: "info",
	}]);

	await harness.sessionShutdown();
});

test("session shutdown stops only the owned server", async () => {
	const child = new FakeProcess();
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		findFreePort: async () => 49_154,
		spawnServer: () => child as unknown as ChildProcess,
		fetch: (async () => healthyResponse()) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await harness.classifierServer.ensureReady();
	await harness.sessionShutdown();

	assert.deepEqual(child.signals, ["SIGTERM"]);
	await assert.rejects(harness.classifierServer.ensureReady(), /not active/);
});

test("the server can be stopped and restarted while the session remains active", async () => {
	const children = [new FakeProcess(), new FakeProcess()];
	const ports = [49_155, 49_156];
	let spawnCount = 0;
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		findFreePort: async () => ports.shift() ?? 49_157,
		spawnServer: () => {
			const child = children[spawnCount];
			spawnCount += 1;
			return child as unknown as ChildProcess;
		},
		fetch: (async () => healthyResponse()) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	assert.equal(
		await harness.classifierServer.ensureReady(),
		"http://127.0.0.1:49155/v1/chat/completions",
	);

	await harness.classifierServer.stop();
	assert.deepEqual(children[0].signals, ["SIGTERM"]);

	assert.equal(
		await harness.classifierServer.ensureReady(),
		"http://127.0.0.1:49156/v1/chat/completions",
	);
	assert.equal(spawnCount, 2);

	await harness.sessionShutdown();
	assert.deepEqual(children[1].signals, ["SIGTERM"]);
});

test("selecting a model restarts an active server with that model", async () => {
	const children = [new FakeProcess(), new FakeProcess()];
	const ports = [49_157, 49_158];
	const invocations: Array<readonly string[]> = [];
	const requestedModels: ClassifierModel[] = [];
	let savedModel: ClassifierModel | undefined;
	const harness = createHarness({
		findCachedModel: async (model) => {
			const requestedModel = model ?? DEFAULT_CLASSIFIER_MODEL;
			requestedModels.push(requestedModel);
			return `/cache/${requestedModel.size}.gguf`;
		},
		findFreePort: async () => ports.shift() ?? 49_159,
		saveModel: (model) => {
			savedModel = model;
		},
		spawnServer: (_command, args) => {
			invocations.push(args);
			return children[invocations.length - 1] as unknown as ChildProcess;
		},
		fetch: (async () => healthyResponse()) as typeof fetch,
	});
	const addressEvents: Array<{ address: string | undefined; model: string }> = [];
	harness.classifierServer.onAddressChange((address) => {
		addressEvents.push({ address, model: harness.classifierServer.getModel().size });
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await harness.classifierServer.ensureReady();

	const fourB = CLASSIFIER_MODELS.find((model) => model.size === "4B");
	assert.ok(fourB);
	await harness.classifierServer.selectModel(fourB);

	assert.deepEqual(addressEvents, [
		{ address: "127.0.0.1:49157", model: "0.8B" },
		{ address: undefined, model: "4B" },
		{ address: "127.0.0.1:49158", model: "4B" },
	]);
	assert.deepEqual(children[0].signals, ["SIGTERM"]);
	assert.equal(harness.classifierServer.getModel(), fourB);
	assert.equal(savedModel, fourB);
	assert.deepEqual(requestedModels, [DEFAULT_CLASSIFIER_MODEL, fourB]);
	assert.equal(invocations[1][6], "/cache/4B.gguf");
	assert.equal(invocations[1][8], CLASSIFIER_ALIAS);
	assert.equal(
		await harness.classifierServer.ensureReady(),
		"http://127.0.0.1:49158/v1/chat/completions",
	);

	await harness.sessionShutdown();
	assert.deepEqual(children[1].signals, ["SIGTERM"]);
});

test("a failed model switch still reports the new model without an address", async () => {
	const children = [new FakeProcess(), new FakeProcess()];
	const ports = [49_167, 49_168];
	let spawnCount = 0;
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		findFreePort: async () => ports.shift() ?? 49_169,
		healthCheckIntervalMs: 0,
		healthCheckTimeoutMs: 0,
		spawnServer: () => {
			const child = children[spawnCount];
			spawnCount += 1;
			return child as unknown as ChildProcess;
		},
		fetch: (async () =>
			spawnCount === 1
				? healthyResponse()
				: new Response(null, { status: 503 })) as typeof fetch,
	});
	const addressEvents: Array<{ address: string | undefined; model: string }> = [];
	harness.classifierServer.onAddressChange((address) => {
		addressEvents.push({ address, model: harness.classifierServer.getModel().size });
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await harness.classifierServer.ensureReady();

	const fourB = CLASSIFIER_MODELS.find((model) => model.size === "4B");
	assert.ok(fourB);
	await assert.rejects(
		harness.classifierServer.selectModel(fourB),
		/llama serve did not become ready in time/,
	);

	assert.equal(harness.classifierServer.getModel(), fourB);
	assert.deepEqual(addressEvents, [
		{ address: "127.0.0.1:49167", model: "0.8B" },
		{ address: undefined, model: "4B" },
	]);

	await harness.sessionShutdown();
	assert.deepEqual(children[1].signals, ["SIGTERM"]);
});

function seedRegistry(entry: { pid: number; port: number; users: number[] }): string {
	const registryDirectory = tempRegistryDir();
	writeFileSync(
		join(registryDirectory, "auto-mode-server-0.8B.json"),
		JSON.stringify(entry),
		"utf8",
	);
	return registryDirectory;
}

function readRegistryUsers(registryDirectory: string): number[] {
	const entry = JSON.parse(
		readFileSync(join(registryDirectory, "auto-mode-server-0.8B.json"), "utf8"),
	);
	return entry.users;
}

test("startup attaches to another instance's healthy server and leaves it running", async () => {
	const registryDirectory = seedRegistry({ pid: 7042, port: 49_180, users: [7001] });
	let spawnCount = 0;
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		isProcessAlive: (pid) => pid === 7042 || pid === 7001,
		registryDirectory,
		spawnServer: () => {
			spawnCount += 1;
			return new FakeProcess() as unknown as ChildProcess;
		},
		fetch: (async () => healthyResponse()) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	const endpoint = await harness.classifierServer.ensureReady();

	assert.equal(endpoint, "http://127.0.0.1:49180/v1/chat/completions");
	assert.equal(spawnCount, 0);
	assert.deepEqual(readRegistryUsers(registryDirectory), [7001, process.pid]);

	await harness.sessionShutdown();

	assert.deepEqual(harness.killedPids, []);
	assert.deepEqual(readRegistryUsers(registryDirectory), [7001]);
});

test("the last instance to leave stops the shared server", async () => {
	const registryDirectory = seedRegistry({ pid: 7042, port: 49_181, users: [7001] });
	const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		// The server is alive until this instance signals it; the other user is gone.
		isProcessAlive: (pid) => pid === 7042 && !killed.some((kill) => kill.pid === pid),
		killProcess: (pid, signal) => killed.push({ pid, signal }),
		registryDirectory,
		fetch: (async () => healthyResponse()) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await harness.classifierServer.ensureReady();
	await harness.sessionShutdown();

	assert.deepEqual(killed, [{ pid: 7042, signal: "SIGTERM" }]);
	assert.equal(existsSync(join(registryDirectory, "auto-mode-server-0.8B.json")), false);
});

test("an owned server survives shutdown while another live instance uses it", async () => {
	const child = new FakeProcess();
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		findFreePort: async () => 49_182,
		isProcessAlive: (pid) => pid === 7001,
		spawnServer: () => child as unknown as ChildProcess,
		fetch: (async () => healthyResponse()) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await harness.classifierServer.ensureReady();

	const registryPath = join(harness.registryDirectory, "auto-mode-server-0.8B.json");
	assert.deepEqual(JSON.parse(readFileSync(registryPath, "utf8")), {
		pid: child.pid,
		port: 49_182,
		users: [process.pid],
	});
	writeFileSync(
		registryPath,
		JSON.stringify({ pid: child.pid, port: 49_182, users: [process.pid, 7001] }),
		"utf8",
	);

	await harness.sessionShutdown();

	assert.deepEqual(child.signals, []);
	assert.deepEqual(harness.killedPids, []);
	assert.deepEqual(readRegistryUsers(harness.registryDirectory), [7001]);
});

test("a vanished shared server is replaced on the next readiness check", async () => {
	const registryDirectory = seedRegistry({ pid: 7042, port: 49_183, users: [7001] });
	const child = new FakeProcess();
	let sharedServerAlive = true;
	let spawnCount = 0;
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		findFreePort: async () => 49_184,
		isProcessAlive: (pid) => pid === 7042 && sharedServerAlive,
		registryDirectory,
		spawnServer: () => {
			spawnCount += 1;
			return child as unknown as ChildProcess;
		},
		fetch: (async () => healthyResponse()) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	assert.equal(
		await harness.classifierServer.ensureReady(),
		"http://127.0.0.1:49183/v1/chat/completions",
	);
	assert.equal(spawnCount, 0);

	sharedServerAlive = false;
	assert.equal(
		await harness.classifierServer.ensureReady(),
		"http://127.0.0.1:49184/v1/chat/completions",
	);
	assert.equal(spawnCount, 1);
	assert.deepEqual(readRegistryUsers(registryDirectory), [process.pid]);

	await harness.sessionShutdown();
	assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("stopping during warm-up leaves the server for an instance that joined meanwhile", async () => {
	const child = new FakeProcess();
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		findFreePort: async () => 49_185,
		isProcessAlive: (pid) => pid === 7001,
		spawnServer: () => child as unknown as ChildProcess,
		// Health never resolves: the server stays in warm-up for the whole test.
		fetch: (async () => new Promise<Response>(() => {})) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	const pending = harness.classifierServer.ensureReady();
	pending.catch(() => {});

	const registryPath = join(harness.registryDirectory, "auto-mode-server-0.8B.json");
	for (let attempt = 0; !existsSync(registryPath); attempt += 1) {
		assert.ok(attempt < 1_000, "registry entry was never written");
		await new Promise((resolve) => setImmediate(resolve));
	}
	const entry = JSON.parse(readFileSync(registryPath, "utf8"));
	writeFileSync(registryPath, JSON.stringify({ ...entry, users: [...entry.users, 7001] }));

	await harness.classifierServer.stop();

	assert.deepEqual(child.signals, []);
	assert.deepEqual(harness.killedPids, []);
	assert.deepEqual(readRegistryUsers(harness.registryDirectory), [7001]);

	await harness.sessionShutdown();
	assert.deepEqual(child.signals, []);
});

test("shutdown never signals a pid whose registry entry was replaced", async () => {
	const registryDirectory = seedRegistry({ pid: 7042, port: 49_186, users: [7001] });
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		isProcessAlive: () => true,
		registryDirectory,
		fetch: (async () => healthyResponse()) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await harness.classifierServer.ensureReady();

	// Another instance replaced the entry, e.g. after this server died and its pid
	// could have been recycled by an unrelated process.
	const registryPath = join(registryDirectory, "auto-mode-server-0.8B.json");
	writeFileSync(registryPath, JSON.stringify({ pid: 8055, port: 49_187, users: [8001] }));

	await harness.sessionShutdown();

	assert.deepEqual(harness.killedPids, []);
	assert.deepEqual(JSON.parse(readFileSync(registryPath, "utf8")), {
		pid: 8055,
		port: 49_187,
		users: [8001],
	});
});

test("shutdown does not signal the shared server pid when its port no longer answers", async () => {
	const registryDirectory = seedRegistry({ pid: 7042, port: 49_188, users: [] });
	let serverUp = true;
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		isProcessAlive: (pid) => pid === 7042,
		registryDirectory,
		fetch: (async () => {
			if (serverUp) return healthyResponse();
			throw new TypeError("fetch failed");
		}) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await harness.classifierServer.ensureReady();

	// The server dies but its pid reads as alive again, as a recycled pid would.
	serverUp = false;
	await harness.sessionShutdown();

	assert.deepEqual(harness.killedPids, []);
	assert.equal(existsSync(join(registryDirectory, "auto-mode-server-0.8B.json")), false);
});

test("a throwing address listener does not break the server lifecycle", async () => {
	const child = new FakeProcess();
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		findFreePort: async () => 49_170,
		spawnServer: () => child as unknown as ChildProcess,
		fetch: (async () => healthyResponse()) as typeof fetch,
	});
	harness.classifierServer.onAddressChange(() => {
		throw new Error("listener failed");
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	assert.equal(
		await harness.classifierServer.ensureReady(),
		"http://127.0.0.1:49170/v1/chat/completions",
	);

	await harness.sessionShutdown();
	assert.deepEqual(child.signals, ["SIGTERM"]);
	assert.deepEqual(harness.notifications, []);
});

test("an owned server is restarted on another free port after a crash", async () => {
	const children = [new FakeProcess(), new FakeProcess()];
	const ports = [49_159, 49_160];
	let spawnCount = 0;
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		findFreePort: async () => ports.shift() ?? 49_161,
		restartDelayMs: 0,
		spawnServer: () => {
			const child = children[spawnCount];
			spawnCount += 1;
			return child as unknown as ChildProcess;
		},
		fetch: (async () => healthyResponse()) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	assert.equal(
		await harness.classifierServer.ensureReady(),
		"http://127.0.0.1:49159/v1/chat/completions",
	);

	children[0].crash();
	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.equal(spawnCount, 2);
	assert.equal(
		await harness.classifierServer.ensureReady(),
		"http://127.0.0.1:49160/v1/chat/completions",
	);
	await harness.sessionShutdown();
});

test("startup failures are reported without leaving auto-mode unguarded", async () => {
	const child = new FakeProcess();
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		findFreePort: async () => 49_162,
		spawnServer: () => {
			queueMicrotask(() => child.emit("error", new Error("spawn failed")));
			return child as unknown as ChildProcess;
		},
		fetch: (async () => new Promise<Response>(() => {})) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await assert.rejects(harness.classifierServer.ensureReady(), /spawn failed/);
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(harness.notifications, [{
		message: "Auto-mode classifier could not start: spawn failed",
		type: "error",
	}]);
	await harness.sessionShutdown();
});

test("a health timeout stops the failed server before a readiness retry", async () => {
	const children = [new FakeProcess(), new FakeProcess()];
	const ports = [49_163, 49_164];
	let spawnCount = 0;
	const harness = createHarness({
		findCachedModel: async () => "/cache/model.gguf",
		findFreePort: async () => ports.shift() ?? 49_165,
		healthCheckIntervalMs: 0,
		healthCheckTimeoutMs: 0,
		restartDelayMs: 0,
		spawnServer: () => {
			const child = children[spawnCount];
			spawnCount += 1;
			return child as unknown as ChildProcess;
		},
		fetch: (async () =>
			spawnCount === 1
				? new Response(null, { status: 503 })
				: healthyResponse()) as typeof fetch,
	});

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await assert.rejects(
		harness.classifierServer.ensureReady(),
		/llama serve did not become ready in time/,
	);

	assert.deepEqual(children[0].signals, ["SIGTERM"]);
	assert.equal(
		await harness.classifierServer.ensureReady(),
		"http://127.0.0.1:49164/v1/chat/completions",
	);
	assert.equal(spawnCount, 2);

	await harness.sessionShutdown();
	assert.deepEqual(children[1].signals, ["SIGTERM"]);
});
