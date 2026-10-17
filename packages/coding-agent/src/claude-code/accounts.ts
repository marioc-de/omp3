import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	query,
	type Query,
	type SDKUserMessage,
	type SDKControlGetUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI } from "../extensibility/extensions/types";
import { replaceFileAtomically } from "../utils/atomic-file";
import { checkClaudeSubscription, claudeLoginCommand } from "./auth";

export interface ClaudeAccountFile {
	version: 1;
	selected: string;
	accounts: Record<string, { configDir: string }>;
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
class AccountInputError extends Error {}

export class ClaudeAccounts {
	constructor(readonly agentDir: string) {}
	get file(): string {
		return path.join(this.agentDir, "claude-accounts.json");
	}
	async read(): Promise<ClaudeAccountFile> {
		const file = Bun.file(this.file);
		if (!(await file.exists())) return { version: 1, selected: "default", accounts: {} };
		const data = (await file.json()) as ClaudeAccountFile;
		if (
			data.version !== 1 ||
			!data.accounts ||
			typeof data.accounts !== "object" ||
			Array.isArray(data.accounts) ||
			typeof data.selected !== "string"
		)
			throw new AccountInputError("Registro de contas Claude inválido.");
		for (const [name, entry] of Object.entries(data.accounts)) {
			if (
				!NAME.test(name) ||
				name === "default" ||
				!entry ||
				typeof entry.configDir !== "string" ||
				!path.isAbsolute(entry.configDir) ||
				/[\r\n\x00]/.test(entry.configDir)
			)
				throw new AccountInputError("Perfil Claude inválido no registro.");
		}
		if (data.selected !== "default" && !Object.hasOwn(data.accounts, data.selected))
			throw new AccountInputError("Perfil Claude selecionado não existe.");
		return {
			version: 1,
			selected: data.selected,
			accounts: Object.fromEntries(
				Object.entries(data.accounts).map(([name, entry]) => [name, { configDir: entry.configDir }]),
			),
		};
	}
	async #write(data: ClaudeAccountFile): Promise<void> {
		await fs.mkdir(this.agentDir, { recursive: true, mode: 0o700 });
		const staging = `${this.file}.${crypto.randomUUID()}.tmp`;
		try {
			await fs.writeFile(staging, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			await replaceFileAtomically(staging, this.file);
		} finally {
			await fs.rm(staging, { force: true });
		}
	}
	async #update(change: (data: ClaudeAccountFile) => void): Promise<void> {
		await fs.mkdir(this.agentDir, { recursive: true, mode: 0o700 });
		const lock = path.join(this.agentDir, ".telchar-setup.lock");
		try {
			await fs.mkdir(lock);
		} catch {
			throw new AccountInputError(
				"Outra alteração de contas ou setup está em andamento; tente novamente. Se persistir, verifique o lock .telchar-setup.lock.",
			);
		}
		try {
			const data = await this.read();
			change(data);
			await this.#write(data);
		} finally {
			await fs.rmdir(lock);
		}
	}

	async add(name: string, directory: string): Promise<void> {
		if (!NAME.test(name) || name === "default")
			throw new AccountInputError("Use um nome com letras, números, - ou _ (default é reservado).");
		const expanded =
			directory === "~"
				? os.homedir()
				: directory.startsWith("~/")
					? path.join(os.homedir(), directory.slice(2))
					: directory;
		if (!path.isAbsolute(expanded) || /[\r\n\x00]/.test(expanded))
			throw new AccountInputError("Use um diretório absoluto ou ~/diretorio.");
		await this.#update(data => {
			if (Object.hasOwn(data.accounts, name)) throw new AccountInputError("Já existe um perfil com esse nome.");
			data.accounts[name] = { configDir: path.normalize(expanded) };
		});
	}
	async select(name: string): Promise<void> {
		await this.#update(data => {
			if (name !== "default" && !Object.hasOwn(data.accounts, name))
				throw new AccountInputError("Perfil Claude não encontrado.");
			data.selected = name;
		});
	}
	async remove(name: string): Promise<void> {
		await this.#update(data => {
			if (name === "default" || name === data.selected)
				throw new AccountInputError("Selecione outro perfil antes de remover; default não pode ser removido.");
			if (!Object.hasOwn(data.accounts, name)) throw new AccountInputError("Perfil Claude não encontrado.");
			delete data.accounts[name];
		});
	}
	async environment(
		name?: string,
		base: Record<string, string | undefined> = process.env,
	): Promise<Record<string, string | undefined>> {
		const data = await this.read();
		const selected = name ?? data.selected;
		if (selected === "default") return { ...base };
		const overrides = [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"ANTHROPIC_CUSTOM_HEADERS",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
			"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
			"CLAUDE_CODE_USE_BEDROCK",
			"CLAUDE_CODE_USE_VERTEX",
			"CLAUDE_CODE_USE_FOUNDRY",
		].filter(key => base[key]?.trim());
		if (overrides.length)
			throw new AccountInputError(
				`O perfil nomeado não pode garantir a conta enquanto estas variáveis estiverem definidas: ${overrides.join(", ")}. Remova os overrides desse processo antes de selecionar o perfil. Valores omitidos.`,
			);
		const entry = Object.hasOwn(data.accounts, selected) ? data.accounts[selected] : undefined;
		if (!entry) throw new AccountInputError("Perfil Claude não encontrado.");
		return { ...base, CLAUDE_CONFIG_DIR: entry.configDir };
	}
}

/** No prompt is yielded: only a control request to the official CLI, no model inference. */
export async function readClaudeQuota(
	env: Record<string, string | undefined>,
	cwd: string,
	createQuery: typeof query = query,
): Promise<SDKControlGetUsageResponse> {
	const stopped = Promise.withResolvers<void>();
	async function* input(): AsyncGenerator<SDKUserMessage> {
		await stopped.promise;
		yield* [];
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 20_000);
	let session: Query | undefined;
	try {
		session = createQuery({
			prompt: input(),
			options: {
				env,
				cwd,
				pathToClaudeCodeExecutable: env.OMP_CLAUDE_BINARY || "claude",
				abortController: controller,
				tools: [],
				settingSources: [],
				strictMcpConfig: true,
				persistSession: false,
			},
		});
		return await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
	} finally {
		clearTimeout(timeout);
		stopped.resolve();
		session?.close();
	}
}

function formatUtilization(value: number | null | undefined): string {
	if (value == null) return "uso não informado";
	if (!Number.isFinite(value) || value < 0 || value > 100) return "uso inválido retornado pelo SDK";
	return `${value}% usado`;
}

export function formatClaudeQuota(report: SDKControlGetUsageResponse): string {
	if (!report.rate_limits_available || !report.rate_limits)
		return "Quotas indisponíveis pelo SDK para este perfil; isso não significa consumo zero.";
	const lines: string[] = [];
	for (const [key, label] of [
		["five_hour", "5 horas"],
		["seven_day", "7 dias"],
		["seven_day_oauth_apps", "Apps OAuth · 7 dias"],
		["seven_day_opus", "Opus · 7 dias"],
		["seven_day_sonnet", "Sonnet · 7 dias"],
	] as const) {
		const window = report.rate_limits[key];
		if (!window) continue;
		const reset =
			window.resets_at && Number.isFinite(Date.parse(window.resets_at))
				? new Date(window.resets_at).toLocaleString("pt-BR", { timeZoneName: "short" })
				: "não informado";
		lines.push(`${label}: ${formatUtilization(window.utilization)} · renovação: ${reset}`);
	}
	for (const window of report.rate_limits.model_scoped ?? []) {
		const label = sanitizeText(window.display_name).slice(0, 80);
		const reset =
			window.resets_at && Number.isFinite(Date.parse(window.resets_at))
				? new Date(window.resets_at).toLocaleString("pt-BR", { timeZoneName: "short" })
				: "não informado";
		lines.push(`${label} · 7 dias: ${formatUtilization(window.utilization)} · renovação: ${reset}`);
	}
	lines.push(
		report.rate_limits.model_scoped == null
			? "Janelas semanais por modelo: informação não disponível."
			: report.rate_limits.model_scoped.length === 0
				? "Janelas semanais por modelo: nenhuma retornada."
				: "Janelas semanais por modelo listadas acima.",
	);
	lines.push("Percentuais por janela; não devem ser somados.");
	return lines.join("\n");
}

export function registerClaudeAccounts(pi: ExtensionAPI, accounts: ClaudeAccounts): void {
	pi.registerCommand("claude-accounts", {
		description: "Gerenciar perfis Claude Code, selecionar conta e consultar quotas pelo SDK",
		handler: async (args, ctx) => {
			try {
				const parts = args.trim().split(/\s+/);
				let [action, name] = parts;
				const rest = parts.slice(2);
				if (!action) {
					const choice = await ctx.ui.select("Contas Claude · perfil OMP atual", [
						"Listar",
						"Adicionar",
						"Selecionar",
						"Status",
						"Quotas",
						"Quotas de todos",
						"Login",
						"Remover",
					]);
					if (!choice) return;
					action = (
						{
							Listar: "list",
							Adicionar: "add",
							Selecionar: "use",
							Status: "status",
							Quotas: "usage",
							"Quotas de todos": "usage-all",
							Login: "login",
							Remover: "remove",
						} as Record<string, string>
					)[choice];
				}
				const data = await accounts.read();
				if (action === "usage-all") {
					for (const accountName of ["default", ...Object.keys(data.accounts)]) {
						ctx.ui.notify(`Consultando ${accountName} pelo SDK…`, "info");
						try {
							const env = await accounts.environment(accountName);
							await checkClaudeSubscription(env.OMP_CLAUDE_BINARY || "claude", env);
							ctx.ui.notify(
								`${accountName} · ${new Date().toLocaleString()}\n${formatClaudeQuota(await readClaudeQuota(env, ctx.cwd))}`,
								"info",
							);
						} catch {
							ctx.ui.notify(`${accountName}: login ou quotas indisponíveis.`, "warning");
						}
					}
					return;
				}
				if (action === "list") {
					ctx.ui.notify(
						[
							"Perfis Claude (não são contas verificadas):",
							...["default", ...Object.keys(data.accounts)].map(
								key =>
									`${key === data.selected ? "●" : "○"} ${key}${key === "default" ? " — ambiente herdado" : ""}`,
							),
							"Use status para validar login e usage para consultar quotas.",
						].join("\n"),
						"info",
					);
					return;
				}
				if (action === "add") {
					name ||= (await ctx.ui.input("Nome do perfil (ex.: max-teste)")) ?? "";
					if (!name) return;
					const directory =
						rest.join(" ") || (await ctx.ui.input("Diretório do Claude Code", `~/.claude-${name}`));
					if (!directory) return;
					await accounts.add(name, directory);
					ctx.ui.notify(
						`Perfil ${name} salvo. Execute /claude-accounts login ${name} para instruções. Nenhuma credencial foi copiada.`,
						"info",
					);
					return;
				}
				if (!["use", "remove", "status", "usage", "login"].includes(action))
					throw new AccountInputError(
						"Use list | add <nome> <diretório> | use | status | usage | login | remove [nome].",
					);
				name ||=
					(await ctx.ui.select("Selecione o perfil Claude", ["default", ...Object.keys(data.accounts)])) ?? "";
				if (!name) return;
				const env = await accounts.environment(name);
				const binary = env.OMP_CLAUDE_BINARY || "claude";
				if (action === "login") {
					ctx.ui.notify(
						`Em outro terminal, no mesmo ambiente:\n${claudeLoginCommand(binary, env)}\nDepois execute /claude-accounts status ${name}. O login permanece no Claude Code.`,
						"info",
					);
					return;
				}
				if (action === "remove") {
					await accounts.remove(name);
					ctx.ui.notify(
						"Perfil removido do cadastro; os arquivos e o login do Claude Code foram preservados.",
						"info",
					);
					return;
				}
				if (action === "use" && !ctx.isIdle())
					throw new AccountInputError("Espere a execução terminar antes de trocar de conta.");
				const subscription = await checkClaudeSubscription(binary, env);
				if (action === "use") {
					await accounts.select(name);
					ctx.ui.notify(
						`Perfil ${name} selecionado para novas chamadas SDK neste perfil OMP, inclusive outras sessões que o usam. Roles e modelos permanecem iguais.`,
						"info",
					);
				} else if (action === "usage") {
					ctx.ui.notify("Consultando quotas pelo SDK oficial (API experimental)…", "info");
					ctx.ui.notify(
						`${name} · ${new Date().toLocaleString()}\n${formatClaudeQuota(await readClaudeQuota(env, ctx.cwd))}`,
						"info",
					);
				} else {
					const plan = ["pro", "max", "team", "enterprise"].includes(subscription.subscriptionType)
						? subscription.subscriptionType
						: "não identificado";
					ctx.ui.notify(`${name}: login claude.ai validado · plano ${plan}.`, "info");
				}
			} catch (error) {
				ctx.ui.notify(
					error instanceof AccountInputError
						? error.message
						: "Não foi possível concluir. Confira nome/diretório, aguarde execuções ativas e valide o login com o CLI oficial. Quotas dependem de uma API experimental; nenhuma credencial foi exibida.",
					"warning",
				);
			}
		},
	});
}
