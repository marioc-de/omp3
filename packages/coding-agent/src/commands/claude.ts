import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runClaudeCode } from "../claude-code/run";
import { claudeHelp } from "../cli/command-help";

export default class Claude extends Command {
	static description = claudeHelp.description;
	static args = { prompt: Args.string({ description: "Optional initial prompt (quote multi-word prompts)" }) };
	static flags = {
		model: Flags.string({ description: "Model name accepted by Claude Code, e.g. sonnet or opus" }),
		resume: Flags.string({ description: "Resume a Claude Code session ID" }),
		binary: Flags.string({ description: "Claude Code executable", default: "claude" }),
		print: Flags.boolean({
			char: "p",
			description: "Run one prompt without a TUI; unresolved permissions are denied",
		}),
	};
	async run(): Promise<void> {
		const { args, flags } = await this.parse(Claude);
		await runClaudeCode({
			cwd: process.cwd(),
			prompt: args.prompt,
			model: flags.model,
			resume: flags.resume,
			binaryPath: flags.binary,
			print: flags.print,
		});
	}
}
