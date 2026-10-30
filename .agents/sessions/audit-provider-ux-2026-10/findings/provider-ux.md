# Provider/model setup UX audit — 2026-10-24

Auditor: orchestrator (surgical reads; agents unavailable). Surfaces:
cli/src/utils/openbuff-provider.ts (wizard+commands), provider-picker-screen.tsx,
model-route-picker.tsx, commands/command-registry.ts, sdk/src/provider-config.ts,
chat.tsx wiring, openbuff.json.example.

## Up to standard

- **ProviderPickerScreen** (`provider-picker-screen.tsx:47-80`): categorized
  presets (Subscriptions vs API Providers), env-var name per preset,
  availability flags, aliases, OAuth connect, and a custom-provider form
  (id/type/baseURL/apiKeyEnv/models). Opened by bare `/setup` and `/provider`.
- **Pre-flight readiness** (`openbuff-provider.ts:1216+`
  `getOpenbuffProviderReadiness`): config diagnostics surfaced verbatim,
  unconfigured state names the exact setup commands, per-agent route
  resolution checked, OAuth connection state checked. Excellent error copy.
- **ModelRoutePicker** (`model-route-picker.tsx:94-237`): real picker over
  default/mode/agent routing showing current effective values.
- **Numbered model menus with capabilities** (`formatModelChoices`): the
  wizard's model steps list `1. gpt-5… | vision,tools` — not raw typing.
- **Live model discovery** (`/provider models <id> --refresh`) hits the
  provider endpoint; `/provider models <id> add` even strips provider
  prefixes from pasted routable ids.
- **Secrets never typed into chat**: setup asks for env-var NAMES; OAuth for
  ChatGPT; `openbuff.json.example` + docs/local-mode.md document the contract.

## Findings

1. **HIGH — two parallel paradigms for the same jobs (complicated).**
   Full-screen pickers (ProviderPicker via `/setup`|`/provider`; ModelRoute
   via `/models`) coexist with TYPED line wizards (`/provider add` → text
   state machine `openbuff-provider.ts:742-832`; `/models configure` →
   7-step wizard `:763-772`). Both write the same openbuff.json. The wizards
   render no availability flags, keep module-level mutable state
   (`let providerWizardState :761`), and are strictly worse than the pickers.
2. **HIGH — failover is invisible (limiting).** `failoverModels` is
   schema-supported (`provider-config.ts:472,604`) and the runtime honors it
   (resolveModelsToTry + failover events), but NO picker, wizard, or command
   sets or displays it — hand-editing openbuff.json is the only path.
3. **MEDIUM — no key validation at setup (buggy-feeling).** Choosing a
   preset names the env var; readiness checks config validity and routing,
   not whether the key exists/works. A missing/typo'd key surfaces later as
   a mid-session provider error. The pieces for a "test connection" exist
   (`--refresh` live call, chatgpt-oauth-validate) but aren't a setup step,
   and the picker's `available` flag is not surfaced as env-set status.
4. **MEDIUM — routing model is powerful but invisible (complicated).**
   default + per-mode (default/plan/executePlan) + per-agent overrides +
   per-route reasoning effort: no single "effective routing" view; users
   meet the taxonomy one wizard question at a time.
5. **MEDIUM — raw router ids leak to users (buggy).** `anthropic/claude-opus-4.7`
   style ids surfaced in provider status text (fixed for recovery events
   earlier); `displayModel()` maps ids in the picker but not uniformly
   (status bar / errors can still show raw ids, esp. for custom providers).
6. **LOW — wizard cancel promise unimplemented.** Wizards advertise "Press
   Escape to cancel" but Escape only flips the input mode; the module-level
   wizard state is never reset on cancel (stale until next wizard start).
7. **LOW — command surface overlap.** `/setup` ≡ `/provider` (bare);
   `/provider add|wizard` diverges into the text wizard while bare `/provider`
   opens the picker — three shapes for one family.

## Coverage receipt

openbuff-provider.ts (wizard states, command handler, readiness, model
menus, resolveModelChoice), provider-picker-screen.tsx (selection model,
presets), model-route-picker.tsx (structure/targets/current values),
command-registry.ts (`/setup`,`/provider` handlers), provider-config.ts
(failoverModels schema, custom provider schema), chat.tsx (picker wiring).
Not deep-read: full 2994-line provider-config resolution internals, OAuth
banner flow, model-route-picker form editing details.
