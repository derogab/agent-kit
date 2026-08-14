import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "later";
const MAX_LABEL_LENGTH = 80;
const ACTION_CONFIRM = "Confirm";
const ACTION_REMOVE = "Remove";
const MARKER_BOUNDARY = "\u2063";
const VARIATION_SELECTOR_START = 0xfe00;
const DELIVERY_MARKER_PATTERN = /\u2063[\uFE00-\uFE0F]{32}\u2063/g;

interface SavedPrompt {
	text: string;
}

interface PendingDelivery {
	prompt: SavedPrompt;
	idle: boolean;
	marker: string;
}

export default function (pi: ExtensionAPI) {
	// Saved prompts, oldest first. Reconstructed from session entries.
	let prompts: SavedPrompt[] = [];
	let pendingDeliveries: PendingDelivery[] = [];
	// Tie idle sends to their input lifecycle, including overlapping sends.
	let awaitingIdleInput: PendingDelivery | undefined;
	let latestIdleInput: PendingDelivery | undefined;
	let pendingIdleInputs: PendingDelivery[] = [];

	const readPrompts = (ctx: ExtensionContext) => {
		let restored: SavedPrompt[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const data = entry.data as { prompts?: string[] } | undefined;
				// Use distinct objects so duplicate prompt text still has stable selection identity.
				restored = (data?.prompts ?? []).map((text) => ({ text }));
			}
		}
		return restored;
	};

	const resetState = (ctx: ExtensionContext) => {
		prompts = readPrompts(ctx);
		pendingDeliveries = [];
		awaitingIdleInput = undefined;
		latestIdleInput = undefined;
		pendingIdleInputs = [];
	};

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
		pendingIdleInputs = pendingIdleInputs.filter((pending) => pending !== delivery);
		if (latestIdleInput === delivery) latestIdleInput = undefined;
		remove(delivery.prompt);
	};

	const createMarker = () => {
		const selectors = [...randomUUID().replaceAll("-", "")]
			.map((digit) => String.fromCharCode(VARIATION_SELECTOR_START + Number.parseInt(digit, 16)))
			.join("");
		return `${MARKER_BOUNDARY}${selectors}${MARKER_BOUNDARY}`;
	};

	const createDelivery = (prompt: SavedPrompt, idle: boolean): PendingDelivery => {
		const delivery = { prompt, idle, marker: createMarker() };
		pendingDeliveries.push(delivery);
		return delivery;
	};

	const queueFollowUp = (prompt: SavedPrompt) => {
		const delivery = createDelivery(prompt, false);
		pi.sendUserMessage(`${prompt.text}${delivery.marker}`, { deliverAs: "followUp" });
	};

	const clearDequeuedFollowUps = (ctx: ExtensionContext) => {
		if (ctx.hasPendingMessages()) return;
		pendingDeliveries = pendingDeliveries.filter((delivery) => delivery.idle);
	};

	const reconstructTreeState = (ctx: ExtensionContext) => {
		const restored = readPrompts(ctx);
		// Each tracked prompt claims a distinct restored copy so every pending
		// delivery's acknowledgement still removes its own entry. Deliveries beyond
		// the restored count keep a stale object and acknowledge as no-ops, and
		// deliveries sharing one prompt object keep sharing it (one removal total).
		const available = [...restored];
		const remapped = new Map<SavedPrompt, SavedPrompt>();
		for (const delivery of pendingDeliveries) {
			if (!prompts.includes(delivery.prompt)) continue;

			let replacement = remapped.get(delivery.prompt);
			if (replacement === undefined) {
				const index = available.findIndex((prompt) => prompt.text === delivery.prompt.text);
				if (index === -1) continue;
				replacement = available[index];
				available.splice(index, 1);
				remapped.set(delivery.prompt, replacement);
			}
			delivery.prompt = replacement;
		}
		prompts = restored;
		clearDequeuedFollowUps(ctx);
	};

	pi.on("session_start", async (_event, ctx) => resetState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructTreeState(ctx));
	pi.on("agent_settled", async (_event, ctx) => clearDequeuedFollowUps(ctx));

	const truncate = (text: string) => {
		const singleLine = text.replace(/\s+/g, " ").trim();
		return singleLine.length > MAX_LABEL_LENGTH ? `${singleLine.slice(0, MAX_LABEL_LENGTH)}…` : singleLine;
	};

	const toLabel = (prompt: SavedPrompt, index: number) => `${index + 1}. ${truncate(prompt.text)}`;

	pi.on("input", async (event, ctx) => {
		const delivery = awaitingIdleInput;
		awaitingIdleInput = undefined;
		const matchesIdleDelivery =
			event.source === "extension" &&
			ctx.isIdle() &&
			delivery !== undefined &&
			event.text.includes(delivery.marker);
		if (matchesIdleDelivery) {
			pendingIdleInputs.push(delivery);
			latestIdleInput = delivery;
			return;
		}

		latestIdleInput = undefined;
		const matchesFollowUp = pendingDeliveries.some(
			(pending) => !pending.idle && event.text.includes(pending.marker),
		);
		if (!matchesFollowUp) clearDequeuedFollowUps(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		let delivery = pendingIdleInputs.find((pending) => event.prompt.includes(pending.marker));
		// If another input handler replaced the text, lifecycle order is safe only
		// while this is the sole idle input waiting to start and the turn is not
		// another tracked delivery's, e.g. an earlier-queued follow-up dequeued first.
		if (
			delivery === undefined &&
			pendingIdleInputs.length === 1 &&
			latestIdleInput === pendingIdleInputs[0] &&
			!pendingDeliveries.some((pending) => event.prompt.includes(pending.marker))
		) {
			delivery = latestIdleInput;
		}
		if (delivery !== undefined) acknowledge(delivery);
		else latestIdleInput = undefined;
		clearDequeuedFollowUps(ctx);
	});

	pi.on("message_start", async (event) => {
		const message = event.message;
		if (message.role !== "user" || !("content" in message) || !Array.isArray(message.content)) return;
		const content = message.content;

		const deliveries = pendingDeliveries.filter((delivery) =>
			content.some((part) => part.type === "text" && part.text.includes(delivery.marker)),
		);

		// Strip even an orphaned marker so internal tracking never reaches session
		// history or the model after an extension reload or state reconstruction.
		message.content = content.map((part) =>
			part.type === "text" ? { ...part, text: part.text.replace(DELIVERY_MARKER_PATTERN, "") } : part,
		);
		for (const delivery of deliveries) acknowledge(delivery);
	});

	pi.registerCommand("later", {
		description: "Save a prompt for later, or run a saved prompt",
		handler: async (args, ctx) => {
			clearDequeuedFollowUps(ctx);
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

				// Authentication can yield while another turn begins. Only use an idle
				// send if the agent is still idle; otherwise use a race-safe follow-up.
				if (ctx.isIdle()) {
					// ExtensionAPI.sendUserMessage() is fire-and-forget. before_agent_start
					// acknowledges an immediate turn, while followUp keeps the send safe if
					// streaming starts during asynchronous input handlers.
					const delivery = createDelivery(prompt, true);
					awaitingIdleInput = delivery;
					pi.sendUserMessage(`${prompt.text}${delivery.marker}`, { deliverAs: "followUp" });
					return;
				}
			}

			// Keep the prompt in the list until its marked follow-up user message
			// actually starts, so an undelivered follow-up is not lost.
			queueFollowUp(prompt);
			ctx.ui.notify("Queued as follow-up", "info");
		},
	});
}
