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
