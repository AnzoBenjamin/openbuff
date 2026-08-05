# Environment Variables

## Quick Rules

- Public client env: `NEXT_PUBLIC_*` only, validated in `common/src/env-schema.ts` (used via `@codebuff/common/env`).
- LLM provider keys: validated in `packages/internal/src/env-schema.ts` (used via `@codebuff/internal/env`). The hosted-backend DB/auth/email server secrets have been removed from this repo.
- Runtime/OS env: pass typed snapshots instead of reading `process.env` throughout the codebase.
- `IPINFO_TOKEN` is only relevant to legacy/upstream hosted flows. Openbuff local/BYOK CLI usage does not require it.
- `CODEBUFF_FULL_TELEMETRY=true` or `CODEBUFF_FULL_TELEMETRY_IDS=user-id,email@example.com`
  disables client analytics sampling for targeted debugging. Use sparingly because it can send full CLI log payloads.

## Env DI Helpers

- Base contracts: `common/src/types/contracts/env.ts` (`BaseEnv`, `BaseCiEnv`, `ClientEnv`, `CiEnv`)
- Helpers: `common/src/env-process.ts`, `common/src/env-ci.ts`
- Test helpers: `common/src/testing-env-process.ts`, `common/src/testing-env-ci.ts`
- CLI: `cli/src/utils/env.ts` (`getCliEnv`)
- CLI test helpers: `cli/src/testing/env.ts` (`createTestCliEnv`)
- SDK: `sdk/src/env.ts` (`getSdkEnv`)
- SDK test helpers: `sdk/src/testing/env.ts` (`createTestSdkEnv`)

## Loading Order

Bun loads (highest precedence last):

- `.env.local` (Infisical-synced secrets, gitignored)
- `.env.development.local` (worktree overrides like ports, gitignored)

## Openbuff and Codebuff Environment Variables

Document only environment variables that are implemented in code. During the fork transition, several `CODEBUFF_*` names remain supported only as legacy compatibility aliases or existing internal names:

- `OPENBUFF_LOCAL_MODE` controls local/BYOK mode. `CODEBUFF_LOCAL_MODE` is NOT supported (removed in the BYOK purge).
- `OPENBUFF_PROVIDER_CONFIG` points to provider configuration JSON. `CODEBUFF_PROVIDER_CONFIG` is NOT supported (removed in the BYOK purge).
- `OPENBUFF_TELEMETRY=0` (also `false` or `off`) disables runtime analytics. `DO_NOT_TRACK=1` is honored as a standard compatibility opt-out. The interactive local CLI currently emits no analytics, but these controls also cover shared runtime code used by integrations.
- `CODEBUFF_API_KEY` is a legacy upstream compatibility name for Codebuff API authentication and any live tests that still exercise that compatibility path. Openbuff local/BYOK provider mode does not require a Codebuff API key.
- `OPENBUFF_GIT_BASH_PATH` is the primary Windows bash path override used by the SDK terminal command helper. `CODEBUFF_GIT_BASH_PATH` remains a compatibility fallback.
- `CODEBUFF_CHATGPT_OAUTH_TOKEN` is the legacy ChatGPT OAuth token name. `OPENBUFF_CHATGPT_OAUTH_TOKEN` is implemented as an alias; the SDK resolves `CODEBUFF_CHATGPT_OAUTH_TOKEN ?? OPENBUFF_CHATGPT_OAUTH_TOKEN` (`sdk/src/env.ts`), so the legacy name takes precedence over the alias (reversed from the API-key ordering).
- `NEXT_PUBLIC_CODEBUFF_APP_URL` remains the required public app URL field. `NEXT_PUBLIC_OPENBUFF_APP_URL` is implemented as an optional public client env field in `common/src/env-schema.ts`, but current accessors still require and read the Codebuff-named URL for the primary app URL.

`CODEBUFF_API_KEY` functions as a runtime fallback (`OPENBUFF_API_KEY ?? CODEBUFF_API_KEY` in `sdk/src/env.ts`, Openbuff primary). `CODEBUFF_CHATGPT_OAUTH_TOKEN` also has an `OPENBUFF_*` alias but with reversed precedence (legacy name primary). `OPENBUFF_GIT_BASH_PATH` takes precedence over the legacy `CODEBUFF_GIT_BASH_PATH` fallback.

Context-budget and proactive-retrieval behaviors remain code-default (no new
env vars). Progressive prompt/tool disclosure and gate repair budgets each have
optional env canaries:

- `OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE` — `progressivePromptDisclosure`
  is ON by default: when the option is omitted, `createBase2` enables
  progressive prompt disclosure even without any env var set. The canary
  (`1`, `true`, `yes`, or `on`, case-insensitive) still forces it on when the
  option is omitted. Explicit option values always win:
  `progressivePromptDisclosure: false` turns disclosure off (the
  pre-disclosure prompt surface), and explicit `true` wins over the env
  canary.
- `OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE` — when set to `1`, `true`, `yes`, or
  `on` (case-insensitive), `createBase2` defaults `progressiveToolDisclosure`
  to `true` if the option is omitted. Explicit `true`/`false` on the agent
  option always wins over the env canary. When enabled with no unlocked tiers,
  the model-visible tool surface is CORE-only (mode gates still apply).
  Production stays off unless the canary or option is set.
- `OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS` — positive integer string for the
  reviewer→repair→re-review budget (default `6`, max `20`). Invalid or missing
  values fall back to `6`. Explicit `createBase2({ maxReviewerRepairRounds })`
  always wins over the env canary. NON_BLOCKING findings also burn this budget
  under LOOKS_GOOD-only finalization.
- `OPENBUFF_MAX_REPAIR_ROUNDS` — positive integer string for the validation-hook
  repair-editor budget (default `3`, max `20`). Invalid or missing values fall
  back to `3`. Explicit `createBase2({ maxRepairRounds })` always wins over the
  env canary.
- `OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS` — positive integer string for the
  specialist→repair→re-review budget (default `3`, max `20`). Invalid or missing
  values fall back to `3`. Explicit `createBase2({ maxSpecialistRepairRounds })`
  always wins over the env canary.

Do not document an `OPENBUFF_*` alias unless the code implements it.

## Releases

Release scripts read `OPENBUFF_GITHUB_TOKEN` (primary) or `CODEBUFF_GITHUB_TOKEN` (compatibility fallback).
