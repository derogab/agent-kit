import assert from "node:assert/strict";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const macOnly = { skip: process.platform !== "darwin", timeout: 20_000 };

const waitFor = async (condition: () => boolean, description: string) => {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
		await delay(50);
	}
};

const running = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
};

const childrenOf = (pid: number): number[] => {
	try {
		return execFileSync("/usr/bin/pgrep", ["-P", String(pid), "-x", "caffeinate"], { encoding: "utf8" })
			.trim().split(/\s+/).map(Number);
	} catch (error) {
		if ((error as { status?: number }).status === 1) return [];
		throw error;
	}
};

const send = async (host: ChildProcess, message: string) => {
	const ready = once(host, "message", { signal: AbortSignal.timeout(5_000) });
	host.send(message);
	await ready;
};

const startHost = async (t: TestContext) => {
	const host = fork(new URL("./fixtures/host.ts", import.meta.url), {
		execArgv: ["--experimental-strip-types"],
		silent: true,
	});
	const caffeinatePids = new Set<number>();
	let stderr = "";
	host.stderr!.on("data", (chunk) => { stderr += chunk; });
	t.after(async () => {
		if (host.exitCode === null && host.signalCode === null) {
			const exited = once(host, "exit");
			host.kill("SIGKILL");
			await exited;
		}
		// Only clean up children created by this test, even if an assertion fails.
		for (const pid of caffeinatePids) {
			if (running(pid)) process.kill(pid, "SIGKILL");
		}
	});
	await once(host, "message", { signal: AbortSignal.timeout(5_000) });

	const childPid = () => {
		const pids = childrenOf(host.pid!);
		for (const pid of pids) caffeinatePids.add(pid);
		assert.equal(pids.length, 1, `Expected one caffeinate child. ${stderr}`);
		return pids[0];
	};
	const pid = childPid();
	await delay(100);
	assert.ok(running(pid), `caffeinate must stay alive while its host runs. ${stderr}`);
	return { host, pid, childPid };
};

test("macOS: releases its child on session shutdown without closing the host", macOnly, async (t) => {
	const { host, pid } = await startHost(t);
	await send(host, "shutdown");
	await waitFor(() => !running(pid), "caffeinate to exit after session shutdown");
	assert.ok(running(host.pid!));
});

test("macOS: reload replaces the old child without accumulating processes", macOnly, async (t) => {
	const { host, pid, childPid } = await startHost(t);
	await send(host, "reload");
	await waitFor(() => !running(pid), "the old caffeinate to exit");
	const replacement = childPid();
	assert.notEqual(replacement, pid);
	assert.ok(running(replacement));
	await send(host, "shutdown");
	await waitFor(() => !running(replacement), "the replacement caffeinate to exit");
});

for (const termination of ["exit", "disconnect", "SIGTERM", "SIGHUP", "SIGKILL"] as const) {
	test(`macOS: ${termination} releases only the terminating host's protection`, macOnly, async (t) => {
		const first = await startHost(t);
		const second = await startHost(t);
		const exited = once(first.host, "exit", { signal: AbortSignal.timeout(5_000) });
		if (termination === "exit" || termination === "disconnect") first.host.send(termination);
		else first.host.kill(termination);
		await exited;
		await waitFor(() => !running(first.pid), "the terminated host's caffeinate to exit");
		assert.ok(running(second.pid), "The other host must retain its protection");
		await send(second.host, "shutdown");
		await waitFor(() => !running(second.pid), "the last caffeinate to exit");
	});
}
