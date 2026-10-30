# Openbuff Local/BYOK Provider Mode

Openbuff is local-first software focused entirely on local/BYOK operation with no backend fallback, credits, or Openbuff subscription. You provide your own keys for user-configured providers (such as OpenAI, Anthropic/Claude, OpenRouter, or local models). Openbuff does not require hosted authentication, credits, run tracking, or hosted model inference.

There is absolutely no backend fallback. Every LLM request must resolve to either:

1. an OpenAI-compatible or Anthropic-compatible provider in `openbuff.json`, or
2. a configured ChatGPT/Codex OAuth provider for supported OpenAI models.

Legacy `codebuff.json` / `manicode` config paths and most `CODEBUFF_*` env-var aliases were removed in the BYOK legacy purge; `openbuff.json` and `OPENBUFF_*` are now the primary names. Retained compatibility env names are documented in [Environment Variables](./environment-variables.md), including `CODEBUFF_API_KEY` as a fallback for `OPENBUFF_API_KEY`. See [docs/configuration.md](./configuration.md) for the full config layering and merge semantics.

## Start Openbuff

```bash
openbuff          # primary binary
# codebuff --local  # retained only where the legacy binary alias is installed
```

Openbuff is always local/BYOK — there is no cloud-mode toggle.

## Quickstart

1. Install and launch the CLI:

   ```bash
   npm install -g @openbuff/cli
   cd your-project
   openbuff
   ```

2. Configure a provider inside the TUI with `/setup <preset>` (e.g.
   `/setup openai`), or `/provider add` for the interactive wizard.
3. Verify with `/provider status` (loaded config, provider URLs, missing env
   vars) and `/models`.

See [Getting Started](./getting-started.md) for the full walkthrough.

## Configure providers

Openbuff looks for provider config in this order (see
[docs/configuration.md](./configuration.md) for full layering details):

1. `OPENBUFF_PROVIDER_CONFIG` — explicit env var; when set, only this path is
   loaded
2. `~/.config/openbuff/provider-config.json` — user-global config
3. `~/.config/openbuff/openbuff.json` — user-global config (alternate name)
4. `openbuff.json` in the current directory and each ancestor directory up to
   (and including) the user's home directory — project-local config

The quickest setup path is the built-in preset command:

```text
/setup opencode-go
/setup openai
/setup anthropic
/setup codex
/setup openrouter
/setup ollama
/setup glm
/setup bedrock
/setup freemodel
```

Use `/provider status` to inspect the loaded config and missing environment variables.
Use `/models` to open the model routing picker.

### Plan artifact commands (PlanLink)

Durable plan artifacts live under `.agents/sessions/<plan>/` and are
attached to a TUI session via PlanLink. The available slash commands are:

- `/resume-plan` — re-attach the current session to an existing plan
  artifact and rehydrate its working context.
- `/update-plan` — open the plan artifact for an incremental edit pass.
- `/plan-status` — print the current task/milestone status from
  `STATUS.md`.
- `/lessons` — append or review lesson notes captured during the plan.
- `/plans` (alias `/plan-ls`) — list every durable plan session found
  under `.agents/sessions/`, one row per session: active marker,
  `[status]` badge, slug, `N/M done` progress, and the current task.
  Only directories holding at least one known plan artifact (`SPEC.md`,
  `PLAN.md`, `STATUS.md`, `LESSONS.md`) are listed. It takes no
  arguments, runs entirely locally, and never sends a prompt to the
  agent.
- `/plan-use <slug>` (aliases `/plan-active`, `/use-plan`) — point
  `.agents/ACTIVE_SESSION` at a session. Accepts a bare slug or the
  `.agents/sessions/<slug>` path form; with no argument it opens the
  shared plan-session picker like the other plan commands. It fails
  closed without writing the pointer when the target resolves outside
  the project root, resolves outside `.agents/sessions/`, is a nested
  path under a session directory, is not a valid slug, does not exist
  on disk, or holds no known plan artifact. The pointer file stores the
  bare slug.

`/plans` derives the active session from the rows it scanned, so when
`.agents/ACTIVE_SESSION` names a slug that `/plans` does not list (the
directory was deleted, or it has no plan artifacts) it prints a
`Stale active session: <slug> ...` note pointing at `/plan-use <slug>`
instead of silently omitting the `Active session:` line.

For agent-driven updates, prefer `update_plan_status` for incremental
`STATUS.md` and lesson-note edits (it preserves user prose), and reserve
`create_plan` for whole-artifact creation or rewrite. See
[Agents and Tools](./agents-and-tools.md) for tool details.

For guided setup/configuration inside the TUI:

```text
/provider
/provider add
/provider status
/provider connect codex
/provider disconnect codex
/models configure
/models set mode plan codex/gpt-5.5
/models set agent code-reviewer openai/gpt-5.5
/models set editor-proposal 2 opencode-go/glm-5.1
/models set editor-selector codex/gpt-5.5
```

Openbuff supports OpenAI-compatible providers, Anthropic-compatible Claude
Messages API providers, and a first-class `chatgpt-oauth` provider for a
ChatGPT/Codex subscription:

```json
{
  "defaultModel": "openai/gpt-5.5",
  "modes": {
    "default": "openai/gpt-5.5",
    "plan": "openai/gpt-5.5"
  },
  "agents": {
    "base2": "openai/gpt-5.5",
    "thinker": "codex/gpt-5.5"
  },
  "providers": {
    "openai": {
      "type": "openai-compatible",
      "baseURL": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "supportsStructuredOutputs": true,
      "compatibility": {
        "stripCacheControl": true,
        "stringifyTextContent": true,
        "supportsTools": true,
        "supportsStopSequences": false,
        "stripProviderMetadata": true
      },
      "models": ["gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano"]
    },
    "zai": {
      "type": "openai-compatible",
      "baseURL": "https://api.z.ai/api/paas/v4",
      "apiKeyEnv": "ZAI_API_KEY",
      "models": ["glm-4.6"]
    },
    "anthropic": {
      "type": "anthropic-compatible",
      "baseURL": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "models": ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"]
    },
    "codex": {
      "type": "chatgpt-oauth",
      "models": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.1-codex"]
    },
    "local": {
      "type": "openai-compatible",
      "baseURL": "http://localhost:11434/v1",
      "models": ["qwen-coder"]
    }
  }
}
```

## How model routing works

Model routing is driven entirely by `openbuff.json` / `routes.json` — there is no
hardcoded per-agent model fallback. For each agent step:

1. `modes.default` or `modes.plan` overrides the built-in root agents (`base`, `base2` in default mode; `base-plan`, `base2-plan` in plan mode).
2. `agents[agentId]` overrides subagents and other non-mode agents when present.
3. `defaultModel` overrides every remaining agent when present.
4. An explicit `model` passed by the caller is a last-resort fallback.
5. The resulting requested model is matched against provider `models`.
6. If nothing is configured, Openbuff fails with a hard error: `No model
configured for agent '<id>'. Run /setup or set defaultModel (or
agents['<id>']) in your openbuff.json.`

Failover to backup providers on auth/server errors is a separate layer on top
of routing — see the [Failover routing](./configuration.md#failover-routing)
subsection for the `failoverModels` field, eligible HTTP status codes
(401/403/5xx), the no-content-yielded gate, and the `preferModelParam` bypass.

Agent keys may use the exact ID (`thinker`), a published ID
(`publisher/agent@1.2.3`), or the unversioned/unpublished short ID.

Model capability metadata may also contain empirical `quality.coding`
measurements keyed by language, task type, and agent role. These measurements
never silently override explicit routing. Use
`/models recommend <language> [task-type] [agent-role]` for an opt-in,
transparent recommendation; unmeasured models are excluded.

Provider `models` can be either a list:

```json
{
  "providers": {
    "opencode-go": {
      "type": "openai-compatible",
      "baseURL": "https://opencode.ai/zen/go/v1",
      "apiKeyEnv": "OPENCODE_GO_API_KEY",
      "models": [
        "glm-5.3-flash",
        "glm-5.3",
        "glm-5.2",
        "glm-5.1",
        "kimi-k3",
        "kimi-k2.7-code",
        "kimi-k2.6",
        "longcat-2.0",
        "mimo-v2.5-pro",
        "mimo-v2.5",
        "deepseek-v4.1-flash",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "hy4-preview",
        "hy3"
      ]
    },
    "opencode-go-anthropic": {
      "type": "anthropic-compatible",
      "baseURL": "https://opencode.ai/zen/go/v1",
      "apiKeyEnv": "OPENCODE_GO_API_KEY",
      "models": [
        "minimax-m3",
        "minimax-m2.7",
        "minimax-m2.5",
        "qwen3.8-max",
        "qwen3.8-flash",
        "qwen3.7-max",
        "qwen3.7-plus",
        "qwen3.6-plus"
      ]
    }
  },
  "defaultModel": "opencode-go/kimi-k2.6"
}
```

For `chatgpt-oauth`, run `/provider connect codex` before routing traffic to
the provider. Disconnect or rotate the subscription credentials with
`/provider disconnect codex` and connect again.

or a mapping from Openbuff-requested model to provider model:

```json
{
  "providers": {
    "openai": {
      "type": "openai-compatible",
      "baseURL": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": {
        "anthropic/claude-opus-4.7": "gpt-5.5",
        "anthropic/claude-sonnet-4.6": "gpt-5.5"
      }
    }
  }
}
```

## Provider compatibility flags

Strict OpenAI-compatible APIs differ on which request fields they accept. Each
provider can declare compatibility behavior:

```json
{
  "compatibility": {
    "stripCacheControl": true,
    "stringifyTextContent": true,
    "supportsTools": true,
    "supportsRequiredToolChoice": true,
    "supportsStopSequences": false,
    "stripProviderMetadata": true
  }
}
```

- `stripCacheControl`: removes Anthropic/OpenRouter prompt-cache metadata.
- `stringifyTextContent`: sends text-only user messages as a plain string.
- `supportsTools`: set `false` for chat-only providers that reject tool schemas.
- `supportsRequiredToolChoice`: set `false` for providers that accept tools but reject `tool_choice: "required"`.
- `supportsStopSequences`: set `true` only for OpenAI-compatible providers that accept the `stop` request field; otherwise Openbuff enforces stop sequences locally.
- `stripProviderMetadata`: omits Codebuff/OpenRouter-specific provider metadata.

## Model output degeneration

Degeneration is garbled or degraded model output in long agentic sessions:
repeated whitespace runs, aborted or mixed tool-call syntax, runaway
repetition. A typical specimen: coherent text, then hundreds of repeated
carriage returns, then aborted tool-call tag fragments (`<to`, `<tool_call`,
`<tool_c`), then a foreign-protocol fragment (`<parameter name="path">...`).
Degeneration is usually stochastic — retrying the turn often clears it. When
it recurs, the triggers below are the usual suspects.

### Known triggers and mitigations

- **Sampling repetition loops.** Greedy (temperature-0) or
  very-high-temperature decoding can lock into self-reinforcing repetition:
  repeated tokens, whitespace runs, tag fragments. Retry the turn and avoid
  temperature 0 for long sessions. On OpenAI-compatible/local endpoints set
  a repetition penalty around 1.1 (never above ~1.3), top-p around 0.9-0.95,
  and consider min-p 0.05-0.1. Route long tool-heavy sessions to a stronger
  model (`/models` or `agents[agentId]` in `openbuff.json`).
- **Context pressure.** Output quality degrades well before the hard context
  window ("context rot"), and providers fail differently at the ceiling:
  Anthropic returns a hard "prompt is too long" 400, Ollama silently truncates
  prompts at its `num_ctx` default, and OpenRouter middle-truncation
  transforms silently drop content. Keep sessions well below the window
  (Openbuff prunes context automatically; `/usage` shows the pressure), set
  `num_ctx` explicitly on Ollama, compact on Anthropic instead of re-sending
  an identical oversized prompt, and prefer models whose context comfortably
  exceeds the session.
- **Self-hosted prefix/KV-cache bugs.** Documented garbled-output cases exist
  for vLLM prefix caching (issues #20261, #5543) and SGLang radix cache
  (#4175, #46259) — repeated, truncated, or garbled tokens that vanish when
  caching is disabled. No public evidence ties corrupted output to OpenAI's
  or Anthropic *managed* prompt caching (their documented issues are cache
  misses, a cost concern). If a self-hosted OpenAI-compatible endpoint
  garbles output, disable prefix caching (vLLM `--no-enable-prefix-caching`,
  SGLang `--disable-radix-cache`) and upgrade the engine.
- **Quantized or small local models.** They fail non-linearly in long
  tool-use loops even when short demos look fine, and KV-cache quantization
  has broken tool calling on specific architectures (Ollama issues #10945,
  #17347). Prefer Q4_K_M-or-better weight quants for coding agents, leave the
  KV cache at f16 when tool calling stalls, use a larger model or a hosted
  API for long sessions, and restart the local server when degradation
  appears after long uptime.
- **Tool-call protocol confusion.** Models trained on several serialization
  dialects sometimes mix them mid-output (claude-code issue #49747; Qwen
  tool-call XML inside reasoning on some vLLM setups). Use the correct
  tool-call parser/chat template for the model on self-hosted servers, and
  if a model persistently mixes formats, switch models or providers.
- **EOS / stop-sequence mishandling.** Generation runs away when a server
  ignores stop strings (llama.cpp issue #11538: multi-token stops) or when
  `ignore_eos` is enabled. Avoid `ignore_eos`, prefer single-token stop
  sequences, and declare `supportsStopSequences: false` for endpoints that
  ignore stop strings so Openbuff enforces stop sequences locally.
- **max_tokens truncation mid-tool-call.** Some servers mislabel a truncated
  tool call as completed (vLLM issue #58228, since fixed; llama.cpp issue
  #30773); Anthropic's documented guidance is to retry with a higher
  max_tokens and never execute a truncated tool_use. Set a generous
  max_tokens and treat `finish_reason: "length"` or `stop_reason: "max_tokens"`
  plus invalid arguments as truncation — retry the turn, never execute a
  repaired guess.

### What Openbuff already does

The parser stack is fail-closed: degenerated bytes never become a tool call.

- Malformed tool calls never execute: the streaming parser
  (`packages/agent-runtime/src/util/stream-xml-parser.ts`) turns invalid JSON
  or a missing tool name into a structured parse error instead of a call.
- A dropped call is not silent: the parse error — including a bounded
  excerpt of the offending bytes — is persisted into the conversation as a
  `TOOL_CALL_ERROR` message and the turn is retried, so the model can
  correct its own malformed output instead of repeating it.
- Unterminated content past the buffer limit is discarded without leaking
  into the visible text stream (`tool_call_buffer_exceeded`), and a call left
  unterminated at end of stream is reported back
  (`tool_call_unterminated_eof`) so the model learns the call was dropped and
  can retry with a smaller payload — never executed, never leaked into the
  visible text stream.
- Common JSON damage is repaired conservatively (trailing or duplicate
  commas, `common/src/tools/params/utils.ts`), and transport-truncated
  arguments are recovered only when the cut dropped nothing but container
  closers — a half-written value is never guessed into existence.
- Tool-name respellings (`tool_name` / `toolName` / `tool` / `name`) are
  resolved instead of dropping the call.
- Provider-reported max-token cuts are classified as truncation, not schema
  errors.
- Degeneration specimens — aborted tag fragments plus repeated control
  bytes — are pinned by regression tests: they produce plain-text output and
  zero executed tool calls.

### When it happens

- Retry the turn; degeneration is usually stochastic.
- If it recurs: route the agent to a stronger model (`/models`), check
  `/usage` for context pressure, review the provider `compatibility` flags,
  and on local endpoints revisit sampling parameters and quantization. For
  backup providers see `failoverModels` in
  [docs/configuration.md](./configuration.md).

## Smoke test

After configuring a provider and exporting its API key:

```bash
bun run smoke:openbuff
```
