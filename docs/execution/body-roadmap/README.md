# Revised polyglot/body execution plan

The [frozen plan](../../../.agents/sessions/body-capability-review-2026-11-05/PLAN.md) and [specification](../../../.agents/sessions/body-capability-review-2026-11-05/SPEC.md) define 36 cards and 39 completion nodes. The [ledger](ledger.json) records acceptance; planning checkmarks do not replace receipts.

**24 of 39 nodes are accepted; 15 remain open.** R11 closes B16 after the compiled child-lifecycle and replay proof and the affected receipt renewals. The earlier B23 language/graph identity and R10 closeout remain accepted. B21 is still accepted only under the user-authorized reduced Linux scope in [its decision](B21-ACCEPTANCE-20261124.json). See the [checkpoint](STATE.md) for current proof and limits.

The [execution registry](execution-plan.json) includes the user-requested [researcher-web addition](researcher-web-agent-browser.md) under B33. RWEB-0 feasibility is approved; implementation and integrated browser delivery remain pending with their prerequisites.

The registry also includes the user-requested [product audit addendum](product-audit-addendum.md) (PROD, 2026-11-12). It adds acceptance clauses to 13 pending cards, 32 new tasks (N01–N32) and a dispatch order. Wave 1 covers confirmed security issues: project-config credential exfiltration, plan-mode writes, SSRF and project `allow-all`. It also covers silent wrong results, command hangs and orphaned jobs, and missing prompt caching. The addendum does not alter the frozen base plan or graph.

**N01, N02, N10 and N12** are separately accepted in the registry under their documented scope. These four source-bound receipts are not part of the 39-node base count.

In a fresh disposable checkout, [restore the R11 evidence capsule](archive/README.md#r11-current-accepted-ledger) before running the validator. Historical receipts, failures, and context remain in the prior snapshots. Restoration verifies preserved bytes; it does not rerun the acceptance checks.
