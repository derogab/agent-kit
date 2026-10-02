import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBashGuard } from "./bash-guard.ts";
import { registerAutoModeControls, type AutoModeControlsDependencies } from "./controls.ts";
import {
	registerClassifierServer,
	type ClassifierServerDependencies,
} from "./server.ts";

const REGISTRATION_EVENT = "@derogab/pi-auto-mode:registration";

export default function (
	pi: ExtensionAPI,
	dependencies: ClassifierServerDependencies & AutoModeControlsDependencies = {},
) {
	// Separate install paths get separate modules. Coordinate on Pi's shared bus
	// so only one copy registers; Pi removes the subscription on runtime reload.
	const registration = { claimed: false };
	pi.events.emit(REGISTRATION_EVENT, registration);
	if (registration.claimed) return;

	const classifierServer = registerClassifierServer(pi, {
		...dependencies,
		isEnabled: () => controller.isActive(),
	});
	const controller = registerAutoModeControls(pi, classifierServer, dependencies);
	registerBashGuard(pi, controller, classifierServer);

	// Claim only after synchronous registration succeeds so failed copies cannot block retries.
	pi.events.on(REGISTRATION_EVENT, (data) => {
		(data as { claimed: boolean }).claimed = true;
	});
}
