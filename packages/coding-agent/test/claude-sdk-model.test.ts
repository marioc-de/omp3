import { expect, test } from "bun:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Context, Tool } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	createOmpToolCatalog,
	streamClaudeSdk,
	type ModelTransportDependencies,
} from "../src/claude-code/model-transport";

const model = buildModel({
	id: "claude-haiku-4-5-20251001",
	name: "SDK",
	provider: "claude-code-sdk",
	api: "omp-claude-agent-sdk",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
});
const read: Tool = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const context: Context = {
	systemPrompt: ["OMP owns plan mode. Only inspect files."],
	messages: [{ role: "user", content: "Inspect the project", timestamp: 1 }],
	tools: [read],
};
function result(toolUse = false): SDKMessage {
	return {
		type: "result",
		subtype: toolUse ? "error_max_turns" : "success",
		num_turns: toolUse ? 2 : 1,
		is_error: toolUse,
		result: "Answer",
		errors: [],
		total_cost_usd: 0.001,
		usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 },
	} as unknown as SDKMessage;
}
function assistant(content: unknown[]): SDKMessage {
	return { type: "assistant", parent_tool_use_id: null, message: { id: "msg-1", content } } as unknown as SDKMessage;
}

test("OMP plan instructions and tool set control SDK inference without Claude plan or native tools", async () => {
	let sdk: Options | undefined;
	const deps: Partial<ModelTransportDependencies> = {
		checkAuth: async () => {},
		query(args) {
			sdk = args.options;
			return {
				close() {},
				async *[Symbol.asyncIterator]() {
					yield assistant([{ type: "tool_use", id: "call-1", name: "mcp__omp__read", input: { path: "a.ts" } }]);
					yield result(true);
					throw new Error("SDK throws after max-turn result");
				},
			};
		},
	};
	const output = await streamClaudeSdk(model, context, {}, deps).result();
	expect(output.stopReason).toBe("toolUse");
	expect(output.content).toContainEqual({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } });
	expect(sdk?.systemPrompt).toEqual(context.systemPrompt);
	expect(sdk?.permissionMode).toBe("default");
	expect(sdk?.tools).toEqual([]);
	expect(sdk?.settingSources).toEqual([]);
	expect(sdk?.strictMcpConfig).toBe(true);
	expect(sdk?.maxTurns).toBe(1);
	expect(sdk?.model).toBe("claude-haiku-4-5-20251001");
	expect(sdk?.persistSession).toBe(false);
	const request = { signal: new AbortController().signal, toolUseID: "x", requestId: "permission-x" };
	expect((await sdk?.canUseTool?.("Bash", { command: "touch should-not-exist" }, request))?.behavior).toBe("deny");
	expect((await sdk?.canUseTool?.("mcp__omp__read", { path: "a.ts" }, request))?.behavior).toBe("allow");
});

test("the next request uses actual OMP tool results and edited context, not an SDK-owned session", async () => {
	const prompts: string[] = [];
	const options: Options[] = [];
	const deps: Partial<ModelTransportDependencies> = {
		checkAuth: async () => {},
		query(args) {
			prompts.push(args.prompt);
			options.push(args.options);
			return {
				close() {},
				async *[Symbol.asyncIterator]() {
					yield assistant([{ type: "text", text: "The file contains 42" }]);
					yield result();
				},
			};
		},
	};
	const next: Context = {
		...context,
		messages: [
			...context.messages,
			{
				role: "toolResult",
				toolName: "read",
				toolCallId: "call-1",
				content: [{ type: "text", text: "42" }],
				isError: false,
				timestamp: 2,
			},
		],
	};
	const output = await streamClaudeSdk(model, next, {}, deps).result();
	expect(prompts[0]).toContain('"toolCallId":"call-1"');
	expect(prompts[0]).toContain('"text":"42"');
	expect(options[0].resume).toBeUndefined();
	expect(output.content).toContainEqual({ type: "text", text: "The file contains 42" });
	expect(output.usage.totalTokens).toBe(34);
});

test("selected account environment is identical for auth preflight and SDK inference", async () => {
	let checked: Record<string, string | undefined> | undefined;
	let queried: Record<string, string | undefined> | undefined;
	const output = await streamClaudeSdk(
		model,
		context,
		{},
		{
			environment: async () => ({
				CLAUDE_CONFIG_DIR: "/tmp/selected-max",
				OMP_CLAUDE_BINARY: "/tmp/official-claude",
			}),
			checkAuth: async (binary, env) => {
				expect(binary).toBe("/tmp/official-claude");
				checked = env;
			},
			query(args) {
				queried = args.options.env;
				return {
					close() {},
					async *[Symbol.asyncIterator]() {
						yield result();
					},
				};
			},
		},
	).result();
	expect(output.stopReason).toBe("stop");
	expect(queried).toBe(checked);
	expect(queried?.CLAUDE_CONFIG_DIR).toBe("/tmp/selected-max");
});

test("MCP catalog advertises only OMP tools and acknowledges without running them", async () => {
	const server = createOmpToolCatalog([read]);
	const client = new Client({ name: "test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	try {
		await Promise.all([server.connect(a), client.connect(b)]);
		const catalog = await client.listTools();
		expect(catalog.tools.map(tool => tool.name)).toEqual(["read"]);
		expect(catalog.tools[0].inputSchema).toMatchObject({
			properties: { path: { type: "string" } },
			required: ["path"],
		});
		// This nonexistent path cannot be read: the handler has no file executor.
		const acknowledgment = await client.callTool({ name: "read", arguments: { path: "/nonexistent/omp-sdk-test" } });
		expect(acknowledgment.isError).not.toBe(true);
		expect(JSON.stringify(acknowledgment.content)).toContain("No tool has been executed");
	} finally {
		await client.close();
		await server.close();
	}
});

test("authentication failure surfaces as an OMP provider error before any SDK inference", async () => {
	let queried = false;
	const output = await streamClaudeSdk(
		model,
		context,
		{},
		{
			checkAuth: async () => {
				throw new Error("Subscription login required");
			},
			query() {
				queried = true;
				throw new Error("must not run");
			},
		},
	).result();
	expect(queried).toBe(false);
	expect(output.stopReason).toBe("error");
	expect(output.errorMessage).toContain("Subscription login required");
});

test("cancellation closes the SDK and reports aborted instead of retrying through Anthropic", async () => {
	const controller = new AbortController();
	const started = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const stream = streamClaudeSdk(
		model,
		context,
		{ signal: controller.signal },
		{
			checkAuth: async () => {},
			query() {
				started.resolve();
				return {
					close() {
						closed.resolve();
					},
					async *[Symbol.asyncIterator]() {
						await closed.promise;
						yield result();
					},
				};
			},
		},
	);
	await started.promise;
	controller.abort();
	expect((await stream.result()).stopReason).toBe("aborted");
});
