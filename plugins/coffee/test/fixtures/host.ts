import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import coffee from "../../extensions/coffee.ts";

const handlers = new Map<string, (event: any, ctx: ExtensionContext) => void>();
const ctx = { hasUI: false } as ExtensionContext;
coffee({
	on: (event: string, handler: (event: any, ctx: ExtensionContext) => void) => handlers.set(event, handler),
} as unknown as ExtensionAPI);

const start = () => handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
const stop = () => handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);

process.on("message", (message) => {
	if (message === "shutdown") stop();
	if (message === "reload") {
		stop();
		start();
	}
	if (message === "exit") process.exit(0);
	if (message === "disconnect") {
		process.disconnect!();
		return;
	}
	process.send!("ready");
});

start();
process.send!("ready");
