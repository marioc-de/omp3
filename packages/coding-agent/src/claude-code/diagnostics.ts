import type { Model } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import { resolveConfiguredModelPatterns } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { ExtensionAPI, ExtensionContext } from "../extensibility/extensions/types";
import { getRetryFallbackChains } from "../session/retry-fallback-chains";
import { checkClaudeSubscription } from "./auth";

const SDK_PROVIDER = "claude-code-sdk";
const AUTH_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
	"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"ANTHROPIC_CUSTOM_HEADERS",
];

export interface SdkDiagnostic {
	id: string;
	message: string;
}

export interface SdkDiagnosticInput {
	env: Record<string, string | undefined>;
	legacyAuth: boolean;
	legacyOAuth: boolean;
	model?: Pick<Model, "provider" | "id">;
	roles: Readonly<Record<string, readonly string[]>>;
}

function outsideSdk(model: Pick<Model, "provider" | "id">): boolean {
	return (
		model.provider !== SDK_PROVIDER &&
		(model.provider === "anthropic" ||
			model.provider === "claude-code" ||
			classifyModel(model.provider, model.id, { lenient: true }).class === "anthropic")
	);
}

/** Only configuration names and booleans enter messages; never credentials or environment values. */
export function collectSdkDiagnostics(input: SdkDiagnosticInput): SdkDiagnostic[] {
	const findings: SdkDiagnostic[] = [];
	if (input.legacyAuth)
		findings.push({
			id: "legacy-auth",
			message:
				"O provider anthropic original tem uma fonte de autenticação configurada. Roles/fallbacks podem usá-lo fora do SDK; /logout não remove chaves de ambiente ou de configuração.",
		});
	if (input.legacyOAuth)
		findings.push({
			id: "legacy-usage",
			message:
				"Há OAuth Anthropic legado disponível. O monitor de quotas do OMP pode consultar a Anthropic diretamente em segundo plano, mesmo com um modelo SDK selecionado.",
		});
	const overrides = AUTH_ENV.filter(name => input.env[name]?.trim());
	if (overrides.length)
		findings.push({
			id: `environment:${overrides.join(",")}`,
			message: `Variáveis que podem alterar autenticação ou rota: ${overrides.join(", ")}. Confirme o destino antes de atribuir o consumo à assinatura. Valores omitidos.`,
		});
	for (const name of ["OMP_CLAUDE_BINARY", "CLAUDE_CONFIG_DIR", "OMP_AUTH_BROKER_URL"]) {
		if (input.env[name]?.trim())
			findings.push({
				id: `override:${name}`,
				message: `${name} está definido. Isso pode selecionar outro executável, perfil de login ou armazenamento de credenciais; confira essa configuração. Valor omitido.`,
			});
	}
	if (input.model && outsideSdk(input.model))
		findings.push({
			id: "active-outside-sdk",
			message:
				"O modelo Claude ativo está fora do provider claude-code-sdk. Esta chamada não usa nosso transporte SDK.",
		});
	const unsafeRoles = Object.entries(input.roles).filter(([, patterns]) =>
		patterns.some(pattern => {
			if (pattern.startsWith(`${SDK_PROVIDER}/`)) return false;
			const slash = pattern.indexOf("/");
			return outsideSdk({
				provider: slash < 0 ? "" : pattern.slice(0, slash),
				id: slash < 0 ? pattern : pattern.slice(slash + 1),
			});
		}),
	);
	if (unsafeRoles.length) {
		const names = unsafeRoles.map(([role]) =>
			/^[a-z][a-z0-9_-]{0,40}$/i.test(role) ? role : "seletor personalizado",
		);
		findings.push({
			id: "roles-outside-sdk",
			message: `Roles/fallbacks com Claude fora de claude-code-sdk ou aliases sem provider explícito: ${names.join(", ")}. Revise /model → Roles, incluindo alternativas; prefira claude-code-sdk/modelo nas rotas desejadas.`,
		});
	}
	return findings;
}

export function registerSdkDiagnostics(
	pi: ExtensionAPI,
	environment: () => Promise<Record<string, string | undefined>> = async () => ({ ...process.env }),
): void {
	const shown = new Set<string>();
	function inspect(ctx: ExtensionContext): SdkDiagnostic[] {
		const auth = ctx.modelRegistry.authStorage;
		// Use the host's settings instance, not a second singleton loaded by this source extension.
		const settings: Settings = pi.pi.settings;
		const roles = Object.fromEntries(
			Object.keys(settings.getModelRoles()).map(role => [
				role,
				resolveConfiguredModelPatterns(`@${role}`, settings),
			]),
		);
		for (const [role, chain] of Object.entries(getRetryFallbackChains(settings))) {
			roles[role] = [...(roles[role] ?? []), ...resolveConfiguredModelPatterns(chain, settings)];
		}
		return collectSdkDiagnostics({
			env: process.env,
			legacyAuth: auth.keys.source("anthropic") !== undefined,
			legacyOAuth: auth.credentials.hasOAuth("anthropic") || Boolean(process.env.ANTHROPIC_OAUTH_TOKEN?.trim()),
			model: ctx.model,
			roles,
		});
	}
	function report(ctx: ExtensionContext, findings: SdkDiagnostic[], force = false): void {
		for (const finding of findings) {
			if (!force && shown.has(finding.id)) continue;
			shown.add(finding.id);
			if (ctx.hasUI) ctx.ui.notify(`Claude SDK: ${finding.message}`, "warning");
			else pi.logger.warn(`Claude SDK: ${finding.message}`);
		}
	}
	pi.on("session_start", async (_event, ctx) => report(ctx, inspect(ctx)));
	pi.on("before_agent_start", async (_event, ctx) => report(ctx, inspect(ctx)));
	pi.on("retry_fallback_applied", async (event, ctx) => {
		if (event.from.startsWith(`${SDK_PROVIDER}/`) && !event.to.startsWith(`${SDK_PROVIDER}/`)) {
			report(
				ctx,
				[
					{
						id: "fallback-left-sdk",
						message:
							"Um fallback saiu do provider claude-code-sdk. A próxima tentativa usará outra conexão. Revise a cadeia da role em /model.",
					},
				],
				true,
			);
		}
	});
	pi.registerCommand("claude-sdk-check", {
		description: "Verificar autenticação e rotas Claude sem mostrar credenciais nem chamar modelos",
		handler: async (_args, ctx) => {
			const findings = inspect(ctx);
			report(ctx, findings, true);
			let status: string;
			try {
				const env = await environment();
				const subscription = await checkClaudeSubscription(env.OMP_CLAUDE_BINARY || "claude", env);
				const plan = ["pro", "max", "team", "enterprise"].includes(subscription.subscriptionType)
					? subscription.subscriptionType
					: "não identificado";
				status = `Login oficial validado; plano: ${plan}.`;
			} catch {
				status =
					"Não foi possível validar o login de assinatura. Execute claude auth status no mesmo ambiente. Detalhes omitidos para proteger credenciais.";
			}
			const summary = `${status} ${findings.length} alerta(s). Verificação de configuração, não uma garantia de isolamento: extensões, subagentes e configurações futuras podem alterar a rota.`;
			if (ctx.hasUI) ctx.ui.notify(summary, "info");
			else pi.logger.info(summary);
		},
	});
}
