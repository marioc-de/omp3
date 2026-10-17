import type { ExtensionAPI, ProviderModelConfig } from "../extensibility/extensions/types";
import { streamClaudeSdk } from "./model-transport";
import { loginClaudeSdk } from "./auth";
import models from "./provider-models.json";
import { registerSdkDiagnostics } from "./diagnostics";
import { ClaudeAccounts, registerClaudeAccounts } from "./accounts";

/** Registers a model transport, not a replacement agent or slash-command handler. */
export default function claudeSdkProvider(pi: ExtensionAPI): void {
	const accounts = new ClaudeAccounts(pi.pi.getAgentDir());
	registerClaudeAccounts(pi, accounts);
	registerSdkDiagnostics(pi, () => accounts.environment());
	pi.registerProvider("claude-code-sdk", {
		api: "omp-claude-agent-sdk",
		baseUrl: "https://unused-sdk-transport.invalid",
		// Registry sentinel only. Never forwarded to the SDK or used as a credential.
		apiKey: "claude-code-subscription",
		oauth: {
			name: "Claude SDK (Pro/Max · Claude Code)",
			login: async callbacks => {
				const env = await accounts.environment();
				return loginClaudeSdk(callbacks, env.OMP_CLAUDE_BINARY || "claude", env);
			},
		},
		models: models as ProviderModelConfig[],
		streamSimple: (model, context, options) =>
			streamClaudeSdk(model, context, options, { environment: () => accounts.environment() }),
	});
}
