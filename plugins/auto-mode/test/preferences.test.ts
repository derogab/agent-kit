import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	CLASSIFIER_MODELS,
	DEFAULT_CLASSIFIER_MODEL,
} from "../extensions/model.ts";
import {
	loadClassifierModelPreference,
	loadEnabledPreference,
	saveClassifierModelPreference,
	saveEnabledPreference,
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

test("no model is remembered independently of the enabled preference", (t) => {
	const path = fixture(t);
	saveEnabledPreference(false, path);
	saveClassifierModelPreference(null, path);
	assert.equal(loadClassifierModelPreference(path), null);
	assert.equal(loadEnabledPreference(path), false);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { enabled: false, model: null });

	saveEnabledPreference(true, path);
	assert.equal(loadClassifierModelPreference(path), null);

	saveClassifierModelPreference(DEFAULT_CLASSIFIER_MODEL, path);
	assert.equal(loadClassifierModelPreference(path), DEFAULT_CLASSIFIER_MODEL);
	assert.equal(loadEnabledPreference(path), true);
});

test("auto-mode defaults to enabled for new and model-only settings", (t) => {
	const path = fixture(t);
	assert.equal(loadEnabledPreference(path), true);

	saveClassifierModelPreference(DEFAULT_CLASSIFIER_MODEL, path);
	assert.equal(loadEnabledPreference(path), true);
});

test("both disabled and enabled preferences are restored", (t) => {
	const path = fixture(t);
	for (const enabled of [false, true]) {
		saveEnabledPreference(enabled, path);
		assert.equal(loadEnabledPreference(path), enabled);
	}
});

test("saving either preference preserves the other and unrelated settings", (t) => {
	const path = fixture(t);
	saveEnabledPreference(false, path);
	writeFileSync(path, JSON.stringify({ enabled: false, extra: "preserved" }));
	const model = CLASSIFIER_MODELS.find((candidate) => candidate.size === "4B");
	assert.ok(model);

	saveClassifierModelPreference(model, path);
	assert.equal(loadEnabledPreference(path), false);

	saveEnabledPreference(true, path);
	assert.equal(loadClassifierModelPreference(path), model);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		enabled: true,
		extra: "preserved",
		model: "4B",
	});
});

test("invalid settings never implicitly disable auto-mode", (t) => {
	const path = fixture(t);
	saveEnabledPreference(false, path);
	for (const content of ["invalid JSON", "null", "[]", "false", '{"enabled":"false"}', '{"enabled":0}']) {
		writeFileSync(path, content);
		assert.equal(loadEnabledPreference(path), true, content);
		assert.equal(loadClassifierModelPreference(path), DEFAULT_CLASSIFIER_MODEL, content);
	}
});

test("an invalid saved preference falls back to the smallest model", (t) => {
	const path = fixture(t);
	saveClassifierModelPreference(DEFAULT_CLASSIFIER_MODEL, path);
	for (const model of [undefined, "unsupported", false, 0, {}]) {
		writeFileSync(path, JSON.stringify({ model }));
		assert.equal(loadClassifierModelPreference(path), DEFAULT_CLASSIFIER_MODEL);
	}
});
