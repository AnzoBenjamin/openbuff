# Revised polyglot/body execution plan

The [frozen plan](../../../.agents/sessions/body-capability-review-2026-11-05/PLAN.md) and [specification](../../../.agents/sessions/body-capability-review-2026-11-05/SPEC.md) define 36 cards and 39 completion nodes. The [ledger](ledger.json) records acceptance; planning checkmarks do not replace receipts.

**23 of 39 nodes have accepted ledger status**: B01, B02, B03, B04, B05, B06, B07, B08, B09, B10, B11, B12, B13, B14, B15, B18, B19, B20, B21, B23, B28, B30 and B36. **16 remain unaccepted.** B23 closes operation-specific language and graph identity; R10 previously closed B06, B07, B09, B10, and B15. The unchanged validator passes with zero errors after restoring the current evidence. B21 remains accepted only under the user-authorized reduced Linux scope in [its decision](B21-ACCEPTANCE-20261124.json). See the [checkpoint](STATE.md) for verification and scope limits.

The [execution registry](execution-plan.json) includes the user-requested [researcher-web addition](researcher-web-agent-browser.md) under B33. RWEB-0 feasibility is approved; implementation and integrated browser delivery remain pending with their prerequisites.

The registry also includes the user-requested [product audit addendum](product-audit-addendum.md) (PROD, 2026-11-12). It adds acceptance clauses to 13 pending cards, 32 new tasks (N01–N32) and a dispatch order. Wave 1 covers confirmed security issues: project-config credential exfiltration, plan-mode writes, SSRF and project `allow-all`. It also covers silent wrong results, command hangs and orphaned jobs, and missing prompt caching. The addendum does not alter the frozen base plan or graph.

See [STATE.md](STATE.md) for the current checks and remaining work. In a fresh disposable checkout, [restore the current evidence capsule](archive/README.md#r10-current-accepted-ledger) before running the unchanged validator. Historical receipts, failures, and context are kept in the separate historical archive. Restoration alone does not establish acceptance.
