import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { downloadFileToCacheDir, getHFHubCachePath, getRepoFolderName } from "@huggingface/hub";

export const CLASSIFIER_ALIAS = "auto-mode-classifier";
export const CLASSIFIER_MODEL_SIZES = ["0.8B", "2B", "4B", "9B"] as const;

export type ClassifierModelSize = (typeof CLASSIFIER_MODEL_SIZES)[number];

export interface ClassifierModel {
	file: string;
	repository: string;
	size: ClassifierModelSize;
}

export const CLASSIFIER_MODELS: readonly ClassifierModel[] = CLASSIFIER_MODEL_SIZES.map((size) => ({
	file: `Sing-Guard-${size}-Q4_K_M.gguf`,
	repository: `inclusionAI/SingGuard-NSFA-${size}-GGUF`,
	size,
}));

export const DEFAULT_CLASSIFIER_MODEL = CLASSIFIER_MODELS[0];

type ModelDownloader = typeof downloadFileToCacheDir;

interface DownloadClassifierModelOptions {
	cacheDir?: string;
	download?: ModelDownloader;
	signal?: AbortSignal;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function findCachedClassifierModel(
	model = DEFAULT_CLASSIFIER_MODEL,
	cacheDir = getHFHubCachePath(),
): Promise<string | undefined> {
	const snapshotsDir = join(
		cacheDir,
		getRepoFolderName({ name: model.repository, type: "model" }),
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
		const path = join(snapshotsDir, snapshot.name, model.file);
		try {
			if ((await stat(path)).isFile()) return path;
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}
	return undefined;
}

/** Download the classifier model into the Hugging Face cache. */
export async function downloadClassifierModel(
	model = DEFAULT_CLASSIFIER_MODEL,
	options: DownloadClassifierModelOptions = {},
): Promise<string> {
	const cacheDir = options.cacheDir ?? getHFHubCachePath();
	const fetchWithSignal: typeof fetch | undefined = options.signal
		? (input, init) => fetch(input, { ...init, signal: options.signal })
		: undefined;
	return (options.download ?? downloadFileToCacheDir)({
		repo: { name: model.repository, type: "model" },
		path: model.file,
		cacheDir,
		...(fetchWithSignal && { fetch: fetchWithSignal }),
	});
}
