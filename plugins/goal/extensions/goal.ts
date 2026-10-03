import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DONE = "<goal>done</goal>";
const BLOCKED = "<goal>blocked</goal>";

interface Goal {
	instruction: string;
	status: "running" | "paused" | "blocked" | "done" | "stopped";
	round: number;
	tasks: Array<{ text: string; done: boolean }>;
}

const ended = (goal: Goal) => goal.status === "done" || goal.status === "stopped";
const progress = (goal: Goal) => `${goal.tasks.filter((task) => task.done).length}/${goal.tasks.length} tasks done`;
const singleLine = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();

function readGoal(file: string): Goal {
	const goal = JSON.parse(readFileSync(file, "utf8"));
	if (!goal || typeof goal.instruction !== "string" || !goal.instruction.trim()
		|| !["running", "paused", "blocked", "done", "stopped"].includes(goal.status)
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
Check the workspace before resuming; saved progress is not proof that the work is still correct.
Make concrete progress, then verify the result against the whole goal. Do not stop at a plan or a partial result.
When the goal is reached, summarize the result and verification, then end your reply with this exact line:
${DONE}
If you cannot proceed without user input, permission, or an unavailable prerequisite, explain the blocker and end your reply with this exact line:
${BLOCKED}
Otherwise, keep working. Never claim success without evidence or bypass permissions to make progress.
Only the user may confirm completion or delete saved goals. Do not edit .pi/goals directly.`;

export default function (pi: ExtensionAPI) {
	let directory = "";
	let active: Goal | undefined;
	let started = false;
	let awaitingSettle = false;
	let generation = 0;
	let archives: Array<{ file: string; goal: Goal }> = [];

	const currentFile = () => join(directory, "current.json");
	const save = () => {
		if (!active) return;
		mkdirSync(directory, { recursive: true });
		const temp = join(directory, `.${randomUUID()}.tmp`);
		try {
			writeFileSync(temp, `${JSON.stringify(active, null, 2)}\n`, { mode: 0o600 });
			renameSync(temp, currentFile());
		} finally {
			rmSync(temp, { force: true });
		}
	};

	const showStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const goal = active ?? archives.at(-1)?.goal;
		const review = archives.length ? `${archives.length} awaiting review · /goal-review` : "";
		if (!goal) {
			ctx.ui.setWidget("goal", undefined);
			return;
		}
		const status = ended(goal) ? `${goal.status} · awaiting review` : goal.status;
		const lines = [
			`goal · ${status} · ${progress(goal)} · round ${goal.round}`,
			singleLine(goal.instruction),
			...goal.tasks.map((task) => `${task.done ? "✓" : "·"} ${singleLine(task.text)}`),
			ended(goal) ? review || "/goal-review" : `${active?.status === "running" ? "/goal-pause" : "/goal-resume"}${review ? ` · ${review}` : ""}`,
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

	const fail = (ctx: ExtensionContext, error: unknown) => {
		started = false;
		if (active?.status === "running") {
			active.status = "paused";
			try { save(); } catch { /* Keep the original error if storage is still unavailable. */ }
		}
		ctx.ui.notify(`Goal paused; check saved state. ${error instanceof Error ? error.message : String(error)}`, "error");
		showStatus(ctx);
	};

	const pause = (ctx: ExtensionContext) => {
		started = false;
		if (active?.status === "running") {
			active.status = "paused";
			try { save(); } catch (error) { fail(ctx, error); return false; }
		}
		showStatus(ctx);
		return true;
	};

	const load = (ctx: ExtensionContext) => {
		generation++;
		started = false;
		active = undefined;
		archives = [];
		directory = join(ctx.cwd, ".pi", "goals");
		if (existsSync(currentFile())) {
			active = readGoal(currentFile());
			if (active.status === "running") {
				active.status = "paused";
				save();
			}
		}
		const archiveDir = join(directory, "archive");
		if (existsSync(archiveDir)) {
			for (const name of readdirSync(archiveDir).filter((name) => name.endsWith(".json")).sort()) {
				const file = join(archiveDir, name);
				try { archives.push({ file, goal: readGoal(file) }); }
				catch (error) { ctx.ui.notify(String(error), "warning"); }
			}
		}
		showStatus(ctx);
	};

	const archive = (ctx: ExtensionContext, status: "done" | "stopped") => {
		if (!active) return;
		started = false;
		active.status = status;
		save();
		const archiveDir = join(directory, "archive");
		mkdirSync(archiveDir, { recursive: true });
		const file = join(archiveDir, `${Date.now()}-${randomUUID()}.json`);
		renameSync(currentFile(), file);
		archives.push({ file, goal: active });
		active = undefined;
		showStatus(ctx);
	};

	const start = async (ctx: ExtensionCommandContext) => {
		if (!active) return;
		if (ended(active)) {
			active.status = "paused";
			save();
			showStatus(ctx);
		}
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
		awaitingSettle = false;
		generation++;
		pause(ctx);
		active = undefined;
		archives = [];
		if (ctx.hasUI) ctx.ui.setWidget("goal", undefined);
	});

	// Pi can report idle before all agent_settled handlers have run.
	pi.on("agent_start", async () => { awaitingSettle = true; });

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!started || active?.status !== "running") return;
		if (event.outcome !== "completed" || ctx.signal?.aborted) {
			pause(ctx);
			return;
		}
		const message = event.context.contextMessages.findLast((message) => message.role === "assistant");
		const text = message?.role === "assistant" && message.stopReason === "stop"
			? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
		const finalLine = text.trim().split(/\r?\n/).at(-1);
		try {
			if (finalLine === DONE) {
				archive(ctx, "done");
				ctx.ui.notify("Goal reached. Use /goal-review to confirm and delete, or resume.", "info");
				return;
			}
			if (finalLine === BLOCKED) {
				started = false;
				active.status = "blocked";
				save();
				showStatus(ctx);
				ctx.ui.notify("Goal blocked. Resolve the blocker, then /goal-resume.", "warning");
				return;
			}
			// Let already-requested work run first; never add a competing follow-up.
			if (event.continue || ctx.hasPendingMessages()) return;
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
			// Reload while idle so a new session or manual file repair is picked up.
			if (active?.status !== "running") load(ctx);
			if (command === "goal-status") {
				ctx.ui.notify(active
					? `Goal (${active.status}, round ${active.round}, ${progress(active)}): ${active.instruction}`
					: `No active goal.${archives.length ? " Use /goal-review for ended goals." : " Use /goal <objective> to start."}`, "info");
				return;
			}
			if (command === "goal-pause") {
				if (active?.status !== "running") { ctx.ui.notify("No running goal.", "info"); return; }
				const abort = started;
				const saved = pause(ctx);
				if (abort) ctx.abort();
				if (saved) ctx.ui.notify("Goal paused. Use /goal-resume to continue.", "info");
				return;
			}
			if (command === "goal-stop") {
				if (!active) { ctx.ui.notify("No active goal.", "info"); return; }
				const abort = active.status === "running";
				try { archive(ctx, "stopped"); } finally { if (abort) ctx.abort(); }
				ctx.ui.notify("Goal stopped and saved. Use /goal-review.", "info");
				return;
			}
			if (active?.status === "running" || awaitingSettle || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Stop the current goal or wait for Pi to finish first.", "warning");
				return;
			}
			if (command === "goal-review") {
				if (!ctx.hasUI) { ctx.ui.notify("Goal review requires an interactive UI.", "warning"); return; }
				// Also recover an ended current.json if archiving was interrupted.
				const choices = [...archives, ...(active && ended(active) ? [{ file: currentFile(), goal: active }] : [])];
				if (!choices.length) { ctx.ui.notify("No goals awaiting review.", "info"); return; }
				const version = generation;
				const previous = active;
				const unchanged = () => generation === version && active === previous && ctx.isIdle() && !ctx.hasPendingMessages();
				const labels = choices.map(({ goal }, i) => `${i + 1}. ${goal.status} · ${singleLine(goal.instruction)}`);
				const selected = await ctx.ui.select("Review ended goal", labels);
				const choice = choices[labels.indexOf(selected ?? "")];
				if (!choice || !unchanged()) return;
				const action = await ctx.ui.select(singleLine(choice.goal.instruction), ["Keep", "Resume", "Confirm finished and delete"]);
				if (!unchanged()) return;
				if (action === "Confirm finished and delete") {
					rmSync(choice.file);
					load(ctx);
					ctx.ui.notify("Goal confirmed and deleted.", "info");
				} else if (action === "Resume") {
					if (active && choice.file !== currentFile()) {
						ctx.ui.notify("Resume or stop the current goal first.", "warning");
						return;
					}
					if (choice.file !== currentFile()) renameSync(choice.file, currentFile());
					load(ctx);
					await start(ctx);
				}
				return;
			}
			if (command === "goal-resume") {
				if (!active) { ctx.ui.notify("No active goal. Use /goal-review for ended goals.", "info"); return; }
				await start(ctx);
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
		["goal-status", "Show the current goal and progress"],
		["goal-pause", "Pause work and keep the current goal for later"],
		["goal-resume", "Continue the saved goal"],
		["goal-stop", "Stop the goal and archive it for review"],
		["goal-review", "Resume, keep, or confirm and delete ended goals"],
	]) {
		pi.registerCommand(name, { description, handler: (args, ctx) => handleCommand(name, args, ctx) });
	}
}
