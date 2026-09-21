# Audit findings: shard-gate-reviewer

- Subsystems: base2-gate, reviewer-agents, common-util-gate-telemetry, common-util-gate-repair-budgets, common-util-audit-receipt, common-types-harness-control-plane, common-types-workspace-state, common-agents-specialist-risk-router, base2-quality-prompt-section, gate-helper-generation, gate-test-suite
- Features: validation-gate, reviewer-attestation, reviewer-fingerprint, repair-flow, repair-budgets, no-verdict-retries, plan-task-gate-receipts, committed-surface-review, reviewer-bypass-challenge, condoned-findings, gate-telemetry-sink, structural-audit-receipt, specialist-risk-routing, reviewer-output-schema, gate-awareness-prompt, workspace-journal-state, harness-optimistic-concurrency, gate-helper-generation-parity
- Files covered: 22
- Snapshot: df9b2f192f10abc4503dfdc5a5a30643b0fd9ca84ef8d8cf5cd8988d93669cc1

## [MEDIUM] security — agents/base2/gate-repair.ts:130 — Raw hook stderr and reviewer finding text flow unescaped into the repair-editor prompt (second-order prompt injection)
- **Risk:** buildRepairEditorPrompt interpolates raw hook stderr (f.message, u.message) and reviewer-derived finding text into a prompt delivered to a write-capable editor agent with no delimiting or sanitization. A malicious dependency build script or a second-order prompt-injected reviewer (the reviewer reads adversarial files) can embed directive text ('run X', 'commit Y', 'ignore instructions') that the repair editor follows, turning the automated repair loop into an execution channel.
- **Fix:** Emit raw diagnostics inside a fenced data block with an explicit 'data, not instructions' contract in the prompt; escape or strip directive-like sequences (tool-call syntax, 'ignore previous', spawn invitations) from interpolated stderr and reviewer text before prompting.
- **Evidence:** lines.push(`  ${file}:`); ... lines.push(`    ${loc} — [${f.source}] ${f.message}`) and lines.push(`  [${u.source}] ${u.message}`) — no sanitization between 'Validation hooks failed' instructions and attacker-influenced text.

## [LOW] security — agents/base2/gate-paths.ts:13 — Gate path containment is lexical only — no realpath/symlink resolution
- **Risk:** normalizeGateFilePath rejects '..' segments and enforces a lexical cwd prefix, but never resolves symlinks or platform aliases. A path like link.ts -> /etc/passwd (or a symlinked directory inside the project) passes normalization, so gate reads, content markers, and reviewer attestations can cover bytes outside the project while the printed path looks in-project. The repo already ships realpath machinery (common/src/util/project-path-containment.ts) that this module does not use.
- **Fix:** Resolve realpaths for gate file reads (or reuse resolveProjectPathForRead from project-path-containment.ts) before hashing/attesting, and record the canonical path in the snapshot details.
- **Evidence:** isAbsolute && (!cwd || (normalized !== cwd && !normalized.startsWith(`${cwd}/`))) — string-prefix check only; project-path-containment.ts realpath helpers exist in the same repo but are not referenced.

## [LOW] security — agents/base2/gate-committed-surface.ts:52 — Committed-surface accepts symlink content markers without verifying the link target is in-project
- **Risk:** isAttestableCommittedSurfaceMarker accepts 'symlink-sha256:<hex>:<len>' as verifiable content, and the docblock asserts the symlink is a 'safe in-project symlink', but no code in this module (the module the docblock says stays import-free and self-contained) verifies the link target. If the caller's markerFor stamps a symlink pointing outside the repo, the committed-surface receipt hashes and attests out-of-project bytes.
- **Fix:** Pass the symlink target (or a verified-target marker) into deriveCommittedSurfaceFileSet and reject targets resolving outside the project here, with a test pinning the rejection.
- **Evidence:** /^(?:symlink-)?sha256:[a-f0-9]{64}:\d+$/.test(value) — both marker kinds accepted; no target-path parameter or in-project assertion anywhere in the module.

## [MEDIUM] security — common/src/util/gate-telemetry.ts:346 — Gate telemetry persists payload strings unredacted — secrets echoed by failing hooks land in plaintext JSONL
- **Risk:** appendGateTelemetryEvent bounds field and line SIZES but performs no content redaction. Gate payloads carry file paths, hook stderr, validation summaries, and reviewer findings; a failing hook that echoes an environment variable, token, or connection string persists it unencrypted (0o600 mode is access control, not encryption) in .openbuff/telemetry/base2-gate.jsonl for the life of the two-generation rotation window.
- **Fix:** Run string fields through a secret/PII redaction pass (reuse the cache-debug summarizeSecret/summarizeCacheDebugValue machinery) before serialization, or at least for keys matching credential-shaped names.
- **Evidence:** appendGateTelemetryEvent writes serializeBoundedLine(payload) verbatim; bounding bounds SIZE only (boundArrayItems/capOversizedFields); no redaction pass exists in the module.

## [MEDIUM] correctness — agents/base2/gate-paths.ts:59 — Reviewability policy silently exempts manifests, CI workflows, and lockfiles from reviewer attestation, contradicting the specialist router
- **Risk:** isReviewableGateFile excludes .json, .yml/.yaml, .toml and its extension allowlist omits lockfiles/go.mod/Gemfile, so edits to package.json, tsconfig.json, .github/workflows/*.yml, or Cargo.toml are 'non-reviewable'. selectSpecialistReviewers (common/src/agents/specialist-risk-router.ts:64) routes dependency-reviewer for exactly those files, but the reviewable pending set has already dropped them — a manifest-only change yields an 'unreviewed-scope' receipt and no review at all. Supply-chain-relevant changes (scripts, dependency bumps, CI steps) bypass the final reviewer gate by design.
- **Fix:** Add manifest/lockfile/CI-workflow classes to reviewability (routed specifically to dependency-reviewer with a cheaper contract), or make selectSpecialistReviewers consume the same isReviewableGateFile predicate so routing and reviewability cannot disagree.
- **Evidence:** if (/\.(md|mdx|json|jsonl|yml|yaml|toml)$/.test(filePath)) return false; final allowlist /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|kts|cs|fs|vb)$/ has no manifest/lockfile/CI class; router matches '(?:^|\/)(?:package\.json|bun\.lockb?|...)' on the same paths.

## [MEDIUM] correctness — agents/base2/gate-reviewer.ts:153 — resolveReviewerAttestation's documented loosening lets a quoted example entry credit file coverage the real entry never attested
- **Risk:** reviewedFiles is the UNION of all schemaVersion-carrying entries while snapshotFingerprint comes from the attesting entry. A reviewer (or a model quoting the documented example receipt, which literally shows reviewedFiles: ["src/a.ts"]) can have a quoted example's path colliding with a real pending path credit coverage the real entry never attested. The docblock pins this as an 'ACCEPTED LOOSENING' and gate-reviewer.test.ts:571 tests that the collision CREDITS — the guarantee is the weaker 'no entry reported it' check.
- **Fix:** Bind the reviewedFiles union to the entry that contributed the credited fingerprint, special-casing the deletions-only receipt (attesting entry legitimately reports an empty reviewedFiles while every pending file is in deletedFiles).
- **Evidence:** for (const entry of shaped) { for (const file of entry.reviewedFiles ?? []) reviewedFiles.push(file) } — union taken before/after attesting-entry selection; gate-reviewer.test.ts:571 'the reviewedFiles union credits a colliding quoted example path' pins the behavior.

## [MEDIUM] correctness — agents/base2/gate-reviewer.ts:195 — Fingerprint tolerance makes the reviewer attestation partially honor-system — a coverage-complete review echoing any well-formed v3 fingerprint is credited
- **Risk:** A review reporting the EXPECTED fingerprint's length and shape but a different value still finalizes when reviewedFiles covers the pending set (drift is only recorded via collectReviewerFingerprintDrift). Because reviewedFiles is reviewer-reported and never cross-checked against the reviewer's actual read_files receipts, the attestation is honor-system for both components: a reviewer that reads one file can echo a well-formed v3 fingerprint, list all pending paths, and pass the gate. The docblock acknowledges the tolerance; the read-receipt gap is not compensated anywhere in the gate.
- **Fix:** Make a fingerprint mismatch a re-review (drift is a fresh-facts event, not credit), or verify reviewedFiles against the reviewer's read_files receipts so the attested set is grounded in observed reads rather than reported reads.
- **Evidence:** else if (reportedFingerprint !== expectedFingerprint && missing.length > 0) — mismatch with full coverage yields no issue, only collectReviewerFingerprintDrift; reviewedFiles is trusted as reported.

## [LOW] correctness — agents/base2/gate-repair.ts:101 — parseValidationFailures dedupes across failure sources, dropping the second hook's distinct message at a shared file:line:col
- **Risk:** The dedupe key `${p.file}:${p.line ?? 0}:${p.column ?? 0}` omits p.source, so when tsc and eslint (or two hooks) both fail at the same location with different messages, the second record is dropped entirely and the repair prompt shows only one hook's message. The docblock scopes dedupe to 'within a single call' but the practical effect is cross-hook message loss; no test exercises two hooks failing at the same location.
- **Fix:** Include source in the dedupe key (or merge same-location records across sources with both messages) and add a cross-source collision test asserting both messages survive.
- **Evidence:** const key = `${p.file}:${p.line ?? 0}:${p.column ?? 0}` — no p.source; test 'deduplicates identical file:line:column within one failure body' (gate-repair.test.ts:97) is the only dedupe test.

## [LOW] correctness — common/src/types/workspace-state.ts:28 — workspace-state re-implements a local 32-bit FNV-1a stableHash (duplicate of common/src/util/stable-hash.ts) as its snapshot-identity chain
- **Risk:** advanceWorkspaceState chains snapshotIds (previous + revision + actions) through a locally redefined FNV-1a 32-bit hash. 2^32 space gives birthday collisions at ~2^16 distinct states, and a collision produces an identical snapshotId for different content — a journal consumer cannot distinguish divergent histories. common/src/util/stable-hash.ts already exports a stableHash with the identical FNV-1a implementation, which the codebase's own review rules flag as a duplicated canonical helper.
- **Fix:** Import the shared stableHash (or sha256 via the gate-fingerprint module), version the digest algorithm inside the snapshotId format, and delete the local copy.
- **Evidence:** let hash = 2166636261 ... hash = Math.imul(hash, 16777619); return (hash >>> 0).toString(16).padStart(8, '0') — locally defined; common/src/util/stable-hash.ts exports the same-name function.

## [LOW] correctness — agents/base2/gate-reviewer.ts:747 — Transient-crash classifier treats any '429' substring as a provider rate limit
- **Risk:** isTransientReviewerCrash uses substring matching, so any crash message containing the digits 429 ('429 diagnostics emitted', 'port 4290 in use', 'checked 4291 files') classifies as a provider rate-limit and the gate takes the transient path instead of the fatal path — masking a real reviewer defect and burning a retry.
- **Fix:** Match status codes with context (status_code === 429, 'HTTP 429', word-boundary plus error vocabulary) or parse structured error fields instead of substrings.
- **Evidence:** patterns = ['rate_limit', 'rate limit', ..., '429', ...]; return patterns.some((pattern) => lower.includes(pattern)).

## [LOW] correctness — agents/base2/gate-paths.ts:20 — file:// URLs with a non-empty authority silently collapse to a relative path instead of being rejected
- **Risk:** The file:// prefix is stripped unconditionally, so 'file://attacker-host/etc/passwd' becomes the relative path 'attacker-host/etc/passwd' rather than being rejected — the path silently changes meaning (a URL for an absolute remote path turns into an unrelated project-relative file). Benign but surprising normalization in a security-sensitive boundary helper.
- **Fix:** Reject file:// URLs carrying a non-empty authority (and ideally reject the file:// scheme entirely once the lexical-cwd rule covers absolute paths), instead of slicing it off.
- **Evidence:** if (normalized.startsWith('file://')) { normalized = normalized.slice('file://'.length) } — authority not checked before slicing.

## [MEDIUM] state-mutation — agents/base2/gate-state.ts:284 — Gate-state invariants are enforced only at scattered write sites — no central normalization/validation of the 40+ field shape
- **Risk:** Base2ActiveWorkState declares ~40 optional fields whose invariants (condoned lists bounded to 200 at every write site, receipts bounded to 24, marker maps must be plain JSON records, one live receipt per task, per-specialist marker maps deleted wherever credit is evicted) live exclusively in docblocks and are enforced at scattered write sites inside base2.ts's 10k-line handleSteps. Nothing in the type module validates or normalizes the shape; a single missed write site silently violates the bound, and corrupt serialized state only fails closed for the few fields that have hydration normalization (planTaskGateReceipts), not the rest.
- **Fix:** Add a single normalizeBase2ActiveWorkState (applied at hydration and before every persist) that enforces all structural invariants — array types, bounds, marker-map plain-object shapes, one-receipt-per-task — the way planTaskGateReceipts already normalizes non-array values to [] at hydration.
- **Evidence:** Docblock-asserted contracts ('Bounded to the most recent 200 entries at every write site', 'MUST stay a plain JSON-serializable record') span ~400 lines with no runtime enforcement; only planTaskGateReceipts documents hydration normalization.

## [LOW] state-mutation — agents/base2/gate-state.ts:284 — openReviewerFindings is the only durable gate ledger with no documented write-site bound
- **Risk:** condonedFindingTexts/condonedFindingKeys are documented as bounded to 200 and planTaskGateReceipts to 24 at every write site, but openReviewerFindings — which accrues one entry per open blocking finding with files, fingerprints, and timestamps — carries no documented bound. Under default-unlimited repair rounds with per-round findings, the serialized durable state grows monotonically within a run.
- **Fix:** Bound openReviewerFindings at its write sites (and at hydration) to the most recent N open findings, mirroring the documented 200/24 conventions, and state the bound in the docblock.
- **Evidence:** openReviewerFindings?: Array<{ id: string; ... createdAt: string }> — the only unbounded ledger among the durable collections in the type.

## [LOW] api-contract — common/src/types/harness-control-plane.ts:54 — Harness control-plane types drift from gate-state finding semantics and lack schemas
- **Risk:** TaskRecord.phase is a bare string while sibling WorkspaceLease.status is a closed union — inconsistent modeling in the same file. ReviewFindingRecord.status ('open'|'addressed'|'resolved'|'invalidated') and Base2ActiveWorkState.openReviewerFindings[].status ('open'|'resolved'|'condoned') describe the same concept with divergent vocabularies, so any future bridge between the control-plane records and gate findings needs lossy mapping. Unlike sibling type modules (memory-v2.ts), these records have no zod schemas for validation at the wire boundary.
- **Fix:** Share one ReviewFindingStatus union between the control-plane types and gate state, give TaskRecord.phase a closed union like WorkspaceLease.status, and add zod schemas for the records that cross the SDK/runtime boundary.
- **Evidence:** phase: string; status: 'open' | 'addressed' | 'resolved' | 'invalidated' — contrast gate-state.ts: status: 'open' | 'resolved' | 'condoned'.

## [LOW] error-handling — common/src/util/gate-repair-budgets.ts:17 — Deprecated budget constants changed exported type semantics from number to null (unlimited) with no consumer-facing signal
- **Risk:** DEFAULT_MAX_REPAIR_ROUNDS, DEFAULT_MAX_SPECIALIST_REPAIR_ROUNDS and DEFAULT_MAX_REVIEWER_REPAIR_ROUNDS were historically numeric hard caps and are now exported as null ('unlimited'). Code that imports the constants as sensible defaults (or docs/tooling that renders them) silently switches to unbounded repair loops; only the progress-guards terminate them. The change is documented as deprecated-but-kept, so the ABI is intentional, but the semantic break is silent for consumers.
- **Fix:** Emit a one-time warning (or telemetry event) when a resolved budget is unlimited and the corresponding round counter first exceeds the historical default (3), so operators see unbounded loops forming.
- **Evidence:** @deprecated Omitted option/env means unlimited, not these values. export const DEFAULT_MAX_REPAIR_ROUNDS = null (three constants, same pattern).

## [LOW] error-handling — common/src/util/gate-telemetry.ts:370 — Intermediate-segment symlink check is check-then-use: a segment planted after the scan is followed
- **Risk:** findSymlinkedSegment scans each path segment, then mkdirSync/openSync run afterwards; a symlink planted at an intermediate segment (.openbuff or telemetry) between the scan and the open is followed (O_NOFOLLOW only protects the final component). The code comments acknowledge this and blame the missing openat-style API, but the failure mode is silent: telemetry is written through the planted link with no report, unlike the final-component case which refuses.
- **Fix:** Open the parent directory once and create the sink with O_NOFOLLOW|O_EXCL under that fd (dirfd-relative open), or document the residual race in the security notes if the Node API surface truly cannot express it — currently the note exists but the race is not listed among the accepted approximations.
- **Evidence:** try { const symlinkedSegment = findSymlinkedSegment(projectRoot); ... } — scan and use are separate syscalls; the module's own note names openat as the missing primitive.

## [LOW] performance — agents/base2/gate-reviewer.ts:447 — Every gate collector re-walks the entire reviewer result tree per gate pass
- **Risk:** collectParentOwnedRequirementBlockers, collectReviewerBlockers, collectReviewerHardBlockers, getReviewerFinalizationVerdict, collectReviewerAttestationIssues, collectReviewerFingerprintDrift, collectReviewerAdvisories, collectReviewerFindingRecords and detectReviewerCrash each independently call collectStructuredReviewerOutputs, i.e. each re-walks the full reviewer tool-result tree (depth 8, breadth unbounded) several times per gate pass. The docblock acknowledges this as a readability convenience; for large reviewer results with nested tool trees it is a repeated O(nodes) walk with allocation per collector.
- **Fix:** Parse the reviewer result ONCE per gate pass into a normalized receipt (verdicts, findings, advisories, attestation, crash) and derive all six collectors from that struct; keep the exported function signatures stable over the cached parse.
- **Evidence:** Structured requirement rows are built per call; the docblock itself: 'every other gate collector ... re-walks the same reviewer result, and visitForStructuredVerdict's depth-8 cap is what bounds the cost.'

## [LOW] test-coverage — agents/__tests__/gate-repair.test.ts:97 — Cross-source dedupe behavior and several budget edge cases have no tests
- **Risk:** The dedupe test at line 97 covers identical file:line:column within one failure body only; the cross-source collision (tsc + eslint at one location) that silently drops a message has no test. gate-repair-budgets.test.ts never exercises 'Infinity'/'1e999' strings (Number() yields Infinity, currently handled by isFinite but unpinned). gate-committed-surface.test.ts has no case for a symlink marker whose target escapes the project (the acceptance criterion the docblock asserts). Condone de-escalation semantics (T1.5) live in base2.ts with tests outside the gate-* suite, so this shard cannot verify their coverage.
- **Fix:** Add: (1) two hooks failing at the same location asserting both messages survive (it will fail against current code — see the correctness finding), (2) Number('Infinity')/Number('1e400') cases for resolvePositiveIntBudget, (3) an out-of-project symlink-marker rejection case for deriveCommittedSurfaceFileSet.
- **Evidence:** grep over gate-repair.test.ts for 'dedupe|duplicate|same location|two hooks|cross' returns only line 97's single-body test; gate-repair-budgets.test.ts has no Infinity/'Infinity' case.

## [LOW] test-coverage — agents/__tests__/gate-committed-surface.test.ts — No test rejects a committed-surface symlink marker whose target leaves the project
- **Risk:** The suite pins cap (40), overflow, empty, narrowing, and NaN-cap behavior, and parity of the inline base2 copy, but never tests the symlink-marker acceptance path — the docblock's claim that symlink markers cover 'safe in-project symlinks' is untestable from the current tests because no test supplies a symlink marker at all, let alone a malicious target.
- **Fix:** Add a test that a markerFor returning 'symlink-sha256:...' for a path whose link target escapes the project yields status 'empty' (or a dedicated rejection) once the in-project assertion from the security finding lands.
- **Evidence:** gate-fingerprint-parity.test.ts:113 'hashGateSnapshotDetails fail-closed parity without crypto (no FNV fallback)'; no equivalent negative test exists for gate-committed-surface.

## [LOW] dependency-hygiene — agents/reviewer/code-reviewer.ts:255 — code-reviewer hard-pins anthropic/claude-opus-4.7 with no model override or fallback
- **Risk:** The final gate reviewer is bound to a single provider/model string with no override, fallback chain, or pinned-fallback on provider outage; every gate cycle depends on that one model's availability and pricing. Other bundled agents vary the model by role (test-writer/doc-writer on flash-lite), so the pattern is configurable elsewhere — here it is a hardcoded literal in source.
- **Fix:** Lift the model into a config surface (option/env with the current value as default) and define a fallback model for the transient-crash retry path so a single-provider outage degrades instead of stalling the gate.
- **Evidence:** const definition: SecretAgentDefinition = { id: 'code-reviewer', publisher, ...createReviewer('anthropic/claude-opus-4.7') } — model is a positional constant, not a configuration surface.

## [LOW] correctness — common/src/agents/specialist-risk-router.ts:83 — Keyword/stem router over-triggers specialists (state.ts → reliability-reviewer, 'regression' → performance-specialist) with no fan-out cost cap
- **Risk:** selectSpecialistReviewers fires reliability-reviewer for any file whose basename stem is state/job/stream/session/lock/etc. (a session.test.ts edit routes reliability) and performance-specialist for requirements containing 'regression' (regress\w*). With nine specialist families and no concurrent-fan-out cap, common wording in requirements spawns many expensive reviews for low-signal changes — cost and false-positive noise in the gate's reviewer round. Recall bias is intentional (a router should not miss), but there is no precision control or budget on the other side.
- **Fix:** Route reliability/performance specialists on diff content (changed symbols, concurrency primitives touched) rather than filename stems; require co-occurrence of a code change with the keyword; add an explicit fan-out cap with deterministic priority when more than N families fire.
- **Evidence:** if (/\b(?:race|concurr\w*|...|regress\w*|...)\b/.test(requirements) || files.some(isReliabilityCodePath)) selected.add('reliability-reviewer') — stem set includes 'state', 'job', 'session', 'stream'; performance regex includes /regress\w*/.

## Coverage receipt

### Subsystems
- base2-gate
- reviewer-agents
- common-util-gate-telemetry
- common-util-gate-repair-budgets
- common-util-audit-receipt
- common-types-harness-control-plane
- common-types-workspace-state
- common-agents-specialist-risk-router
- base2-quality-prompt-section
- gate-helper-generation
- gate-test-suite

### Features
- validation-gate
- reviewer-attestation
- reviewer-fingerprint
- repair-flow
- repair-budgets
- no-verdict-retries
- plan-task-gate-receipts
- committed-surface-review
- reviewer-bypass-challenge
- condoned-findings
- gate-telemetry-sink
- structural-audit-receipt
- specialist-risk-routing
- reviewer-output-schema
- gate-awareness-prompt
- workspace-journal-state
- harness-optimistic-concurrency
- gate-helper-generation-parity

### Files
- agents/base2/gate-reviewer.ts
- agents/base2/gate-repair.ts
- agents/base2/gate-paths.ts
- agents/base2/gate-fingerprint.ts
- agents/base2/gate-committed-surface.ts
- agents/base2/gate-concurrency.ts
- agents/base2/gate-state.ts
- agents/base2/quality-prompt-section.ts
- agents/base2/specialist-risk-router.ts
- agents/reviewer/code-reviewer.ts
- common/src/agents/specialist-risk-router.ts
- common/src/util/gate-telemetry.ts
- common/src/util/gate-repair-budgets.ts
- common/src/util/audit-receipt.ts
- common/src/types/harness-control-plane.ts
- common/src/types/workspace-state.ts
- agents/__tests__/gate-reviewer.test.ts
- agents/__tests__/gate-repair.test.ts
- agents/__tests__/gate-committed-surface.test.ts
- agents/__tests__/gate-helpers-freshness.test.ts
- common/src/util/__tests__/gate-telemetry.test.ts
- common/src/util/__tests__/gate-repair-budgets.test.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
