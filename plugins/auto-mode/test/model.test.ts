import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getRepoFolderName } from "@huggingface/hub";
import {
	CLASSIFIER_MODELS,
	DEFAULT_CLASSIFIER_MODEL,
	downloadClassifierModel,
	findCachedClassifierModel,
	type ClassifierModel,
} from "../extensions/model.ts";

function cacheFixture(model: ClassifierModel = DEFAULT_CLASSIFIER_MODEL) {
	const cacheDir = mkdtempSync(join(tmpdir(), "pi-auto-mode-cache-test-"));
	const modelPath = join(
		cacheDir,
		getRepoFolderName({ name: model.repository, type: "model" }),
		"snapshots",
		"test-revision",
		model.file,
	);
	return { cacheDir, modelPath };
}

test("the supported Q4 models use the verified repositories and filenames", () => {
	assert.deepEqual(CLASSIFIER_MODELS, [
		{
			size: "0.8B",
			repository: "inclusionAI/SingGuard-NSFA-0.8B-GGUF",
			file: "Sing-Guard-0.8B-Q4_K_M.gguf",
		},
		{
			size: "2B",
			repository: "inclusionAI/SingGuard-NSFA-2B-GGUF",
			file: "Sing-Guard-2B-Q4_K_M.gguf",
		},
		{
			size: "4B",
			repository: "inclusionAI/SingGuard-NSFA-4B-GGUF",
			file: "Sing-Guard-4B-Q4_K_M.gguf",
		},
		{
			size: "9B",
			repository: "inclusionAI/SingGuard-NSFA-9B-GGUF",
			file: "Sing-Guard-9B-Q4_K_M.gguf",
		},
	]);
	assert.equal(DEFAULT_CLASSIFIER_MODEL.size, "0.8B");
});

test("an existing model is reused from the Hugging Face cache", async (t) => {
	const { cacheDir, modelPath } = cacheFixture();
	t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
	mkdirSync(join(modelPath, ".."), { recursive: true });
	writeFileSync(modelPath, "fixture");

	const result = await findCachedClassifierModel(DEFAULT_CLASSIFIER_MODEL, cacheDir);

	assert.equal(result, modelPath);
});

test("the configured standard Hugging Face cache is used by default", async (t) => {
	const { cacheDir, modelPath } = cacheFixture();
	const previousCache = process.env.HF_HUB_CACHE;
	t.after(() => {
		if (previousCache === undefined) delete process.env.HF_HUB_CACHE;
		else process.env.HF_HUB_CACHE = previousCache;
		rmSync(cacheDir, { recursive: true, force: true });
	});
	process.env.HF_HUB_CACHE = cacheDir;
	mkdirSync(join(modelPath, ".."), { recursive: true });
	writeFileSync(modelPath, "fixture");

	assert.equal(await findCachedClassifierModel(DEFAULT_CLASSIFIER_MODEL), modelPath);
});

test("a missing model is not found in the Hugging Face cache", async (t) => {
	const { cacheDir } = cacheFixture();
	t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
	assert.equal(await findCachedClassifierModel(DEFAULT_CLASSIFIER_MODEL, cacheDir), undefined);
});

test("the model is downloaded into the Hugging Face cache when requested", async (t) => {
	const { cacheDir, modelPath } = cacheFixture();
	t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
	let downloadOptions: Record<string, unknown> | undefined;

	const result = await downloadClassifierModel(DEFAULT_CLASSIFIER_MODEL, {
		cacheDir,
		download: (async (options: Record<string, unknown>) => {
			downloadOptions = options;
			return modelPath;
		}) as never,
	});

	assert.equal(result, modelPath);
	assert.ok(downloadOptions);
	assert.deepEqual(downloadOptions.repo, {
		name: DEFAULT_CLASSIFIER_MODEL.repository,
		type: "model",
	});
	assert.equal(downloadOptions.path, DEFAULT_CLASSIFIER_MODEL.file);
	assert.equal(downloadOptions.cacheDir, cacheDir);
});
