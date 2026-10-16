import type { ExtensionAPI, ProviderModelConfig } from "../extensibility/extensions/types";
import { streamClaudeSdk } from "./model-transport";
import models from "./provider-models.json";

/** Registers a model transport, not a replacement agent or slash-command handler. */
export default function claudeSdkProvider(pi: ExtensionAPI): void {
	pi.registerProvider("claude-code", {
		api: "omp-claude-agent-sdk",
		baseUrl: "https://unused-sdk-transport.invalid",
		// Registry sentinel only. Never forwarded to the SDK or used as a credential.
		apiKey: "claude-code-subscription",
		models: models as ProviderModelConfig[],
		streamSimple: streamClaudeSdk,
	});
}
