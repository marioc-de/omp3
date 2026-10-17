import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ClaudeAccounts, formatClaudeQuota, readClaudeQuota } from "../src/claude-code/accounts";
import { claudeLoginCommand } from "../src/claude-code/auth";
import type { SDKControlGetUsageResponse, Query, query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

test("account selection supplies a per-request environment without copying tokens or changing the parent environment", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-accounts-"));
	directories.push(directory);
	const accounts = new ClaudeAccounts(directory);
	await accounts.add("max", "/tmp/max-account");
	await accounts.select("max");
	const base = { CLAUDE_CONFIG_DIR: "/tmp/old", UNRELATED_SECRET: "test-secret", PATH: "/usr/bin" };
	const env = await accounts.environment(undefined, base);
	expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/max-account");
	expect(base.CLAUDE_CONFIG_DIR).toBe("/tmp/old");
	expect(await fs.readFile(accounts.file, "utf8")).not.toContain("test-secret");
	await expect(
		accounts.environment(undefined, { ...base, CLAUDE_CODE_OAUTH_TOKEN: "never-use-another-account" }),
	).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN");
	await expect(accounts.environment(undefined, { ANTHROPIC_CUSTOM_HEADERS: "Authorization: test" })).rejects.toThrow(
		"ANTHROPIC_CUSTOM_HEADERS",
	);
	await expect(accounts.remove("max")).rejects.toThrow();
	await accounts.select("default");
	expect((await accounts.environment(undefined, base)).CLAUDE_CONFIG_DIR).toBe("/tmp/old");
	await accounts.remove("max");
	expect((await accounts.read()).accounts).toEqual({});
	await expect(accounts.add("../bad", "/tmp/path")).rejects.toThrow();
});

test("concurrent account changes never silently discard successful updates", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-accounts-"));
	directories.push(directory);
	const accounts = new ClaudeAccounts(directory);
	const names = ["one", "two", "three"];
	const results = await Promise.allSettled(names.map(name => new ClaudeAccounts(directory).add(name, `/tmp/${name}`)));
	const saved = await accounts.read();
	for (const [index, result] of results.entries()) {
		expect(Object.hasOwn(saved.accounts, names[index])).toBe(result.status === "fulfilled");
	}
	expect(results.some(result => result.status === "fulfilled")).toBe(true);
	await accounts.add("after", "/tmp/after");
	expect((await accounts.read()).accounts.after.configDir).toBe("/tmp/after");
});

test("quota boundaries, invalid values, weekly windows and reset timezone are explicit", () => {
	const report = {
		rate_limits_available: true,
		rate_limits: {
			five_hour: { utilization: 0, resets_at: "2026-10-17T00:00:00Z" },
			seven_day: { utilization: 100, resets_at: "invalid" },
			seven_day_opus: { utilization: Infinity, resets_at: null },
			model_scoped: [{ display_name: "Example", utilization: 45, resets_at: null }],
		},
	} as SDKControlGetUsageResponse;
	const output = formatClaudeQuota(report);
	expect(output).toContain("0% usado");
	expect(output).toContain("100% usado");
	expect(output).toContain("uso inválido");
	expect(output).toContain("Example · 7 dias: 45%");
	expect(output).toContain(new Date("2026-10-17T00:00:00Z").toLocaleString("pt-BR", { timeZoneName: "short" }));
	expect(output).toContain("renovação: não informado");
});

test("unavailable quotas are not displayed as zero and valid windows preserve percentages", () => {
	const unavailable = { rate_limits_available: false, rate_limits: null } as SDKControlGetUsageResponse;
	expect(formatClaudeQuota(unavailable)).not.toContain("0%");
	const report = {
		rate_limits_available: true,
		rate_limits: {
			five_hour: { utilization: 45, resets_at: null },
			seven_day: { utilization: null, resets_at: null },
		},
	} as SDKControlGetUsageResponse;
	expect(formatClaudeQuota(report)).toContain("45%");
	expect(formatClaudeQuota(report)).not.toContain("null%");
});

test("quota inspection sends no prompt to the model and closes the CLI session", async () => {
	let promptResult: Promise<IteratorResult<SDKUserMessage>> | undefined;
	let closed = false;
	const report = { rate_limits_available: false, rate_limits: null } as SDKControlGetUsageResponse;
	const fake: typeof query = args => {
		if (typeof args.prompt === "string") throw new Error("Must not send an inference prompt");
		promptResult = args.prompt[Symbol.asyncIterator]().next();
		return {
			usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => report,
			close() {
				closed = true;
			},
		} as unknown as Query;
	};
	await readClaudeQuota({}, "/tmp", fake);
	expect(closed).toBe(true);
	expect((await promptResult)?.done).toBe(true);
	expect((await promptResult)?.value).toBeUndefined();
});

test("login instructions quote paths so shell substitutions remain literal", async () => {
	const command = claudeLoginCommand("/tmp/claude $(false)'quoted", { CLAUDE_CONFIG_DIR: "/tmp/$(false)'account" });
	const result = Bun.spawnSync(["bash", "-c", `set -- ${command}; printf '%s\\n' "$@"`]);
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString().split("\n")).toEqual([
		"CLAUDE_CONFIG_DIR=/tmp/$(false)'account",
		"/tmp/claude $(false)'quoted",
		"auth",
		"login",
		"",
	]);
});
