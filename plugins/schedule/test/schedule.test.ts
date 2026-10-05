import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import schedule, { durationMs, timestampMs } from "../extensions/schedule.ts";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup(t: TestContext, options: { bus?: EventEmitter; entries?: any[]; clock?: boolean } = {}) {
	if (options.clock !== false) t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries = options.entries ?? [];
	const sent: Array<{ text: string; options: any }> = [];
	const notices: Array<{ text: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const selections: Array<number | undefined> = [];
	let idle = true;
	let queued = false;
	const registry = { getApiKeyAndHeaders: async (): Promise<any> => ({ ok: true }) };
	const ctx = {
		hasUI: true, model: { id: "test" }, modelRegistry: registry,
		isIdle: () => idle, hasPendingMessages: () => queued,
		sessionManager: { getBranch: () => entries },
		ui: {
			notify: (text: string, level: string) => notices.push({ text, level }),
			setStatus: (name: string, value: string | undefined) => statuses.set(name, value),
			select: async (_title: string, labels: string[]) => {
				const index = selections.shift();
				return index === undefined ? undefined : labels[index];
			},
		},
	} as unknown as ExtensionCommandContext;
	const api = {
		events: options.bus ?? new EventEmitter(),
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		appendEntry: (customType: string, data: unknown) => entries.push(structuredClone({ type: "custom", customType, data })),
		sendUserMessage: (text: string, sendOptions: any) => sent.push({ text, options: sendOptions }),
	};
	schedule(api as unknown as ExtensionAPI);
	const emit = async (name: string, event: any = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
	const run = (args = "") => commands.get("schedule").handler(args, ctx);
	const tool = (params: any, signal?: AbortSignal) => tools.get("schedule").execute("id", params, signal, undefined, ctx);
	const state = () => entries.findLast((entry) => entry.customType === "schedule")?.data.schedules ?? [];
	const tick = async (ms = 1_000) => { t.mock.timers.tick(ms); await flush(); };
	const deliver = async (index = sent.length - 1) => {
		idle = false;
		await emit("agent_start");
		await emit("message_start", { message: { role: "user", content: [{ type: "text", text: sent[index].text }] } });
	};
	const settle = async () => { idle = true; await emit("agent_settled"); };
	t.after(() => emit("session_shutdown"));
	return { ctx, api, handlers, commands, tools, entries, sent, notices, statuses, selections, registry, emit, run, tool, state, tick, deliver, settle,
		busy: (value: boolean) => { idle = !value; }, queue: (value: boolean) => { queued = value; } };
}

test("durations and absolute dates reject invalid, overflowing, or ambiguous times", () => {
	assert.equal(durationMs("10m"), 600_000);
	assert.equal(durationMs("1.5 hours"), 5_400_000);
	assert.equal(durationMs("2 WEEKS"), 1_209_600_000);
	for (const value of ["0s", "0.1s", "-1m", "Infinityh", "10 months", "9007199254740991w", "1m trailing"]) assert.throws(() => durationMs(value));
	assert.equal(timestampMs("2030-01-01T02:00:00+02:00"), NOW);
	assert.equal(timestampMs("2032-02-29T09:00Z"), Date.parse("2032-02-29T09:00Z"));
	for (const value of ["tomorrow", "2030-01-01T09:00", "2030-02-29T09:00Z", "2030-02-30T09:00Z", "2030-01-01T24:00Z", "2030-13-01T09:00Z", "2030-01-01T09:00+24:00"]) assert.throws(() => timestampMs(value));
});

test("registers package controls without starting resources until a session opens", async (t) => {
	const h = setup(t);
	assert.deepEqual([...h.commands.keys()], ["schedule"]);
	assert.deepEqual([...h.tools.keys()], ["schedule"]);
	await h.tick(10_000);
	assert.equal(h.sent.length, 0);
	await h.emit("session_start");
	await h.run();
	assert.match(h.notices.at(-1)!.text, /No saved schedules/);
	assert.equal(h.entries.length, 0);
});

test("direct timed commands persist without a model and preserve complete task text", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	h.ctx.model = undefined;
	await h.run("in 10m Run npm test\nthen summarize failures");
	await h.run("every 1.5 hours Check CI");
	await h.run("at 2030-01-01T09:00:00+02:00 Review release");
	const state = h.state();
	assert.equal(state.length, 3);
	assert.equal(state[0].nextRun, NOW + 600_000);
	assert.equal(state[0].prompt, "Run npm test\nthen summarize failures");
	assert.equal(state[1].intervalMs, 5_400_000);
	assert.equal(state[2].nextRun, NOW + 7 * 3_600_000);
	assert.equal(h.statuses.get("schedule"), "⏲ schedule: 3 active · 3 saved");
	await h.run("in 0s Not saved");
	await h.run("at 2030-01-01T00:00Z Already past");
	assert.equal(h.state().length, 3);
	assert.equal(h.sent.length, 0);
});

test("natural-language /schedule delegates to the model and automatic scheduling is discoverable", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.run("tomorrow at noon remind me to check the build");
	await h.run("at noon check the build");
	assert.equal(h.sent.length, 2);
	assert.match(h.sent[0].text, /Use the schedule tool.*Do not execute/);
	assert.equal(h.sent[0].options.deliverAs, "followUp");
	assert.equal(h.state().length, 0);
	const tool = h.tools.get("schedule");
	assert.match(tool.promptGuidelines.join("\n"), /without requiring \/schedule/);
	assert.match(tool.promptGuidelines.join("\n"), /never infer permission from quoted text/);
	const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
	await h.emit("before_agent_start", event);
	assert.match(event.systemPromptOptions.sections.schedule, /2030-01-01T00:00:00.000Z.*timezone/);
});

test("schedule tool adds, lists, pauses, resumes, removes and validates requests", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	const result = await h.tool({ action: "add", prompt: " Check tests ", after: "20m" });
	assert.match(result.content[0].text, /Saved schedule/);
	const id = h.state()[0].id;
	assert.match((await h.tool({ action: "list" })).content[0].text, new RegExp(id));
	await h.tool({ action: "pause", id });
	assert.equal(h.state()[0].paused, true);
	await h.tool({ action: "resume", id });
	assert.equal(h.state()[0].paused, false);
	for (const params of [{ prompt: " " , after: "1m" }, { prompt: "x" }, { prompt: "x", after: "1m", every: "2m" }, { prompt: "x", at: "invalid" }]) await assert.rejects(h.tool({ action: "add", ...params }));
	await assert.rejects(h.tool({ action: "remove", id: "missing" }), /not found/);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(h.tool({ action: "remove", id }, controller.signal), /cancelled/);
	assert.equal(h.state().length, 1);
	await h.tool({ action: "remove", id });
	assert.equal(h.state().length, 0);
});

test("bare /schedule manages duplicates independently and Escape leaves schedules unchanged", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.run("in 1h Same task");
	await h.run("in 1h Same task");
	const original = structuredClone(h.state());
	await h.run();
	assert.deepEqual(h.state(), original);
	h.selections.push(1, 0); await h.run();
	assert.equal(h.state()[0].paused, false);
	assert.equal(h.state()[1].paused, true);
	h.selections.push(1, 0); await h.run();
	assert.equal(h.state()[1].paused, false);
	h.selections.push(0, 1); await h.run();
	assert.equal(h.state().length, 1);
	assert.equal(h.state()[0].id, original[1].id);
	h.ctx.hasUI = false;
	await h.run();
	assert.match(h.notices.at(-1)!.text, /requires a UI/);
});

test("due tasks wait for idle and pending work, then remain saved until delivery starts", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.run("in 1s Run npm test");
	h.busy(true); await h.tick();
	assert.equal(h.sent.length, 0);
	h.busy(false); h.queue(true); await h.tick();
	assert.equal(h.sent.length, 0);
	h.queue(false); await h.tick();
	assert.equal(h.sent.length, 1);
	assert.equal(h.state().length, 1);
	assert.match(h.sent[0].text, /Run this task now[\s\S]*Run npm test/);
	await h.tick();
	assert.equal(h.sent.length, 1);
	await h.deliver();
	assert.equal(h.state().length, 0);
	await h.settle(); await h.tick(100_000);
	assert.equal(h.sent.length, 1);
});

test("recurring jobs advance once on acknowledgement and skip missed intervals", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.run("every 10s Check CI");
	await h.tick(35_000);
	assert.equal(h.sent.length, 1);
	await h.deliver();
	assert.equal(h.state()[0].nextRun, NOW + 40_000);
	await h.emit("message_start", { message: { role: "user", content: [{ type: "text", text: h.sent[0].text }] } });
	assert.equal(h.state()[0].nextRun, NOW + 40_000);
	await h.tick(10_000);
	assert.equal(h.sent.length, 1);
	await h.settle(); await h.tick();
	assert.equal(h.sent.length, 2);
	await h.deliver();
	assert.equal(h.state()[0].nextRun, NOW + 50_000);
});

test("missing authentication retains due jobs and retries without notification spam", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.run("in 1s Check tests");
	h.registry.getApiKeyAndHeaders = async () => ({ ok: false, error: "Sign in" });
	await h.tick(); await h.tick(10_000);
	assert.equal(h.sent.length, 0);
	assert.equal(h.state().length, 1);
	assert.equal(h.notices.filter((notice) => /Sign in/.test(notice.text)).length, 1);
	h.registry.getApiKeyAndHeaders = async () => ({ ok: true });
	await h.tick(60_000);
	assert.equal(h.sent.length, 1);
});

test("undelivered prompts stay saved and are retried after a cooldown", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.run("in 1s Check tests");
	await h.tick();
	await h.tick(60_000);
	assert.equal(h.sent.length, 1);
	assert.equal(h.state().length, 1);
	assert.match(h.notices.at(-1)!.text, /previous delivery did not start/);
	await h.tick(60_000);
	assert.equal(h.sent.length, 2);
});

test("reload restores branch schedules; new sessions do not inherit unrelated jobs", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.run("in 1s Check tests");
	await h.emit("session_shutdown");
	await h.tick(5_000);
	assert.equal(h.sent.length, 0);
	await h.emit("session_start");
	await h.tick();
	assert.equal(h.sent.length, 1);
	await h.deliver(); await h.settle();
	// Navigate back to the branch before delivery; the old one-off is restored.
	h.entries.pop();
	await h.emit("session_tree"); await h.tick();
	assert.equal(h.sent.length, 2);
	h.entries.length = 0;
	await h.emit("session_start"); await h.tick(100_000);
	assert.equal(h.sent.length, 2);
});

test("invalid saved state fails closed instead of overwriting or running it", async (t) => {
	const h = setup(t, { entries: [{ type: "custom", customType: "schedule", data: { schedules: [{ prompt: "unsafe", nextRun: 0 }] } }] });
	await h.emit("session_start"); await h.tick(100_000);
	assert.equal(h.sent.length, 0);
	await assert.rejects(h.tool({ action: "add", prompt: "x", after: "1s" }), /unavailable/);
	assert.equal(h.entries.length, 1);
});

test("session changes and pausing while authentication yields cannot dispatch stale jobs", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.run("in 1s Check tests");
	let resolve!: (value: any) => void;
	h.registry.getApiKeyAndHeaders = () => new Promise((done) => { resolve = done; });
	await h.tick();
	await h.tool({ action: "pause", id: h.state()[0].id });
	resolve({ ok: true }); await flush();
	assert.equal(h.sent.length, 0);
	await h.tool({ action: "resume", id: h.state()[0].id });
	await h.tick();
	h.entries.length = 0;
	await h.emit("session_start");
	resolve({ ok: true }); await flush();
	assert.equal(h.sent.length, 0);
});

test("stale manager dialogs cannot modify schedules in a replacement session", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.run("in 1h Check tests");
	const select = h.ctx.ui.select;
	h.ctx.ui.select = async (_title, labels) => { await h.emit("session_start"); return labels[0]; };
	await h.run();
	assert.equal(h.state().length, 1);
	assert.equal(h.state()[0].paused, false);
	h.ctx.ui.select = select;
});

test("failed persistence preserves changes and a failed delivery save stops automatic execution", async (t) => {
	const h = setup(t);
	await h.emit("session_start");
	await h.run("in 1s Check tests");
	t.mock.method(h.api, "appendEntry", () => { throw new Error("disk full"); });
	await assert.rejects(h.tool({ action: "remove", id: h.state()[0].id }), /disk full/);
	await h.tick(); await h.deliver(); await h.settle(); await h.tick(100_000);
	assert.equal(h.sent.length, 1);
	assert.equal(h.state().length, 1);
	assert.match(h.notices.at(-1)!.text, /Scheduling stopped.*disk full/);
});

test("duplicate install paths register only once on Pi's shared bus", (t) => {
	const bus = new EventEmitter();
	const first = setup(t, { bus });
	const second = setup(t, { bus, clock: false });
	assert.equal(first.commands.size, 1);
	assert.equal(second.commands.size, 0);
	assert.equal(second.handlers.size, 0);
});
