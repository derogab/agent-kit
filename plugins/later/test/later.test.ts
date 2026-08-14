import assert from "node:assert/strict";
import test from "node:test";
import later from "../extensions/later.ts";

interface CustomEntry {
	type: "custom";
	customType: string;
	data: { prompts: string[] };
	id: string;
	parentId: string | null;
	timestamp: string;
}

const setup = (options: { idle?: boolean; authError?: string } = {}) => {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const entries: CustomEntry[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const sent: Array<{ prompt: string; options?: { deliverAs: "followUp" } }> = [];
	const queuedSelections: Array<string | undefined> = [];

	const sessionManager = {
		getBranch: () => entries,
	};
	const ctx = {
		hasUI: true,
		isIdle: () => options.idle ?? true,
		model: { provider: "test", id: "model" } as { provider: string; id: string } | undefined,
		modelRegistry: {
			getApiKeyAndHeaders: async () =>
				options.authError === undefined ? { ok: true } : { ok: false, error: options.authError },
		},
		sessionManager,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			select: async (_title: string, labels: string[]) =>
				queuedSelections.length > 0 ? queuedSelections.shift() : labels[0],
		},
	};
	let command: ((args: string, ctx: any) => Promise<void>) | undefined;
	const pi = {
		appendEntry: (customType: string, data: { prompts: string[] }) => {
			entries.push({
				type: "custom",
				customType,
				data,
				id: String(entries.length + 1),
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "2026-08-14T00:00:00.000Z",
			});
		},
		on: (event: string, handler: (event: any, ctx: any) => Promise<void>) => handlers.set(event, handler),
		registerCommand: (_name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => {
			command = definition.handler;
		},
		sendUserMessage: (prompt: string, sendOptions?: { deliverAs: "followUp" }) => {
			sent.push({ prompt, options: sendOptions });
		},
	};

	later(pi as any);

	return {
		ctx,
		entries,
		handlers,
		notifications,
		sent,
		queueSelection: (value: string | undefined) => {
			queuedSelections.push(value);
		},
		run: async (args: string) => command!(args, ctx),
	};
};

const latestPrompts = (entries: CustomEntry[]) => entries.at(-1)?.data.prompts;

const startUserMessage = async (fixture: ReturnType<typeof setup>, text: string) => {
	const event = { message: { role: "user", content: [{ type: "text", text }] } };
	await fixture.handlers.get("message_start")!(event, fixture.ctx);
	return event;
};

test("keeps an idle prompt when no model is selected", async () => {
	const fixture = setup();
	fixture.ctx.model = undefined;
	await fixture.run("keep me");
	await fixture.run("");

	assert.deepEqual(fixture.sent, []);
	assert.deepEqual(latestPrompts(fixture.entries), ["keep me"]);
	assert.match(fixture.notifications.at(-1)!.message, /kept in list: no model selected/);
});

test("keeps an idle prompt when provider authentication is unavailable", async () => {
	const fixture = setup({ authError: "No API key" });
	await fixture.run("keep me");
	await fixture.run("");

	assert.deepEqual(fixture.sent, []);
	assert.deepEqual(latestPrompts(fixture.entries), ["keep me"]);
	assert.match(fixture.notifications.at(-1)!.message, /kept in list: No API key/);
});

test("removes an idle prompt only when Pi accepts the turn", async () => {
	const fixture = setup();
	await fixture.run("run me");
	await fixture.run("");

	assert.deepEqual(fixture.sent, [{ prompt: "run me", options: undefined }]);
	assert.deepEqual(latestPrompts(fixture.entries), ["run me"]);

	await fixture.handlers.get("before_agent_start")!({ prompt: "run me" }, fixture.ctx);
	assert.deepEqual(latestPrompts(fixture.entries), []);
});

test("acknowledges an idle prompt transformed by an input handler", async () => {
	const fixture = setup();
	await fixture.run("original");
	await fixture.run("");

	await fixture.handlers.get("before_agent_start")!({ prompt: "transformed" }, fixture.ctx);
	assert.deepEqual(latestPrompts(fixture.entries), []);
});

test("removes the selected duplicate follow-up when its turn starts", async () => {
	const fixture = setup({ idle: false });
	await fixture.run("A");
	await fixture.run("B");
	await fixture.run("A");
	fixture.queueSelection("3. A");
	await fixture.run("");

	assert.equal(fixture.sent.length, 1);
	assert.equal(fixture.sent[0].prompt.startsWith("A\u2063later:"), true);
	assert.deepEqual(fixture.sent[0].options, { deliverAs: "followUp" });
	// Queueing the follow-up must not remove the prompt before delivery.
	assert.deepEqual(latestPrompts(fixture.entries), ["A", "B", "A"]);

	await startUserMessage(fixture, fixture.sent[0].prompt);
	assert.deepEqual(latestPrompts(fixture.entries), ["A", "B"]);
});

test("removes the selected duplicate after an idle turn is accepted", async () => {
	const fixture = setup();
	await fixture.run("A");
	await fixture.run("B");
	await fixture.run("A");
	fixture.queueSelection("3. A");
	await fixture.run("");
	await fixture.handlers.get("before_agent_start")!({ prompt: "A" }, fixture.ctx);

	assert.deepEqual(latestPrompts(fixture.entries), ["A", "B"]);
});

test("keeps a queued follow-up when a user types the same text", async () => {
	const fixture = setup({ idle: false });
	await fixture.run("B");
	await fixture.run("");

	assert.equal(fixture.sent.length, 1);
	assert.deepEqual(fixture.sent[0].options, { deliverAs: "followUp" });
	assert.deepEqual(latestPrompts(fixture.entries), ["B"]);

	// A user-typed message can overtake the queued follow-up with identical text.
	await fixture.handlers.get("before_agent_start")!({ prompt: "B" }, fixture.ctx);
	await startUserMessage(fixture, "B");
	assert.deepEqual(latestPrompts(fixture.entries), ["B"]);

	const event = await startUserMessage(fixture, fixture.sent[0].prompt);
	assert.equal(event.message.content[0].text, "B");
	assert.deepEqual(latestPrompts(fixture.entries), []);
});

test("removes a prompt without running it when Remove is chosen", async () => {
	const fixture = setup({ idle: false });
	await fixture.run("A");
	await fixture.run("B");
	fixture.queueSelection("2. B");
	fixture.queueSelection("Remove");
	await fixture.run("");

	assert.deepEqual(fixture.sent, []);
	assert.deepEqual(latestPrompts(fixture.entries), ["A"]);
	assert.match(fixture.notifications.at(-1)!.message, /Removed saved prompt \(1 pending\)/);
});

test("keeps a prompt when the action choice is cancelled", async () => {
	const fixture = setup();
	await fixture.run("keep me");
	fixture.queueSelection("1. keep me");
	fixture.queueSelection(undefined);
	await fixture.run("");

	assert.deepEqual(fixture.sent, []);
	assert.deepEqual(latestPrompts(fixture.entries), ["keep me"]);
});
