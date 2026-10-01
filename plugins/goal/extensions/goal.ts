import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DONE = "<goal>done</goal>";
const BLOCKED = "<goal>blocked</goal>";

interface Goal {
	text: string;
	round: number;
	started: boolean;
}

const prompt = (goal: Goal) => `Keep working toward this goal:

${goal.text}

Make concrete progress, then verify the result against the whole goal. Do not stop at a plan or a partial result.
When the goal is reached, summarize the result and verification, then end your reply with this exact line:
${DONE}
If you cannot proceed without user input, permission, or an unavailable prerequisite, explain the blocker and end your reply with this exact line:
${BLOCKED}
Otherwise, keep working. Never claim success without evidence or bypass permissions to make progress.`;

export default function (pi: ExtensionAPI) {
	let active: Goal | undefined;

	const showStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("goal", active ? `goal · round ${active.round}` : undefined);
	};

	const clear = (ctx: ExtensionContext) => {
		active = undefined;
		showStatus(ctx);
	};

	const stop = (ctx: ExtensionContext, message: string, level: "info" | "warning" = "info") => {
		clear(ctx);
		ctx.ui.notify(message, level);
	};

	pi.on("session_start", async (_event, ctx) => clear(ctx));
	pi.on("session_tree", async (_event, ctx) => clear(ctx));
	pi.on("session_shutdown", async (_event, ctx) => clear(ctx));

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!active?.started) return;
		if (event.outcome !== "completed" || ctx.signal?.aborted) {
			stop(ctx, "Goal stopped before completion.", "warning");
			return;
		}

		const message = event.context.contextMessages.findLast((message) => message.role === "assistant");
		const text = message?.role === "assistant" && message.stopReason === "stop"
			? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
			: "";
		const finalLine = text.trim().split(/\r?\n/).at(-1);
		if (finalLine === DONE) {
			stop(ctx, "Goal reached.");
			return;
		}
		if (finalLine === BLOCKED) {
			stop(ctx, "Goal blocked. See the agent's reply.", "warning");
			return;
		}

		// Let already-requested work run first; never add a competing follow-up.
		if (event.continue || ctx.hasPendingMessages()) return;
		active.round++;
		showStatus(ctx);
		return {
			entries: [...event.entries, {
				type: "custom_message" as const,
				customType: "goal",
				content: prompt(active),
				display: false,
			}],
			continue: true,
		};
	});

	// Aborts can skip the actionable boundary entirely. Never restart from here.
	pi.on("agent_settled", async (_event, ctx) => {
		if (active) stop(ctx, "Goal stopped before completion.", "warning");
	});

	pi.registerCommand("goal", {
		description: "Work toward a goal until complete; /goal shows status, /goal stop cancels",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify(active ? `Goal (round ${active.round}): ${active.text}` : "No active goal. Use /goal <objective> to start.", "info");
				return;
			}
			if (text === "stop") {
				if (!active) {
					ctx.ui.notify("No active goal.", "info");
					return;
				}
				stop(ctx, "Goal stopped.");
				ctx.abort();
				return;
			}
			if (active || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Stop the current goal or wait for Pi to finish before starting a goal.", "warning");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("Select a model before starting a goal.", "warning");
				return;
			}

			const goal = { text, round: 1, started: false };
			active = goal;
			showStatus(ctx);
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				// Authentication can yield to cancellation, session changes, or another run.
				if (active !== goal) return;
				if (!auth.ok || !ctx.isIdle() || ctx.hasPendingMessages()) {
					stop(ctx, auth.ok ? "Pi is busy. Start the goal again when idle." : `Could not start goal: ${auth.error}`, "warning");
					return;
				}
				goal.started = true;
				pi.sendUserMessage(prompt(goal));
			} catch (error) {
				if (active === goal) stop(ctx, `Could not start goal: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		},
	});
}
