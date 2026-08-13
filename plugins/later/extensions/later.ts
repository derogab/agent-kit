import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "later";
const MAX_LABEL_LENGTH = 80;

export default function (pi: ExtensionAPI) {
	// Saved prompts, oldest first. Reconstructed from session entries.
	let prompts: string[] = [];

	const reconstructState = (ctx: ExtensionContext) => {
		prompts = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const data = entry.data as { prompts?: string[] } | undefined;
				// Clone: entries are live references, and prompts is mutated in place later
				prompts = [...(data?.prompts ?? [])];
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	const persist = () => {
		pi.appendEntry(ENTRY_TYPE, { prompts: [...prompts] });
	};

	const toLabel = (prompt: string, index: number) => {
		const singleLine = prompt.replace(/\s+/g, " ").trim();
		const truncated =
			singleLine.length > MAX_LABEL_LENGTH ? `${singleLine.slice(0, MAX_LABEL_LENGTH)}…` : singleLine;
		return `${index + 1}. ${truncated}`;
	};

	pi.registerCommand("later", {
		description: "Save a prompt for later, or run a saved prompt",
		handler: async (args, ctx) => {
			const text = args.trim();

			// /later <prompt>: save it for later
			if (text) {
				prompts.push(text);
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

			prompts.splice(index, 1);
			persist();

			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("Queued as follow-up", "info");
			}
		},
	});
}
