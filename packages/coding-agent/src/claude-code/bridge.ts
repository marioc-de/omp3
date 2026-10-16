import {
	query,
	type CanUseTool,
	type Options,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeStream extends AsyncIterable<SDKMessage> {
	close(): void;
}
export type ClaudeQuery = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeStream;
export type BridgeEvent =
	| { type: "session"; id: string }
	| { type: "preview"; text: string }
	| { type: "message"; text: string }
	| { type: "tool"; name: string; input: unknown }
	| { type: "tool_result"; id: string; content: unknown; error: boolean }
	| { type: "done"; cost: number; turns: number };

/** One Claude turn at a time. The CLI owns tools, history, and compaction. */
export class ClaudeBridge {
	#query: ClaudeQuery;
	#active?: { controller: AbortController; stream?: ClaudeStream; release: () => void };
	sessionId?: string;

	constructor(createQuery: ClaudeQuery = query) {
		this.#query = createQuery;
	}
	get busy(): boolean {
		return this.#active !== undefined;
	}

	stop(): void {
		const active = this.#active;
		if (!active) return;
		active.controller.abort();
		active.release();
		active.stream?.close();
	}

	async run(
		text: string,
		config: {
			cwd: string;
			model?: string;
			binaryPath?: string;
			canUseTool: CanUseTool;
			emit: (event: BridgeEvent) => void;
		},
	): Promise<void> {
		if (this.busy) throw new Error("Claude Code is busy. Stop the current turn first.");
		const heldInput = Promise.withResolvers<void>();
		const active = {
			controller: new AbortController(),
			release: heldInput.resolve,
			stream: undefined as ClaudeStream | undefined,
		};
		this.#active = active;
		// Keep stdin open until the result; permission replies use the same channel.
		async function* prompt(): AsyncGenerator<SDKUserMessage> {
			yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
			await heldInput.promise;
		}
		let preview = "";
		let gotResult = false;
		let gotText = false;
		try {
			active.stream = this.#query({
				prompt: prompt(),
				options: {
					cwd: config.cwd,
					pathToClaudeCodeExecutable: config.binaryPath || "claude",
					abortController: active.controller,
					systemPrompt: { type: "preset", preset: "claude_code" },
					settingSources: ["user", "project", "local"],
					permissionMode: "default",
					canUseTool: config.canUseTool,
					includePartialMessages: true,
					...(config.model ? { model: config.model } : {}),
					...(this.sessionId ? { resume: this.sessionId } : {}),
				},
			});
			for await (const message of active.stream) {
				if (active.controller.signal.aborted) break;
				if (
					(message.type === "result" || (message.type === "system" && message.subtype === "init")) &&
					message.session_id !== this.sessionId
				) {
					this.sessionId = message.session_id;
					config.emit({ type: "session", id: message.session_id });
				}
				if (message.type === "stream_event" && !message.parent_tool_use_id) {
					const event = message.event;
					if (event.type === "message_start") preview = "";
					if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
						preview += event.delta.text;
						config.emit({ type: "preview", text: preview });
					}
				} else if (message.type === "assistant") {
					for (const block of message.message.content) {
						if (block.type === "text" && !message.parent_tool_use_id) {
							gotText = true;
							config.emit({ type: "message", text: block.text });
						} else if (block.type === "tool_use") {
							config.emit({ type: "tool", name: block.name, input: block.input });
						}
					}
					preview = "";
					config.emit({ type: "preview", text: "" });
				} else if (message.type === "user" && Array.isArray(message.message.content)) {
					for (const block of message.message.content) {
						if (block.type === "tool_result")
							config.emit({
								type: "tool_result",
								id: block.tool_use_id,
								content: block.content,
								error: block.is_error ?? false,
							});
					}
				} else if (message.type === "result") {
					gotResult = true;
					// Release streaming input before the iterator unwinds on either a
					// success or an error result. Permission traffic shared that input.
					heldInput.resolve();
					active.stream.close();
					if (message.subtype !== "success") throw new Error(message.errors.join("\n"));
					if (message.is_error) throw new Error(message.result);
					if (!gotText && message.result) config.emit({ type: "message", text: message.result });
					config.emit({ type: "done", cost: message.total_cost_usd, turns: message.num_turns });
					break;
				}
			}
			if (!gotResult && !active.controller.signal.aborted)
				throw new Error("Claude Code exited without completing the turn.");
		} catch (error) {
			if (!active.controller.signal.aborted) throw error;
		} finally {
			heldInput.resolve();
			this.#active = undefined;
			active.stream?.close();
		}
	}
}
