# Revised polyglot/body execution plan

The [frozen plan](../../../.agents/sessions/body-capability-review-2026-11-05/PLAN.md) and [specification](../../../.agents/sessions/body-capability-review-2026-11-05/SPEC.md) define 36 cards and 39 completion nodes. The [ledger](ledger.json) records acceptance; planning checkmarks do not replace receipts.

**13 of 39 nodes have accepted ledger status**: B01, B02, B03, B04, B05, B08, B18, B19, B20, B21, B28, B30 and B36. **26 remain unaccepted.** B21 is accepted only under the user-authorized reduced local Linux behavior scope in [its decision](B21-ACCEPTANCE-20261124.json); the original full source-bound/independent gate is not claimed. The validator still reports twelve missing historical receipt files for other accepted nodes, including B19 and B20; this update does not reconstruct or waive those receipts.

The [execution registry](execution-plan.json) includes the user-requested [researcher-web addition](researcher-web-agent-browser.md) under B33. RWEB-0 feasibility is approved; implementation and integrated browser delivery remain pending with their prerequisites.

The registry also includes the user-requested [product audit addendum](product-audit-addendum.md) (PROD, 2026-11-12). It adds acceptance clauses to 13 pending cards, 32 new tasks (N01–N32) and a dispatch order. Wave 1 covers confirmed security issues: project-config credential exfiltration, plan-mode writes, SSRF and project `allow-all`. It also covers silent wrong results, command hangs and orphaned jobs, and missing prompt caching. The base plan, graph and receipts are unchanged.

See [STATE.md](STATE.md) for the current bounded checks and remaining work. Original receipts, failed attempts and required context are retained in a [content-addressed archive](archive/README.md), with explicit restoration into a disposable checkout. Archiving preserves evidence bytes; it does not establish current acceptance.
