import { $ } from "bun";

export interface ClaudeSubscription {
	authMethod: "claude.ai";
	subscriptionType: string;
}

/** Inspect only the official CLI's status, never OMP credentials or Claude token files. */
export async function checkClaudeSubscription(binaryPath: string): Promise<ClaudeSubscription> {
	const result = await $`${binaryPath} auth status`.quiet().nothrow();
	let status: unknown;
	try {
		status = JSON.parse(result.text());
	} catch {
		throw new Error(
			"Could not read Claude Code authentication. Run `claude auth login` with your Pro or Max account.",
		);
	}
	if (result.exitCode !== 0 || !status || typeof status !== "object")
		throw new Error("Claude Code is not logged in. Run `claude auth login`.");
	const value = status as Record<string, unknown>;
	if (value.loggedIn !== true || value.authMethod !== "claude.ai" || value.apiProvider !== "firstParty") {
		throw new Error(
			"omp claude requires a Claude subscription login. Run `claude auth login`; remove API-key or cloud-provider overrides from this shell/Claude configuration. No direct API fallback is used.",
		);
	}
	return {
		authMethod: "claude.ai",
		subscriptionType: typeof value.subscriptionType === "string" ? value.subscriptionType : "unknown",
	};
}
