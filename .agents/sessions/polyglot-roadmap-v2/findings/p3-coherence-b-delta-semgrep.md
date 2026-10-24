# Audit findings: p3-coherence-b-delta-semgrep

- Subsystems: sdk-diagnostic-delta-preflight, sdk-semgrep-baseline-securityscan, sdk-file-change-hooks, sdk-run-targeted-validation, sdk-change-review-bundle, sdk-run-tool-dispatch
- Features: P3-T3, P3-T11, LI-02, LI-10
- Files covered: 9

## [HIGH] correctness — sdk/src/services/diagnostic-delta-runner.ts:188 — P3-T3 verdict: PARTIAL — reject-only-new-errors semantics are unreachable in the production wiring; the only wired injector structurally guarantees acceptance
- **Risk:** The plan's core claim (an edit is rejected ONLY if it introduces NEW error-severity diagnostics) is not enforced by any reachable code path. The rejection machinery (preflightDiagnosticDelta with a real applyEdit/rollbackEdit) has no production caller — referencedBy shows only the test file — so new-error gating never fires and runTargetedValidation's hard-fail arm for it is dead in production.
- **Fix:** Wire a baseline-owning injector on the mutation-broker path (change-file.ts / filesystem-authority.ts snapshotting diagnostics pre/post edit) or capture the pre-edit baseline before edits are applied, so the delta can actually reject; until then the plan's gating claim is not enforced anywhere live.
- **Evidence:** sdk/src/services/diagnostic-delta-runner.ts:~188-210 — createDiagnosticDeltaHook returns preflight({ files, cwd, runCommand, applyEdit: () => {}, skipSecondCapture: true, ... }); skipSecondCapture doc in sdk/src/services/diagnostic-delta.ts:~285-293 says the after-capture reuses the baseline so 'delta collapses to empty → accept'. sdk/src/run.ts:~455-465 builds diagnosticDeltaHook = createDiagnosticDeltaHook({ spawn }) and threads it via handleToolCall into the run_file_change_hooks (~2400) and run_targeted_validation (~2520) branches; run-targeted-validation.ts:~77-84 treats validationStatus === 'diagnostic_delta_rejected' as a hard failure — unreachable. referencedBy for preflightDiagnosticDelta lists only sdk/src/__tests__/diagnostic-delta.test.ts.

## [MEDIUM] correctness — sdk/src/services/diagnostic-delta.ts:232 — Tolerant delta key (file, code) masks genuinely new errors that share a rule code with a pre-existing diagnostic
- **Risk:** tolerantKey matches on (file, code) only. A pre-existing diagnostic with code E in file F matches ANY after-state diagnostic with the same (F, E), so an edit that introduces a SECOND, genuinely new error of an already-present code in the same file is not rejected. The docstring documents the line-shift rationale, but the masking of new duplicate-code errors goes beyond shifted pre-existing errors and weakens the reject-only-new-errors guarantee further (compounding finding 1).
- **Fix:** Consider count-aware (multiset) matching per (file, code): a new diagnostic that raises the per-(file,code) count above baseline counts as new, while pure line shifts stay tolerated.
- **Evidence:** sdk/src/services/diagnostic-delta.ts:~60-77 DeltaMatchMode docs ('tolerant' (default): match on (file, code) only); ~230-235 tolerantKey returns JSON.stringify([diagnostic.file, diagnostic.code]); ~245-255 computeDiagnosticDelta builds a Set of baseline keys and filters after against it; resolveDeltaKeyOf (~260-275) defaults to tolerant unless OPENBUFF_DIAGNOSTIC_DELTA_MODE=strict.

## [LOW] correctness — sdk/src/services/diagnostic-delta.ts:39 — P3-T3 verified claims (b, c, e, f, g) MATCH: fix-its, flag-off byte-identity, deferred-daemon docs, rollback guard, deadline escalation pattern
- **Risk:** Informational verdict anchor for P3-T3 sub-claims that MATCH: (c) flag OFF byte-identical — DIAGNOSTIC_PREFLIGHT_FLAG + isDiagnosticPreflightEnabled (sdk/src/tools/file-change-hooks.ts:~763-785) gate the delta block `isDiagnosticPreflightEnabled(env) && params.diagnosticDelta` (~887), so flag-off skips the block entirely; run.ts passes the injector unconditionally with the flag check inside runFileChangeHooks (run.ts:~455-465). (b) fix-its aggregated with dedupe + MAX_FIXITS=50 (diagnostic-delta.ts:~388-405) and surfaced in the diagnostic_delta_rejected hook result (file-change-hooks.ts:~905-918). (e) deferred daemons documented in the module header (this line range). (f) rollback guard — throwing applyEdit is contained with best-effort rollbackEdit in its own try/catch, rejection returned with empty (non-fabricated) diagnostics (diagnostic-delta.ts:~325-360); a throwing rollbackEdit on the rejection path is logged without discarding the rejection (~370-385). (g) deadline/SIGKILL pattern — createDiagnosticCommandRunner arms the SIGKILL escalation INSIDE the deadline callback after settling (diagnostic-delta-runner.ts:~150-180, unref'd grace), consistent with semgrep makeSpawnRunner (semgrep-baseline.ts:~180-205) and runGitBounded's abort path (get-change-review-bundle.ts:~230-260).
- **Fix:** No action needed; informational verdict anchor.
- **Evidence:** sdk/src/services/diagnostic-delta.ts:~39-41 'Deferred: the incremental daemons (tsc --watch, cargo check JSON daemon, ruff server, dmypy) are not implemented; the preflight runs one-shot diagnostic commands per invocation.' — verbatim match with the PLAN.md P3-T3 DEFERRED note (PLAN.md:101).

## [LOW] security — sdk/src/services/semgrep-baseline.ts:103 — P3-T11 verdict: MATCHES with one hardening residue — the baseline-ref whitelist still accepts a trailing '/'
- **Risk:** The hardening spec for this wave named trailing '/' among the ref-whitelist tightenings, but SAFE_BASELINE_REF ends with an optional \/? so refs like 'main/' still pass isSafeBaselineRef. Impact is low — the ref travels as one argv token and git rejects such refnames — and a compat comment documents the retention for direct callers of runSemgrepBaseline, but the claimed hardening is incomplete on this specific point. '..' rejection and option-injection safety (leading '-' impossible: the regex must start with a hex digit or [A-Za-z0-9]; the ref is passed as --baseline-commit=<value>, a single pre-validated token) both verify correctly.
- **Fix:** Drop the optional trailing slash from the regex, or gate that legacy form behind an explicit compat flag so the shipped hardening matches the stated spec.
- **Evidence:** sdk/src/services/semgrep-baseline.ts:~100-125 SAFE_BASELINE_REF regex `^[0-9a-f]{4,40}$|^HEAD~\d{1,3}$|^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9._-])?(?:~\d{1,3})?\/?$` plus isSafeBaselineRef rejecting '..' anywhere; comment at ~95-105 explicitly retains the trailing slash for direct-caller compatibility.

## [LOW] error-handling — sdk/src/services/semgrep-baseline.ts:315 — runSemgrepBaseline accepts no AbortSignal; a cancelled bundle build cannot cancel a running scan
- **Risk:** resolveSecurityScan in get-change-review-bundle.ts accepts params.signal but runSemgrepBaseline's params shape has no signal field, so an aborted get_change_review_bundle call leaves the semgrep child running until its 60s default (300s max-clamped) deadline. Bounded, but caller cancellation is not honored and the abort-shape convention used by runGitBounded is not mirrored here.
- **Fix:** Thread an AbortSignal through runSemgrepBaseline into makeSpawnRunner, mirroring runGitBounded's abort + SIGTERM→SIGKILL escalation shape.
- **Evidence:** sdk/src/services/semgrep-baseline.ts:~315-345 runSemgrepBaseline params = { cwd, baselineCommit, files, runner?, timeoutMs?, skipScan? } — no signal field. sdk/src/tools/get-change-review-bundle.ts:~600-655 resolveSecurityScan({ ..., signal }) receives the caller's signal but never forwards it into runSemgrepBaseline.

## [LOW] correctness — sdk/src/services/diagnostic-delta-runner.ts:165 — Diagnostic runner's SIGKILL escalation timer is not cleared when the child exits before the grace elapses
- **Risk:** finish() clears only the deadline timer; the SIGKILL escalation timer armed inside the deadline callback keeps ticking even after the child exits on SIGTERM. Harmless today (unref'd, child.kill wrapped in try/catch), but inconsistent with the sibling semgrep runner whose settle() clears both timers.
- **Fix:** Track and clear the escalation timer in finish(), matching the semgrep runner's settle shape.
- **Evidence:** sdk/src/services/diagnostic-delta-runner.ts:~120-180 — finish() only clears `timer`; the `escalate` timer created inside the deadline callback is never cancelled. Contrast sdk/src/services/semgrep-baseline.ts:~160-170 settle() which does `if (escalate) clearTimeout(escalate)`.

## [LOW] state-mutation — sdk/src/tools/file-change-hooks.ts:880 — Diagnostic-delta preflight never runs when no hooks are configured or match, even with the flag on
- **Risk:** The OPENBUFF_DIAGNOSTIC_PREFLIGHT-gated delta block sits after the early returns for hooks.length === 0 and matching.length === 0, so a flag-on repository with no configured (or no matching) hooks gets no preflight result at all. Arguably by design — hooks are the verification gate — but it further narrows the surface where the preflight can ever report anything (compounding finding 1's reachability gap).
- **Fix:** Document the dependency (preflight is part of the hook gate) or hoist the preflight ahead of the early returns if preflight-only feedback is desired when no hooks match.
- **Evidence:** sdk/src/tools/file-change-hooks.ts:~830-870 early `return` arms for hooks.length === 0 and matching.length === 0; the flag-gated delta block at ~880-925 only executes after those returns.

## [LOW] api-contract — sdk/src/services/semgrep-baseline.ts:415 — P3-T11 verdict: MATCHES — all plan claims verified with the hardening landed
- **Risk:** Informational verdict anchor for P3-T11 (all 7 sub-claims verified): (a) argv-only — makeSpawnRunner spawns 'semgrep' with an argv array, never a shell (semgrep-baseline.ts:~140-155); ref travels as the single pre-validated token --baseline-commit=<value> (~390-400); SemgrepRunner seam injectable (~30-40); whitelist rejects '..' and option-like refs (see LOW finding for trailing '/'). (b) caps — MAX_SEMGREP_FILES=200 (~68), DEFAULT_SCAN_TIMEOUT_MS=60_000 clamped to [1s, 300s] (~69-72), MAX_SARIF_BYTES=8MiB (~75), MAX_FINDINGS=200 (~77); `truncated` flag surfaced through the securityScan schema (common/src/tools/params/tool/get-change-review-bundle.ts:~44-50). (c) fail-open — unavailable/error/skipped statuses, never throws; resolveSecurityScan catch maps any error to status 'error' with empty findings (get-change-review-bundle.ts:~630-655). (d) exit-1-with-findings now success — SARIF is parsed BEFORE exit-code classification and exit 1 with parsed findings is accepted (this line range); the earlier 'exit 1 treated as failure dropping findings' bug is fixed. (e) SIGKILL escalation armed INSIDE the deadline callback, never at spawn (semgrep-baseline.ts:~180-205, explicit comment) — the earlier HIGH is fixed. (f) securityScan is additive/optional on the bundle outputSchema (z.object(...).optional() with an additive comment). (g) SARIF parsing reused from the P0-T8 parser: runSemgrepBaseline calls parseLanguageDiagnostics from ../tools/language-diagnostics (~405-410), whose structuredDiagnosticParsers include sarifParser (sdk/src/tools/language-diagnostics.ts:~1180-1188) — no duplicated SARIF parsing.
- **Fix:** No action needed; informational verdict anchor.
- **Evidence:** sdk/src/services/semgrep-baseline.ts:~415-430 — comment 'Parse the SARIF before classifying the exit code: semgrep exits 1 when the scan simply found results'; classifier `if (scan.exitCode !== 0 && !(scan.exitCode === 1 && findings.length > 0))`. common/src/tools/params/tool/get-change-review-bundle.ts:~37-52 securityScan z.object({ status enum ok/unavailable/error/skipped, findings, reason?, toolVersion?, truncated: z.boolean().optional() }).optional().

## Coverage receipt

### Subsystems
- sdk-diagnostic-delta-preflight
- sdk-semgrep-baseline-securityscan
- sdk-file-change-hooks
- sdk-run-targeted-validation
- sdk-change-review-bundle
- sdk-run-tool-dispatch

### Features
- P3-T3
- P3-T11
- LI-02
- LI-10

### Files
- sdk/src/services/diagnostic-delta.ts
- sdk/src/services/diagnostic-delta-runner.ts
- sdk/src/services/semgrep-baseline.ts
- sdk/src/tools/file-change-hooks.ts
- sdk/src/tools/run-targeted-validation.ts
- sdk/src/tools/get-change-review-bundle.ts
- sdk/src/run.ts
- common/src/tools/params/tool/get-change-review-bundle.ts
- sdk/src/tools/language-diagnostics.ts

### Domains
- correctness
- security
- error-handling
- state-mutation
- performance
- api-contract
