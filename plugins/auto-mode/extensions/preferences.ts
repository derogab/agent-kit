import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CLASSIFIER_MODELS,
	DEFAULT_CLASSIFIER_MODEL,
	type ClassifierModel,
} from "./model.ts";

const PREFERENCES_PATH = join(getAgentDir(), "auto-mode-settings.json");

function loadPreferences(path: string): Record<string, unknown> {
	try {
		const preferences: unknown = JSON.parse(readFileSync(path, "utf8"));
		return preferences !== null && typeof preferences === "object" && !Array.isArray(preferences)
			? preferences as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
}

function savePreferences(preferences: Record<string, unknown>, path: string): void {
	const merged = { ...loadPreferences(path), ...preferences };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

export function loadEnabledPreference(path = PREFERENCES_PATH): boolean {
	return loadPreferences(path).enabled !== false;
}

export function saveEnabledPreference(enabled: boolean, path = PREFERENCES_PATH): void {
	savePreferences({ enabled }, path);
}

export function loadClassifierModelPreference(path = PREFERENCES_PATH): ClassifierModel {
	const preferences = loadPreferences(path);
	return (
		CLASSIFIER_MODELS.find((model) => model.size === preferences.model) ??
		DEFAULT_CLASSIFIER_MODEL
	);
}

export function saveClassifierModelPreference(
	model: ClassifierModel,
	path = PREFERENCES_PATH,
): void {
	savePreferences({ model: model.size }, path);
}
