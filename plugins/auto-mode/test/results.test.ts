import assert from "node:assert/strict";
import test from "node:test";
import { registerAutoModeResultRenderer } from "../extensions/results.ts";

test("result rendering sanitizes the command and shows source and outcome", () => {
	let renderer: ((entry: any, options: any, theme: any) => { render(width: number): string[] }) | undefined;
	registerAutoModeResultRenderer({
		registerEntryRenderer(type: string, callback: typeof renderer) {
			assert.equal(type, "auto-mode-result");
			renderer = callback;
		},
	} as never);
	assert.ok(renderer);

	const backgrounds: string[] = [];
	const component = renderer(
		{ data: { command: "printf \u001b[31mred", allowed: false, source: "MODEL" } },
		{},
		{
			bg(name: string, text: string) {
				backgrounds.push(name);
				return text;
			},
		},
	);
	const rendered = component.render(80).join("\n");
	assert.match(rendered, /printf \\u001b\[31mred ✗ MODEL/);
	assert.ok(backgrounds.every((name) => name === "toolErrorBg"));
});
