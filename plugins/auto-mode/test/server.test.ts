import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
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

function createHarness(dependencies: ClassifierServerDependencies) {
	let sessionStart: ((event: any, context: any) => void) | undefined;
	let sessionShutdown: (() => Promise<void>) | undefined;
	const notifications: Array<{ message: string; type?: string }> = [];
	const classifierServer = registerClassifierServer({
		on(event: string, handler: any) {
			if (event === "session_start") sessionStart = handler;
			if (event === "session_shutdown") sessionShutdown = handler;
		},
	} as never, {
		loadModel: () => DEFAULT_CLASSIFIER_MODEL,
		saveModel: () => {},
		...dependencies,
	});

	assert.ok(sessionStart);
	assert.ok(sessionShutdown);
	const context = {
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
	};
	return { classifierServer, context, notifications, sessionShutdown, sessionStart };
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

test("session startup launches llama-server on the allocated port", async () => {
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
		command: "llama-server",
		args: [
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

	harness.sessionStart({ type: "session_start", reason: "startup" }, harness.context);
	await harness.classifierServer.ensureReady();

	const fourB = CLASSIFIER_MODELS.find((model) => model.size === "4B");
	assert.ok(fourB);
	await harness.classifierServer.selectModel(fourB);

	assert.deepEqual(children[0].signals, ["SIGTERM"]);
	assert.equal(harness.classifierServer.getModel(), fourB);
	assert.equal(savedModel, fourB);
	assert.deepEqual(requestedModels, [DEFAULT_CLASSIFIER_MODEL, fourB]);
	assert.equal(invocations[1][5], "/cache/4B.gguf");
	assert.equal(invocations[1][7], CLASSIFIER_ALIAS);
	assert.equal(
		await harness.classifierServer.ensureReady(),
		"http://127.0.0.1:49158/v1/chat/completions",
	);

	await harness.sessionShutdown();
	assert.deepEqual(children[1].signals, ["SIGTERM"]);
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
		/llama-server did not become ready in time/,
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
