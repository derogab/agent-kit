import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBashGuard } from "./bash-guard.ts";
import {
	registerAutoModeControls,
	type AutoModeControlsDependencies,
} from "./controls.ts";
import { registerAutoModeResultRenderer } from "./results.ts";

export default function (pi: ExtensionAPI, dependencies: AutoModeControlsDependencies = {}) {
	const controller = registerAutoModeControls(pi, dependencies);
	registerAutoModeResultRenderer(pi);
	registerBashGuard(pi, controller);
}
