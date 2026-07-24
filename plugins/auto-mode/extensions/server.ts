import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CLASSIFIER_ALIAS,
	DEFAULT_CLASSIFIER_MODEL,
	downloadClassifierModel,
	findCachedClassifierModel,
	type ClassifierModel,
} from "./model.ts";

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
	restartDelayMs?: number;
	spawnServer?: SpawnServer;
}

export interface ClassifierServer {
	ensureReady(signal?: AbortSignal): Promise<string>;
	getModel(): ClassifierModel;
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
	return spawn(command, [...args], { stdio: "ignore" });
}

async function waitUntilHealthy(
	healthEndpoint: string,
	serverProcess: ChildProcess,
	fetchHealth: typeof fetch,
	signal: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (serverProcess.exitCode !== null) {
			throw new Error(`llama-server exited with code ${serverProcess.exitCode}`);
		}
		try {
			if ((await fetchHealth(healthEndpoint, { signal })).ok) return;
		} catch (error) {
			if (signal.aborted) throw error;
		}
		await sleep(HEALTH_CHECK_INTERVAL_MS, signal);
	}
	throw new Error("llama-server did not become ready in time");
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
	const launchServer = dependencies.spawnServer ?? spawnClassifierServer;
	const firstRestartDelay = dependencies.restartDelayMs ?? 1_000;

	let active = false;
	let sessionActive = false;
	let generation = 0;
	let endpoint: string | undefined;
	let ownedProcess: ChildProcess | undefined;
	let restartAttempts = 0;
	let restartTimer: NodeJS.Timeout | undefined;
	let sessionAbort: AbortController | undefined;
	let sessionContext: ExtensionContext | undefined;
	let selectedModel = DEFAULT_CLASSIFIER_MODEL;
	let startup: Promise<string> | undefined;

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

		const port = await getFreePort();
		if (!active || currentGeneration !== generation || signal.aborted) throw abortError();

		const serverProcess = launchServer("llama-server", [
			"--host",
			CLASSIFIER_HOST,
			"--port",
			String(port),
			"--model",
			modelPath,
			"--alias",
			CLASSIFIER_ALIAS,
		]);
		ownedProcess = serverProcess;
		const classifierEndpoint = `http://${CLASSIFIER_HOST}:${port}/v1/chat/completions`;
		let ready = false;
		let ended = false;

		const startupFailure = new Promise<never>((_resolve, reject) => {
			serverProcess.once("error", (error) => {
				ended = true;
				if (ownedProcess === serverProcess) {
					ownedProcess = undefined;
					endpoint = undefined;
				}
				if (ready && active && currentGeneration === generation) scheduleRestart();
				reject(error);
			});
			serverProcess.once("exit", (code, exitSignal) => {
				ended = true;
				if (ownedProcess === serverProcess) {
					ownedProcess = undefined;
					endpoint = undefined;
				}
				if (active && currentGeneration === generation) scheduleRestart();
				reject(
					new Error(
						`llama-server exited${code === null ? "" : ` with code ${code}`}${
							exitSignal ? ` (${exitSignal})` : ""
						}`,
					),
				);
			});
		});

		await Promise.race([
			waitUntilHealthy(
				`http://${CLASSIFIER_HOST}:${port}/health`,
				serverProcess,
				fetchHealth,
				signal,
			),
			startupFailure,
		]);
		if (ended || !active || currentGeneration !== generation || signal.aborted) throw abortError();

		ready = true;
		restartAttempts = 0;
		endpoint = classifierEndpoint;
		return classifierEndpoint;
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

	async function stop(): Promise<void> {
		active = false;
		generation += 1;
		sessionAbort?.abort();
		sessionAbort = undefined;
		endpoint = undefined;
		startup = undefined;
		restartAttempts = 0;
		if (restartTimer) {
			clearTimeout(restartTimer);
			restartTimer = undefined;
		}

		const serverProcess = ownedProcess;
		ownedProcess = undefined;
		if (serverProcess) await stopProcess(serverProcess);
	}

	function ensureReady(signal?: AbortSignal): Promise<string> {
		if (!sessionActive) return Promise.reject(new Error("classifier server session is not active"));
		if (!active) {
			active = true;
			generation += 1;
			sessionAbort = new AbortController();
		}
		return withSignal(start(), signal);
	}

	async function selectModel(model: ClassifierModel, signal?: AbortSignal): Promise<void> {
		if (model.size === selectedModel.size) return;
		const restart = active;
		await stop();
		selectedModel = model;
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
		getModel: () => selectedModel,
		selectModel,
		stop,
	};
}
