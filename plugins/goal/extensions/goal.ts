import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DONE = "<goal>done</goal>";
const BLOCKED = "<goal>blocked</goal>";
const MAX_VISIBLE_TASKS = 10;
const REGISTRATION_EVENT = "@derogab/pi-goal:registration";

const uid = process.geteuid?.();
const archiveRoot = uid === undefined ? join(tmpdir(), "pi-goals") : `/tmp/pi-goals-${uid}`;

function privateArchiveRoot(create: boolean) {
	if (create) mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
	const stat = lstatSync(archiveRoot, { throwIfNoEntry: false });
	if (!stat && !create) return false;
	// A predictable path in shared /tmp must not be a link or controlled by another user.
	if (!stat?.isDirectory() || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) {
		throw new Error(`Expected a private goal archive directory: ${archiveRoot}`);
	}
	return true;
}

interface Goal {
	instruction: string;
	status: "running" | "paused" | "blocked" | "done" | "stopped";
	round: number;
	archiveId?: string;
	tasks: Array<{ text: string; done: boolean }>;
}

const ended = (goal: Goal) => goal.status === "done" || goal.status === "stopped";
const progress = (goal: Goal) => `${goal.tasks.filter((task) => task.done).length}/${goal.tasks.length} tasks done`;
const singleLine = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();

function readGoal(file: string): Goal {
	const goal = JSON.parse(readFileSync(file, "utf8"));
	if (!goal || typeof goal.instruction !== "string" || !goal.instruction.trim()
		|| !["running", "paused", "blocked", "done", "stopped"].includes(goal.status)
		|| (goal.archiveId !== undefined && (typeof goal.archiveId !== "string" || !/^\d+-[a-f0-9-]{36}$/.test(goal.archiveId)))
		|| !Number.isSafeInteger(goal.round) || goal.round < 1 || !Array.isArray(goal.tasks)
		|| !goal.tasks.every((task: any) => task && typeof task.text === "string" && typeof task.done === "boolean")) {
		throw new Error(`Invalid goal file: ${file}`);
	}
	return goal;
}

const prompt = (goal: Goal) => `Keep working toward this goal:

${goal.instruction}

Saved checklist: ${JSON.stringify(goal.tasks)}
Use goal_progress to keep a short, flat checklist updated as tasks are completed. Keep completed tasks in the list.
Apply later user messages and corrections before continuing or declaring completion; update the checklist accordingly. Goal reminders do not override newer user instructions.
Check the workspace before resuming; saved progress is not proof that the work is still correct.
Make concrete progress, then verify the result against the whole goal. Do not stop at a plan or a partial result.
When the goal is reached, update the checklist, summarize the result and verification, then end your reply with this exact line:
${DONE}
If you cannot proceed without user input, permission, or an unavailable prerequisite, explain the blocker and end your reply with this exact line:
${BLOCKED}
Otherwise, keep working. Never claim success without evidence or bypass permissions to make progress.
The plugin automatically marks the checklist complete and archives the goal when you report completion. Do not edit .pi/goals directly.`;

export default function (pi: ExtensionAPI) {
	// Separate install paths share Pi's bus; subscriptions are removed on runtime reload.
	const registration = { claimed: false };
	pi.events.emit(REGISTRATION_EVENT, registration);
	if (registration.claimed) return;

	let directory = "";
	let archiveDir = "";
	let active: Goal | undefined;
	let replyGoal: Goal | undefined;
	let started = false;
	let awaitingSettle = false;
	let archives: Goal[] = [];
	let closeExpanded: (() => void) | undefined;

	const currentFile = () => join(directory, "current.json");
	const save = (dir = directory, name = "current.json", goal = active) => {
		if (!goal) return;
		mkdirSync(dir, { recursive: true });
		const temp = join(dir, `.${randomUUID()}.tmp`);
		try {
			writeFileSync(temp, `${JSON.stringify(goal, null, 2)}\n`, { mode: 0o600 });
			renameSync(temp, join(dir, name));
		} finally {
			rmSync(temp, { force: true });
		}
	};

	const showStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const goal = active ?? archives.at(-1);
		if (!goal || (!active && goal.status === "done")) {
			ctx.ui.setWidget("goal", undefined);
			return;
		}
		const status = ended(goal) ? `${goal.status} · ${active ? "archive pending" : "archived"}` : goal.status;
		const lines = [
			`goal · ${status} · ${progress(goal)} · round ${goal.round}`,
			singleLine(goal.instruction),
			...goal.tasks.slice(0, MAX_VISIBLE_TASKS).map((task) => `${task.done ? "✓" : "·"} ${singleLine(task.text)}`),
			...(goal.tasks.length > MAX_VISIBLE_TASKS ? [`… ${goal.tasks.length - MAX_VISIBLE_TASKS} more${ctx.mode === "tui" ? " · Ctrl+Shift+T: expand" : ""}`] : []),
			ended(goal) ? (active ? "Check saved state; /goal-status to retry archiving" : "/goal <objective>: start another goal")
				: goal.status === "running" ? "/goal-pause"
					: goal.status === "blocked" ? "Reply to continue · /goal-pause to stay paused" : "/goal-resume",
		];
		if (ctx.mode !== "tui") {
			ctx.ui.setWidget("goal", lines);
			return;
		}
		ctx.ui.setWidget("goal", (_tui, theme) => ({
			render(width) {
				if (width < 4) return lines.map((line) => truncateToWidth(line, width));
				const border = (text: string) => theme.fg("borderMuted", text);
				return [
					border(`╭${"─".repeat(width - 2)}╮`),
					...lines.map((line, index) => {
						const text = truncateToWidth(line, width - 4);
						return border("│ ") + theme.fg(index === 0 ? "accent" : "muted", text)
							+ " ".repeat(width - 4 - visibleWidth(text)) + border(" │");
					}),
					border(`╰${"─".repeat(width - 2)}╯`),
				];
			},
			invalidate() {},
		}), { placement: "aboveEditor" });
	};

	pi.registerShortcut(Key.ctrlShift("t"), {
		description: "Expand or collapse the full goal checklist",
		handler: async (ctx) => {
			if (closeExpanded) { closeExpanded(); return; }
			const goal = active ?? archives.at(-1);
			if (ctx.mode !== "tui" || !ctx.hasUI || !goal || goal.tasks.length <= MAX_VISIBLE_TASKS) return;
			await ctx.ui.custom<void>((tui, theme, keys, done) => {
				const close = () => {
					closeExpanded = undefined;
					done();
				};
				closeExpanded = close;
				let list: SelectList;
				let selected = 0;
				let pageSize = 1;
				return {
					render(width) {
						pageSize = Math.max(1, tui.terminal.rows - 8);
						list = new SelectList(goal.tasks.map((task, i) => ({
							value: String(i), label: `${task.done ? "✓" : "·"} ${singleLine(task.text)}`,
						})), pageSize, {
							selectedPrefix: (text) => theme.fg("accent", text),
							selectedText: (text) => theme.fg("accent", text),
							description: (text) => theme.fg("muted", text),
							scrollInfo: (text) => theme.fg("dim", text),
							noMatch: () => theme.fg("muted", "No tasks"),
						});
						selected = Math.min(selected, Math.max(0, goal.tasks.length - 1));
						list.setSelectedIndex(selected);
						list.onCancel = close;
						return [
							theme.fg("accent", truncateToWidth(`goal · ${goal.status} · ${progress(goal)}`, width)),
							theme.fg("muted", truncateToWidth(singleLine(goal.instruction), width)),
							...list.render(width).map((line) => truncateToWidth(line, width)),
							theme.fg("dim", truncateToWidth("↑↓ / PgUp / PgDn: scroll · Ctrl+Shift+T / Esc: collapse", width)),
						];
					},
					handleInput(data) {
						if (matchesKey(data, Key.ctrlShift("t"))) close();
						else if (keys.matches(data, "tui.select.pageUp")) list?.setSelectedIndex(Math.max(0, selected - pageSize));
						else if (keys.matches(data, "tui.select.pageDown")) list?.setSelectedIndex(Math.min(goal.tasks.length - 1, selected + pageSize));
						else list?.handleInput(data);
						selected = Number(list?.getSelectedItem()?.value ?? 0);
						tui.requestRender();
					},
					invalidate() {},
				};
			}, { overlay: true });
		},
	});

	const fail = (ctx: ExtensionContext, error: unknown) => {
		started = false;
		if (active?.status === "running") {
			active.status = "paused";
			try { save(); } catch { /* Keep the original error if storage is still unavailable. */ }
		}
		const reason = active && ended(active) ? "Goal could not be archived" : "Goal paused";
		ctx.ui.notify(`${reason}; check saved state. ${error instanceof Error ? error.message : String(error)}`, "error");
		showStatus(ctx);
	};

	const pause = (ctx: ExtensionContext, manual = false) => {
		replyGoal = undefined;
		started = false;
		if (active?.status === "running" || (manual && active?.status === "blocked")) {
			active.status = "paused";
			try { save(); } catch (error) { fail(ctx, error); return false; }
		}
		showStatus(ctx);
		return true;
	};

	const load = (ctx: ExtensionContext, adoptLegacy = false) => {
		closeExpanded?.();
		replyGoal = undefined;
		started = false;
		active = undefined;
		archives = [];
		const root = join(ctx.cwd, ".pi", "goals");
		// A stable session key survives restarts without sharing state with other sessions.
		const session = `session-${encodeURIComponent(ctx.sessionManager.getSessionId())}`;
		directory = join(root, "sessions", session);
		const workspace = createHash("sha256").update(realpathSync(ctx.cwd)).digest("hex");
		archiveDir = join(archiveRoot, workspace, session);
		const legacyFile = join(root, "current.json");
		if (adoptLegacy && !existsSync(currentFile()) && existsSync(legacyFile)) {
			readGoal(legacyFile);
			mkdirSync(directory, { recursive: true });
			// Move, rather than copy, so only one session can adopt the old shared goal.
			renameSync(legacyFile, currentFile());
		}
		if (existsSync(currentFile())) {
			active = readGoal(currentFile());
			if (active.status === "running") {
				active.status = "paused";
				save();
			}
		}
		const history = [join(directory, "archive")]; // Older session history stays readable in place.
		try { if (privateArchiveRoot(false)) history.push(archiveDir); }
		catch (error) { ctx.ui.notify(String(error), "warning"); }
		for (const dir of history) {
			if (!existsSync(dir)) continue;
			for (const name of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
				const file = join(dir, name);
				try { archives.push(readGoal(file)); }
				catch (error) { ctx.ui.notify(String(error), "warning"); }
			}
		}
		// Retry an interrupted archive move without restarting completed work.
		if (active?.status === "done" || active?.status === "stopped") archive(ctx, active.status);
		else showStatus(ctx);
	};

	const archive = (ctx: ExtensionContext, status: "done" | "stopped") => {
		if (!active) return;
		started = false;
		active.status = status;
		if (status === "done") active.tasks = active.tasks.map((task) => ({ ...task, done: true }));
		// Keep the destination stable if Pi exits between publishing the archive and removing current.json.
		active.archiveId ??= `${Date.now()}-${randomUUID()}`;
		save();
		privateArchiveRoot(true);
		const { archiveId, ...record } = active;
		save(archiveDir, `${archiveId}.json`, record);
		rmSync(currentFile());
		archives.push(record);
		active = undefined;
		if (status === "done") closeExpanded?.();
		showStatus(ctx);
	};

	const start = async (ctx: ExtensionCommandContext) => {
		if (!active) return;
		if (!ctx.model) {
			ctx.ui.notify("Select a model before starting a goal.", "warning");
			return;
		}
		const goal = { ...active, status: "running" as const };
		active = goal;
		started = false;
		try {
			save();
			showStatus(ctx);
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			// Authentication can yield to cancellation, session changes, or another run.
			if (active !== goal || goal.status !== "running") return;
			if (!auth.ok || awaitingSettle || !ctx.isIdle() || ctx.hasPendingMessages()) {
				pause(ctx);
				ctx.ui.notify(auth.ok ? "Pi is busy. Use /goal-resume when idle." : `Could not start goal: ${auth.error}`, "warning");
				return;
			}
			started = true;
			pi.sendUserMessage(prompt(goal));
		} catch (error) {
			if (active === goal) fail(ctx, error);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		awaitingSettle = false;
		pause(ctx);
		try { load(ctx); } catch (error) { fail(ctx, error); }
	});
	pi.on("session_tree", async (_event, ctx) => {
		awaitingSettle = false;
		pause(ctx);
		try { load(ctx); } catch (error) { fail(ctx, error); }
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		closeExpanded?.();
		awaitingSettle = false;
		pause(ctx);
		active = undefined;
		archives = [];
		if (ctx.hasUI) ctx.ui.setWidget("goal", undefined);
	});

	pi.on("input", async (event) => {
		replyGoal = event.source !== "extension" && (event.text.trim() || event.images?.length)
			&& active?.status === "blocked" ? active : undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const goal = replyGoal;
		replyGoal = undefined;
		// Wait until Pi accepts the reply; handled input or failed authentication must not resume work.
		if (!goal || active !== goal || goal.status !== "blocked" || !("prompt" in event) || ctx.signal?.aborted) return;
		try {
			goal.status = "running";
			started = true;
			save();
			showStatus(ctx);
			return { message: { customType: "goal", content: prompt(goal), display: false } };
		} catch (error) { fail(ctx, error); }
	});

	// Pi can report idle before all agent_settled handlers have run.
	pi.on("agent_start", async () => { awaitingSettle = true; });

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!started || active?.status !== "running") return;
		if (event.outcome !== "completed" || ctx.signal?.aborted) {
			pause(ctx);
			return;
		}
		// Let Pi deliver queued input before acting on a now-stale completion or blocker.
		if (ctx.hasPendingMessages() || event.context.pendingMessages.length > 0) return;
		const message = event.context.contextMessages.findLast((message) => message.role === "assistant");
		const text = message?.role === "assistant" && message.stopReason === "stop"
			? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
		const finalLine = text.trim().split(/\r?\n/).at(-1);
		try {
			if (finalLine === DONE) {
				const goal = active;
				archive(ctx, "done");
				ctx.ui.notify(`Goal reached and archived. ${progress(goal)}: ${singleLine(goal.instruction)}`, "info");
				return;
			}
			if (finalLine === BLOCKED) {
				started = false;
				active.status = "blocked";
				save();
				showStatus(ctx);
				ctx.ui.notify("Goal blocked. Reply to continue automatically, or use /goal-resume after resolving the blocker.", "warning");
				return;
			}
			// Let already-requested work run first; never add a competing follow-up.
			if (event.continue) return;
			active.round++;
			save();
			showStatus(ctx);
			return {
				entries: [...event.entries, {
					type: "custom_message" as const, customType: "goal", content: prompt(active), display: false,
				}],
				continue: true,
			};
		} catch (error) { fail(ctx, error); }
	});

	// Aborts can skip the actionable boundary entirely. Never restart from here.
	pi.on("agent_settled", async (_event, ctx) => {
		awaitingSettle = false;
		pause(ctx);
	});

	pi.registerTool({
		name: "goal_progress",
		label: "Goal progress",
		description: "Replace the running goal's short checklist. Include completed tasks. Does not start or finish goals.",
		parameters: Type.Object({
			tasks: Type.Array(Type.Object({ text: Type.String({ minLength: 1 }), done: Type.Boolean() })),
		}),
		async execute(_id, { tasks }, signal, _onUpdate, ctx) {
			const goal = active;
			return withFileMutationQueue(currentFile(), async () => {
				if (active !== goal || !started || active?.status !== "running" || signal?.aborted) throw new Error("No running goal.");
				active.tasks = tasks;
				try { save(); } catch (error) { fail(ctx, error); throw error; }
				showStatus(ctx);
				return { content: [{ type: "text" as const, text: progress(active) }], details: undefined };
			});
		},
	});

	const handleCommand = async (command: string, args: string, ctx: ExtensionCommandContext) => {
		try {
			const text = args.trim();
			if (command === "goal" && !text) {
				ctx.ui.notify("Usage: /goal <objective>. Use /goal-status to show the current goal.", "info");
				return;
			}
			// Reload this session's saved state so manual file repairs are picked up.
			if (active?.status !== "running") load(ctx, command === "goal-resume");
			if (command === "goal-status") {
				const goal = active ?? archives.at(-1);
				ctx.ui.notify(goal
					? `Goal (${goal.status}${active ? "" : ", archived"}, round ${goal.round}, ${progress(goal)}): ${goal.instruction}`
					: "No active goal. Use /goal <objective> to start.", "info");
				return;
			}
			if (command === "goal-pause") {
				if (active?.status !== "running" && active?.status !== "blocked") { ctx.ui.notify("No running goal.", "info"); return; }
				const abort = started;
				const saved = pause(ctx, true);
				if (abort) ctx.abort();
				if (saved) ctx.ui.notify("Goal paused. Use /goal-resume to continue.", "info");
				return;
			}
			if (command === "goal-stop") {
				if (!active) { ctx.ui.notify("No active goal.", "info"); return; }
				const abort = active.status === "running";
				try { archive(ctx, "stopped"); } finally { if (abort) ctx.abort(); }
				ctx.ui.notify("Goal stopped and archived.", "info");
				return;
			}
			if (command === "goal-resume") {
				if (!active) { ctx.ui.notify("No active goal. Use /goal <objective> to start.", "info"); return; }
				if (active.status === "running") return;
				if (awaitingSettle || !ctx.isIdle() || ctx.hasPendingMessages()) {
					// Adopt the current work; the settle boundary handles goal continuation.
					active.status = "running";
					started = true;
					save();
					showStatus(ctx);
				} else await start(ctx);
				return;
			}
			if (active?.status === "running" || awaitingSettle || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Stop the current goal or wait for Pi to finish first.", "warning");
				return;
			}
			if (active) {
				ctx.ui.notify("A saved goal exists. Use /goal-resume or /goal-stop first.", "warning");
				return;
			}
			active = { instruction: text, status: "paused", round: 1, tasks: [] };
			save();
			showStatus(ctx);
			await start(ctx);
		} catch (error) { fail(ctx, error); }
	};

	for (const [name, description] of [
		["goal", "Start a goal: /goal <objective>"],
		["goal-status", "Show the current or latest archived goal and progress"],
		["goal-pause", "Pause work and keep the current goal for later"],
		["goal-resume", "Continue the saved goal"],
		["goal-stop", "Stop the goal and archive it"],
	]) {
		pi.registerCommand(name, { description, handler: (args, ctx) => handleCommand(name, args, ctx) });
	}

	// Claim only after registration succeeds so failed copies cannot block retries.
	pi.events.on(REGISTRATION_EVENT, (data) => {
		(data as typeof registration).claimed = true;
	});
}
