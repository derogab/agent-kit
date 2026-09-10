import childProcess, { type ChildProcess } from "node:child_process";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let caffeinate: ChildProcess | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (os.platform() !== "darwin" || caffeinate) return;

		const warn = (message: string) => {
			const text = `coffee: ${message} Run /reload to retry.`;
			if (ctx.hasUI) ctx.ui.notify(text, "warning");
			else console.error(text);
		};

		try {
			// Each Pi owns its own assertions. -w also releases them after a crash or SIGKILL.
			const child = childProcess.spawn("/usr/bin/caffeinate", ["-d", "-i", "-w", String(process.pid)], {
				detached: true,
				stdio: "ignore",
			});
			caffeinate = child;

			child.once("error", (error) => {
				if (caffeinate !== child) return;
				caffeinate = undefined;
				warn(`Could not keep your Mac awake: ${error.message}.`);
			});
			child.once("exit", (code, signal) => {
				if (caffeinate !== child) return;
				caffeinate = undefined;
				warn(`Keep-awake protection stopped unexpectedly (${signal ?? `exit ${code}`}).`);
			});

			// Do not keep Pi's event loop or terminal open just to maintain the assertions.
			child.unref();
		} catch (error) {
			warn(`Could not keep your Mac awake: ${error instanceof Error ? error.message : String(error)}.`);
		}
	});

	pi.on("session_shutdown", () => {
		const child = caffeinate;
		caffeinate = undefined;
		child?.kill("SIGTERM");
	});
}
