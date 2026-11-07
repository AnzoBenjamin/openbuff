# Shard 2 — Tool results, JSON presentation, set_output receipts, searches

Auditor: orchestrator (agents unavailable). Files: tools/ registry + renderers,
blocks/tool-branch.tsx fallback, terminal-command-display, discovery-results.

## Up to standard

- **code_search** (`tools/code-search.tsx`): exemplary — status glyph,
  "N matches in M files" summary, zero-matches explicit ("— no matches"),
  streaming count ("N matches so far"), grouped-by-file sections, and
  matched-pattern emphasis with tolerant fallbacks (`discovery-results.tsx:59-119`,
  invalid regex → case-insensitive literal split, >200-char patterns skip
  highlighting), bounded at 250 matches with slice-truncation.
- **Terminal output truncation** (`components/terminal-command-display.tsx:120-158`):
  head+tail excerpt, "… (N more lines)" inline marker, expandable
  "Show N more lines" button — the right pattern.
- **diff-viewer** (`tools/diff-viewer.tsx`): typed add/del/context lines,
  per-hunk expand/collapse (`:17`), initial-visible line budget per file
  (`:67-75`), tolerant `@@` hunk parsing.
- **Fallback discipline** (`blocks/tool-branch.tsx:61-67`): unregistered tools
  collapse by default and show a one-line preview (command preview for shell,
  last-3-lines tail for terminal output) instead of dumping JSON open.
- **Registry coverage**: ~28 bespoke renderers cover the high-traffic tools
  (query_index, code_search, diffs, read_files, jobs, todos, git status).

## Findings

1. **HIGH — set_output receipts render as raw JSON.** `set_output` has NO
   entry in `tools/registry.ts` (grep count 0), so a spawned agent's
   structured receipt (the reviewer/dependency-manager `dimensions`,
   `requirementCoverage`, `schemaVersion`, `snapshotFingerprint` objects) hits
   the generic fallback: collapsed by default, but expanding shows
   ```` ```json ````-fenced `JSON.stringify(input, null, 2)`
   (`blocks/tool-branch.tsx:69`) — machine fields and all. This is the exact
   "json usage like setouput" complaint. Improvement: a `set_output` renderer
   that shows verdict/status + summary + findings count (the receipts all
   carry a human-shaped summary field), with schemaVersion/fingerprint as a
   dim footer at most.
2. **HIGH — spawn_agents card discards children's answers.**
   `tools/spawn-agents.tsx:19-43` renders only "Agents completed (N)" + a
   comma list of agent_types. The child agents' verdicts/summaries (their
   set_output receipts, available on the spawn result) are never surfaced —
   the user must expand each child branch to learn what the reviewers
   concluded. Improvement: one line per child: `✔ reviewer — LOOKS_GOOD`,
   `▲ dependency-manager — partial: guard failed` (data already in
   result.agentReceipts).
3. **MEDIUM — query_index detail is machine-flavored.**
   `tools/query-index.tsx:230-240` shows `score 0.87 · matched: symbol · hash
   a1b2c3d4e5f6` per result. Scores and hashes are agent-facing telemetry;
   users scan for path + snippet + why-it-matched (explanation IS rendered —
   good). Improvement: rank-order without printing raw scores, demote
   hash/matched-on to a dim second line or drop.
4. **MEDIUM — no match highlighting in query_index snippets.** code_search
   emphasizes the pattern (`discovery-results.tsx`), but query_index's
   `matchedSnippets` render as plain wrapped text (`query-index.tsx:241-257`)
   — the query terms aren't visually distinguished in the snippet.
5. **LOW — no jump-to-file affordance on search results.** Neither
   code_search nor query_index offers "open this file" / insert-path-into-
   input; compare Claude Code where result paths are clickable to open.
6. **LOW — diff stats summary absent.** diff-viewer shows hunks but no
   `+N −M` file-level line counts in the collapsed preview (edit-transaction
   card header carries file names; quick-scan of change size requires
   expanding).

## Answers to the named questions

(a) Raw JSON reaches users via the registry fallback for any unregistered
tool — currently set_output (and any future tool before a renderer lands).
The fallback is collapsed-by-default, which mitigates but doesn't fix.
(b) set_output receipts: child branch → tool_call block → fallback renderer →
fenced raw JSON. No bespoke rendering exists anywhere for receipts, and the
spawn_agents summary card does not substitute for it.
(c) Searches: code_search is best-in-class-adjacent (grouping, emphasis,
counts, zero-state). query_index is information-dense but machine-flavored
and unhighlighted.
(d) Diffs: solid (typed lines, hunk collapse, budgets); missing quick +/−
counts. (e) Long terminal output: exemplary truncation UX (head+tail+expand).

## Coverage receipt

registry.ts, tool-branch.tsx (fallback), spawn-agents.tsx (full),
code-search.tsx (full), query-index.tsx (render body + helpers),
discovery-results.tsx (emphasis helpers), diff-viewer.tsx (structure),
terminal-command-display.tsx (truncation), terminal link support noted.
Not audited in depth: read-docs, skill, render-ui, run-file-change-hooks,
language-intelligence renderers (lower traffic; flagged for follow-up).
