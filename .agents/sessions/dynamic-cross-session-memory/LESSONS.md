# LESSONS: Dynamic Cross-Session Memory

## 2026-08-22
- The runtime already deduped merges (`uniqueRecent`, `normalizeEvidence`) and excluded stale evidence (`evidenceIsFresh`) — verify existing helpers before writing new ones; the real gap was persistence + reconciliation only.
- `TaskMemoryV1.evidence[]` was schema-designed for cross-session staleness (`freshnessHash`, `workspaceRevision`, `supersedes`, `stale`) months before anyone wired persistence; read schemas for intent, not just current usage.
- `runOnce` has many terminal paths; the only reliable success discriminator is `terminalState.output.type !== 'error'` (cancelled/error states always emit `type:'error'`).
- Persisted evidence paths and journal move destinations are untrusted input: fail closed on path escape before any file read.
- Fixed `.tmp` filenames race concurrent saves in one cwd; unique suffix (pid+random) + best-effort unlink on failure.
- Delegation reliability: this session saw thinker/web-researcher/architect/editor spawn failures; when a specialist fails twice with the same class of error, implement directly with edit_transaction rather than burning retries.
- FNV-1a now lives in three places (sdk store, run.ts git-status fingerprint, agent-runtime task-memory); the @codebuff/common shared helper should land before a fourth copy appears.
