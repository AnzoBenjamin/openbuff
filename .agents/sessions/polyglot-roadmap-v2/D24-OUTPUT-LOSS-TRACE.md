# D24 output-loss trace (2026-09-28) — CONFIRMED with one refinement

Question: does the runtime actually lose subagent `set_output` content for structured-output agents (researcher-web, librarian, thinker, debugger), as D24 inferred? Verdict: **CONFIRMED, refined** — the mechanism is not a dropped payload but a **status fail-open** that mislabels a lost-output run as `completed`.

## Chain (all line numbers read this session)

1. **set_output retry exists and is honest.** `run-agent-step.ts:2719-2760`: when `agentTemplate.outputSchema` is set, the child is non-programmatic, `output === undefined`, and the turn is ending, the loop retries up to `MAX_MISSING_OUTPUT_RETRIES` with the real recorded rejection (`currentAgentState.lastSetOutputError`) instead of a generic reminder. Genuine anti-silent-loss design.
2. **After the retry cap the output stays undefined.** The loop ends; `executeSubagent` (`spawn-agent-utils.ts:2334-2446`) returns that state. A child-internal crash (not parent cancellation) is degraded to `{type:'error', message}` at `:2366-2400`.
3. **Durability marker exists (M0-T3).** `normalizeSpawnedAgentOutput` (`spawn-agent-utils.ts:930-993`) maps undefined/null/blank output to `{summary:'', partial:true, errorMessage:'<agent> ended without calling set_output'}`; run-level errors map to `{errorMessage, partial:true}`. Covered by `spawn-agent-utils-output.test.ts`.
4. **THE FAIL-OPEN — status resolution ignores the marker.** `buildRuntimeAgentReceiptOrThrow` (`:1490-1762`):
   - `missingExplicitCompletion` (the `task_completed` check) applies ONLY to `isGeneralAgent` (`:1525-1528`).
   - `resolvedStatus` (`:1644-1652`): for a non-mutation, non-general agent (researcher-web/librarian/thinker) with no errors, the final fallback is `'completed'` — the `partial:true` marker in `normalizedOutput` never influences the receipt status.
   - `findReceiptStatus` (`:1318-1344`) could rescue this (it scans the output for `status:'partial'`), but the marker has NO `status` field — it has `partial:true` + `errorMessage`, so `findReceiptStatus` finds nothing and `params.status ?? foundOutputStatus ?? 'completed'` lands on `'completed'`.
5. **Parent-visible consequence.** The receipt (`:1717-1760`) carries the truncated output blob (`output: stripUndefinedValuedKeys(reconciledOutput)`) plus `status:'completed'` and zero `errors`. A parent consuming only `status` sees a fully-successful run whose payload is `{summary:'', partial:true, errorMessage:...}` — the exact "orchestrator never gets the content" symptom, while the failure is technically visible only if the parent reads the deep payload.

## Additional confirmed loss vectors

- **last_message fragmentation (D20, not D24):** `last_message`-mode agents return assistant-turn fragments; the runtime does not merge them before normalization (no merge call found in `spawn-agents.ts` or `spawn-agent-utils.ts`). The `truncation.omittedItems` counters in `boundAgentOutputForParent` (`:845-928`) then report 100+ omitted items for large transcripts.
- **Reviewer truncation in transit:** reviewer receipts arrived `truncated:true` this session because `boundAgentOutputForParent` slices serialized output to `PARENT_AGENT_OUTPUT_MAX_CHARS` (48k head / 8k tail); the `attestationCore` rescue (`:864-925`) preserves verdict/fingerprint but not the full finding text.
- **Context-pruner crash (D24's second half):** `agents/context-pruner.ts` performs `'answers' in value` on a value that can be a string/number (crash reproduced 3x this session). A `typeof value === 'object'` guard before the `in` check fixes it.

## Implication for PR-T6 (already planned in PLAN.md)

The fix is narrower than D24 originally implied:
1. Make `normalizeSpawnedAgentOutput`'s partial/error marker carry `status:'partial'` so `findReceiptStatus` picks it up — one-field change, minimal blast radius.
2. OR widen the `missingExplicitCompletion` check beyond `isGeneralAgent` to any agent with an `outputSchema` template.
3. Add `typeof value === 'object'` guard in context-pruner before `'answers' in value`.
4. Keep the rest of D24 (typed envelope with `schema_invalid`/`truncated`/`crashed` outcomes) as the full contract in PR-T1.

Recommended order: (1) first as the minimal fix; (2) only if (1) misses real-world cases; (3) independently; (4) as the umbrella contract.
