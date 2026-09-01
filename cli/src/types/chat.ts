import type { ChatTheme } from './theme-system'
import type { ToolName } from '@openbuff/sdk'
import type { ReactNode } from 'react'
import type { CompletionSummary } from '../utils/completion-summary'

/**
 * isCollapsed/userOpened are duplicated across block types intentionally - each UI
 * element tracks collapse state independently for different defaults and to persist
 * user intent vs programmatic state.
 */

export type ChatVariant = 'ai' | 'user' | 'agent' | 'error'

export type ThinkingCollapseState = 'expanded' | 'preview' | 'hidden'

export type TextContentBlock = {
  type: 'text'
  content: string
  color?: string
  marginTop?: number
  marginBottom?: number
  status?: 'running' | 'complete'
  textType?: 'reasoning' | 'text'
  isCollapsed?: boolean
  thinkingId?: string
  userOpened?: boolean
  /** True if this is a reasoning block from a <think> tag that hasn't been closed yet */
  thinkingOpen?: boolean
  thinkingCollapseState?: ThinkingCollapseState
}
/** Renders dynamic React content. NOT serializable - don't use for persistent data. */
export type HtmlContentBlock = {
  type: 'html'
  marginTop?: number
  marginBottom?: number
  render: (context: { textColor: string; theme: ChatTheme }) => ReactNode
}
export type ToolContentBlock = {
  type: 'tool'
  toolCallId: string
  toolName: ToolName
  input: any
  output?: string
  outputRaw?: unknown
  agentId?: string
  includeToolCall?: boolean
  isCollapsed?: boolean
  userOpened?: boolean
  // True when this write tool call is waiting on a prior same-path write that
  // is still in flight (queued behind a per-path write barrier). Flipped to
  // false by a `tool_start` event once the barrier resolves. Omitted/undefined
  // for read-only tools and older persisted blocks (treated as not-queued).
  queued?: boolean
  /** Authoritative call lifecycle. */
  lifecycle?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  /** The run was interrupted before this authoritative result arrived. */
  interrupted?: boolean
  /**
   * Detached background shell (process) job associated with this tool card.
   * For run_terminal_command BACKGROUND launches, the job id is known only
   * after the SDK starts the process and is wired from the tool_result
   * payload so live `job_update` events can correlate to this card and update
   * its lifecycle/output in place. May also be set on spawn result paths for
   * background agents.
   */
  backgroundJobId?: string
  /**
   * True once a background job error has been appended to this tool card's
   * output. Prevents duplicate error text if an error/lost job_update is
   * delivered more than once. Omitted/undefined for blocks without a
   * background job error (treated as not-yet-appended).
   *
   * Internal in-memory UI state only: this optional flag is not part of any
   * serialized/persisted block format or any CLI/config/environment contract.
   * Its addition is backward-compatible and requires no migration.
   */
  jobErrorAppended?: boolean
}
export type AgentContentBlock = {
  type: 'agent'
  agentId: string
  agentName: string
  agentType: string
  content: string
  status: 'running' | 'complete' | 'partial' | 'failed' | 'cancelled'
  blocks?: ContentBlock[]
  initialPrompt?: string
  params?: Record<string, any>
  isCollapsed?: boolean
  userOpened?: boolean
  /** The spawn_agents tool call ID that created this block, used to match results */
  spawnToolCallId?: string
  /** The index within the spawn_agents call, used to match the correct result */
  spawnIndex?: number
  /** Detached background-agent job associated with this card. */
  backgroundJobId?: string
  /**
   * True once a background job error has been appended to this agent card's
   * blocks. Prevents duplicate error text if an error/lost job_update is
   * delivered more than once. Omitted/undefined for blocks without a
   * background job error (treated as not-yet-appended).
   *
   * Internal in-memory UI state only: this optional flag is not part of any
   * serialized/persisted block format or any CLI/config/environment contract.
   * Its addition is backward-compatible and requires no migration.
   */
  jobErrorAppended?: boolean
}
export type AgentListContentBlock = {
  type: 'agent-list'
  id: string
  agents: Array<{ id: string; displayName: string }>
  agentsDir: string
  isCollapsed?: boolean
  userOpened?: boolean
}
export type ModeDividerContentBlock = {
  type: 'mode-divider'
  mode: string
}

export type PlanArtifactMetadata = {
  sessionPath?: string
  specPath?: string
  planPath?: string
  statusPath?: string
  lessonsPath?: string
  customArtifacts?: Array<{ label: string; path: string }>
  customArtifactCommands?: string[]
  executeCommand?: string
  resumeCommand?: string
  updateCommand?: string
  statusCommand?: string
  lessonsCommand?: string
}

export type PlanContentBlock = {
  type: 'plan'
  content: string
  metadata?: PlanArtifactMetadata
}

export type GateStateStatus = 'pending' | 'passed' | 'failed' | 'skipped'

/**
 * Parsed `<gate-state>` block.
 *
 * PUBLISHED BLOCK SCHEMA (canonical consumer contract, kept in step with the
 * producer `formatGateStateBlock` in agents/base2/base2.ts and the parser
 * `parseGateStateBlock` in cli/src/utils/message-block-helpers.ts): `gate` and
 * `status` are required; `details`, `origin`, `advisories`, and `workflow` are
 * optional and additive, so a block persisted before one of them existed
 * replays unchanged. Any new producer key MUST be added here, to the parser
 * docblock, and to the renderer, or downstream consumers parse a format this
 * contract does not describe. The prose summary in cli/knowledge.md is a
 * pointer to this contract, not a second source of truth; refresh it whenever
 * this enumeration changes.
 */
export type GateStateContentBlock = {
  type: 'gate-state'
  gate: string
  gateStatus: GateStateStatus
  details?: string
  /** Optional human label for the gate origin (e.g. "Base2"). */
  origin?: string
  /**
   * Non-blocking reviewer observations reported alongside the gate result.
   * Advisories never change the gate status: they are surfaced for awareness
   * only. Omitted when the producer reported none.
   *
   * Bounded by contract: base2's `formatGateStateBlock` emits at most 8 entries
   * of at most 240 characters each, and the CLI parser
   * (`parseGateStateAdvisories`) enforces the same bounds, dropping the whole
   * list when arbitrary assistant text exceeds them. Entries are stored
   * verbatim and may legitimately contain the literal `</gate-state>` text: the
   * producer escapes `</` as `<\/` (a legal JSON string escape) so payload text
   * cannot terminate the tag-delimited block early.
   */
  advisories?: string[]
  /**
   * Declared write_todos workflow progress reported alongside the gate result.
   * Present ONLY when the gate PASSED while declared workflow work still
   * remained, so a turn that finalizes with outstanding declared items is
   * distinguishable from a genuinely complete one. Observability only: no gate
   * phase, finalization decision, or follow-up permission reads it.
   *
   * Bounded by contract: base2's `formatGateStateBlock` emits a
   * `nextWorkflowAction` of at most 240 characters and emits the field at all
   * only when `completedCount < totalCount` (work actually remains), and the
   * CLI parser (`parseGateStateWorkflow`) enforces the same bounds, dropping
   * the field whole when arbitrary assistant text violates them. Optional, so
   * blocks persisted before it existed replay unchanged.
   */
  workflow?: {
    completedCount: number
    totalCount: number
    nextWorkflowAction: string
  }
}

export type CompletionSummaryContentBlock = {
  type: 'completion-summary'
  summary: CompletionSummary
}

export type CompactionCategoryDelta = {
  category:
    | 'toolResults'
    | 'todos'
    | 'fileReads'
    | 'subagents'
    | 'userAssistantMessages'
  beforeTokens: number
  afterTokens: number
}

/**
 * Identifies the CLI process that produced a still-live block. Blocks are
 * persisted to chat-messages.json and replayed on reload, and a live
 * (`status: 'pending'`) compaction pass has no cleanup path when the user
 * aborts the turn before it settles, so a replayed block would otherwise come
 * back as a permanently "compacting" card. A restored block carries the id of
 * the process that wrote it, which can never match the current one, so
 * consumers render it as an interrupted pass instead. Opaque and
 * diagnostic-only: nothing parses its contents.
 */
export const CLI_LIVE_SESSION_ID = `${process.pid}-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 10)}`

/**
 * Plain-JSON record of one context-compaction pass. Blocks are persisted to
 * chat-messages.json and replayed on reload, so every field is serializable
 * (no functions, no class instances) and the renderer must tolerate missing or
 * garbage values coming back from an older/partial session.
 *
 * Consumer-visible contract change: this typed block replaces the previous
 * concatenated free-text `text` compaction notice. A replayed session that
 * still holds the old notice keeps rendering as plain text. See
 * `docs/agents-and-tools.md` under "Context-window-aware compaction budgets".
 */
export type CompactionContentBlock = {
  type: 'compaction'
  /**
   * 'pending' while the pruner is still running: the result fields are not yet
   * known and render as a live state. Absent or 'complete' is a finished pass,
   * which is what every persisted/replayed block from before this field holds.
   * 'interrupted' is the terminal state of a pass whose run ended before it
   * reported a result (the user aborted mid-compaction, or the turn ended
   * abnormally): the abort/teardown path rewrites 'pending' to it, so a block
   * that reaches persistence never claims to still be running.
   * 'declined' is the terminal state of a pass that RAN and reclaimed nothing
   * (the runtime settled it without ever reporting a result), which is distinct
   * from 'interrupted': the pass completed, it simply had nothing to reclaim.
   *
   * Backward replay is lossy but non-fatal, and is documented as such in
   * `docs/agents-and-tools.md`: an older CLI enumerates only
   * pending/complete/interrupted and falls through to its completed-pass branch
   * for an unknown value, so a 'declined' block written here renders there as a
   * completed pass reporting `→ 0 tokens (−0%)` (its result fields are the
   * zeroed placeholders of a pass that never reported one). Nothing fails to
   * parse and the session still loads.
   */
  status?: 'pending' | 'complete' | 'interrupted' | 'declined'
  /**
   * True when this pass was performed by a foreground subagent or inline agent
   * run (non-empty `ancestorRunIds`) rather than the root turn, so the card can
   * be labelled as a nested pass. Absent on root passes and on
   * persisted/replayed blocks written by an older CLI (treated as root), which
   * also means an older CLI replaying a block written here drops the label and
   * presents a nested pass as a root one.
   */
  subagent?: boolean
  /**
   * Which brake produced this block. Absent for the runtime-owned passes
   * (`context_compaction`, including its mechanical emergency trim), which is
   * also what every persisted/replayed block written by an older CLI holds.
   * 'request' marks the SDK's request-time emergency trim
   * (`context_request_trim`), a strictly later and more severe brake that must
   * not be presented as a runtime pass. An older CLI drops the field on replay
   * and therefore presents such a trim as an ordinary runtime pass.
   */
  trimSource?: 'runtime' | 'request'
  /**
   * Set to {@link CLI_LIVE_SESSION_ID} while `status: 'pending'` is live in the
   * producing process. Absent on a completed pass, on an 'interrupted' one (the
   * stamp is meaningless once the run is over) and on persisted blocks written
   * by an older CLI, so an absent or foreign value marks a pending pass that
   * this process cannot still be running (a crash that ran no teardown at all).
   */
  liveSessionId?: string
  /**
   * Agent run that produced this pass (`runId` on the compaction events). Only
   * root-run passes are recorded as root-level blocks, but the id is retained
   * so a `settled`/result event can only ever settle the card its own run
   * started, never a concurrent or nested agent loop's. Absent on blocks
   * persisted before the correlation existed; those pair with equally
   * uncorrelated events.
   */
  runId?: string
  action: 'semantic_compaction' | 'mechanical_trim'
  beforeTokens: number
  afterTokens: number
  beforeMessages: number
  afterMessages: number
  /** Whole-percent reduction, 0..100, already clamped by the producer. */
  reductionPercent: number
  retainedKnowledgeMemory: boolean
  recovery: string
  /** Categories that shrank, with their before/after token counts. */
  categoryDeltas: CompactionCategoryDelta[]
  reason?: string
  resolvedContextWindowTokens?: number
  triggerBudgetTokens?: number
  targetBudgetTokens?: number
  compactionCount?: number
  consecutiveNoProgressCompactions?: number
  fitsBudget?: boolean
  shortfallTokens?: number
  escalated?: boolean
}

/**
 * Canonical accumulated context-compaction notice for the current turn, or
 * null when nothing has been compacted. Declared once here and reused by the
 * SDK event handler that produces it, the status-bar chip selector, and the
 * status-bar component, so a later additive field cannot go silently missing
 * from one consumer.
 *
 * Turn-scoped, and shared across nesting levels: every agent loop (root,
 * foreground subagents, inline agents) reports its own compaction events, so
 * the producer counts a nested run's completed pass but only ever adopts the
 * ROOT run's own `compactionCount` as the turn total.
 *
 * Live state is NOT root-only. A live pass of ANY run — root or nested — is
 * recorded in {@link CompactionNotice.pendingRunIds} and therefore sets
 * `pending`, so a subagent's compaction keeps the shared status-bar chip live
 * even though it renders no root-level card of its own. Only the ROOT run's
 * live pass additionally gets a pending transcript card.
 */
export type CompactionNotice = {
  /**
   * Passes that COMPLETED in this turn (the root run's own reported
   * `compactionCount` when it reports one, plus each nested run's passes).
   *
   * A settled notice never stays at 0: the shared chip selector renders nothing
   * for a notice that is neither pending nor `count > 0`, so the producer
   * clears such a notice to null instead of retaining unobservable state. A
   * pass that ran and reclaimed nothing is reported by its terminal
   * `status: 'declined'` transcript card, not by the notice.
   */
  count: number
  /**
   * Action of the most recently COMPLETED pass. A pass that has only started
   * leaves it untouched, so an aborted turn still labels the settled chip by
   * what actually completed.
   */
  action: CompactionContentBlock['action']
  /** The pass did not fit the budget, or stopped reclaiming space. */
  degraded: boolean
  /**
   * A compaction pass is running right now. Derived from {@link pendingRunIds}
   * (true exactly when it is non-empty) so consumers that only read this flag
   * need no change. The one exception is the tolerated legacy shape described
   * on {@link pendingRunIds}: a `pending: true` with no `pendingRunIds` is
   * carried forward verbatim by the producers instead of being recomputed away,
   * so such a notice keeps its live flag until a settling event clears it.
   */
  pending?: boolean
  /**
   * Runs with a live (announced but unsettled) compaction pass. Tracked per run
   * so nested or concurrent agent loops cannot cross-settle each other's live
   * state: `started` adds the emitting `runId`, `settled` removes it, and a
   * `settled` for a run that was never recorded is tolerated as a no-op. Root
   * and nested runs alike are recorded here — a subagent pass renders no
   * root-level card, but it does keep the shared root-level chip live until its
   * own run settles.
   *
   * Absent on notices produced before this field existed. Such a notice can
   * still carry `pending: true`, and that live flag is HONORED: the producers
   * keep it on events that settle no announced pass (a request-time trim, a
   * nested compaction result) and clear it on the events that do settle one (a
   * `settled` status, a root compaction result), because an uncorrelated live
   * pass has no run id to match against.
   */
  pendingRunIds?: string[]
}

export type AskUserContentBlock = {
  type: 'ask-user'
  toolCallId: string
  questions: Array<{
    question: string
    header?: string
    options: Array<{
      label: string
      description?: string
    }>
    multiSelect?: boolean
    validation?: {
      maxLength?: number
      minLength?: number
      pattern?: string
      patternError?: string
    }
  }>
  answers?: Array<{
    questionIndex: number
    selectedOption?: string
    selectedOptions?: string[]
    otherText?: string
  }>
  skipped?: boolean
}

export type ImageContentBlock = {
  type: 'image'
  image: string // base64 encoded
  mediaType: string
  filename?: string
  size?: number
  width?: number
  height?: number
  imageRedacted?: boolean
  imageLength?: number
  isCollapsed?: boolean
  userOpened?: boolean
}

export type ImageAttachment = {
  filename: string
  path: string
  size?: number
}

export type TextAttachment = {
  id: string
  content: string
  preview: string
  charCount: number
}

export type FileAttachment = {
  path: string
  filename: string
  isDirectory: boolean
  note?: string
}

export type ContextContentBlock = {
  type: 'context'
  ledgerText: string | null
  gateBudgetsText: string
}

export type InfoContentBlock = {
  type: 'info'
  version: string
  workspace: string
}

export type DoctorContentBlock = {
  type: 'doctor'
  projectRoot: string
  agentsTrusted: boolean
  skillsTrusted: boolean
  skillCount: number
  mcpCount: number
  diagnostics: Array<{ filePath?: string; agentId?: string; message: string }>
  providerStatus: string
}

export type IndexStatusContentBlock = {
  type: 'index-status'
  statusLine: string
  messageLine: string
  corpusLine: string
  ageLine: string
  vectorLine: string
  hintLine: string
  coverageLine?: string
  diagnosticsLines?: string[]
  lines: string[]
}

export type PlanStatusContentBlock = {
  type: 'plan-status' | 'plan-status-list'
  mode: 'status' | 'list'
  reportText: string
  sessions?: import('../commands/plan-artifacts').PlanSessionSummary[]
  isStatusReport: boolean
}

export type MemoryContentBlock =
  | {
      type: 'memory'
      state: 'empty'
    }
  | {
      type: 'memory'
      state: 'status'
      revision: number
      updatedAt: number
      goal: string | null
      goalPreview: string
      isGoalTruncated: boolean
      counts: {
        decisions: number
        requirements: number
        editsMade: number
        validationResults: number
        blockers: number
        nextActions: number
      }
      evidence: {
        fresh: number
        stale: number
        total: number
      }
      stalePaths: string[]
      totalStaleCount: number
    }
  | {
      type: 'memory'
      state: 'pruned'
      removed: number
      remaining: number
    }
  | {
      type: 'memory'
      state: 'nothing-to-prune'
      remaining: number
    }
  | {
      type: 'memory'
      state: 'no-record'
    }
  | {
      type: 'memory'
      state: 'failed'
      reason: 'invalid-record' | 'concurrent-write' | 'write-failed'
      cause: string
      removed: number
      remaining: number
    }
  | {
      type: 'memory'
      state: 'error'
      message: string
    }

export type ContentBlock =
  | AgentContentBlock
  | AgentListContentBlock
  | AskUserContentBlock
  | CompletionSummaryContentBlock
  | CompactionContentBlock
  | ContextContentBlock
  | DoctorContentBlock
  | GateStateContentBlock
  | HtmlContentBlock
  | ImageContentBlock
  | IndexStatusContentBlock
  | InfoContentBlock
  | MemoryContentBlock
  | ModeDividerContentBlock
  | PlanStatusContentBlock
  | TextContentBlock
  | ToolContentBlock
  | PlanContentBlock

export type AgentMessage = {
  agentName: string
  agentType: string
  responseCount: number
  subAgentCount?: number
}

export type ChatMessageMetadata = {
  /** Working directory where a bash command was executed */
  bashCwd?: string
  /** Whether this message/agent is collapsed in the UI */
  isCollapsed?: boolean
  /** Whether the user manually opened this collapsed item */
  userOpened?: boolean
  /** RunState stored after completion */
  runState?: unknown
}

export type ChatMessage = {
  id: string
  variant: ChatVariant
  content: string
  blocks?: ContentBlock[]
  timestamp: string
  parentId?: string
  agent?: AgentMessage
  isCompletion?: boolean
  credits?: number
  /**
   * Cache hit rate (0-1) for the run, computed from
   * cacheInputTokens/cacheTotalInputTokens on the main agent state at run
   * completion. Surfaced live in the message footer as "cache N%". Undefined
   * when no cache usage data was collected (e.g. provider doesn't report it).
   */
  cacheHitRate?: number
  completionTime?: string
  isComplete?: boolean
  metadata?: ChatMessageMetadata
  validationErrors?: Array<{ id: string; message: string }>
  /**
   * UI-only runtime error displayed in UserErrorBanner (not sent to LLM).
   * Set by setError() when an error occurs during message streaming.
   * Can be cleared by clearUserError() when starting a new successful interaction.
   */
  userError?: string
  attachments?: ImageAttachment[]
  textAttachments?: TextAttachment[]
  fileAttachments?: FileAttachment[]
}

// Type guard functions for safe type narrowing
export function isTextBlock(block: ContentBlock): block is TextContentBlock {
  return block.type === 'text'
}

export function isToolBlock(block: ContentBlock): block is ToolContentBlock {
  return block.type === 'tool'
}

export function isAgentBlock(block: ContentBlock): block is AgentContentBlock {
  return block.type === 'agent'
}

export function isHtmlBlock(block: ContentBlock): block is HtmlContentBlock {
  return block.type === 'html'
}

export function isAgentListBlock(
  block: ContentBlock,
): block is AgentListContentBlock {
  return block.type === 'agent-list'
}

export function isPlanBlock(block: ContentBlock): block is PlanContentBlock {
  return block.type === 'plan'
}

export function isModeDividerBlock(
  block: ContentBlock,
): block is ModeDividerContentBlock {
  return block.type === 'mode-divider'
}

export function isAskUserBlock(
  block: ContentBlock,
): block is AskUserContentBlock {
  return block.type === 'ask-user'
}

export function isImageBlock(block: ContentBlock): block is ImageContentBlock {
  return block.type === 'image'
}

export function isGateStateBlock(
  block: ContentBlock,
): block is GateStateContentBlock {
  return block.type === 'gate-state'
}

export function isCompletionSummaryBlock(
  block: ContentBlock,
): block is CompletionSummaryContentBlock {
  return block.type === 'completion-summary'
}

export function isCompactionBlock(
  block: ContentBlock,
): block is CompactionContentBlock {
  return block.type === 'compaction'
}

export function isMemoryBlock(
  block: ContentBlock,
): block is MemoryContentBlock {
  return block.type === 'memory'
}

export function isContextBlock(
  block: ContentBlock,
): block is ContextContentBlock {
  return block.type === 'context'
}

export function isInfoBlock(block: ContentBlock): block is InfoContentBlock {
  return block.type === 'info'
}

export function isDoctorBlock(
  block: ContentBlock,
): block is DoctorContentBlock {
  return block.type === 'doctor'
}

export function isIndexStatusBlock(
  block: ContentBlock,
): block is IndexStatusContentBlock {
  return block.type === 'index-status'
}

export function isPlanStatusBlock(
  block: ContentBlock,
): block is PlanStatusContentBlock {
  return block.type === 'plan-status' || block.type === 'plan-status-list'
}
