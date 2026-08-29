# Unified Background Job Architecture — STATUS

## Current state (workspace.v1.827) — M0–M4 + security fix GREEN

### Done

- **M0** Discovery/blast-radius machine-confirmed.
- **M1** Unified `common/src/util/job-registry.ts` core (lifecycle state machine, sequenced ring buffer, per-consumer cursors, wait/snapshot/stream, in-registry ownership). 63 unit tests.
- **M2** Shell (process) adapter in `sdk` on the unified core (spawn/kill/log capture/quota, cross-session recovery as write-only disk projection).
- **M3** Agent adapter in `agent-runtime` on the shared singleton (per-kind bounds, single-key ids, coroutine cancel, chunk streaming).
- **M4** Tool surface migrated (check_job/check_background_agent/kill_job/list_jobs/read_logs/end_turn) onto the unified core; legacy `pending-background-jobs` Map and `authorize/foreign/recover` gate deleted.
- **Security fix (SEC-1..6)** landed and validated:
  - Process-job ops stamp a TRUSTED owner from agentState/session (never model input), enforced via `jobRegistry.assertOwned`.
  - Follow-timeout hang fixed: `deadline = Date.now() + timeoutMs` moved to function entry in `sdk/src/tools/check-job.ts`.
  - TS2590 fixed: `ProcessJobClientToolCall` is a standalone structural type; handlers cast at the forward boundary.
  - Recovery re-attach lockout fixed: added `JobRegistry.restampOwner()`; `getBackgroundJob` upgrades only a placeholder owner to the trusted owner (never overwrites a real owner).
  - 3 agent-runtime handler tests retyped `forwardedToolCall` to `ProcessJobClientToolCall`.

### Validation (workspace.v1.827)

- Typechecks: common:0, sdk:0, agent-runtime:0 (clean).
- sdk background-job suites: 55 pass / 0 fail.
- agent-runtime + common job suites: 94 pass / 0 fail.

### Remaining

- **M5** Wire live job event stream to CLI; render live job activity.
- **M6** Update prompts, docs, evals; regenerate release bundles (controlled breaks).
- **M7** Final cross-package validation + dev-server smoke + coverage gate; final review.

## Resume instructions

Backend unification + security hardening is complete and green. Next checkpoint is M5 (live UI). The full design lives in `PLAN.md`; the security findings/decisions live in `LESSONS.md`.

<!-- update_plan_status:appended -->

## M5 Live UI Complete (verified implemented) — 2026-08-01 — 2026-08-01T14:43:39.935Z

M5 needed NO new code — the live-UI chain was already implemented and unit-tested; the plan's IN PROGRESS checkbox was stale. Verified by reading source + running the two relevant suites.

Run-loop forwarding (M5.1): `sdk/src/job-update-forwarder.ts` (`createJobUpdateForwarder`) is subscribed once in `sdk/src/run.ts` with the trusted owner and disposed on every terminal path (abort + normal completion), so the process-wide `jobRegistry` singleton never leaks listeners. `common/src/types/print-mode.ts` registers `printModeJobUpdateSchema` (additive union member). Owner-scoped: rejects foreign + `UNKNOWN_JOB_OWNER`; forwards lifecycle+output only.

CLI render (M5.2): `handleJobUpdate` in `cli/src/utils/sdk-event-handlers.ts` (registered in the match) updates correlated tool blocks (lifecycle + 50k tail-bounded output + flag-deduped error append) and agent blocks (status + truncated error). Correlation wired in production: `tool_call` carries `backgroundJobId`; `handleRegularToolCall` stores it. `cli/src/components/terminal-command-display.tsx` renders `job <id> · status · detached · log`.

Validation: `bun test sdk/src/__tests__/run-job-updates.test.ts` = 6 pass/0 fail; `bun test cli/src/utils/__tests__/sdk-event-handlers.test.ts` = 26 pass/0 fail (incl. all 13 job_update cases).

Remaining for M5's spirit: the LIVE real-terminal dev-server smoke — that is M7.3, intentionally deferred.

Next: M6 (prompts/docs/evals/generated bundles). M6.1 base2 prompt (line 292) already documents live-surface behavior; verify editor.ts/base-deep.ts prompts, docs/deterministic-edit-system.md, and regenerate cli/release bundles.

<!-- update_plan_status:appended -->

## M6 Prompts/Docs/Evals Complete — 2026-08-01 — 2026-08-01T14:58:36.878Z

M6 needed NO new edits — prompts, docs, and evals were already aligned with the unified job contracts. Verified by source search, not assumed.

M6.1 (agent prompts): `agents/base2/base2.ts:292` already documents the unified model (BACKGROUND process_type → jobId; check_job/wait_for readiness; kill_job; list_jobs rediscovers shell+agent jobs; "live job status and output surfaced automatically"). `agents/editor/editor.ts` and `agents/base2/base-deep.ts` contain ZERO references to the deleted authorize/foreign/recover/pending-background-jobs model.

M6.2 (docs): `docs/deterministic-edit-system.md:28` and `docs/agents-and-tools.md:581-628` already describe the unified JobRegistry (process+agent kinds, one lifecycle machine, assertOwned foreign→not-found, restampOwner, additive job_update). No doc still documents the deleted tri-state gate or pending-background-jobs Map.

M6.3 (evals + bundles): evals/buffbench/_ are clean — no job-tool references, no ownership-behavior assertions. cli/release_/index.js regeneration DEFERRED to the CI release workflow (user decision): build-binary.ts is the CI release path (requires version, compiles platform binaries), and the bundles are regenerate-not-hand-edit artifacts.

Next: M7 (final cross-package validation + live dev-server smoke + coverage gate + final review).
