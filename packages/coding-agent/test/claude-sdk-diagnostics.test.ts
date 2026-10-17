import { expect, test } from "bun:test";
import { collectSdkDiagnostics, type SdkDiagnosticInput } from "../src/claude-code/diagnostics";

const clean: SdkDiagnosticInput = {
	env: {},
	legacyAuth: false,
	legacyOAuth: false,
	model: { provider: "claude-code-sdk", id: "claude-sonnet-5-5" },
	roles: { plan: ["claude-code-sdk/claude-opus-5-5"] },
};

test("diagnostics never disclose secret environment values, including URLs with credentials", () => {
	const findings = collectSdkDiagnostics({
		...clean,
		env: {
			ANTHROPIC_API_KEY: "secret-key-for-test",
			ANTHROPIC_BASE_URL: "https://user:secret-password@example.test",
			CLAUDE_CONFIG_DIR: "/private-account-directory",
		},
	});
	const text = JSON.stringify(findings);
	expect(text).toContain("ANTHROPIC_API_KEY");
	expect(text).toContain("ANTHROPIC_BASE_URL");
	expect(text).not.toContain("secret-key-for-test");
	expect(text).not.toContain("secret-password");
	expect(text).not.toContain("private-account-directory");
});

test("SDK selection does not hide legacy OAuth background requests or direct Claude fallbacks", () => {
	const findings = collectSdkDiagnostics({
		...clean,
		legacyAuth: true,
		legacyOAuth: true,
		roles: { plan: ["claude-code-sdk/claude-opus-5-5", "anthropic/claude-sonnet-5"] },
	});
	expect(findings.map(finding => finding.id)).toEqual(
		expect.arrayContaining(["legacy-auth", "legacy-usage", "roles-outside-sdk"]),
	);
	expect(findings.some(finding => finding.id === "active-outside-sdk")).toBe(false);
});

test("Claude on another provider is flagged while SDK-only routes and unrelated models are not", () => {
	expect(collectSdkDiagnostics(clean)).toEqual([]);
	const findings = collectSdkDiagnostics({
		...clean,
		model: { provider: "openrouter", id: "anthropic/claude-opus-5" },
	});
	expect(findings.map(finding => finding.id)).toEqual(["active-outside-sdk"]);
	expect(collectSdkDiagnostics({ ...clean, model: { provider: "openai", id: "gpt-5" } })).toEqual([]);
});
