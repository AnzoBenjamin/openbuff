# Compaction retention eval

Deterministic (no-LLM) scenario measuring **compaction retention quality**:
whether the context pruner's pinned `<knowledge_memory>` block still carries the
evidence a run needs to continue, and how that scales with the model context
window. Drives `agents/context-pruner.ts` directly — `handleSteps` is invoked
with a mock `agentState` and the resulting `set_messages` payload is measured,
exactly as `agents/__tests__/context-pruner.test.ts` does. No network, no LLM,
no filesystem access.

The block sections under measurement are `Goal:`, `Decisions:`,
`Files Inspected:`, `Edits Made:`, `Validation Results:`, `Review Receipts:`,
`Post-Edit Anchors:`, `Blockers:` and `Next Action:`. Per-field caps are
baselines at a 100k semantic target scaled by
`clamp(targetTokens / 100_000, 0.5, 3.0)`, and the whole block is additionally
bounded by `max(1_500, floor(target * 0.25))` estimated tokens with oldest-first
eviction; `Goal:` and `Next Action:` truncate toward their floors rather than
being dropped.

## Scenarios

| ID  | Claim under test                                                                               |
| --- | ---------------------------------------------------------------------------------------------- |
| S1  | 140k trigger / 100k target (scale 1.0) records the reference retention counts                  |
| S2  | An 8k-class BYOK window stays under the block ceiling and never drops `Goal:` / `Next Action:` |
| S3  | A ~1M-token window retains strictly more list entries than S1                                  |
| S4  | A trailing instruction after a long pasted diagnostic survives in the pinned goal              |
| S5  | An open reviewer blocker and the review receipt fingerprint both survive a pass                |

## Metrics

Each scenario records named metrics into a module-level `metrics` record and the
suite prints a compact table at the end of the run. Assertions are the
regression floor; the metrics are the deliverable.

| Metric                | Meaning                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| `recallRate`          | Fraction of the seeded must-survive facts still present in the emitted block |
| `blockTokens`         | Estimated tokens of the emitted `<knowledge_memory>` block                   |
| `retainedEntryCounts` | Per-section ` -` entry counts (decisions, files, edits, validation, …)       |
| `compressionRatio`    | Emitted summary tokens over input history tokens                             |

The must-survive set is a specific inspected file path, a specific decision
line, an open blocker line and the trailing next action; S4 additionally
requires the trailing instruction and S5 the review receipt fingerprint.

## Run

```bash
bun --cwd=evals test compaction-retention
```

No wiring change is needed: `evals/package.json` runs `bun test` (which picks up
any `**/*.test.ts` under `evals/`) and `evals/tsconfig.json` includes `**/*.ts`.

## Out of scope / deferred

- Pruner behavior other than the pinned block (extractive entry walk budgets,
  `<pinned_active_work_state>`) — covered by `agents/__tests__/context-pruner.test.ts`.
- Cross-session persistence of the same facts — covered by the sibling
  `evals/memory-retention/` eval and the runtime task-memory suite.
- Model-quality questions (does the model _act_ on retained evidence) — needs an
  LLM-in-the-loop eval and is intentionally excluded here.
- Retention under repeated compaction cycles at each window size (multi-pass
  drift), which would extend S1–S3 into a cycle-count sweep.
