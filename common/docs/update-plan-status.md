# update_plan_status

Record durable progress in a plan session without rewriting the whole artifact. The
tool applies targeted checklist edits, appends delimited entries, moves session
lifecycle state, and attaches validation/review evidence — all without reordering or
rewriting unmatched user prose.

## Allowed paths

`path` is required and must point at one of the following session artifacts:

- `.agents/sessions/<slug>/PLAN.md`
- `.agents/sessions/<slug>/STATUS.md`
- `.agents/sessions/<slug>/LESSONS.md`

Absolute paths and any `..` segment are rejected. The tool does not create the session
directory; use `create_plan` to bootstrap a session first. Editing `PLAN.md` is
restricted to tri-state task toggles and the current-task pointer (no full overwrites).

## Input fields

At least one of `updates`, `append`, `sessionStatus`, `currentTask`, or `checkpoint`
must be provided.

### `updates` (array, optional)

Targeted updates applied in order. Each entry rewrites at most one matching checklist
line, preserving leading indentation and trailing prose. Unmatched updates fall through
to `append`. Each entry must provide `taskId` or `task`.

| Field | Type | Notes |
| --- | --- | --- |
| `taskId` | string (non-empty), optional | Stable task ID at the start of a checklist line (for example `P2-T3`). Preferred over substring matching. |
| `task` | string (non-empty), optional | Case-insensitive substring of the existing checklist line to match. The first matching `- [ ]`/`- [x]`/`- [~]`/`- [/]`/`- [!]` line is updated in place. |
| `completed` | boolean, optional | Sets the checkbox binary state (`true` -> `[x]`, `false` -> `[ ]`). Ignored when `status` is provided. |
| `status` | enum, optional | Tri-state status; overrides `completed`. See marks below. |
| `note` | string, optional | Short note appended in parentheses after the line's main text. Existing trailing text is preserved. |

`status` values map to checkbox marks:

| `status` | Mark |
| --- | --- |
| `pending` | `[ ]` |
| `in_progress` | `[~]` |
| `done` | `[x]` |
| `cancelled` | `[/]` |
| `blocked` | `[!]` |

### `append` (object, optional)

Written at the end of the artifact under `## <heading> — <ISO timestamp>` when no
targeted line matches (or for free-form lessons).

| Field | Type | Notes |
| --- | --- | --- |
| `heading` | string (non-empty), required | Short heading used to form the delimited block. |
| `body` | string (non-empty), required | Markdown body written verbatim under the heading. |

### `sessionStatus` (enum, optional)

Session-level lifecycle transition. When provided,
`.agents/sessions/<slug>/STATE.json` is created or updated with the new status. One of:
`draft`, `ready`, `active`, `executing`, `validating`, `reviewing`, `blocked`,
`paused`, `completed`, `archived`.

### `currentTask` (string, optional)

Rewrites the `<!-- current-task: <task> -->` annotation in `PLAN.md`. Pass an empty
string (or omit) to clear the pointer. Only takes effect when `path` targets `PLAN.md`.

### `expectedRevision` (number, optional)

A non-negative integer used as a `STATE.json` compare-and-swap revision. The update
fails without writing when the current revision differs.

### `checkpoint` (object, optional)

Validation or review evidence associated with a stable task ID. Completing a `PLAN.md`
task requires a passed validation checkpoint with `receiptIds`.

| Field | Type | Notes |
| --- | --- | --- |
| `taskId` | string (non-empty), required | Stable task ID the evidence applies to. |
| `phase` | enum, required | Either `validation` or `review`. |
| `passed` | boolean, required | Whether the checkpoint passed. |
| `summary` | string, optional | Short human-readable summary. |
| `receiptIds` | array of non-empty strings, optional | Supporting receipt IDs. An empty array is treated as absent. |

## Usage example

```json
{
  "path": ".agents/sessions/harness-audit-2026-06/PLAN.md",
  "updates": [
    { "task": "P0-11 update_plan_status tool", "status": "done", "note": "shipped" },
    { "task": "P0-12 memory-drift-guard", "status": "in_progress" }
  ],
  "sessionStatus": "active",
  "currentTask": "P0-12 memory-drift-guard"
}
```

Attaching a validation checkpoint before completing a task:

```json
{
  "path": ".agents/sessions/harness-audit-2026-06/PLAN.md",
  "checkpoint": {
    "taskId": "P0-11",
    "phase": "validation",
    "passed": true,
    "summary": "type-check exit 0, lint exit 0",
    "receiptIds": ["lKrt9ptZfQk", "lKrt-Lw1-Ko"]
  }
}
```

## Gotchas

- `checkpoint` is a structured object, not a string. Passing it as a serialized JSON
  string fails validation with `checkpoint: Invalid input: expected object, received
  string`. Send the object fields directly rather than a stringified payload.
- The same object-vs-string rule applies to `append`: it is an object with `heading`
  and `body`, not a pre-serialized string.
- A `status` value always overrides `completed`; set only one to avoid confusion.
- `currentTask` only affects `PLAN.md`. Supplying it while targeting another artifact
  has no effect on the pointer.
- The tool preserves user prose: it never rewrites unmatched lines, never reorders
  content, and only appends when `append` is provided.
