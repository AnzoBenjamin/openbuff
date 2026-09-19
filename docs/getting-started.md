# Getting Started

Openbuff is a local-first, bring-your-own-key (BYOK) agentic coding CLI. There
are no accounts, no credits, and no hosted inference: you supply API keys for
your own providers (OpenAI, Anthropic/Claude, OpenRouter, local Ollama, or any
OpenAI-compatible endpoint), and every model request resolves locally against
your configuration. This guide takes you from install to a working CLI session
in one path.

## 1. Install

```bash
npm install -g @openbuff/cli
```

Run it from your project directory:

```bash
cd your-project
openbuff
```

## 2. Configure a provider

Openbuff runs no models of its own — point it at a provider you have a key
for. Provider config is read from the following sources, in priority order:

1. `OPENBUFF_PROVIDER_CONFIG` — env var pointing at a single config file
2. `~/.config/openbuff/provider-config.json` — user-global config
3. `~/.config/openbuff/openbuff.json` — user-global config (alternate name)
4. `openbuff.json` in the current directory and each ancestor directory up to
   (and including) `$HOME` — project-local config

See [configuration.md](./configuration.md) for multi-file merge semantics.

You have two quick paths.

### Inside the TUI (recommended)

Run the preset command for your provider:

```text
/setup openai   # presets: openai, anthropic, codex, openrouter, ollama,
                # glm, opencode-go, bedrock, freemodel
```

Or use the interactive wizard, including custom providers:

```text
/provider add
```

For a ChatGPT/Codex subscription, connect OAuth first:

```text
/provider connect codex
```

### Manual (`openbuff.json`)

Create an `openbuff.json` (project-local or user-global, per the search order
above) with one provider and a default route:

```jsonc
{
  "providers": {
    "openai": {
      "type": "openai-compatible",
      "baseURL": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "models": ["gpt-5.5", "gpt-5.4-mini"]
    }
  },
  "defaultModel": "openai/gpt-5.5",
  "modes": { "default": "openai/gpt-5.5" }
}
```

`apiKeyEnv` names the environment variable that holds your key — export it
before starting Openbuff:

```bash
export OPENAI_API_KEY="..."
```

## 3. Route your models

Openbuff routes each agent step from `openbuff.json`:

- `modes.default` and `modes.plan` override the built-in root agents.
- `agents[agentId]` overrides subagents and other non-mode agents.
- `defaultModel` is the fallback for everything not matched above.

There is **no hardcoded fallback**. If an agent has no configured model,
Openbuff fails with:

```text
No model configured for agent '<id>'. Run /setup or set defaultModel ...
```

Use `/models` to open the model routing picker, or `/models configure` for the
interactive routing wizard. The full resolution order is described in
[local-mode.md](./local-mode.md).

## 4. Verify

Inside the TUI:

```text
/provider status   # loaded config, provider URLs, missing env vars
/models            # model routing picker
```

Optionally run the smoke test after exporting your API key:

```bash
bun run smoke:openbuff
```

## 5. Troubleshooting

- **`No model configured for agent '<id>'`** — no model is routed for that
  agent. Run `/setup <preset>`, or set `defaultModel` (or `agents['<id>']`) in
  your `openbuff.json`.
- **Missing API key env var** — the provider's `apiKeyEnv` variable is not
  exported. Export it (e.g. `export OPENAI_API_KEY="..."`) and restart.
  `/provider status` lists the missing env vars for each provider.
- **`chatgpt-oauth` provider fails** — the ChatGPT/Codex OAuth provider needs
  `/provider connect codex` before it can serve traffic.
- **Config not picked up** — `/provider status` shows which file loaded.
  Check the priority order in section 2; when several files match, the merge
  rules in [configuration.md](./configuration.md) decide which values win.

## Where to go next

- [Configuration](./configuration.md) — config locations, merge semantics,
  failover routing, file-change hooks.
- [Local / BYOK provider mode](./local-mode.md) — provider setup details and
  TUI commands.
- [Environment variables](./environment-variables.md) — `OPENBUFF_*`
  variables and `apiKeyEnv` names.
- [Architecture](./architecture.md) — how the CLI fits together.
- Repo [README](../README.md) — custom agents and the SDK.
