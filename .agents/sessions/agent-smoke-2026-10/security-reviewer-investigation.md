# Investigation: security-reviewer empty output on manual spawns

Date: 2026-10-08. Scope: the Wave-1 smoke observation that `security-reviewer` returned only `{ params, snapshotFingerprint }` with no review content, plus a comparison against the other specialist reviewers.

## What happened in the smoke test

Wave 1 spawned security-reviewer with a terse prompt ("Confirm there are no injection, path, secret, or process risks and report findings or a clean verdict") and a synthetic fingerprint (`manual-smoke-no-gate-token`). The agent returned an object containing only the echoed params and fingerprint — no verdict, findings, dimensions, or requirementCoverage. Every other reviewer-family agent (product-reviewer, reliability-reviewer, migration-reviewer, accessibility-reviewer, ux-visual-reviewer, compatibility-reviewer, dependency-reviewer, code-reviewer) returned full structured output on the same manual-spawn pattern.

## Control probe (decisive)

Re-spawning security-reviewer with the SAME synthetic fingerprint but a prompt that explicitly requested the full structured output ("return your complete structured output (schemaVersion, snapshotFingerprint, reviewedFiles, verdict, findings, coverage, dimensions, requirementCoverage)") produced a complete, high-quality review: verdict LOOKS_GOOD, 2 findings, all dimensions, full requirementCoverage, exact fingerprint echo.

**Conclusion: the empty output was prompt-shape-driven, not a fingerprint-protocol rejection.** The runtime does not reject the synthetic token (the schema imposes no `v3:` pattern on `snapshot_fingerprint`), and the agent happily reviews with it when told to produce the full schema.

## Source-level findings

1. **Manual-spawn protocol is designed and documented — but inconsistently across families.**
   - `agents/specialists/create-specialist.ts` (all routed specialists): explicit omit-for-manual contract — `params.snapshot_id` optional, `snapshotFingerprint: ""` on manual spawns, documented in the instructionsPrompt and in `agents/guides/specialist-routing.md`.
   - `agents/security-reviewer/security-reviewer.ts`: the documented exception — schema hard-requires `changed_files` + `snapshot_fingerprint` on EVERY spawn (manual included), but imposes no `v3:` pattern, so a manual caller supplies its own stable value. Also documented in specialist-routing.md and `common/src/constants/prompt-sections.ts`.
   - `agents/reviewer/code-reviewer.ts`: schema requires `snapshotFingerprint` as a plain string; the instructionsPrompt says "Copy only the fingerprint token from the prompt" — works for manual spawns when the caller supplies a value.

2. **The real defect: reviewer-family output is NOT schema-validated at runtime.** In `packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts`, `compactReviewerOutput` (L665-727) only compacts when `output.verdict` is a string; a verdict-less object passes through unchanged. Nothing in the spawn path validates the structured output against the agent's declared `outputSchema` before delivery. So a reviewer that emits a degenerate object still "succeeds" from the runtime's perspective and the parent receives garbage with `outcome: ok`. The gate-side helpers (`detectReviewerCrash`, `resolveReviewerFinalizationVerdict` in `agents/base2/gate-reviewer.ts`) distinguish crash vs no-verdict, but a non-null, non-verdict object is silently treated as a normal (malformed) reply.

3. **security-reviewer's instructions are the least explicit about the manual-spawn shape.** Its instructionsPrompt (L136) says "Return only the required structured output... Echo params.snapshot_fingerprint exactly" but, unlike create-specialist and code-reviewer, it has no explicit worked example of the full JSON object and no mention of what a manual (non-gate) spawn means. With a terse caller prompt and a synthetic-looking token, the model chose a minimal acknowledge-style object instead of the full schema. The probe shows explicit field enumeration fixes this — meaning the fix belongs in the agent's instructions (add a worked minimal-shape example and a manual-spawn note like create-specialist has), not in the protocol.

## Recommendations

- **Caller guidance (no code change):** when manually spawning security-reviewer, include an explicit instruction to return the complete structured output per its schema (as specialist-routing.md's example flow does). This alone resolves the observed failure.
- **Runtime hardening (follow-up work):** validate reviewer-family structured output against the declared outputSchema at set_output time (or extend `compactReviewerOutput`/`detectReviewerCrash` to classify a verdict-less reviewer object as "no structured output" so the existing automated-retry path triggers instead of delivering a garbage receipt).
- **Agent-definition hardening (follow-up work):** port create-specialist's worked output example and the explicit omit-for-manual/fingerprint-echo wording into security-reviewer's instructionsPrompt so terse manual prompts cannot collapse to a degenerate reply.

## Verdict

Not a spawn-protocol bug and not family-wide: one agent (security-reviewer) under-produces on terse manual prompts, and the runtime lacks schema validation that would catch and retry it. All other specialist reviewers handled manual spawns correctly in the smoke test.
