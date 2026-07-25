import assert from "node:assert/strict";
import test from "node:test";
import { registerAutoModeControls } from "../extensions/controls.ts";
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

interface RegisteredCommand {
	description?: string;
	handler: (args: string, context: any) => Promise<void>;
}

function createHarness(
	overrides: Partial<ClassifierServer> = {},
) {
	let selectedModel = DEFAULT_CLASSIFIER_MODEL;
	const classifierServer: ClassifierServer = {
		ensureReady: async () => "http://127.0.0.1:49152/v1/chat/completions",
		getModel: () => selectedModel,
		selectModel: async (model) => {
			selectedModel = model;
		},
		stop: async () => {},
		...overrides,
	};
	let sessionStartHandler: ((event: any, context: any) => Promise<any>) | undefined;
	let command: RegisteredCommand | undefined;
	const controller = registerAutoModeControls({
		on(event: string, callback: typeof sessionStartHandler) {
			assert.equal(event, "session_start");
			sessionStartHandler = callback;
		},
		registerCommand(name: string, options: RegisteredCommand) {
			assert.equal(name, "auto-mode");
			command = options;
		},
	} as never, classifierServer);

	assert.ok(sessionStartHandler);
	assert.ok(command);
	return { command, controller, sessionStartHandler };
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

test("the status line shows when auto-mode is active", async () => {
	const { sessionStartHandler } = createHarness();
	const ui = createCommandContext();

	await sessionStartHandler({}, ui.context);

	assert.deepEqual(ui.status, { key: "auto-mode", text: "success:auto-mode" });
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
	let selectedModel: ClassifierModel | undefined;
	let receivedSignal: AbortSignal | undefined;
	const abortController = new AbortController();
	const { command } = createHarness({
		getModel: () => selectedModel ?? DEFAULT_CLASSIFIER_MODEL,
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
	assert.deepEqual(ui.menus[1].options, CLASSIFIER_MODELS.map((model) => model.size));
	assert.equal(ui.menus[3].title, "Classifier model: 4B");
	assert.equal(selectedModel?.size, "4B");
	assert.equal(receivedSignal, abortController.signal);
	assert.deepEqual(ui.notifications, [{
		message: "Classifier model set to 4B.",
		type: "info",
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
	const { command, controller } = createHarness({
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
	assert.equal(controller.isActive(), true);
	assert.deepEqual(ui.status, { key: "auto-mode", text: "success:auto-mode" });
	assert.match(ui.notifications.at(-1)?.message ?? "", /Auto-mode is on/);
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
	assert.deepEqual(ui.status, { key: "auto-mode", text: "success:auto-mode" });
	assert.match(ui.notifications.at(-1)?.message ?? "", /Auto-mode is on/);
});

test("enabling stays active when classifier setup fails", async () => {
	const { command, controller } = createHarness({
		ensureReady: async () => {
			throw new Error("server failed");
		},
	});
	const ui = createCommandContext({ selections: [STATUS_OPTION, ENABLE_OPTION] });

	await command.handler("", ui.context);

	assert.equal(controller.isActive(), true);
	assert.deepEqual(ui.status, { key: "auto-mode", text: "success:auto-mode" });
	assert.deepEqual(ui.notifications.at(-1), {
		message: "Auto-mode could not start: server failed",
		type: "error",
	});
});
