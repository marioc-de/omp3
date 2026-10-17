import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Tool } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { emptyUsage } from "@oh-my-pi/pi-ai/images/shared";
import { render } from "@oh-my-pi/pi-utils/prompt";
import conversationTemplate from "../prompts/system/claude-sdk-conversation.md" with { type: "text" };
import toolAcknowledgment from "../prompts/system/claude-sdk-tool-ack.md" with { type: "text" };
import { checkClaudeSubscription } from "./auth";

export interface ModelQuery extends AsyncIterable<SDKMessage> {
	close(): void;
}
export interface ModelTransportDependencies {
	query(args: { prompt: string; options: Options }): ModelQuery;
	checkAuth(binaryPath: string, env?: Record<string, string | undefined>): Promise<unknown>;
	environment(): Promise<Record<string, string | undefined>>;
}
const defaults: ModelTransportDependencies = {
	query,
	checkAuth: checkClaudeSubscription,
	environment: async () => ({ ...process.env }),
};

/** The MCP server only acknowledges requests. It cannot execute OMP or native tools. */
export function createOmpToolCatalog(tools: readonly Tool[]): McpServer {
	const server = new McpServer({ name: "omp", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			inputSchema: { ...JSON.parse(JSON.stringify(tool.parameters)), type: "object" as const },
			_meta: { "anthropic/alwaysLoad": true },
		})),
	}));
	server.server.setRequestHandler(CallToolRequestSchema, async () => ({
		content: [{ type: "text" as const, text: toolAcknowledgment.trim() }],
	}));
	return server;
}

/** Stateless single-round inference. OMP's context/plan/tools remain authoritative. */
export function streamClaudeSdk(
	model: Model,
	context: Context,
	options: SimpleStreamOptions = {},
	dependencies: Partial<ModelTransportDependencies> = {},
): AssistantMessageEventStream {
	const deps = { ...defaults, ...dependencies };
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const controller = new AbortController();
	let active: ModelQuery | undefined;
	const abort = () => {
		controller.abort();
		active?.close();
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) controller.abort();
	void (async () => {
		let server: McpServer | undefined;
		try {
			controller.signal.throwIfAborted();
			const env = await deps.environment();
			const binary = env.OMP_CLAUDE_BINARY || "claude";
			await deps.checkAuth(binary, env);
			controller.signal.throwIfAborted();
			const messages = context.messages.map(message => {
				const content =
					typeof message.content === "string"
						? message.content
						: message.content.filter(block => block.type !== "thinking" && block.type !== "redactedThinking");
				if (Array.isArray(content) && content.some(block => block.type === "image"))
					throw new Error("The Claude SDK model provider currently supports text only.");
				return {
					role: message.role,
					content,
					...("toolCallId" in message
						? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError }
						: {}),
				};
			});
			const tools = context.tools ?? [];
			const toolNames = new Map(tools.map(tool => [`mcp__omp__${tool.name}`, tool.name]));
			server = createOmpToolCatalog(tools);
			active = deps.query({
				prompt: render(conversationTemplate, { conversation: JSON.stringify(messages) }),
				options: {
					env,
					cwd: options.cwd ?? process.cwd(),
					model: model.id,
					pathToClaudeCodeExecutable: binary,
					abortController: controller,
					systemPrompt: context.systemPrompt ?? [],
					// No Claude plan, presets, project hooks, native tools or foreign MCP servers.
					settingSources: [],
					tools: [],
					strictMcpConfig: true,
					permissionMode: "default",
					mcpServers: { omp: { type: "sdk", name: "omp", instance: server } },
					canUseTool: async (name, input) =>
						toolNames.has(name)
							? { behavior: "allow", updatedInput: input }
							: { behavior: "deny", message: "Only OMP tool catalog shims are permitted." },
					maxTurns: 1,
					persistSession: false,
					includePartialMessages: true,
				},
			});
			stream.push({ type: "start", partial: output });
			const text = { type: "text" as const, text: "" };
			output.content.push(text);
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			const finalTexts: string[] = [];
			const seenTools = new Set<string>();
			let resultSeen = false;
			for await (const message of active) {
				controller.signal.throwIfAborted();
				if (
					message.type === "stream_event" &&
					!message.parent_tool_use_id &&
					message.event.type === "content_block_delta" &&
					message.event.delta.type === "text_delta"
				) {
					text.text += message.event.delta.text;
					stream.push({ type: "text_delta", contentIndex: 0, delta: message.event.delta.text, partial: output });
				} else if (message.type === "assistant" && !message.parent_tool_use_id) {
					for (const block of message.message.content) {
						if (block.type === "text") finalTexts.push(block.text);
						if (block.type !== "tool_use" || seenTools.has(block.id)) continue;
						const name = toolNames.get(block.name);
						if (!name) throw new Error(`Claude SDK requested an unregistered tool: ${block.name}`);
						if (!block.input || typeof block.input !== "object" || Array.isArray(block.input))
							throw new Error(`Invalid arguments for ${name}`);
						seenTools.add(block.id);
						const toolCall = {
							type: "toolCall" as const,
							id: block.id,
							name,
							arguments: block.input as Record<string, unknown>,
						};
						const index = output.content.length;
						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
					}
				} else if (message.type === "result") {
					resultSeen = true;
					// Claude increments num_turns before checking maxTurns; a tool
					// response stopped at maxTurns=1 may report num_turns=2.
					const expectedToolStop = message.subtype === "error_max_turns" && seenTools.size > 0;
					if (message.subtype !== "success" && !expectedToolStop) throw new Error(message.errors.join("\n"));
					if (message.subtype === "success" && message.is_error) throw new Error(message.result);
					const usage = message.usage;
					output.usage = {
						input: usage.input_tokens,
						output: usage.output_tokens,
						cacheRead: usage.cache_read_input_tokens ?? 0,
						cacheWrite: usage.cache_creation_input_tokens ?? 0,
						totalTokens:
							usage.input_tokens +
							usage.output_tokens +
							(usage.cache_read_input_tokens ?? 0) +
							(usage.cache_creation_input_tokens ?? 0),
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: message.total_cost_usd },
					};
					if (!text.text && !finalTexts.length && message.subtype === "success" && message.result)
						finalTexts.push(message.result);
					// Do not advance SDK iteration: max-turn termination throws after its result.
					break;
				}
			}
			if (!resultSeen) throw new Error("Claude SDK exited without an inference result.");
			if (finalTexts.length) text.text = finalTexts.join("\n");
			stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: output });
			output.stopReason = seenTools.size ? "toolUse" : "stop";
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			output.stopReason = controller.signal.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			options.signal?.removeEventListener("abort", abort);
			active?.close();
			await server?.close();
		}
	})();
	return stream;
}
