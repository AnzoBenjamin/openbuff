# SPEC — Agent-body feature-gap audit (Openbuff CLI)

Status: scope pinned, audit in progress. This file is rewritten once shard findings are synthesized.

## Goal

Openbuff should be a complete, reliable **body for a coding agent**: the agent must be able to
perceive the workspace, mutate it, run and verify work, recover from failure, and prove completion —
for any coding task, on a local-only machine with no backend.

This audit answers three questions:

1. **Tool quality** — for every tool the agent can call, is the implementation complete and
   trustworthy (correct, structured errors, recovery guidance, failure states, tested)?
2. **Tool gaps** — which capabilities a coding agent needs are missing entirely?
3. **Over-strict guardrails** — which security/permission rules block legitimate local work
   without protecting anything meaningful in a local-only, single-user CLI?

## Non-goals (explicitly out of scope for this audit)

- Token-consumption / context-cost reduction as an objective. Context handling is only in scope
  where a *failure* (dropped evidence, lost capability, silent truncation) breaks task completion.
- Backend, multi-tenant, hosted-inference, billing, or credit concerns — none exist in this product.
- Model/prompt quality tuning and eval-score chasing.
- Cosmetic TUI polish unrelated to agent capability or operator verification.

## Snapshot

- Structural snapshot: `fb71d9a3e8f5d047c4dc944c4ef1bd14421da14d6e67e1af6c6c2d6cc5c3bcce`
- Subsystems inventoried: 24 top-level; source-bearing: `cli`, `sdk`, `packages/*`, `common`,
  `agents`, `scripts`, `evals`, `.agents`.

## Audit domains (per shard)

Each shard evaluates its files against: security, correctness, state mutation, error handling,
performance, dependency hygiene, test coverage, API/contract stability — and additionally, for this
audit: **capability completeness** (can an agent actually finish a task with this tool?) and
**over-strictness** (does a guard block legitimate local work?).

## Acceptance criteria for the audit itself

- Every source-bearing subsystem is either sharded or explicitly marked out-of-scope with a reason.
- Every agent-callable tool in `common/src/tools/list.ts` appears in at least one shard's coverage.
- Findings are persisted under `.agents/sessions/audit-agent-body-2026-09/findings/`.
- Coverage is machine-checked with `evaluate_audit_coverage` before synthesis.
- The deliverable is a prioritized, source-backed plan — not a prose essay.
