# Context Budget Architecture — STATUS

Session: context-budget-architecture-2026-08
Last updated: 2026-08-01

## Current state

Milestone 0 (baseline measurement) complete. Script created and run. Numbers recorded below.

## M0 Baseline Numbers (2026-08-01)

Measured via `bun run scripts/measure-context-baseline.ts` on the openbuff repo itself.
Token counts use gpt-tokenizer with 1.35x Anthropic fudge factor.

### Per-component breakdown

| Component | Tokens | Notes |
|---|---|---|
| base2 systemPrompt (raw template) | 10,674 | 39,283 chars; includes unreplaced placeholders |
| Knowledge files instruction (static) | 1,036 | The "how to use knowledge files" prompt |
| Patterns index prompt | 307 | Compact catalog from agents/patterns/INDEX.md |
| File tree prompt (agent, 10k budget) | 190 | UNDERESTIMATE — session-state extraction missed fileTree |
| System info prompt | 109 | OS, shell, chrome, recently-read files |
| Language + engine profile | 0 | UNDERESTIMATE — depends on fileTree which was empty |
| Knowledge files (root-level contents) | 0 | UNDERESTIMATE — sessionState.knowledgeFiles was empty |
| Git changes prompt | 0 | Clean tree at measurement time |
| **Fixed baseline subtotal** | **12,316** | Excludes injections; underestimates true cost |
| Proactive query_index (24 results) | 4,912 | scope=multi-file, mode=explain, limit=24 |
| git_status injection | 52 | Compact: branch + dirty paths |
| **Automatic injections subtotal** | **4,964** | Per-turn when proactive retrieval fires |
| **Total measured** | **17,280** | 9.1% of 190k max |

### Known underestimates

The script extracts ProjectFileContext fields from `initialSessionState()`, but the
session-state shape does not directly expose `knowledgeFiles`, `fileTree`, and
`userKnowledgeFiles` at the top level the script expected. In production:

- **Knowledge file contents** (knowledge.md, AGENTS.md, docs/architecture.md) add
  roughly 3,000–5,000 tokens based on the files present in this repo.
- **File tree** at 10k budget adds roughly 2,000–4,000 tokens for a repo this size.
- **Language profile** adds roughly 500–1,000 tokens.
- **Tool definitions** (schemas for ~40+ tools) are sent alongside the system prompt
  but NOT measured by this script. Estimated 15,000–25,000 tokens based on the
  tool count and schema verbosity.

### Realistic per-turn fixed cost estimate

| Component | Est. tokens |
|---|---|
| System prompt (assembled, placeholders replaced) | ~15,000–18,000 |
| Tool definitions (schemas) | ~15,000–25,000 |
| Per-turn injections (query_index + git_status) | ~5,000 |
| **Total fixed per-turn overhead** | **~35,000–48,000** |
| As % of 190k max | ~18–25% |

### Key takeaways for prioritization

1. **base2 systemPrompt template (10,674 tok)** is the single largest measured fixed
   cost and the primary target for M4 (progressive disclosure). A 25% reduction
   saves ~2,700 tokens/turn.
2. **Proactive query_index (~4,912 tok/injection)** is the largest per-turn variable
   cost. M2 (dedup + tighter classifier) can eliminate most repeat injections.
3. **git_status (52 tok)** is cheap individually but fires at 9 sites; M3 (delta
   helper) eliminates redundant fires. Cost savings are small but it removes
   noise from history that compounds over turns.
4. **Tool definitions** are a large unmeasured cost. Not in scope for this plan
   but worth a future investigation (lazy tool registration, schema compression).
5. **Pruning threshold (190k)** means the context grows to ~190k before any cleanup.
   M5 (earlier semantic compaction) addresses this.

## Completed work

- [x] SPEC.md written
- [x] PLAN.md written
- [x] M0-T1: scripts/measure-context-baseline.ts created and runs clean (exit 0)
- [x] M0-T2: Representative query_index and git_status injections measured
- [x] Numbers recorded in this file

## Next steps

- M1: Context budget ledger + /context telemetry
- M2: Retrieval dedup (can parallelize with M3, M4 after M1)
- M3: Git delta helper
- M4: Progressive prompt disclosure
- M5: Earlier semantic compaction

## Resume instructions

1. Read SPEC.md and PLAN.md in this directory.
2. The baseline script is at scripts/measure-context-baseline.ts.
3. Fix the session-state → ProjectFileContext extraction to get accurate
   knowledge/tree/profile numbers before starting M1.
4. Start M1-T1: create packages/agent-runtime/src/util/context-budget.ts.

<!-- update_plan_status:appended -->
## M0 numbers CORRECTED after under-measurement fix — 2026-08-01T06:32:17.067Z

The initial M0 run under-measured because the script stub-extracted ProjectFileContext fields. The hardened script now uses the real `sessionState.fileContext`, and the base2 template measurement reflects the fully-assembled default-mode systemPrompt (createBase2('default')). Re-run 2026-08-01T06:30Z:

| Component | Tokens (corrected) | Was |
|---|---|---|
| base2 systemPrompt (raw template) | 11,631 | 10,674 |
| File tree prompt (agent, 10k) | 9,729 | 190 |
| Knowledge files (root-level contents) | 98 | 0 |
| Knowledge files instruction (static) | 1,036 | 1,036 |
| System info prompt | 326 | 109 |
| Git changes prompt | 363 | 0 |
| Patterns index prompt | 307 | 307 |
| Language + engine profile | 388 | 0 |
| **Fixed baseline** | **23,878** | **12,316** |
| Proactive query_index (24) | 4,912 | 4,912 |
| git_status | 52 | 52 |
| **Injections/turn** | **4,964** | **4,964** |
| **Total measured** | **28,842** | **17,280** |
| % of 190k max | **15.2%** | 9.1% |

Key revision: the fixed baseline was ~2x larger than first measured, dominated by the file tree (9,729) and the assembled systemPrompt template (11,631). Priorities for M4 (progressive disclosure) and M1 telemetry are unchanged but better justified. Tool-definition schemas remain the largest UNMEASURED cost (est 15–25k). Script hardening complete: isInjection/isRawTemplate flags, KNOWLEDGE_FILE_NAMES_LOWERCASE reuse, and exit-1 on component error.
