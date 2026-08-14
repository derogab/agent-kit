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

const setup = (
	options: {
		idle?: boolean;
		authError?: string;
		getAuth?: () => Promise<{ ok: true } | { ok: false; error: string }>;
		initialEntries?: CustomEntry[];
	} = {},
) => {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const entries = (options.initialEntries ?? []).map((entry) => ({
		...entry,
		data: { prompts: [...entry.data.prompts] },
	}));
	const notifications: Array<{ message: string; level: string }> = [];
	const selections: Array<{ title: string; labels: string[] }> = [];
	const sent: Array<{ prompt: string; options?: { deliverAs: "followUp" } }> = [];
	const pendingMessages: string[] = [];
	const queuedSelections: Array<string | undefined> = [];
	let idle = options.idle ?? true;

	const sessionManager = {
		getBranch: () => entries,
	};
	const ctx = {
		hasUI: true,
		hasPendingMessages: () => pendingMessages.length > 0,
		isIdle: () => idle,
		model: { provider: "test", id: "model" } as { provider: string; id: string } | undefined,
		modelRegistry: {
			getApiKeyAndHeaders: async () => {
				if (options.getAuth !== undefined) return options.getAuth();
				return options.authError === undefined ? { ok: true } : { ok: false, error: options.authError };
			},
		},
		sessionManager,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			select: async (title: string, labels: string[]) => {
				selections.push({ title, labels: [...labels] });
				return queuedSelections.length > 0 ? queuedSelections.shift() : labels[0];
			},
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
			if (sendOptions?.deliverAs === "followUp") pendingMessages.push(prompt);
		},
	};

	later(pi as any);

	return {
		ctx,
		dequeueFollowUps: () => pendingMessages.splice(0),
		deliverFollowUp: (text: string) => {
			const index = pendingMessages.indexOf(text);
			if (index !== -1) pendingMessages.splice(index, 1);
		},
		entries,
		handlers,
		notifications,
		selections,
		sent,
		setIdle: (value: boolean) => {
			idle = value;
		},
		queueSelection: (value: string | undefined) => {
			queuedSelections.push(value);
		},
		run: async (args: string) => command!(args, ctx),
	};
};

const latestPrompts = (entries: CustomEntry[]) => entries.at(-1)?.data.prompts;

const startUserMessage = async (fixture: ReturnType<typeof setup>, text: string) => {
	fixture.deliverFollowUp(text);
	const event = { message: { role: "user", content: [{ type: "text", text }] } };
	await fixture.handlers.get("message_start")!(event, fixture.ctx);
	return event;
};

const submitInput = async (fixture: ReturnType<typeof setup>, text: string, source = "extension") => {
	await fixture.handlers.get("input")!({ text, source }, fixture.ctx);
};

const assertHasInvisibleMarker = (sent: string, prompt: string) => {
	assert.equal(sent.endsWith(prompt), true);
	const marker = sent.slice(0, -prompt.length);
	assert.notEqual(marker, "");
	assert.doesNotMatch(marker, /[\x20-\x7e]/);
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

test("restores prompts from session state without mutating saved entries", async () => {
	const source = setup();
	await source.run("first");
	await source.run("second");
	const persisted = source.entries.map((entry) => [...entry.data.prompts]);
	const fixture = setup({ initialEntries: source.entries });

	await fixture.handlers.get("session_start")!({}, fixture.ctx);
	await fixture.handlers.get("session_tree")!({}, fixture.ctx);
	fixture.queueSelection("1. first");
	fixture.queueSelection("Remove");
	await fixture.run("");

	assert.deepEqual(latestPrompts(fixture.entries), ["second"]);
	assert.deepEqual(
		fixture.entries.slice(0, persisted.length).map((entry) => entry.data.prompts),
		persisted,
	);
	assert.deepEqual(source.entries.map((entry) => entry.data.prompts), persisted);
});

test("truncates labels for long saved prompts", async () => {
	const fixture = setup();
	const prompt = "x".repeat(81);
	await fixture.run(prompt);
	fixture.queueSelection(undefined);
	await fixture.run("");

	assert.deepEqual(fixture.selections, [{ title: "Saved prompts", labels: [`1. ${"x".repeat(80)}…`] }]);
});

test("removes an idle prompt only when Pi accepts the turn", async () => {
	const fixture = setup();
	await fixture.run("run me");
	await fixture.run("");

	assert.equal(fixture.sent.length, 1);
	assertHasInvisibleMarker(fixture.sent[0].prompt, "run me");
	assert.deepEqual(latestPrompts(fixture.entries), ["run me"]);

	await submitInput(fixture, fixture.sent[0].prompt);
	await fixture.handlers.get("before_agent_start")!({ prompt: fixture.sent[0].prompt }, fixture.ctx);
	const event = await startUserMessage(fixture, fixture.sent[0].prompt);
	assert.equal(event.message.content[0].text, "run me");
	assert.deepEqual(latestPrompts(fixture.entries), []);
});

test("acknowledges an idle prompt transformed by an input handler", async () => {
	const fixture = setup();
	await fixture.run("original");
	await fixture.run("");

	await submitInput(fixture, fixture.sent[0].prompt);
	await fixture.handlers.get("before_agent_start")!({ prompt: "transformed" }, fixture.ctx);
	assert.deepEqual(latestPrompts(fixture.entries), []);
});

test("acknowledges an idle delivery while a follow-up is pending", async () => {
	const fixture = setup();
	await fixture.run("idle prompt");
	await fixture.run("");
	await submitInput(fixture, fixture.sent[0].prompt);
	fixture.setIdle(false);
	await fixture.run("queued prompt");
	fixture.queueSelection("2. queued prompt");
	await fixture.run("");
	await submitInput(fixture, fixture.sent.at(-1)!.prompt);

	await fixture.handlers.get("before_agent_start")!({ prompt: fixture.sent[0].prompt }, fixture.ctx);
	assert.deepEqual(latestPrompts(fixture.entries), ["queued prompt"]);
});

test("acknowledges overlapping idle deliveries independently", async () => {
	const fixture = setup();
	await fixture.run("first");
	await fixture.run("second");
	fixture.queueSelection("1. first");
	await fixture.run("");
	await submitInput(fixture, fixture.sent[0].prompt);
	fixture.queueSelection("2. second");
	await fixture.run("");
	await submitInput(fixture, fixture.sent[1].prompt);

	await fixture.handlers.get("before_agent_start")!({ prompt: fixture.sent[0].prompt }, fixture.ctx);
	await fixture.handlers.get("before_agent_start")!({ prompt: fixture.sent[1].prompt }, fixture.ctx);
	assert.deepEqual(latestPrompts(fixture.entries), []);
});

test("keeps an idle delivery when unrelated input starts first", async () => {
	const fixture = setup();
	await fixture.run("idle prompt");
	await fixture.run("");
	await submitInput(fixture, fixture.sent[0].prompt);
	await submitInput(fixture, "unrelated", "interactive");

	await fixture.handlers.get("before_agent_start")!({ prompt: "unrelated" }, fixture.ctx);
	assert.deepEqual(latestPrompts(fixture.entries), ["idle prompt"]);
});

test("queues a prompt when the agent starts during authentication", async () => {
	let authRequested!: () => void;
	const requested = new Promise<void>((resolve) => {
		authRequested = resolve;
	});
	let resolveAuth!: (result: { ok: true }) => void;
	const auth = new Promise<{ ok: true }>((resolve) => {
		resolveAuth = resolve;
	});
	const fixture = setup({
		getAuth: async () => {
			authRequested();
			return auth;
		},
	});
	await fixture.run("race-safe prompt");
	const confirmation = fixture.run("");
	await requested;
	fixture.setIdle(false);
	resolveAuth({ ok: true });
	await confirmation;

	assert.equal(fixture.sent.length, 1);
	assertHasInvisibleMarker(fixture.sent[0].prompt, "race-safe prompt");
	assert.deepEqual(fixture.sent[0].options, { deliverAs: "followUp" });
	await fixture.handlers.get("before_agent_start")!({ prompt: "unrelated" }, fixture.ctx);
	assert.deepEqual(latestPrompts(fixture.entries), ["race-safe prompt"]);
});

test("removes the selected duplicate follow-up when its turn starts", async () => {
	const fixture = setup({ idle: false });
	await fixture.run("A");
	await fixture.run("B");
	await fixture.run("A");
	fixture.queueSelection("3. A");
	await fixture.run("");

	assert.equal(fixture.sent.length, 1);
	assertHasInvisibleMarker(fixture.sent[0].prompt, "A");
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
	await submitInput(fixture, fixture.sent[0].prompt);
	await fixture.handlers.get("before_agent_start")!({ prompt: fixture.sent[0].prompt }, fixture.ctx);

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

test("keeps and can rerun a follow-up removed from Pi's queue", async () => {
	const fixture = setup({ idle: false });
	await fixture.run("run later");
	await fixture.run("");
	fixture.dequeueFollowUps();
	await fixture.handlers.get("agent_settled")?.({}, fixture.ctx);

	fixture.setIdle(true);
	await fixture.run("");
	await submitInput(fixture, fixture.sent[1].prompt);
	await fixture.handlers.get("before_agent_start")!({ prompt: fixture.sent[1].prompt }, fixture.ctx);

	assert.deepEqual(latestPrompts(fixture.entries), []);
});

test("keeps and can rerun a dequeued follow-up after its text is edited", async () => {
	const fixture = setup({ idle: false });
	await fixture.run("run later");
	await fixture.run("");
	fixture.dequeueFollowUps();
	await submitInput(fixture, "edited prompt", "interactive");
	await startUserMessage(fixture, "edited prompt");
	assert.deepEqual(latestPrompts(fixture.entries), ["run later"]);

	fixture.setIdle(true);
	await fixture.run("");
	await submitInput(fixture, fixture.sent[1].prompt);
	await fixture.handlers.get("before_agent_start")!({ prompt: fixture.sent[1].prompt }, fixture.ctx);

	assert.deepEqual(latestPrompts(fixture.entries), []);
});

test("keeps follow-up delivery tracking across session tree navigation", async () => {
	const fixture = setup({ idle: false });
	await fixture.run("queued prompt");
	await fixture.run("");
	const queued = fixture.sent[0].prompt;

	await fixture.handlers.get("session_tree")!({}, fixture.ctx);
	const event = await startUserMessage(fixture, queued);

	assert.equal(event.message.content[0].text, "queued prompt");
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
