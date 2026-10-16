import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export type AskClaudeUser = (title: string, body: string, signal: AbortSignal) => Promise<string | undefined>;

/** Permission decisions belong to Claude Code; only unresolved requests reach this UI. */
export function claudePermissions(ask: AskClaudeUser): CanUseTool {
	let queue: Promise<PermissionResult> = Promise.resolve({ behavior: "deny", message: "No request" });
	return (name, input, options) => {
		const answer = async (): Promise<PermissionResult> => {
			if (options.signal.aborted) return { behavior: "deny", message: "Cancelled" };
			try {
				if (name === "AskUserQuestion" && Array.isArray(input.questions)) {
					const answers: Record<string, string> = {};
					for (const item of input.questions) {
						if (!item || typeof item !== "object" || typeof item.question !== "string") {
							return { behavior: "deny", message: "Unsupported question format" };
						}
						const value = await ask(item.question, JSON.stringify(item.options ?? [], null, 2), options.signal);
						if (value === undefined || options.signal.aborted)
							return { behavior: "deny", message: "Question cancelled" };
						answers[item.question] = value;
					}
					return { behavior: "allow", updatedInput: { ...input, answers } };
				}
				const value = await ask(
					`Claude Code requests ${name}`,
					`${JSON.stringify(input, null, 2)}\nAllow this operation? [y/N]`,
					options.signal,
				);
				return !options.signal.aborted && /^(y|yes)$/i.test(value?.trim() ?? "")
					? { behavior: "allow", updatedInput: input }
					: { behavior: "deny", message: "User declined the operation" };
			} catch {
				return { behavior: "deny", message: "Permission UI unavailable" };
			}
		};
		queue = queue.then(answer, answer);
		return queue;
	};
}
