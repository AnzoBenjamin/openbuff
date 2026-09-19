# Openbuff Documentation

Openbuff is a local-first, bring-your-own-key (BYOK) coding CLI. Start here if
you are new to the project.

## Start here

- [Getting Started](./getting-started.md) — Install, provider setup, model
  routing, and verification; the recommended first read.
- [Local / BYOK provider mode](./local-mode.md) — Provider setup details and
  TUI commands.
- [Configuration](./configuration.md) — Config file locations, layering,
  merge semantics, and file-change hooks.

## Using Openbuff

- [Agents and tools](./agents-and-tools.md) — The agent system, tool
  definitions, and custom agents.
- [Environment variables](./environment-variables.md) — `OPENBUFF_*` env vars
  and `apiKeyEnv` names.
- [Development](./development.md) — Dev setup, running from source, tests,
  and CI-local checks.

## Internals & reference

- [Architecture](./architecture.md) — Monorepo package structure.
- [Request flow](./request-flow.md) — Prompt → SDK → runtime → provider
  lifecycle.
- [Deterministic edit system](./deterministic-edit-system.md) —
  Read-before-edit guidance and deterministic edit tools.
- [Testing](./testing.md) — DI-over-mocking test conventions and
  per-package `bun` scripts.

## Migration & planning

- [Codebuff → Openbuff migration](./codebuff-to-openbuff-migration.md) —
  Legacy Codebuff name compatibility map.
- [Memory V1 removal readiness](./memory-v1-removal-readiness.md) —
  Readiness plan for a future Memory V1 removal decision.
- [Authentication](./authentication.md) — Legacy Codebuff cloud auth
  reference. **Historical only — not used in local/BYOK mode.**
- [Provider & model setup UX proposal](./openbuff-provider-model-setup-ux.md)
  — Internal setup-UX proposal.
- [Goal](./goal.md) — The project goal, in one line.

## Repo docs

- [README](../README.md) — Project overview and SDK.
- [AGENTS.md](../AGENTS.md) — Agent conventions.
