import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "later";
const MAX_LABEL_LENGTH = 80;

interface SavedPrompt {
	text: string;
}

export default function (pi: ExtensionAPI) {
	// Saved prompts, oldest first. Reconstructed from session entries.
	let prompts: SavedPrompt[] = [];
	let pendingIdleDelivery: SavedPrompt | undefined;

	const reconstructState = (ctx: ExtensionContext) => {
		prompts = [];
		pendingIdleDelivery = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const data = entry.data as { prompts?: string[] } | undefined;
				// Use distinct objects so duplicate prompt text still has stable selection identity.
				prompts = (data?.prompts ?? []).map((text) => ({ text }));
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	const persist = () => {
		pi.appendEntry(ENTRY_TYPE, { prompts: prompts.map((prompt) => prompt.text) });
	};

	const remove = (prompt: SavedPrompt) => {
		const index = prompts.indexOf(prompt);
		if (index === -1) return;

		prompts.splice(index, 1);
		persist();
	};

	const toLabel = (prompt: SavedPrompt, index: number) => {
		const singleLine = prompt.text.replace(/\s+/g, " ").trim();
		const truncated =
			singleLine.length > MAX_LABEL_LENGTH ? `${singleLine.slice(0, MAX_LABEL_LENGTH)}…` : singleLine;
		return `${index + 1}. ${truncated}`;
	};

	pi.on("before_agent_start", async () => {
		const prompt = pendingIdleDelivery;
		if (prompt === undefined) return;

		// The next accepted idle turn is the pending delivery, even if an input
		// handler transformed its text before this event.
		pendingIdleDelivery = undefined;
		remove(prompt);
	});

	pi.registerCommand("later", {
		description: "Save a prompt for later, or run a saved prompt",
		handler: async (args, ctx) => {
			const text = args.trim();

			// /later <prompt>: save it for later
			if (text) {
				prompts.push({ text });
				persist();
				ctx.ui.notify(`Saved for later (${prompts.length} pending)`, "info");
				return;
			}

			// /later: pick a saved prompt to run
			if (prompts.length === 0) {
				ctx.ui.notify("Nothing saved for later. Use /later <prompt> to save a prompt.", "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/later requires interactive mode to pick a saved prompt", "error");
				return;
			}

			const labels = prompts.map(toLabel);
			const choice = await ctx.ui.select("Saved prompts — pick one to run", labels);
			if (choice === undefined) return;

			const index = labels.indexOf(choice);
			const prompt = prompts[index];
			if (prompt === undefined) return;

			if (ctx.isIdle()) {
				if (ctx.model === undefined) {
					ctx.ui.notify("Could not run saved prompt, kept in list: no model selected", "error");
					return;
				}

				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				if (!auth.ok) {
					ctx.ui.notify(`Could not run saved prompt, kept in list: ${auth.error}`, "error");
					return;
				}

				// ExtensionAPI.sendUserMessage() is fire-and-forget. before_agent_start
				// acknowledges that Pi accepted this idle turn after all preflight checks.
				pendingIdleDelivery = prompt;
				pi.sendUserMessage(prompt.text);
				return;
			}

			pi.sendUserMessage(prompt.text, { deliverAs: "followUp" });
			remove(prompt);
			ctx.ui.notify("Queued as follow-up", "info");
		},
	});
}
