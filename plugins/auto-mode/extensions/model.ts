import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { downloadFileToCacheDir, getHFHubCachePath, getRepoFolderName } from "@huggingface/hub";

export const CLASSIFIER_REPOSITORY = "inclusionAI/SingGuard-NSFA-9B-GGUF";
export const CLASSIFIER_FILE = "Sing-Guard-9B-Q4_K_M.gguf";
export const CLASSIFIER_MODEL = `${CLASSIFIER_REPOSITORY}:Q4_K_M`;

type ModelDownloader = typeof downloadFileToCacheDir;

interface DownloadClassifierModelOptions {
	cacheDir?: string;
	download?: ModelDownloader;
	signal?: AbortSignal;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function findCachedClassifierModel(cacheDir = getHFHubCachePath()): Promise<string | undefined> {
	const snapshotsDir = join(
		cacheDir,
		getRepoFolderName({ name: CLASSIFIER_REPOSITORY, type: "model" }),
		"snapshots",
	);

	let snapshots;
	try {
		snapshots = await readdir(snapshotsDir, { withFileTypes: true });
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}

	for (const snapshot of snapshots) {
		if (!snapshot.isDirectory()) continue;
		const path = join(snapshotsDir, snapshot.name, CLASSIFIER_FILE);
		try {
			if ((await stat(path)).isFile()) return path;
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}
	return undefined;
}

/** Download the classifier model into the Hugging Face cache. */
export async function downloadClassifierModel(options: DownloadClassifierModelOptions = {}): Promise<string> {
	const cacheDir = options.cacheDir ?? getHFHubCachePath();
	const fetchWithSignal: typeof fetch | undefined = options.signal
		? (input, init) => fetch(input, { ...init, signal: options.signal })
		: undefined;
	return (options.download ?? downloadFileToCacheDir)({
		repo: { name: CLASSIFIER_REPOSITORY, type: "model" },
		path: CLASSIFIER_FILE,
		cacheDir,
		...(fetchWithSignal && { fetch: fetchWithSignal }),
	});
}
