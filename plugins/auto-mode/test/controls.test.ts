import assert from "node:assert/strict";
import test from "node:test";
import { registerAutoModeControls, type AutoModeControlsDependencies } from "../extensions/controls.ts";
import {
	CLASSIFIER_MODELS,
	DEFAULT_CLASSIFIER_MODEL,
	type ClassifierModel,
} from "../extensions/model.ts";
import type { ClassifierServer } from "../extensions/server.ts";

const ENABLE_OPTION = "Enable auto-mode";
const DISABLE_OPTION = "Disable auto-mode";
const STATUS_OPTION = "Status";
const MODEL_OPTION = "Model";
const NO_MODEL_OPTION = "No model";

interface RegisteredCommand {
	description?: string;
	handler: (args: string, context: any) => Promise<void>;
}

function createHarness(
	overrides: Partial<ClassifierServer> = {},
	dependencies: AutoModeControlsDependencies = {},
) {
	const savedEnabled: boolean[] = [];
	let selectedModel: ClassifierModel | null = DEFAULT_CLASSIFIER_MODEL;
	let address: string | undefined;
	let addressListener: ((address: string | undefined) => void) | undefined;
	const classifierServer: ClassifierServer = {
		ensureReady: async () => "http://127.0.0.1:49152/v1/chat/completions",
		getAddress: () => address,
		getModel: () => selectedModel,
		onAddressChange: (listener) => {
			addressListener = listener;
			return () => {
				if (addressListener === listener) addressListener = undefined;
			};
		},
		selectModel: async (model) => {
			selectedModel = model;
		},
		stop: async () => {},
		...overrides,
	};
	const handlers = new Map<string, (event: any, context: any) => Promise<any>>();
	let command: RegisteredCommand | undefined;
	const controller = registerAutoModeControls({
		on(event: string, callback: (event: any, context: any) => Promise<any>) {
			handlers.set(event, callback);
		},
		registerCommand(name: string, options: RegisteredCommand) {
			assert.equal(name, "auto-mode");
			command = options;
		},
	} as never, classifierServer, {
		loadEnabled: () => true,
		saveEnabled: (enabled) => { savedEnabled.push(enabled); },
		...dependencies,
	});

	const sessionStartHandler = handlers.get("session_start");
	assert.ok(sessionStartHandler);
	assert.ok(handlers.get("session_shutdown"));
	assert.ok(command);
	return {
		command,
		controller,
		savedEnabled,
		sessionStartHandler,
		setAddress(value: string | undefined) {
			address = value;
			addressListener?.(value);
		},
	};
}

interface CommandContextOptions {
	confirm?: () => Promise<boolean>;
	selections?: Array<string | undefined>;
	signal?: AbortSignal;
}

function createCommandContext(options: CommandContextOptions = {}) {
	let status: { key: string; text: string | undefined } | undefined;
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const menus: Array<{ title: string; options: string[] }> = [];
	const selections = [...(options.selections ?? [])];
	let confirmationCount = 0;
	const context = {
		signal: options.signal,
		hasUI: true,
		ui: {
			confirm: async () => {
				confirmationCount++;
				return options.confirm?.() ?? true;
			},
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			select: async (title: string, choices: string[]) => {
				menus.push({ title, options: choices });
				return selections.shift();
			},
			setStatus: (key: string, text: string | undefined) => {
				status = { key, text };
			},
			theme: { fg: (color: string, text: string) => `${color}:${text}` },
		},
	};
	return {
		context,
		menus,
		notifications,
		get confirmationCount() {
			return confirmationCount;
		},
		get status() {
			return status;
		},
	};
}

test("the status line shows a text shield and the selected model when auto-mode is active", async () => {
	const { sessionStartHandler } = createHarness();
	const ui = createCommandContext();

	await sessionStartHandler({}, ui.context);

	assert.deepEqual(ui.status, {
		key: "auto-mode",
		text: "success:⛨ muted:inclusionAI/SingGuard-NSFA-0.8B-GGUF:0.8B",
	});
});

test("a saved disabled preference hides the status and is not overwritten on startup", async () => {
	const { controller, savedEnabled, sessionStartHandler, setAddress, command } = createHarness({}, {
		loadEnabled: () => false,
	});
	const ui = createCommandContext({ selections: [STATUS_OPTION] });

	await sessionStartHandler({}, ui.context);
	setAddress("127.0.0.1:49152");
	await command.handler("", ui.context);

	assert.equal(controller.isActive(), false);
	assert.deepEqual(ui.status, { key: "auto-mode", text: undefined });
	assert.equal(ui.menus[1].title, "Auto-mode status: disabled");
	assert.deepEqual(savedEnabled, []);
});

test("cancelled menus do not save a preference", async () => {
	const { command, savedEnabled } = createHarness();
	const ui = createCommandContext({ selections: [undefined, STATUS_OPTION, undefined] });

	await command.handler("", ui.context);
	await command.handler("", ui.context);

	assert.deepEqual(savedEnabled, []);
});

test("the status line follows the classifier server address", async () => {
	const { sessionStartHandler, setAddress } = createHarness();
	const ui = createCommandContext();

	await sessionStartHandler({}, ui.context);
	setAddress("127.0.0.1:49152");

	assert.deepEqual(ui.status, {
		key: "auto-mode",
		text: "success:⛨ muted:inclusionAI/SingGuard-NSFA-0.8B-GGUF:0.8B · 127.0.0.1:49152",
	});

	setAddress(undefined);

	assert.deepEqual(ui.status, {
		key: "auto-mode",
		text: "success:⛨ muted:inclusionAI/SingGuard-NSFA-0.8B-GGUF:0.8B",
	});
});

test("/auto-mode opens its main menu", async () => {
	const { command } = createHarness();
	const ui = createCommandContext();

	await command.handler("", ui.context);

	assert.equal(ui.menus.length, 1);
	assert.equal(ui.menus[0].title, "Auto-mode");
	assert.deepEqual(ui.menus[0].options, [STATUS_OPTION, MODEL_OPTION]);
	assert.deepEqual(ui.notifications, []);
});

test("Model shows the default and changes the selected model", async () => {
	let selectedModel: ClassifierModel | null = DEFAULT_CLASSIFIER_MODEL;
	let receivedSignal: AbortSignal | undefined;
	const abortController = new AbortController();
	const { command } = createHarness({
		getModel: () => selectedModel,
		selectModel: async (model, signal) => {
			selectedModel = model;
			receivedSignal = signal;
		},
	});
	const ui = createCommandContext({
		selections: [MODEL_OPTION, "4B", MODEL_OPTION],
		signal: abortController.signal,
	});

	await command.handler("", ui.context);
	await command.handler("", ui.context);

	assert.equal(ui.menus[1].title, "Classifier model: 0.8B");
	assert.deepEqual(ui.menus[1].options, [NO_MODEL_OPTION, ...CLASSIFIER_MODELS.map((model) => model.size)]);
	assert.equal(ui.menus[3].title, "Classifier model: 4B");
	assert.equal(selectedModel?.size, "4B");
	assert.equal(receivedSignal, abortController.signal);
	assert.deepEqual(ui.status, {
		key: "auto-mode",
		text: "success:⛨ muted:inclusionAI/SingGuard-NSFA-4B-GGUF:4B",
	});
	assert.deepEqual(ui.notifications, [{
		message: "Classifier model set to 4B.",
		type: "info",
	}]);
});

test("No model keeps auto-mode active and shows policies-only status", async () => {
	const { command, controller } = createHarness();
	const ui = createCommandContext({ selections: [MODEL_OPTION, NO_MODEL_OPTION, MODEL_OPTION] });

	await command.handler("", ui.context);
	await command.handler("", ui.context);

	assert.equal(controller.isActive(), true);
	assert.equal(ui.menus[3].title, "Classifier model: No model");
	assert.deepEqual(ui.status, { key: "auto-mode", text: "\x1b[38;5;208m⛨\x1b[39m muted:policies only" });
	assert.deepEqual(ui.notifications, [{
		message: "No model selected. Only static policy rules are used.",
		type: "info",
	}]);
});

test("enabling with no model never asks the classifier to start", async () => {
	let ensureCount = 0;
	const { command, controller, sessionStartHandler } = createHarness({
		getModel: () => null,
		ensureReady: async () => {
			ensureCount += 1;
			throw new Error("unexpected classifier start");
		},
	}, { loadEnabled: () => false });
	const ui = createCommandContext({ selections: [STATUS_OPTION, ENABLE_OPTION] });

	await sessionStartHandler({}, ui.context);
	await command.handler("", ui.context);

	assert.equal(ensureCount, 0);
	assert.equal(controller.isActive(), true);
	assert.deepEqual(ui.status, { key: "auto-mode", text: "\x1b[38;5;208m⛨\x1b[39m muted:policies only" });
	assert.deepEqual(ui.notifications, [{ message: "Auto-mode is on. Bash commands are checked.", type: "info" }]);
});

test("cancelling model selection leaves the current model unchanged", async () => {
	let changes = 0;
	const { command } = createHarness({ selectModel: async () => { changes += 1; } });
	const ui = createCommandContext({ selections: [MODEL_OPTION, undefined] });

	await command.handler("", ui.context);

	assert.equal(changes, 0);
	assert.deepEqual(ui.notifications, []);
});

test("a failed model switch still refreshes the status", async () => {
	const fourB = CLASSIFIER_MODELS.find((model) => model.size === "4B");
	assert.ok(fourB);
	let selectedModel: ClassifierModel | null = DEFAULT_CLASSIFIER_MODEL;
	const { command } = createHarness({
		getModel: () => selectedModel,
		selectModel: async (model) => {
			selectedModel = model;
			throw new Error("restart failed");
		},
	});
	const ui = createCommandContext({ selections: [MODEL_OPTION, "4B"] });

	await command.handler("", ui.context);

	assert.deepEqual(ui.status, {
		key: "auto-mode",
		text: "success:⛨ muted:inclusionAI/SingGuard-NSFA-4B-GGUF:4B",
	});
	assert.deepEqual(ui.notifications, [{
		message: "Classifier model could not change: restart failed",
		type: "error",
	}]);
});

test("Status shows the current status and actions", async () => {
	const { command } = createHarness();
	const ui = createCommandContext({ selections: [STATUS_OPTION] });

	await command.handler("", ui.context);

	assert.equal(ui.menus.length, 2);
	assert.equal(ui.menus[1].title, "Auto-mode status: enabled");
	assert.deepEqual(ui.menus[1].options, [ENABLE_OPTION, DISABLE_OPTION]);
	assert.deepEqual(ui.notifications, []);
});

test("disabling stops and enabling restarts the classifier server", async () => {
	let ensureCount = 0;
	let stopCount = 0;
	const { command, controller, savedEnabled } = createHarness({
		ensureReady: async () => {
			ensureCount += 1;
			return "http://127.0.0.1:49152/v1/chat/completions";
		},
		stop: async () => {
			stopCount += 1;
		},
	});
	const ui = createCommandContext({
		selections: [STATUS_OPTION, DISABLE_OPTION, STATUS_OPTION, ENABLE_OPTION],
	});

	await command.handler("", ui.context);
	await command.handler("", ui.context);

	assert.equal(ui.confirmationCount, 0);
	assert.equal(stopCount, 1);
	assert.equal(ensureCount, 1);
	assert.deepEqual(savedEnabled, [false, true]);
	assert.equal(controller.isActive(), true);
	assert.deepEqual(ui.status, {
		key: "auto-mode",
		text: "success:⛨ muted:inclusionAI/SingGuard-NSFA-0.8B-GGUF:0.8B",
	});
	assert.match(ui.notifications.at(-1)?.message ?? "", /Auto-mode is on/);
});

test("disabling is remembered even if the classifier cannot stop", async () => {
	const { command, controller, savedEnabled } = createHarness({
		stop: async () => { throw new Error("stop failed"); },
	});
	const ui = createCommandContext({ selections: [STATUS_OPTION, DISABLE_OPTION] });

	await command.handler("", ui.context);

	assert.equal(controller.isActive(), false);
	assert.deepEqual(savedEnabled, [false]);
	assert.match(ui.notifications.at(-1)?.message ?? "", /could not stop: stop failed/);
});

test("a failed preference save still applies the choice and warns it may reset", async () => {
	const { command, controller } = createHarness({}, {
		saveEnabled: () => { throw new Error("disk full"); },
	});
	const ui = createCommandContext({ selections: [STATUS_OPTION, DISABLE_OPTION] });

	await command.handler("", ui.context);

	assert.equal(controller.isActive(), false);
	assert.deepEqual(ui.status, { key: "auto-mode", text: undefined });
	assert.deepEqual(ui.notifications[0], {
		message: "Auto-mode status could not be saved and may reset after a reload or restart: disk full",
		type: "error",
	});
});

test("enabling forwards cancellation while waiting for the classifier server", async () => {
	let receivedSignal: AbortSignal | undefined;
	const abortController = new AbortController();
	const { command, controller } = createHarness({
		ensureReady: async (signal) => {
			receivedSignal = signal;
			return "http://127.0.0.1:49152/v1/chat/completions";
		},
	});
	const ui = createCommandContext({
		selections: [STATUS_OPTION, ENABLE_OPTION],
		signal: abortController.signal,
	});

	await command.handler("", ui.context);

	assert.equal(receivedSignal, abortController.signal);
	assert.equal(controller.isActive(), true);
	assert.deepEqual(ui.status, {
		key: "auto-mode",
		text: "success:⛨ muted:inclusionAI/SingGuard-NSFA-0.8B-GGUF:0.8B",
	});
	assert.match(ui.notifications.at(-1)?.message ?? "", /Auto-mode is on/);
});

test("enabling stays active when classifier setup fails", async () => {
	const { command, controller, savedEnabled } = createHarness({
		ensureReady: async () => {
			throw new Error("server failed");
		},
	});
	const ui = createCommandContext({ selections: [STATUS_OPTION, ENABLE_OPTION] });

	await command.handler("", ui.context);

	assert.equal(controller.isActive(), true);
	assert.deepEqual(ui.status, {
		key: "auto-mode",
		text: "success:⛨ muted:inclusionAI/SingGuard-NSFA-0.8B-GGUF:0.8B",
	});
	assert.deepEqual(savedEnabled, [true]);
	assert.deepEqual(ui.notifications.at(-1), {
		message: "Auto-mode could not start: server failed",
		type: "error",
	});
});
