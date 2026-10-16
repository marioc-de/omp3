import { Input } from "@oh-my-pi/pi-tui/components/input";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { TUI } from "@oh-my-pi/pi-tui/tui";
import { replaceTabs, stripTerminalSequences } from "@oh-my-pi/pi-tui/utils";
import { ClaudeBridge, type BridgeEvent } from "./bridge";
import { checkClaudeSubscription } from "./auth";
import { claudePermissions, type AskClaudeUser } from "./permissions";

export interface ClaudeCodeOptions {
	cwd: string;
	model?: string;
	resume?: string;
	binaryPath?: string;
	prompt?: string;
	print?: boolean;
}

function display(text: string): string {
	return replaceTabs(stripTerminalSequences(text));
}

/** A separate runtime: never construct OMP's AgentSession, auth store, or model registry. */
export async function runClaudeCode(options: ClaudeCodeOptions): Promise<void> {
	const account = await checkClaudeSubscription(options.binaryPath || "claude");
	const bridge = new ClaudeBridge();
	bridge.sessionId = options.resume;
	if (options.print) {
		if (!options.prompt?.trim()) throw new Error("--print requires a prompt argument.");
		const stop = () => bridge.stop();
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
		let completed = false;
		try {
			await bridge.run(options.prompt, {
				...options,
				canUseTool: async () => ({
					behavior: "deny",
					message: "No interactive approval in --print mode. Run omp claude interactively.",
				}),
				emit: event => {
					if (event.type === "message") process.stdout.write(`${display(event.text)}\n`);
					if (event.type === "session") process.stderr.write(`Claude Code session: ${event.id}\n`);
					if (event.type === "done") completed = true;
				},
			});
			if (!completed) process.exitCode = 130;
		} finally {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		}
		return;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error("Interactive Claude Code requires a terminal. Use --print for a single prompt.");
	const tui = new TUI(new ProcessTerminal());
	const input = new Input();
	input.prompt = "Claude > ";
	const status = new Text("Ready. /help for commands.", 1, 0);
	const streaming = new Text("", 1, 0);
	tui.addChild(
		new Text(
			`OMP · Claude Code · ${account.subscriptionType}\nModels, tools, authentication and conversation history are owned by Claude Code.`,
		),
	);
	tui.addChild(streaming);
	tui.addChild(status);
	tui.addChild(input);
	tui.setFocus(input);
	const exited = Promise.withResolvers<void>();
	let closing = false;
	let model = options.model;
	let turn: Promise<void> | undefined;
	let answer: ((value: string | undefined) => void) | undefined;
	const append = (text: string): void => {
		tui.children.splice(tui.children.length - 3, 0, new Text(display(text)));
		tui.requestRender();
	};
	const ask: AskClaudeUser = async (title, body, signal) => {
		if (signal.aborted || closing) return undefined;
		append(`${title}\n${body}`);
		status.setText("Claude Code is waiting for your answer. Esc cancels.");
		input.prompt = "Answer > ";
		const result = Promise.withResolvers<string | undefined>();
		answer = result.resolve;
		const cancel = () => result.resolve(undefined);
		signal.addEventListener("abort", cancel, { once: true });
		tui.requestRender();
		try {
			return await result.promise;
		} finally {
			signal.removeEventListener("abort", cancel);
			answer = undefined;
			input.prompt = "Claude > ";
			status.setText("Claude Code is working · Esc to stop");
			tui.requestRender();
		}
	};
	const permissions = claudePermissions(ask);
	const exit = (): void => {
		closing = true;
		answer?.(undefined);
		bridge.stop();
		exited.resolve();
	};
	const stop = (): void => {
		if (bridge.busy) bridge.stop();
		else exit();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", exit);
	tui.addInputListener(data => {
		if (data === "\x03") {
			stop();
			return { consume: true };
		}
		return undefined;
	});
	input.onEscape = () => {
		if (answer) answer(undefined);
		else bridge.stop();
	};
	const emit = (event: BridgeEvent): void => {
		if (closing) return;
		switch (event.type) {
			case "session":
				status.setText(`Claude Code session: ${event.id}`);
				break;
			case "preview":
				streaming.setText(display(event.text));
				break;
			case "message":
				streaming.setText("");
				append(`Claude Code\n${event.text}`);
				break;
			case "tool":
				append(`Claude Code · ${event.name}\n${JSON.stringify(event.input, null, 2)}`);
				break;
			case "tool_result":
				append(`Claude Code · ${event.error ? "Tool error" : "Tool finished"} · ${event.id}`);
				if (event.error) append(typeof event.content === "string" ? event.content : JSON.stringify(event.content));
				break;
			case "done":
				status.setText(`Done · ${event.turns} turns · $${event.cost.toFixed(4)} estimated by Claude Code`);
				break;
		}
		tui.requestRender();
	};
	input.onSubmit = value => {
		const text = value.trim();
		if (answer) {
			input.setValue("");
			answer(text);
			return;
		}
		if (!text) return;
		if (text === "/quit" || text === "/exit") {
			exit();
			return;
		}
		if (text === "/stop") {
			input.setValue("");
			bridge.stop();
			return;
		}
		if (bridge.busy) {
			status.setText("Claude Code is working. Esc or /stop interrupts; your draft is kept.");
			tui.requestRender();
			return;
		}
		input.setValue("");
		if (text === "/help") {
			append(
				"/new — new Claude conversation\n/session — show resume ID\n/model <name> — select a Claude Code model\n/stop or Esc — interrupt\n/quit — exit\nOther messages and commands (including /compact) go to Claude Code.",
			);
			return;
		}
		if (text === "/new") {
			bridge.sessionId = undefined;
			append("New Claude Code conversation. Previous messages above are not sent.");
			return;
		}
		if (text === "/session") {
			append(`Session: ${bridge.sessionId ?? "new"}\nResume with: omp claude --resume <session-id>`);
			return;
		}
		if (text.startsWith("/model ")) {
			model = text.slice(7).trim();
			if (model === "default") model = undefined;
			append(`Claude Code model: ${model ?? "default"}`);
			return;
		}
		append(`You\n${text}`);
		status.setText("Claude Code is working · Esc to stop");
		turn = bridge
			.run(text, { ...options, model, canUseTool: permissions, emit })
			.catch(error => {
				if (!closing) append(`Claude Code error\n${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => {
				if (!closing) {
					streaming.setText("");
					status.setText(`Ready · session ${bridge.sessionId ?? "new"}`);
					tui.requestRender();
				}
			});
	};
	try {
		tui.start();
		if (options.prompt) input.onSubmit(options.prompt);
		await exited.promise;
		await turn;
	} finally {
		bridge.stop();
		process.off("SIGINT", stop);
		process.off("SIGTERM", exit);
		tui.stop();
	}
}
