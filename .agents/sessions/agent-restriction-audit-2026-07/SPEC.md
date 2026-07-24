# SPEC — Over-strict Agent Guardrail Audit (codebase-wide)

## Overview
The user asked for a GENERAL audit of security/guardrail controls that limit our
agents more than they protect. The git-committer (git-commit terminal profile)
is ONE example, not the scope. This audit covers every "agent restriction"
surface in the SDK/CLI/agents/runtime and classifies each control as:
(A) safe to relax/remove (friction > value), (B) consolidate/soften, or
(C) keep (real security value).

Supersedes the narrower `shell-policy-audit-2026-07` session, which only covered
the terminal-command policy. That session's F1–F6 findings are folded in here as
the "terminal-policy" shard.

## Snapshot
- inspect_codebase_structure snapshotId:
  7ae7b7cee225b1cd331f12ae17993437bd4a8fd96509802ed572f4e0567cd33a

## Goals
- Enumerate ALL runtime-enforced agent restrictions, not just terminal/git.
- For each, cite the exact file:line enforcement point and give a concrete,
  minimal relaxation candidate where the control is mostly friction.
- Keep genuine security controls (traversal, secrets, privilege escalation,
  SSRF, force-push) intact.

## Non-Goals
- Removing traversal/containment, secret-scanning, privilege-escalation, SSRF,
  or force/default-branch-push protections.
- Rewriting the harness approval architecture.
- Implementation (plan mode).

## Restriction surfaces / shards
1. terminal-policy — sdk/src/tools/terminal-command-policy.ts,
   sdk/src/services/harness-enforcement.ts, sdk/src/tools/run-terminal-command.ts,
   agents/git-committer, common/src/constants/git-discipline.ts.
2. read-and-path — sdk/src/tools/read-policy.ts, read-files.ts, path-utils.ts,
   common/src/util/sensitive-paths.ts, project-path-containment.ts.
3. tool-arg-allowlists — ripgrep flag allowlist in sdk/src/tools/code-search.ts &
   find-files-matching-content.ts; cli/src/commands/git-command-args.ts;
   agents/security-reviewer glob parity; glob/list-directory limits.
4. web-network — packages/agent-runtime/src/tools/handlers/tool/web-search-utils.ts
   (isBlockedWebAddress/assertSafePublicWebUrl), read-only network-mutation bans.
5. edit-authorization — packages/agent-runtime/src/util/read-authorization.ts,
   tools/handlers/tool/edit-read-state.ts, str-replace circuit breaker,
   cap.v3 read-before-edit gating.
6. spawn-permissions — packages/agent-runtime/src/tools/handlers/tool/
   spawn-agent-utils.ts permission/profile/tool derivation for child agents.

## Acceptance criteria
- Every shard writes findings with file:line evidence + A/B/C classification.
- evaluate_audit_coverage passes over the shard receipts + snapshot.
- Synthesized report ranks removal candidates by (friction relieved / risk added).
- git-committer fix appears as ONE item among several, not the whole report.
