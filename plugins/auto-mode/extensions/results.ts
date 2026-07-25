import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./security.ts";

const RESULT_ENTRY_TYPE = "auto-mode-result";

export type DecisionSource = "CLASSIFIER" | "POLICY";

interface AutoModeResult {
	command: string;
	allowed: boolean;
	source: DecisionSource;
}

export function appendAutoModeResult(pi: ExtensionAPI, result: AutoModeResult): void {
	pi.appendEntry(RESULT_ENTRY_TYPE, result);
}

export function registerAutoModeResultRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<AutoModeResult>(RESULT_ENTRY_TYPE, (entry, _options, theme) => {
		const result = entry.data ?? { command: "", allowed: false, source: "CLASSIFIER" };
		const box = new Box(1, 0, (text) => theme.bg(result.allowed ? "toolSuccessBg" : "toolErrorBg", text));
		box.addChild(
			new Text(`${sanitizeTerminalText(result.command)} ${result.allowed ? "✓" : "✗"} ${result.source}`, 0, 0),
		);
		return box;
	});
}
