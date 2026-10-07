import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type {
	AgentBeforeSettleEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import goal from "../extensions/goal.ts";

const DONE = "<goal>done</goal>";
const BLOCKED = "<goal>blocked</goal>";
const directories: string[] = [];
after(() => directories.forEach((cwd) => rmSync(cwd, { recursive: true, force: true })));

const assistant = (text: string, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason,
});

const setup = (options: { cwd?: string; mode?: string; bus?: EventEmitter; factory?: typeof goal } = {}) => {
	const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "pi-goal-test-"));
	if (!options.cwd) directories.push(cwd);
	const mode = options.mode ?? "tui";
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const tools = new Map<string, any>();
	const sent: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const widgets = new Map<string, any>();
	const selections: Array<number | undefined> = [];
	const dialogs: Array<{ title: string; options: string[] }> = [];
	let idle = true;
	let pending = false;
	let aborts = 0;
	const registry = { getApiKeyAndHeaders: async (): Promise<any> => ({ ok: true, apiKey: "test" }) };
	const ctx = {
		cwd, mode,
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
			select: async (title: string, options: string[]) => {
				dialogs.push({ title, options });
				const index = selections.shift();
				return index === undefined ? undefined : options[index];
			},
		},
	} as unknown as ExtensionCommandContext;
	const api = {
		events: options.bus ?? new EventEmitter(),
		on: (event: string, handler: (event: any, ctx: ExtensionContext) => any) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
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
	const directory = join(cwd, ".pi", "goals");
	const current = join(directory, "current.json");
	const archiveDir = join(directory, "archive");
	const archived = () => existsSync(archiveDir) ? readdirSync(archiveDir).filter((name) => name.endsWith(".json")).sort() : [];
	const render = (width = 100, theme = { fg: (_color: string, text: string) => text }): string[] => {
		const widget = widgets.get("goal");
		return typeof widget === "function" ? widget({}, theme).render(width) : widget ?? [];
	};
	return {
		ctx, api, registry, handlers, commands, tools, sent, notifications, widgets, selections, dialogs, emit, boundary,
		cwd, directory, current, archiveDir, archived, render,
		state: () => JSON.parse(readFileSync(current, "utf8")),
		archive: (index = 0) => JSON.parse(readFileSync(join(archiveDir, archived()[index]), "utf8")),
		run: (args: string) => commands.get("goal")!.handler(args, ctx),
		command: (name: string) => commands.get(name)!.handler("", ctx),
		update: (tasks: Array<{ text: string; done: boolean }>, signal?: AbortSignal) =>
			tools.get("goal_progress").execute("id", { tasks }, signal, undefined, ctx),
		busy: () => { idle = false; },
		queue: () => { pending = true; },
		aborts: () => aborts,
	};
};

const tasks = [{ text: "Fix tests", done: true }, { text: "Run full suite", done: false }];

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
		await first.emit("session_start");
		await first.run("Fix the tests.");
		await first.update(tasks);
		assert.equal((await first.boundary()).entries.length, 1);
		assert.deepEqual(first.state().tasks, tasks);
		await first.emit("session_shutdown");
		assert.equal(setup({ bus }).tools.size, 0, "session changes must retain the claim");
		// Pi removes runtime subscriptions on /reload, but keeps the shared bus.
		bus.removeAllListeners();
		const reloaded = setup({ bus, cwd: first.cwd, factory: factories[1] });
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
	assert.equal(next.commands.size, 6);
	assert.deepEqual([...next.tools.keys()], ["goal_progress"]);
});

test("does nothing and creates no files without an explicit goal", async () => {
	const h = setup();
	assert.deepEqual([...h.commands.keys()], ["goal", "goal-status", "goal-pause", "goal-resume", "goal-stop", "goal-review"]);
	assert.deepEqual([...h.tools.keys()], ["goal_progress"]);
	await h.emit("session_start");
	assert.equal(await h.boundary(), undefined);
	await h.emit("agent_settled");
	await h.run("  ");
	assert.match(h.notifications.at(-1)!.message, /Usage: \/goal <objective>.*\/goal-status/);
	await h.command("goal-status");
	assert.match(h.notifications.at(-1)!.message, /No active goal/);
	for (const name of ["goal-pause", "goal-resume", "goal-stop", "goal-review"]) await h.command(name);
	assert.equal(h.sent.length, 0);
	assert.equal(existsSync(h.directory), false);
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

test("checklist rows stay compact, update their markers and survive pause and archive reloads", async () => {
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
		const next = setup({ cwd: h.cwd, mode });
		await next.emit("session_start");
		assert.ok(rows(next).includes("✓ Fix tests") && rows(next).includes("· Run full suite"));
		await next.command("goal-resume");
		await next.boundary([assistant(DONE)]);
		const archived = setup({ cwd: h.cwd, mode });
		await archived.emit("session_start");
		assert.ok(rows(archived).includes("✓ Fix tests") && rows(archived).includes("· Run full suite"));
	}
});

test("large checklists have a bounded preview without losing saved or resumed tasks", async () => {
	for (const mode of ["tui", "rpc"]) {
		const h = setup({ mode });
		await h.run("Complete every task.");
		let checklist: Array<{ text: string; done: boolean }> = [];
		for (const count of [0, 10, 11, 100]) {
			checklist = Array.from({ length: count }, (_, i) => ({ text: `Task ${i + 1}`, done: i % 2 === 0 }));
			await h.update(checklist);
			const lines = h.render();
			assert.equal(lines.length, (mode === "tui" ? 5 : 3) + Math.min(count, 10) + Number(count > 10));
			assert.equal(lines.filter((line) => /[·✓] Task /.test(line)).length, Math.min(count, 10));
			assert.equal(lines.some((line) => line.includes(" more")), count > 10);
			if (count > 10) assert.ok(lines.some((line) => line.includes(`… ${count - 10} more`)));
			assert.ok(!lines.some((line) => line.includes("Task 11")));
			assert.deepEqual(h.state().tasks, checklist);
			assert.ok((await h.boundary()).entries[0].content.includes(JSON.stringify(checklist)));
		}
		await h.command("goal-pause");
		const next = setup({ cwd: h.cwd, mode });
		await next.emit("session_start");
		assert.ok(next.render().some((line) => line.includes("… 90 more")));
		await next.command("goal-resume");
		assert.ok(next.sent[0].includes(JSON.stringify(checklist)));
		await next.boundary([assistant(DONE)]);
		assert.deepEqual(next.archive().tasks, checklist);
		const archived = setup({ cwd: h.cwd, mode });
		await archived.emit("session_start");
		assert.equal(archived.render().length, mode === "tui" ? 16 : 14);
		assert.ok(archived.render().some((line) => line.includes("… 90 more")));
	}
});

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

test("completion archives until the user confirms, including across sessions", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.update(tasks);
	assert.equal(await h.boundary([assistant(`Verified the result.\r\n${DONE}\n`)]), undefined);
	assert.equal(existsSync(h.current), false);
	assert.equal(h.archived().length, 1);
	assert.deepEqual(h.archive(), { instruction: "Fix the tests.", status: "done", round: 1, tasks });
	await h.emit("agent_settled");
	assert.equal(await h.boundary(), undefined);
	assert.match(h.render().join("\n"), /done · awaiting review/);
	assert.match(h.render().join("\n"), /\/goal-review/);
	assert.match(h.notifications.at(-1)!.message, /\/goal-review/);
	assert.equal(h.aborts(), 0);
	const next = setup({ cwd: h.cwd });
	await next.emit("session_start");
	assert.match(next.render().join("\n"), /done · awaiting review/);
	assert.equal(next.sent.length, 0);
	for (const action of [undefined, 0]) {
		next.selections.push(0, action);
		await next.command("goal-review");
		assert.equal(next.archived().length, 1, "cancel and Keep must retain the goal");
	}
	next.selections.push(0, 2);
	await next.command("goal-review");
	assert.equal(next.archived().length, 0);
	assert.equal(existsSync(next.current), false);
	assert.deepEqual(next.render(), []);
});

for (const mode of ["tui", "rpc"]) {
	test(`review count remains visible with only archived goals in ${mode} mode`, async () => {
		const h = setup({ mode });
		await h.run("First goal.");
		await h.boundary([assistant(DONE)]);
		await h.emit("agent_settled");
		assert.match(h.render().join("\n"), /1 awaiting review · \/goal-review/);
		await h.run("Second goal.");
		assert.match(h.render().join("\n"), /1 awaiting review · \/goal-review/);
		await h.command("goal-stop");
		assert.equal(existsSync(h.current), false);
		assert.match(h.render().join("\n"), /2 awaiting review · \/goal-review/);

		const next = setup({ cwd: h.cwd, mode });
		await next.emit("session_start");
		assert.match(next.render().join("\n"), /2 awaiting review · \/goal-review/);
		next.selections.push(0, 2);
		await next.command("goal-review");
		assert.match(next.render().join("\n"), /1 awaiting review · \/goal-review/);
		next.selections.push(0, 2);
		await next.command("goal-review");
		assert.deepEqual(next.render(), []);
	});
}

test("blocked goals retain their checklist and can resume in a fresh session", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.update(tasks);
	await h.boundary([assistant(`Need permission.\n${BLOCKED}`)]);
	await h.emit("agent_settled");
	assert.equal(h.state().status, "blocked");
	assert.equal(h.archived().length, 0);
	assert.match(h.render().join("\n"), /blocked/);
	const next = setup({ cwd: h.cwd });
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

test("/goal-pause saves progress without archiving and can resume in another session", async () => {
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
	const next = setup({ cwd: h.cwd });
	await next.emit("session_start");
	await next.command("goal-resume");
	assert.deepEqual(next.state(), before);
	assert.ok(next.sent[0].includes(JSON.stringify(tasks)));
});

test("/goal-pause never aborts unrelated work or changes a non-running goal", async () => {
	for (const status of ["none", "paused", "blocked", "done"]) {
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
	const next = setup({ cwd: h.cwd });
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

test("archived goals can be resumed without losing their checklist", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.update(tasks);
	await h.boundary([assistant(DONE)]);
	const next = setup({ cwd: h.cwd });
	next.selections.push(0, 1);
	await next.command("goal-review");
	assert.equal(next.archived().length, 0);
	assert.equal(next.state().status, "running");
	assert.deepEqual(next.state().tasks, tasks);
	assert.equal(next.sent.length, 1);
});

test("review deletes only the selected archive and cannot replace a current goal", async () => {
	const h = setup();
	await h.run("First goal.");
	await h.command("goal-stop");
	await h.emit("agent_settled");
	await h.run("Second goal.");
	await h.command("goal-stop");
	await h.emit("agent_settled");
	await h.run("Third goal.");
	await h.emit("agent_settled");
	const before = h.state();
	h.selections.push(0, 1);
	await h.command("goal-review");
	assert.equal(h.archived().length, 2);
	assert.deepEqual(h.state(), before);
	const retained = h.archived()[1];
	h.selections.push(0, 2);
	await h.command("goal-review");
	assert.deepEqual(h.archived(), [retained]);
	assert.deepEqual(h.state(), before);
});

test("session changes while reviewing cannot delete saved work", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.command("goal-stop");
	await h.emit("agent_settled");
	let calls = 0;
	h.ctx.ui.select = async (_title, options) => {
		if (++calls === 2) await h.emit("session_start");
		return options[calls === 2 ? 2 : 0];
	};
	await h.command("goal-review");
	assert.equal(calls, 2);
	assert.equal(h.archived().length, 1);
});

test("invalid saved state is reported and never overwritten", async () => {
	for (const value of ["{broken", "null", '{"instruction":"hello"}']) {
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

test("a storage failure stops continuation, keeps the last valid file, and reports an error", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	const before = readFileSync(h.current, "utf8");
	// Make the archive destination unwritable without depending on chmod or user privileges.
	writeFileSync(h.archiveDir, "not a directory");
	await h.boundary([assistant(DONE)]);
	assert.equal(await h.boundary(), undefined);
	assert.equal(h.state().instruction, JSON.parse(before).instruction);
	assert.equal(h.notifications.at(-1)!.level, "error");
	assert.match(h.render().join("\n"), /\/goal-review/);
	// An ended current.json left by a failed move can still be reviewed and deleted.
	await h.emit("agent_settled");
	rmSync(h.archiveDir);
	h.selections.push(0, 2);
	await h.command("goal-review");
	assert.equal(existsSync(h.current), false);
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

test("resuming an archive without a model retains it as a paused current goal", async () => {
	const h = setup();
	await h.run("Fix the tests.");
	await h.command("goal-stop");
	await h.emit("agent_settled");
	h.ctx.model = undefined;
	h.selections.push(0, 1);
	await h.command("goal-review");
	assert.equal(h.archived().length, 0);
	assert.equal(h.state().status, "paused");
	assert.equal(h.sent.length, 1);
});

test("malformed archives are reported and preserved without blocking valid goals", async () => {
	const h = setup();
	mkdirSync(h.archiveDir, { recursive: true });
	const file = join(h.archiveDir, "broken.json");
	writeFileSync(file, "broken");
	await h.run("Fix the tests.");
	assert.equal(h.sent.length, 1);
	assert.equal(readFileSync(file, "utf8"), "broken");
	assert.equal(h.notifications[0].level, "warning");
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
		if (mode === "rpc") assert.ok(Array.isArray(h.widgets.get("goal")));
		else assert.equal(h.widgets.size, 0);
	});
}
