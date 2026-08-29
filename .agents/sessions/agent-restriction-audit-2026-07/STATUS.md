# STATUS — Over-strict Agent Guardrail Audit

## Current state

Codebase-wide audit complete (plan mode). No source changed. Six restriction
surfaces mapped across SDK/CLI/agents/runtime; findings written with file:line
evidence and A/B/C classification.

## Completed

- SPEC + PLAN written; supersedes narrower shell-policy-audit-2026-07 (folded in).
- Shard findings written to .agents/sessions/agent-restriction-audit-2026-07/findings/:
  - read-and-path.md (sensitive-paths, read-files, path-utils, read-subtree, containment)
  - web-network.md (web-search fetch caps + SSRF keep-list)
  - tool-arg-allowlists.md (ripgrep flags, /git args, security-reviewer params, result caps)
  - edit-authorization.md (cap.v3, str_replace circuit breaker, read revocation)
  - spawn-permissions.md (handoff capability derivation — includes 1 HIGH read-lockout)
- terminal-policy surface covered by prior shell-policy-audit F1-F6 (git-committer fix).

## Key results

- 1 HIGH (spawn empty-readablePaths read lockout), several MEDIUM friction items.
- The genuine security controls (SSRF, secrets, containment, cap.v3, force-push)
  are sound and classified KEEP — the report separates friction from value.

## Pending (awaiting user decision)

- Which tiers to execute (Tier 1 recommended).
- T1.3 structured-commit path vs minimal heredoc allowance.

## Blocked

- Implementation blocked in plan mode + pending user go-ahead (security-sensitive).

## Next checkpoint

User selects tiers. Then exit plan mode, run security-reviewer advisory on the
touched security files, implement per-task, run named suites, then full gate.

## Resume instructions

Read SPEC.md + all findings/\*.md + PLAN.md tiers. Tier 1 tasks are independent
(T1.1-T1.5) and can be done in any order; T2.2 depends on T2.1.

<!-- update_plan_status:appended -->

## Tier 1 progress — 2026-07-24T07:28:35.108Z

Implemented T1.1, T1.2, T1.4, T1.5.

Validation:

- bun test packages/agent-runtime/src/**tests**/spawn-agents-permissions.test.ts → 35 pass
- bun test sdk/src/**tests**/find-files-matching-content.test.ts → 26 pass
- bun test cli/src/commands/**tests**/git-command-args.test.ts → 8 pass

Still pending: T1.3 git-committer, Tiers 2–3.

Changed source:

- packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts
- packages/agent-runtime/src/**tests**/spawn-agents-permissions.test.ts
- sdk/src/tools/find-files-matching-content.ts
- sdk/src/**tests**/find-files-matching-content.test.ts
- cli/src/commands/git-command-args.ts
- cli/src/commands/**tests**/git-command-args.test.ts

<!-- update_plan_status:appended -->

## T1.3 progress — 2026-07-24T07:46:12.342Z

Editor updated common/src/constants/git-discipline.ts to recommend multiple -m flags instead of blocked HEREDOC. Validation: bun test terminal-command-policy.test.ts pending.

<!-- update_plan_status:appended -->

## Tier 1 complete — 2026-07-24T07:47:22.412Z

All Tier 1 tasks done:

- T1.1 empty readablePaths read lockout fixed
- T1.2 spawnableAgents + programmaticToolNames preserved on handoff
- T1.3 gitCommitGuidePrompt reconciled (multiple -m; no HEREDOC)
- T1.4 ripgrep -ni expansion + -v/-c flags
- T1.5 /git pathspec ()[]{} allowed

Validation receipts:

- spawn-agents-permissions: 35 pass (kwPDvM-wCIg)
- find-files-matching-content: 26 pass (kwPDwKZR-Js)
- git-command-args: 8 pass (kwPDxEHrdNM)
- terminal-command-policy: 30 pass (kxbIGIjqXpI)
- security-reviewer LOOKS_GOOD (kwvcyLW4E1g)

Pending: Tier 2 (sensitive-paths, absolute reads), Tier 3 (throughput caps, str_replace friction).

<!-- update_plan_status:appended -->

## Tier 2 complete — 2026-07-24T08:13:25.528Z

T2.1 + T2.2 implemented and validated.

- sensitive-paths: drop .crt/.cer/.yarnrc; kubeconfig exact match; .tfstate endsWith only
- path-utils: allow absolute POSIX form; drive/UNC/.. still rejected; containment remains authority

Validation:

- bun test common/src/util/**tests**/sensitive-paths.test.ts → 5 pass (ky5wT4qXgdY)
- bun test sdk/src/**tests**/path-utils.test.ts → 17 pass (ky5wU9eXFWY)
- security-reviewer LOOKS_GOOD (ky5wV3MoQeI)

Next: Tier 3 optional (throughput caps + str_replace friction).

<!-- update_plan_status:appended -->

## Tier 3 complete — 2026-07-24T08:30:15.044Z

T3.1 + T3.2 implemented and validated.

Throughput caps:

- MAX_RANGE_READ_BYTES 1MB → 4MB
- LIVE_SUBTREE_MAX_NODES 1000 → 5000
- MAX_WEB_FETCH_BYTES 512KB → 2MB (soft-truncate declared oversize)
- MAX_FETCH_LENGTH 50KB → 150KB
- code_search maxResults 15 → 30
- find_files_matching_content maxFiles 100 → 250
- MAX_SPAWN_BATCH_SIZE 8 → 12

str_replace friction:

- small-file unique oldString auto-strips stale basedOnRead (large files still hard-fail)
- circuit breaker limit 3 → 5; clean success drains by 1
- revoke fresh-read only on true stale/cross-run capability failures

Validation:

- process-str-replace.test.ts → 73 pass (kz2XXWstvs8)
- str-replace-circuit-breaker.test.ts → 6 pass (kz2XYov_dfQ)
- read-subtree.test.ts → 18 pass (prior)
- spawn-agents-permissions.test.ts → pass with batch size 12 (prior)

All Tier 1–3 remediation complete. Keep-list security controls unchanged.

<!-- update_plan_status:appended -->

## CB-DRAIN-OSCILLATION repair — 2026-07-24T08:50:49.801Z

Security-reviewer BLOCKING CB-DRAIN-OSCILLATION on drain-by-1 success.

Fix: clean exact-match success leaves consecutiveStrReplaceFailuresByPath unchanged (non-draining). Limit stays 5. Failures and auto-correct still increment. Structural recovery may still full-clear.

Validation: str-replace-circuit-breaker.test.ts → 6 pass (k0yZKaIADXE).
Security re-review pending on snapshot b86f88b1c48509decca134ca3bde20dc9147a53422c42845a61f0cc5d59fef4b.

<!-- update_plan_status:appended -->

## Tier 3 complete (post CB-DRAIN fix) — 2026-07-24T08:52:23.628Z

T3.1 + T3.2 complete.

Throughput (T3.1):

- MAX_RANGE_READ_BYTES 4MB, LIVE_SUBTREE 5000, web fetch 2MB/150KB, code_search 30, maxFiles 250, spawn batch 12

str_replace (T3.2):

- small-file unique stale basedOnRead auto-strip; large files hard-fail
- circuit breaker limit 5; clean success non-draining (CB-DRAIN-OSCILLATION fixed)

Validation:

- process-str-replace 73 pass (kz2XXWstvs8)
- circuit-breaker 6 pass (k0yZKaIADXE)
- security-reviewer LOOKS_GOOD (k1H1MlKhSNo) snapshot b86f88b1...

All Tier 1–3 remediation complete. Keep-list security controls unchanged.

<!-- update_plan_status:appended -->

## Final specialist attestation — 2026-07-24T09:13:33.652Z

reliability-reviewer LOOKS_GOOD (k2VmxFlExQk) on snapshot b52ba1d591816414e5f48ba1fbf4f784d862ca5f876ed99259ae325f700fb2bf.
security-reviewer LOOKS_GOOD (k1H1MlKhSNo) after CB-DRAIN non-draining fix.
Smoke: 114 pass / 0 fail across circuit-breaker + process-str-replace + spawn-agents-permissions (k2VmzIm7NOU).

Plan session completed. All Tier 1–3 tasks done. Keep-list security controls unchanged.

<!-- update_plan_status:appended -->

## Followups in progress — 2026-07-24T14:21:40.614Z

User requested all three suggested followups: docs note, broader regression tests, commit via git-committer (source+docs; exclude plan session dirs).

<!-- update_plan_status:appended -->

## Followups: tests + docs — 2026-07-24T14:45:57.586Z

Docs: agents-and-tools.md Agent restriction policy section + stale cap numbers fixed.
SDK absolute-path tests updated for T2.2 (change-file, run-file-filter).
Database suite isolation: clearUserInfoCacheForTests() + beforeEach/afterEach clear.
Awaiting full sdk suite green then git-committer (source+docs; exclude plan sessions).

<!-- update_plan_status:appended -->

## Broader regression results — 2026-07-24T14:52:52.715Z

agent-runtime: 1172 pass / 0 fail
cli: 2450 pass / 0 fail (15 skip)
sdk: 1036 pass / 0 fail (1 skip) after absolute-path test updates + database cache isolation (clearUserInfoCacheForTests + mock.restore in beforeEach)

Next: git-committer with source+docs owned_paths; exclude .agents/sessions/\* and packages/agent-runtime/docs/

<!-- update_plan_status:appended -->

## Followups status — commit blocked on gate — 2026-07-24T14:59:12.800Z

1. Docs: done — docs/agents-and-tools.md Agent restriction policy (relaxed vs keep) + cap number fixes.
2. Broader tests: done — agent-runtime 1172 pass; cli 2450 pass; sdk 1036 pass / 0 fail after absolute-path test updates + database cache isolation.
3. Commit: blocked — git-committer withheld until validation/reviewer gate passes for pending files (incl. sdk/src/**tests**/database.test.ts). Will spawn git-committer once gate reports passed; owned_paths = source+docs only (exclude .agents/sessions/\* and packages/agent-runtime/docs/).

<!-- update_plan_status:appended -->

## RF-1 resolution recorded — 2026-07-24T15:28:36.261Z

Open reviewer finding RF-1-eef7064f (requirement uncertain: explain the reviewer double-spawn and terminal-stop) is addressed by a durable LESSONS.md entry rather than a source edit, because the requirement is an explanation, not a code behavior. Summary: (1) second review was required because the pending (snapshot, file-set) pair changed after the database.test.ts isolation fixes were added post-first-review; (2) the run stopped because migration-reviewer was the wrong specialist for a diff with no migration surface and hit specialist-terminal-failure after its single automatic snapshot refresh, so the gate fail-closed. A fresh code-reviewer against stable snapshot e0088f39 (rev 542) returned LOOKS_GOOD across all 27 pending files with zero blocking findings. Next: commit source+docs via git-committer once the gate attests the pending set.
