# Review contract

User objective: review Openbuff as a body for a model (model supplies the intelligence), inventory macro capabilities and gaps, judge the implementation quality of present capabilities, and replace the disappointing polyglot roadmap with a grounded executable plan. Polyglot means both implementation-language choice and cooperation across target-project languages. Review production wiring and failure behavior, not just named files or green unit tests. Do not implement source fixes.

Pinned inventory: `/tmp/openbuff-body-review-2026-11-05/INVENTORY.json`; snapshot `ec141833a7efa94cd25b0e2c964fc2c832ce5983b2446c03769515032360deb0`.

Review the picker-selected files using exact reads. You may read adjacent files to trace consumers or resolve a hypothesis; record what you actually read. Be explicit about line ranges and sampling of large files. Do not read credentials or private configuration values. No source mutations. You are not alone in the workspace; never revert others' edits.

All eight audit domains must be considered (from agents/patterns/audit-codebase.md):

1. **Security** — injection, authn/authz bypass, secret leakage, path traversal, unsafe deserialization, SSRF, missing input validation, over-permissive CORS/cookies, prompt injection surfaces.
2. **Correctness** — logic errors, off-by-one, wrong operator, race conditions, incorrect error propagation, broken invariants, misused APIs, type assertions that hide bugs.
3. **State mutation** — unguarded shared mutable state, stale closures, missing transaction boundaries, cache-invalidation gaps, leaked background jobs/AbortSignals, double-frees, order-of-init bugs.
4. **Error handling** — swallowed errors, `catch {}` that hides failures, missing retries where required, retries without backoff, error messages that leak internals, unhandled promise rejections, missing timeout on I/O.
5. **Performance** — O(n^2) in a hot path, unnecessary clones, serial I/O that could be parallel, missing pagination, unbounded memory growth, redundant re-renders, N+1 queries.
6. **Dependency hygiene** — pinned vs floating versions, unused deps, dup deps, known-vulnerable versions, deps used without being declared, dev deps shipped to runtime.
7. **Test coverage gaps** — critical paths with no test, tests that don't assert the failure mode, flaky-test patterns, missing error-path tests, tests that mock too much to be meaningful.
8. **API/ABI contract breaks** — exported signature changes, removed exports, changed error shapes, breaking config/schema changes, changed CLI flags/env vars, changed event payloads.

For each capability assessed, record: entrypoint -> implementation -> real consumer -> tests -> docs -> failure/loading/empty/cancellation/retry/permission states. Classify maturity as `usable`, `partial`, `unwired`, `absent`, or `unknown`; record assurance separately (static trace/unit/integration/live). A documented or tested stub is not usable.

Findings need concrete triggers and consequences, current file:line evidence, domains, severity, confidence, evidence vs inference, suggested fix, and an acceptance probe. Include valuable existing strengths and why they matter. Do not claim 'best possible' without an explicit target and measured tradeoff. Do not invent vulnerabilities or performance measurements. Distinguish missing default wiring from optional design choices. Avoid duplicates or already-fixed historical issues.

Produce exactly one structured JSON and one human-readable Markdown report under your assigned `/tmp/openbuff-body-review-2026-11-05/findings/<shardId>.{json,md}`. They will be published to the required `.agents/sessions/body-capability-review-2026-11-05/findings` directory after review; that directory is read-only in the sandbox. Own only these files. Output JSON shape:

```json
{
  "shardId": "01-cli",
  "snapshotId": "ec141833a7efa94cd25b0e2c964fc2c832ce5983b2446c03769515032360deb0",
  "structuralReceipt": {
    "schemaVersion": 1,
    "snapshotId": "ec141833a7efa94cd25b0e2c964fc2c832ce5983b2446c03769515032360deb0",
    "shardId": "01-cli",
    "subsystemIds": ["cli"],
    "files": ["cli/src/index.tsx"],
    "domains": ["security", "correctness", "state-mutation", "error-handling", "performance", "dependency-hygiene", "test-coverage", "api-contract"]
  },
  "readRanges": [{"path":"cli/src/index.tsx","from":1,"to":100}],
  "capabilities": [{"id":"example","maturity":"partial","assurance":"static trace","evidence":[],"gaps":[],"strengths":[]}],
  "findings": [{"id":"01-F1","title":"...","severity":"HIGH","domains":["correctness"],"confidence":"high","basis":"evidence","evidence":[{"path":"...","line":1,"detail":"..."}],"trigger":"...","consequence":"...","suggestedFix":"...","acceptanceProbe":"..."}],
  "domainAssessment": {"security":"...","correctness":"...","state-mutation":"...","error-handling":"...","performance":"...","dependency-hygiene":"...","test-coverage":"...","api-contract":"..."},
  "coverageLimits": [],
  "recommendedPlanWork": []
}
```

Use only current files in the inventory in structuralReceipt; history plans may be read as context but are excluded from that receipt. A receipt is a statement of inspection, not a full-line audit or a guarantee of correctness. Return only compact receipt with report path, findings count, capabilities count, and the top two conclusions. Native Openbuff audit tools are repository code rather than exposed tools in this Codex session; do not pretend to have called unavailable tools. Root will validate the structured receipts through the exported native coverage function.
