# Deterministic edit system (public contract)

Strict read-before-edit keeps edits hash-bound to content the agent actually saw. Capabilities are scoped to project, path, and agent run (`cap.v3`). Edits fail closed on stale content, truncated reads, or invented bytes.

This document describes the **runtime public contract** for `read_files`, `str_replace`, `write_file`, and `edit_transaction`. It does not invent options beyond what those handlers enforce.

## Authorization surfaces

| Surface | What it is | Grants |
| --- | --- | --- |
| **Sticky whole-file auth** | Path + content hash stored after a complete whole-file read (or after a successful edit that refreshes observed bytes) | Subsequent edits that check hash freshness against disk |
| **Scoped capability** (`basedOnRead` / `readCapability`) | Hash-bound token from `editAnchor.readCapability` on a complete read | That edit only, when the live file hash still matches |
| **Whole-file-covering capability** | `cap.v3` with `startLine === 1` and `endLine === current line count`, hash-matched to disk | Overwrite via `write_file` / `edit_transaction` `write_file` (and clears `context_compacted` for that path) |
| **In-process auto-reread** | Server-side one-shot load used by `str_replace` when there is no sticky auth and no capability | Authorizes **that** unique `str_replace` only; does **not** mint durable sticky for later `write_file` |

### What mints sticky whole-file auth

- Complete `read_files` via `paths` (whole-file content, `complete: true`).
- Complete full-file **range** reads only: `startLine === 1`, `endLine === totalLines`, `complete: true`, with undecorated `sourceContent`. Partial or truncated ranges never grant sticky auth.
- Successful applied edits may refresh sticky from **observed post-edit content** (not from a blind server re-read alone).
- A validated whole-file-covering `basedOnRead` on `write_file` grants sticky and clears reread markers for that path.

Symbol-only reads never mint sticky whole-file auth.

### What does not authorize a whole-file overwrite

- Partial range or symbol slices alone (including passing a range-scoped capability as `basedOnRead` on `write_file`).
- Sticky hash match after **context compaction** without a new complete whole-file `read_files` grant **or** a validated whole-file-covering `basedOnRead` (see below).
- Auto-reread used for a unique `str_replace` (in-process only; no durable sticky mint before apply).

## Same-step read → edit

**Implicit sticky:** A `read_files` completed in the same model step does not make new whole-file sticky usable for edits that rely only on sticky auth in that step. The runtime distinguishes model-visible sticky (snapshot at generation start) from grants completed later in the streamed response. Write-back of sticky maps settles with in-flight tools; parallel batches can race if an edit assumes sticky that is not yet model-visible.

**Explicit capability (same-batch handoff):** If the edit includes a matching `basedOnRead` / `readCapability` token minted from a complete read and the live file hash still matches at apply time, the edit may proceed in the same batch — including when the read and edit were emitted in one model response. Implicit sticky still waits; explicit tokens work when hash-fresh and in scope.

Practical guidance:

1. Prefer `basedOnRead` / `readCapability` from the last complete `editAnchor.readCapability` on every scoped replacement or overwrite.
2. Do not invent same-step sticky authority. A same-step whole-file `paths` read does **not** authorize a sticky-only `write_file` or capability-less `str_replace` until the next step **unless** you pass an explicit hash-fresh capability.

## Range reads vs sticky auth

- Range / symbol results return scoped `editAnchor.readCapability` for complete, non-truncated slices.
- Pass that token as `basedOnRead` (or `readCapability` for range tools) on the edit.
- Only a **full-file** complete range (`1..totalLines` with `sourceContent`) is promoted to sticky whole-file auth, equivalent to a `paths` read. Do not force a second whole-file `paths` read when the range already covered the full file.
- A partial range-anchored capability must not be treated as whole-file authorization for `write_file` overwrites; only a whole-file-covering `cap.v3` may authorize overwrite.

## Context compaction

After compaction removes exact read bodies from model-visible context (`revokeImplicitReadAuthorizationsAfterCompaction`):

- Sticky path/hash maps are **kept** (not wiped).
- Paths are marked with reread reason `context_compacted` for guidance/telemetry.
- Edit-time checks still **fail closed** if disk content no longer matches the stored hash.

Tool-specific behavior while `context_compacted` is set:

| Tool | Behavior |
| --- | --- |
| `write_file` (standalone or in `edit_transaction`) | Hash-fresh sticky alone is **not** enough. Overwrite is allowed after a **complete whole-file** `read_files` grant, or when the call supplies a validated whole-file-covering `basedOnRead`. Failure messages include a ready-to-paste `basedOnRead` when content is available. |
| `str_replace` | May proceed when sticky is hash-fresh and the unique `oldString` match is the safety bound. The `context_compacted` marker is cleared only after a **successful unique apply** (not after a failed no-match attempt). |
| `delete` / `move` (in `edit_transaction`) | The confirmed post-edit anchor branch intentionally **ignores** the `context_compacted` marker when deciding authorization: a fresh whole-file anchor whose hash matches the live snapshot is stronger evidence than the marker. The marker is deliberately **not** cleared by this branch either, so a subsequent `write_file` on the same path stays blocked until a fresh whole-file read. |
| Partial range / symbol re-read | May clear other reread gates, but **must not** drop `context_compacted` until a complete whole-file grant. |

## Auto-reread and capability echo

### `str_replace` auto-reread (once)

When strict read-before-edit (or recovery-from-failed-edit) would block **and**:

- there is no stored sticky auth,
- no `basedOnRead` on the replacements,
- the file exists on disk,

the runtime loads current disk content once and authorizes **this** unique `str_replace` in-process. It does **not** call `grantWholeFileReadAuthorization` before apply (so a later `write_file` cannot chain off a blind re-read).

- If the unique replace applies: post-apply sticky may refresh from observed post-edit bytes.
- If it still fails (no match / ambiguous / other processing failure): the error appends a whole-file `basedOnRead` and a structured `recovery` object so the next step can retry without a separate exploratory re-read.
- Stale sticky (external file change): **not** auto-regranted; fails closed with a freshness / re-read error.
- Missing file: fails closed.

`edit_transaction` applies the same auto-reread-once rule per unique path for `str_replace` edits only (transaction-local; no pre-apply durable sticky).

### Auth-miss recovery payloads

When an edit is blocked for missing or stale authorization, failures commonly include:

- Human-readable next step (`call read_files with paths: [...]` or range selector for range tools).
- `errorCode: 'fresh_read_required'` where applicable.
- Ready-to-paste `basedOnRead` in the error text and/or `recovery.basedOnRead` (pre-minted whole-file capability when content is known).

`edit_transaction` failures list per-edit `failures[]` entries; those may each carry `basedOnRead`.

**Next-step retry without exploratory re-read:** when a failure already includes a whole-file-covering `basedOnRead`, pass it on the next `write_file` or `str_replace` call. Do not open a separate exploratory `read_files` first unless the token is missing, out of scope, or hash-stale.

## `write_file` and create UX

### Schema (public input)

Standalone `write_file` and `edit_transaction` edits of type `write_file` accept optional `basedOnRead`:

- Must be a whole-file-covering `cap.v3` (lines `1..currentLineCount`).
- Hash and project/path/run scope must match current disk content.
- Partial range capabilities never authorize overwrite; failures mint a fresh whole-file capability for retry.

### `write_file` (standalone)

| Situation | Authorization |
| --- | --- |
| **Create** (disk content `null`) | No prior sticky or capability required. |
| **Overwrite** | Hash-fresh whole-file sticky, **or** a prior same-turn successful whole-file `write_file` on that path, **or** a validated whole-file-covering `basedOnRead`. |
| **Overwrite under `context_compacted`** | Sticky alone is insufficient. Supply whole-file-covering `basedOnRead`, or complete a whole-file `read_files` first. |
| **Auth miss / bad capability** | No blind auto-apply of the overwrite. Error includes ready-to-paste `basedOnRead` when content is loadable; retry with that token. |

### `edit_transaction` create

- `type: "create"` on a path that already exists is rejected with a clear message: use `write_file` (with whole-file sticky or whole-file-covering `basedOnRead`) or `str_replace` for an in-place edit.
- The failure may include a pre-minted whole-file `basedOnRead`. That token is retry-usable on a subsequent `write_file` edit (standalone or in `edit_transaction`) without an exploratory re-read when the hash still matches.

## `edit_transaction` strict mode (summary)

Under `strictReadBeforeEdit`:

- **create** on missing path: allowed without prior read.
- **create** on existing path: rejected (use `write_file` / `str_replace` with auth; recovery may echo `basedOnRead`).
- **str_replace**: sticky hash-fresh, or every replacement has `basedOnRead`, or auto-reread-once (transaction-local, no pre-apply durable sticky).
- **replace_range**: requires explicit `readCapability` when not sticky-fresh.
- **write_file**: sticky hash-fresh **or** validated whole-file-covering `basedOnRead`; blocked under `context_compacted` until whole-file re-read **or** that explicit capability (sticky alone insufficient).
- **delete / move**: a fresh confirmed post-edit anchor on the source path authorizes without another read, but only when the anchor is whole-file (`startLine === 1`) **and** its hash matches the transaction's snapshotted current content. A hash mismatch means the file changed since that confirmed apply — the edit fails closed via the generic strict-mode block. A move's destination needs no read authorization: it must not exist, and the lifecycle preflight (`Move destination already exists`) enforces that. On anchor-authorized delete/move, any stale reread marker on the source path is cleared so a later edit does not inherit a lingering gate; `context_compacted` is deliberately **preserved** so `write_file` on that path stays blocked until a fresh whole-file read.
- Capability / scope failures **and** match/no-match aborts that invalidate the atomic batch require **fresh reads for every transaction target**, not only the first failed path (or paste echoed per-failure `basedOnRead` where provided). Pure syntax preflight failures do **not** force multi-path re-read. This is abort-time recovery only — not always-on force-read before the first multi-file attempt.
- Abort recovery packet (additive, model-visible): `requiresFreshRead: true`; `errorCode` of `no_match` | `stale_capability` | `preflight_failed`; `failures[].failureKind` of `capability_*` | `no_match` | `preflight_failed` | `generic`; `recovery` with `{ action: 'rebuild_whole_transaction', requiresFreshRead, paths, failedEditIndex?, failedReplacementIndex?, preferredStrategy?, tool: 'read_files', input: { paths } }`. Large/low-similarity match diagnostics may set `preferredStrategy` to `replace_range` or `smaller_oldString`.

## Agent / editor contract

1. Always copy `editAnchor.readCapability` into `basedOnRead` (or the tool’s `readCapability` field) for range-anchored edits. Never invent same-step sticky auth.
2. Prefer explicit capabilities over relying on same-step sticky. Explicit hash-fresh tokens authorize same-batch; sticky does not.
3. After compaction, either re-read whole files before sticky-only `write_file`, or retry overwrite with the echoed whole-file-covering `basedOnRead`. Unique `str_replace` may still work when sticky remains hash-fresh.
4. On auth failures, prefer the echoed `basedOnRead` / `recovery` payload over inventing a new exploratory read loop when the capability is already provided.
5. Do not use `create` for existing paths; use `write_file` or `str_replace` with authorization. If create-exists fails with a minted `basedOnRead`, pass it on `write_file`.
6. On multi-file `edit_transaction` abort with `recovery.action === 'rebuild_whole_transaction'`, re-read **all** of `recovery.paths` in one coherent snapshot and resubmit the whole transaction. Do not refresh only the failed path or replay memory for other targets.
7. Obey `recovery.paths` / `recovery.input` as the authoritative multi-target re-read set; sticky auth from before the abort is revoked for those paths until the fresh read lands.

## Non-negotiable safeguards

- Hash-bound capabilities scoped to project, path, and run.
- Reject stale content and stale/out-of-scope tokens.
- No edit from truncated read content.
- No inventing file bytes the model never saw.
- Fail closed when disk content drifts from the authorized hash.
- No blind server auto-apply of whole-file overwrites (`write_file` never auto-rereads-then-writes).

## Related source (implementation)

Contract is enforced primarily in:

- `packages/agent-runtime/src/tools/handlers/tool/read-files.ts`
- `packages/agent-runtime/src/tools/handlers/tool/str-replace.ts`
- `packages/agent-runtime/src/tools/handlers/tool/write-file.ts`
- `packages/agent-runtime/src/tools/handlers/tool/edit-transaction.ts`
- `packages/agent-runtime/src/tools/handlers/tool/edit-read-state.ts`
- `packages/agent-runtime/src/util/read-authorization.ts`
- `common/src/tools/params/tool/write-file.ts`
- `common/src/tools/params/tool/edit-transaction.ts`
