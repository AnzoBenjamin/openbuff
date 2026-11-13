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
authorization for each touched path before accepting an edit.

Raw UTF-8 bytes and displayed text have separate identities. Observation text
uses LF and excludes a leading UTF-8 BOM; localized splices preserve unrelated
raw bytes, including mixed terminators, later U+FEFF and Unicode scalars.
Invalid UTF-8 and unpaired surrogates are refused. Fresh v4 capabilities bind
both the observation and its original raw basis. Historical v3 remains parsable
but supplies no fresh raw edit authority. Whole bases cannot relocate after
raw drift. Scoped bases can relocate only to a unique unchanged raw slice after
a complete finite search; duplicate scopes or an exceeded budget refuse.

Prepared mutations carry normalized `expectedHash` and separate exact
`expectedRawHash` guards. The SDK checks raw preimages again before staging and
retains its conditional commit and existing receipt/rollback semantics. Bounded
Node readers use an owned result buffer plus a fixed descriptor chunk, scan to
EOF without retaining discarded lines, and forward cancellation through actual
close. Requested-content completeness and known EOF/hash metadata are separate;
a partial selected line grants no authority even when an EOF scan knows totals.

There are three tiers of read authorization, and confusing them is the most
common cause of "I already read this file, why is my edit blocked?":

1. **Whole-file authorization (reusable).** A complete whole-file read with
   an authenticated whole raw basis mints
   a per-path authorization the runtime remembers, so later exact-match edits
   on that path proceed without a capability. Only complete whole-file reads
   with that basis register this.
2. **Scoped capability (per-edit).** A _range_ or _symbol_ read mints a
   `readCapability` bound to the exact project, path, line bounds, content
   observation hash, raw basis, and run. It authorizes only edits inside the
   observed slice and must be
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
  header, or a freshly confirmed after-edit capability) is the explicit
  authorization path. The runtime verifies the embedded observation and raw
  basis and rejects stale or mismatched anchors before any file is changed.
- The `replace_range` transaction edit accepts that same `readCapability` and decodes the
  line bounds plus hash as one atomic target. Prefer this form for Markdown,
  checklists, and formatting-sensitive blocks instead of copying a rendered
  range into a large `oldString` or manually pairing three range fields.
- The provider schema requires `{ readCapability, newContent }` and accepts
  either contained `startLine`/`endLine` bounds or an `occurrence` selector.
  The runtime compatibility parser also accepts the legacy
  `{ startLine, endLine, expectedHash, newContent }` form, but callers cannot
  combine it with `readCapability`. Capability-only edits normalize internally.
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
  `readCapability` is a scope-bound `cap.v4` token the model can pass as
  `basedOnRead` (write_file) or per-replacement `basedOnRead` (str_replace) on
  a follow-up edit, avoiding a redundant re-read. The part appears only when at
  least one anchor was granted; it is omitted when no anchor could be minted
  (for example, no runtime-known content or no authoritative scope).
- `coordinateEditApplication` confirms only `confirmationPaths` (default: all
  coordinated `paths`). `wholeFileContentByPath` may include excluded no-op
  snapshots, but confirmation and new authority are restricted to
  `confirmationPaths`. An extra snapshot with no applied action must not undo
  confirmation of the applied subset or receive a new capability.
  Client-output inspection (`hasExplicitError`, envelope collection, structured
  `stale_snapshot`/`stale_state` classification, and unconfirmed-application
  detection) is an iterative heap walk with a depth bound of 6. Recursion is
  not used, so deeply nested or cyclic tool outputs cannot overflow the stack;
  nodes past the bound are ignored (fail closed).
- The strict read-before-edit blocked-recovery message distinguishes a file
  that was created or edited earlier in the session (it has a confirmed
  post-edit anchor). Instead of the generic "no fresh read authorization
  exists; call read_files" guidance, the message tells the model to retry with
  `basedOnRead` set to the `readCapability` from that create/edit result's
  confirmed post-edit anchor, and the structured `recovery.basedOnRead` echoes
  that token. The other blocked-recovery causes (`stale_snapshot`, a prior
  failed edit, stale-revoked, compacted, never-read) are unchanged.
  `stale_snapshot` is classified from structured `errorCode` (on the output
  object or `failures[]` entries) and from filesystem `code: 'stale_state'`
  on mutation errors/actions (SDK CAS), not only `errorCode: 'stale_snapshot'`.
- A confirmed create or edit can grant whole-file authority only when a
  committed receipt pins exact lossless after-content. The runtime verifies the
  receipt's raw after-hash, checks an authenticated v4 whole anchor or mints a
  local one from those confirmed bytes, and stores its raw basis, observation
  hash, bounds and issuer. Missing after-content grants no new authority.
  Unconfirmed no-op paths and extra receipt envelopes outside the requested
  confirmation set receive no new capability.
- Confirmed post-edit anchors remain durable across turns. Hydration retains
  the original raw basis only for the matching trusted local project/run issuer;
  it cannot upgrade v3 into raw authority. Revocation, workspace revision changes
  and unknown-tool invalidation clear stale anchors. A later delete or move
  requires an explicit whole basis and unchanged exact source bytes. A move's
  destination remains an exclusive missing target. Confirmed operations discard
  earlier prepared promise queues, so follow-up writes use current or absent
  source content. Localized edits can grant whole authority from a confirmed
  full after-content receipt even though their initial read was scoped.

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
- Semantic compaction and emergency trimming preserve sticky raw hashes while
  recording `context_compacted`. Unique exact `str_replace` edits can still
  proceed on fresh authority, but their successful apply and scoped reads keep
  that marker. A whole-file overwrite requires a fresh complete paths read or
  an explicit v4 capability with a matching whole raw basis to clear it.
  Range, window, around and symbol selectors retain `scope: 'lines'`, including
  slices covering the visible file; coverage alone cannot grant whole authority.

- On a strict auth miss, `str_replace` may auto-reread once through the lossless
  optional-file callback for a unique replacement. `allowMultiple` requires real
  sticky authority or an explicit capability. Auto-reread grants no durable
  whole-file authority; only a confirmed applied result can supply a new whole
  after-basis. Missing, ambiguous or stale results require a fresh read and mint
  no capability. Supplied invalid or stale capabilities are always respected as
  a refusal boundary, including on small files with a unique `oldString`.
  Whole-file `write_file` never auto-authorizes from a blind reread: it needs
  unchanged raw whole-file sticky authority or an explicit matching v4 whole
  capability. Line and structural tokens cannot authorize that overwrite.

- `edit_transaction` create-on-existing recovery points to `write_file` or
  `str_replace` with whole-file sticky auth **or** `basedOnRead` on the
  `write_file` / replacement (end-to-end reachable: mint capability → pass as
  `basedOnRead` on `write_file`). When a capability is already echoed, primary
  guidance is capability-retry (`write_file`/`str_replace` + `basedOnRead`) —
  not an exploratory `read_files` first. The same preference applies to strict
  auth-miss and residual process-failure recovery messages: mint/`basedOnRead`
  first when content is known; `read_files` remains the fallback only when no
  capability can be minted. Auto-reread and a successful unique `str_replace`
  apply do **not** clear `context_compacted` — only a complete whole-file
  `read_files` grant or an explicit `basedOnRead` with a whole raw basis does.
  Other failed-edit markers may still clear after a confirmed unique apply.
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

Any `edit_transaction` preflight failure means **no disk writes** by the
transaction. Application remains guarded and sequential; client failures can
report partial changes or rollback. On match/no-match and capability aborts a fresh read is
required only for the **failing** paths named in `recovery.paths`. Non-failing
targets keep their existing read authorization and do **not** need re-reading —
that retained authorization is still hash-verified against live content at its
next use, so a path some external actor changed fails closed then, exactly as it
would after a full re-read. The whole transaction must still be rebuilt and
resubmitted, because nothing was applied. Pure syntax preflight failures do
**not** revoke any authorization (fix the new content only).

This is **not** an always-on force-read before the first multi-file attempt. Fresh
reads of the failing paths are abort-time / capability / match recovery only.

On those aborts the model-visible result is additive and machine-readable:

- `requiresFreshRead: true`
- `errorCode`: `no_match` | `stale_capability` | `preflight_failed`
- `failures[].failureKind`: `capability_*`, `no_match`, `preflight_failed`, or
  `generic`
- `recovery`: `{ action: 'rebuild_whole_transaction', requiresFreshRead, paths,
failedEditIndex?, failedReplacementIndex?, preferredStrategy?, tool:
'read_files', input: { paths } }`

Correct next step: one `read_files` (paths, or range/symbol selectors) over
`recovery.paths` — the failing targets only — copy exact live text into new
`oldString`s / use `replace_range` with `readCapability`, then resubmit the
**whole** transaction from that snapshot, reusing the retained read state of the
non-failing targets. Do not re-read targets `recovery.paths` does not name, and
do not replay a stale token or `oldString` from memory for a path that did lose
its authorization. Large or low-similarity `oldString` diagnostics may set
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
   `editAnchor.readCapability` (cap.v4) bound to those exact lines. Pass it
   verbatim as the edit capability: `edit_transaction` `replace_range`
   `{ readCapability, newContent }` (preferred for a block) or scoped
   `str_replace` with `basedOnRead`. With no caller `startLine`/`endLine`,
   the runtime derives the bounds and hash from the token.
3. **Truncated read.** A truncated or render-clamped read mints nothing and
   says so (`NO edit capability ... was minted`). Re-read a smaller,
   fully-covered range to obtain a fresh `readCapability` before editing.

The rest of this section is the reference detail behind that flow.

A complete range read mints a `readCapability` bound to exactly the
requested line bounds, observation hash and original raw basis. The runtime mints
only authenticated cap.v4 tokens from a nonempty capability issuer; each token
binds the project, path, line bounds, observation hash, raw basis, and run. If authoritative
project/run scope is unavailable, no edit capability is minted. Truncated or
render-clamped reads likewise mint nothing, so a partial or unscoped observation
can never be reused as edit authorization.

Structured range results expose `editAnchor.readCapability`, diagnostic
bounds, the observation hash and the authenticated raw basis. Every line or
structural selector retains a lines basis, even when it covers the visible
file. Obtain reusable whole-file authority through an authenticated complete
paths read or a confirmed exact after-content receipt.

For `replace_range`, pass `{ readCapability, newContent }` to replace the
observed range. Optional `startLine` and `endLine` together select a contained
sub-range; optional `occurrence` instead targets a literal occurrence inside
that range. The runtime derives and verifies raw freshness from the token;
`expectedHash` is not a model-facing input. An explicit final empty entry is
addressable only when its capability and complete EOF metadata authenticate it.
An omitted read end stays at the visible ceiling.

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
`contentHash`, and a cap.v4 `readCapability` bound to the project, path, and
run). Copy `editAnchor.readCapability` verbatim to `basedOnRead` /
`readCapability` on a follow-up edit. Partial or failed blocks mint NO
capability. These are scoped (per-edit) authorizations, not whole-file grants;
they participate in the same staged read-before-edit policy as a `read_files`
range read.

`replace_range` additionally accepts an optional
`occurrence: { match, occurrence? }` as an alternative to `startLine`/`endLine`. When
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
  cross-subsystem or unknown-surface tasks use `query_index`,
  `list_directory`, `glob`, and parallel file-picker shards.
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
- Discovery phase: use `query_index` directly, then spawn file-picker or
  researcher agents when relevant files, APIs, or
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
- `/plans` (alias `/plan-ls`) — list every plan session under
  `.agents/sessions/` that holds at least one known plan artifact
  (`SPEC.md`, `PLAN.md`, `STATUS.md`, `LESSONS.md`), one row per session
  with active marker, `[status]` badge, slug, `N/M done` progress, and
  current task. Takes no arguments and runs locally without prompting
  the agent. When `.agents/ACTIVE_SESSION` names a slug it does not
  list, it prints a `Stale active session: <slug> ...` note.
- `/plan-use <slug>` (aliases `/plan-active`, `/use-plan`) — point
  `.agents/ACTIVE_SESSION` at a session, given a bare slug or the
  `.agents/sessions/<slug>` path form; with no argument it opens the
  plan-session picker. It fails closed without writing the pointer for a
  target that escapes the project root, resolves outside
  `.agents/sessions/`, nests under a session directory, is not a valid
  slug, is missing on disk, or holds no known plan artifact. The pointer
  stores the bare slug.

For mutations to plan artifacts:

- Prefer `update_plan_status` for incremental updates to `STATUS.md`
  task lines and append-only lesson notes. It preserves surrounding user
  prose, ordering, and any manual edits the user has already made.
- Use `create_plan` only when creating a new plan artifact or doing a
  whole-artifact rewrite. `create_plan` overwrites; it is not the right
  tool for incremental task or lesson updates.
