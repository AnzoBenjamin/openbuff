# SPEC — Compatibility-Reviewer Remediation Wave (compat-remediation-2026-09)

## Overview
Four NON_BLOCKING compatibility-reviewer findings remain open against the current dirty set (P4–P8 remediation + migration repairs). Each requires a targeted, finding-scoped change plus regression coverage, then a fresh compatibility-reviewer receipt to clear.

## Goals
1. Address each open finding at its causal root with minimal diff surface.
2. Keep all previously landed repairs intact (credentials copy-fallback, post-marker retirement, invalid-record reason, archive 64-hex naming, indexer --isolate).

## Non-Goals
- Reverting the underlying behavior changes (boolean return, field removal, 64-hex naming, model-driven set_output) — reviewers confirmed the new contracts are the right ones; the remedies are documentation, tolerance, or regression proof.
- Any unrelated cleanup, refactors, or new features.

## Findings → Required Outcomes

### C1. savechunksidecar-void-to-boolean
- File: `packages/indexer/src/index-store.ts` (`saveChunkSidecar`, ~line 505).
- Signature widened `Promise<void>` → `Promise<boolean>`. TypeScript already permits passing `Promise<boolean>`-returning fns where `Promise<void>` callbacks are expected, so the residual risk is silent contract drift for consumers built against the old `.d.ts`.
- Outcome: publish the contract change (sdk CHANGELOG entry + JSDoc on `saveChunkSidecar` naming the old/new signature and the boolean meaning: `true` = validated write, `false` = rejected by validator/fallback). Optional test already exists (`index-store.test.ts:488,497`) pinning both boolean branches — extend only if the doc change alters behavior (it must not).

### C2. agentstate-field-removal-persisted-state-compat
- File: `common/src/types/session-state.ts` (field removed); read paths in `cli/src/utils/run-state-storage.ts`.
- Verified live: the CLI read path uses raw `JSON.parse(...) as ...` casts and `sanitizeForChatPersistence` (non-strict) — no strict zod schema rejects unknown/legacy fields, so old snapshots carrying `consecutiveTextOnlyWithoutCompletion` load unchanged and the stale field is simply dropped on next save.
- Outcome: add a regression test (in `cli/src/utils/__tests__/run-state-storage.test.ts`) that a legacy checkpoint/chat-state JSON containing the removed field still loads through `loadCheckpoint` / `loadChatStateFromDirectory` without error, proving the non-strict read contract. No production change required.

### C3. archive-filename-64hex-mirror-contract
- Files: `cli/src/commands/memory-command.ts` (`runCompact`), `cli/src/commands/__tests__/memory-command.test.ts`.
- Legacy 8-hex mirror files no longer match the canonical 64-hex `claim.archived` suffix. The post-apply mismatch path already reports a warning instead of failing; the orphaned legacy file remains on disk as a recoverable artifact but is not surfaced.
- Outcome: in `runCompact`'s mismatch branch, detect a legacy `archive-<8hex>.jsonl` sibling and include it in the warning message as the legacy recovery artifact (with guidance that the canonical full-digest file is authoritative). Add/extend a CLI test covering the legacy-mirror warning shape.

### C4. researcher-web-toolnames-contract-change
- Files: `agents/researcher/researcher-web.ts` (new contract live), `docs/agents-and-tools.md`, optionally sdk CHANGELOG.
- `set_output` moved from `programmaticToolNames` into `toolNames`; embedders that introspected `programmaticToolNames` to intercept set_output at generator level will see `[]`.
- Outcome: document the embedder-facing behavioral change (docs/agents-and-tools.md: programmatic vs model-facing tool contract, note that structured_output agents now declare set_output in toolNames and hosts must intercept at the model-call boundary). The new contract is already pinned by `agents/__tests__/researcher-web.test.ts` — no code change.

## Acceptance Criteria
- AC1: sdk/indexer typecheck green; CHANGELOG documents the boolean contract; no behavior change.
- AC2: run-state-storage tests include a legacy-field passthrough case; cli typecheck green.
- AC3: runCompact mismatch warning names the legacy mirror; cli memory-command tests green.
- AC4: docs/agents-and-tools.md documents the set_output contract change; agents tests green.
- AC5: All prior repairs still pass: sdk typecheck 0 + v1-migration/credentials 69/69; indexer suite green with --isolate (226 tests).

## Relevant Files / Systems
- packages/indexer/src/index-store.ts, sdk/CHANGELOG.md
- common/src/types/session-state.ts, cli/src/utils/run-state-storage.ts + its tests
- cli/src/commands/memory-command.ts + cli/src/commands/__tests__/memory-command.test.ts
- agents/researcher/researcher-web.ts, docs/agents-and-tools.md, agents/__tests__/researcher-web.test.ts
