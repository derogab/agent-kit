import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getRepoFolderName } from "@huggingface/hub";
import {
	CLASSIFIER_FILE,
	CLASSIFIER_REPOSITORY,
	downloadClassifierModel,
	findCachedClassifierModel,
} from "../extensions/model.ts";

function cacheFixture() {
	const cacheDir = mkdtempSync(join(tmpdir(), "pi-auto-mode-cache-test-"));
	const modelPath = join(
		cacheDir,
		getRepoFolderName({ name: CLASSIFIER_REPOSITORY, type: "model" }),
		"snapshots",
		"test-revision",
		CLASSIFIER_FILE,
	);
	return { cacheDir, modelPath };
}

test("an existing model is reused from the Hugging Face cache", async (t) => {
	const { cacheDir, modelPath } = cacheFixture();
	t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
	mkdirSync(join(modelPath, ".."), { recursive: true });
	writeFileSync(modelPath, "fixture");

	const result = await findCachedClassifierModel(cacheDir);

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

	assert.equal(await findCachedClassifierModel(), modelPath);
});

test("a missing model is not found in the Hugging Face cache", async (t) => {
	const { cacheDir } = cacheFixture();
	t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
	assert.equal(await findCachedClassifierModel(cacheDir), undefined);
});

test("the model is downloaded into the Hugging Face cache when requested", async (t) => {
	const { cacheDir, modelPath } = cacheFixture();
	t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
	let downloadOptions: Record<string, unknown> | undefined;

	const result = await downloadClassifierModel({
		cacheDir,
		download: (async (options: Record<string, unknown>) => {
			downloadOptions = options;
			return modelPath;
		}) as never,
	});

	assert.equal(result, modelPath);
	assert.ok(downloadOptions);
	assert.deepEqual(downloadOptions.repo, { name: CLASSIFIER_REPOSITORY, type: "model" });
	assert.equal(downloadOptions.path, CLASSIFIER_FILE);
	assert.equal(downloadOptions.cacheDir, cacheDir);
});
