import type { TrackEventFn } from './analytics'
import type { ConsumeCreditsWithFallbackFn } from './billing'
import type {
  HandleStepsLogChunkFn,
  RequestFilesFn,
  RequestMcpToolDataFn,
  RequestOptionalFileFn,
  RequestToolCallFn,
  SendActionFn,
  SendSubagentChunkFn,
} from './client'
import type {
  AddAgentStepFn,
  DatabaseAgentCache,
  FetchAgentFromDatabaseFn,
  FinishAgentRunFn,
  GetUserInfoFromApiKeyFn,
  StartAgentRunFn,
} from './database'
import type { ClientEnv, CiEnv } from './env'
import type {
  PromptAiSdkFn,
  PromptAiSdkStreamFn,
  PromptAiSdkStructuredFn,
} from './llm'
import type { Logger } from './logger'
import type { CodebuffFileSystem } from '../filesystem'

/** Deterministic id generation (P2-T1). */
export interface IdGen {
  /** replaces crypto.randomUUID() */
  uuid(): string
  /** prefixed id, e.g. prefixedId('xml') -> 'xml-<uuid>' */
  prefixedId(prefix: string, separator?: string): string
}

/** Deterministic wall-clock (P2-T1). */
export interface Clock {
  /** replaces Date.now() for persisted state-timestamps */
  now(): number
}

/** One append-only run-journal event (P2-T2). JSON-serializable payload. */
export interface JournalEvent {
  eventType:
    | 'llm_request'
    | 'llm_response'
    | 'tool_call'
    | 'tool_result'
    | 'spawn'
    | 'step_boundary'
    | 'error'
  stepNumber: number
  correlation?: string | null
  payload: unknown
}

/** Append-only journal writer (P2-T2). Mints `seq` monotonically per runId. */
export interface JournalWriter {
  append(runId: string, event: JournalEvent): void
  /**
   * P2-T2 slice 4 (optional): drain any hot-path-batched events so every
   * event appended so far is durably committed. Optional so existing
   * implementors that flush per append are unaffected (a per-append writer
   * flushes eagerly and flush() is a no-op).
   */
  flush?(): Promise<void>
  /**
   * P2-T2 slice 4 (optional): flush any batched events, then close the
   * underlying storage. Optional so existing implementors that close
   * synchronously are unaffected (a sync writer closes eagerly and close()
   * is a no-op).
   */
  close?(): Promise<void>
  /**
   * P2-T2 slice-4 hardening (optional): force-drain any hot-path-batched
   * events so everything appended so far is durably committed. The
   * tool-execution path probes for it structurally (`typeof
   * writer.forceFlush === 'function'`) and calls it BEFORE a side-effecting
   * tool executes, so a batching writer's deferred tool_call completion
   * marker cannot lag the side effect (a kill-9 in that window would replay
   * the tool — double execution). Optional so existing implementors are
   * never broken by an added member: a per-append writer flushes eagerly and
   * has nothing buffered, so its drain is a no-op.
   */
  forceFlush?(): Promise<void>
}

/**
 * A journaled event row as a reader surfaces it: the event plus its gap-free
 * per-run sequence number, and OPTIONALLY the wall-clock timestamp (epoch
 * milliseconds) its storage recorded for it (the built-in sqlite journal
 * persists `created_at`). Optional so existing implementors that carry no
 * timestamp are never broken by an added member; consumers must treat an
 * absent createdAt as unknown, never as a synthetic ordering label.
 */
export type JournalEventRow = JournalEvent & {
  seq: number
  createdAt?: number
}

/**
 * Journal reader used for crash classification and replay (P2-T2).
 *
 * Optional non-contract extension (P2-T7 dash): an implementor MAY also
 * expose `runIds(): string[]` enumerating the DISTINCT runIds present in
 * the journal, NEWEST FIRST — ordered by each run's FIRST event
 * (MIN(created_at)), descending. MIN (not MAX) is the dash contract, the
 * same one the built-in sqlite journal (agent-runtime RunJournal /
 * CreatedRunJournal) documents and implements: a later append to an OLD
 * run must not promote it above runs whose first events are newer.
 * Consumers that must list runs (the `openbuff dash` provider) probe for it
 * structurally (`typeof reader.runIds === 'function'`) and surface no runs
 * when it is absent; it is deliberately NOT a required interface member so
 * existing implementors are never broken by an added one.
 */
export interface JournalReader {
  lastEvent(runId: string): JournalEventRow | undefined
  events(runId: string): JournalEventRow[]
  /** tool_result payload for a toolCallId, if journaled (replay short-circuit). */
  toolResultFor(runId: string, toolCallId: string): unknown | undefined
  /**
   * Deterministic replay short-circuit key (P2-T2-DESIGN §5: replay requires
   * reproducible ids). Matches the Nth (zero-based `occurrence`) journaled
   * `tool_call` whose payload carries this `toolName` and a structurally-equal
   * `input`, in gap-free `seq` order, and returns that attempt's completing
   * `tool_result` payload (or undefined when the call is journaled but its
   * result is not — an in-flight attempt the caller must re-execute under live
   * control). A fresh `toolCallId` minted by `idGen.uuid()` is NOT
   * reproducible across a process restart, so the short-circuit keys on the
   * journaled payload (toolName + input) instead: the programmatic loop
   * re-derives the same toolName/input on resume, and the caller consumes
   * occurrences in order (0, 1, ...) so the same tool called twice with an
   * identical input in one run resolves deterministically to distinct results.
   */
  toolResultForInput(
    runId: string,
    toolName: string,
    input: unknown,
    occurrence: number,
  ): unknown | undefined
}

/**
 * P2-T8: the request the parent hands to the supervised-spawn seam when the
 * `processSupervision` flag is on. JSON-serializable by design — the default
 * seam (packages/agent-runtime supervision/supervised-spawn.ts) persists it
 * to a temp file the child entrypoint reads from argv.
 */
export type SupervisedSpawnRequest = {
  agentType: string
  prompt: string | undefined
  spawnParams: Record<string, unknown> | undefined
  /**
   * Wall-clock deadline for the supervised child. Supervised spawns gain a
   * deadline in-process spawns do not have; the supervisor's 10-minute
   * default is preserved when omitted.
   */
  timeoutMs?: number
  /**
   * Serializable slice of the pre-allocated child AgentState. Must be
   * JSON-native: the default seam persists it via JSON.stringify and the
   * child rehydrates it with structural validation — a field that fails
   * validation (e.g. a Date timestamp coerced to an ISO string by the round
   * trip) is DROPPED child-side (the fresh initial-state default stands in)
   * instead of blindly cast to the live shape.
   */
  child?: {
    agentId: string
    messageHistory?: unknown
    systemPrompt?: string
    taskMemory?: unknown
    workspaceState?: unknown
    contextTokenCount?: number
  }
  fileContext?: unknown
  localAgentTemplates?: unknown
  userId?: string | undefined
  clientSessionId?: string
  userInputId?: string
  fingerprintId?: string
  ancestorRunIds?: string[]
  parentSystemPrompt?: string
  /**
   * P2-T8b: path of the parent-side RPC bridge's Unix socket INSIDE the spawn
   * sandbox (the 0700 mkdtemp dir). Present only when the parent seam started
   * a bridge server; the child then supplies the bridged callback deps over
   * newline-delimited JSON on that socket and runs the REAL agent loop. The
   * bridge has landed for the bridged dep set (promptAiSdkStream, promptAiSdk,
   * promptAiSdkStructured, sendAction, requestToolCall, requestFiles,
   * requestOptionalFile, requestMcpToolData, handleStepsLogChunk,
   * sendSubagentChunk, trackEvent, fetch, startAgentRun, finishAgentRun,
   * addAgentStep, fetchAgentFromDatabase, consumeCreditsWithFallback) — live
   * function values still never cross the temp-file transport itself; only
   * this serializable socket path does.
   *
   * Typed-dep-contract note (serialization repair): the wire is JSON, so
   * non-JSON-native param members cross as nonce-stamped wire markers
   * rehydrated parent-side — notably `addAgentStep`'s required
   * `startTime: Date`, which crosses as a `{ __openbuffBridge: 'date',
   * nonce, iso }` marker and is delivered to the parent's real dep as a
   * live `new Date(iso)` (never the `{}` a plain-object walk alone would
   * produce); see bridge-protocol.ts `createBridgeDateWireMarker`. Results
   * are validated ROUND-TRIP-SAFE fail-closed before crossing the wire:
   * `fetchAgentFromDatabase`'s AgentTemplate result is rejected with a
   * structured error naming any live `z.ZodSchema` / programmatic
   * `handleSteps` members rather than silently degraded
   * (bridge-protocol.ts `findNonRoundTripSafeResultPaths`). Absent ⇒ the child entrypoint still
   * returns the structured 'unsupported-deps' failed receipt instead of
   * half-running.
   *
   * Capability note: `requestFiles`' `capabilityIssuer`
   * ({ projectId, runId }) is JSON-serializable and crosses the bridge
   * VERBATIM, so the parent's real dep mints cap.v3 editAnchors (contentHash
   * + line range) for complete reads; the child's read_files handler then
   * re-mints that anchor with the CHILD's own in-process HMAC key — a cap.v3
   * token is verifiable only in the process that minted it, so
   * capability-bearing edits (str_replace / replace_range / rewrite_symbol /
   * edit_transaction) work in a flag-on supervised child without ever
   * replaying a parent-signed token across the wire.
   */
  rpcSocketPath?: string
  /**
   * P2-T8b (collision-proof bridge sentinel): the per-table bridge marker
   * nonce minted by `buildSupervisedBridgeHandlers` and stamped into the
   * request by the default supervised-spawn seam. The child sanitizer emits
   * nonce-stamped wire markers (`{ __openbuffBridge, nonce }`) and the parent
   * substitutes live Logger/AbortSignal values ONLY on an exact nonce match
   * — agent-authored params that happen to carry the `__openbuffBridge` key
   * cross the bridge verbatim. Absent ⇒ the child emits the legacy
   * content-only marker shape, which no parent recognizes (data-only).
   */
  rpcBridgeNonce?: string
}

/**
 * P2-T8: the settled result the supervised-spawn seam resolves with — the
 * structurally-identical transport outcome the supervisor's
 * `spawnSettledSubagent` produces. Declared structurally here so common (and
 * the seam contract) never depends on the agent-runtime package; the
 * supervisor module keeps its full concrete type and re-exports this one.
 */
export type SettledSubagentResult = {
  outcome:
    | 'ok'
    | 'missing_output'
    | 'schema_invalid'
    | 'truncated'
    | 'crashed'
  crashReason?: string
  /** A validated `AgentReceipt` envelope; present for ok/truncated. */
  receipt?: unknown
  schemaError?: string
  exitCode: number | null
  durationMs: number
  stdoutBytes: number
  killed: boolean
  stderrTail: string
}

/**
 * P2-T8c: opt-in, parent-decided restart policy for the supervised-spawn
 * seam (packages/agent-runtime supervision/supervised-spawn.ts, passed via
 * that builder's additive third `options` parameter). When supplied, a
 * RESTARTABLE crash — `outcome === 'crashed'` whose `crashReason` is a
 * transport-level failure ('spawn_failed', 'internal_error', or
 * 'nonzero_exit' WITHOUT a valid receipt envelope) — re-runs the WHOLE seam
 * (fresh mkdtemp sandbox, fresh bridge socket, fresh request file) after an
 * exponential backoff, at most `maxAttempts` times; the LAST settled result
 * is returned unchanged once the budget is exhausted. Everything else
 * settles as-is: `timeout` (the wall-clock deadline is authoritative —
 * restarting would double the budget), every non-crashed outcome
 * (ok / missing_output / schema_invalid / truncated), a free-form
 * `crashReason` (a deterministic input bug retrying cannot help), and
 * `nonzero_exit` WITH a receipt envelope (an agent-level failure, not a
 * transport crash — `result.receipt !== undefined`). Declared structurally
 * here, like {@link SettledSubagentResult}, so the contracts stay
 * dependency-free; agent-runtime re-exports the type.
 */
export interface SupervisedRestartPolicy {
  /**
   * REQUIRED, deliberately with NO default: the maximum number of RESTARTS
   * (not total spawns — `maxAttempts: 2` allows up to 3 spawns) permitted
   * after restartable crashes. Callers must opt into the bound explicitly so
   * no caller ever gets silent unbounded retries. Must be a finite number
   * >= 0; 0 makes the policy inert (a single spawn, zero restarts), and an
   * invalid value (missing/NaN/Infinity/negative) degrades to 0 — never to
   * unbounded retries.
   */
  maxAttempts: number
  /**
   * Base wall-clock delay (ms) before the FIRST restart; restart #N waits
   * `backoffMs * backoffMultiplier ** (N - 1)`. Default 250. A non-finite or
   * negative value clamps to the default; 0 is honored (no backoff wait).
   */
  backoffMs?: number
  /**
   * Exponential growth factor applied per restart. Default 2. A non-finite
   * or negative value clamps to the default.
   */
  backoffMultiplier?: number
  /**
   * P2-T8c: optional observability hook, invoked once per ACTUAL restart
   * (between the backoff sleep and the respawn — never for the initial
   * spawn) with the 1-based restart number (`1` = the first restart, i.e.
   * the second spawn) and the PREVIOUS attempt's `crashReason`.
   */
  onRestart?: (info: { attempt: number; crashReason: string }) => void
}

/** Shared dependencies */
export type AgentRuntimeDeps = {
  // Environment
  clientEnv: ClientEnv
  ciEnv: CiEnv

  // Database
  getUserInfoFromApiKey: GetUserInfoFromApiKeyFn
  fetchAgentFromDatabase: FetchAgentFromDatabaseFn
  startAgentRun: StartAgentRunFn
  finishAgentRun: FinishAgentRunFn
  addAgentStep: AddAgentStepFn

  // Billing
  consumeCreditsWithFallback: ConsumeCreditsWithFallbackFn

  // LLM
  promptAiSdkStream: PromptAiSdkStreamFn
  promptAiSdk: PromptAiSdkFn
  promptAiSdkStructured: PromptAiSdkStructuredFn
  /** Resolve the smallest declared context window across the agent's primary
   * BYOK route and configured failovers before a run. */
  resolveModelContextWindow?: (params: {
    agentId?: string
    model?: string
  }) => number | undefined

  // Mutable State
  databaseAgentCache: DatabaseAgentCache

  // Analytics
  trackEvent: TrackEventFn

  // Other
  logger: Logger
  fetch: typeof globalThis.fetch

  // Determinism (P2-T1)
  /** Injectable id generator; resolves to realIdGen when omitted. */
  idGen?: IdGen
  /** Injectable wall-clock; resolves to realClock when omitted. */
  clock?: Clock

  // Durable run journal (P2-T2)
  /** Append-only run-journal writer; when omitted, no journaling occurs. */
  journalWriter?: JournalWriter
  /** Run-journal reader for crash classification + replay short-circuit. */
  journalReader?: JournalReader

  // Process supervision (P2-T8)
  /**
   * Flag-gated adoption of the process supervisor for subagent spawns
   * (P2-T8). Resolved from the `OPENBUFF_PROCESS_SUPERVISION` env var at the
   * SDK impl entry seam (`sdk/src/impl/agent-runtime.ts`, via
   * `getSystemProcessEnv`) — agent-runtime production files never read
   * ambient `process.env`. Truthiness matches the
   * `OPENBUFF_COLLECT_FULL_FILE_CONTEXT` convention: `1`/`true`/`yes`/`on`
   * (case-insensitive). Default undefined ⇒ off ⇒ the in-process spawn path
   * stays byte-identical. When on, `executeSubagent` delegates to the
   * supervised-spawn seam instead of `loopAgentSteps`; the seam itself is
   * `spawnSupervised` below (and its env allowlist seed is built alongside
   * it at the same seam).
   */
  processSupervision?: boolean
  /**
   * P2-T8: injectable supervised-spawn seam, consulted only when
   * `processSupervision` is on. Seeded at the SDK impl entry seam alongside
   * the flag (backed by supervision/process-supervisor.ts +
   * supervision/child-entry.ts); tests inject a stub returning fixture
   * envelopes.
   */
  spawnSupervised?: (
    request: SupervisedSpawnRequest,
  ) => Promise<SettledSubagentResult>
}

/** Per-run dependencies */
export type AgentRuntimeScopedDeps = {
  // Client (WebSocket)
  handleStepsLogChunk: HandleStepsLogChunkFn
  requestToolCall: RequestToolCallFn
  requestMcpToolData: RequestMcpToolDataFn
  requestFiles: RequestFilesFn
  requestOptionalFile: RequestOptionalFileFn
  /** Filesystem view used by runtime-native discovery tools such as read_subtree. */
  fileSystem?: CodebuffFileSystem
  /** Shared path policy classifier; blocked paths are omitted from discovery. */
  fileFilter?: (path: string) => {
    status: 'blocked' | 'allow-example' | 'allow'
  }
  sendAction: SendActionFn
  sendSubagentChunk: SendSubagentChunkFn

  apiKey: string
}
