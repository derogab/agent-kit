import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type {
	AgentBeforeSettleEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import goal from "../extensions/goal.ts";

const DONE = "<goal>done</goal>";
const BLOCKED = "<goal>blocked</goal>";
const PAGE_LEFT = "\x1b[1;6D"; // Ctrl+Shift+Left and Ctrl+Shift+Right as sent by the terminal.
const PAGE_RIGHT = "\x1b[1;6C";
const archiveRoot = process.geteuid ? `/tmp/pi-goals-${process.geteuid()}` : join(tmpdir(), "pi-goals");
const directories: string[] = [];
after(() => directories.forEach((cwd) => rmSync(cwd, { recursive: true, force: true })));

const assistant = (text: string, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason,
});

const setup = (options: { cwd?: string; sessionId?: string; mode?: string; bus?: EventEmitter; factory?: typeof goal } = {}) => {
	const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "pi-goal-test-"));
	if (!options.cwd) directories.push(cwd);
	const mode = options.mode ?? "tui";
	const sessionId = options.sessionId ?? randomUUID();
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const tools = new Map<string, any>();
	const shortcuts = new Map<KeyId, { handler: (ctx: ExtensionContext) => void | Promise<void> }>();
	const sent: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const widgets = new Map<string, any>();
	let idle = true;
	let pending = false;
	let aborts = 0;
	const registry = { getApiKeyAndHeaders: async (): Promise<any> => ({ ok: true, apiKey: "test" }) };
	const ctx = {
		cwd, mode,
		sessionManager: { getSessionId: () => sessionId },
		hasUI: mode === "tui" || mode === "rpc",
		model: { id: "test-model" },
		modelRegistry: registry,
		signal: undefined,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		abort: () => { aborts++; },
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setWidget: (key: string, value: any) => widgets.set(key, value),
			select: async () => assert.fail("Goals must not require review dialogs."),
		},
	} as unknown as ExtensionCommandContext;
	const api = {
		events: options.bus ?? new EventEmitter(),
		on: (event: string, handler: (event: any, ctx: ExtensionContext) => any) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerShortcut: (key: KeyId, shortcut: any) => shortcuts.set(key, shortcut),
		sendUserMessage: (text: string) => {
			sent.push(text);
			void handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		},
	};
	(options.factory ?? goal)(api as unknown as ExtensionAPI);
	const emit = (name: string, event: any = {}) => handlers.get(name)!({ type: name, ...event }, ctx);
	const boundary = (messages: any[] = [assistant("More work remains.")], overrides: Partial<AgentBeforeSettleEvent> = {}) => emit("agent_before_settle", {
		entries: [], continue: false, outcome: "completed",
		context: { contextMessages: messages, pendingMessages: [], canContinue: false },
		...overrides,
	});
	const directory = join(cwd, ".pi", "goals", "sessions", `session-${encodeURIComponent(sessionId)}`);
	const current = join(directory, "current.json");
	const workspace = createHash("sha256").update(fs.realpathSync(cwd)).digest("hex");
	const workspaceArchive = join(archiveRoot, workspace);
	if (!options.cwd) directories.push(workspaceArchive);
	const archiveDir = join(workspaceArchive, `session-${encodeURIComponent(sessionId)}`);
	const archived = () => existsSync(archiveDir) ? readdirSync(archiveDir).filter((name) => name.endsWith(".json")).sort() : [];
	const render = (width = 100, theme = { fg: (_color: string, text: string) => text }): string[] => {
		const widget = widgets.get("goal");
		return typeof widget === "function" ? widget({}, theme).render(width) : widget ?? [];
	};
	return {
		ctx, api, registry, handlers, commands, tools, shortcuts, sent, notifications, widgets, emit, boundary,
		cwd, sessionId, directory, current, archiveDir, archived, render,
		reply: async (text = "The blocker is resolved.", source = "interactive", images?: any[]) => {
			await emit("input", { text, source, images });
			const result = await emit("before_agent_start", { prompt: text, messageType: "user", images });
			await emit("agent_start");
			return result;
		},
		press: (data: string) => {
			for (const [key, shortcut] of shortcuts) if (matchesKey(data, key)) return shortcut.handler(ctx);
		},
		state: () => JSON.parse(readFileSync(current, "utf8")),
		archive: (index = 0) => JSON.parse(readFileSync(join(archiveDir, archived()[index]), "utf8")),
		run: (args: string) => commands.get("goal")!.handler(args, ctx),
		command: (name: string) => commands.get(name)!.handler("", ctx),
		update: (tasks: Array<{ text: string; done: boolean }>, signal?: AbortSignal) =>
			tools.get("goal_progress").execute("id", { tasks }, signal, undefined, ctx),
		busy: () => { idle = false; },
		queue: (value = true) => { pending = value; },
		aborts: () => aborts,
	};
};

const tasks = [{ text: "Fix tests", done: true }, { text: "Run full suite", done: false }];
const completedTasks = tasks.map((task) => ({ ...task, done: true }));

const { default: projectGoal } = await import(new URL("../extensions/goal.ts?project", import.meta.url).href);

test("duplicate install paths register only one tool, command set and lifecycle", async () => {
	assert.notEqual(projectGoal, goal);
	for (const factories of [[goal, projectGoal], [projectGoal, goal]]) {
		const bus = new EventEmitter();
		const first = setup({ bus, factory: factories[0] });
		const second = setup({ bus, factory: factories[1] });
		assert.equal(second.handlers.size, 0);
		assert.equal(second.commands.size, 0);
		assert.equal(second.tools.size, 0);
		assert.equal(second.shortcuts.size, 0);
		assert.deepEqual([...first.shortcuts.keys()], ["ctrl+shift+left", "ctrl+shift+right"]);
		await first.emit("session_start");
		await first.run("Fix the tests.");
		await first.update(tasks);
		assert.equal((await first.boundary()).entries.length, 1);
		assert.deepEqual(first.state().tasks, tasks);
		await first.emit("session_shutdown");
		assert.equal(setup({ bus }).tools.size, 0, "session changes must retain the claim");
		// Pi removes runtime subscriptions on /reload, but keeps the shared bus.
		bus.removeAllListeners();
		const reloaded = setup({ bus, cwd: first.cwd, sessionId: first.sessionId, factory: factories[1] });
		assert.deepEqual([...reloaded.commands.keys()], [...first.commands.keys()]);
		assert.deepEqual([...reloaded.tools.keys()], ["goal_progress"]);
		assert.equal(setup({ bus, factory: factories[0] }).tools.size, 0);
		await reloaded.emit("session_start");
		assert.equal(reloaded.state().status, "paused");
		assert.deepEqual(reloaded.state().tasks, tasks);
		await reloaded.command("goal-resume");
		assert.equal(reloaded.sent.length, 1);
	}
});

test("a failed registration does not prevent another copy from loading", () => {
	const bus = new EventEmitter();
	assert.throws(() => setup({
		bus,
		factory: (pi) => goal({
			...pi,
			registerTool: () => { throw new Error("Tool registration failed"); },
		}),
	}), /Tool registration failed/);
	const next = setup({ bus, factory: projectGoal });
	assert.equal(next.commands.size, 5);
	assert.deepEqual([...next.tools.keys()], ["goal_progress"]);
});

test("does nothing and creates no files without an explicit goal", async () => {
	const h = setup();
	assert.deepEqual([...h.commands.keys()], ["goal", "goal-status", "goal-pause", "goal-resume", "goal-stop"]);
	assert.deepEqual([...h.tools.keys()], ["goal_progress"]);
	await h.emit("session_start");
	assert.equal(await h.boundary(), undefined);
	await h.emit("agent_settled");
	await h.run("  ");
	assert.match(h.notifications.at(-1)!.message, /Usage: \/goal <objective>.*\/goal-status/);
	await h.command("goal-status");
	assert.match(h.notifications.at(-1)!.message, /No active goal/);
	for (const name of ["goal-pause", "goal-resume", "goal-stop"]) await h.command(name);
	assert.equal(h.sent.length, 0);
	assert.equal(existsSync(h.directory), false);
	assert.equal(existsSync(h.archiveDir), false);
	assert.deepEqual(h.render(), []);
	await assert.rejects(h.update(tasks), /No running goal/);
});

test("control words are ordinary objectives, not /goal subcommands", async () => {
	for (const instruction of ["status", "pause", "resume", "stop", "review"]) {
		const h = setup();
		await h.run(instruction);
		assert.equal(h.state().instruction, instruction);
		assert.equal(h.state().status, "running");
		assert.equal(h.sent.length, 1);
	}
});

test("starts a trimmed objective, saves minimal state and shows the goal above the editor", async () => {
	const h = setup();
	await h.run("  Fix all tests\nwithout deleting any.  ");
	assert.equal(h.sent.length, 1);
	assert.match(h.sent[0], /Fix all tests\nwithout deleting any\./);
	assert.match(h.sent[0], /verify/);
	assert.match(h.sent[0], /permission/);
	assert.match(h.sent[0], /Apply later user messages and corrections before continuing or declaring completion/);
	assert.match(h.sent[0], /Goal reminders do not override newer user instructions/);
	assert.match(h.sent[0], /automatically marks the checklist complete and archives the goal/);
	assert.ok(!/confirm completion|goal-review/.test(h.sent[0]));
	assert.ok(h.sent[0].includes(DONE) && h.sent[0].includes(BLOCKED));
	assert.deepEqual(h.state(), {
		instruction: "Fix all tests\nwithout deleting any.", status: "running", round: 1, tasks: [],
	});
	assert.match(h.render().join("\n"), /goal · running · 0\/0 tasks done · round 1/);
	assert.equal(h.render()[0][0], "╭");
	assert.match(h.render().join("\n"), /\/goal-pause/);
	await h.command("goal-status");
	assert.match(h.notifications.at(-1)!.message, /Goal \(running, round 1, 0\/0 tasks done\): Fix all tests/);
	assert.equal(h.sent.length, 1);
});

test("bare /goal shows usage without changing an existing goal", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	const before = h.state();
	await h.run("  ");
	assert.match(h.notifications.at(-1)!.message, /Usage: \/goal <objective>.*\/goal-status/);
	assert.deepEqual(h.state(), before);
	assert.equal(h.sent.length, 1);
	assert.equal(h.aborts(), 0);
});

test("/goal-status reports progress while busy or paused without starting work", async () => {
	for (const paused of [false, true]) {
		const h = setup();
		await h.run("Fix the tests.");
		await h.update(tasks);
		if (paused) await h.emit("agent_settled");
		else { h.busy(); h.queue(); }
		const before = h.state();
		await h.command("goal-status");
		assert.ok(h.notifications.at(-1)!.message.includes(`Goal (${before.status}, round 1, 1/2 tasks done): Fix the tests.`));
		assert.deepEqual(h.state(), before);
		assert.equal(h.sent.length, 1);
		assert.equal(h.aborts(), 0);
	}
});

test("checklist updates persist, render and feed the next continuation", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	assert.equal((await h.update(tasks)).content[0].text, "1/2 tasks done");
	assert.deepEqual(h.state().tasks, tasks);
	assert.match(h.render().join("\n"), /1\/2 tasks done/);
	const result = await h.boundary();
	assert.ok(result.entries[0].content.includes(JSON.stringify(tasks)));
	assert.deepEqual(readdirSync(h.directory), ["current.json"], "atomic saves leave no temporary files");
	await assert.rejects(h.update([], AbortSignal.abort()), /No running goal/);
	assert.deepEqual(h.state().tasks, tasks);
});

test("checklist rows stay compact, survive pause reloads and disappear after completion", async () => {
	for (const mode of ["tui", "rpc"]) {
		const h = setup({ mode });
		const rows = (h: ReturnType<typeof setup>) => h.render().map((line) => line.replace(/^│ | │$/g, "").trimEnd());
		await h.run("Fix the tests.");
		assert.equal(h.render().length, mode === "tui" ? 5 : 3, "empty checklists add no rows");
		await h.update(tasks);
		assert.deepEqual(rows(h).slice(mode === "tui" ? 3 : 2, mode === "tui" ? 5 : 4), ["✓ Fix tests", "· Run full suite"]);
		await h.update(tasks.map((task) => ({ ...task, done: true })));
		assert.ok(rows(h).includes("✓ Run full suite"));
		assert.ok(!rows(h).includes("· Run full suite"));
		await h.update([]);
		assert.equal(h.render().length, mode === "tui" ? 5 : 3);
		await h.update(tasks);
		await h.command("goal-pause");
		const next = setup({ cwd: h.cwd, sessionId: h.sessionId, mode });
		await next.emit("session_start");
		assert.ok(rows(next).includes("✓ Fix tests") && rows(next).includes("· Run full suite"));
		await next.command("goal-resume");
		await next.boundary([assistant(DONE)]);
		const archived = setup({ cwd: h.cwd, sessionId: h.sessionId, mode });
		await archived.emit("session_start");
		assert.deepEqual(archived.render(), []);
		assert.deepEqual(archived.archive().tasks, completedTasks);
	}
});

test("large checklists have a bounded preview without losing saved or resumed tasks", async () => {
	for (const mode of ["tui", "rpc"]) {
		const h = setup({ mode });
		await h.run("Complete every task.");
		let checklist: Array<{ text: string; done: boolean }> = [];
		for (const count of [0, 5, 6, 10, 11, 100]) {
			checklist = Array.from({ length: count }, (_, i) => ({ text: `Task ${i + 1}`, done: i % 2 === 0 }));
			await h.update(checklist);
			const lines = h.render();
			assert.equal(lines.length, (mode === "tui" ? 5 : 3) + Math.min(count, 5) + Number(count > 5));
			assert.equal(lines.filter((line) => /[·✓] Task /.test(line)).length, Math.min(count, 5));
			const hint = mode === "tui" ? `Page 1/${Math.ceil(count / 5)} · Ctrl+Shift+←/→` : `… ${count - 5} more`;
			assert.equal(lines.some((line) => line.includes(hint)), count > 5);
			assert.ok(!lines.some((line) => line.includes("Task 6")));
			assert.deepEqual(h.state().tasks, checklist);
			assert.ok((await h.boundary()).entries[0].content.includes(JSON.stringify(checklist)));
		}
		await h.command("goal-pause");
		const next = setup({ cwd: h.cwd, sessionId: h.sessionId, mode });
		await next.emit("session_start");
		assert.ok(next.render().some((line) => line.includes(mode === "tui" ? "Page 1/20" : "… 95 more")));
		await next.command("goal-resume");
		assert.ok(next.sent[0].includes(JSON.stringify(checklist)));
		await next.boundary([assistant(DONE)]);
		assert.deepEqual(next.archive().tasks, checklist.map((task) => ({ ...task, done: true })));
		const archived = setup({ cwd: h.cwd, sessionId: h.sessionId, mode });
		await archived.emit("session_start");
		assert.deepEqual(archived.render(), []);
		assert.deepEqual(archived.archive().tasks, checklist.map((task) => ({ ...task, done: true })));
	}
});

test("modified arrows page through every task in the goal box without changing saved state", async () => {
	const h = setup();
	await h.press(PAGE_RIGHT);
	assert.deepEqual(h.render(), []);
	assert.equal(existsSync(h.directory), false);
	await h.run("Complete every task.");
	const checklist = Array.from({ length: 13 }, (_, i) => ({ text: `Task ${i + 1}`, done: i % 2 === 0 }));
	await h.update(checklist);
	const before = readFileSync(h.current, "utf8");
	const checkPage = (page: number) => {
		const lines = h.render();
		assert.ok(lines.some((line) => line.includes(`Page ${page}/3 · Ctrl+Shift+←/→`)));
		const rows = lines.flatMap((line) => line.match(/[✓·] Task \d+/g) ?? []);
		assert.deepEqual(rows, checklist.slice((page - 1) * 5, page * 5).map((t) => `${t.done ? "✓" : "·"} ${t.text}`));
	};
	checkPage(1);
	for (const [key, page] of [[PAGE_LEFT, 1], ["\x1b[C", 1], [PAGE_RIGHT, 2], [PAGE_RIGHT, 3],
		[PAGE_RIGHT, 3], [PAGE_LEFT, 2], [PAGE_LEFT, 1]] as const) {
		await h.press(key);
		checkPage(page);
	}
	assert.equal(readFileSync(h.current, "utf8"), before);
	assert.equal(h.sent.length, 1);
	assert.equal(h.aborts(), 0);
});

test("live updates retain the current page or clamp it when the checklist shrinks", async () => {
	const h = setup();
	await h.run("Track progress.");
	const checklist = Array.from({ length: 11 }, (_, i) => ({ text: `Task ${i + 1}`, done: false }));
	await h.update(checklist);
	await h.press(PAGE_RIGHT);
	await h.press(PAGE_RIGHT);
	await h.update(checklist.map((task) => ({ ...task, done: true })));
	assert.match(h.render().join("\n"), /✓ Task 11/);
	await h.update(checklist.slice(0, 6));
	assert.match(h.render().join("\n"), /Page 2\/2/);
	assert.match(h.render().join("\n"), /· Task 6/);
	await h.update([]);
	assert.doesNotMatch(h.render().join("\n"), /Task \d|Page|Ctrl\+Shift/);
	await h.update(checklist);
	assert.match(h.render().join("\n"), /Page 1\/3/);
});

test("blocked, paused and stopped goals can be paged; a new goal starts on page one", async () => {
	const h = setup();
	await h.run("First goal.");
	const checklist = Array.from({ length: 6 }, (_, i) => ({ text: `Task ${i + 1}`, done: false }));
	await h.update(checklist);
	await h.boundary([assistant(BLOCKED)]);
	await h.emit("agent_settled");
	await h.press(PAGE_RIGHT);
	assert.match(h.render().join("\n"), /goal · blocked[\s\S]*Page 2\/2/);
	await h.command("goal-pause");
	await h.press(PAGE_LEFT);
	assert.match(h.render().join("\n"), /goal · paused[\s\S]*Page 1\/2/);
	await h.command("goal-stop");
	await h.press(PAGE_RIGHT);
	assert.match(h.render().join("\n"), /stopped · archived[\s\S]*Page 2\/2/);
	assert.deepEqual(h.archive().tasks, checklist);
	await h.run("Second goal.");
	await h.update(checklist);
	assert.match(h.render().join("\n"), /Page 1\/2/);
	await h.press(PAGE_RIGHT);
	await h.boundary([assistant(DONE)]);
	await h.press(PAGE_LEFT);
	assert.deepEqual(h.render(), []);
});

for (const mode of ["rpc", "json"]) {
	test(`paging is terminal-only and leaves ${mode} goal behavior unchanged`, async () => {
		const h = setup({ mode });
		await h.run("Complete every task.");
		await h.update(Array.from({ length: 6 }, (_, i) => ({ text: `Task ${i + 1}`, done: false })));
		const before = h.render();
		await h.press(PAGE_RIGHT);
		assert.deepEqual(h.render(), before);
		assert.doesNotMatch(before.join("\n"), /Ctrl\+Shift|Page/);
		assert.equal(h.state().tasks.length, 6);
	});
}

test("continues repeatedly while preserving other extensions' entries", async () => {
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
		assert.equal(h.state().round, round);
		assert.ok(h.render().join("\n").includes(`round ${round}`));
	}
	assert.equal(h.sent.length, 1, "continuations must not queue uncancellable follow-ups");
});

for (const mode of ["tui", "rpc", "json"]) {
	test(`completion announces success and archives the completed checklist automatically in ${mode} mode`, async () => {
		const h = setup({ mode });
		await h.run("Fix the tests.");
		await h.update(tasks);
		assert.equal(await h.boundary([assistant(`Verified the result.\r\n${DONE}\n`)]), undefined);
		assert.equal(existsSync(h.current), false);
		assert.equal(h.archived().length, 1);
		assert.deepEqual(h.archive(), { instruction: "Fix the tests.", status: "done", round: 1, tasks: completedTasks });
		assert.equal(h.notifications.at(-1)!.message, "Goal reached and archived. 2/2 tasks done: Fix the tests.");
		assert.deepEqual(h.render(), []);
		await h.emit("agent_settled");
		assert.equal(await h.boundary(), undefined);
		assert.equal(h.archived().length, 1);
		assert.equal(h.aborts(), 0);
		await assert.rejects(h.update(tasks), /No running goal/);

		const next = setup({ cwd: h.cwd, sessionId: h.sessionId, mode });
		await next.emit("session_start");
		for (const instance of [h, next]) assert.deepEqual(instance.render(), []);
		assert.equal(next.sent.length, 0);
		await next.command("goal-status");
		assert.match(next.notifications.at(-1)!.message, /Goal \(done, archived, round 1, 2\/2 tasks done\)/);
		assert.deepEqual(next.render(), []);
		await next.command("goal-resume");
		assert.match(next.notifications.at(-1)!.message, /No active goal/);
		assert.equal(next.sent.length, 0);
		assert.equal(next.archived().length, 1);
		assert.equal(existsSync(next.current), false);
		await next.run("Next goal.");
		assert.equal(next.state().instruction, "Next goal.");
		assert.equal(next.archived().length, 1, "starting another goal must retain history");
	});
}

for (const mode of ["tui", "rpc"]) {
	test(`completed goals stay hidden while stopped archives remain visible in ${mode} mode`, async (t) => {
		// These represent separate runs; avoid random archive ordering within one clock tick.
		let now = Date.now();
		t.mock.method(Date, "now", () => now++);
		const h = setup({ mode });
		await h.run("First goal.");
		await h.boundary([assistant(DONE)]);
		await h.emit("agent_settled");
		assert.deepEqual(h.render(), []);
		const firstFile = h.archived()[0];
		const first = readFileSync(join(h.archiveDir, firstFile), "utf8");
		await h.run("Second goal.");
		assert.match(h.render().join("\n"), /goal · running/);
		assert.ok(!/First goal|review|archived/.test(h.render().join("\n")));
		await h.update(tasks);
		await h.command("goal-stop");
		assert.equal(existsSync(h.current), false);
		assert.equal(h.notifications.at(-1)!.message, "Goal stopped and archived.");
		assert.match(h.render().join("\n"), /stopped · archived · 1\/2 tasks done/);

		const next = setup({ cwd: h.cwd, sessionId: h.sessionId, mode });
		await next.emit("session_start");
		assert.match(next.render().join("\n"), /stopped · archived · 1\/2 tasks done/);
		assert.match(next.render().join("\n"), /Second goal/);
		assert.match(next.render().join("\n"), /· Run full suite/);
		assert.ok(!/review|confirm/.test(next.render().join("\n")));
		assert.equal(next.archived().length, 2);
		assert.equal(readFileSync(join(next.archiveDir, firstFile), "utf8"), first);
	});
}

test("blocked goals retain their checklist and can resume after reopening their session", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.update(tasks);
	await h.boundary([assistant(`Need permission.\n${BLOCKED}`)]);
	await h.emit("agent_settled");
	assert.equal(h.state().status, "blocked");
	assert.equal(h.archived().length, 0);
	assert.match(h.render().join("\n"), /blocked/);
	const next = setup({ cwd: h.cwd, sessionId: h.sessionId });
	await next.emit("session_start");
	assert.equal(await next.boundary(), undefined);
	await next.command("goal-resume");
	assert.equal(next.state().status, "running");
	assert.equal(next.sent.length, 1);
	assert.ok(next.sent[0].includes(JSON.stringify(tasks)));
	assert.match(next.sent[0], /Check the workspace/);
});

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

test("/goal-pause saves progress without archiving and can resume after reopening the session", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.update(tasks);
	await h.boundary();
	const before = h.state();
	h.busy();
	h.queue();
	await h.command("goal-pause");
	assert.equal(h.aborts(), 1);
	assert.deepEqual(h.state(), { ...before, status: "paused" });
	assert.deepEqual(h.archived(), []);
	assert.equal(await h.boundary([assistant(DONE)]), undefined);
	assert.match(h.render().join("\n"), /paused/);
	assert.match(h.notifications.at(-1)!.message, /Goal paused.*\/goal-resume/);
	await h.emit("agent_settled");
	await h.command("goal-pause");
	assert.equal(h.aborts(), 1);
	assert.equal(h.sent.length, 1);
	const next = setup({ cwd: h.cwd, sessionId: h.sessionId });
	await next.emit("session_start");
	await next.command("goal-resume");
	assert.deepEqual(next.state(), before);
	assert.ok(next.sent[0].includes(JSON.stringify(tasks)));
});

test("/goal-resume enables paused and blocked goals while busy without interrupting or queuing work", async () => {
	for (const status of ["paused", "blocked"]) {
		for (const state of ["busy", "queue", "settling"] as const) {
			const h = setup();
			await h.run("Fix the tests.");
			await h.update(tasks);
			if (status === "blocked") await h.boundary([assistant(BLOCKED)]);
			await h.emit("agent_settled");
			const before = h.state();
			assert.equal(before.status, status);
			if (state === "settling") await h.emit("agent_start");
			else h[state]();
			h.registry.getApiKeyAndHeaders = async () => assert.fail("Resuming busy work must not authenticate again.");
			h.notifications.length = 0;

			await h.command("goal-resume");
			await h.command("goal-resume");
			assert.deepEqual(h.state(), { ...before, status: "running" });
			assert.match(h.render().join("\n"), /goal · running/);
			assert.equal(h.sent.length, 1);
			assert.equal(h.aborts(), 0);
			assert.deepEqual(h.notifications, []);
			await h.update(tasks);
			if (state === "queue") {
				assert.equal(await h.boundary([assistant(DONE)]), undefined);
				assert.deepEqual(h.archived(), []);
				h.queue(false);
			}
			const result = await h.boundary();
			assert.equal(result.continue, true);
			assert.ok(result.entries[0].content.includes(JSON.stringify(tasks)));
			assert.equal(h.state().round, before.round + 1);
			await h.boundary([assistant(DONE)]);
			assert.equal(h.archive().status, "done");
		}
	}
});

test("/goal-resume is a no-op for a running goal", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	const before = h.state();
	await h.command("goal-resume");
	assert.deepEqual(h.state(), before);
	assert.equal(h.sent.length, 1);
	assert.equal(h.aborts(), 0);
	assert.deepEqual(h.notifications, []);
	assert.equal((await h.boundary()).continue, true);
});

test("/goal-resume while busy never revives missing or archived goals", async () => {
	for (const status of ["none", "done", "stopped"]) {
		const h = setup();
		if (status !== "none") {
			await h.run("Fix the tests.");
			if (status === "done") await h.boundary([assistant(DONE)]);
			else await h.command("goal-stop");
			await h.emit("agent_settled");
		}
		const sent = h.sent.length;
		const archives = h.archived();
		const aborts = h.aborts();
		h.busy();
		await h.command("goal-resume");
		assert.match(h.notifications.at(-1)!.message, /No active goal/);
		assert.equal(h.sent.length, sent);
		assert.equal(h.aborts(), aborts);
		assert.deepEqual(h.archived(), archives);
		assert.equal(existsSync(h.current), false);
	}
});

test("errors and cancellation still pause a goal resumed during work", async () => {
	for (const outcome of ["aborted", "error", "settled"] as const) {
		const h = setup();
		await h.run("Fix the tests.");
		await h.emit("agent_settled");
		h.busy();
		await h.command("goal-resume");
		assert.equal(h.state().status, "running");
		if (outcome === "settled") await h.emit("agent_settled");
		else assert.equal(await h.boundary([assistant(DONE)], { outcome }), undefined);
		assert.equal(h.state().status, "paused");
		assert.equal(await h.boundary(), undefined);
		assert.equal(h.sent.length, 1);
		assert.deepEqual(h.archived(), []);
	}
});

test("a failed busy resume stays paused without interrupting current work", async (t) => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.emit("agent_settled");
	h.busy();
	const rename = fs.renameSync;
	let attempts = 0;
	t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
		if (++attempts === 1) throw new Error("Resume save failed");
		return rename(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	await h.command("goal-resume");
	assert.equal(h.state().status, "paused");
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.sent.length, 1);
	assert.equal(h.aborts(), 0);
	assert.equal(h.notifications.at(-1)!.level, "error");
	assert.match(h.notifications.at(-1)!.message, /Resume save failed/);
});

test("/goal-pause never aborts unrelated work or changes a paused or ended goal", async () => {
	for (const status of ["none", "paused", "done"]) {
		const h = setup();
		if (status !== "none") {
			await h.run("Fix the tests.");
			if (status === "paused") await h.emit("agent_settled");
			else await h.boundary([assistant(status === "done" ? DONE : BLOCKED)]);
		}
		const before = existsSync(h.current) ? h.state() : undefined;
		const archives = h.archived();
		h.busy();
		await h.command("goal-pause");
		assert.equal(h.aborts(), 0);
		assert.deepEqual(existsSync(h.current) ? h.state() : undefined, before);
		assert.deepEqual(h.archived(), archives);
		assert.match(h.notifications.at(-1)!.message, /No running goal/);
	}
});

test("/goal-pause still aborts on a save failure without claiming progress was saved", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	rmSync(h.current);
	mkdirSync(h.current);
	await h.command("goal-pause");
	assert.equal(h.aborts(), 1);
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.notifications.at(-1)!.level, "error");
	assert.deepEqual(h.archived(), []);
	assert.match(h.render().join("\n"), /paused/);
});

test("/goal-stop archives before aborting and never aborts unrelated work", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.command("goal-stop");
	assert.equal(h.aborts(), 1);
	assert.equal(await h.boundary(), undefined);
	await h.emit("agent_settled");
	await h.command("goal-stop");
	assert.equal(h.aborts(), 1);
	assert.equal(h.archive().status, "stopped");
	assert.equal(existsSync(h.current), false);
	await h.run("Try again.");
	assert.equal(h.sent.length, 2);
	assert.equal(h.archived().length, 1);
});

for (const outcome of ["aborted", "error"] as const) {
	test(`pauses on ${outcome} even if the response contains the completion marker`, async () => {
		const h = setup();
		await h.run("Fix the tests.");
		assert.equal(await h.boundary([assistant(DONE)], { outcome }), undefined);
		assert.equal(h.state().status, "paused");
		assert.equal(await h.boundary(), undefined);
		assert.equal(h.archived().length, 0);
	});
}

test("Escape pauses even when Pi skips agent_before_settle", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.emit("agent_settled");
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.state().status, "paused");
	assert.match(h.render().join("\n"), /paused/);
	assert.match(h.render().join("\n"), /\/goal-resume/);
	await h.command("goal-resume");
	assert.equal(h.sent.length, 2);
});

for (const action of ["done", "stop", "pause"]) {
	test(`waits for settlement after ${action} before starting another goal run`, async () => {
		const h = setup();
		await h.run("First goal.");
		if (action === "done") await h.boundary([assistant(DONE)]);
		else await h.command(`goal-${action}`);
		// Pi becomes idle before dispatching agent_settled; an earlier handler can yield.
		const restart = () => action === "pause" ? h.command("goal-resume") : h.run("Second goal.");
		await restart();
		assert.equal(h.sent.length, 1);
		await h.emit("agent_settled");
		await restart();
		assert.equal(h.sent.length, 2);
		assert.equal(h.state().status, "running");
		assert.equal((await h.boundary()).continue, true);
	});
}

test("an aborted operation cannot request a continuation", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	h.ctx.signal = AbortSignal.abort();
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.state().status, "paused");
});

for (const event of ["session_start", "session_tree", "session_shutdown"]) {
	test(`${event} saves and pauses without starting or aborting work`, async () => {
		const h = setup();
		await h.run("Fix the tests.");
		await h.update(tasks);
		await h.emit(event);
		await h.emit(event);
		assert.equal(await h.boundary(), undefined);
		assert.equal(h.state().status, "paused");
		assert.deepEqual(h.state().tasks, tasks);
		assert.equal(h.aborts(), 0);
		assert.equal(h.sent.length, 1);
	});
}

test("a process restart restores running goals paused, never resumes automatically", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.update(tasks);
	await h.boundary();
	const next = setup({ cwd: h.cwd, sessionId: h.sessionId });
	await next.emit("session_start");
	assert.equal(next.sent.length, 0);
	assert.match(next.render().join("\n"), /paused/);
	assert.equal(next.state().status, "paused");
	await next.command("goal-resume");
	assert.equal(next.state().round, 2);
	assert.deepEqual(next.state().tasks, tasks);
	assert.equal(next.sent.length, 1);
});

test("does not compete with another continuation or queued user work", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	assert.equal(await h.boundary(undefined, { continue: true }), undefined);
	h.queue();
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.state().round, 1);
});

test("queued input is considered before continuing, completing or blocking a goal", async () => {
	for (const source of ["queue", "boundary"] as const) {
		for (const reply of ["More work remains.", DONE, BLOCKED]) {
			const h = setup();
			await h.run("Fix the tests.");
			await h.update(tasks);
			const before = h.state();
			if (source === "queue") h.queue();
			const result = await h.boundary([assistant(reply)], source === "boundary" ? {
				context: {
					contextEntries: [], contextMessages: [assistant(reply)] as any, llmMessages: [],
					pendingMessages: [{ role: "user", content: "Also check the integration tests.", timestamp: Date.now() }],
					canContinue: true,
				},
			} : {});
			assert.equal(result, undefined, "let Pi deliver the queued input without a competing reminder");
			assert.deepEqual(h.state(), before);
			assert.deepEqual(h.archived(), []);
			assert.equal(h.sent.length, 1);
			assert.equal(h.aborts(), 0);
			h.queue(false);
			assert.equal((await h.boundary([assistant("Checking the integration tests next.")])).continue, true);
			assert.equal(h.state().status, "running");
			await h.boundary([assistant(`All checks passed.\n${DONE}`)]);
			assert.equal(h.archive().status, "done");
		}
	}
});

test("refuses to replace running or paused goals, or start while busy", async () => {
	const h = setup();
	await h.run("First goal.");
	await h.run("Second goal.");
	await h.emit("agent_settled");
	await h.run("Third goal.");
	assert.equal(h.state().instruction, "First goal.");
	assert.equal(h.sent.length, 1);
	for (const state of ["busy", "queue"] as const) {
		const busy = setup();
		busy[state]();
		await busy.run("Fix the tests.");
		assert.equal(busy.sent.length, 0);
		assert.equal(existsSync(busy.current), false);
	}
});

test("missing model or failed authentication leaves the goal paused and resumable", async () => {
	const noModel = setup();
	noModel.ctx.model = undefined;
	await noModel.run("Fix the tests.");
	assert.equal(noModel.sent.length, 0);
	assert.equal(noModel.state().status, "paused");
	for (const throws of [false, true]) {
		const h = setup();
		h.registry.getApiKeyAndHeaders = async () => {
			if (throws) throw new Error("Authentication failed");
			return { ok: false, error: "Authentication failed" };
		};
		await h.run("Fix the tests.");
		assert.equal(h.sent.length, 0);
		assert.equal(await h.boundary(), undefined);
		assert.equal(h.state().status, "paused");
		assert.match(h.notifications.at(-1)!.message, /Authentication failed/);
	}
});

test("cancellation or session changes during authentication cannot send a stale goal", async () => {
	for (const cancel of ["pause", "stop", "session_start", "session_tree", "session_shutdown"]) {
		const h = setup();
		let resolve!: (value: any) => void;
		h.registry.getApiKeyAndHeaders = () => new Promise((done) => { resolve = done; });
		const starting = h.run("Fix the tests.");
		if (cancel === "pause" || cancel === "stop") await h.command(`goal-${cancel}`);
		else await h.emit(cancel);
		resolve({ ok: true });
		await starting;
		assert.equal(h.sent.length, 0);
		assert.equal(await h.boundary(), undefined);
		if (cancel === "pause") {
			assert.equal(h.state().status, "paused");
			assert.equal(h.aborts(), 0);
		}
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
	assert.equal(h.state().status, "paused");
});

test("rechecks idle state after authentication", async () => {
	const h = setup();
	h.registry.getApiKeyAndHeaders = async () => { h.busy(); return { ok: true }; };
	await h.run("Fix the tests.");
	assert.equal(h.sent.length, 0);
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.state().status, "paused");
});

test("send failures pause the goal", async () => {
	const h = setup();
	h.api.sendUserMessage = () => { throw new Error("Could not send"); };
	await h.run("Fix the tests.");
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.state().status, "paused");
	assert.match(h.notifications.at(-1)!.message, /Could not send/);
});

test("invalid saved state is reported and never overwritten", async () => {
	for (const value of ["{broken", "null", '{"instruction":"hello"}', JSON.stringify({
		instruction: "Invalid destination", status: "done", round: 1, tasks: [], archiveId: "../escape",
	})]) {
		const h = setup();
		mkdirSync(h.directory, { recursive: true });
		writeFileSync(h.current, value);
		await h.emit("session_start");
		await h.run("New goal.");
		assert.equal(h.sent.length, 0);
		assert.equal(readFileSync(h.current, "utf8"), value);
		assert.equal(h.notifications.at(-1)!.level, "error");
	}
});

for (const status of ["done", "stopped"]) {
	test(`a failed ${status} archive retains saved work and retries without restarting it`, async () => {
		const h = setup();
		await h.run("Fix the tests.");
		await h.update(tasks);
		// Make the archive destination unwritable without depending on chmod or user privileges.
		mkdirSync(dirname(h.archiveDir), { recursive: true, mode: 0o700 });
		writeFileSync(h.archiveDir, "not a directory");
		if (status === "done") await h.boundary([assistant(DONE)]);
		else await h.command("goal-stop");
		assert.equal(await h.boundary(), undefined);
		const expected = { instruction: "Fix the tests.", status, round: 1, tasks: status === "done" ? completedTasks : tasks };
		const { archiveId, ...pending } = h.state();
		assert.deepEqual(pending, expected);
		assert.equal(h.notifications.at(-1)!.level, "error");
		assert.ok(!h.notifications.some(({ message }) => /Goal reached and archived|Goal stopped and archived/.test(message)));
		assert.match(h.render().join("\n"), /archive pending/);
		await h.emit("agent_settled");
		rmSync(h.archiveDir);
		await h.command("goal-status");
		assert.equal(existsSync(h.current), false);
		assert.deepEqual(h.archived(), [`${archiveId}.json`]);
		assert.deepEqual(h.archive(), expected);
		if (status === "done") assert.deepEqual(h.render(), []);
		else assert.match(h.render().join("\n"), /stopped · archived/);
		assert.equal(h.sent.length, 1);
	});
}

test("a restart recovers an ended current goal without review or re-running work", async () => {
	for (const status of ["done", "stopped"]) {
		const h = setup();
		mkdirSync(h.directory, { recursive: true });
		writeFileSync(h.current, JSON.stringify({ instruction: "Old goal.", status, round: 3, tasks }));
		await h.emit("session_start");
		assert.equal(existsSync(h.current), false);
		assert.deepEqual(h.archive(), { instruction: "Old goal.", status, round: 3, tasks: status === "done" ? completedTasks : tasks });
		assert.equal(h.sent.length, 0);
		await h.command("goal-resume");
		assert.equal(h.sent.length, 0);
		assert.equal(h.archived().length, 1);
	}
});

test("a transient save failure persists the paused state and reports one error", async (t) => {
	const h = setup();
	await h.run("Fix the tests.");
	const rename = fs.renameSync;
	let attempts = 0;
	t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
		if (++attempts === 1) throw new Error("Temporary save failure");
		return rename(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	await assert.rejects(h.update(tasks), /Temporary save failure/);
	assert.equal(h.state().status, "paused");
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.notifications.filter(({ level }) => level === "error").length, 1);
	assert.match(h.notifications.at(-1)!.message, /Temporary save failure/);
});

test("a persistent start save failure reports only the original error", async (t) => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.command("goal-pause");
	await h.emit("agent_settled");
	let attempts = 0;
	t.mock.method(fs, "renameSync", () => { throw new Error(`Save failure ${++attempts}`); });
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	await h.command("goal-resume");
	assert.equal(h.sent.length, 1);
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.state().status, "paused");
	assert.equal(attempts, 2);
	assert.deepEqual(h.notifications.filter(({ level }) => level === "error").map(({ message }) => message), [
		"Goal paused; check saved state. Save failure 1",
	]);
});

test("a failed progress save pauses without replacing the last valid state", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	const before = readFileSync(h.current, "utf8");
	rmSync(h.current);
	mkdirSync(h.current);
	writeFileSync(join(h.current, "saved.json"), before);
	await assert.rejects(h.update(tasks));
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.notifications.at(-1)!.level, "error");
	assert.equal(readFileSync(join(h.current, "saved.json"), "utf8"), before);
	assert.deepEqual(readdirSync(h.directory), ["current.json"]);
});

test("queued progress cannot recreate a stopped goal or modify a replacement", async () => {
	const h = setup();
	await h.run("First goal.");
	const updating = assert.rejects(h.update(tasks), /No running goal/);
	await h.command("goal-stop");
	await h.emit("agent_settled");
	await h.run("Second goal.");
	await updating;
	assert.deepEqual(h.state().tasks, []);
	assert.equal(h.state().instruction, "Second goal.");
	assert.deepEqual(h.archive().tasks, []);
});

test("malformed archives are reported and preserved without blocking valid goals", async () => {
	const h = setup();
	mkdirSync(h.archiveDir, { recursive: true, mode: 0o700 });
	const file = join(h.archiveDir, "broken.json");
	writeFileSync(file, "broken");
	await h.run("Fix the tests.");
	assert.equal(h.sent.length, 1);
	assert.equal(readFileSync(file, "utf8"), "broken");
	assert.equal(h.notifications[0].level, "warning");
});

test("old session archives remain readable; new goals stay out of the workspace archive", async () => {
	const h = setup();
	const legacyDir = join(h.directory, "archive");
	mkdirSync(legacyDir, { recursive: true });
	const old = JSON.stringify({ instruction: "Local history.", status: "stopped", round: 1, tasks });
	writeFileSync(join(legacyDir, "old.json"), old);
	await h.command("goal-status");
	assert.match(h.notifications.at(-1)!.message, /stopped, archived.*Local history/);
	await h.run("New history.");
	await h.command("goal-stop");
	assert.equal(h.archive().instruction, "New history.");
	await h.command("goal-status");
	assert.match(h.notifications.at(-1)!.message, /stopped, archived.*New history/);
	assert.deepEqual(readdirSync(legacyDir), ["old.json"]);
	assert.equal(readFileSync(join(legacyDir, "old.json"), "utf8"), old);

	const other = setup({ sessionId: h.sessionId });
	await other.command("goal-status");
	assert.match(other.notifications.at(-1)!.message, /No active goal/);
});

test("a non-private archive root is refused without losing the goal", { skip: !process.geteuid }, async (t) => {
	const h = setup();
	await h.run("Keep this private.");
	const unsafe = fs.statSync(h.directory);
	unsafe.mode |= 0o077;
	const lstat = fs.lstatSync;
	t.mock.method(fs, "lstatSync", (...args: Parameters<typeof lstat>) => args[0] === archiveRoot ? unsafe : lstat(...args));
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	await h.command("goal-stop");
	assert.match(h.notifications.at(-1)!.message, /Expected a private goal archive directory/);
	assert.equal(h.state().status, "stopped");
	assert.equal(existsSync(h.archiveDir), false);
});

test("archiving across filesystems retries an interrupted source removal without duplicating history", async (t) => {
	const h = setup();
	await h.run("Move this goal.");
	const rename = fs.renameSync;
	t.mock.method(fs, "renameSync", (from: string, to: string) => {
		if (dirname(from) !== dirname(to)) throw Object.assign(new Error("Cross-device rename"), { code: "EXDEV" });
		rename(from, to);
	});
	const remove = fs.rmSync;
	t.mock.method(fs, "rmSync", (...args: Parameters<typeof remove>) => {
		if (args[0] === h.current) throw new Error("Source removal failed");
		remove(...args);
	});
	syncBuiltinESMExports();
	const restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
	t.after(restore);
	await h.command("goal-stop");
	assert.match(h.notifications.at(-1)!.message, /Source removal failed/);
	assert.equal(h.state().status, "stopped");
	const files = h.archived();
	assert.equal(files.length, 1);
	restore();
	const next = setup({ cwd: h.cwd, sessionId: h.sessionId });
	await next.emit("session_start");
	assert.deepEqual(next.archived(), files);
	assert.equal(next.archive().instruction, "Move this goal.");
	assert.deepEqual(readdirSync(h.directory), []);
	assert.equal(next.sent.length, 0);
});

test("different sessions run independent goals in the same directory", async () => {
	const first = setup();
	await first.run("First session's goal.");
	await first.update(tasks);
	const before = first.state();
	const second = setup({ cwd: first.cwd });
	await second.emit("session_start");
	await second.command("goal-resume");
	assert.deepEqual(first.state(), before, "opening another session must not pause the first");
	assert.deepEqual(second.render(), []);
	assert.equal(second.sent.length, 0);
	await second.run("Second session's goal.");
	await Promise.all([first.update(tasks), second.update([{ text: "Other task", done: false }])]);
	assert.equal((await first.boundary()).continue, true);
	assert.equal((await second.boundary()).continue, true);
	assert.deepEqual(first.state().tasks, tasks);
	assert.deepEqual(second.state().tasks, [{ text: "Other task", done: false }]);
	await first.command("goal-pause");
	assert.equal(second.state().status, "running");
	await second.command("goal-stop");
	assert.equal(first.state().status, "paused");
	assert.deepEqual(first.archived(), []);
	assert.equal(second.archive().instruction, "Second session's goal.");
	await second.emit("session_shutdown");
	await first.emit("agent_settled");
	await first.command("goal-resume");
	await first.boundary([assistant(DONE)]);
	assert.equal(first.archive().instruction, "First session's goal.");
	const third = setup({ cwd: first.cwd });
	await third.emit("session_start");
	await third.command("goal-status");
	assert.match(third.notifications.at(-1)!.message, /No active goal/);
	assert.deepEqual(third.render(), []);
});

test("custom session IDs cannot escape their goal directory or collide when encoded", async () => {
	const first = setup({ sessionId: "../other/session" });
	const second = setup({ cwd: first.cwd, sessionId: "..%2Fother%2Fsession" });
	await first.run("First goal.");
	await second.run("Second goal.");
	assert.equal(first.state().instruction, "First goal.");
	assert.equal(second.state().instruction, "Second goal.");
	assert.deepEqual(readdirSync(join(first.cwd, ".pi", "goals")), ["sessions"]);
});

test("legacy shared goals are adopted only by an explicit resume and only once", async () => {
	const first = setup();
	const second = setup({ cwd: first.cwd });
	const root = join(first.cwd, ".pi", "goals");
	const legacy = join(root, "current.json");
	mkdirSync(join(root, "archive"), { recursive: true });
	const oldArchive = join(root, "archive", "old.json");
	const saved = { instruction: "Legacy goal.", status: "blocked", round: 3, tasks };
	writeFileSync(legacy, JSON.stringify(saved));
	writeFileSync(oldArchive, JSON.stringify({ ...saved, status: "done" }));
	await first.emit("session_start");
	await second.emit("session_start");
	assert.deepEqual(first.render(), []);
	assert.deepEqual(second.render(), []);
	assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")), saved);
	await Promise.all([first.command("goal-resume"), second.command("goal-resume")]);
	assert.equal(existsSync(legacy), false);
	assert.deepEqual(first.state(), { ...saved, status: "running" });
	assert.equal(first.sent.length, 1);
	assert.equal(second.sent.length, 0);
	assert.equal(existsSync(second.current), false);
	await second.run("An independent new goal.");
	assert.equal(second.state().instruction, "An independent new goal.");
	assert.equal(JSON.parse(readFileSync(oldArchive, "utf8")).status, "done");
});

test("starting a new goal leaves legacy state intact and malformed legacy goals cannot be adopted", async () => {
	const h = setup();
	const legacy = join(h.cwd, ".pi", "goals", "current.json");
	mkdirSync(join(h.cwd, ".pi", "goals"), { recursive: true });
	writeFileSync(legacy, "{broken");
	await h.command("goal-resume");
	assert.equal(h.notifications.at(-1)!.level, "error");
	assert.equal(existsSync(h.current), false);
	await h.run("New session goal.");
	assert.equal(h.state().instruction, "New session goal.");
	assert.equal(readFileSync(legacy, "utf8"), "{broken");
});

test("human replies unfreeze blocked goals without another prompt or resume command", async () => {
	for (const source of ["interactive", "rpc"]) {
		const h = setup({ mode: source === "rpc" ? "rpc" : "tui" });
		await h.run("Fix the tests.");
		await h.update(tasks);
		await h.boundary([assistant(`Which tests?\n${BLOCKED}`)]);
		await h.emit("agent_settled");
		assert.match(h.render().join("\n"), /Reply to continue/);
		assert.match(h.notifications.at(-1)!.message, /Reply.*resume/i);
		const next = setup({ cwd: h.cwd, sessionId: h.sessionId, mode: h.ctx.mode });
		await next.emit("session_start");
		assert.equal(next.state().status, "blocked");
		const result = await next.reply("Check the integration tests too.", source);
		assert.equal(next.state().status, "running");
		assert.match(result.message.content, /Fix the tests/);
		assert.ok(result.message.content.includes(JSON.stringify(tasks)));
		assert.match(result.message.content, /newer user instructions/);
		assert.equal(result.message.display, false);
		assert.equal(next.sent.length, 0, "the user's reply is already starting work");
		assert.equal(next.aborts(), 0);
		await next.update(tasks);
		assert.equal((await next.boundary()).continue, true);
		await next.boundary([assistant(BLOCKED)]);
		await next.emit("agent_settled");
		await next.reply("Here is the remaining answer.", source);
		await next.boundary([assistant(DONE)]);
		assert.deepEqual(next.archive().tasks, completedTasks);
	}
});

test("extension prompts and empty input do not unfreeze blocked goals; image replies do", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.boundary([assistant(BLOCKED)]);
	await h.emit("agent_settled");
	for (const [text, source] of [["Scheduled work", "extension"], ["  ", "interactive"]]) {
		assert.equal(await h.reply(text, source), undefined);
		assert.equal(h.state().status, "blocked");
		assert.equal(await h.boundary([assistant(DONE)]), undefined);
		await h.emit("agent_settled");
	}
	await h.reply("", "interactive", [{ type: "image", data: "test", mimeType: "image/png" }]);
	assert.equal(h.state().status, "running");
	assert.equal((await h.boundary()).continue, true);
});

test("blocked goals resume only when the reply starts a run", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.boundary([assistant(BLOCKED)]);
	await h.emit("agent_settled");
	await h.emit("input", { text: "A reply handled by another extension", source: "interactive" });
	assert.equal(h.state().status, "blocked");
	assert.equal(await h.emit("before_agent_start", { messageType: "custom", message: {} }), undefined);
	assert.equal(h.state().status, "blocked");
	await h.reply("An unrelated extension prompt", "extension");
	assert.equal(h.state().status, "blocked");
});

test("manual pause overrides a blocker and replies never restart paused, stopped or completed goals", async () => {
	for (const action of ["goal-pause", "goal-stop", "done", "escape"]) {
		const h = setup();
		await h.run("Fix the tests.");
		await h.update(tasks);
		if (action === "done") await h.boundary([assistant(DONE)]);
		else if (action !== "escape") await h.boundary([assistant(BLOCKED)]);
		await h.emit("agent_settled");
		if (action.startsWith("goal-")) await h.command(action);
		const state = existsSync(h.current) ? h.state() : undefined;
		if (state) assert.equal(state.status, "paused");
		assert.equal(h.aborts(), 0, "pausing a blocker must not abort unrelated work");
		assert.equal(await h.reply(), undefined);
		assert.equal(await h.boundary([assistant(DONE)]), undefined);
		assert.deepEqual(existsSync(h.current) ? h.state() : undefined, state);
		assert.equal(h.sent.length, 1);
		await h.emit("agent_settled");
		if (state) {
			await h.command("goal-resume");
			assert.equal(h.state().status, "running");
		}
	}
});

test("cancellation and errors still pause automatically resumed goals", async () => {
	for (const outcome of ["aborted", "error"] as const) {
		const h = setup();
		await h.run("Fix the tests.");
		await h.boundary([assistant(BLOCKED)]);
		await h.emit("agent_settled");
		await h.reply();
		assert.equal(await h.boundary([assistant(DONE)], { outcome }), undefined);
		await h.emit("agent_settled");
		assert.equal(h.state().status, "paused");
		assert.equal(await h.reply(), undefined);
		assert.equal(await h.boundary(), undefined);
		assert.deepEqual(h.archived(), []);
	}
});

test("a failed automatic resume pauses safely without queuing work", async (t) => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.boundary([assistant(BLOCKED)]);
	await h.emit("agent_settled");
	const rename = fs.renameSync;
	let attempts = 0;
	t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
		if (++attempts === 1) throw new Error("Automatic resume save failed");
		return rename(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	assert.equal(await h.reply(), undefined);
	assert.equal(h.state().status, "paused");
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.sent.length, 1);
	assert.match(h.notifications.at(-1)!.message, /Automatic resume save failed/);
});

test("saved goals stay isolated to their project directory", async () => {
	const first = setup();
	const second = setup();
	await first.run("First project's goal.");
	await second.emit("session_start");
	assert.deepEqual(second.render(), []);
	await second.run("Second project's goal.");
	assert.equal(first.state().instruction, "First project's goal.");
	assert.equal(second.state().instruction, "Second project's goal.");
});

test("the box fits narrow widths, multiline objectives, Unicode and theme changes", async () => {
	const h = setup();
	await h.run("Fix 界 👩‍💻 é\nthen verify\twithout \x1b[31mcontrol codes");
	await h.update([{ text: "Check 界 👩‍💻 é\nthen verify\twithout \x1b[31mcontrol codes", done: false }]);
	assert.match(h.render().join("\n"), /· Check 界 👩‍💻 é then verify without control codes/);
	for (const width of [0, 1, 2, 3, 4, 5, 10, 40, 100]) {
		for (const line of h.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
			assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(stripVTControlCharacters(line)));
		}
	}
	const widget = h.widgets.get("goal");
	let changed = false;
	const component = widget({}, { fg: (_color: string, text: string) => changed ? text.toUpperCase() : text });
	assert.match(component.render(100).join("\n"), /goal/);
	changed = true;
	component.invalidate();
	assert.match(component.render(100).join("\n"), /GOAL/);
});

for (const mode of ["rpc", "json"]) {
	test(`loop behavior works in ${mode} mode without terminal components`, async () => {
		const h = setup({ mode });
		await h.run("Fix the tests.");
		await h.update(tasks);
		assert.equal((await h.boundary()).continue, true);
		await h.boundary([assistant(DONE)]);
		assert.equal(await h.boundary(), undefined);
		assert.equal(h.archive().status, "done");
		if (mode === "rpc") assert.equal(h.widgets.get("goal"), undefined);
		else assert.equal(h.widgets.size, 0);
	});
}
