import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBashGuard } from "./bash-guard.ts";
import { registerAutoModeControls, type AutoModeControlsDependencies } from "./controls.ts";
import {
	registerClassifierServer,
	type ClassifierServerDependencies,
} from "./server.ts";

export default function (
	pi: ExtensionAPI,
	dependencies: ClassifierServerDependencies & AutoModeControlsDependencies = {},
) {
	const classifierServer = registerClassifierServer(pi, {
		...dependencies,
		isEnabled: () => controller.isActive(),
	});
	const controller = registerAutoModeControls(pi, classifierServer, dependencies);
	registerBashGuard(pi, controller, classifierServer);
}
