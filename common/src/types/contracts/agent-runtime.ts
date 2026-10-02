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

/** Journal reader used for crash classification and replay (P2-T2). */
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
