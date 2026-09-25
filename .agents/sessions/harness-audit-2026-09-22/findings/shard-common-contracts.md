# Audit findings: shard-common-contracts

- Subsystems: common
- Features: param-coercion-and-repair, cap-v3-based-on-read-contract, edit-transaction-schema, tool-registry-list, tool-metadata-registry, session-state-schema, error-or-utilities, message-conversion-boundary, sensitive-path-policy, plan-artifact-store
- Files covered: 10
- Snapshot: a0de6357ff5254c1bb8cf2e92d821fd948811744293fe3361209c5d557e95392

## [HIGH] performance — common/src/tools/params/utils.ts:195 — tryRecoverTruncatedToolArguments rescans the full prefix per closer candidate: O(n^2) CPU on up to 256KB model-controlled tool arguments
- **Risk:** The outer loop walks every byte from the end (line 195) and for each '}' or ']' candidate rebuilds the container stack with a full rescan of rawInput.slice(0, pos+1) (lines 200-218) plus a JSON.parse of the candidate. With MAX_TRUNCATION_SCAN_LENGTH = 256000 and a truncated payload containing tens of thousands of closers (many complete nested arrays inside one unclosed outer container), total work reaches ~10^10 character operations on the tool-call parse hot path, stalling the agent loop for minutes. This is a CPU DoS reachable via ordinary model output.
- **Fix:** Make recovery single-pass: scan once forward recording an open-container stack snapshot (or stack height plus parent link) at each closer position, then walk recorded boundaries latest-to-earliest without rescanning. Add a hard work budget (candidate count and total bytes rescanned) that returns undefined when exceeded so worst case stays O(n).
- **Evidence:** for (let pos = rawInput.length - 1; pos >= 0; pos--) {     const closingChar = rawInput[pos]     if (closingChar !== '}' && closingChar !== ']') { continue }     const prefix = rawInput.slice(0, pos + 1)     // full rescan per candidate:     for (let i = 0; i < prefix.length; i++) { ... openStack.push/pop ... }     ... JSON.parse(candidate) ... } Bounds: MAX_TRUNCATION_SCAN_LENGTH = MAX_REPAIRABLE_JSON_LENGTH = 256_000; no cap on candidate count or rescan budget.

## [MEDIUM] performance — common/src/tools/params/utils.ts:65 — repairMalformedJsonSeparators bounds the scan by trimmed length but iterates the untrimmed input
- **Risk:** The guard rejects only when trimmed.length > MAX_TRUNCATION_SCAN_LENGTH (256000) while the repair loop iterates input.length and appends every char to output (lines 74-105). A tiny JSON body padded with tens of megabytes of whitespace passes the guard and forces a full-length scan plus a large string build. parseJsonStringWithRepair runs this on every failed JSON.parse in argument coercion, so repeated whitespace-padded arguments amplify CPU and allocation; the intended 256KB CPU bound is trivially bypassed.
- **Fix:** Bound input.length (or scan only the trimmed slice after skipping leading/trailing whitespace) and return undefined when the raw input exceeds the constant. Use the trimmed slice for both the guard and the loop.
- **Evidence:** const trimmed = input.trim() if (   trimmed.length === 0 ||   trimmed.length > MAX_TRUNCATION_SCAN_LENGTH ||   !(...) ) { return undefined } ... for (let index = 0; index < input.length; index++) {   const char = input[index]   ... output += char ... }

## [LOW] correctness — common/src/tools/params/utils.ts:142 — Truncation scan conflates '}' and ']' and openStack.pop ignores closer type, misclassifying malformed JSON as transport truncation
- **Risk:** scanTruncationState decrements depth for either closer (line 142) and tryRecoverTruncatedToolArguments pops the stack for either closer (line 217) without matching types. A genuinely malformed payload with mismatched braces (e.g. {"a": [1}) reports residual depth > 0, so detectTransportTruncation returns true and the tool reports payload_truncated instead of a syntax error, and recovery may propose prefixes that are not valid cuts. Models then apply transport-recovery guidance to a syntax bug.
- **Fix:** Track a typed container stack in scanTruncationState (return undefined on mismatched closer) and validate closer/stack-top equality in the recovery rescan, so only well-nested but unbalanced inputs are treated as truncation.
- **Evidence:** } else {       if (ch === '"') inString = true       else if (ch === '{' || ch === '[') depth++       else if (ch === '}' || ch === ']') depth--   // either closer, no type match       if (depth < 0) return undefined     } and in the recovery rescan:       else if (c === '}') openStack.push...        else if (c === '}' || c === ']') openStack.pop()   // pops regardless of type

## [LOW] correctness — common/src/tools/params/utils.ts:357 — repairCommaSplitFragments silently rewrites legitimate string arrays of JSON-shaped fragments
- **Risk:** When all elements are strings, the rejoined string is re-parsed and returned as data if it parses as an array (lines 353-359): ['[', '1,2', ']'] becomes the number array [1,2]. ['[]', '[]'] falls to the collapse branch (lines 367-383) and becomes the single string '[],[]', which then fails schema validation with a misleading error. Shared coercion primitives (coerceToArray, normalizeSpawnAgentList) therefore mutate well-formed model input instead of only repairing transport artifacts.
- **Fix:** Accept the repair only when every fragment fails standalone parse AND the rejoined parse yields an array consistent with comma-splitting (e.g. re-serializing and re-splitting reproduces the fragment count); otherwise return the original array unchanged.
- **Evidence:** const rejoined = value.join(',') ... const reparsed = parseJsonBounded(rejoined) if (Array.isArray(reparsed)) {   return reparsed   // ['[','1,2',']'] -> [1,2] } ... if (!hasStandaloneObject) {   return rejoined   // ['[]','[]'] -> '[],[]' (then Zod fails on a string) }

## [LOW] security — common/src/tools/params/utils.ts:813 — $getToolCallString spreads input after the reserved tool-name key, letting input override generated tool identity
- **Risk:** const obj = { [toolNameParam]: toolName, ...input } places the spread last, so an input object carrying the reserved toolNameParam/endsAgentStepParam keys silently overrides the tool name and step-termination flag in the model-facing tool-call string. If model-influenced input ever reaches this helper, a prompt-injected key can mint a tool-call string for a different tool or force/forbid endsAgentStep.
- **Fix:** Build the object as { ...input, [toolNameParam]: toolName } and set endsAgentStepParam last, or strip reserved keys from input before spreading.
- **Evidence:** const obj: Record<string, any> = {     [toolNameParam]: toolName,     ...input,   }   if (endsAgentStep) {     obj[endsAgentStepParam] = endsAgentStep satisfies true   }

## [LOW] security — common/src/tools/params/utils.ts:565 — Snapshot-id recovery scans prompt prose and prefers the last match, letting trailing injected text win
- **Risk:** normalizeSpawnAgentList extracts snapshot_id with a regex over record.prompt and takes matches.at(-1) (lines 557-565). Prompt text is user/model influenced, so trailing prose can append a competing 'Snapshot: v3:<64 hex>' line that overrides the labelled token earlier in the instruction. Downstream fingerprint verification limits authority, but recovery biases toward attacker-supplied text and can steer which review bundle a snapshot-scoped specialist is pointed at.
- **Fix:** Take the first explicitly labelled match (or require the token in a structured field), keep the existing downstream fingerprint verification as the authority gate, or drop prose recovery entirely.
- **Evidence:** const matches = [   ...record.prompt.matchAll(/\b(?:Snapshot(?: ID| fingerprint)?...|snapshot_id)\s*:\s*`?([A-Za-z0-9][A-Za-z0-9._:-]{0,511})`?/gi), ] const explicitSnapshot = matches.at(-1)?.[1] if (typeof explicitSnapshot === 'string' && /^v3:[a-f0-9]{64}$/.test(explicitSnapshot)) {   paramsRecord.snapshot_id = explicitSnapshot

## [LOW] correctness — common/src/tools/params/tool/edit-transaction.ts:169 — Non-strict edit variants silently strip contradicting fields (e.g. a delete edit carrying full content)
- **Risk:** createFileEditSchema, deleteFileEditSchema, moveFileEditSchema and strReplaceEditSchema are plain z.object extensions (lines 82-180) that strip unknown keys, while replaceRangeEditSchema is .strict(). A model sending { type: 'delete', path, content: '<intended bytes>' } validates and deletes the file while the content is discarded with no diagnostic: an intent/behavior divergence in the canonical mutation surface. Misspelled fields (destinationpath) are likewise dropped silently for these variants but rejected for replace_range.
- **Fix:** Make every transaction edit variant .strict() (as replace_range already is), or add a superRefine rejecting fields that contradict the discriminator (content on delete, destinationPath on create, etc.) with a targeted message.
- **Evidence:** const deleteFileEditSchema = editBaseSchema.extend({   type: z.literal('delete'), })   // no .strict(); a sibling `content` key is silently stripped const replaceRangeEditSchema = editBaseSchema   .extend({ ... })   .strict()   // inconsistent strictness across the same discriminated union

## [MEDIUM] api-contract — common/src/tools/params/tool/edit-transaction.ts:311 — Provider-facing edit schemas diverge from runtime enforcement: advertised contract accepts payloads the input schema rejects
- **Risk:** canonicalReplaceRangeEditSchema and canonicalReplacementSchema (approx lines 283-335) are hand-duplicated from the runtime schemas but omit the cap.v3 readCapability decode check, occurrence vs startLine/endLine mutual exclusion, capability-range containment, and isObviousEditPlaceholder rejection; providerInputSchema bounds also skip the unique-path and input-byte limits. The LLM-facing contract therefore documents combinations the runtime fails, producing late validation errors and retry loops, and the two surfaces can silently drift further.
- **Fix:** Derive both surfaces from one schema (superRefine stripped only for JSON-schema generation) or add a contract test asserting every payload accepted by providerInputSchema is either accepted by inputSchema or listed in an explicit documented delta.
- **Evidence:** const canonicalReplaceRangeEditSchema = editBaseSchema.extend({   type: z.literal('replace_range'),   readCapability: z.string().min(1),   // no decodeReadCapabilityToken / tokenVersion check   startLine: z.number().int().min(1).optional(),   endLine: z.number().int().min(1).optional(),   occurrence: ...optional(),           // no mutual-exclusion or containment superRefine   newContent: z.string(),              // no isObviousEditPlaceholder refine }) vs replaceRangeEditSchema.superRefine which enforces all of the above.

## [LOW] dependency-hygiene — common/src/tools/list.ts:322 — clientToolNames is derived from unstable Zod internals (.def.options / shape.toolName.value)
- **Risk:** The exported client-tool name list reads clientToolCallSchema.def.options and opt.shape.toolName.value (lines 322-324), which are not stable public Zod API. A Zod minor upgrade can break the common package build or, worse, silently change the derived tool-name set used for client forwarding and registry checks.
- **Fix:** Export a literal CLIENT_TOOL_NAMES tuple as the single source of truth and build the discriminated union from it, so names survive Zod upgrades and can be diffed in review.
- **Evidence:** export const clientToolNames = clientToolCallSchema.def.options.map(   (opt) => opt.shape.toolName.value, ) satisfies ToolName[]

## [LOW] correctness — common/src/tools/list.ts:345 — ProcessJobClientToolCall is an unchecked forward-boundary escape hatch over the client-tool union
- **Risk:** The type (and the documented 'cast to ClientToolCall<T> at the forward boundary' pattern) replaces compile-time checking of check_job/kill_job/read_logs inputs with an unchecked assertion; malformed job inputs or a drifted owner shape surface only at SDK runtime ownership assertion, after the call has crossed the wire contract.
- **Fix:** Provide a narrow runtime schema (jobInputSchema.and(ownerSchema)) and a typed forward helper that parses before casting, so the three process-job tools validate input at the boundary like every other client tool.
- **Evidence:** export type ProcessJobClientToolCall<T extends ClientToolName> = {   toolName: T   toolCallId: string   input: Record<string, unknown> & { owner: RuntimeJobOwner } } // comment: "the handler builds that shape and casts to `ClientToolCall<T>` at the forward boundary"

## [LOW] api-contract — common/src/tools/metadata.ts:159 — metadataFor derives scheduling from kind first, making NAMED_PATH_TOOLS entries for read tools dead configuration
- **Risk:** scheduling is computed as kind === 'read' ? 'read_only' : NAMED_PATH_TOOLS.has(...) (lines 158-164), so the read-kind entries 'inspect_3d_asset' and 'render_3d_preview' in NAMED_PATH_TOOLS (lines 105-106) never take effect. Consumers of toolMetadata see 'read_only' while the registry suggests path-scoped scheduling; anyone adding a read tool that needs path-scoped scheduling silently gets global read_only.
- **Fix:** Compute scheduling from NAMED_PATH_TOOLS independently of kind (read tools may still be path-scoped), or delete the dead entries and document that read tools are always read_only.
- **Evidence:** const NAMED_PATH_TOOLS = new Set<ToolName>([   ...,'inspect_3d_asset', 'render_3d_preview',   // both are in READ_TOOLS ]) ... scheduling:   kind === 'read'     ? 'read_only'     : NAMED_PATH_TOOLS.has(toolName)       ? 'named_path'       : 'global',

## [LOW] api-contract — common/src/tools/metadata.ts:130 — PATH_INPUTS declares non-path scalars (sessionSlug, shardId) as path inputs for write_audit_findings
- **Risk:** The write_audit_findings entry lists 'sessionSlug' and 'shardId' (line 130) although neither is a filesystem path. Combined with 'named_path' scheduling and path-input-driven containment/lease tooling, these tokens can be resolved or scoped as workspace paths, mis-scoping write-conflict detection (the real sink is .agents/sessions/<slug>/findings/<shardId>.md).
- **Fix:** Represent the derived artifact path explicitly (e.g. 'derived:.agents/sessions/<sessionSlug>/findings/<shardId>.md') or give the tool an empty pathInputs with a dedicated artifactSink descriptor consumed by scheduling.
- **Evidence:** const PATH_INPUTS: Partial<Record<ToolName, readonly string[]>> = {   ...   write_file: ['path'],   write_audit_findings: ['sessionSlug', 'shardId'],   // slugs, not paths }

## [HIGH] security — common/src/types/session-state.ts:367 — Security-critical read-authorization and capability registries have no runtime schema; forged session state can grant edit authority without reads
- **Risk:** readAuthorizationsByPath, readAuthorizationHashesByPath and confirmedPostEditAnchorsByPath (lines 352-385) are plain TS fields on the unversioned AgentState type. This contract module ships runtime schemas for toolCallSchema/subgoalSchema/AgentOutputSchema but none for AgentState/SessionState. Any restore path that JSON.parses persisted session state and casts (the repeated 'optional so old sessions parse cleanly' comments imply exactly such loading) will honor attacker- or corruption-supplied authorization maps, granting sticky read-before-edit authority and remintable post-edit capabilities for files that were never read (authz bypass / capability forgery). The loader itself is outside this shard and must be verified.
- **Fix:** Export a Zod schema for the authorization/capability maps (and AgentState), validate every persisted session at load, and re-verify each readAuthorizationHashesByPath hash against current file content and each ConfirmedPostEditAnchor token signature before honoring entries.
- **Evidence:** export type AgentState = {   ...   readAuthorizationsByPath?: Record<string, true>   readAuthorizationHashesByPath?: Record<string, string>   confirmedPostEditAnchorsByPath?: Record<string, ConfirmedPostEditAnchor>   ... } // Only runtime schemas in the file: toolCallSchema, subgoalSchema, AgentOutputSchema. // No AgentState/SessionState schema; hash map comment: "an entry is authoritative only when this map contains the hash..."

## [MEDIUM] state-mutation — common/src/types/session-state.ts:413 — backgroundAgentJobs has no documented cap or pruning; AgentState grows without bound across spawns
- **Risk:** The backgroundAgentJobs array (lines 412-423) is append-oriented (one entry per spawned job plus optional receipt) and, unlike compactionArchive/contextConsolidations whose comments state explicit caps, no bound is declared here. Long sessions that spawn many subagents serialize an ever-growing AgentState into every checkpoint/restore, causing unbounded memory and checkpoint-size growth.
- **Fix:** Declare and enforce a cap (e.g. keep in-flight jobs plus the last N terminal receipts, moving older receipts to the capped archive) and document the eviction contract the way compactionArchive does.
- **Evidence:** backgroundAgentJobs?: Array<{     jobId: string     agentType: string     status: 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted'     startedAt: number     completedAt?: number     error?: string     childRunId?: string     receipt?: AgentReceipt   }> // contrast compactionArchive: "the runtime caps snapshot count and size" - no such note here

## [MEDIUM] api-contract — common/src/types/session-state.ts:282 — AgentState/SessionState have no schemaVersion despite continuous optional-field growth and persistence
- **Risk:** AgentState (lines 282-508) accumulates versioned inner records (MemoryRuntimeStateV2, WorkspaceStateV1) next to unversioned plain maps, with many fields justified only as 'optional so old sessions parse cleanly'. Without a top-level schemaVersion and migration entrypoint, consumers cannot distinguish old vs new persisted shapes, cannot migrate safely, and read-time default choices silently change behavior (e.g. readAuthorizationsByPath presence semantics).
- **Fix:** Add schemaVersion to AgentState/SessionState plus a migrateSessionState(from -> current) function colocated with getInitialAgentState, and reject or flag unknown future versions instead of passing them through.
- **Evidence:** export type AgentState = {   /** @deprecated agentId is replaced by runId */   agentId: string   ...   readAuthorizationsByPath?: Record<string, true>   // "Optional so old sessions parse cleanly"-style comments recur } export type SessionState = {   fileContext: ProjectFileContext   mainAgentState: AgentState }   // no schemaVersion field anywhere

## [MEDIUM] security — common/src/util/sensitive-paths.ts:8 — Mandatory sensitive denylist omits common plaintext credential carriers (.git-credentials, .pgpass, .s3cfg, ...)
- **Risk:** SENSITIVE_BASENAMES/SENSITIVE_EXTENSIONS (lines 3-27) miss at least .git-credentials (plaintext Git host tokens), .pgpass (Postgres passwords), .my.cnf (client passwords), .s3cfg and .boto (AWS secret keys), .hgrc, and bare 'netrc'. isMandatorySensitiveReadPath therefore returns false for these files and they can be indexed and read into model context, leaking long-lived credentials in a BYOK harness where model output is the exfiltration channel.
- **Fix:** Add the missing basenames (at minimum .git-credentials, .pgpass, .my.cnf, .s3cfg, .boto, .hgrc, netrc, .pg_service.conf) and pair the denylist with an entropy/token-pattern scrub as a second gate so enumeration gaps cannot fully bypass the policy.
- **Evidence:** const SENSITIVE_BASENAMES = new Set([   '.htpasswd', '.netrc', 'credentials', 'credentials.json', 'credentials.yaml',   'credentials.yml', '.npmrc', 'auth.json', '.pypirc', 'terraform.tfvars', '.terraformrc', ]) // no .git-credentials / .pgpass / .my.cnf / .s3cfg / .boto / .hgrc / netrc entries

## [MEDIUM] security — common/src/util/sensitive-paths.ts:33 — toPortablePath normalizes only path.sep; POSIX leaves backslash paths unnormalized while sibling policy normalizes unconditionally
- **Risk:** toPortablePath splits on path.sep (line 33), so on POSIX a mixed/backslash path (e.g. 'x\.env') is classified with a whole-string basename and misses the '.env' rule and the exact-basename rules, while common/src/util/plan-artifacts.ts normalizePlanPath converts backslash to slash on every platform. Any call site that normalizes separators after classification (or feeds normalized paths to fs while classifying raw ones) turns this disagreement into a sensitive-file policy bypass (e.g. 'x\.env' classified benign, resolved as x/.env).
- **Fix:** Normalize backslashes to forward slashes unconditionally in toPortablePath (share one normalizer with plan-artifacts) and add cross-separator test cases to the sensitive-paths tests.
- **Evidence:** function toPortablePath(value: string): string {   return value.split(path.sep).join('/').replace(/^\.\//, '') } // plan-artifacts.ts: export function normalizePlanPath(p: string): string { return p.replace(/\\/g, '/') } // isMandatorySensitiveReadPath('.env' rule) tests basename === '.env' which 'x\.env' fails on POSIX

## [MEDIUM] security — common/src/util/plan-artifacts.ts:115 — Artifact path validators accept '.' (and '..' via isSessionPlanPath) as session slugs, escaping the .agents/sessions/<slug>/ jail
- **Risk:** ALLOWED_SESSION_ARTIFACT_RE/ALLOWED_UPDATE_ARTIFACT_RE capture the slug as [A-Za-z0-9._-]+ (lines 115, 119) which admits '.', and SESSION_PLAN_RE uses [^/]+ (line 122) which admits '..'. hasTraversalSegment only rejects '..' segments (line 138) and neither validator calls isValidPlanSlug (which does reject '.' and '..'). '.agents/sessions/./SPEC.md' therefore validates but resolves to '.agents/SPEC.md', and '.agents/sessions/../PLAN.md' counts as a session plan path resolving to '.agents/PLAN.md': create_plan/update_plan_status can write outside the per-session directory they claim to jail (path containment bypass).
- **Fix:** Validate the captured slug with isValidPlanSlug in both validators and in getSessionDirForArtifact/isSessionPlanPath (reject '.', '..' and dot-only slugs), and add regression tests for '.agents/sessions/./SPEC.md' and '.agents/sessions/../PLAN.md'.
- **Evidence:** const ALLOWED_SESSION_ARTIFACT_RE =   /^(?:\.\/)?\.agents\/sessions\/([A-Za-z0-9._-]+)\/(SPEC|PLAN|STATUS|LESSONS)\.md$/ const SESSION_PLAN_RE = /(?:^|\/)\.agents\/sessions\/([^/]+)\/PLAN\.md$/i function hasTraversalSegment(p: string): boolean {   return p.split('/').includes('..')   // '.' is not rejected } // isValidPlanSlug exists and rejects '.' / '..', but is never applied to the regex capture.

## [MEDIUM] state-mutation — common/src/util/plan-artifacts.ts:280 — STATE.json 'compare-and-swap revision' is never compared; read-modify-write loses concurrent updates
- **Risk:** writePlanState reads existing state and writes revision: (existing?.revision ?? 0) + 1 (lines 271-290) with no expectedRevision input and no lock around the read-modify-write; concurrent writers sharing a project root silently overwrite each other, and normalizePlanState resets invalid revisions to 0, so the documented 'Monotonic compare-and-swap revision' provides no protection and callers cannot implement CAS.
- **Fix:** Add expectedRevision to writePlanState and fail on mismatch with existing.revision (or take an exclusive lockfile/O_EXCL guard around the RMW), and never downgrade a parsed revision to 0: reject instead.
- **Evidence:** /** Monotonic compare-and-swap revision for deterministic state updates. */   revision: number ...   const existing = readPlanState(slug, projectRoot)   const next: PlanSessionState = {     ...     revision: (existing?.revision ?? 0) + 1,   ...   fs.writeFileSync(tempPath, ...)   fs.renameSync(tempPath, statePath)   // atomic replace, but RMW is unlocked

## [MEDIUM] state-mutation — common/src/util/plan-artifacts.ts:221 — Module-global projectRootResolver is only partially threaded; several API surfaces cannot take an explicit root
- **Risk:** projectRootResolver is mutable module-level state (lines 220-228) and its own docstring admits the concurrent-run race. readPlanState/writePlanState/appendPlanEvent accept a projectRoot override, but readPlanEvents, clearPlanState, readActiveSessionPointer, writeActiveSessionPointer and clearActiveSessionPointer use only the global, so two projects running in one process can read/write each other's .agents state depending on which resolver was set last (stale global race).
- **Fix:** Thread an explicit projectRoot (or a resolved context object) through every exported function, keep the global only as a deprecated fallback, and make setProjectRootResolver fail when called twice with different roots.
- **Evidence:** let projectRootResolver: () => string = () => {   throw new Error('Project root resolver not configured') } export function setProjectRootResolver(fn: () => string): void {   projectRootResolver = fn } // writePlanState doc: "This avoids the concurrent-run race where `setProjectRootResolver` mutates a shared global." // but: export function readPlanEvents(slug: string, opts ...): PlanEvent[]  // no projectRoot param // and: clearPlanState(slug) -> resolveSessionDir(slug)   // global only

## [MEDIUM] performance — common/src/util/plan-artifacts.ts:545 — readPlanEvents fully reads and parses unbounded, never-rotated EVENTS.jsonl before applying limit
- **Risk:** readPlanEvents readFileSync's the entire EVENTS.jsonl and JSON.parses every line on each call; the log is append-only with no rotation or size cap in appendPlanEvent (which documents only PIPE_BUF ordering). Over a long session the timeline CLI pays O(total events) per invocation and holds the whole event list in memory just to return a limited slice: unbounded memory growth plus serial full-file I/O.
- **Fix:** Tail-read only the last N lines needed for opts.limit (or maintain a size-capped/rotated log with an index) and enforce a max file size in appendPlanEvent.
- **Evidence:** const eventsPath = path.join(sessionDir, EVENTS_FILENAME) if (!fs.existsSync(eventsPath)) return [] let raw: string try {   raw = fs.readFileSync(eventsPath, 'utf8')   // whole unbounded log ... const lines = raw.split('\n') for (const line of lines) { ... JSON.parse(trimmed) ... } // appendPlanEvent: fs.appendFileSync(eventsPath, line, 'utf8')  // no cap/rotation

## [LOW] correctness — common/src/util/plan-artifacts.ts:558 — readPlanEvents limit returns the oldest N events, not the most recent
- **Risk:** events.slice(0, opts.limit) takes the first N records in file order (oldest first) while the option doc promises 'most recent last'; callers asking for recent activity (plan timeline) silently get the earliest events once the log exceeds the limit: an off-by-semantics bug that appears only after enough history accumulates.
- **Fix:** Return events.slice(-opts.limit) for the recent window (documenting order), or add an explicit oldest|newest option and test both.
- **Evidence:** type ReadPlanEventsOptions = {   /** Filter to a single event kind. */   kind?: PlanEventKind   /** Return at most `limit` events (most recent last when reading in order). */   limit?: number } ... if (opts.limit !== undefined && opts.limit >= 0) {   return events.slice(0, opts.limit)   // oldest N, not most recent N }

## [LOW] correctness — common/src/util/plan-artifacts.ts:845 — preflightPlan does not detect dependency cycles or self-dependencies; unexecutable plans pass with ok:true
- **Risk:** Dependency validation only checks ID format and membership. A pending task that depends on itself (ids.has passes) or a cycle among pending tasks passes preflight with errors: [] and nextTaskId: null, so execute-plan mode accepts a plan it can never advance and reports no diagnostic: the deterministic execution contract breaks for exactly the plans that need guidance.
- **Fix:** Run a cycle/self-edge check over pending-task dependency edges and emit a [dependency-cycle] error naming the participating IDs before returning ok.
- **Evidence:** for (const task of tasks) {     for (const dependency of task.dependencies) {       if (!TASK_ID_RE.test(dependency)) { errors.push(...) }       else if (!ids.has(dependency)) { errors.push(...) }       // no self-edge or cycle check     } ... const actionable = tasks.find((task) => ... task.dependencies.every((dependency) => done.has(dependency))) return { ok: errors.length === 0, ..., nextTaskId: actionable?.id ?? null, ... }

## [LOW] correctness — common/src/util/plan-artifacts.ts:770 — Plan task field matcher ignores indentation and task scope, attributing unrelated bullets to the previous task
- **Risk:** The 'Depends on|Acceptance|Validate' matcher runs on line.trim() with no indent requirement and `current` persists until the next checkbox line (parsePlanTaskDetails), so a '- Validate: ...' bullet in a later non-checklist section silently attaches to the last parsed task and flips hasValidationGate/hasAcceptanceCriteria. The documented 'indented execution contract' is unenforced and preflight warnings/nextTaskId depend on incidental layout.
- **Fix:** Require the documented indentation (field indent > task indent) and reset `current` at any heading or same/lower-indentation line.
- **Evidence:** if (!current) continue const field = line   .trim()   // indentation erased, so any nesting level matches   .match(     /^[-*]\s*(?:\*\*)?(Depends on|Acceptance|Validate)(?:\*\*)?\s*:\s*(.*)$/i,   ) if (!field) continue

## [MEDIUM] error-handling — common/src/util/error.ts:175 — isAbortError message-prefix sniffing misclassifies unrelated failures as user aborts
- **Risk:** isAbortError treats any Error whose message is 'Request aborted' or starts with 'Request aborted: ' as an abort. Third-party or transport errors with that wording are propagated as silent user cancellation: callers skip error reporting, retries and fallbacks, and a genuine failure disappears as a user abort (incorrect error propagation).
- **Fix:** Detect aborts by brand instead: AbortError class instance, DOMException name === 'AbortError', or the owning AbortSignal.aborted flag; drop the message-prefix check and keep the name check for native AbortError.
- **Evidence:** export function isAbortError(error: unknown): boolean {   if (!(error instanceof Error)) { return false }   if (     error.message === ABORT_ERROR_MESSAGE ||     error.message.startsWith(`${ABORT_ERROR_MESSAGE}: `)   // message sniffing   ) {     return true   }   if (error.name === 'AbortError') { return true }

## [MEDIUM] security — common/src/util/error.ts:78 — ErrorObject captures API request bodies and response bodies into every failure record
- **Risk:** requestBodyValues (line 78) and responseBody (line 72) are populated from AI SDK APICallError via safeStringify up to 10000 chars each in getErrorObject. Request body values include system prompts, user content and tool output (and can include provider options), which then flow through Failure envelopes into logs, telemetry and model-visible error surfaces: a credential/PII leakage channel in a local-first BYOK harness. Only rawError is gated behind includeRawError.
- **Fix:** Redact or allowlist keys for requestBodyValues/responseBody (status/code/message only), cap them well below 10KB, and gate both fields behind the same includeRawError opt-in.
- **Evidence:** export type ErrorObject = {   ...   /** Response body from API errors (AI SDK APICallError) */   responseBody?: string   ...   /** Request body values that were sent (API errors) - stringified for safety */   requestBodyValues?: string ... if (extError.requestBodyValues !== undefined && typeof extError.requestBodyValues === 'object') {   requestBodyValues = safeStringify(extError.requestBodyValues)   // default maxLength 10000, always on }

## [LOW] correctness — common/src/util/error.ts:455 — safeStringify marks visited objects but never un-marks, mislabeling shared (non-circular) references as [Circular]
- **Risk:** The JSON.stringify replacer adds every object to a WeakSet and returns '[Circular]' on any repeat visit (lines 450-458) without removing after subtree serialization, so a DAG with legitimately shared nodes (e.g. two errors sharing a cause) serializes the second occurrence as '[Circular]', corrupting diagnostic payloads and hiding real structure in logged error objects.
- **Fix:** Track the active recursion path instead of a global visited set (add before children, delete after), the pattern already used by sanitizeJsonToolResultValue in util/messages.ts.
- **Evidence:** const seen = new WeakSet() const str = JSON.stringify(   value,   (_, val) => {     if (typeof val === 'object' && val !== null) {       if (seen.has(val)) return '[Circular]'       seen.add(val)   // never deleted, so siblings are mislabeled     }     return val   },   2, )

## [MEDIUM] performance — common/src/util/messages.ts:126 — convertCbToModelMessages deep-clones and re-validates the entire message history on every request
- **Risk:** Every conversion pass structuredClones each message (assistantToCodebuffMessage line 126, convertToolResultMessage lines 133-169 including media base64 blobs, convertToolMessage user path) and then validateModelMessages safeParses every message again. With image tool results and long histories this is repeated multi-MB allocation plus full schema validation per turn on the request hot path: O(history) garbage and CPU per provider request.
- **Fix:** Convert with shallow wrappers (copy-on-write only for messages receiving cache-control or repair) and validate each message once when created rather than on every request.
- **Evidence:** return structuredClone({ ...message, content: [message.content] })   // assistantToCodebuffMessage ... return structuredClone<UserMessage>({         ...message,         role: 'user',         content: [{ type: 'file', data: c.data, mediaType: c.mediaType }],   // full base64 clone       }) ... const result = modelMessageSchema.safeParse(message)   // per message, per request

## [MEDIUM] correctness — common/src/util/messages.ts:154 — convertToolResultMessage spreads the whole message into each tool-result part, contaminating parts and duplicating payloads
- **Risk:** Synthesized parts are built as { ...message, output, type: 'tool-result' } (lines 139, 154), so every part carries role, content (the full parts array) and all auxiliary fields; for a tool message with k content parts the payload is duplicated k times (O(k^2) memory) and media results copy the base64 data again. The contamination passes only because modelMessageSchema strips unknown keys; a stricter provider schema or a consumer reading part.content/role sees garbage.
- **Fix:** Construct parts from explicit fields ({ toolCallId, output: {...}, type: 'tool-result' }) and keep message-level fields only on the outer message.
- **Evidence:** return message.content.map((c) => {     if (c.type === 'json') {       return structuredClone<ToolModelMessage>({         ...message,         role: 'tool',         content: [           {             ...message,   // role/content/toolCallId all leak into the part             output: { ...c, value: sanitizeJsonToolResultValue(c.value) },             type: 'tool-result',           },         ],       })

## [LOW] error-handling — common/src/util/messages.ts:250 — Orphan tool results and their assistant tool-calls are silently deleted from history with only debug/warn logs
- **Risk:** filterOrphanModelToolMessages drops tool results that are not immediately pairable (clearing pending ids on any intervening system/user message) and stripUnansweredToolCalls then deletes the matching assistant tool-call parts. A single interleaved system/user message between a tool call and its result permanently removes both the request and its completed output from the conversation sent to the model, with only logger.debug/logger.warn: completed tool work silently vanishes and the model may redo it.
- **Fix:** Track drops in session metrics surfaced to the user (count + tool names) and consider re-pairing across intervening messages before dropping; at minimum log at warn with the affected tool names in both directions.
- **Evidence:** if (droppedToolResultIds.length > 0) {     logger?.debug({ droppedToolResultCount: ..., droppedToolResultIds },       'Dropped orphan tool-result messages before model request.') } ... if (strippedToolCallIds.length > 0) {     logger?.warn({ strippedToolCallIds: ... },       'Stripped unanswered assistant tool calls before model request.') }

## [MEDIUM] test-coverage — common/src/tools/params/tool/edit-transaction.ts:405 — No dedicated tests pin edit-transaction schema invariants (dual surfaces, preserved issue codes, transaction bounds)
- **Risk:** The visible test surface covers params/utils (coerce-to-array, truncation-recovery), error, messages, sensitive-paths, plan-artifacts and tool reachability, but nothing pins edit-transaction's hand-duplicated provider/input schemas, the deliberately preserved too_small/too_big issue codes (documented as a compatibility contract for consumers branching on issue.code), placeholder rejection, or the three transaction bounds (count, unique paths, input bytes). A refactor can silently break the error-shape contract or the provider/runtime delta without failing CI.
- **Fix:** Add a schema test suite asserting issue codes/messages for empty/oversized transactions, unique-path and byte bounds, placeholder rejection, occurrence vs startLine exclusivity, and a providerInputSchema vs inputSchema acceptance-diff test.
- **Evidence:** // boundedTransactionEditListSchema comment:   // The empty/oversized list issues deliberately keep the `too_small`/`too_big` codes that chained   // bounds emitted, so consumers branching on `issue.code` keep matching. // referencedBy for common/src/tools/params/tool/edit-transaction.ts lists no test file; // only params/utils tests (coerce-to-array.test.ts, truncation-recovery.test.ts) touch the shared plumbing.

## Coverage receipt

### Subsystems
- common

### Features
- param-coercion-and-repair
- cap-v3-based-on-read-contract
- edit-transaction-schema
- tool-registry-list
- tool-metadata-registry
- session-state-schema
- error-or-utilities
- message-conversion-boundary
- sensitive-path-policy
- plan-artifact-store

### Files
- common/src/tools/params/utils.ts
- common/src/tools/params/based-on-read.ts
- common/src/tools/params/tool/edit-transaction.ts
- common/src/tools/list.ts
- common/src/tools/metadata.ts
- common/src/types/session-state.ts
- common/src/util/error.ts
- common/src/util/messages.ts
- common/src/util/sensitive-paths.ts
- common/src/util/plan-artifacts.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
