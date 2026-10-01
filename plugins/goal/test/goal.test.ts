import assert from "node:assert/strict";
import test from "node:test";
import type {
	AgentBeforeSettleEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import goal from "../extensions/goal.ts";

const DONE = "<goal>done</goal>";
const BLOCKED = "<goal>blocked</goal>";

const assistant = (text: string, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason,
});

const setup = (hasUI = true) => {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const sent: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();
	let idle = true;
	let pending = false;
	let aborts = 0;
	const registry = { getApiKeyAndHeaders: async (): Promise<any> => ({ ok: true, apiKey: "test" }) };
	const ctx = {
		hasUI,
		model: { id: "test-model" },
		modelRegistry: registry,
		signal: undefined,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		abort: () => { aborts++; },
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
		},
	} as unknown as ExtensionCommandContext;
	const api = {
		on: (event: string, handler: (event: any, ctx: ExtensionContext) => any) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		sendUserMessage: (text: string) => sent.push(text),
	};
	goal(api as unknown as ExtensionAPI);
	const emit = (name: string, event: any = {}) => handlers.get(name)!({ type: name, ...event }, ctx);
	const boundary = (messages: any[] = [assistant("More work remains.")], overrides: Partial<AgentBeforeSettleEvent> = {}) => emit("agent_before_settle", {
		entries: [],
		continue: false,
		outcome: "completed",
		context: { contextMessages: messages, pendingMessages: [], canContinue: false },
		...overrides,
	});
	return {
		ctx, api, registry, commands, sent, notifications, statuses, emit, boundary,
		run: (args: string) => commands.get("goal")!.handler(args, ctx),
		busy: () => { idle = false; },
		queue: () => { pending = true; },
		aborts: () => aborts,
	};
};

test("registers only /goal and does nothing without an explicit goal", async () => {
	const h = setup();
	assert.deepEqual([...h.commands.keys()], ["goal"]);
	await h.emit("session_start");
	assert.equal(await h.boundary(), undefined);
	await h.emit("agent_settled");
	await h.run("  ");
	assert.match(h.notifications.at(-1)!.message, /No active goal/);
	assert.equal(h.sent.length, 0);
});

test("starts a trimmed objective and shows progress without resending on /goal", async () => {
	const h = setup();
	await h.run("  Fix all tests\nwithout deleting any.  ");
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0], /Fix all tests\nwithout deleting any\./);
	assert.match(h.sent[0], /verify/);
	assert.match(h.sent[0], /permission/);
	assert.ok(h.sent[0].includes(DONE) && h.sent[0].includes(BLOCKED));
	assert.equal(h.statuses.get("goal"), "goal · round 1");
	await h.run("");
	assert.match(h.notifications.at(-1)!.message, /Goal \(round 1\): Fix all tests/);
	assert.equal(h.sent.length, 1);
});

test("continues repeatedly at the boundary while preserving other extensions' entries", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	const existing = { type: "custom" as const, customType: "another-extension", data: {} };
	for (let round = 2; round <= 5; round++) {
		const result = await h.boundary(undefined, { entries: [existing] });
		assert.equal(result.continue, true);
		assert.equal(result.entries.length, 2);
		assert.equal(result.entries[0], existing);
		assert.deepEqual(result.entries[1], {
			type: "custom_message", customType: "goal", content: h.sent[0], display: false,
		});
		assert.equal(h.statuses.get("goal"), `goal · round ${round}`);
	}
	assert.equal(h.sent.length, 1, "continuations must not queue uncancellable follow-ups");
});

for (const marker of [DONE, BLOCKED]) {
	test(`stops on the final assistant line ${marker}`, async () => {
		const h = setup();
		await h.run("Fix the tests.");
		assert.equal(await h.boundary([assistant(`Verified the result.\r\n${marker}\n`)]), undefined);
		assert.equal(h.statuses.get("goal"), undefined);
		assert.match(h.notifications.at(-1)!.message, marker === DONE ? /Goal reached/ : /Goal blocked/);
		await h.emit("agent_settled");
		assert.equal(await h.boundary(), undefined);
		assert.equal(h.sent.length, 1);
		assert.equal(h.aborts(), 0);
	});
}

for (const messages of [
	[assistant(`Example: ${DONE}`)],
	[assistant(`${DONE}\nStill working.`)],
	[assistant(`\`\`\`\n${DONE}\n\`\`\``)],
	[{ role: "user", content: [{ type: "text", text: DONE }] }],
	[assistant("Working."), { role: "toolResult", content: [{ type: "text", text: DONE }] }],
	[{ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: DONE }] }],
	[assistant(DONE, "toolUse")],
	[assistant(DONE, "length")],
	[assistant(DONE), assistant("Not finished after all.")],
]) {
	test(`does not treat incidental or non-final output as completion: ${JSON.stringify(messages)}`, async () => {
		const h = setup();
		await h.run("Fix the tests.");
		assert.equal((await h.boundary(messages)).continue, true);
	});
}

test("/goal stop clears the loop before aborting and does not abort unrelated work", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.run("stop");
	assert.equal(h.aborts(), 1);
	assert.equal(await h.boundary(), undefined);
	await h.emit("agent_settled");
	await h.run("stop");
	assert.equal(h.aborts(), 1);
	assert.equal(h.statuses.get("goal"), undefined);
});

for (const outcome of ["aborted", "error"] as const) {
	test(`stops on ${outcome} even if the response contains the completion marker`, async () => {
		const h = setup();
		await h.run("Fix the tests.");
		assert.equal(await h.boundary([assistant(DONE)], { outcome }), undefined);
		assert.match(h.notifications.at(-1)!.message, /stopped before completion/);
		assert.equal(await h.boundary(), undefined);
	});
}

test("Escape stops the loop even when Pi skips agent_before_settle", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.emit("agent_settled");
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.statuses.get("goal"), undefined);
	await h.run("Try again.");
	assert.equal(h.sent.length, 2);
});

test("an aborted operation cannot request a continuation", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	h.ctx.signal = AbortSignal.abort();
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.statuses.get("goal"), undefined);
});

for (const event of ["session_start", "session_tree", "session_shutdown"]) {
	test(`${event} clears the goal without starting or aborting work`, async () => {
		const h = setup();
		await h.run("Fix the tests.");
		await h.emit(event);
		await h.emit(event);
		assert.equal(await h.boundary(), undefined);
		assert.equal(h.statuses.get("goal"), undefined);
		assert.equal(h.aborts(), 0);
		assert.equal(h.sent.length, 1);
	});
}

test("does not compete with another continuation or queued user work", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	assert.equal(await h.boundary(undefined, { continue: true }), undefined);
	h.queue();
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.statuses.get("goal"), "goal · round 1");
});

test("refuses to replace an active goal or start while busy or messages are pending", async () => {
	const h = setup();
	await h.run("First goal.");
	await h.run("Second goal.");
	await h.run("");
	assert.match(h.notifications.at(-1)!.message, /First goal/);
	assert.equal(h.sent.length, 1);
	for (const state of ["busy", "queue"] as const) {
		const busy = setup();
		busy[state]();
		await busy.run("Fix the tests.");
		assert.equal(busy.sent.length, 0);
		assert.equal(await busy.boundary(), undefined);
	}
});

test("missing model or failed authentication leaves no running goal", async () => {
	const noModel = setup();
	noModel.ctx.model = undefined;
	await noModel.run("Fix the tests.");
	assert.equal(noModel.sent.length, 0);
	assert.equal(await noModel.boundary(), undefined);
	for (const throws of [false, true]) {
		const h = setup();
		h.registry.getApiKeyAndHeaders = async () => {
			if (throws) throw new Error("Authentication failed");
			return { ok: false, error: "Authentication failed" };
		};
		await h.run("Fix the tests.");
		assert.equal(h.sent.length, 0);
		assert.equal(await h.boundary(), undefined);
		assert.match(h.notifications.at(-1)!.message, /Authentication failed/);
	}
});

test("cancellation or session changes during authentication cannot send a stale goal", async () => {
	for (const cancel of ["stop", "session_start", "session_tree", "session_shutdown"]) {
		const h = setup();
		let resolve!: (value: any) => void;
		h.registry.getApiKeyAndHeaders = () => new Promise((done) => { resolve = done; });
		const starting = h.run("Fix the tests.");
		if (cancel === "stop") await h.run("stop");
		else await h.emit(cancel);
		resolve({ ok: true });
		await starting;
		assert.equal(h.sent.length, 0);
		assert.equal(await h.boundary(), undefined);
	}
});

test("an unrelated run cannot continue or complete a goal still authenticating", async () => {
	const h = setup();
	let resolve!: (value: any) => void;
	h.registry.getApiKeyAndHeaders = () => new Promise((done) => { resolve = done; });
	const starting = h.run("Fix the tests.");
	assert.equal(await h.boundary(), undefined);
	assert.equal(await h.boundary([assistant(DONE)]), undefined);
	await h.emit("agent_settled");
	resolve({ ok: true });
	await starting;
	assert.equal(h.sent.length, 0);
	assert.equal(h.statuses.get("goal"), undefined);
});

test("rechecks idle state after authentication", async () => {
	const h = setup();
	h.registry.getApiKeyAndHeaders = async () => { h.busy(); return { ok: true }; };
	await h.run("Fix the tests.");
	assert.equal(h.sent.length, 0);
	assert.equal(await h.boundary(), undefined);
});

test("send failures clear the goal", async () => {
	const h = setup();
	h.api.sendUserMessage = () => { throw new Error("Could not send"); };
	await h.run("Fix the tests.");
	assert.equal(await h.boundary(), undefined);
	assert.match(h.notifications.at(-1)!.message, /Could not send/);
});

test("loop behavior does not depend on terminal UI", async () => {
	const h = setup(false);
	await h.run("Fix the tests.");
	assert.equal((await h.boundary()).continue, true);
	await h.boundary([assistant(DONE)]);
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.statuses.size, 0);
});
