# LESSONS — Harness Remediation

Initial entries carried over from the audit phase (they directly shape execution):

## Gotchas that will bite during execution
- **Wire schemas must stay JSON-Schema-portable.** Unicode property escapes (`\p{Cc}` etc.) in Zod `.regex()` leak into tool `pattern`s and hard-fail strict provider validators with a 400 *before generation* (`{"errorMessage": "Invalid request parameters"}` from `normalizeSpawnedAgentOutput`, NOT the tool's own "Missing or invalid ... parameters." text). Keep enforcement in `inputSchema`/handler and put a pattern-free `providerInputSchema` on the wire (convention: str-replace.ts). Regression test lives in `common/src/tools/__tests__/tool-registration-consistency.test.ts`.
- **Generated tool type mirrors never get hand-edited.** After ANY tool schema change run `bun scripts/generate-tool-definitions.ts` (updates `agents/types/tools.ts`, `common/src/templates/initial-agents-dir/types/tools.ts`, `.agents/types/tools.ts`, `cli/src/data/initial-agent-type-sources.generated.ts`); CI/pre-push verifies freshness.
- **`guard:memory-drift` blocks pushes** when `cli/knowledge.md` / `common/knowledge.md` are older than their sibling `src/` trees. Pair every src change with a knowledge.md refresh in the same commit set — exactly what blocked the first push of 40fbd88fa.
- **Audit snapshot machinery churns on live state.** `hashInventory` (sdk/src/services/audit-intelligence.ts) hashes every walked file except `.git/node_modules/dist/build/coverage/.next` — so `.openbuff/memory/*`, `.codebuff-index/*.tmp`, debug logs, and the harness's own task-memory writes invalidate snapshots between calls (28/28 probes returned "stale"). Never loop on `inspect_codebase_structure` to chase freshness; fix the hashing/binding first (M0-T1).
- **Receipt binding is unsatisfiable post-write by design.** `evaluateAuditCoverage` requires `receipt.snapshotId === inventory.snapshotId` of the live tree, but `write_audit_findings` writes findings INTO that tree; probes only emit `evidence_kind: 'heuristic'` while the checker demands `'verified'`. The fix must add stored-inventory binding + an explicit verified-evidence promotion (M0-T1) — do not try to satisfy the current checker by re-minting receipts.
- **Sub-agent output silently vanishes at size.** Large `set_output` payloads get transport-truncated ("payload truncated ... resume cursor") or return `value: null` with no error (the first synthesizer run). Keep child outputs compact; prefer file artifacts + small summaries; M0-T3 makes this durable.
- **Distinguish the two failure shapes when debugging agent runs:** provider-request death → `{errorMessage: "..."}` with an API-ish message (request never generated); tool-schema rejection → the tool's own precise validation text. The former killed every general-agent run until the schema portability fix.
- **Edit-transaction contract:** copy exact contiguous `oldString` from a live read; multi-file is all-or-nothing; after an abort, re-read every recovery path from ONE snapshot and rebuild the whole transaction — never peel remembered edits into alternating retries.
- **Compat blocks are real:** compatibility-reviewer findings keep the gate open until a fresh matching review clears them (the `AuditFindingsInput` z.infer→z.input episode). Plan type-contract checks into every schema task (M2-T3).
- **Plan-mode/session artifacts** live under `.agents/sessions/<slug>/`; the audit evidence dir `harness-audit-2026-09-22/` is read-only input for this program.

## Decisions
- Remediation is phased M0→M6 with security before lifecycle before performance before bulk sweeps before capability gaps; certification (re-audit + machine-check) is a hard gate.
- Every finding must end with a resolution marker (fixed+ref / accepted+rationale) — AC7 — so "all these issues" is auditable at the end.

## Follow-up notes
- At fix time: verify exact line numbers for the two approximate CLI citations (`chat.tsx`, `sdk-event-handlers.ts`) from the verbatim snippets in shard-cli-tui.md.
- Verify installed AI SDK v5 `experimental_repairToolCall` semantics (re-dispatch vs re-validate) before M2-T5 design; test both outcomes if the docs are ambiguous.
- Keep appending here whenever a fix reveals something the next executor will trip over.