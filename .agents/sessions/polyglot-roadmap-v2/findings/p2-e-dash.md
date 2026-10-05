# Audit findings: p2-e-dash

- Subsystems: sdk-dash, cli-dash-command, cli-run-journal-wiring, agent-runtime-run-journal, cli-docs-tmux-viewer-repoint
- Features: P2-T7, S7
- Files covered: 20

## [MEDIUM] security — cli/src/commands/dash-command.ts:238 — Generated token reaches stdout via the dashboard URL in default serve mode
- **Risk:** The claimed invariant is 'token to STDERR only', but in the DEFAULT serve mode the token-bearing dashboard URL (?token=<secret>) is written to stdout, so `openbuff dash | tee run.log` or any piped/redirected stdout captures the bearer secret. --no-open suppresses it, but it is opt-in.
- **Fix:** Print the URL to stderr (reserve stdout for data) or omit the token from the printed URL with a stderr hint to append ?token=; at minimum document the piped-stdout exposure in the --no-open help text.
- **Evidence:** cli/src/commands/dash-command.ts:225 generated-token line goes to writeStderr; :238-241 `if (args.open) writeStdout(server.url + '\n')`; sdk/src/dash/server.ts startDashServer returns `url = http://127.0.0.1:<port>/?token=<token>`; cli-args.ts:389-392 --no-open only suppresses the URL print.

## [LOW] correctness — sdk/src/dash/server.ts:130 — 'Replay journals, receipts and timelines' is display-only — no interactive replay in the dashboard UI
- **Risk:** The UI delivers a run list, an event timeline TABLE, and receipts/gate as pretty-printed JSON <pre> panes, but there is no interactive replay (step scrubbing/playback) of a journal, and receipts/gate are raw JSON dumps rather than rendered views. tmux-viewer replacement parity (its --replay/GIF export UX) is not reached; the PLAN entry itself notes 'replacement parity rides later polish', so the headline verb 'replay' overstates what ships.
- **Fix:** Add step scrubbing/selection over the journaled event stream (the data is already fully available via /api/runs/:id/events), or record the replay gap explicitly in the PLAN entry instead of relying on the parenthetical.
- **Evidence:** sdk/src/dash/server.ts DASH_PAGE_HTML: sections 'Event timeline' (static table), 'Receipts' (<pre id="receipts">, textContent = JSON.stringify), 'Gate' (<pre id="gate">); no replay/scrub controls anywhere in the inline script; docs/testing.md:112 and cli/knowledge.md:144 repoint at dash as the run viewer.

## [LOW] state-mutation — cli/src/commands/dash-command.ts:130 — Dash-side journal open is row-read-only but not connection-read-only
- **Risk:** The docblock claims the dash side is 'strictly read-only (no append, no pruneRuns)' — true for ROWS — but the default opener calls createRunJournal, which runs idempotent schema DDL and PRAGMA journal_mode=WAL on the existing db file, so the dash connection does touch the file (WAL/-shm sidecars, schema init) while a live writer may be mid-append. Row preservation is tested; connection-level read-only is not enforced structurally.
- **Fix:** Open the dash-side connection with a sqlite read-only flag (or a dedicated read-only factory seam) so an absent write capability is structural, not conventional.
- **Evidence:** cli/src/commands/dash-command.ts defaultOpenJournal -> createRunJournal({path}); createRunJournal performs WAL/schema init on open (run-journal.ts); dash-server.test.ts 'listRuns never wrote' asserts only that the same ROWS are visible on reopen, and the bash-command.test.ts dash live-wiring tests inject a fake opener for the never-writes assertion (file size 0).

## [LOW] api-contract — packages/agent-runtime/src/util/run-journal.ts:855 — runIds() SQL deviates cosmetically from the claimed 'SELECT DISTINCT run_id GROUP BY run_id' wording
- **Risk:** The claim reads 'SELECT DISTINCT run_id GROUP BY run_id ORDER BY MIN(created_at) DESC'; the implementation is 'SELECT run_id FROM run_events GROUP BY run_id ORDER BY MIN(created_at) DESC' — no DISTINCT keyword, but GROUP BY makes rows distinct per run_id, so the semantics match exactly. The MIN(created_at)-not-MAX recency contract (a late child append to an old run must not promote it) IS implemented and documented.
- **Fix:** None required; align the PLAN wording or leave as-is (semantics identical).
- **Evidence:** packages/agent-runtime/src/util/run-journal.ts:855-862, docblock :848-854 ('MIN (not MAX) is the dash contract'); consumed structurally by sdk/src/dash/provider.ts knownRunIds/listRuns.

## [LOW] error-handling — sdk/src/dash/server.ts:148 — Malformed Authorization header silently downgrades to the legacy query-token channel
- **Risk:** A request carrying a malformed/non-Bearer Authorization header (e.g. 'Basic ...' or a raw token without the scheme) silently falls back to comparing the ?token= query value instead of being rejected; security impact is nil (both channels are authenticated against the same expected token) but the fallback is implicit rather than a deliberate 401.
- **Fix:** Return a 401 (or ignore the header entirely) when Authorization is present but not Bearer-scheme, so the header channel cannot silently degrade to the legacy query channel.
- **Evidence:** sdk/src/dash/server.ts extractProvidedToken: `if (auth.startsWith('Bearer ')) return auth.slice(...); return url.searchParams.get('token') ?? ''`.

## Coverage receipt

### Subsystems
- sdk-dash
- cli-dash-command
- cli-run-journal-wiring
- agent-runtime-run-journal
- cli-docs-tmux-viewer-repoint

### Features
- P2-T7
- S7

### Files
- sdk/src/dash/server.ts
- sdk/src/dash/provider.ts
- sdk/src/dash/export.ts
- sdk/src/dash/__tests__/dash-server.test.ts
- cli/src/commands/dash-command.ts
- cli/src/cli-args.ts
- cli/src/index.tsx
- cli/src/utils/run-journal-path.ts
- cli/src/commands/run-command.ts
- cli/src/hooks/use-send-message.ts
- cli/src/utils/env.ts
- cli/src/types/env.ts
- packages/agent-runtime/src/util/run-journal.ts
- sdk/src/__tests__/run-journal-wiring.test.ts
- cli/src/utils/__tests__/run-journal-path.test.ts
- cli/src/__tests__/cli-args.test.ts
- cli/src/commands/__tests__/bash-command.test.ts
- docs/testing.md
- cli/tmux.knowledge.md
- cli/knowledge.md

### Domains
- security
- correctness
- error-handling
- test-coverage
- api-contract
