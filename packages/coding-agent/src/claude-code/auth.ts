import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";

export interface ClaudeSubscription {
	authMethod: "claude.ai";
	subscriptionType: string;
}

export function claudeLoginCommand(binaryPath: string, env: Record<string, string | undefined>): string {
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	return `${env.CLAUDE_CONFIG_DIR ? `CLAUDE_CONFIG_DIR=${quote(env.CLAUDE_CONFIG_DIR)} ` : ""}${quote(binaryPath)} auth login`;
}

/** Inspect only the official CLI's status, never OMP credentials or Claude token files. */
export async function checkClaudeSubscription(
	binaryPath: string,
	env: Record<string, string | undefined> = process.env,
	signal?: AbortSignal,
): Promise<ClaudeSubscription> {
	signal?.throwIfAborted();
	const boundedSignal = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
	const result = Bun.spawn([binaryPath, "auth", "status"], {
		env,
		signal: boundedSignal,
		killSignal: "SIGKILL",
		stdout: "pipe",
		stderr: "ignore",
	});
	const reader = result.stdout.getReader();
	const stopReading = () => {
		void reader.cancel().catch(() => {});
	};
	boundedSignal.addEventListener("abort", stopReading, { once: true });
	let output = "";
	let exitCode: number;
	try {
		if (boundedSignal.aborted) stopReading();
		const decoder = new TextDecoder();
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			output += decoder.decode(chunk.value, { stream: true });
		}
		output += decoder.decode();
		exitCode = await result.exited;
		boundedSignal.throwIfAborted();
	} finally {
		boundedSignal.removeEventListener("abort", stopReading);
		reader.releaseLock();
	}
	let status: unknown;
	try {
		status = JSON.parse(output);
	} catch {
		throw new Error(
			"Could not read Claude Code authentication. Run `claude auth login` with your Pro or Max account.",
		);
	}
	if (exitCode !== 0 || !status || typeof status !== "object")
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

/** Link the official CLI login without importing or persisting subscription tokens. */
export async function loginClaudeSdk(
	callbacks: OAuthLoginCallbacks,
	binaryPath = process.env.OMP_CLAUDE_BINARY || "claude",
	env: Record<string, string | undefined> = process.env,
): Promise<string> {
	callbacks.signal?.throwIfAborted();
	let subscription: ClaudeSubscription;
	try {
		subscription = await checkClaudeSubscription(binaryPath, env, callbacks.signal);
	} catch {
		callbacks.signal?.throwIfAborted();
		await callbacks.onPrompt({
			message: `Em outro terminal, execute ${claudeLoginCommand(binaryPath, env)} com sua assinatura Pro/Max. Depois volte aqui e pressione Enter para validar. O login pertence ao Claude Code; nenhuma chave ou token deve ser colado aqui.`,
			allowEmpty: true,
		});
		callbacks.signal?.throwIfAborted();
		subscription = await checkClaudeSubscription(binaryPath, env, callbacks.signal);
	}
	callbacks.signal?.throwIfAborted();
	callbacks.onProgress?.(
		`Claude SDK: login do Claude Code validado (${subscription.subscriptionType}). Credenciais permanecem no Claude Code.`,
	);
	// Local connection marker only; model transport never forwards this as a credential.
	return "claude-code-subscription";
}
