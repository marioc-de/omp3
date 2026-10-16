# Claude subscription models in normal OMP (experimental)

Prepare a fresh checkout with `bash scripts/build-omp3`, then install it with
`bash scripts/install-omp3`. The `omp3`
command starts normal OMP with the Claude SDK provider, using your existing
profile, authentication and roles. The upstream `omp` executable stays separate.
`omp3 --version` identifies the custom build. The launcher depends on this checkout
and its dependencies remaining in place. `OMP3_BIN_DIR` overrides the installation
directory (default `~/.local/bin`).

Telchar installs `omp` from upstream, supplies the `omp2` workspace function via
its zsh configuration, and installs `omp3` from `https://github.com/marioc-de/omp3`.
Its `scripts/omp3-source.sh` pins the fork commit. Each revision is prepared in
its own checkout under `~/.local/share/omp3/releases`; the launcher switches only
after preparation and version verification succeed. `TELCHAR_OMP3_CHECKOUT`
selects an explicitly prepared developer checkout instead. The SDK uses the
normal OMP profile unless you pass `--profile`.

For an isolated `claude-sdk` profile, use `scripts/omp-sdk`. It starts the ordinary
OMP session with the same provider.
OMP owns commands, roles, planning, context and tool execution. The official
Claude Agent SDK and installed Claude Code executable handle model requests and
subscription authentication.

```sh
# Run from your project directory:
/home/dev/src/oh-my-pi-claude-code/scripts/omp-sdk
```

Use `/login` → **Claude SDK (Pro/Max · Claude Code)** to validate the official
Claude Code login. If it is not authenticated, the dialog asks you to run
`claude auth login` in another terminal, then press Enter to validate. OMP stores
only a non-secret connection marker, never subscription tokens. Removing that
marker in `/logout` does not sign out the external Claude Code installation.

Use `/model` to select `claude-code/sonnet`, `claude-code/opus` or
`claude-code/haiku`. `/plan` is OMP's native plan mode; the provider does not
activate Claude Code plan mode. Configure roles in
`~/.omp/profiles/claude-sdk/agent/config.yml`; a complete example lives in
`scripts/claude-sdk-config.example.yml`. The local profile uses Sonnet for
`default`/`task`, Opus for `plan`/`slow`, and Haiku for `smol`/`tiny`.
The model picker and active-model label identify these models as
`Claude SDK · Sonnet (Pro/Max)` (or Opus/Haiku). The existing `anthropic`
provider and its login remain available alongside the SDK provider; there is no
provider block or SDK-only model filter. Select `claude-code/...` for SDK transport
or an existing `anthropic/...` model for the original connection. Roles can mix
providers. Project configuration can override profile settings, so retain the
`claude-code/` prefix for roles intended to use the SDK.

The `omp3` installer never replaces the upstream `omp` command. For a fresh checkout, install
dependencies, prepare the matching native addon as described below, then run
`bun run gen:tool-views` and `bun run gen:bundle` before using `scripts/omp-sdk`.
Copy the example configuration into the named profile if it does not exist.

## Transport behavior and current limits

Each OMP model round sends the current OMP system prompt and a serialized JSON
conversation snapshot to a fresh SDK query. It exposes only the supplied OMP
tool schemas through MCP shims. Shims acknowledge calls without executing them;
a one-turn limit returns tool requests to OMP for real execution. The following
round includes OMP's actual tool results. Claude native tools, project settings
and foreign MCP servers are disabled in this provider. There is no direct
Anthropic API fallback and no copying of OAuth tokens.

This is an adapter over an agent SDK, not a native stateless completion endpoint:
conversation roles are serialized in the prompt, and process startup/full context
replay add overhead. Text input and ordinary tool calls are supported; images,
OMP reasoning-effort controls and exact output-token/temperature controls are
not implemented. Catalog windows are conservative placeholders; aliases resolve
through Claude Code. A zero catalog price is not a claim of unlimited usage;
subscription quotas still apply, and SDK-reported costs are estimates.

Live Pro validation covered inference and an OMP `read` tool followed by a second
model round using the file contents. An interactive `/plan` test selected Opus
through the plan role, read the fixture and opened OMP’s native Plan Review
with Sonnet selected for continuation. Execution was not approved. Provider tests cover OMP plan instructions,
tool ownership, cancellation and authentication failure. Max uses the same
subscription authentication contract but has not been tested with a Max account.

## Separate Claude-owned agent mode

The earlier `omp claude` prototype remains available below. It is a separate
mode in which Claude owns the agent loop; use `scripts/omp-sdk` for normal OMP
commands and roles.

This fork adds `omp claude`: an OMP terminal interface backed by the official
Claude Agent SDK and the installed Claude Code executable. Claude Code owns the
agent loop, Anthropic requests, authentication, tools, compaction and sessions.
OMP does not supply subscription tokens, construct Anthropic requests, register
its own tools, or fall back to its Anthropic provider in this mode. The ordinary
`omp` command still runs the normal OMP agent.

## Pro and Max subscriptions

Sign in using the official CLI:

```sh
claude auth login
claude auth status
```

Use the Claude subscription login option. Before starting, this mode checks that
`claude auth status` reports a logged-in `claude.ai` account on `firstParty`.
It rejects API-key and cloud-provider authentication instead of silently using
API billing. It does not read OMP's auth store or copy Claude's token files.
`CLAUDE_CONFIG_DIR` is inherited, allowing a separate officially authenticated
Claude profile. Settings and environment must remain consistent between login
and running the command; Claude Code ultimately decides authentication/billing.

Anthropic's [subscription documentation](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
currently permits Agent SDK and third-party app usage with subscription limits.
Normal usage limits and account policies still apply. This is not a way to bypass
limits and cannot guarantee future account-policy decisions. Pro has been tested
locally; Max follows the same login contract but requires a Max account for a live test.

## Run this clone

From any project directory, preserving that directory as Claude's workspace:

```sh
/home/dev/src/oh-my-pi-claude-code/scripts/omp-claude
/home/dev/src/oh-my-pi-claude-code/scripts/omp-claude --model sonnet
/home/dev/src/oh-my-pi-claude-code/scripts/omp-claude --model opus
```

The source entrypoint is `bun packages/coding-agent/src/cli.ts claude`.
For another checkout, install dependencies with `bun install --ignore-scripts`
and build the matching native addon with `bun run build:native`. The dedicated
checkout already has the matching 18.11.1 Linux addon extracted from the official
`@oh-my-pi/pi-natives-linux-x64` package. The launcher does not replace global OMP.

One-shot mode:

```sh
scripts/omp-claude --print 'Explain this project'
scripts/omp-claude --resume <claude-session-id> --print 'Continue'
```

Responses go to stdout; the Claude session ID goes to stderr. Unresolved tool
permission requests are denied in print mode. Claude Code's existing permission
rules still apply; print mode is not a read-only sandbox.

## Interactive controls

- Enter sends text to Claude Code. Replies stream in OMP's terminal components.
- Tool requests and completion/error events appear in the transcript.
- Requests requiring approval show their full input and require `y`/`yes`.
- Claude's questions accept a typed answer.
- Esc or `/stop` interrupts; the next message resumes the Claude session.
- `/model sonnet`, `/model opus`, or `/model default` selects the model via Claude Code.
- `/new` starts a fresh Claude conversation without deleting previous sessions.
- `/session` displays the ID for `--resume`.
- `/quit` exits. Other commands, including `/compact`, are sent to Claude Code.

This first version has a simple single-line composer and no image attachments,
OMP model-picker integration, OMP extensions, OMP background jobs or OMP tools.
Resuming restores Claude's context but does not replay older messages in the TUI.
Claude's own user/project/local configuration and `CLAUDE.md` are loaded through
the SDK. Tool permission prompts use the default Claude Code permission mode.

## Architecture and validation

```text
omp claude
  → OMP terminal components
  → @anthropic-ai/claude-agent-sdk query()
  → installed claude executable
  → Anthropic (Claude Code subscription authentication)
```

The command skips OMP's provider-network bootstrap and never constructs an OMP
AgentSession, model registry, auth store, title generator or fallback chain.
The adapter uses the same SDK entrypoint and executable-selection mechanism as
[T3 Code's Claude adapter](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts).
The implementation is intentionally smaller; T3 Code UI features are not copied.

Focused checks:

```sh
bun test packages/coding-agent/test/claude-code-runtime.test.ts packages/coding-agent/test/claude-code-auth.test.ts
bun run --filter @oh-my-pi/pi-coding-agent check:types
```

Tests cover session continuation, concurrent-prompt rejection, cancellation,
streaming/tool events, errors without provider fallback, permission decisions,
user questions and rejection of API-key authentication.

Local validation on 2026-10-16 used Claude Code 2.1.292 with a Pro login:
one-shot inference and a second invocation resuming the same conversation both
succeeded with the parent OMP process's `fetch` replaced by a throwing guard.
In an interactive PTY, Claude Code requested approval for `Write`, received the
answer through the SDK, and created the expected file in a temporary workspace.
The bridge/auth tests, CLI routing/help tests, package type check and focused lint
passed. These checks do not constitute a live Max-account test.
