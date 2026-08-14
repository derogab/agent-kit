import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "later";
const MAX_LABEL_LENGTH = 80;
const ACTION_CONFIRM = "Confirm";
const ACTION_REMOVE = "Remove";

interface SavedPrompt {
	text: string;
}

interface PendingDelivery {
	prompt: SavedPrompt;
	idle: boolean;
	marker?: string;
}

export default function (pi: ExtensionAPI) {
	// Saved prompts, oldest first. Reconstructed from session entries.
	let prompts: SavedPrompt[] = [];
	let pendingDeliveries: PendingDelivery[] = [];

	const reconstructState = (ctx: ExtensionContext) => {
		prompts = [];
		pendingDeliveries = [];
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

	const acknowledge = (delivery: PendingDelivery) => {
		const index = pendingDeliveries.indexOf(delivery);
		if (index === -1) return;

		pendingDeliveries.splice(index, 1);
		remove(delivery.prompt);
	};

	const truncate = (text: string) => {
		const singleLine = text.replace(/\s+/g, " ").trim();
		return singleLine.length > MAX_LABEL_LENGTH ? `${singleLine.slice(0, MAX_LABEL_LENGTH)}…` : singleLine;
	};

	const toLabel = (prompt: SavedPrompt, index: number) => `${index + 1}. ${truncate(prompt.text)}`;

	pi.on("before_agent_start", async () => {
		const delivery = pendingDeliveries.find((delivery) => delivery.idle);
		if (delivery !== undefined) acknowledge(delivery);
	});

	pi.on("message_start", async (event) => {
		const message = event.message;
		if (message.role !== "user" || !("content" in message) || !Array.isArray(message.content)) return;
		const content = message.content;

		const delivery = pendingDeliveries.find((delivery) => {
			const marker = delivery.marker;
			return marker !== undefined && content.some((part) => part.type === "text" && part.text.includes(marker));
		});
		if (delivery === undefined || delivery.marker === undefined) return;
		const marker = delivery.marker;

		// sendUserMessage() has no delivery ID for queued follow-ups. The marker
		// survives queueing, then is removed before the user message is persisted
		// or sent to the model.
		message.content = content.map((part) =>
			part.type === "text" ? { ...part, text: part.text.replace(marker, "") } : part,
		);
		acknowledge(delivery);
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
			const choice = await ctx.ui.select("Saved prompts", labels);
			if (choice === undefined) return;

			const index = labels.indexOf(choice);
			const prompt = prompts[index];
			if (prompt === undefined) return;

			const action = await ctx.ui.select(`Selected: ${truncate(prompt.text)}`, [
				ACTION_CONFIRM,
				ACTION_REMOVE,
			]);

			if (action === ACTION_REMOVE) {
				remove(prompt);
				ctx.ui.notify(`Removed saved prompt (${prompts.length} pending)`, "info");
				return;
			}

			if (action !== ACTION_CONFIRM) return;

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
				pendingDeliveries.push({ prompt, idle: true });
				pi.sendUserMessage(prompt.text);
				return;
			}

			// Keep the prompt in the list until its marked follow-up user message
			// actually starts, so an undelivered follow-up is not lost.
			const delivery = { prompt, idle: false, marker: `\u2063later:${randomUUID()}\u2063` };
			pendingDeliveries.push(delivery);
			pi.sendUserMessage(`${prompt.text}${delivery.marker}`, { deliverAs: "followUp" });
			ctx.ui.notify("Queued as follow-up", "info");
		},
	});
}
