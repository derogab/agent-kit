import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { joinServerRegistry, leaveServerRegistry } from "../extensions/registry.ts";

const tempDirs: string[] = [];

after(() => {
	for (const directory of tempDirs) rmSync(directory, { force: true, recursive: true });
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "auto-mode-registry-"));
	tempDirs.push(directory);
	return directory;
}

function entryPath(directory: string): string {
	return join(directory, "auto-mode-server-0.8B.json");
}

function readEntry(directory: string) {
	return JSON.parse(readFileSync(entryPath(directory), "utf8"));
}

test("joining without a registered server spawns and records one", async () => {
	const directory = tempDir();

	const joined = await joinServerRegistry("0.8B", async () => ({ pid: 111, port: 49_200 }), {
		directory,
		isProcessAlive: () => true,
		selfPid: 42,
	});

	assert.deepEqual(joined, { owned: true, pid: 111, port: 49_200 });
	assert.deepEqual(readEntry(directory), { pid: 111, port: 49_200, users: [42] });
});

test("joining attaches to a live registered server without spawning", async () => {
	const directory = tempDir();
	writeFileSync(entryPath(directory), JSON.stringify({ pid: 111, port: 49_200, users: [42] }));
	let spawned = false;

	const joined = await joinServerRegistry(
		"0.8B",
		async () => {
			spawned = true;
			return { pid: 999, port: 1 };
		},
		{ directory, isProcessAlive: (pid) => pid === 111 || pid === 42, selfPid: 43 },
	);

	assert.equal(spawned, false);
	assert.deepEqual(joined, { owned: false, pid: 111, port: 49_200 });
	assert.deepEqual(readEntry(directory), { pid: 111, port: 49_200, users: [42, 43] });
});

test("joining drops dead users and replaces a dead server", async () => {
	const directory = tempDir();
	writeFileSync(entryPath(directory), JSON.stringify({ pid: 111, port: 49_200, users: [42] }));

	const joined = await joinServerRegistry("0.8B", async () => ({ pid: 222, port: 49_300 }), {
		directory,
		isProcessAlive: (pid) => pid !== 111 && pid !== 42,
		selfPid: 43,
	});

	assert.deepEqual(joined, { owned: true, pid: 222, port: 49_300 });
	assert.deepEqual(readEntry(directory), { pid: 222, port: 49_300, users: [43] });
});

test("a failed spawn records no registry entry", async () => {
	const directory = tempDir();

	const joined = await joinServerRegistry("0.8B", async () => ({ pid: undefined, port: 49_300 }), {
		directory,
		isProcessAlive: () => true,
		selfPid: 42,
	});

	assert.deepEqual(joined, { owned: true, pid: undefined, port: 49_300 });
	assert.equal(existsSync(entryPath(directory)), false);
});

test("leaving keeps the server for remaining live users", async () => {
	const directory = tempDir();
	writeFileSync(entryPath(directory), JSON.stringify({ pid: 111, port: 49_200, users: [42, 43] }));

	const outcome = await leaveServerRegistry("0.8B", 111, {
		directory,
		isProcessAlive: (pid) => pid === 111 || pid === 43,
		selfPid: 42,
	});

	assert.equal(outcome, "kept");
	assert.deepEqual(readEntry(directory), { pid: 111, port: 49_200, users: [43] });
});

test("the last live user removes the entry and stops the server", async () => {
	const directory = tempDir();
	writeFileSync(entryPath(directory), JSON.stringify({ pid: 111, port: 49_200, users: [42, 43] }));

	const outcome = await leaveServerRegistry("0.8B", 111, {
		directory,
		isProcessAlive: (pid) => pid === 111 || pid === 42,
		selfPid: 42,
	});

	assert.equal(outcome, "removed");
	assert.equal(existsSync(entryPath(directory)), false);
});

test("leaving a replaced entry reports it unregistered without touching it", async () => {
	const directory = tempDir();
	writeFileSync(entryPath(directory), JSON.stringify({ pid: 222, port: 49_300, users: [43] }));

	const outcome = await leaveServerRegistry("0.8B", 111, {
		directory,
		isProcessAlive: () => true,
		selfPid: 42,
	});

	assert.equal(outcome, "unregistered");
	assert.deepEqual(readEntry(directory), { pid: 222, port: 49_300, users: [43] });
});

test("leaving with a missing registry directory reports unregistered instead of spinning", async () => {
	const directory = join(tempDir(), "missing");

	const outcome = await leaveServerRegistry("0.8B", 111, {
		directory,
		isProcessAlive: () => true,
		selfPid: 42,
	});

	assert.equal(outcome, "unregistered");
});

test("a stale lock left by a crashed process is broken", async () => {
	const directory = tempDir();
	const lockPath = `${entryPath(directory)}.lock`;
	writeFileSync(lockPath, "");
	const past = new Date(Date.now() - 60_000);
	utimesSync(lockPath, past, past);

	const joined = await joinServerRegistry("0.8B", async () => ({ pid: 111, port: 49_200 }), {
		directory,
		isProcessAlive: () => true,
		selfPid: 42,
	});

	assert.deepEqual(joined, { owned: true, pid: 111, port: 49_200 });
	assert.equal(existsSync(lockPath), false);
});

test("a held lock makes registry access time out", async () => {
	const directory = tempDir();
	writeFileSync(`${entryPath(directory)}.lock`, "");

	await assert.rejects(
		joinServerRegistry("0.8B", async () => ({ pid: 111, port: 49_200 }), {
			directory,
			isProcessAlive: () => true,
			lockRetryMs: 10,
			lockTimeoutMs: 100,
			selfPid: 42,
		}),
		/timed out waiting for the auto-mode server registry lock/,
	);
	assert.equal(existsSync(entryPath(directory)), false);
});
