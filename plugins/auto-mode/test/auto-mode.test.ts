import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-auto-mode-composition-test-"));
const agentDirectory = join(fixtureRoot, "agent");
const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDirectory;
mkdirSync(agentDirectory);

const { default: autoMode } = await import("../extensions/auto-mode.ts");

after(() => {
	if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
	rmSync(fixtureRoot, { recursive: true, force: true });
});

test("the composition root connects the server, controls, and guard", async () => {
	let toolCallHandler: ((event: any, context: any) => Promise<any>) | undefined;
	let sessionStartHandlers = 0;
	let sessionShutdownHandlers = 0;
	let command: { handler: (args: string, context: any) => Promise<void> } | undefined;

	autoMode({
		on(event: string, callback: typeof toolCallHandler) {
			if (event === "tool_call") toolCallHandler = callback;
			if (event === "session_start") sessionStartHandlers += 1;
			if (event === "session_shutdown") sessionShutdownHandlers += 1;
		},
		registerCommand(name: string, options: typeof command) {
			assert.equal(name, "auto-mode");
			command = options;
		},
	} as never);

	assert.ok(toolCallHandler);
	assert.equal(sessionStartHandlers, 2);
	assert.equal(sessionShutdownHandlers, 2);
	assert.ok(command);

	let status: string | undefined;
	const selections = ["Status", "Disable auto-mode"];
	await command.handler("", {
		signal: undefined,
		hasUI: true,
		ui: {
			notify() {},
			select: async () => selections.shift(),
			setStatus: (_key: string, text: string | undefined) => {
				status = text;
			},
			theme: { fg: (_color: string, text: string) => text },
		},
	});

	writeFileSync(join(agentDirectory, "auto-mode.json"), JSON.stringify({ deny: ["^rm -rf /$"] }));
	const result = await toolCallHandler(
		{ type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "rm -rf /" } },
		{
			cwd: fixtureRoot,
			signal: undefined,
			hasUI: true,
			isProjectTrusted: () => false,
			ui: { confirm: async () => true },
		},
	);

	assert.equal(status, undefined);
	assert.equal(result, undefined);
});
