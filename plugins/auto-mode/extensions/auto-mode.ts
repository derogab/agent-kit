import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBashGuard } from "./bash-guard.ts";
import { registerAutoModeControls } from "./controls.ts";
import {
	registerClassifierServer,
	type ClassifierServerDependencies,
} from "./server.ts";

export default function (pi: ExtensionAPI, dependencies: ClassifierServerDependencies = {}) {
	const classifierServer = registerClassifierServer(pi, dependencies);
	const controller = registerAutoModeControls(pi, classifierServer);
	registerBashGuard(pi, controller, classifierServer);
}
