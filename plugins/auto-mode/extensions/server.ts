import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CLASSIFIER_ALIAS,
	downloadClassifierModel,
	findCachedClassifierModel,
	type ClassifierModel,
	type ClassifierModelSize,
} from "./model.ts";
import {
	loadClassifierModelPreference,
	saveClassifierModelPreference,
} from "./preferences.ts";
import {
	isProcessAlive as defaultIsProcessAlive,
	joinServerRegistry,
	leaveServerRegistry,
	type LeaveResult,
} from "./registry.ts";

const CLASSIFIER_HOST = "127.0.0.1";
const HEALTH_CHECK_INTERVAL_MS = 250;
const HEALTH_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const RESTART_DELAY_MAX_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

type SpawnServer = (command: string, args: readonly string[]) => ChildProcess;

export interface ClassifierServerDependencies {
	downloadModel?: typeof downloadClassifierModel;
	fetch?: typeof fetch;
	findCachedModel?: typeof findCachedClassifierModel;
	findFreePort?: typeof findFreePort;
	healthCheckIntervalMs?: number;
	healthCheckTimeoutMs?: number;
	isProcessAlive?: (pid: number) => boolean;
	killProcess?: (pid: number, signal: NodeJS.Signals) => void;
	loadModel?: typeof loadClassifierModelPreference;
	registryDirectory?: string;
	restartDelayMs?: number;
	saveModel?: typeof saveClassifierModelPreference;
	spawnServer?: SpawnServer;
}

export interface ClassifierServer {
	ensureReady(signal?: AbortSignal): Promise<string>;
	getAddress(): string | undefined;
	getModel(): ClassifierModel;
	onAddressChange(listener: (address: string | undefined) => void): () => void;
	selectModel(model: ClassifierModel, signal?: AbortSignal): Promise<void>;
	stop(): Promise<void>;
}

function abortError(): DOMException {
	return new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}

		const finish = () => {
			signal?.removeEventListener("abort", handleAbort);
			resolve();
		};
		const timer = setTimeout(finish, milliseconds);
		const handleAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", handleAbort);
			reject(abortError());
		};
		signal?.addEventListener("abort", handleAbort, { once: true });
	});
}

async function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw abortError();

	return new Promise<T>((resolve, reject) => {
		const handleAbort = () => reject(abortError());
		signal.addEventListener("abort", handleAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", handleAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", handleAbort);
				reject(error);
			},
		);
	});
}

async function reserveFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const reservation = createServer();
		reservation.unref();
		reservation.once("error", reject);
		reservation.listen({ host: CLASSIFIER_HOST, port: 0, exclusive: true }, () => {
			const address = reservation.address();
			if (!address || typeof address === "string") {
				reservation.close();
				reject(new Error("could not allocate a local port"));
				return;
			}
			reservation.close((error) => {
				if (error) reject(error);
				else resolve(address.port);
			});
		});
	});
}

export async function findFreePort(): Promise<number> {
	const port = await reserveFreePort();
	return port === 8080 ? findFreePort() : port;
}

function spawnClassifierServer(command: string, args: readonly string[]): ChildProcess {
	// Detached: other Pi instances may share this server, so it must survive this
	// instance's exit and stay out of its process group when the user hits Ctrl+C.
	const serverProcess = spawn(command, [...args], { detached: true, stdio: "ignore" });
	serverProcess.unref();
	return serverProcess;
}

async function waitUntilHealthy(
	healthEndpoint: string,
	isRunning: () => boolean,
	fetchHealth: typeof fetch,
	signal: AbortSignal,
	intervalMs = HEALTH_CHECK_INTERVAL_MS,
	timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	do {
		if (!isRunning()) {
			throw new Error("llama serve exited before it became ready");
		}
		try {
			if ((await fetchHealth(healthEndpoint, { signal })).ok) return;
		} catch (error) {
			if (signal.aborted) throw error;
		}
		await sleep(intervalMs, signal);
	} while (Date.now() < deadline);
	throw new Error("llama serve did not become ready in time");
}

async function stopProcess(serverProcess: ChildProcess): Promise<void> {
	if (serverProcess.exitCode !== null) return;
	const exited = new Promise<void>((resolve) => {
		serverProcess.once("exit", () => resolve());
	});
	serverProcess.kill("SIGTERM");
	await Promise.race([exited, sleep(SHUTDOWN_TIMEOUT_MS)]);
	if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
}

/** Stop a shared server another Pi instance spawned, so only its pid is known. */
async function stopProcessById(
	pid: number,
	isAlive: (pid: number) => boolean,
	kill: (pid: number, signal: NodeJS.Signals) => void,
): Promise<void> {
	try {
		kill(pid, "SIGTERM");
	} catch {
		return; // Already gone.
	}
	const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
	while (isAlive(pid)) {
		if (Date.now() >= deadline) {
			try {
				kill(pid, "SIGKILL");
			} catch {
				// Exited between the liveness check and the signal.
			}
			return;
		}
		await sleep(HEALTH_CHECK_INTERVAL_MS);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerClassifierServer(
	pi: ExtensionAPI,
	dependencies: ClassifierServerDependencies = {},
): ClassifierServer {
	const downloadModel = dependencies.downloadModel ?? downloadClassifierModel;
	const fetchHealth = dependencies.fetch ?? fetch;
	const findCachedModel = dependencies.findCachedModel ?? findCachedClassifierModel;
	const getFreePort = dependencies.findFreePort ?? findFreePort;
	const healthCheckIntervalMs =
		dependencies.healthCheckIntervalMs ?? HEALTH_CHECK_INTERVAL_MS;
	const healthCheckTimeoutMs = dependencies.healthCheckTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
	const isAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
	const killProcess =
		dependencies.killProcess ??
		((pid: number, killSignal: NodeJS.Signals) => {
			process.kill(pid, killSignal);
		});
	const loadModel = dependencies.loadModel ?? loadClassifierModelPreference;
	const launchServer = dependencies.spawnServer ?? spawnClassifierServer;
	const firstRestartDelay = dependencies.restartDelayMs ?? 1_000;
	const registryDependencies = {
		directory: dependencies.registryDirectory,
		isProcessAlive: isAlive,
	};
	const saveModel = dependencies.saveModel ?? saveClassifierModelPreference;

	let active = false;
	let address: string | undefined;
	let sessionActive = false;
	let generation = 0;
	let endpoint: string | undefined;
	let joined: { pid: number; port: number; size: ClassifierModelSize } | undefined;
	let ownedProcess: ChildProcess | undefined;
	let restartAttempts = 0;
	let restartTimer: NodeJS.Timeout | undefined;
	let sessionAbort: AbortController | undefined;
	let sessionContext: ExtensionContext | undefined;
	let selectedModel = loadModel();
	let startup: Promise<string> | undefined;
	const addressListeners = new Set<(address: string | undefined) => void>();

	function setEndpoint(value: string | undefined): void {
		endpoint = value;
		const nextAddress = value === undefined ? undefined : new URL(value).host;
		if (nextAddress === address) return;
		address = nextAddress;
		for (const listener of addressListeners) {
			try {
				listener(address);
			} catch {
				// Listener failures must not interrupt the server lifecycle.
			}
		}
	}

	function scheduleRestart(): void {
		if (!sessionActive || !active || restartTimer) return;
		const delay = Math.min(firstRestartDelay * 2 ** restartAttempts, RESTART_DELAY_MAX_MS);
		restartAttempts += 1;
		restartTimer = setTimeout(() => {
			restartTimer = undefined;
			if (!active) return;
			void start().catch(() => scheduleRestart());
		}, delay);
		restartTimer.unref();
	}

	async function startServer(currentGeneration: number, signal: AbortSignal): Promise<string> {
		const model = selectedModel;
		let modelPath = await findCachedModel(model);
		if (!modelPath) {
			if (!active || currentGeneration !== generation || signal.aborted) throw abortError();
			sessionContext?.ui.notify("Downloading the auto-mode classifier model in the background...", "info");
			modelPath = await downloadModel(model, { signal });
		}
		if (!active || currentGeneration !== generation || signal.aborted) throw abortError();

		let ready = false;
		let ended = false;
		let serverProcess: ChildProcess | undefined;
		let startupFailure: Promise<never> | undefined;
		let membership: { pid: number; port: number; size: ClassifierModelSize } | undefined;

		try {
			// Attach to a server another Pi instance already runs for this model, or spawn one.
			const server = await joinServerRegistry(
				model.size,
				async () => {
					const port = await getFreePort();
					const child = launchServer("llama", [
						"serve",
						"--host",
						CLASSIFIER_HOST,
						"--port",
						String(port),
						"--model",
						modelPath,
						"--alias",
						CLASSIFIER_ALIAS,
					]);
					serverProcess = child;
					ownedProcess = child;
					startupFailure = new Promise<never>((_resolve, reject) => {
						child.once("error", (error) => {
							ended = true;
							if (ownedProcess === child) {
								ownedProcess = undefined;
								setEndpoint(undefined);
							}
							if (ready && active && currentGeneration === generation) scheduleRestart();
							reject(error);
						});
						child.once("exit", (code, exitSignal) => {
							ended = true;
							if (ownedProcess === child) {
								ownedProcess = undefined;
								setEndpoint(undefined);
							}
							if (active && currentGeneration === generation) scheduleRestart();
							reject(
								new Error(
									`llama serve exited${code === null ? "" : ` with code ${code}`}${
										exitSignal ? ` (${exitSignal})` : ""
									}`,
								),
							);
						});
					});
					// The failure may fire before the race below consumes it, e.g. when this
					// startup attempt is aborted first; never leave the rejection unhandled.
					startupFailure.catch(() => {});
					return { pid: child.pid, port };
				},
				registryDependencies,
			);
			if (server.pid !== undefined) {
				membership = { pid: server.pid, port: server.port, size: model.size };
				// Publish membership before the health wait so a concurrent stop() releases
				// this attempt through the registry refcount instead of unconditionally
				// killing a server that another instance may have joined in the meantime.
				joined = membership;
			}
			const classifierEndpoint = `http://${CLASSIFIER_HOST}:${server.port}/v1/chat/completions`;

			if (!active || currentGeneration !== generation || signal.aborted) throw abortError();

			const child = serverProcess;
			const isRunning = child
				? () => child.exitCode === null
				: () => isAlive(server.pid as number);
			const healthy = waitUntilHealthy(
				`http://${CLASSIFIER_HOST}:${server.port}/health`,
				isRunning,
				fetchHealth,
				signal,
				healthCheckIntervalMs,
				healthCheckTimeoutMs,
			);
			await (startupFailure ? Promise.race([healthy, startupFailure]) : healthy);
			if (ended || !active || currentGeneration !== generation || signal.aborted) throw abortError();

			ready = true;
			restartAttempts = 0;
			setEndpoint(classifierEndpoint);
			return classifierEndpoint;
		} catch (error) {
			if (serverProcess && ownedProcess === serverProcess) {
				ownedProcess = undefined;
				setEndpoint(undefined);
			}
			if (membership && joined === membership) {
				// This attempt still owns its registration. When a concurrent stop() has
				// already taken and released it, releasing again could strip an instance
				// that re-registered in between.
				joined = undefined;
				if (isAbortError(error)) {
					// Aborted, not broken: another instance may share this server, so
					// release it through the registry refcount.
					await releaseServer(membership, serverProcess);
				} else if (serverProcess) {
					try {
						await leaveServerRegistry(membership.size, membership.pid, registryDependencies);
					} catch {
						// Best effort: a stale entry is corrected by the next join.
					}
					// An owned server that failed to start must not linger. It dies even when
					// others are registered: a hung-but-alive process would otherwise survive
					// every instance's refcounted cleanup and pin their retry loops forever.
					await stopProcess(serverProcess);
				} else {
					// A failed attach still releases through the refcount: with the owner gone
					// this instance may hold the last reference to a zombie, and the port probe
					// in releaseServer reclaims it without ever signalling a recycled pid.
					await releaseServer(membership, serverProcess);
				}
			} else if (!membership && serverProcess) {
				await stopProcess(serverProcess);
			}
			if (!isAbortError(error) && active && currentGeneration === generation) scheduleRestart();
			throw error;
		}
	}

	function start(): Promise<string> {
		if (endpoint) return Promise.resolve(endpoint);
		if (startup) return startup;
		if (!active || !sessionAbort) return Promise.reject(new Error("classifier server is not active"));

		const promise = startServer(generation, sessionAbort.signal);
		startup = promise;
		promise.then(
			() => {
				if (startup === promise) startup = undefined;
			},
			() => {
				if (startup === promise) startup = undefined;
			},
		);
		return promise;
	}

	/**
	 * Leave the shared server's registry entry and stop the server only when no other
	 * live Pi instance still uses it.
	 */
	async function releaseServer(
		membership: { pid: number; port: number; size: ClassifierModelSize },
		serverProcess: ChildProcess | undefined,
	): Promise<void> {
		let outcome: LeaveResult;
		try {
			outcome = await leaveServerRegistry(membership.size, membership.pid, registryDependencies);
		} catch {
			// Without the registry there is no way to tell who else uses the server;
			// only stop a process this instance spawned itself.
			outcome = serverProcess ? "unregistered" : "kept";
		}
		if (outcome === "kept") return;
		// A process this instance spawned itself is always safe to signal.
		if (serverProcess) {
			await stopProcess(serverProcess);
			return;
		}
		// A server known only by pid needs care: pids get recycled, and an "unregistered"
		// entry has already moved on. Even when this instance removed the final reference,
		// confirm the recorded port still answers so a recycled pid never gets the signal.
		if (outcome !== "removed") return;
		if (!(await isServerResponding(membership.port))) return;
		await stopProcessById(membership.pid, isAlive, killProcess);
	}

	/** Whether anything still answers on the shared server's recorded port. */
	async function isServerResponding(port: number): Promise<boolean> {
		try {
			await fetchHealth(`http://${CLASSIFIER_HOST}:${port}/health`, {
				signal: AbortSignal.timeout(1_000),
			});
			return true;
		} catch {
			return false;
		}
	}

	async function stop(): Promise<void> {
		active = false;
		generation += 1;
		sessionAbort?.abort();
		sessionAbort = undefined;
		setEndpoint(undefined);
		startup = undefined;
		restartAttempts = 0;
		if (restartTimer) {
			clearTimeout(restartTimer);
			restartTimer = undefined;
		}

		const serverProcess = ownedProcess;
		const membership = joined;
		ownedProcess = undefined;
		joined = undefined;
		if (membership) await releaseServer(membership, serverProcess);
		else if (serverProcess) await stopProcess(serverProcess);
	}

	/**
	 * A shared server owned by another instance dies without any child-process event
	 * here, so probe its pid and let the next start rediscover or respawn it.
	 */
	function dropVanishedSharedServer(): void {
		if (!joined || ownedProcess || !endpoint) return;
		if (isAlive(joined.pid)) return;
		joined = undefined;
		setEndpoint(undefined);
	}

	function ensureReady(signal?: AbortSignal): Promise<string> {
		if (!sessionActive) return Promise.reject(new Error("classifier server session is not active"));
		if (!active) {
			active = true;
			generation += 1;
			sessionAbort = new AbortController();
		}
		dropVanishedSharedServer();
		return withSignal(start(), signal);
	}

	async function selectModel(model: ClassifierModel, signal?: AbortSignal): Promise<void> {
		if (model.size === selectedModel.size) return;
		saveModel(model);
		const restart = active;
		selectedModel = model;
		await stop();
		if (restart) await ensureReady(signal);
	}

	pi.on("session_start", (_event, ctx) => {
		sessionActive = true;
		sessionContext = ctx;
		const readiness = ensureReady();
		const startGeneration = generation;
		void readiness.catch((error) => {
			if (sessionActive && active && generation === startGeneration && !isAbortError(error)) {
				ctx.ui.notify(`Auto-mode classifier could not start: ${errorMessage(error)}`, "error");
			}
		});
	});

	pi.on("session_shutdown", async () => {
		sessionActive = false;
		sessionContext = undefined;
		await stop();
	});

	return {
		ensureReady,
		getAddress: () => address,
		getModel: () => selectedModel,
		onAddressChange: (listener) => {
			addressListeners.add(listener);
			return () => {
				addressListeners.delete(listener);
			};
		},
		selectModel,
		stop,
	};
}
