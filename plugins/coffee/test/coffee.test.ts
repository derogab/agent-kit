import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import coffee from "../extensions/coffee.ts";

class FakeChild extends EventEmitter {
	kills: Array<NodeJS.Signals | undefined> = [];
	unrefs = 0;

	kill(signal?: NodeJS.Signals) {
		this.kills.push(signal);
		return true;
	}

	unref() {
		this.unrefs++;
	}
}

const setup = (t: TestContext, platform: NodeJS.Platform = "darwin") => {
	t.mock.method(os, "platform", () => platform);
	const children: FakeChild[] = [];
	const spawn = t.mock.method(childProcess, "spawn", () => {
		const child = new FakeChild();
		children.push(child);
		return child as unknown as ChildProcess;
	});

	const createInstance = (hasUI = true) => {
		const handlers = new Map<string, (event: any, ctx: ExtensionContext) => void>();
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			hasUI,
			ui: {
				notify: (message: string, level: string) => notifications.push({ message, level }),
			},
		} as unknown as ExtensionContext;
		coffee({
			on: (event: string, handler: (event: any, ctx: ExtensionContext) => void) => handlers.set(event, handler),
		} as unknown as ExtensionAPI);

		return {
			handlers,
			notifications,
			start: () => handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx),
			stop: () => handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx),
		};
	};

	return { children, createInstance, spawn };
};

test("starts only when a session opens, with display and idle protection tied to Pi's PID", (t) => {
	const { children, createInstance, spawn } = setup(t);
	const instance = createInstance();
	assert.equal(spawn.mock.callCount(), 0);
	assert.deepEqual([...instance.handlers.keys()], ["session_start", "session_shutdown"]);

	instance.start();
	instance.start();

	assert.equal(spawn.mock.callCount(), 1);
	assert.deepEqual(spawn.mock.calls[0].arguments, [
		"/usr/bin/caffeinate",
		["-d", "-i", "-w", String(process.pid)],
		{ detached: true, stdio: "ignore" },
	]);
	assert.equal(children[0].unrefs, 1);
	assert.deepEqual(instance.notifications, []);
});

for (const platform of ["linux", "win32"] as const) {
	test(`does nothing on ${platform}`, (t) => {
		const { createInstance, spawn } = setup(t, platform);
		const instance = createInstance();
		instance.start();
		instance.stop();
		assert.equal(spawn.mock.callCount(), 0);
		assert.deepEqual(instance.notifications, []);
	});
}

test("shutdown is safe before startup and only stops its child once", (t) => {
	const { children, createInstance } = setup(t);
	const instance = createInstance();
	instance.stop();
	instance.start();
	instance.stop();
	instance.stop();
	children[0].emit("exit", null, "SIGTERM");

	assert.deepEqual(children[0].kills, ["SIGTERM"]);
	assert.deepEqual(instance.notifications, []);
});

test("session replacement and reload do not retain old children", (t) => {
	const { children, createInstance } = setup(t);
	const oldInstance = createInstance();
	oldInstance.start();
	oldInstance.stop();
	const replacement = createInstance();
	replacement.start();
	oldInstance.stop();
	children[0].emit("exit", null, "SIGTERM");

	assert.equal(children.length, 2);
	assert.deepEqual(children[0].kills, ["SIGTERM"]);
	assert.deepEqual(children[1].kills, []);
	assert.deepEqual(oldInstance.notifications, []);
	replacement.stop();
	assert.deepEqual(children[1].kills, ["SIGTERM"]);
});

test("can restart the same instance and ignores late events from the stopped child", (t) => {
	const { children, createInstance } = setup(t);
	const instance = createInstance();
	instance.start();
	instance.stop();
	instance.start();
	children[0].emit("error", new Error("late error"));
	children[0].emit("exit", 1, null);
	instance.start();

	assert.equal(children.length, 2);
	assert.deepEqual(instance.notifications, []);
	instance.stop();
	assert.deepEqual(children[1].kills, ["SIGTERM"]);
});

test("closing one instance leaves other instances alone", (t) => {
	const { children, createInstance } = setup(t);
	const first = createInstance();
	const second = createInstance();
	first.start();
	second.start();
	first.stop();

	assert.deepEqual(children[0].kills, ["SIGTERM"]);
	assert.deepEqual(children[1].kills, []);
	second.start();
	assert.equal(children.length, 2);
	second.stop();
	assert.deepEqual(children[1].kills, ["SIGTERM"]);
});

test("reports asynchronous spawn errors without crashing and permits a retry", (t) => {
	const { children, createInstance } = setup(t);
	const instance = createInstance();
	instance.start();
	children[0].emit("error", new Error("spawn /usr/bin/caffeinate ENOENT"));
	children[0].emit("exit", -2, null);

	assert.equal(instance.notifications.length, 1);
	assert.equal(instance.notifications[0].level, "warning");
	assert.match(instance.notifications[0].message, /ENOENT.*\/reload/);
	instance.stop();
	assert.deepEqual(children[0].kills, []);
	instance.start();
	assert.equal(children.length, 2);
	instance.stop();
	assert.deepEqual(children[1].kills, ["SIGTERM"]);
});

test("reports synchronous spawn failures and permits a retry", (t) => {
	const { children, createInstance, spawn } = setup(t);
	spawn.mock.mockImplementationOnce(() => {
		throw new Error("spawn failed");
	});
	const instance = createInstance();
	instance.start();
	assert.match(instance.notifications[0].message, /spawn failed/);
	instance.start();
	assert.equal(children.length, 1);
	instance.stop();
	assert.deepEqual(children[0].kills, ["SIGTERM"]);
});

for (const [code, signal] of [[1, null], [null, "SIGKILL"]] as const) {
	test(`reports unexpected child exit (${signal ?? code}) and permits a retry`, (t) => {
		const { children, createInstance } = setup(t);
		const instance = createInstance();
		instance.start();
		children[0].emit("exit", code, signal);
		assert.equal(instance.notifications.length, 1);
		assert.match(instance.notifications[0].message, /stopped unexpectedly.*\/reload/);
		instance.start();
		instance.stop();
		assert.deepEqual(children[0].kills, []);
		assert.deepEqual(children[1].kills, ["SIGTERM"]);
	});
}

test("reports failures to stderr rather than stdout without a UI", (t) => {
	const { children, createInstance } = setup(t);
	const stderr = t.mock.method(console, "error", () => {});
	const stdout = t.mock.method(console, "log", () => {});
	const instance = createInstance(false);
	instance.start();
	children[0].emit("error", new Error("unavailable"));

	assert.equal(stderr.mock.callCount(), 1);
	assert.match(stderr.mock.calls[0].arguments[0], /unavailable/);
	assert.equal(stdout.mock.callCount(), 0);
	assert.deepEqual(instance.notifications, []);
});
