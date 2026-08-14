import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const setup = (options: { idle?: boolean; sessionFile?: string; authError?: string } = {}) => {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const entries: CustomEntry[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const sent: Array<{ prompt: string; options?: { deliverAs: "followUp" } }> = [];
	let selection: string | undefined;

	const sessionManager = {
		getBranch: () => entries,
		getEntries: () => [...entries],
		getHeader: () => ({ type: "session", version: 3, id: "session", timestamp: "2026-08-14T00:00:00.000Z", cwd: "/tmp" }),
		getSessionFile: () => options.sessionFile,
	};
	const ctx = {
		hasUI: true,
		isIdle: () => options.idle ?? true,
		model: { provider: "test", id: "model" },
		modelRegistry: {
			getApiKeyAndHeaders: async () =>
				options.authError === undefined ? { ok: true } : { ok: false, error: options.authError },
		},
		sessionManager,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			select: async (_title: string, labels: string[]) => selection ?? labels[0],
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
		setSelection: (value: string) => {
			selection = value;
		},
		run: async (args: string) => command!(args, ctx),
	};
};

const latestPrompts = (entries: CustomEntry[]) => entries.at(-1)?.data.prompts;

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

test("removes the selected duplicate prompt", async () => {
	const fixture = setup({ idle: false });
	await fixture.run("A");
	await fixture.run("B");
	await fixture.run("A");
	fixture.setSelection("3. A");
	await fixture.run("");

	assert.deepEqual(fixture.sent, [{ prompt: "A", options: { deliverAs: "followUp" } }]);
	assert.deepEqual(latestPrompts(fixture.entries), ["A", "B"]);
});

test("removes the selected duplicate after an idle turn is accepted", async () => {
	const fixture = setup();
	await fixture.run("A");
	await fixture.run("B");
	await fixture.run("A");
	fixture.setSelection("3. A");
	await fixture.run("");
	await fixture.handlers.get("before_agent_start")!({ prompt: "A" }, fixture.ctx);

	assert.deepEqual(latestPrompts(fixture.entries), ["A", "B"]);
});

test("writes an unflushed session on graceful exit", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-later-"));
	const sessionFile = join(directory, "session.jsonl");

	try {
		const fixture = setup({ sessionFile });
		await fixture.run("survive exit");
		await fixture.handlers.get("session_shutdown")!({ reason: "quit" }, fixture.ctx);

		const lines = readFileSync(sessionFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(lines[0].type, "session");
		assert.deepEqual(lines.at(-1)!.data.prompts, ["survive exit"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
