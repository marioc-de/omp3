import { describe, expect, test } from "bun:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBridge, type BridgeEvent, type ClaudeQuery } from "../src/claude-code/bridge";
import { claudePermissions } from "../src/claude-code/permissions";

const sessionId = "f2b46f7c-6a28-4e2c-a907-4a1467f84b22";
function result(extra: Record<string, unknown> = {}): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		session_id: sessionId,
		result: "Complete",
		is_error: false,
		num_turns: 1,
		total_cost_usd: 0.001,
		...extra,
	} as SDKMessage;
}
const deny = async () => ({ behavior: "deny" as const, message: "Test" });
const noop = () => {};

describe("Claude Code runtime", () => {
	test("continues the Claude-owned session and never replays OMP history", async () => {
		const calls: { options: Options; prompt: unknown }[] = [];
		const create: ClaudeQuery = args => ({
			close: noop,
			async *[Symbol.asyncIterator]() {
				const first = await args.prompt[Symbol.asyncIterator]().next();
				calls.push({ options: args.options, prompt: first.value });
				yield result();
			},
		});
		const bridge = new ClaudeBridge(create);
		await bridge.run("Remember a number", { cwd: "/tmp", canUseTool: deny, emit: noop });
		await bridge.run("What number?", { cwd: "/tmp", canUseTool: deny, emit: noop });
		expect(calls[0].options.resume).toBeUndefined();
		expect(calls[1].options.resume).toBe(sessionId);
		expect(calls[1].prompt).toMatchObject({ message: { content: "What number?" } });
		// The official subprocess inherits its own login; no OMP auth/proxy overrides.
		expect(calls[1].options.env).toBeUndefined();
		expect(calls[1].options.pathToClaudeCodeExecutable).toBe("claude");
	});

	test("streams text and tools without duplicating the final assistant reply", async () => {
		const events: BridgeEvent[] = [];
		const create: ClaudeQuery = () => ({
			close: noop,
			async *[Symbol.asyncIterator]() {
				yield {
					type: "stream_event",
					event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
					parent_tool_use_id: null,
				} as SDKMessage;
				yield {
					type: "assistant",
					parent_tool_use_id: null,
					message: {
						content: [
							{ type: "text", text: "Hello" },
							{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "a.ts" } },
						],
					},
				} as SDKMessage;
				yield result({ result: "Hello" });
			},
		});
		await new ClaudeBridge(create).run("read", { cwd: "/tmp", canUseTool: deny, emit: event => events.push(event) });
		expect(events.filter(event => event.type === "message")).toEqual([{ type: "message", text: "Hello" }]);
		expect(events).toContainEqual({ type: "preview", text: "Hello" });
		expect(events).toContainEqual({ type: "tool", name: "Read", input: { file_path: "a.ts" } });
	});

	test("cancellation releases the turn and rejects concurrent prompts", async () => {
		const blocked = Promise.withResolvers<void>();
		let closed = false;
		const bridge = new ClaudeBridge(() => ({
			close() {
				closed = true;
				blocked.resolve();
			},
			async *[Symbol.asyncIterator]() {
				await blocked.promise;
				yield result();
			},
		}));
		const turn = bridge.run("long task", { cwd: "/tmp", canUseTool: deny, emit: noop });
		await expect(bridge.run("second", { cwd: "/tmp", canUseTool: deny, emit: noop })).rejects.toThrow("busy");
		bridge.stop();
		await turn;
		expect(closed).toBe(true);
		expect(bridge.busy).toBe(false);
	});

	test("propagates Claude errors instead of retrying through another provider", async () => {
		let calls = 0;
		const bridge = new ClaudeBridge(() => {
			calls++;
			return {
				close: noop,
				async *[Symbol.asyncIterator]() {
					yield result({ is_error: true, result: "Usage limit reached" });
				},
			};
		});
		await expect(bridge.run("task", { cwd: "/tmp", canUseTool: deny, emit: noop })).rejects.toThrow(
			"Usage limit reached",
		);
		expect(calls).toBe(1);
		expect(bridge.busy).toBe(false);
	});

	test("an incomplete stream is an error, not a successful empty reply", async () => {
		const bridge = new ClaudeBridge(() => ({ close: noop, async *[Symbol.asyncIterator]() {} }));
		await expect(bridge.run("task", { cwd: "/tmp", canUseTool: deny, emit: noop })).rejects.toThrow(
			"without completing",
		);
	});

	test("permission requests default to denial and aborted approval cannot authorize tools", async () => {
		const controller = new AbortController();
		const request = { signal: controller.signal, toolUseID: "t1", requestId: "permission-1" };
		expect((await claudePermissions(async () => "")("Bash", { command: "echo test" }, request))?.behavior).toBe(
			"deny",
		);
		expect((await claudePermissions(async () => "yes")("Bash", { command: "echo test" }, request))?.behavior).toBe(
			"allow",
		);
		expect(
			(
				await claudePermissions(async () => {
					controller.abort();
					return "yes";
				})("Bash", {}, request)
			)?.behavior,
		).toBe("deny");
	});

	test("answers Claude's user-question tool without treating text as a new model prompt", async () => {
		const permissions = claudePermissions(async () => "blue");
		const response = await permissions(
			"AskUserQuestion",
			{ questions: [{ question: "Which color?", options: [] }] },
			{ signal: new AbortController().signal, toolUseID: "q1", requestId: "question-1" },
		);
		expect(response).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which color?": "blue" } } });
	});
});
