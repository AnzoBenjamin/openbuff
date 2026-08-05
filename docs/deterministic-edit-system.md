# Deterministic Edit System

This document records usage guidance for deterministic harness tools that should be consistently registered before agent prompts recommend them.

## Search before editing

Use `find_files_matching_content` when you need the unique set of files whose contents match a ripgrep pattern, without dumping every matching line. This is useful for refactor planning and follow-up targeted reads:

```json
{
  "pattern": "handleCodeSearch",
  "cwd": "packages/agent-runtime/src",
  "groupBySymbol": true
}
```

Prefer `code_search` when the matching lines and surrounding context are needed. Prefer `find_files_matching_content` when the next step is deduping file paths and reading or editing those files. The tool streams ripgrep output internally into bounded, deduped file sets so large searches do not require holding the full stdout payload in memory; future client protocols can expose those internal progress updates incrementally.

Both search tools accept safe ripgrep flags either as one string or as an argv
array, for example `"-t ts -g src/**"` or `["-t", "ts", "-g",
"src/**"]`. One accidental quote layer around the whole string is repaired,
then the normal strict allowlist is still applied. Line numbers are enabled
internally; redundant `-n`/`--line-number` inputs are discarded as harmless
no-ops, while output-changing or effectful flags remain rejected.

## Background jobs at turn boundaries

`run_terminal_command` with `process_type: "BACKGROUND"` registers running jobs in the unified `JobRegistry` (in the `common` package), the single source of truth for every background job — shell processes (`kind: 'process'`) and background agents (`kind: 'agent'`) alike — driven by one lifecycle state machine (`queued -> running -> stopping -> {completed | error | stopped | lost | cancelled}`). `end_turn` surfaces any still-running job IDs so agents do not silently leak dev servers, watchers, or log tails across turns. Use `check_job`, `read_logs`, or `kill_job` to inspect or stop them before finishing when appropriate. Live job status and output are streamed to the CLI via additive `job_update` events, so users see progress without the agent polling.

## Staged read-before-edit enforcement

Shipped root/editor agents use `edit_transaction` as their single
model-visible project mutation surface. Its edit variants cover targeted text,
ranges, symbols, patches, structured operations, and file lifecycle changes.
Standalone edit handlers remain registered for persisted/external
compatibility. All active mutation
paths participate in the same staged read-before-edit policy.
Under strict-mode edit flows, the runtime requires a recent `read_files`
authorization for each touched path before accepting an edit:

There are three tiers of read authorization, and confusing them is the most
common cause of "I already read this file, why is my edit blocked?":

1. **Whole-file authorization (reusable).** A *complete* whole-file read mints
   a per-path authorization the runtime remembers, so later exact-match edits
   on that path proceed without a capability. Only complete whole-file reads
   register this.
2. **Scoped capability (per-edit).** A *range* or *symbol* read mints a
   `readCapability` bound to the exact project, path, line bounds, content
   hash, and run. It authorizes only edits inside those bounds and must be
   passed explicitly on the edit (`basedOnRead` / `readCapability`); it does
   **not** grant whole-file authorization for the path.
3. **No capability (truncated/partial).** A truncated or oversized read mints
   nothing. The result says so explicitly (`NO edit capability ... was minted`),
   so re-read a fully-covered bounded range before editing.

- A successful complete whole-file `read_files.paths` call mints a per-path
  authorization for follow-up exact-match edits and returns a structured
  `editAnchor` containing the exact bounds, canonical content hash, and a short
  `readCapability`. Copy only `editAnchor.readCapability` when explicit proof is
  needed; the adjacent bounds and hash are diagnostic metadata.
  Truncated reads expose no capability. Range and symbol reads stay scoped:
  follow-up edits must carry `editAnchor.readCapability` rather than receiving
  whole-file authorization. SDK v1 wire results retain legacy duplicate fields,
  but the runtime removes them before provider context construction.
- `basedOnRead` (the read capability returned from a `read_files` range
  header, or the freshly echoed capability on a successful large-file
  edit) is the explicit authorization path. The runtime verifies the
  embedded hash and rejects stale or mismatched anchors before any file
  is changed.
- The `replace_range` transaction edit accepts that same `readCapability` and decodes the
  line bounds plus hash as one atomic target. Prefer this form for Markdown,
  checklists, and formatting-sensitive blocks instead of copying a rendered
  range into a large `oldString` or manually pairing three range fields.
- The provider schema exposes only `{ readCapability, newContent }`; the runtime
  compatibility parser also accepts the legacy
  `{ startLine, endLine, expectedHash, newContent }` form, but callers cannot
  combine it with `readCapability`. Capability-only edits normalize internally.
  The one sanctioned mixed form — a whole-file capability paired with narrower
  caller bounds — is described under "Capability minting and the default
  replace_range flow" below.
- Every fully applied action may return an action-local post-edit `editAnchor`
  containing the confirmed post-edit bounds, content hash, and reusable
  `readCapability`. It describes that action's resulting content, not the
  transaction's pre-edit snapshot. The runtime also writes confirmed post-edit
  content into automatic whole-file authorization when it has enough evidence.
  Prefer that automatic authorization or the action's
  `editAnchor.readCapability` for follow-up work; a successful mutation does
  not require an unconditional reread.
- When a mutation is confirmed and the runtime grants post-edit anchors, the
  mutating tool result appends one additive json part named
  `postEditCapabilities`: an array of `{ path, contentHash, readCapability }`,
  one per granted path. This part is model-facing (it flows into message
  history) and is **not** rendered in the user-facing CLI rows. Each
  `readCapability` is a scope-bound `cap.v3` token the model can pass as
  `basedOnRead` (write_file) or per-replacement `basedOnRead` (str_replace) on
  a follow-up edit, avoiding a redundant re-read. The part appears only when at
  least one anchor was granted; it is omitted when no anchor could be minted
  (for example, no runtime-known content or no authoritative scope).
- The strict read-before-edit blocked-recovery message distinguishes a file
  that was created or edited earlier in the session (it has a confirmed
  post-edit anchor). Instead of the generic "no fresh read authorization
  exists; call read_files" guidance, the message tells the model to retry with
  `basedOnRead` set to the `readCapability` from that create/edit result's
  confirmed post-edit anchor, and the structured `recovery.basedOnRead` echoes
  that token. The other blocked-recovery causes (`stale_snapshot`, a prior
  failed edit, stale-revoked, compacted, never-read) are unchanged.
- A confirmed `create` (or any confirmed whole-file write) grants sticky
  whole-file authorization straight from the runtime-known post-edit bytes —
  the bytes a `create` supplies are exact, so the runtime does not need the
  client to echo a whole-file-covering anchor. When no usable client anchor is
  present, the runtime mints its own `cap.v3` anchor from those known bytes
  (scope-bound to project, path, and run) and records it as the confirmed
  post-edit anchor. A follow-up `delete` (or `move`) on that path is then
  authorized when the anchor's content hash still matches the transaction's
  snapshotted current content; an external modification (hash mismatch) fails
  closed and requires a fresh read. A `move`'s destination path needs no read
  authorization — its safety is enforced by the lifecycle preflight, which
  blocks `Move destination already exists`. The client-echoed anchor is
  preferred when valid but is never itself trusted to authorize — it is only
  reused after passing the 7-point verification.
- A `ConfirmedPostEditAnchor` (recorded in `confirmedPostEditAnchorsByPath`)
  is definitionally whole-file-verified: it is only minted when the 7-point
  check confirms whole-file coverage (`startLine === 1` and
  `endLine === totalLines`) with a hash matching the runtime-known post-edit
  bytes. There is no scoped/partial confirmed post-edit anchor — a confirmed
  apply re-anchors to whole-file because the full post-edit content is always
  runtime-known (`processEditTransaction` computes it from gate-verified
  initial bytes). This is why a confirmed apply may grant whole-file sticky
  authorization even for a localized edit: the granted hash pins the exact
  full post-edit bytes, and every consumer re-hashes the current file and
  fails closed on drift. A destructive `delete`/`move` additionally requires
  the anchor to be whole-file (`startLine === 1`) as a defensive guard, so a
  future partial anchor could never authorize a whole-file delete/move.
- Reread when the next edit needs a different region, the action anchor is
  missing or oversized, external activity may have made filesystem state
  stale, or a stale/ambiguous diagnostic explicitly asks for a fresh range.
  On stale-anchor or anchor-not-found failures, read the named target range and
  retry with the new capability rather than guessing from memory.
- For a one-file recovery request, the harness accepts
  `{ paths: ["file"], ranges: [{ startLine, endLine }] }` and safely infers the
  omitted range path. It still rejects missing range paths when multiple files
  make the target ambiguous.
- Authorization write-back happens after all in-flight tools settle. A
  confirmed edit also refreshes whole-file authorization from its known
  post-edit content, including edits originally authorized by a scoped range.
- A read and edit emitted in one provider response still execute in safe order,
  but the new implicit whole-file authorization is not usable until the next
  model step **unless** the edit carries an explicit capability or the server
  performs its one-shot auto-reread (below). Explicit authenticated capabilities
  from earlier visible context remain valid.
- Semantic compaction and emergency mechanical trimming **no longer wipe**
  sticky whole-file authorizations/hashes. They record a `context_compacted`
  reread reason. For `str_replace`, hash-fresh unique edits may still proceed
  and clear the marker only after a successful unique apply (unique `oldString`
  is the safety bound); failed/no-match `str_replace` and proper-subset/scoped
  reads do **not** clear it. For **`write_file`**, `context_compacted` **blocks**
  a whole-file overwrite even when the sticky hash still matches disk — only a
  complete whole-file `read_files` grant (paths whole-file content, or full-file
  range `1..totalLines` with `sourceContent`) **or** an explicit whole-file-covering
  `basedOnRead` (hash-fresh, startLine=1 through current line count, same project/
  path/run) clears that marker before overwrite is allowed. Changed files still
  fail closed on hash mismatch. Authenticated scoped capabilities retained in
  operational memory are still verified against live content when used.
- Complete full-file range reads (`startLine === 1` and `endLine === totalLines`,
  with complete `sourceContent`) grant sticky whole-file authorization the same
  way as `read_files.paths`. Proper-subset and truncated ranges stay scoped-only.
- On a strict auth miss (no fresh whole-file hash match and no `basedOnRead`),
  `str_replace` / `edit_transaction` `str_replace` may **auto-reread once**
  server-side via `requestOptionalFile` and authorize **only that** unique
  replacement in-process (`allowMultiple` false/undefined). Multi-match
  replacements with `allowMultiple: true` **never** auto-reread — they fail
  closed and require real sticky auth or explicit `basedOnRead`. Auto-reread
  **does not** mint durable sticky whole-file authorization (so a later
  `write_file` cannot chain a blind overwrite off a server re-read). A successful
  applied unique edit may still refresh sticky from observed **post-edit**
  content. Still fail-closed if the file is missing, the circuit breaker is open,
  the match is ambiguous, or zero matches remain after re-read; residual failures
  mint a whole-file `basedOnRead` capability in the error recovery payload.
  Explicit `basedOnRead` still works same-batch.
  **`write_file` (standalone and `edit_transaction` `write_file`) never
  auto-rereads** — whole-file overwrites require a prior complete whole-file
  sticky hash match from a real read / successful observed edit, **or** an
  optional whole-file-covering `basedOnRead` from a fresh complete whole-file
  read (paths or full-file range). Partial range caps **never** authorize
  overwrite. Capability echo on `write_file` / create-on-existing failures is
  retry-usable as `basedOnRead` without an exploratory re-read. Sticky maps alone
  do not make partial-range `basedOnRead` work for overwrite.
- `edit_transaction` create-on-existing recovery points to `write_file` or
  `str_replace` with whole-file sticky auth **or** `basedOnRead` on the
  `write_file` / replacement (end-to-end reachable: mint capability → pass as
  `basedOnRead` on `write_file`). When a capability is already echoed, primary
  guidance is capability-retry (`write_file`/`str_replace` + `basedOnRead`) —
  not an exploratory `read_files` first. The same preference applies to strict
  auth-miss and residual process-failure recovery messages: mint/`basedOnRead`
  first when content is known; `read_files` remains the fallback only when no
  capability can be minted. Auto-reread for transaction `str_replace` does **not**
  clear `context_compacted`/failed-edit markers pre-apply — only successful unique
  apply (or a real whole-file basedOnRead/read) clears them.
- Input-only and preflight failures that never reached the client preserve a
  still-current whole-file authorization. Failures that make filesystem state
  uncertain revoke it and persist a typed reread reason across turns; the next
  blocked edit names the originating tool/reason, and a successful recovery
  read clears that state.

This policy is staged/strict-mode only; tools still apply unique-anchor
`str_replace` edits without `basedOnRead` when ambiguity is not a risk.

Structured v1 `read_files` responses are correlated back to their requested
selectors before any authorization is derived from them. A response whose
items do not line up with the requested selector index, kind, and path fails
closed: no content or capability from that batch is allowed to mint whole-file

or scoped read authorization. The failure is reported per selector — each
requested selector keeps its own genuine per-item diagnostic (for example a
real `not_found`/`blocked` error for that path) instead of being collapsed
into a single blanket mismatch error, while any selector the response did not
correctly return is reported as a fail-closed `invalid_request` error.

Legacy path-keyed results (`Record<string, string | null>`, where paths are
used as object keys) are adversarial inputs and are normalized defensively:

- **Prototype-chain collisions fail closed.** Key lookups are
  own-enumerable-only, so a requested path that collides with an
  `Object.prototype` member name (for example `constructor`, `toString`,
  `hasOwnProperty`, or `__proto__`) is never read as inherited content; the
  selector resolves to `not_found` instead of minting garbage content or an
  authorization.
- **Ambiguous same-path batches fail closed.** A path-keyed map stores one
  value per path, so a batch that requests a whole file AND one or more
  ranges for the same path cannot correlate its selectors safely. Every
  selector on that path is rejected with a fail-closed `invalid_request`
  error rather than letting a range block leak into a whole-file item or
  whole-file content leak into a range item. Request the file and its ranges
  in separate batches (or return structured-v1 results from overrides).

Replacement batches discard only operation-less placeholder entries such as
`{}` or `{ allowMultiple: false }`, which some providers append after valid
replacements. One-sided entries, misspelled payload keys, and batches containing
only placeholders still fail schema validation.

Prose references such as `[see patch above]` are rejected at schema validation
for every active mutation payload. Each edit call must carry its exact
`oldString` and complete replacement bytes. Because this rejection occurs
before edit preparation, it does not consume a valid prior read authorization.

`edit_transaction.edits` should always be passed as an actual array of objects,
never as a JSON string. The runtime defensively decodes complete legacy
stringified or double-stringified arrays and entries, but malformed or truncated
strings fail at the `edits` field boundary instead of being misreported as an
invalid `edits[0]`. When `type` is omitted, the harness repairs only unambiguous
payloads (`replacements`, `operation`, `destinationPath`, `diff`, a complete
range payload, or `symbol` plus `content`). Content-only edits remain rejected
because the intent could be `create` or `write_file`. Conflicting payload shapes
and invalid decoded edit objects remain rejected.

Schema-validation errors include bounded excerpts for each failing issue path
instead of only the first 500 characters of a large call. Recovery hints are
field-specific: range-capability conflicts show the capability's actual bounds,
and `skipIfMissing` errors identify its deletion-only contract without appending
unrelated array/stringification instructions.

### Edit intent and canonical mixed-mode compilation

Use `str_replace` by default for localized exact edits. Use `rewrite_symbol`
only when the replacement is a complete symbol, including its full declaration
and body. Use `replace_range` when changing an authenticated range returned
directly by `read_files`; pass that read's capability rather than reconstructing
line/hash metadata.

A transaction may mix these modes on one file only when their spans in the
original snapshot are disjoint and the compiler can map every action
unambiguously. Canonical transaction compilation resolves all original spans,
rejects overlap or ambiguous provenance, and then maps accepted actions through
prior edits deterministically. Splitting an overlapping rewrite into different
edit variants does not bypass this rule.

### Multi-file `edit_transaction` abort recovery

`edit_transaction` is all-or-nothing: any preflight failure means **no disk
writes**. Match/no-match and capability aborts require a fresh read of **every**
transaction target in that run, not only the failed path. Pure syntax preflight
failures do **not** force multi-path re-read (fix the new content only).

This is **not** an always-on force-read before the first multi-file attempt. Fresh
multi-path reads are abort-time / capability / match recovery only.

On those aborts the model-visible result is additive and machine-readable:

- `requiresFreshRead: true`
- `errorCode`: `no_match` | `stale_capability` | `preflight_failed`
- `failures[].failureKind`: `capability_*`, `no_match`, `preflight_failed`, or
  `generic`
- `recovery`: `{ action: 'rebuild_whole_transaction', requiresFreshRead, paths,
  failedEditIndex?, failedReplacementIndex?, preferredStrategy?, tool:
  'read_files', input: { paths } }`

Correct next step: one multi-path `read_files` (or range/symbol selectors) over
`recovery.paths`, copy exact live text into new `oldString`s / use
`replace_range` with `readCapability`, then resubmit the **whole** transaction
from that one snapshot. Do not refresh only the failed path or replay memory for
other targets. Large or low-similarity `oldString` diagnostics may set
`preferredStrategy` to `replace_range` or `smaller_oldString`.

### Post-edit anchors and reread telemetry

Confirmed action-local anchors are reusable operational state. Semantic
compaction retains a bounded set of fully applied, receipt-correlated anchors
without retaining `afterContent`; partial, rollback, malformed, unconfirmed, and
uncorrelated results are discarded. Capability tokens belong only in model
operational memory. User-facing CLI rows show a short post-edit hash and whether
a fresh capability exists, never the token or post-edit body.

Immediate rereads after a successful local mutation are telemetry-classified so
unnecessary reread loops can be distinguished from legitimate recovery:

- `different_region`: the next operation needs bytes outside the confirmed
  action anchor;
- `missing_or_oversized_anchor`: no reusable bounded action anchor was emitted;
- `external_or_stale_state`: another actor or uncertain filesystem result may
  have changed the file;
- `explicit_diagnostics`: a stale, ambiguous, or recovery diagnostic requested
  a fresh read.

The default category is reuse: automatic confirmed whole-file authorization or
the action-local capability is sufficient, so no immediate reread is issued.

### Capability minting and the default replace_range flow

The default flow is read -> capability -> edit. In the common case an agent
follows one of three paths:

1. **Whole-file read.** A complete `read_files.paths` read returns an
   `editAnchor` and mints a reusable per-path authorization. Later
   exact-match edits on that path proceed without passing a capability;
   copy `editAnchor.readCapability` only when explicit proof is required.
2. **Range read.** A complete `read_files.ranges` read returns a scoped
   `editAnchor.readCapability` (cap.v3) bound to those exact lines. Pass it
   verbatim as the edit capability: `edit_transaction` `replace_range`
   `{ readCapability, newContent }` (preferred for a block) or scoped
   `str_replace` with `basedOnRead`. With no caller `startLine`/`endLine`,
   the runtime derives the bounds and hash from the token.
3. **Truncated read.** A truncated or render-clamped read mints nothing and
   says so (`NO edit capability ... was minted`). Re-read a smaller,
   fully-covered range to obtain a fresh `readCapability` before editing.

The rest of this section is the reference detail behind that flow.

A complete range read mints a `readCapability` bound to exactly the
requested line bounds and the hash of the returned slice. The runtime mints
only authenticated cap.v3 tokens from a nonempty capability issuer; each token
binds the project, path, line bounds, content hash, and run. If authoritative
project/run scope is unavailable, no edit capability is minted. Truncated or
render-clamped reads likewise mint nothing, so a partial or unscoped observation
can never be reused as edit authorization.

Structured-v1 range results expose the scoped capability only as
`editAnchor.readCapability`, alongside diagnostic bounds and content hash. They
do not expose a separate whole-file capability. A proper-subset range therefore
remains scoped to the observed range and cannot grant whole-file overwrite
authority. To obtain reusable whole-file authorization or a whole-file-covering
cap.v3 token, perform a complete whole-file paths read or a complete full-file
range read.

On the edit side, the shipped structured-v1 `edit_transaction` `replace_range`
input is capability-only: pass `{ readCapability, newContent }`. During input
normalization the runtime authenticates the token and derives its exact bounds
and expected content hash before preflight. Caller-supplied bounds or
`expectedHash` are not part of this structured-v1 form; re-read the desired
range when different bounds are needed.

### read_files `windows`/`around`/`symbol` selectors and occurrence-scoped `replace_range`

For large files, `read_files` is the capability-minting block read surface: its
`windows`/`around`/`symbol` selectors return one or more COMPLETE structural
blocks so a large file yields a usable edit anchor without a
guess-shrink-retry loop. The selector modes may be combined in one call; each
selector returns one result item with a contiguous `requestIndex` and its own
`editAnchor`:

- `windows: [{ path, windowSize?, window? }]` splits the file into complete
  contiguous line windows (default `windowSize` 400). Omit `window` to get the
  manifest (`totalLines`, `windowSize`, `windowCount`) plus the first window.
- `around: [{ path, match, occurrence?, contextLines? }]` finds the 1-indexed
  `occurrence` (default 1) of the exact literal `match` and returns a complete
  block covering it plus `contextLines` (default 40) on each side, clamped at
  file boundaries. It is robust to line-number drift.
- `symbol: { path, name, occurrence? }` pulls the Nth (default 1) top-level
  symbol with that name, mirroring `rewrite_symbol`'s occurrence semantics; a
  batch `symbols: [{ path, name, occurrence? }]` selector pulls several in one
  call.

Every complete block returns a structured `editAnchor` (`startLine`, `endLine`,
`contentHash`, and a cap.v3 `readCapability` bound to the project, path, and
run). Copy `editAnchor.readCapability` verbatim to `basedOnRead` /
`readCapability` on a follow-up edit. Partial or failed blocks mint NO
capability. These are scoped (per-edit) authorizations, not whole-file grants;
they participate in the same staged read-before-edit policy as a `read_files`
range read.

`replace_range` additionally accepts an optional
`occurrence: { match, occurrence? }` alongside `startLine`/`endLine`. When
present, the edit targets the 1-indexed `occurrence` (default 1) of the exact
literal `match` found only within the capability-authorized range
(`capabilityStartLine..capabilityEndLine`); the resolved absolute lines then
flow through the existing freshness/hash verification and replacement path
unchanged. `occurrence` is mutually exclusive with `startLine`/`endLine`, so a
call provides either explicit line bounds or an occurrence target, never both.
This applies to both the standalone `replace_range` tool and the
`replace_range` edit kind inside `edit_transaction`.

## Explicit elision markers

`str_replace.oldString` supports a narrow `...` elision marker after exact
matching fails. The marker is special only when a line's trimmed content is
exactly `...`, and it must be surrounded by exact literal anchor segments.
Each literal segment must contain at least 10 non-whitespace characters,
and the full elided range must resolve to exactly one deterministic match.
Ambiguous or weak elision anchors fail with recovery guidance rather than
falling back to broad fuzzy matching. `replace_range` remains strict: it
uses the bounds and content hash authenticated by `readCapability`, and does
not accept `...` in place of a capability.

## Reviewer / validation gate semantics

The reviewer/validation gate tracks pending gate files, validation hooks,
and a reviewer gate to decide whether a turn may finish green:

- Each pending gate file is recorded with a working-tree content marker
  of the form `sha256:<hash>:<byteLength>` taken from the on-disk
  contents at the time of the pass.
- Durable pass freshness compares the current file's marker against the
  recorded marker. If the marker has changed (edit, truncation, byte
  drift), the prior pass is discarded and the gate must re-run.
- Missing or unreadable files fail closed: the gate refuses to mark the
  turn green rather than treating an absent file as implicitly passing.
- The user-visible contract is a structured `<gate-state>` block.
  Downstream tooling and agents should parse that block rather than
  scraping surrounding prose.
- File contents themselves are not logged into gate state or
  transcripts. Only the marker (hash + byte length) and pass/fail
  status are recorded.

### Subagent and parallelism policy

Subagent use is phase-triggered orchestration policy, not a random choice. The policy covers every high-impact orchestration candidate:

- Context-gathering breadth: classify each task as `tiny`, `focused`,
  `multi-file`, `cross-subsystem`, or `unknown surface` before editing.
  Tiny tasks read the directly relevant file; focused tasks also inspect
  adjacent tests/callers; multi-file tasks search and read representative
  files; cross-subsystem or unknown-surface tasks use `query_index`,
  `list_directory`, `glob`, and parallel file-picker/code-searcher shards.
- Tool choice: route repository state to `git_status`, source inspection to
  `read_files`/`read_outline`/`read_subtree`/`glob`/`list_directory`/
  `query_index`, images to `read_image`, whole-symbol edits to
  `rewrite_symbol`, related edits to `edit_transaction`, configured hooks
  to `run_file_change_hooks`, visual smoke tests to browser/CLI visual
  agents, and only use shell commands through `basher` when no dedicated
  tool exists.
- Ask-user decisions: require confirmation for destructive commands,
  public API or contract changes, dependency additions, schema/data
  migrations, release/publish/deploy actions, production-affecting scripts,
  and ambiguous product behavior. For reversible or obvious choices,
  choose the conservative path and proceed.
- Discovery phase: use `query_index` directly, then spawn file-picker,
  code-searcher, or researcher agents when relevant files, APIs, or
  commands are not already obvious.
- Reasoning phase: spawn `thinker` after context discovery for complex
  design, architecture, risk, tradeoff, spec/plan critique, or debugging
  strategy decisions. Explicitly skip it for straightforward edits.
- Implementation phase: spawn `editor` for non-trivial source changes
  with a self-contained implementation brief. Preserve simple-task
  exceptions for direct answers and tiny edits.
- Validation selection: map changed paths to the narrowest deterministic
  suite where possible: `agents/base2/*` to agents typecheck plus prompt,
  gate, or e2e subsets when behavior changes; `agents/*` to agents
  typecheck and relevant agent tests; `packages/sdk/*` to SDK checks;
  `packages/agent-runtime/*` to runtime checks; `common/*` to common
  checks plus dependent package typechecks; `cli/src/components/*` and
  `cli/src/hooks/*` to CLI typecheck plus visual smoke; docs/prompt-only
  changes to configured hooks or a recorded skip reason.
- Repair phase: validation failures and timeouts block completion. Repair
  the exact failure, re-run the relevant validation, and use `debugger`
  when repeated failures or unclear runtime behavior need focused
  diagnosis.
- Reviewer selection: use the automated `code-reviewer` gate for edited
  code; use `security-reviewer` for auth, crypto, secrets, permissions,
  injection, sandboxing, path/process/network handling, supply-chain, or
  production-risk changes; use `test-writer` when behavior changes lack
  coverage; use `debugger` after repeated validation/runtime failures.
- Release/deployment flow: for requested push, release, deployment, or
  publish work, follow status inspection, remote/tag fetch, rebase/merge
  decision, push, CI/CD wait, release trigger, artifact/tag/package
  verification, and local branch sync/reporting. Ask before resolving
  non-fast-forward or conflict decisions unless the user already gave an
  explicit strategy.
- Plan artifact maintenance: in EXECUTE_PLAN update `STATUS.md` and
  `LESSONS.md` at phase boundaries, blockers, validation/review results,
  and finalization. Prefer `update_plan_status` for incremental updates.
- Subagent parallelism: parallelize independent discovery shards,
  independent validation commands, and static review that does not depend
  on validation output. Keep dependent edits, fragile debug loops, and
  validation-repair cycles sequential.
- Join discipline: reviewers spawned in parallel with validation provide
  static review only. Reviewer approval cannot certify still-running or
  failed validation; validation failure/timeout and reviewer/security
  blockers both prevent a green finish.

## Plan artifacts and PlanLink wiring

Durable plan artifacts under `.agents/sessions/<plan>/` are wired into the
TUI through PlanLink slash commands:

- `/resume-plan` — re-attach the current session to an existing plan
  artifact and rehydrate its working context.
- `/update-plan` — open the plan artifact for an incremental edit pass.
- `/plan-status` — print the current task/milestone status, derived from
  `STATUS.md`.
- `/lessons` — append or review lesson notes captured during the plan.

For mutations to plan artifacts:

- Prefer `update_plan_status` for incremental updates to `STATUS.md`
  task lines and append-only lesson notes. It preserves surrounding user
  prose, ordering, and any manual edits the user has already made.
- Use `create_plan` only when creating a new plan artifact or doing a
  whole-artifact rewrite. `create_plan` overwrites; it is not the right
  tool for incremental task or lesson updates.
