import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	CLASSIFIER_MODELS,
	DEFAULT_CLASSIFIER_MODEL,
} from "../extensions/model.ts";
import {
	loadClassifierModelPreference,
	saveClassifierModelPreference,
} from "../extensions/preferences.ts";

function fixture(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "pi-auto-mode-preferences-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return join(directory, "agent", "auto-mode-settings.json");
}

test("the smallest model is used before a preference is saved", (t) => {
	assert.equal(loadClassifierModelPreference(fixture(t)), DEFAULT_CLASSIFIER_MODEL);
});

test("the selected model is restored after a restart", (t) => {
	const path = fixture(t);
	const model = CLASSIFIER_MODELS.find((candidate) => candidate.size === "4B");
	assert.ok(model);

	saveClassifierModelPreference(model, path);

	assert.equal(loadClassifierModelPreference(path), model);
});

test("an invalid saved preference falls back to the smallest model", (t) => {
	const path = fixture(t);
	saveClassifierModelPreference(DEFAULT_CLASSIFIER_MODEL, path);
	writeFileSync(path, JSON.stringify({ model: "unsupported" }));

	assert.equal(loadClassifierModelPreference(path), DEFAULT_CLASSIFIER_MODEL);
});
