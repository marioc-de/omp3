import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkClaudeSubscription } from "../src/claude-code/auth";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function authCli(status: unknown, exitCode = 0): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-claude-auth-"));
	directories.push(directory);
	const binary = path.join(directory, "claude fixture");
	await Bun.write(
		binary,
		`#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(JSON.stringify(status))});\nprocess.exit(${exitCode});\n`,
	);
	await fs.chmod(binary, 0o700);
	return binary;
}

test("accepts Claude Pro and Max subscription logins reported by the official CLI", async () => {
	const binary = await authCli({
		loggedIn: true,
		authMethod: "claude.ai",
		apiProvider: "firstParty",
		subscriptionType: "pro",
	});
	expect(await checkClaudeSubscription(binary)).toEqual({ authMethod: "claude.ai", subscriptionType: "pro" });
	// Max uses the same authentication contract, not a separate token implementation.
	const max = await authCli({
		loggedIn: true,
		authMethod: "claude.ai",
		apiProvider: "firstParty",
		subscriptionType: "max",
	});
	expect((await checkClaudeSubscription(max)).subscriptionType).toBe("max");
});

test("refuses API-key authentication instead of charging the API in subscription mode", async () => {
	const binary = await authCli({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" });
	await expect(checkClaudeSubscription(binary)).rejects.toThrow("subscription login");
});

test("logged-out CLI fails before a model request", async () => {
	const binary = await authCli({ loggedIn: false }, 1);
	await expect(checkClaudeSubscription(binary)).rejects.toThrow("not logged in");
});
