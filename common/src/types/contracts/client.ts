import type { ServerAction } from '../../actions'
import type { MCPConfig, McpToolCatalog } from '../mcp'
import type { ToolResultOutput } from '../messages/content-part'
import type {
  CommitReceiptV1,
  ReadFilesResultV1,
} from '../../tools/results/filesystem'
import type { ReadCapabilityIssuer } from '../../util/content-hash'
import type { ActionOutcome } from '../run-outcome'

/** Runtime description; only the receiving host registers executable authority. */
export type ExecutionActor = Readonly<{ runId: string; rootRunId: string; agentId: string }>
/** Descriptive runtime-internal origin; only a registered host can resolve authority. */
export type ExecutionHostOperationOrigin = Readonly<{
  actor: ExecutionActor
  purpose: 'semantic-compaction' | 'snapshot-consolidation'
}>
export type ToolExecutionIdentity = ExecutionActor & Readonly<{
  actionId: string; attemptId: string; basisId: string
  basis: Readonly<ActionOutcome['basis']>
  workspaceSnapshotId?: string
}>

/** Root callbacks register synchronously; a supervised peer awaits the parent acknowledgement. */
export type OnExecutionActionStart = (start: Readonly<{
  identity: ToolExecutionIdentity
  toolName: string
  input: unknown
  signal: AbortSignal
}>) => void | Promise<void>

export type RequestToolCallFn = (params: {
  userInputId: string
  callId?: string
  toolName: string
  input: Record<string, any> & { timeout_seconds?: number }
  mcpConfig?: MCPConfig
  mcpReference?: string
  mcpAgentId?: string
  mcpServerName?: string
  mcpCatalogGeneration?: number | null
  signal?: AbortSignal
  executionIdentity?: ToolExecutionIdentity
  /** Hash of the actual forwarded request, separately from the original attempted input. */
  executionRequestHash?: string
}) => Promise<{
  output: ToolResultOutput[]
  canonicalReceipt?: CommitReceiptV1
}>

export type RequestMcpToolDataFn = (params: {
  mcpConfig: MCPConfig
  toolNames: string[] | null
  mcpReference?: string
  mcpAgentId?: string
  mcpServerName?: string
  signal?: AbortSignal
  executionActor?: ExecutionActor
}) => Promise<
  | McpToolCatalog
  | {
      name: string
      description?: string
      inputSchema: unknown
    }[]
>

export type FileLineRange = {
  path: string
  startLine?: number
  endLine?: number
}

export type RequestFilesFn = (params: {
  filePaths: string[]
  ranges?: FileLineRange[]
  /** Runtime-only issuer scope used to mint non-replayable raw-basis capabilities. */
  capabilityIssuer?: ReadCapabilityIssuer
  signal?: AbortSignal
}) => Promise<ReadFilesResultV1>

export type RequestOptionalFileFn = (params: {
  filePath: string
  signal?: AbortSignal
}) => Promise<string | null>

export type SendSubagentChunkFn = (params: {
  userInputId: string
  agentId: string
  agentType: string
  chunk: string
  /**
   * When set to 'reasoning', `chunk` is a reasoning/thinking delta rather
   * than display text. Omitted (or any other value) keeps the existing text
   * semantics.
   */
  chunkKind?: 'reasoning'
  /**
   * Reasoning provenance, mirroring PrintModeReasoningDelta.ancestorRunIds:
   * the run chain that produced the reasoning delta. Only meaningful
   * alongside `chunkKind: 'reasoning'`.
   */
  ancestorRunIds?: string[]
  prompt?: string | undefined
  forwardToPrompt?: boolean
}) => void

export type HandleStepsLogChunkFn = (params: {
  userInputId: string
  runId: string
  level: 'debug' | 'info' | 'warn' | 'error'
  data: unknown
  message?: string
}) => void

export type SendActionFn = (params: { action: ServerAction }) => void
