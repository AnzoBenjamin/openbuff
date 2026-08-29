# list_jobs

List the background jobs owned by the current run from the unified registry —
both shell jobs (`kind: 'process'`) started by `run_terminal_command` and
background-agent jobs (`kind: 'agent'`) started by `spawn_agents({ background: true })`.
The digest covers still-running jobs and recently settled ones
(`completed`/`error`/`stopped`/`lost`/`cancelled`) retained within the
session/TTL. Use it to rediscover `jobId`s after context compaction so you can
`check_job`/`read_logs`/`kill_job` a shell job or `check_background_agent` an
agent job.

## Input

`list_jobs` takes no agent-supplied input. Ownership is runtime-injected from
trusted run/session state; the model-facing schema deliberately exposes no
`owner` field and agents must omit it.

## Output

The result is a single JSON value in one of two shapes.

### Digest variant

The normal digest lists up to 10 jobs (`LIST_JOBS_MAX_ROWS`), preferring
running/non-terminal jobs and then most-recent `startedAt`.

| Field            | Type             | Notes                                                                                                                  |
| ---------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `jobs`           | array, required  | Selected job rows (see below).                                                                                         |
| `note`           | string, required | Always `No action required unless you need this output.` — declarative; no action required unless you need the output. |
| `truncatedCount` | number, optional | How many rows were capped off when more than 10 jobs matched. Omitted when nothing was truncated.                      |

Each entry in `jobs`:

| Field         | Type                             | Notes                                                                                                                                                                                                          |
| ------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobId`       | string, required                 | User-facing id; pass to `check_job`/`read_logs`/`kill_job` (process) or `check_background_agent` (agent).                                                                                                      |
| `kind`        | `'process' \| 'agent'`, required | Shell job vs background agent.                                                                                                                                                                                 |
| `command`     | string, required                 | Human label for the job.                                                                                                                                                                                       |
| `status`      | enum, required                   | One of `queued`, `running`, `stopping`, `completed`, `error`, `stopped`, `lost`, `cancelled`.                                                                                                                  |
| `startedAt`   | number, required                 | Start timestamp (ms).                                                                                                                                                                                          |
| `completedAt` | number, optional                 | Settle timestamp, present only for terminal jobs.                                                                                                                                                              |
| `pending`     | enum, required                   | Bucketed pending process/log lines relative to the last `check_job` consumer cursor: `none`, `<10`, `<100`, `<1k`, `1k+`. Agent jobs usually show `none`.                                                      |
| `gap`         | boolean, required                | `true` when events were truncated from the ring buffer; then `pending` is a lower bound counted from only the retained (non-truncated) events. A flooded job may show `pending: 'none'` alongside `gap: true`. |
| `exitCode`    | number \| null, optional         | Present for terminal jobs that report an exit code.                                                                                                                                                            |
| `tail`        | array of string, optional        | Last ≤10 output lines, only for terminal jobs (terminal peek).                                                                                                                                                 |

### Suppressed variant

When nothing changed since the previous `list_jobs` digest this turn, the
per-turn change-gate swaps the full table for a small suppression payload:

```json
{
  "unchanged": true,
  "note": "No job changes since the previous list_jobs digest this turn; the earlier digest is still current."
}
```

The suppressed payload deliberately omits `jobs` entirely — an empty array
would read as "no jobs exist", which is false. `unchanged` is always the
literal `true`; treat the earlier digest as still current and do not re-list.

## Gotchas

- The digest is a read-only snapshot: `list_jobs` never advances the
  `check_job` consumer cursor, so it cannot drain a job's `pending` bucket.
- `pending` counts only process/log output lines. Agent jobs emit no line
  buckets and are rediscovered via `status`/`kind`, not `pending`.
- The first `list_jobs` call of a turn always returns the full digest; only
  subsequent identical digests are suppressed.
- New buffered output and wall-clock drift do not by themselves bust the
  change-gate — a job that is still running with fresher output can still
  return the suppressed variant. Call `check_job` to actually drain output.
