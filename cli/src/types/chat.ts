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
}

export type CompletionSummaryContentBlock = {
  type: 'completion-summary'
  summary: CompletionSummary
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
