# Background Job Push Model & Drain Inversion — STATUS

## Current state — M1–M4 implemented; awaiting gate on M4 files

### Done
- M1: truncatedAtCursor gap predicate; bound returned events; tests.
- M2: live 250ms drain, per-line events, hasLiveDrainer, peekJobLineCarry.
- M3: checkJob wait() wake; matched=false; follow without wait_for; OOM bounds tests.
- Adapter TTL prune + recovery settledAt / no post-TTL re-cache; lastCheckCursor for live observability.
- Reviewer nits: wait_for-via-lineCarry test; MAX_LINE_BYTES force-flush test (export MAX_LINE_BYTES).
- **M4:**
  - Pure helpers `common/src/util/list-jobs-view.ts` + unit tests.
  - `list_jobs` schema + SDK: pending bucket, gap, optional terminal tail, note line; does not advance lastCheckCursor.
  - base2 yields programmatic `list_jobs` after initial + mid-loop `git_status` (pushed status digest).

### Validation (local)
- check-job 41/41; list-jobs-view + list-jobs 12/12; combined suites 53/53.
- typecheck: common, sdk, agents clean.

### Pending
- Runtime validation/reviewer gate on M4 dirty set.
- M5: cross-package smoke + live dev-server if desired.

## Resume
If gate returns blockers, fix finding-scoped issues only. M5 is optional next after LOOKS_GOOD.