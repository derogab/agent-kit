import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ClassifierModelSize } from "./model.ts";

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
// The lock is held for milliseconds, so one this old belongs to a crashed process.
const LOCK_STALE_MS = 30_000;

/** A classifier server another Pi instance may share, as recorded on disk. */
export interface JoinedServer {
	owned: boolean;
	pid: number | undefined;
	port: number;
}

interface RegistryEntry {
	pid: number;
	port: number;
	users: number[];
}

export interface ServerRegistryDependencies {
	directory?: string;
	isProcessAlive?: (pid: number) => boolean;
	lockRetryMs?: number;
	lockStaleMs?: number;
	lockTimeoutMs?: number;
	selfPid?: number;
}

/** Probe liveness with signal 0; EPERM means the process exists but belongs to another user. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function registryPath(directory: string, size: ClassifierModelSize): string {
	return join(directory, `auto-mode-server-${size}.json`);
}

function readEntry(path: string): RegistryEntry | undefined {
	let entry: RegistryEntry;
	try {
		entry = JSON.parse(readFileSync(path, "utf8")) as RegistryEntry;
	} catch {
		// A missing or corrupt entry means no shared server is registered.
		return undefined;
	}
	const valid =
		typeof entry?.pid === "number" &&
		typeof entry?.port === "number" &&
		Array.isArray(entry?.users) &&
		entry.users.every((user) => typeof user === "number");
	return valid ? entry : undefined;
}

function writeEntry(path: string, entry: RegistryEntry): void {
	// Write-then-rename so a process dying mid-write cannot leave a truncated entry
	// behind; the previous valid entry survives instead.
	const temporaryPath = `${path}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, path);
}

interface LockOptions {
	retryMs: number;
	staleMs: number;
	timeoutMs: number;
}

function lockOptions(dependencies: ServerRegistryDependencies): LockOptions {
	return {
		retryMs: dependencies.lockRetryMs ?? LOCK_RETRY_MS,
		staleMs: dependencies.lockStaleMs ?? LOCK_STALE_MS,
		timeoutMs: dependencies.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
	};
}

/** Serialize registry reads and writes across Pi instances via an exclusive lock file. */
async function withLock<T>(path: string, options: LockOptions, fn: () => Promise<T> | T): Promise<T> {
	const lockPath = `${path}.lock`;
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		try {
			writeFileSync(lockPath, "", { flag: "wx" });
			break;
		} catch (error) {
			// Anything but "the lock already exists" (missing directory, permissions)
			// will not resolve by waiting; surface it instead of spinning forever.
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let stale = false;
		try {
			stale = statSync(lockPath).mtimeMs < Date.now() - options.staleMs;
		} catch {
			// The lock vanished between attempts; fall through to the bounded retry.
		}
		if (stale) {
			rmSync(lockPath, { force: true });
			continue;
		}
		if (Date.now() >= deadline) {
			throw new Error("timed out waiting for the auto-mode server registry lock");
		}
		await new Promise((resolve) => setTimeout(resolve, options.retryMs));
	}
	try {
		return await fn();
	} finally {
		rmSync(lockPath, { force: true });
	}
}

/**
 * Attach to the registered classifier server for this model size, or spawn a new one.
 *
 * The registry entry refcounts the Pi instances using the server so the last one to
 * leave can shut it down. `spawnServer` runs under the registry lock and must only
 * start the process, not wait for it to become healthy; it may report an undefined
 * pid when spawning failed, in which case nothing is recorded.
 */
export async function joinServerRegistry(
	size: ClassifierModelSize,
	spawnServer: () => Promise<{ pid: number | undefined; port: number }>,
	dependencies: ServerRegistryDependencies = {},
): Promise<JoinedServer> {
	const directory = dependencies.directory ?? getAgentDir();
	const alive = dependencies.isProcessAlive ?? isProcessAlive;
	const selfPid = dependencies.selfPid ?? process.pid;
	mkdirSync(directory, { recursive: true });
	const path = registryPath(directory, size);
	return withLock(path, lockOptions(dependencies), async () => {
		const existing = readEntry(path);
		if (existing && alive(existing.pid)) {
			const users = [...new Set([...existing.users.filter(alive), selfPid])];
			writeEntry(path, { ...existing, users });
			return { owned: false, pid: existing.pid, port: existing.port };
		}
		const spawned = await spawnServer();
		if (spawned.pid !== undefined) {
			writeEntry(path, { pid: spawned.pid, port: spawned.port, users: [selfPid] });
		}
		return { owned: true, ...spawned };
	});
}

/**
 * How a departing instance left the registry:
 * - "kept": other live users remain, so the server must keep running.
 * - "removed": the caller removed the final reference and must stop the server.
 * - "unregistered": the entry was missing or already replaced; nothing references
 *   serverPid anymore, but it was never this caller's entry to stop.
 */
export type LeaveResult = "kept" | "removed" | "unregistered";

/** Drop this instance from the server's registry entry. */
export async function leaveServerRegistry(
	size: ClassifierModelSize,
	serverPid: number,
	dependencies: ServerRegistryDependencies = {},
): Promise<LeaveResult> {
	const directory = dependencies.directory ?? getAgentDir();
	const alive = dependencies.isProcessAlive ?? isProcessAlive;
	const selfPid = dependencies.selfPid ?? process.pid;
	mkdirSync(directory, { recursive: true });
	const path = registryPath(directory, size);
	return withLock<LeaveResult>(path, lockOptions(dependencies), () => {
		const entry = readEntry(path);
		if (!entry || entry.pid !== serverPid) return "unregistered";
		const users = entry.users.filter((user) => user !== selfPid && alive(user));
		if (users.length === 0) {
			rmSync(path, { force: true });
			return "removed";
		}
		writeEntry(path, { ...entry, users });
		return "kept";
	});
}
