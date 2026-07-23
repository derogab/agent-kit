import assert from "node:assert/strict";
import test from "node:test";
import {
	registerAutoModeControls,
	type AutoModeControlsDependencies,
} from "../extensions/controls.ts";

const ENABLE_OPTION = "Enable auto-mode";
const DISABLE_OPTION = "Disable auto-mode";

interface RegisteredCommand {
	description?: string;
	handler: (args: string, context: any) => Promise<void>;
}

function createHarness(dependencies: AutoModeControlsDependencies = {}) {
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
	} as never, dependencies);

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

test("/auto-mode shows its introduction, status, question, and choices", async () => {
	const { command } = createHarness();
	const ui = createCommandContext();

	await command.handler("", ui.context);

	assert.equal(ui.menus.length, 1);
	assert.match(ui.menus[0].title, /^Auto-mode checks Bash commands/);
	assert.match(ui.menus[0].title, /Current status: enabled/);
	assert.match(ui.menus[0].title, /What would you like to do\?/);
	assert.deepEqual(ui.menus[0].options, [ENABLE_OPTION, DISABLE_OPTION]);
	assert.deepEqual(ui.notifications, []);
});

test("enabling uses a cached model without prompting or downloading", async () => {
	let downloadCalled = false;
	const { command, controller } = createHarness({
		findCachedModel: async () => "/cached/model.gguf",
		downloadModel: async () => {
			downloadCalled = true;
			return "/cached/model.gguf";
		},
	});
	const ui = createCommandContext({ selections: [DISABLE_OPTION, ENABLE_OPTION] });

	await command.handler("", ui.context);
	await command.handler("", ui.context);

	assert.equal(ui.confirmationCount, 0);
	assert.equal(downloadCalled, false);
	assert.equal(controller.isActive(), true);
	assert.deepEqual(ui.status, { key: "auto-mode", text: "success:auto-mode" });
	assert.match(ui.notifications.at(-1)?.message ?? "", /Auto-mode is on/);
});

test("enabling stays off when a model download is declined", async () => {
	let downloadCalled = false;
	const { command, controller } = createHarness({
		findCachedModel: async () => undefined,
		downloadModel: async () => {
			downloadCalled = true;
			return "/cached/model.gguf";
		},
	});
	const ui = createCommandContext({
		confirm: async () => false,
		selections: [ENABLE_OPTION],
	});

	await command.handler("", ui.context);

	assert.equal(ui.confirmationCount, 1);
	assert.equal(downloadCalled, false);
	assert.equal(controller.isActive(), false);
	assert.deepEqual(ui.status, { key: "auto-mode", text: undefined });
	assert.match(ui.notifications.at(-1)?.message ?? "", /cannot start/);
});

test("enabling downloads an absent model after confirmation", async () => {
	let downloadOptions: { signal?: AbortSignal } | undefined;
	const abortController = new AbortController();
	const { command, controller } = createHarness({
		findCachedModel: async () => undefined,
		downloadModel: async (options) => {
			downloadOptions = options;
			return "/cached/model.gguf";
		},
	});
	const ui = createCommandContext({
		selections: [ENABLE_OPTION],
		signal: abortController.signal,
	});

	await command.handler("", ui.context);

	assert.equal(ui.confirmationCount, 1);
	assert.equal(downloadOptions?.signal, abortController.signal);
	assert.equal(controller.isActive(), true);
	assert.deepEqual(ui.status, { key: "auto-mode", text: "success:auto-mode" });
	assert.match(ui.notifications.at(-2)?.message ?? "", /Downloading/);
	assert.match(ui.notifications.at(-1)?.message ?? "", /Auto-mode is on/);
});

test("enabling stays off when model setup fails", async () => {
	const { command, controller } = createHarness({
		findCachedModel: async () => undefined,
		downloadModel: async () => {
			throw new Error("download failed");
		},
	});
	const ui = createCommandContext({ selections: [ENABLE_OPTION] });

	await command.handler("", ui.context);

	assert.equal(controller.isActive(), false);
	assert.deepEqual(ui.status, { key: "auto-mode", text: undefined });
	assert.deepEqual(ui.notifications.at(-1), {
		message: "Auto-mode could not start: download failed",
		type: "error",
	});
});
