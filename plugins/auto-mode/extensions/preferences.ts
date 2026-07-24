import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CLASSIFIER_MODELS,
	DEFAULT_CLASSIFIER_MODEL,
	type ClassifierModel,
} from "./model.ts";

const PREFERENCES_PATH = join(getAgentDir(), "auto-mode-settings.json");

export function loadClassifierModelPreference(path = PREFERENCES_PATH): ClassifierModel {
	try {
		const preferences = JSON.parse(readFileSync(path, "utf8")) as { model?: unknown };
		return (
			CLASSIFIER_MODELS.find((model) => model.size === preferences.model) ??
			DEFAULT_CLASSIFIER_MODEL
		);
	} catch {
		return DEFAULT_CLASSIFIER_MODEL;
	}
}

export function saveClassifierModelPreference(
	model: ClassifierModel,
	path = PREFERENCES_PATH,
): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ model: model.size }, null, 2)}\n`, "utf8");
}
