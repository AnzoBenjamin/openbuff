import path from 'path'
import { existsSync, rmSync } from 'node:fs'

import { callMainPrompt } from '@codebuff/agent-runtime/main-prompt'
import {
  buildUserMessageContent,
  withSystemTags,
} from '@codebuff/agent-runtime/util/messages'
import { MAX_AGENT_STEPS_DEFAULT } from '@codebuff/common/constants/agents'
import {
  getMCPClientCacheKey,
  resolveMCPConfigOrigin,
  propagateMCPConfigOrigins,
} from '@codebuff/common/mcp/client'
import {
  bindMcpSession,
  resolveMcpHostBinding,
} from '@codebuff/common/mcp/provenance'
import { selectExternalToolPaths } from '@codebuff/common/tools/external-tool'
import {
  getScopedReadPolicyAliases,
  isSafeProjectRelativePath,
  resolveFilePathForFileSystemReadOperation,
} from './tools/path-utils'
import type { MCPConfig } from '@codebuff/common/types/mcp'
import { toolNames } from '@codebuff/common/tools/constants'
import {
  fileMutationResultV1Schema,
  getConfirmedAppliedActionsV1,
  type CommitReceiptV1,
  type FileMutationResultV1,
} from '@codebuff/common/tools/results/filesystem'
import {
  clientToolCallSchema,
  clientToolNames,
} from '@codebuff/common/tools/list'
import { parseJsonBounded } from '@codebuff/common/tools/params/utils'
import { executionRefusalSchema } from '@codebuff/common/tools/params/execution-refusal'
import { AgentOutputSchema } from '@codebuff/common/types/session-state'
import { advanceWorkspaceState } from '@codebuff/common/types/workspace-state'
import type { WorkspaceStateV1 } from '@codebuff/common/types/workspace-state'
import { extractApiErrorDetails } from '@codebuff/common/util/error'
import { jobRegistry } from '@codebuff/common/util/job-registry'
import { hashActionInput } from '@codebuff/common/util/action-outcomes'
import { jsonSchemaToZod } from '@codebuff/common/util/json-schema'
import { captureRootDeadline, isExecutionDeadlineSignal } from '@codebuff/common/util/execution-context'
import { stableHash } from '@codebuff/common/util/stable-hash'
import type { TaskMemoryV1 } from '@codebuff/common/types/task-memory'
import { cloneDeep } from 'lodash'

import { getErrorStatusCode } from './error-utils'
import { createJobUpdateForwarder } from './job-update-forwarder'
import { createRunMcpExecution } from './services/run-mcp-execution'
import { createExecutionScopeRegistry } from './services/execution-scope-registry'
import { createActionWorkspaceBasis } from './services/action-workspace-basis'
import type { ActionWorkspaceBasis, ConfirmedWorkspaceTransition } from './services/action-workspace-basis'
import { getAgentRuntimeImpl } from './impl/agent-runtime'
import { captureAmbientHostInputs, getCapturedProviderConfig, loadHostConfigSnapshot, nodeConfigReadFs } from './host-config'
import { createHostExecutionServices, defaultExecutionProfile, executionClock } from './host-execution'
import { bindHostFileSystem } from './services/host-filesystem'
import { executionLimitMs, ExecutionRefusalError, isExecutionRefusalError } from './services/execution-launch'
import { initialSessionState, applyOverridesToSessionState } from './run-state'
import {
  codebuffFsToNodePromises,
  saveMergedTaskMemory,
} from './services/task-memory-store'
import { WorkspaceJournalService } from './services/workspace-journal'
import { WorkspaceMutationBroker } from './services/workspace-mutation-broker'
import { LocalHarnessStore } from './services/local-harness-store'
import {
  captureDiagnosticObservation,
  type DiagnosticCapture,
} from './services/diagnostic-delta'
import {
  createDiagnosticCommandRunner,
  createDiagnosticDeltaHook,
} from './services/diagnostic-delta-runner'
import {
  diagnosticFileSet,
  diagnosticPostimageMatches,
} from './services/diagnostic-baseline'
import { MemoryV2Coordinator } from './services/memory-v2/coordinator'
import type { MemoryV2ClientConfig } from './services/memory-v2/types'
import {
  HarnessApprovalService,
  hashCommand,
} from './services/harness-enforcement'
import type {
  HarnessApprovalMode,
  HarnessApprovalRequest,
} from './services/harness-enforcement'
import { changeFile, changeFiles } from './tools/change-file'
import { getDefaultFilesystemAuthority } from './tools/filesystem-authority'
import { codeSearch } from './tools/code-search'
import { findFilesMatchingContent } from './tools/find-files-matching-content'
import { glob } from './tools/glob'
import { listDirectory } from './tools/list-directory'
import {
  getFileForEditResult,
  getFilesStructured,
  normalizeReadFilesOverrideResult,
} from './tools/read-files'
import { readImages } from './tools/read-image'
import { edit3dAsset, inspect3dAsset, render3dPreview } from './tools/3d-assets'
import {
  browserLogs,
  chromeSandboxArgs,
  resolveChromeExecutable,
  stopBrowserSessionsByOwner,
  type BrowserSessionOwner,
} from './tools/browser-logs'
import { replaceRange } from './tools/replace-range'
import { runTerminalCommand } from './tools/run-terminal-command'
import { checkJob } from './tools/check-job'
import { killJob } from './tools/kill-job'
import { readLogs } from './tools/read-logs'
import { gitStatus } from './tools/git-status'
import { inspectWorkspace } from './tools/inspect-workspace'
import { getTask } from './tools/get-task'
import { getChangeReviewBundle } from './tools/get-change-review-bundle'
import { runTargetedValidation } from './tools/run-targeted-validation'
import { inspectEnvironment } from './tools/inspect-environment'
import { getAffectedTests } from './tools/get-affected-tests'
import { getBuildTargets } from './tools/get-build-targets'
import { findReferences } from './tools/find-references'
import { goToDefinition } from './tools/go-to-definition'
import { hoverType } from './tools/hover-type'
import { workspaceSymbol } from './tools/workspace-symbol'
import { renameSymbol } from './tools/rename-symbol'
import { codeAction } from './tools/code-action'
import { extractSymbol } from './tools/extract-symbol'
import {
  createLanguageIntelligence,
  type LanguageIntelligenceService,
} from './services/language-intelligence'
import {
  evaluateAuditCoverageTool,
  inspectCodebaseStructureTool,
  inspectFeatureCompletenessTool,
} from './tools/audit-intelligence'
import { gitBranch } from './tools/git-branch'
import {
  isDiagnosticPreflightEnabled,
  runFileChangeHooks,
  type DiagnosticDeltaHook,
} from './tools/file-change-hooks'
import {
  findFileMutationResult,
  writeAuditFindings,
} from './tools/write-audit-findings'
import { createNodeFileSystem } from './tools/node-filesystem'
import {
  createTransactionIntentLogForWorkspace,
  recoverAndRevertInterruptedTransactions,
  type TransactionIntentLog,
} from './tools/transaction-intent-log'
import type { FilesystemAuthorityPolicy } from './tools/filesystem-authority'

import type {
  CustomToolDefinition,
  CustomToolExecutionContext,
} from './custom-tool'
import type { RunState } from './run-state'
import { projectRunOutcomes } from './run-state'
import type { RunOutcome } from '@codebuff/common/types/run-outcome'
import type { FileFilter } from './tools/read-files'
import type { FileLineRange } from '@codebuff/common/types/contracts/client'
import type { ReadFilesResultV1 } from '@codebuff/common/tools/results/filesystem'
import type { ServerAction } from '@codebuff/common/actions'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type {
  PublishedToolName,
  ToolName,
} from '@codebuff/common/tools/constants'
import type { ClientToolName } from '@codebuff/common/tools/list'
import type { CodebuffToolCall } from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { ToolMessage } from '@codebuff/common/types/messages/codebuff-message'
import type {
  ImagePart,
  TextPart,
  ToolResultOutput,
} from '@codebuff/common/types/messages/content-part'
import type { PlaybookGateOutcomeEvent } from '@codebuff/common/types/memory-playbook'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { SessionState } from '@codebuff/common/types/session-state'
import type { JobOwner } from '@codebuff/common/util/job-registry'
import type { ReadCapabilityIssuer } from '@codebuff/common/util/content-hash'
import { decodeReadCapabilityToken } from '@codebuff/common/util/content-hash'
import {
  captureTextDocument,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'
import { rawReadBasesMatch } from '@codebuff/common/util/raw-read-basis'
import type { Source } from '@codebuff/common/types/source'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import { listJobs } from './tools/list-jobs'

import type { ListJobsViewRow } from '@codebuff/common/util/list-jobs-view'
import { fingerprintListJobsRows } from '@codebuff/common/util/list-jobs-view'
import { getSystemProcessEnv } from './env'
import { spawn as nodeSpawn } from 'node:child_process'
import type {
  JournalReader,
  JournalWriter,
} from '@codebuff/common/types/contracts/agent-runtime'
import { createRunResumeDriver } from './services/run-resume-driver'
import type { CapturedCredentialPort, HostConfigurationInputs, HostConfigSnapshot } from './host-config'
import type { ConfigReadFs } from './provider-config'
import type { ExecutionScope, HostExecutionOptions, RunHostServices } from './host-execution'
import type { BoundResourceFactory, ExecutionAdapterContext, LaunchEvent, PolicyInput, ProfileRequest } from '@codebuff/common/types/contracts/execution-context'
import type { MediatedMcpRequest } from '@codebuff/common/mcp/request'
import type { CapturedHookConfiguration } from './tools/file-change-hooks'
import type { ExecutionActor, ToolExecutionIdentity } from '@codebuff/common/types/contracts/client'

/**
 * Audit fix (D): tool calls whose receipt can contain file actions — the same
 * set that reaches handleToolCall's post-commit mutation block (the change-
 * file tools plus the compact-receipt tools). rename_symbol, code_action,
 * and extract_symbol ride the same compact-receipt channel as
 * write_audit_findings, so they are baseline-captured too. Mirrors the
 * toolName list the override receipt guard uses there.
 */
const DIAGNOSTIC_BASELINE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'str_replace',
  'create_plan',
  'edit_transaction',
  'replace_range',
  'write_audit_findings',
  'rename_symbol',
  'code_action',
  'extract_symbol',
])

/**
 * Audit fix (D): bounded file list for the pre-edit baseline capture — the
 * paths a mutating tool call targets, derived from its input WITHOUT any
 * schema change. Each tool input carries at most a few paths, so the list is
 * bounded by construction; supportedDiagnosticFiles filters it further before
 * capture, and an empty output means no capture runs at all.
 */
function diagnosticBaselineFiles(toolName: string, input: unknown): string[] {
  const record = (input ?? {}) as Record<string, unknown>
  switch (toolName) {
    case 'write_file':
    case 'str_replace':
    case 'create_plan':
    case 'replace_range':
    // rename_symbol, code_action, and extract_symbol are single-`path`
    // mutating tools that reach the same post-commit mutation block via the
    // compact-receipt channel, so they get the same `input.path` baseline
    // branch. (extract_symbol's destination is a NEW file, so it needs no
    // pre-edit baseline.)
    case 'rename_symbol':
    case 'code_action':
    case 'extract_symbol': {
      const file = typeof record.path === 'string' ? record.path : undefined
      return file ? [file] : []
    }
    case 'edit_transaction': {
      const edits = Array.isArray(record.edits) ? record.edits : []
      const files = new Set<string>()
      for (const edit of edits) {
        if (!edit || typeof edit !== 'object') continue
        const editPath = (edit as { path?: unknown }).path
        if (typeof editPath === 'string' && editPath !== '') {
          files.add(editPath)
        }
      }
      return [...files]
    }
    default:
      return []
  }
}

/**
 * Stable trusted background-job ownership seed for THIS client session.
 *
 * The seed is created lazily ONCE per process (never per run), so consecutive
 * `run()` calls from the same CLI session resolve the same
 * `trustedJobOwner.clientSessionId`. That keeps a background process spawned in
 * turn N owned (and manageable via check_job/kill_job/read_logs/list_jobs /
 * end_turn) in turn N+1, instead of every new run stamping a fresh random id
 * that makes all earlier jobs look 'foreign'.
 *
 * Trust invariants (unchanged):
 * - The seed is runtime-owned process state; it is NEVER derived from model,
 *   tool input, or anything the model can influence.
 * - It is scoped to one client session/process, so separate sessions stay
 *   distinct owners.
 * - `sessionState` itself carries no stable session-level identifier today
 *   (`AgentState` has only per-run `runId` / deprecated `agentId`, and turn
 *   ids like `promptId` are per-run by design), which is exactly why a
 *   process-owned seed is used. No per-run fallback is needed: every
 *   background job this session spawns is stamped with this same seed.
 */
let trustedSessionClientId: string | undefined

/**
 * Exported for tests: the same accessor `runOnce` uses, so ownership tests
 * can pin consecutive-run stability against the production symbol.
 */
export function getTrustedSessionClientId(): string {
  trustedSessionClientId ??= crypto.randomUUID()
  return trustedSessionClientId
}

/**
 * Wraps content for user messages, ensuring text is wrapped in <user_message> tags.
 * Uses buildUserMessageContent from agent-runtime for consistency.
 */
const wrapContentForUserMessage = (
  content?: (TextPart | ImagePart)[],
): (TextPart | ImagePart)[] | undefined => {
  if (!content || content.length === 0) {
    return content
  }
  // Delegate to the shared utility which handles wrapping correctly
  return buildUserMessageContent(undefined, undefined, content)
}

export type OverrideExecutionContextV1 = {
  abiVersion: 'v1'
  signal: AbortSignal
  execution?: ExecutionAdapterContext
}

export type OverrideDescriptor<TInput, TV0Output, TV1Output = TV0Output> =
  | ((input: TInput) => Promise<TV0Output>)
  | {
      version: 'v0'
      execute: (input: TInput) => Promise<TV0Output>
    }
  | {
      version: 'v1'
      execute: (
        input: TInput,
        context: OverrideExecutionContextV1,
      ) => Promise<TV1Output>
    }

type PublishedToolInput<T extends PublishedToolName> = Extract<
  CodebuffToolCall,
  { toolName: T }
>['input']

export type ClientToolOverrides = {
  [T in Exclude<PublishedToolName, 'read_files'>]?: OverrideDescriptor<
    PublishedToolInput<T>,
    ToolResultOutput[]
  >
} & {
  read_files?: OverrideDescriptor<
    { filePaths: string[]; ranges?: FileLineRange[] },
    ReadFilesResultV1
  >
}

export type OpenbuffClientOptions = {
  apiKey?: string

  cwd?: string
  /** Optional directory path to load skills from. Skills found here will be available to the `skill` tool. */
  skillsDir?: string
  projectFiles?: Record<string, string>
  /** Use paths to defer repository-wide symbol parsing to retrieval tools. Defaults to symbols. */
  projectContextMode?: 'paths' | 'symbols'
  knowledgeFiles?: Record<string, string>
  /** Explicit user knowledge, merged after files selected by the captured home policy. */
  userKnowledgeFiles?: Record<string, string>
  agentDefinitions?: AgentDefinition[]
  /**
   * Host-supplied MCP servers to attach to the agent being run. They are
   * merged (by object REFERENCE, never cloned) into the resolved agent
   * template's `mcpServers` after the session state is built, so the run
   * loop's getMCPToolData picks them up. Callers that need these treated as
   * untrusted (e.g. the serve bridge, for client-advertised servers) mark them
   * with markAllMCPConfigOrigins BEFORE passing them here; run() never
   * re-marks or clones them, so the identity-keyed origin marks survive to
   * resolveMCPConfigOrigin.
   */
  mcpServers?: Record<string, MCPConfig>
  maxAgentSteps?: number
  /** (Optional) Cap on how many times the agent retries a structured set_output after ending its turn without one. Omit for unlimited retries (bounded by maxAgentSteps). */
  maxMissingOutputRetries?: number
  env?: Record<string, string | undefined>
  /** Whether terminal commands inherit the host process environment. Defaults
   * to true. False uses only env (then applies the credential scrub). This
   * controls child commands; it does not isolate SDK/provider execution. */
  inheritEnv?: boolean
  /** Complete host-only inputs. Child env overrides do not change provider configuration. */
  hostConfiguration?: HostConfigurationInputs
  /** Synchronous configuration reader; explicit injection never uses another reader. */
  configReadFs?: ConfigReadFs
  /** Private provider credential service for this run. */
  credentials?: CapturedCredentialPort
  /** Selected process policy and required backend capabilities. */
  executionProfile?: ProfileRequest
  /** Secret-free execution phase observations. */
  recordExecution?: (event: LaunchEvent) => void
  /** Harness control-plane state root. Defaults to the Openbuff config directory. */
  harnessStateDir?: string
  /** Pre-created, exact-scope approval receipt IDs available to this run.
   * Receipts are matched and consumed atomically only for the high-impact
   * action, workspace, root run, and current snapshot they authorize. */
  approvalReceiptIds?: string[]
  /** Approval behavior for classified terminal effects. Defaults to balanced. */
  approvalMode?: HarnessApprovalMode
  /** Host callback used to pause the current run for an exact approval. */
  requestApproval?: (request: HarnessApprovalRequest) => Promise<boolean>

  handleEvent?: (event: PrintModeEvent) => void | Promise<void>
  handleStreamChunk?: (
    chunk:
      | string
      | {
          type: 'subagent_chunk'
          agentId: string
          agentType: string
          chunk: string
        }
      | {
          type: 'reasoning_chunk'
          agentId: string
          ancestorRunIds: string[]
          chunk: string
        },
  ) => void | Promise<void>

  /** Optional filter to classify files before reading (runs before gitignore check) */
  fileFilter?: FileFilter

  /** Operation- and phase-aware policy composed after mandatory safeguards. */
  filesystemPolicy?: FilesystemAuthorityPolicy

  overrideTools?: ClientToolOverrides
  customToolDefinitions?: CustomToolDefinition[]

  /** Called after a file-mutating tool (write_file/str_replace/edit_transaction/
   *  replace_range) runs, so a host can invalidate caches such as
   *  the codebase index. Best-effort; never blocks the tool result. */
  onFilesChanged?: () => unknown | Promise<unknown>

  /** Awaited after a confirmed mutation so hosts can update indexes precisely. */
  onFilesystemMutation?: (
    event: FilesystemMutationEvent,
  ) => void | Promise<void>

  /** Host attestation hook for v1 mutation overrides. Without it, external
   * mutation results remain conservatively unconfirmed. */
  verifyExternalMutation?: (params: {
    toolName: string
    callId: string
    result: FileMutationResultV1
  }) => boolean | Promise<boolean>

  fsSource?: Source<CodebuffFileSystem>
  spawnSource?: CodebuffSpawn | Promise<CodebuffSpawn>
  logger?: Logger

  /** Runtime-neutral Memory V2 configuration. Authority defaults from legacy mode (shadow when omitted). */
  memoryV2?: MemoryV2ClientConfig

  /** Overall wall-clock timeout for a single run, in milliseconds. When set,
   *  the returned promise settles with an error RunState if the run has not
   *  completed within this duration, so a silent network drop can no longer
   *  hang the caller forever. Default: disabled (undefined). The timer is
   *  unref'd so it won't keep a host process alive on its own; it still fires
   *  while the event loop is busy with the active run. */
  runTimeoutMs?: number

  /**
   * P1-T3 backend seam. Optional pluggable execution backend for
   * `OpenbuffClient.run()`. When omitted, the in-process backend (today's
   * `run()`) is used and behavior is byte-identical to before. Supplying a
   * backend (e.g. `AcpRemoteBackend`) routes the run through it instead, so a
   * host can attach to a live `openbuff serve` session. Additive-optional.
   */
  backend?: import('./client/backend').ClientBackend

  /** P2-T2: append-only run-journal writer (see createRunJournal in
   *  @codebuff/agent-runtime/util/run-journal). Threaded into the agent
   *  runtime deps so the run loop journals tool_call/tool_result/step
   *  boundaries for crash-safe resume. Additive-optional: a run without it
   *  is byte-identical to today (no journaling occurs). */
  journalWriter?: JournalWriter

  /** P2-T2: run-journal reader threaded into the agent runtime deps so the
   *  existing guarded block in runAgentStep classifies/replays interrupted
   *  prior work, and so the §4c replay short-circuit reuses journaled tool
   *  results (keyed deterministically by toolName+input per P2-T2-DESIGN §5,
   *  never by the freshly-minted toolCallId). Additive-optional. */
  journalReader?: JournalReader
}

export type FilesystemMutationEvent = {
  toolName: string
  callId: string
  operationId: string
  receiptId?: string
  workspaceRevision: number
  workspaceSnapshotId: string
  actions: Array<{
    action: 'create' | 'update' | 'delete' | 'move'
    path: string
    destinationPath?: string
    beforeHash: string | null
    afterHash: string | null
  }>
}

/** @deprecated Use `OpenbuffClientOptions` instead. Kept as a compatibility
 * alias so existing imports continue to resolve after the SDK rename. */
export type CodebuffClientOptions = OpenbuffClientOptions

export type ImageContent = {
  type: 'image'
  image: string // base64 encoded
  mediaType: string
}

export type TextContent = {
  type: 'text'
  text: string
}

export type MessageContent = TextContent | ImageContent

export type RunOptions = {
  agent: string | AgentDefinition
  prompt: string
  /** Content array for multimodal messages (text + images) */
  content?: MessageContent[]
  params?: Record<string, any>
  previousRun?: RunState
  extraToolResults?: ToolMessage[]
  signal?: AbortSignal
  costMode?: string
  /** Extra key/values merged into each LLM request's `codebuff_metadata`.
   *  Used by hosts (e.g. the CLI) to forward client-scoped identifiers or
   *  provider-routing metadata that downstream adapters read from the request body. */
  extraCodebuffMetadata?: Record<string, string>

  /** P2-3: Mid-turn checkpoint callback. When provided, the main agent loop
   *  invokes it with a snapshot of `mainAgentState` after each step boundary,
   *  time-throttled (30s), so a crashed/killed session can resume mid-turn from
   *  the last checkpoint rather than losing all in-flight work. The host (CLI)
   *  supplies a writer that persists atomically (temp file + rename). Failures
   *  inside the callback are caught and logged by the loop — they never kill
   *  the run. */
  onCheckpoint?: (agentState: SessionState['mainAgentState']) => void

  /** P2-3: When true, the user prompt is already present in
   *  `previousRun.sessionState.mainAgentState.messageHistory` (restored from a
   *  checkpoint), so the main agent loop must NOT re-append a USER_PROMPT
   *  message. The CLI sets this when it detects a valid checkpoint for the
   *  current turn and resumes from it. */
  resumeInterruptedTurn?: boolean
}

function executionRefusalFromError(error: unknown): { executionRefusal?: import('@codebuff/common/tools/params/execution-refusal').ExecutionRefusal } {
  const value = error && typeof error === 'object' && 'executionRefusal' in error ? error.executionRefusal : undefined
  const parsed = executionRefusalSchema.safeParse(value)
  return parsed.success ? { executionRefusal: parsed.data } : {}
}

const createAbortError = (signal?: AbortSignal) => {
  if (signal?.reason instanceof Error) {
    return signal.reason
  }
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

/**
 * `path.relative`-based containment, the convention used throughout this
 * codebase. `startsWith` is treated as a bug here: a sibling directory such as
 * `<configDir>-evil` shares the prefix but is NOT contained.
 */
function isPathInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(
    path.resolve(directory),
    path.resolve(candidate),
  )
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  )
}

/** Outcome of the ER-1 `readableRoots` trust gate. */
export type TrustedReadableRootsSelection = {
  /** Roots that may be registered with the external read allowlist. */
  trusted: string[]
  /**
   * How many ABSOLUTE roots were dropped for untrusted provenance. Reported as
   * a count only, never as paths: a user's home-directory paths are mildly
   * sensitive and the warning that carries this may be shared.
   */
  untrustedCount: number
}

/**
 * ER-1 trust gate for `readableRoots`, extracted as a PURE function so the
 * decision that lets a cloned repository allowlist credential directories is
 * directly testable (see `sdk/src/__tests__/model-provider.test.ts`).
 *
 * TRUSTED: the root's declaring config file lives inside `configDir`
 *   (user-owned). Always registered.
 * UNTRUSTED: declared anywhere else (project or ancestor `openbuff.json`), or
 *   with no recorded provenance at all — fail CLOSED and drop it unless
 *   `trustProjectRoots` (OPENBUFF_TRUST_PROJECT_READABLE_ROOTS=1) is set.
 *
 * Relative entries are dropped rather than guessed — the declaring config may
 * be a global file loaded from an unrelated directory, so anchoring to
 * `process.cwd()` could allowlist something the user never intended — and they
 * are NOT counted as untrusted, since nothing was refused on trust grounds.
 */
export function selectTrustedReadableRoots(params: {
  roots: readonly string[]
  sources: Record<string, string>
  configDir: string
  trustProjectRoots: boolean
}): TrustedReadableRootsSelection {
  const { roots, sources, configDir, trustProjectRoots } = params
  const trusted: string[] = []
  let untrustedCount = 0
  for (const root of roots) {
    if (!path.isAbsolute(root)) continue
    const sourceFile = sources[path.resolve(root)]
    if (sourceFile && isPathInsideDirectory(configDir, sourceFile)) {
      trusted.push(root)
      continue
    }
    if (trustProjectRoots) {
      trusted.push(root)
      continue
    }
    untrustedCount++
  }
  return { trusted, untrustedCount }
}

async function executeOverride<TInput, TV0Output, TV1Output>({
  override,
  input,
  signal,
  executionContext,
}: {
  override: OverrideDescriptor<TInput, TV0Output, TV1Output>
  input: TInput
  signal: AbortSignal
  executionContext?: ExecutionAdapterContext
}): Promise<TV0Output | TV1Output> {
  if (signal.aborted) {
    throw createAbortError(signal)
  }

  const execution: Promise<TV0Output | TV1Output> = (async () => {
    if (typeof override === 'function') {
      return override(input)
    }
    if (override.version === 'v1') {
      return override.execute(input, { abiVersion: 'v1', signal, execution: executionContext })
    }
    return override.execute(input)
  })()

  return raceAgainstAbort(execution, signal)
}

function raceAgainstAbort<T>(
  execution: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(createAbortError(signal))
  }

  // A legacy v0 override may ignore cancellation. Racing it lets the native
  // scheduler unwind while deliberately suppressing any late self-reported
  // result. The external side effect remains unconfirmed by contract.
  const abort = new Promise<never>((_, reject) => {
    const rejectOnAbort = () => reject(createAbortError(signal))
    if (signal.aborted) {
      rejectOnAbort()
      return
    }
    signal.addEventListener('abort', rejectOnAbort, { once: true })
    void execution.then(
      () => signal.removeEventListener('abort', rejectOnAbort),
      () => signal.removeEventListener('abort', rejectOnAbort),
    )
  })

  return Promise.race([execution, abort])
}

/**
 * File moves recorded in the workspace journal, oldest-last, used to rebind
 * persisted task-memory evidence paths across sessions. Bounded defensively.
 */
export function collectWorkspaceMoves(
  workspaceJournal: WorkspaceJournalService | undefined,
): { from: string; to: string }[] {
  if (!workspaceJournal) return []
  try {
    const moves: { from: string; to: string }[] = []
    for (const record of workspaceJournal.read().changes) {
      for (const action of record.actions) {
        if (action.action === 'move' && action.path && action.destinationPath) {
          moves.push({ from: action.path, to: action.destinationPath })
        }
      }
    }
    return moves.slice(-64)
  } catch {
    return []
  }
}

/**
 * Post-run persistence gate for cross-session task memory. Persists whenever a
 * `cwd` is set and the run produced task memory, regardless of `output.type`:
 * cancelled and aborted runs always carry an `error` output, and gating on that
 * threw away everything a Ctrl-C'd session learned. This is safe because the
 * value is a committed `TaskMemoryV1` produced by `commitTaskMemory` from work
 * that actually happened, and `saveMergedTaskMemory` merges rather than
 * overwrites — so a partial session contributes what it learned instead of
 * discarding it. Do not restore an `output.type === 'error'` early return.
 * Failures log at debug and never propagate. Exported for tests.
 */
export async function persistRunTaskMemory(params: {
  cwd?: string
  terminalState: RunState
  priorMemory?: TaskMemoryV1
  /** Run filesystem so saves honor injected/virtual-fs hosts like hydration does. */
  fs?: CodebuffFileSystem
  logger?: { debug?: (obj: unknown, message: string) => void }
}): Promise<TaskMemoryV1 | undefined> {
  const { cwd, terminalState, priorMemory, logger } = params
  if (!cwd || !terminalState.sessionState?.mainAgentState.taskMemory) {
    return undefined
  }
  try {
    // Route store IO through the same resolved filesystem hydration used,
    // mirroring initialSessionState, so virtual-fs hosts keep .openbuff/memory
    // inside their abstraction instead of writing it to real disk.
    return await saveMergedTaskMemory({
      rootDir: cwd,
      runMemory: terminalState.sessionState.mainAgentState.taskMemory,
      priorMemory,
      fs: params.fs ? codebuffFsToNodePromises(params.fs) : undefined,
    })
  } catch (error) {
    logger?.debug?.({ error }, 'Failed to persist task memory')
    return undefined
  }
}

type RunExecutionOptions = RunOptions &
  OpenbuffClientOptions & {
    apiKey: string
    fingerprintId: string
  }
type RunReturnType = RunState

/**
 * P2-T5: guards the once-per-process startup recovery of interrupted
 * multi-file transactions, keyed by state dir + intent-log file so two
 * concurrent projects in one process each recover exactly once.
 */
const transactionRecoveryPerformed = new Set<string>()

/**
 * P3-T10: guards the once-per-process registration of the bundled exact
 * token providers (registerBundledExactTokenProviders in
 * @codebuff/agent-runtime/util/exact-token-providers). Flipped only once a
 * run actually finds the OPENBUFF_EXACT_TOKENS gate ON, so flag-off runs
 * leave it false — a later run that turns the gate on still registers —
 * while consecutive gated runs never repeat the dynamic import. The
 * provider module is itself idempotent; this guard only avoids redundant
 * import attempts.
 */
let exactTokenProvidersRegistrationAttempted = false

export async function run(options: RunExecutionOptions): Promise<RunState> {
  options = Object.freeze({ ...options, env: options.env && Object.freeze({ ...options.env }),
    executionProfile: options.executionProfile && Object.freeze({ ...options.executionProfile,
      required: Object.freeze([...options.executionProfile.required]) }) })
  const { signal } = options

  if (signal?.aborted) {
    const abortError = createAbortError(signal)
    return projectRunOutcomes(
      {
        sessionState: options.previousRun?.sessionState,
        output: {
          type: 'error',
          message: abortError.message,
        },
      },
      {
        runOutcome: {
          termination: 'cancelled',
          cause: { code: 'run_cancelled', message: abortError.message },
        },
        taskAcceptance: { status: 'unknown' },
      },
    )
  }

  const limit = executionLimitMs(options.runTimeoutMs)
  const boundary = limit.ok ? captureRootDeadline({ clock: executionClock, limit: limit.value }) : limit
  const refusalState = (message: string, termination: RunOutcome['termination'], code: string, sessionState = options.previousRun?.sessionState) =>
    projectRunOutcomes({ sessionState: sessionState ? cloneDeep(sessionState) : undefined, output: { type: 'error', message } },
      { runOutcome: { termination, cause: { code, message } }, taskAcceptance: { status: 'unknown' } })
  if (!boundary.ok) return refusalState(boundary.cause,
    boundary.reason === 'deadline-exhausted' ? 'deadline_exhausted' : 'failed', `execution_${boundary.reason}`)
  // Capture the absolute root deadline before this synchronous configuration read.
  const requestedRoot = path.resolve(options.cwd ?? '.')
  const inputs = options.hostConfiguration ?? captureAmbientHostInputs({
    cwd: requestedRoot, projectRoot: requestedRoot,
  })
  const captured = loadHostConfigSnapshot({ inputs, fs: options.configReadFs ?? nodeConfigReadFs })
  if (captured.status !== 'complete') return refusalState(captured.cause, 'failed', 'host_configuration_unavailable')
  const snapshot = captured.snapshot
  if (options.cwd !== undefined && requestedRoot !== snapshot.inputs.projectRoot)
    return refusalState('Run cwd differs from the captured project root', 'failed', 'execution_invalid_context')
  let spawn: CodebuffSpawn = (command, args = [], spawnOptions) => nodeSpawn(command, [...args], spawnOptions ?? {})
  let approvalResolver: HostExecutionOptions['resolveApprovalContext']
  let basisResolver: HostExecutionOptions['isCurrentBasis']
  let activeSession: SessionState | undefined
  let cancellationReady = false
  const completion = new AbortController()
  let disposeMcp: (() => Promise<void>) | undefined
  const services = createHostExecutionServices({
    snapshot, boundary: boundary.value,
    childInheritanceEnvironment: { ...snapshot.inputs.environment }, env: options.env ? { ...options.env } : {},
    inheritEnv: options.inheritEnv, signal: signal ? AbortSignal.any([signal, completion.signal]) : completion.signal,
    profile: options.executionProfile,
    spawn: (command, args, spawnOptions) => spawn(command, args, spawnOptions),
    credentials: options.credentials, record: options.recordExecution,
    approvalMode: options.approvalMode, requestApproval: options.requestApproval,
    resolveApprovalContext: input => approvalResolver?.(input) ?? Promise.resolve(undefined),
    isCurrentBasis: correlation => correlation.kind !== 'action' || basisResolver?.(correlation) === true,
  })
  if (!services.ok) return refusalState(services.cause,
    services.reason === 'deadline-exhausted' ? 'deadline_exhausted' : services.reason === 'cancelled' ? 'cancelled' : 'failed',
    `execution_${services.reason}`)
  const hostServices = services.value
  // Workspace discovery stays opt-in; session metadata uses the captured root.
  const capturedOptions = { ...options,
    cwd: options.cwd !== undefined || options.hostConfiguration !== undefined
      ? snapshot.inputs.projectRoot : undefined,
    skillsDir: options.skillsDir === undefined ? undefined : path.resolve(snapshot.inputs.invocationCwd, options.skillsDir),
    env: options.env ? { ...options.env } : undefined, signal: hostServices.rootSignal }
  try {
    const execution = runOnce(capturedOptions, {
      snapshot, hostServices, setSpawn: value => { spawn = value },
      profileExplicitlySelected: options.executionProfile !== undefined,
      setApprovalResolver: value => { approvalResolver = value },
      setBasisResolver: value => { basisResolver = value },
      onSessionReady: value => { activeSession = value },
      onCancellationReady: () => { cancellationReady = true },
      onMcpReady: value => { disposeMcp = value },
    })
    return await raceAgainstAbort(execution, hostServices.rootSignal).catch(async (error) => {
      if (!hostServices.rootSignal.aborted || !cancellationReady) throw error
      // Startup dependencies remain abortable. Once the runtime owns
      // cancellation, wait for its tools, callbacks and cleanup to settle so
      // the public result retains their final history and action outcomes.
      const state = await execution
      const exhausted = isExecutionDeadlineSignal(hostServices.rootSignal)
      const message = exhausted
        ? `Run timed out after ${options.runTimeoutMs}ms`
        : createAbortError(hostServices.rootSignal).message
      return projectRunOutcomes({ ...state, output: { type: 'error', message } }, {
        runOutcome: {
          termination: exhausted ? 'deadline_exhausted' : 'cancelled',
          cause: { code: exhausted ? 'run_deadline_exhausted' : 'run_cancelled', message },
        },
        taskAcceptance: { status: 'unknown' },
      })
    })
  } catch (error) {
    const exhausted = isExecutionDeadlineSignal(hostServices.rootSignal)
    const message = exhausted ? `Run timed out after ${options.runTimeoutMs}ms` : error instanceof Error ? error.message : String(error)
    return refusalState(message, exhausted ? 'deadline_exhausted' : hostServices.rootSignal.aborted ? 'cancelled' : 'failed',
      exhausted ? 'run_deadline_exhausted' : hostServices.rootSignal.aborted ? 'run_cancelled' : 'run_setup_failed', activeSession)
  } finally {
    // End the authenticated root lifetime on every terminal path. Explicitly
    // transferred resources retain their receiver lifetime and finite cap.
    completion.abort(new Error('Run execution scope completed'))
    try {
      await disposeMcp?.()
    } catch (error) {
      options.logger?.warn({ error }, 'Run-owned MCP cleanup failed')
    }
  }
}

type RunHostBootstrap = {
  snapshot: HostConfigSnapshot
  hostServices: RunHostServices
  profileExplicitlySelected: boolean
  setSpawn(spawn: CodebuffSpawn): void
  setApprovalResolver(resolver: NonNullable<HostExecutionOptions['resolveApprovalContext']>): void
  setBasisResolver(resolver: NonNullable<HostExecutionOptions['isCurrentBasis']>): void
  onSessionReady(state: SessionState): void
  onCancellationReady(): void
  onMcpReady(dispose: () => Promise<void>): void
}

async function runOnce({
  apiKey,
  fingerprintId,

  cwd,
  skillsDir,
  projectFiles,
  projectContextMode,
  knowledgeFiles,
  userKnowledgeFiles,
  agentDefinitions,
  mcpServers,
  maxAgentSteps = MAX_AGENT_STEPS_DEFAULT,
  // No default: omitted means unlimited missing-output retries, mirroring
  // the runtime knob's undefined → unlimited contract.
  maxMissingOutputRetries,
  env,
  inheritEnv = true,
  harnessStateDir,
  approvalReceiptIds = [],
  approvalMode = 'balanced',
  requestApproval,
  runTimeoutMs,

  handleEvent,
  handleStreamChunk,

  fileFilter,
  filesystemPolicy,
  overrideTools,
  customToolDefinitions,
  onFilesChanged,
  onFilesystemMutation,
  verifyExternalMutation,

  fsSource,
  spawnSource,
  logger,
  memoryV2,
  journalWriter,
  journalReader,

  agent,
  prompt,
  content,
  params,
  previousRun,
  extraToolResults,
  signal,
  costMode,
  extraCodebuffMetadata,
  onCheckpoint,
  resumeInterruptedTurn,
}: RunExecutionOptions, host: RunHostBootstrap): Promise<RunState> {
  const { snapshot, hostServices } = host
  const contextCwd = snapshot.inputs.projectRoot
  const hostEnvironment = snapshot.inputs.environment
  const homeDir = snapshot.inputs.home.kind === 'path'
    ? path.resolve(snapshot.inputs.invocationCwd, snapshot.inputs.home.path)
    : null
  const includeGlobalSkills = snapshot.inputs.globals.kind === 'directory'
  const loadedProviderConfig = getCapturedProviderConfig(snapshot)
  const capturedHookConfiguration: CapturedHookConfiguration = Object.freeze({
    autoFileChangeHooks: loadedProviderConfig.config.autoFileChangeHooks === true,
    fileChangeHooks: Object.freeze(loadedProviderConfig.config.fileChangeHooks.map(hook => Object.freeze({ ...hook }))),
  })
  const diagnosticPreflightEnabled = isDiagnosticPreflightEnabled(hostEnvironment)
  // P3-T10: register the bundled OpenAI-family exact tokenizers when the
  // OPENBUFF_EXACT_TOKENS gate is on. This is the FIRST thing the run does
  // so no token count in the run can precede registration, and the dynamic
  // import below is the ONLY import of the provider module — and therefore
  // of tiktoken's WASM — so a flag-off run never loads it and token counting
  // stays byte-identical (the gpt-tokenizer estimator). The gate uses the
  // same truthy-set rule as the counter's per-call gate in
  // @codebuff/agent-runtime/util/token-counter and is read from the raw
  // process env through the same accessor the other OPENBUFF_* trust flags
  // use, so the seam and the counter agree on when the providers are live.
  // Once-per-process via the module-level guard; a registration failure is
  // logged and degrades to the estimator (the seam's own fallback) instead
  // of failing the run.
  if (!exactTokenProvidersRegistrationAttempted) {
    const exactTokensEnv = hostEnvironment.OPENBUFF_EXACT_TOKENS
    if (
      exactTokensEnv !== undefined &&
      /^(1|true|yes|on)$/i.test(exactTokensEnv.trim())
    ) {
      exactTokenProvidersRegistrationAttempted = true
      try {
        const { registerBundledExactTokenProviders } =
          await import('@codebuff/agent-runtime/util/exact-token-providers')
        registerBundledExactTokenProviders()
      } catch (error) {
        logger?.warn(
          { error },
          'Exact token provider registration failed; keeping the estimator',
        )
      }
    }
  }
  const resolvedHarnessStateDir = harnessStateDir !== undefined
    ? path.resolve(snapshot.inputs.invocationCwd, harnessStateDir)
    : snapshot.configDir ? path.join(snapshot.configDir, 'state', 'harness') : undefined
  let spawn: CodebuffSpawn
  if (spawnSource !== undefined) {
    spawn = await raceAgainstAbort(Promise.resolve(spawnSource), hostServices.rootSignal)
    if (typeof spawn !== 'function') throw new ExecutionRefusalError({ ok: false, reason: 'invalid-context', cause: 'Injected spawn dependency is not callable' })
  } else {
    spawn = (command, args = [], spawnOptions) => nodeSpawn(command, [...args], spawnOptions ?? {})
  }
  host.setSpawn(spawn)
  hostServices.rootSignal.throwIfAborted()
  let fs: CodebuffFileSystem
  if (fsSource !== undefined) {
    const fsSourceValue = typeof fsSource === 'function' ? fsSource() : fsSource
    fs = await fsSourceValue
  } else if (cwd && resolvedHarnessStateDir) {
    try {
      const mutationBroker = await WorkspaceMutationBroker.create({
        cwd,
        stateDir: resolvedHarnessStateDir,
        executionContext: hostServices.bootstrap,
      })
      fs = createNodeFileSystem({ mutationBroker })
    } catch (error) {
      if (isExecutionRefusalError(error)) throw error
      logger?.warn(
        { error },
        'Workspace mutation broker unavailable; guarded mutations will fail closed',
      )
      fs = createNodeFileSystem()
    }
  } else {
    fs = createNodeFileSystem()
  }
  hostServices.rootSignal.throwIfAborted()
  fs = bindHostFileSystem(fs, hostServices.readPolicy)

  // P2-T5: startup recovery of interrupted multi-file transactions. The
  // intent log is colocated with the harness state dir (outside the project
  // tree it guards) and scoped to this workspace. Best-effort and
  // once-per-process: failures are logged and never crash startup.
  let intentLog: TransactionIntentLog | undefined
  if (cwd && resolvedHarnessStateDir) {
    intentLog = createTransactionIntentLogForWorkspace({
      stateDir: resolvedHarnessStateDir,
      cwd,
    })
    const recoveryKey = `${resolvedHarnessStateDir}\u0000${intentLog.filePath}`
    if (!transactionRecoveryPerformed.has(recoveryKey)) {
      transactionRecoveryPerformed.add(recoveryKey)
      try {
        await recoverAndRevertInterruptedTransactions({
          intentLog,
          cwd,
          fs,
          logger,
        })
      } catch (error) {
        logger?.warn(
          { error },
          'Transaction intent recovery failed; startup continues',
        )
      }
    }
  }
  // Audit fix (B): production diagnostic-delta preflight wiring. The runner
  // executes diagnostic commands as argv arrays over this run's child-process
  // seam (never a shell), and the injector is fail-open. The
  // OPENBUFF_DIAGNOSTIC_PREFLIGHT flag check lives inside runFileChangeHooks,
  // so passing the injector unconditionally keeps flag-off behavior
  // byte-identical.
  // One retained baseline per run, scoped to a confirmed mutation's postimage.
  let diagnosticBaselineEpoch = 0
  let pendingDiagnosticBaseline:
    | {
        capture: DiagnosticCapture
        cwd: string
        files: string[]
        mutationCallId: string
        workspaceRevision: number
        workspaceSnapshotId: string
        afterHashes: Record<string, string | null>
        invalidReason?: string
      }
    | undefined
  const diagnosticDeltaHook = createDiagnosticDeltaHook({
    spawn,
    deltaMode: hostEnvironment.OPENBUFF_DIAGNOSTIC_DELTA_MODE?.toLowerCase() === 'strict' ? 'strict' : 'tolerant',
    getBaseline: async ({ files, cwd: hookCwd, signal: hookSignal }) => {
      const pending = pendingDiagnosticBaseline
      if (!pending) return undefined
      const workspace = sessionState.mainAgentState.workspaceState
      const requested = diagnosticFileSet(hookCwd, files)
      if (
        !pending.invalidReason &&
        (path.resolve(hookCwd) !== pending.cwd ||
          workspace?.revision !== pending.workspaceRevision ||
          workspace?.snapshotId !== pending.workspaceSnapshotId ||
          requested.length !== pending.files.length ||
          requested.some((file, index) => file !== pending.files[index]) ||
          !(await diagnosticPostimageMatches({
            fs,
            hashes: pending.afterHashes,
            signal: hookSignal,
          })))
      ) {
        pending.invalidReason = 'baseline_postimage_or_scope_unverified'
      }
      if (pending.invalidReason) {
        return {
          ...pending.capture,
          coverage: {
            ...pending.capture.coverage,
            status: 'unknown' as const,
            unobservedFiles: [...pending.capture.coverage.requestedFiles],
            reasons: [
              ...pending.capture.coverage.reasons,
              pending.invalidReason,
            ],
          },
        }
      }
      return pending.capture
    },
  })
  // Audit fix (D): the pre-edit baseline capture below runs through the SAME
  // argv-array child-process seam (its own stateless adapter instance — the
  // runner holds no state), bounded exactly like the hook's own captures.
  const diagnosticBaselineRunner = createDiagnosticCommandRunner({ spawn })
  const preparedContent = wrapContentForUserMessage(content)

  // Per-run client session id (also the trusted process-job owner session).
  const promptId = Math.random().toString(36).substring(2, 15)

  // Init session state
  let agentId
  if (typeof agent !== 'string') {
    // cloneDeep, deliberately NOT the platform's structuredClone: an
    // AgentDefinition carries non-cloneable members — notably the `handleSteps`
    // generator function — and structuredClone throws DataCloneError on any
    // function value, whereas cloneDeep copies the object graph and preserves
    // them. lodash is therefore a deliberate RUNTIME dependency of this shipped
    // module (declared in sdk/package.json dependencies), not a convenience
    // import a built-in could replace.
    const clonedDefs = agentDefinitions ? cloneDeep(agentDefinitions) : []
    clonedDefs.forEach((definition, index) => {
      propagateMCPConfigOrigins(
        agentDefinitions?.[index].mcpServers,
        definition.mcpServers,
      )
    })
    agentDefinitions = [...clonedDefs, agent]
    agentId = agent.id
  } else {
    agentId = agent
  }
  let workspaceJournal = cwd && resolvedHarnessStateDir
    ? await WorkspaceJournalService.create({
        rootDir: resolvedHarnessStateDir,
        cwd,
        executionContext: hostServices.bootstrap,
      }).catch(error => {
        if (isExecutionRefusalError(error)) throw error
        logger?.warn({ error }, 'Workspace journal unavailable; continuing without a persisted journal')
        return undefined
      })
    : undefined
  // Moves recorded by prior sessions rebind persisted evidence paths during
  // task-memory hydration inside initialSessionState below.
  const persistedWorkspaceMoves = collectWorkspaceMoves(workspaceJournal)

  let sessionState: SessionState
  if (previousRun?.sessionState) {
    // applyOverridesToSessionState handles deep cloning and applying any provided overrides
    sessionState = await applyOverridesToSessionState(
      cwd,
      previousRun.sessionState,
      {
        contextCwd,
        homeDir,
        includeGlobalSkills,
        skillsDir,
        knowledgeFiles,
        userKnowledgeFiles,
        agentDefinitions,
        customToolDefinitions,
        projectFiles,
        projectContextMode,
        maxAgentSteps,
      },
      { fs, logger },
    )
  } else {
    // No previous run, so create a fresh session state
    const startup = hostServices.directOperation()
    if (!startup.ok) throw new ExecutionRefusalError(startup)
    sessionState = await initialSessionState({
      cwd,
      contextCwd,
      homeDir,
      includeGlobalSkills,
      skillsDir,
      knowledgeFiles,
      userKnowledgeFiles,
      agentDefinitions,
      customToolDefinitions,
      projectFiles,
      projectContextMode,
      maxAgentSteps,
      fs,
      spawn,
      executionContext: startup.value.executionContext,
      logger,
      workspaceMoves: persistedWorkspaceMoves,
    })
  }
  // A continued turn must not inherit the previous turn's terminal verdict.
  sessionState.mainAgentState.runOutcome = undefined
  sessionState.mainAgentState.taskAcceptance = { status: 'unknown' }
  host.onSessionReady(sessionState)
  // Merge host-supplied configs after session construction, retaining the
  // caller's origin marks. The host binding below snapshots each server and
  // gives JSON continuations an opaque reference to that exact origin/config.
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    const targetTemplate = sessionState.fileContext.agentTemplates?.[agentId]
    if (targetTemplate) {
      targetTemplate.mcpServers = {
        ...targetTemplate.mcpServers,
        ...mcpServers,
      }
      // These replacements come from the host's explicit run options. Retire
      // only their old references; retained JSON state still cannot retarget a
      // bound config, and untouched siblings keep their original authority.
      if (targetTemplate.mcpServerReferences) {
        targetTemplate.mcpServerReferences = {
          ...targetTemplate.mcpServerReferences,
        }
        for (const serverName of Object.keys(mcpServers))
          delete targetTemplate.mcpServerReferences[serverName]
      }
    }
  }
  // A restored JSON context cannot select the expected project for authority
  // checks. The host run's cwd supplies that identity.
  const mcpProjectRoot = snapshot.inputs.projectRoot
  sessionState.fileContext.projectRoot = mcpProjectRoot
  const boundMcp = bindMcpSession({
    projectRoot: mcpProjectRoot,
    sessionReference: sessionState.fileContext.mcpSessionReference,
    templates: sessionState.fileContext.agentTemplates,
  })
  sessionState.fileContext.agentTemplates = boundMcp.templates
  sessionState.fileContext.mcpSessionReference = boundMcp.sessionReference
  const resolveRunMcpConfig = (params: {
    mcpConfig: MCPConfig
    mcpReference?: string
    mcpAgentId?: string
    mcpServerName?: string
  }): MCPConfig => {
    if (!params.mcpReference) return params.mcpConfig
    const sessionReference = sessionState.fileContext.mcpSessionReference
    if (!sessionReference)
      throw new Error('MCP host session reference is unavailable.')
    return resolveMcpHostBinding({
      ...params,
      projectRoot: mcpProjectRoot,
      sessionReference,
    }).config
  }
  // Snapshot the hydrated task memory so post-run persistence can merge the
  // final memory into it. The runtime replaces this property rather than
  // mutating it in place, so holding the reference is sufficient.
  const hydratedTaskMemory = sessionState.mainAgentState.taskMemory
  const memoryV2Coordinator = memoryV2
    ? new MemoryV2Coordinator(memoryV2, logger)
    : undefined
  // Trusted ownership identity for every process-job operation. Derived
  // ONLY from trusted runtime state — NEVER from model or tool input — and
  // injected into check_job/kill_job/read_logs/list_jobs/run_terminal_command
  // below. `clientSessionId` comes from the stable per-process session seed
  // (see getTrustedSessionClientId), NOT from the per-turn promptId, so
  // ownership survives across consecutive turns of the same client session.
  const trustedJobOwner: JobOwner = {
    clientSessionId: getTrustedSessionClientId(),
    get rootRunId() { return sessionState.mainAgentState.runId ?? sessionState.mainAgentState.agentId },
    get parentRunId() { return sessionState.mainAgentState.runId ?? sessionState.mainAgentState.agentId },
    parentAgentId: sessionState.mainAgentState.agentId,
  }
  const registeredActors = new Map<string, { actor: ExecutionActor; parentContext?: ExecutionAdapterContext;
    parentActor?: ExecutionActor; ancestors: readonly string[] }>()
  const executionScopes = new Map<string, ExecutionScope>()
  const actionContexts = new Map<string, ExecutionAdapterContext>()
  const actionStarts = new Map<string, { identity: ToolExecutionIdentity; toolName: string; context: ExecutionAdapterContext;
    scope: ExecutionScope; workspaceBasis: ActionWorkspaceBasis }>()
  const executionScopeRegistry = createExecutionScopeRegistry(hostServices.execution)
  const rememberExecutionScope = (context: ExecutionAdapterContext, scope: ExecutionScope) => {
    const registered = executionScopeRegistry.register(context.execution, scope)
    if (!registered.ok) throw new ExecutionRefusalError(registered)
  }
  const internalOperationActors = new Map<string, ExecutionActor>()
  const internalActorContexts = new Map<string, ExecutionAdapterContext>()
  const actorKey = (actor: ExecutionActor) => JSON.stringify([actor.rootRunId, actor.runId, actor.agentId])
  const actionKey = (identity: ToolExecutionIdentity) => JSON.stringify([trustedJobOwner.clientSessionId,
    identity.rootRunId, identity.runId, identity.agentId, identity.actionId, identity.attemptId])
  const correlationKey = (correlation: Extract<PolicyInput['facts']['correlation'], { kind: 'action' }>) =>
    JSON.stringify([correlation.owner.clientSessionId, correlation.owner.rootRunId, correlation.owner.parentRunId,
      correlation.owner.parentAgentId, correlation.actionId, correlation.attemptId])
  const registerExecutionActor: NonNullable<Parameters<typeof getAgentRuntimeImpl>[0]['registerExecutionActor']> = ({ actor, parentActor, executionContext, ancestorRunIds }) => {
    if (Object.values(actor).some(value => typeof value !== 'string' || !value || value.includes('\0')))
      throw new ExecutionRefusalError({ ok: false, reason: 'invalid-context', cause: 'Invalid runtime actor registration' })
    const parent = parentActor ? registeredActors.get(actorKey(parentActor)) : undefined
    const expectedAncestors = parent ? [...parent.ancestors, parent.actor.runId] : []
    if (!Array.isArray(ancestorRunIds) || JSON.stringify(ancestorRunIds) !== JSON.stringify(expectedAncestors) ||
      ancestorRunIds.includes(actor.runId))
      throw new ExecutionRefusalError({ ok: false, reason: 'stale-authority', cause: 'Runtime actor ancestry does not match its registered parent' })
    if (parentActor) {
      if (!parent || actor.rootRunId !== parentActor.rootRunId || !executionContext)
        throw new ExecutionRefusalError({ ok: false, reason: 'stale-authority', cause: 'Runtime parent actor is unavailable' })
    } else if (actor.rootRunId !== actor.runId || actor.agentId !== sessionState.mainAgentState.agentId || executionContext) {
      throw new ExecutionRefusalError({ ok: false, reason: 'stale-authority', cause: 'Runtime root actor does not match this run' })
    }
    if (executionContext) {
      const registered = hostServices.execution.actionRegistration(executionContext.execution)
      if (!registered.ok) throw new ExecutionRefusalError(registered)
      const correlation = registered.value.correlation
      const source = correlation.kind === 'action' ? actionStarts.get(correlationKey(correlation)) : undefined
      const operationActor = correlation.kind === 'host-operation' ? internalOperationActors.get(correlation.operationId) : undefined
      const contextActor = source && correlation.kind === 'action' && source.identity.basisId === correlation.basisId
        ? source.identity : operationActor
      if (!contextActor || contextActor.rootRunId !== actor.rootRunId || !ancestorRunIds.includes(contextActor.runId))
        throw new ExecutionRefusalError({ ok: false, reason: 'stale-authority', cause: 'Runtime parent context lacks registered action or internal-operation ancestry' })
    }
    const key = actorKey(actor)
    const existing = registeredActors.get(key)
    if (existing && (existing.parentContext?.execution !== executionContext?.execution ||
      (existing.parentActor && actorKey(existing.parentActor)) !== (parentActor && actorKey(parentActor)) ||
      JSON.stringify(existing.ancestors) !== JSON.stringify(ancestorRunIds)))
      throw new ExecutionRefusalError({ ok: false, reason: 'stale-authority', cause: 'Runtime actor registration changed parent authority' })
    if (existing) return
    if ([...registeredActors.values()].some(value => value.actor.runId === actor.runId || value.actor.agentId === actor.agentId))
      throw new ExecutionRefusalError({ ok: false, reason: 'stale-authority', cause: 'Runtime actor identity is already registered' })
    registeredActors.set(key, { actor: Object.freeze({ ...actor }), parentActor: parentActor && Object.freeze({ ...parentActor }),
      parentContext: executionContext, ancestors: Object.freeze([...ancestorRunIds]) })
  }
  function scopeForActor(actor?: ExecutionActor): ExecutionScope {
    if (!actor) return hostServices.directScope
    const registeredActor = registeredActors.get(actorKey(actor))
    const owner = { clientSessionId: trustedJobOwner.clientSessionId, rootRunId: actor.rootRunId,
      parentRunId: actor.runId, parentAgentId: actor.agentId }
    if (!registeredActor || Object.values(owner).some(value => typeof value !== 'string' || !value || value.includes('\0')))
      throw new ExecutionRefusalError({ ok: false, reason: 'stale-authority', cause: 'Runtime actor is outside this root run' })
    const key = JSON.stringify(owner)
    let scope = executionScopes.get(key)
    if (!scope) {
      const registered = hostServices.registerRun(owner, registeredActor.parentContext)
      if (!registered.ok) throw new ExecutionRefusalError(registered)
      scope = registered.value
      executionScopes.set(key, scope)
    }
    return scope
  }
  function contextForRegisteredAction(identity: ToolExecutionIdentity): ExecutionAdapterContext {
    const start = actionStarts.get(actionKey(identity))
    if (!start || start.identity.basisId !== identity.basisId || start.identity.workspaceSnapshotId !== identity.workspaceSnapshotId ||
      start.identity.basis.inputHash !== identity.basis.inputHash || start.identity.basis.workspaceRevision !== identity.basis.workspaceRevision)
      throw new ExecutionRefusalError({ ok: false, reason: 'stale-authority', cause: 'Parent action is not registered under this exact B02 basis' })
    const registration = hostServices.execution.actionRegistration(start.context.execution)
    if (!registration.ok) throw new ExecutionRefusalError(registration)
    return start.context
  }
  function contextForInternalActor(actor: ExecutionActor): ExecutionAdapterContext {
    const key = actorKey(actor)
    const existing = internalActorContexts.get(key)
    if (existing) {
      const registration = hostServices.execution.actionRegistration(existing.execution)
      if (!registration.ok) throw new ExecutionRefusalError(registration)
      return existing
    }
    const scope = scopeForActor(actor)
    const registered = scope.operation({ signal: runSignal })
    if (!registered.ok) throw new ExecutionRefusalError(registered)
    const context = registered.value
    const registration = hostServices.execution.actionRegistration(context.execution)
    if (!registration.ok) throw new ExecutionRefusalError(registration)
    if (registration.value.correlation.kind !== 'host-operation')
      throw new ExecutionRefusalError({ ok: false, reason: 'invalid-context', cause: 'Internal actor operation has no authenticated host-operation origin' })
    internalActorContexts.set(key, context)
    internalOperationActors.set(registration.value.correlation.operationId, Object.freeze({ ...actor }))
    rememberExecutionScope(context, scope)
    return context
  }
  const processOptionsFor = (toolName: string, input: Record<string, any>) => {
    const terminal = toolName === 'run_terminal_command'
    const hooks = toolName === 'run_file_change_hooks' || toolName === 'run_targeted_validation'
    const processProfile = hostServices.bootstrap.profile
    const profile: ProfileRequest = (terminal || hooks) && !host.profileExplicitlySelected
      ? Object.freeze({ ...processProfile, policy: 'full-access' }) : processProfile
    const limit = executionLimitMs(terminal && typeof input.timeout_seconds === 'number'
      ? input.timeout_seconds === -1 ? -1 : input.timeout_seconds * 1000 : undefined)
    if (!limit.ok) throw new ExecutionRefusalError(limit)
    return { profile, limit: limit.value, mode: 'assistant' as const }
  }
  const onExecutionActionStart: NonNullable<Parameters<typeof getAgentRuntimeImpl>[0]['onExecutionActionStart']> = (start) => {
    const { identity, toolName } = start
    const expectedBasis = hashActionInput('openbuff.execution-b02-basis.v1', { basis: identity.basis,
      workspaceSnapshotId: identity.workspaceSnapshotId ?? null })
    if (identity.basis.inputHash !== hashActionInput(toolName, start.input) || identity.basisId !== expectedBasis)
      throw new ExecutionRefusalError({ ok: false, reason: 'invalid-context', cause: 'Runtime action basis does not match its original input' })
    const key = actionKey(identity)
    const old = actionStarts.get(key)
    if (old) {
      if (old.identity.basisId !== identity.basisId || old.toolName !== toolName)
        throw new ExecutionRefusalError({ ok: false, reason: 'stale-authority', cause: 'Runtime action identity changed basis' })
      return
    }
    const input = typeof start.input === 'string' ? parseJsonBounded(start.input) : start.input ?? {}
    const options = processOptionsFor(toolName, input as Record<string, any>)
    const scope = scopeForActor(identity)
    const signal = AbortSignal.any([runSignal, start.signal])
    const registered = scope.action({ actionId: identity.actionId, attemptId: identity.attemptId, basisId: identity.basisId,
      signal, limit: options.limit, profile: options.profile, mode: options.mode })
    if (!registered.ok) throw new ExecutionRefusalError(registered)
    const entry = { identity: Object.freeze({ ...identity, basis: Object.freeze({ ...identity.basis }) }), toolName,
      context: registered.value, scope, workspaceBasis: createActionWorkspaceBasis(identity, sessionState.mainAgentState.workspaceState) }
    actionStarts.set(key, entry)
    actionContexts.set(key, registered.value)
    rememberExecutionScope(registered.value, scope)
  }
  host.setBasisResolver(correlation => {
    if (correlation.kind !== 'action') return true
    const start = actionStarts.get(correlationKey(correlation))
    return !!start && start.workspaceBasis.isCurrent(correlation.basisId, sessionState.mainAgentState.workspaceState)
  })
  const backgroundReceiver = hostServices.createBackgroundReceiver(trustedJobOwner.clientSessionId)
  if (!backgroundReceiver.ok) throw new ExecutionRefusalError(backgroundReceiver)
  const mcpExecution = createRunMcpExecution({ snapshot, authority: hostServices.execution, rootLifetime: hostServices.rootLifetime, spawn })
  host.onMcpReady(mcpExecution.dispose)
  const capturedChromeSandboxArgs = Object.freeze(chromeSandboxArgs())
  let capturedChromeExecutable: string | undefined
  // M5: forward this run's own live background-job activity to the host via
  // handleEvent. Subscribe once here (never inside a loop) and dispose on
  // every terminal path so the process-wide registry singleton never leaks
  // dead listeners across runs. The disposer is idempotent.
  const unsubscribeJobEvents = jobRegistry.subscribeAll(
    createJobUpdateForwarder({
      owner: trustedJobOwner,
      handleEvent: (event) => handleEvent?.(event),
      shouldForward: () =>
        callbacksEnabled && !runSignal.aborted && !!handleEvent,
    }),
  )
  const approvalService = resolvedHarnessStateDir ? new HarnessApprovalService(
    new LocalHarnessStore(resolvedHarnessStateDir),
  ) : undefined
  const actionApprovalIds = new Map<string, readonly string[]>()
  host.setApprovalResolver(async (input: PolicyInput) => {
    const state = sessionState.mainAgentState.workspaceState
    const snapshotId = state?.snapshotId
    if (!snapshotId || !workspaceJournal || !approvalService) return undefined
    const context = input.facts.correlation.kind === 'action' ? actionContexts.get(correlationKey(input.facts.correlation)) : undefined
    let branch: string | undefined, defaultBranch: string | undefined
    if (input.classification.effects.some(effect => effect.action === 'push') && context) {
      const observed = await inspectWorkspace({ cwd: snapshot.inputs.projectRoot, signal: context.signal, executionContext: context })
      const value = observed[0]?.type === 'json' ? observed[0].value : undefined
      if (value && 'branch' in value) { branch = value.branch; defaultBranch = value.defaultBranch }
    }
    return { service: approvalService, repositoryId: workspaceJournal.repositoryId, workspaceId: workspaceJournal.workspaceId,
      runId: trustedJobOwner.rootRunId, snapshotId,
      receiptIds: input.facts.correlation.kind === 'action' ? actionApprovalIds.get(correlationKey(input.facts.correlation)) ?? approvalReceiptIds : approvalReceiptIds,
      branch, defaultBranch, isCurrent: () => sessionState.mainAgentState.workspaceState?.snapshotId === snapshotId &&
        !hostServices.rootSignal.aborted && !context?.signal?.aborted }
  })
  // P3-T2 (LI-01): lazily-built language-intelligence service shared across the
  // four LSP read tools. Only constructed when a language-intelligence client
  // tool actually fires, so a run that never uses them never spawns a server.
  let languageIntelligenceService: LanguageIntelligenceService | undefined
  const getLanguageIntelligence = (): LanguageIntelligenceService => {
    languageIntelligenceService ??= createLanguageIntelligence({
      cwd: requireCwd(cwd, 'language intelligence'),
      spawn,
      // Audit fix (fs splice): the semantic-edit splice and post-commit LSP
      // sync read through THIS run's filesystem, so a virtual-fs host
      // (fsSource / hydration) is spliced from the same bytes the mutation
      // broker commits — never raw host node disk.
      fs,
      readPolicy: hostServices.readPolicy,
      resourceFactory: (spec, request) => {
        const scope = executionScopeRegistry.resolve(request.execution)
        return scope.ok ? scope.value.lspResources(spec, request) : scope
      },
    })
    return languageIntelligenceService
  }
  if (workspaceJournal) {
    try {
      const persistedWorkspace = workspaceJournal.read()
      const currentRevision =
        sessionState.mainAgentState.workspaceState?.revision ?? -1
      if (persistedWorkspace.revision > currentRevision) {
        sessionState.mainAgentState.workspaceState = persistedWorkspace
        sessionState.mainAgentState.readAuthorizationsByPath = {}
        sessionState.mainAgentState.readAuthorizationHashesByPath = {}
        sessionState.mainAgentState.rawReadAuthorizationHashesByPath = {}
        sessionState.mainAgentState.confirmedPostEditAnchorsByPath = {}
      }
    } catch (error) {
      logger?.warn(
        { error },
        'Workspace journal unavailable; continuing with in-memory workspace state',
      )
      workspaceJournal = undefined
    }
  }

  // The combined run signal and the run timeout arm HERE, before memory
  // preparation, so a slow or hung Memory V2 repository is bounded by the run
  // timeout instead of extending it
  // (reliability:memory-preparation-is-outside-timeout).
  const timeoutAbortController = new AbortController()
  const runSignal = AbortSignal.any([hostServices.rootSignal, timeoutAbortController.signal])
  let terminalRequested = false
  let callbacksEnabled = true
  let callbackQueue: Promise<void> = Promise.resolve()
  let callbackFailure: unknown
  let runDeadlineExceeded = false
  const markRootDeadline = () => { runDeadlineExceeded = isExecutionDeadlineSignal(hostServices.rootSignal) }
  hostServices.rootSignal.addEventListener('abort', markRootDeadline, { once: true })
  let resolveTerminal: (value: RunReturnType) => void = () => {}
  const terminalPromise = new Promise<RunReturnType>((res) => {
    resolveTerminal = (value) => {
      if (terminalRequested) return
      terminalRequested = true
      res(projectRunOutcomes(value))
    }
  })

  const abortRun = (reason: unknown) => {
    if (!timeoutAbortController.signal.aborted) {
      timeoutAbortController.abort(reason)
    }
  }
  const enqueueCallback = (callback: () => void | Promise<void>) => {
    const queued = callbackQueue.then(callback)
    callbackQueue = queued.catch((error) => {
      callbackFailure ??= error
      logger?.error({ error }, 'Openbuff client event callback failed')
    })
    return callbackQueue
  }
  async function onError(error: { message: string }) {
    if (callbacksEnabled && !runSignal.aborted && handleEvent) {
      await handleEvent({ type: 'error', message: error.message })
    }
  }

  // The agent runtime mutates sessionState.mainAgentState as it progresses,
  // replacing messageHistory with a new array once it adds the user prompt.
  // Comparing array identity detects progress more robustly than length:
  // context pruning could shrink history below its starting length without
  // meaning the runtime never ran.
  const initialMessageHistory = sessionState.mainAgentState.messageHistory

  /** Calculates the current session state if cancelled.
   *
   * This is used when callMainPrompt throws an error. If the agent runtime made
   * any progress (replaced the shared messageHistory), those messages are
   * preserved. Otherwise the user's message is added so it isn't lost.
   */
  function getCancelledSessionState(message: string): SessionState {
    const runtimeMadeProgress =
      sessionState.mainAgentState.messageHistory !== initialMessageHistory

    const state = structuredClone(sessionState)

    // Only add the user's message if the runtime didn't get a chance to add it.
    if (!runtimeMadeProgress && (prompt || preparedContent)) {
      state.mainAgentState.messageHistory.push({
        role: 'user' as const,
        content: buildUserMessageContent(prompt, params, preparedContent),
        tags: ['USER_PROMPT'] as string[],
      })
    }

    // Add error context message
    state.mainAgentState.messageHistory.push({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: withSystemTags(message) }],
    })
    return state
  }
  function getCancelledRunState(
    message?: string,
    termination: RunOutcome['termination'] = runDeadlineExceeded
      ? 'deadline_exhausted'
      : 'cancelled',
  ): RunState {
    message = message ?? 'Run cancelled by user.'
    return projectRunOutcomes(
      {
        sessionState: getCancelledSessionState(message),
        output: {
          type: 'error',
          message,
        },
      },
      {
        runOutcome: {
          termination,
          cause: { code: `run_${termination}`, message },
        },
      },
    )
  }

  host.onCancellationReady()

  // Race memory preparation against the run signal: an abort (user cancel or
  // run timeout) rejects here and the run proceeds through its normal
  // degraded/cancelled paths instead of hanging or crashing. prepareTurn
  // itself never rejects — its own failures degrade the turn internally — so
  // the caught rejection below can only come from the abort race.
  if (memoryV2Coordinator) {
    try {
      await raceAgainstAbort(
        memoryV2Coordinator.prepareTurn({
          agentState: sessionState.mainAgentState,
          trustedUserInputId: promptId,
          query: prompt,
          workspaceState: sessionState.mainAgentState.workspaceState,
          resumeInterruptedTurn,
          signal: runSignal,
        }),
        runSignal,
      )
    } catch (error) {
      logger?.warn(
        { error },
        'Memory V2 turn preparation was aborted or failed; continuing without injected memory',
      )
    }
  }

  if (runSignal.aborted) {
    resolveTerminal(getCancelledRunState(createAbortError(runSignal).message))
    const terminalState = await terminalPromise
    callbacksEnabled = false
    unsubscribeJobEvents()
        return terminalState
  }

  const onResponseChunk = async (
    action: ServerAction<'response-chunk'>,
  ): Promise<void> => {
    if (!callbacksEnabled || runSignal.aborted) {
      return
    }
    const { chunk } = action

    if (typeof chunk !== 'string') {
      if (chunk.type === 'reasoning_delta') {
        handleStreamChunk?.({
          type: 'reasoning_chunk',
          chunk: chunk.text,
          agentId: chunk.agentId ?? chunk.runId,
          ancestorRunIds: chunk.ancestorRunIds,
        })
      } else {
        await handleEvent?.(chunk)
      }
      return
    }

    if (handleStreamChunk) {
      await handleStreamChunk(chunk)
    }
  }
  const onSubagentResponseChunk = async (
    action: ServerAction<'subagent-response-chunk'>,
  ) => {
    if (!callbacksEnabled || runSignal.aborted) {
      return
    }
    const { agentId, agentType, chunk, chunkKind, ancestorRunIds } = action

    if (handleStreamChunk && chunk) {
      if (chunkKind === 'reasoning') {
        // Reasoning (thinking) delta from a subagent: emit the SAME
        // reasoning_chunk stream event the root loop's onResponseChunk maps
        // its reasoning_delta events to (ancestorRunIds is required in the
        // CLI's reasoning_chunk shape, so a missing chain falls back to the
        // root reasoning stream with []).
        await handleStreamChunk({
          type: 'reasoning_chunk',
          agentId,
          ancestorRunIds: ancestorRunIds ?? [],
          chunk,
        })
      } else {
        await handleStreamChunk({
          type: 'subagent_chunk',
          agentId,
          agentType,
          chunk,
        })
      }
    }
  }

  const ownedLibrarianCloneDirs = new Set<string>()
  // Per-turn change-gate state for list_jobs digests. Declared in this run
  // closure (not module scope) so every run() call gets a fresh fingerprint
  // and concurrent runs never share suppression state. `null` means no
  // list_jobs digest has been emitted yet this turn, so the first call always
  // returns the full table.
  let lastListJobsFingerprint: string | null = null
  // Per-turn change-gate state for git_status observations. Declared in this
  // run closure (not module scope) so every run() call gets a fresh
  // fingerprint and concurrent runs never share suppression state. `null`
  // means no git_status observation has been emitted yet this turn, so the
  // first call always returns the full observation.
  let lastGitStatusFingerprint: string | null = null
  // Per-run set of already-approved client-origin MCP tool keys (P1-T2).
  // Declared in this run closure (not module scope) so every run() call starts
  // with a fresh approval scope and concurrent runs never share it. The FIRST
  // client-origin call of each (server-config, tool) pair is gated behind the
  // host approver; subsequent calls of the same tool this run run freely.
  const approvedClientMcpTools = new Set<string>()
  // P2-audit-fix-8: production crash-resume driver. Built exactly when a
  // journal reader is wired (the same condition under which the runtime's
  // loop-entry block builds the resume report) and threaded additively into
  // the agent-runtime deps so loopAgentSteps' existing not-clean branch can
  // ACT on the report: re-drive in-flight children (best-effort; recorded)
  // and re-issue interrupted background intents with the durable respawnOf
  // marker. Fail-open by contract; a run with no journalReader gets no
  // resumeDriver field at all and stays byte-identical.
  const resumeDriver = journalReader
    ? createRunResumeDriver({ journalWriter, journalReader, logger })
    : undefined
  // Memory-overhaul P4 build-order item 2: wire the playbook-gate outcome
  // producer against this run's Memory V2 repository, so gate verdicts reach
  // the persisted effectiveness counters in production runs. The helper
  // returns undefined — and the deps below then carry NO key at all — when
  // no repository is configured or the store lacks the optional counter-fold
  // member, so such a run stays byte-identical to an unwired one.
  const onPlaybookGateOutcome = buildPlaybookGateOutcomeReporter(
    memoryV2?.repository,
    logger,
  )
  const agentRuntimeImpl = getAgentRuntimeImpl({
    logger,
    registerExecutionActor,
    onExecutionActionStart,
    executionForAction: contextForRegisteredAction,
    executionForActorOperation: contextForInternalActor,
    supervisedExecutionForRequest: (request) => {
      const origin = request.executionHostOperation
      if (origin && request.executionIdentity)
        throw new ExecutionRefusalError({ ok: false, reason: 'invalid-context', cause: 'Supervised launch cannot combine action and host-operation origins' })
      const actor = origin?.actor ?? request.executionIdentity
      const registeredActor = actor && registeredActors.get(actorKey(actor))
      if (!actor || !registeredActor || JSON.stringify(request.ancestorRunIds) !== JSON.stringify([...registeredActor.ancestors, actor.runId]))
        throw new ExecutionRefusalError({ ok: false, reason: 'stale-authority', cause: 'Supervised launch ancestry does not match its registered parent' })
      if (origin) {
        if (origin.purpose !== 'semantic-compaction' && origin.purpose !== 'snapshot-consolidation')
          throw new ExecutionRefusalError({ ok: false, reason: 'invalid-context', cause: 'Supervised host-operation purpose is unavailable' })
        return contextForInternalActor(origin.actor)
      }
      return contextForRegisteredAction(request.executionIdentity!)
    },
    apiKey,
    hostServices,
    journalWriter,
    journalReader,
    ...(resumeDriver ? { resumeDriver } : {}),
    ...(onPlaybookGateOutcome ? { onPlaybookGateOutcome } : {}),
    handleStepsLogChunk: () => {
      // Does nothing for now
    },
    requestToolCall: async ({
      userInputId,
      callId,
      toolName,
      input,
      mcpConfig,
      mcpReference,
      mcpAgentId,
      mcpServerName,
      mcpCatalogGeneration,
      signal: toolSignal,
      executionIdentity,
      executionRequestHash,
    }) => {
      if (runSignal.aborted || terminalRequested) {
        throw createAbortError(runSignal)
      }
      const trustedCallId = executionIdentity?.actionId ?? callId ?? crypto.randomUUID()
      const parsedInput = typeof input === 'string' ? parseJsonBounded(input) : input
      const isEditBatch = toolName === 'edit_transaction' && Array.isArray(parsedInput)
      if (!parsedInput || typeof parsedInput !== 'object' || (Array.isArray(parsedInput) && !isEditBatch))
        throw new ExecutionRefusalError({ ok: false, reason: 'invalid-context', cause: 'Tool input must be an object or a prepared edit_transaction batch' })
      // The runtime forwards preflighted edits as the canonical CHANGES array.
      // Execution options come from the registered action, not that edit batch.
      const toolInput = isEditBatch ? {} : parsedInput as Record<string, any>
      const processSignal = toolSignal ? AbortSignal.any([runSignal, toolSignal]) : runSignal
      const start = executionIdentity ? actionStarts.get(actionKey(executionIdentity)) : undefined
      const capturedExternalAlias = Boolean(mcpConfig) || customToolDefinitions?.some(definition => definition.toolName === toolName)
      if (executionIdentity && (!start || start.identity.basisId !== executionIdentity.basisId ||
        (start.toolName !== toolName && !capturedExternalAlias) ||
        executionRequestHash !== hashActionInput(toolName, input)))
        throw new ExecutionRefusalError({ ok: false, reason: 'stale-authority', cause: 'Tool request does not match a registered B02 action and exact forwarded input' })
      const scope = start?.scope ?? hostServices.directScope
      const directOptions = processOptionsFor(toolName, toolInput)
      const registered = start ? { ok: true as const, value: start.context } : scope.operation({ signal: processSignal,
        limit: directOptions.limit, profile: directOptions.profile, mode: toolName === 'run_terminal_command' && toolInput.mode === 'user' ? 'user' : 'assistant' })
      if (!registered.ok) throw new ExecutionRefusalError(registered)
      const executionContext = registered.value
      rememberExecutionScope(executionContext, scope)
      actionApprovalIds.set(executionIdentity ? actionKey(executionIdentity) : trustedCallId, Object.freeze([...new Set([
        ...(typeof toolInput.approval_receipt_id === 'string' ? [toolInput.approval_receipt_id] : []), ...approvalReceiptIds,
      ])]))
      if (toolName === 'run_terminal_command') {
        const command = (input as { command?: unknown }).command
        if (typeof command === 'string') {
          const cloneMatch = command.match(
            /^git clone --depth 1 'https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?\/?' '(\/tmp\/librarian-[A-Za-z0-9._-]+-[0-9]+)'$/,
          )
          if (cloneMatch?.[1]) ownedLibrarianCloneDirs.add(cloneMatch[1])
        }
      }
      // Capture before the mutation and retain it only after confirmed effects.
      // A later validation call must match its scope, revision and raw postimage.
      const isMutatingToolCall = DIAGNOSTIC_BASELINE_TOOL_NAMES.has(toolName)
      const canHaveUnknownEffects =
        toolName === 'run_terminal_command' ||
        Boolean(mcpConfig) ||
        customToolDefinitions?.some(
          (definition) => definition.toolName === toolName,
        )
      if (isMutatingToolCall || canHaveUnknownEffects) {
        pendingDiagnosticBaseline = undefined
        diagnosticBaselineEpoch += 1
      }
      const baselineEpochForCall = diagnosticBaselineEpoch
      let diagnosticBaseline: DiagnosticCapture | undefined
      if (
        isMutatingToolCall &&
        cwd &&
        diagnosticPreflightEnabled
      ) {
        try {
          const baselineFiles = diagnosticBaselineFiles(toolName, input)
          if (baselineFiles.length > 0) {
            diagnosticBaseline = await captureDiagnosticObservation({
              files: baselineFiles,
              cwd,
              runCommand: diagnosticBaselineRunner,
              env,
              signal: executionContext.signal,
              executionContext,
              phase: 'baseline',
            })
          }
        } catch {
          // Fail-open: no baseline → the hook keeps today's no-baseline path.
          diagnosticBaseline = undefined
        }
      }
      const handled = await handleToolCall({
        action: {
          type: 'tool-call-request',
          requestId: trustedCallId,
          userInputId,
          toolName,
          input,
          mcpConfig: mcpConfig
            ? resolveRunMcpConfig({
                mcpConfig,
                mcpReference,
                mcpAgentId,
                mcpServerName,
              })
            : undefined,
          mcpReference,
          mcpAgentId,
          mcpServerName,
          mcpCatalogGeneration,
        },
        overrides: overrideTools ?? {},
        onFilesChanged,
        onConfirmedWorkspaceTransition: transition => { start?.workspaceBasis.confirmTransition(transition) },
        onFilesystemMutation: async (event) => {
          if (
            diagnosticBaseline &&
            cwd &&
            baselineEpochForCall === diagnosticBaselineEpoch
          ) {
            const afterHashes: Record<string, string | null> = {}
            for (const changed of event.actions) {
              afterHashes[path.resolve(cwd, changed.path)] =
                changed.action === 'delete' || changed.action === 'move'
                  ? null
                  : changed.afterHash
              if (changed.destinationPath)
                afterHashes[path.resolve(cwd, changed.destinationPath)] =
                  changed.afterHash
            }
            const files = diagnosticFileSet(
              cwd,
              diagnosticBaseline.coverage.requestedFiles,
            )
            const changedFiles = Object.keys(afterHashes).sort()
            if (
              files.length > 0 &&
              files.length <= 32 &&
              files.length === changedFiles.length &&
              files.every((file, index) => file === changedFiles[index])
            ) {
              pendingDiagnosticBaseline = {
                capture: diagnosticBaseline,
                cwd: path.resolve(cwd),
                files,
                mutationCallId: trustedCallId,
                workspaceRevision: event.workspaceRevision,
                workspaceSnapshotId: event.workspaceSnapshotId,
                afterHashes,
              }
            }
          } else if (isMutatingToolCall) {
            pendingDiagnosticBaseline = undefined
          }
          if (onFilesystemMutation) await onFilesystemMutation(event)
          else await onFilesChanged?.()
        },
        verifyExternalMutation,
        getLanguageIntelligence,
        diagnosticDelta: diagnosticDeltaHook,
        executionContext,
        resources: scope.resources,
        capturedHookConfiguration,
        diagnosticPreflightEnabled,
        terminalShell: hostServices.terminalShell,
        getTerminalLaunchMetadata: hostServices.getTerminalLaunchMetadata,
        prepareTransferredLaunch: target => backgroundReceiver.value.prepareLaunch(executionContext, target),
        resolveMcpRequest: config => mcpExecution.request(config, scope, executionContext),
        getBrowserExecution: () => {
          capturedChromeExecutable ??= resolveChromeExecutable(hostEnvironment, snapshot.inputs.platform as NodeJS.Platform, existsSync)
          return Object.freeze({ ...executionContext, resources: scope.resources, executablePath: capturedChromeExecutable,
            sandboxArgs: capturedChromeSandboxArgs })
        },
        customToolDefinitions: customToolDefinitions
          ? Object.fromEntries(
              customToolDefinitions.map((def) => [def.toolName, def]),
            )
          : {},
        cwd,
        fs,
        fileFilter,
        filesystemPolicy,
        intentLog,
        trustedJobOwner,
        logger,
        capabilityIssuer: cwd
          ? {
              projectId: cwd,
              runId:
                sessionState.mainAgentState.runId ??
                sessionState.mainAgentState.agentId,
            }
          : undefined,
        env,
        inheritEnv,
        harnessStateDir: resolvedHarnessStateDir,
        approvalReceiptIds,
        approvalMode,
        requestApproval,
        approvedClientMcpTools,
        approvalService,
        harnessWorkspaceIdentity: workspaceJournal
          ? {
              repositoryId: workspaceJournal.repositoryId,
              workspaceId: workspaceJournal.workspaceId,
            }
          : undefined,
        getWorkspaceState: () => sessionState.mainAgentState.workspaceState,
        setWorkspaceState: (state) => {
          sessionState.mainAgentState.workspaceState = state
        },
        advanceWorkspaceJournal: workspaceJournal
          ? (change) =>
              (() => {
                if (!workspaceJournal) {
                  return advanceWorkspaceState(
                    sessionState.mainAgentState.workspaceState,
                    change,
                  )
                }
                try {
                  return workspaceJournal.advance({
                    runId:
                      sessionState.mainAgentState.runId ??
                      sessionState.mainAgentState.agentId,
                    ...change,
                  })
                } catch (error) {
                  logger?.warn(
                    { error },
                    'Workspace journal write failed; continuing with in-memory workspace state',
                  )
                  workspaceJournal = undefined
                  return advanceWorkspaceState(
                    sessionState.mainAgentState.workspaceState,
                    change,
                  )
                }
              })()
          : undefined,
        signal: executionContext.signal,
      })
      const directOverride =
        toolName === 'read_files'
          ? overrideTools?.read_files
          : overrideTools?.[
              toolName as Exclude<PublishedToolName, 'read_files'>
            ]
      const fallbackWriteOverride =
        (toolName === 'str_replace' || toolName === 'create_plan') &&
        overrideTools?.write_file
      await memoryV2Coordinator?.recordToolObservation({
        toolName,
        callId: trustedCallId,
        userInputId,
        input,
        output: handled.output,
        workspaceState: sessionState.mainAgentState.workspaceState,
        native:
          toolNames.includes(toolName as ToolName) &&
          !customToolDefinitions?.some(
            (definition) => definition.toolName === toolName,
          ) &&
          !directOverride &&
          !fallbackWriteOverride,
        mcp: Boolean(mcpConfig),
      })
      // Intercept the single dispatch path (model- and agent-initiated calls
      // alike) so an unchanged list_jobs digest doesn't re-inject the full
      // table into the conversation every step. The gate owns the returned
      // output; the per-turn fingerprint lives in this closure.
      if (toolName === 'list_jobs') {
        const gated = applyListJobsDigestGate(
          lastListJobsFingerprint,
          handled.output,
        )
        lastListJobsFingerprint = gated.nextFingerprint
        return { ...handled, output: gated.output }
      } else if (toolName === 'git_status') {
        // This interception runs AFTER the tool executed (`handled.output`),
        // so every git_status observation still runs; only its context
        // encoding is compacted when the worktree is byte-identical.
        const gated = applyGitStatusGate(
          lastGitStatusFingerprint,
          handled.output,
        )
        lastGitStatusFingerprint = gated.nextFingerprint
        return { ...handled, output: gated.output }
      }
      return handled
    },
    requestMcpToolData: async (request) => {
      const scope = scopeForActor(request.executionActor)
      const signal = request.signal ? AbortSignal.any([runSignal, request.signal]) : runSignal
      const registered = scope.operation({ signal, profile: hostServices.bootstrap.profile,
        limit: { kind: 'finite', durationMs: 15_000 } })
      if (!registered.ok) throw new ExecutionRefusalError(registered)
      const config = resolveRunMcpConfig(request)
      const access = await mcpExecution.request(config, scope, registered.value)
      try {
      const catalog = await access.listToolCatalog({ signal: registered.value.signal })
      return {
        ...catalog,
        origin: resolveMCPConfigOrigin(config),
        tools: request.toolNames
          ? catalog.tools.filter((tool) =>
              request.toolNames!.includes(tool.name),
            )
          : catalog.tools,
      }
      } finally { access.release() }
    },
    requestFiles: ({
      filePaths,
      ranges,
      capabilityIssuer,
      signal: requestSignal,
    }) => {
      const readSignal = requestSignal
        ? AbortSignal.any([runSignal, requestSignal])
        : runSignal
      if (readSignal.aborted || terminalRequested) {
        throw createAbortError(readSignal)
      }
      return readFiles({
        filePaths,
        ranges,
        override: overrideTools?.read_files,
        fileFilter,
        cwd,
        fs,
        signal: readSignal,
        capabilityIssuer,
      })
    },
    requestOptionalFile: async ({ filePath, signal: requestSignal }) => {
      const readSignal = requestSignal
        ? AbortSignal.any([runSignal, requestSignal])
        : runSignal
      if (readSignal.aborted || terminalRequested) {
        throw createAbortError(readSignal)
      }
      // File-editing tools (str_replace / write_file) validate and
      // apply against this content, so it MUST be the full, untruncated file. The
      // regular read_files rendering truncates large files at 100k chars for the
      // model; using that here corrupts edit validation (e.g. a 4,499-line file
      // appears to have only ~2,889 lines, rejecting valid basedOnRead anchors).
      const override = overrideTools?.read_files
      if (override) {
        const raw = await executeOverride({
          override,
          input: { filePaths: [filePath] },
          signal: readSignal,
        })
        const item = normalizeReadFilesOverrideResult({
          filePaths: [filePath],
          raw,
        }).results[0]
        if (
          item?.selector === 'file' &&
          item.status === 'ok' &&
          item.complete &&
          item.metadataComplete === true &&
          typeof item.rawSourceContent === 'string' &&
          item.editAnchor
        ) {
          const decoded = decodeReadCapabilityToken(
            item.editAnchor.readCapability,
          )
          if (
            typeof decoded !== 'string' &&
            decoded.tokenVersion === 'v4' &&
            decoded.rawBasis?.scope === 'whole'
          ) {
            const document = captureTextDocument(
              item.rawSourceContent,
              decoded.rawBasis,
            )
            if (
              item.content === document.observation &&
              decoded.hash === document.observationHash &&
              decoded.startLine === 1 &&
              decoded.endLine === document.maxCapabilityLine &&
              rawReadBasesMatch(item.editAnchor.rawBasis, decoded.rawBasis) &&
              rawReadBasesMatch(
                decoded.rawBasis,
                getRawReadBasis(
                  document,
                  1,
                  document.maxCapabilityLine,
                  'whole',
                ),
              )
            ) {
              if (readSignal.aborted) throw createAbortError(readSignal)
              // Current raw view for edit freshness only; this callback never mints authority.
              return document.rawText
            }
          }
        }
        if (item?.status === 'error' && item.error.code === 'not_found') {
          return null
        }
        const code = item?.status === 'error' ? item.error.code : 'stale_read'
        const message =
          item?.status === 'error'
            ? item.error.message
            : 'The override did not return an authenticated complete lossless source view. Rendered text cannot supply raw edit authority.'
        throw new Error(`read_files ${code}: ${message}`)
      }
      const read = await getFileForEditResult({
        filePath,
        cwd: requireCwd(cwd, 'read_files'),
        fs,
        fileFilter,
        signal: readSignal,
      })
      if (readSignal.aborted) throw createAbortError(readSignal)
      if (read.status === 'found') return read.content
      if (read.status === 'not_found') return null
      throw new Error(`read_files ${read.status}: ${read.error.message}`)
    },
    fileSystem: fs,
    fileFilter,
    sendAction: ({ action }) => {
      if (!callbacksEnabled || terminalRequested) {
        return
      }
      if (action.type === 'action-error') {
        return enqueueCallback(() => onError({ message: action.message }))
      }
      if (action.type === 'response-chunk') {
        return enqueueCallback(() => onResponseChunk(action))
      }
      if (action.type === 'subagent-response-chunk') {
        return enqueueCallback(() => onSubagentResponseChunk(action))
      }
      if (action.type === 'prompt-response') {
        handlePromptResponse({
          action,
          resolve: resolveTerminal,
          onError,
          initialSessionState: sessionState,
        })
        return
      }
      if (action.type === 'prompt-error') {
        handlePromptResponse({
          action,
          resolve: resolveTerminal,
          onError,
          initialSessionState: sessionState,
        })
        return
      }
      return undefined
    },
    sendSubagentChunk: ({
      userInputId,
      agentId,
      agentType,
      chunk,
      prompt,
      forwardToPrompt = true,
      chunkKind,
      ancestorRunIds,
    }) => {
      if (!callbacksEnabled || terminalRequested) {
        return
      }
      onSubagentResponseChunk({
        type: 'subagent-response-chunk',
        userInputId,
        agentId,
        agentType,
        chunk,
        prompt,
        forwardToPrompt,
        chunkKind,
        ancestorRunIds,
      })
    },
  })

  // Send input
  const userInfo = await raceAgainstAbort(agentRuntimeImpl.getUserInfoFromApiKey({
    ...agentRuntimeImpl,
    apiKey,
    fields: ['id'],
  }), runSignal).catch((error) => {
    if (!runSignal.aborted) throw error
    return null
  })
  if (runSignal.aborted) {
    resolveTerminal(getCancelledRunState(createAbortError(runSignal).message))
    const terminalState = await terminalPromise
    await callbackQueue
    callbacksEnabled = false
    unsubscribeJobEvents()
    if (terminalState.sessionState && memoryV2Coordinator) {
      await raceAgainstAbort(
        memoryV2Coordinator.finishTurn({
          agentState: terminalState.sessionState.mainAgentState,
          output: terminalState.output,
          signal: runSignal,
        }),
        runSignal,
      ).catch(() => {})
    }
    return terminalState
  }
  if (!userInfo) {
        const terminalState = getCancelledRunState(
      'Invalid API key or user not found',
      'failed',
    )
    if (memoryV2Coordinator) {
      await raceAgainstAbort(
        memoryV2Coordinator.finishTurn({
          agentState: terminalState.sessionState!.mainAgentState,
          output: terminalState.output,
          signal: runSignal,
        }),
        runSignal,
      ).catch(() => {})
    }
    // Terminal path: dispose the process-wide jobRegistry listener so it does
    // not leak across runs (same invariant as the aborted path below).
    callbacksEnabled = false
    unsubscribeJobEvents()
    return terminalState
  }

  const userId = userInfo.id

  let settledRuntimeState: RunState | undefined
  const promptExecution = callMainPrompt({
    ...agentRuntimeImpl,
    promptId,
    action: {
      type: 'prompt',
      promptId,
      prompt,
      promptParams: params,
      content: preparedContent,
      fingerprintId: fingerprintId,
      costMode: costMode ?? 'normal',
      sessionState,
      toolResults: extraToolResults ?? [],
      agentId,
    },
    repoUrl: undefined,
    repoId: undefined,
    clientSessionId: promptId,
    userId,
    extraCodebuffMetadata,
    signal: runSignal,
    onCheckpoint,
    resumeInterruptedTurn,
    maxMissingOutputRetries,
  })
    .then((result) => {
      settledRuntimeState = result
      resolveTerminal(result)
    })
    .catch((error) => {
      let errorMessage =
        error instanceof Error ? error.message : String(error ?? '')
      const apiErrorDetails = extractApiErrorDetails(error)
      const statusCode = apiErrorDetails.statusCode ?? getErrorStatusCode(error)
      const {
        countryBlockReason,
        countryCode,
        errorCode,
        ipPrivacySignals,
        message: parsedMessage,
      } = apiErrorDetails
      if (parsedMessage) {
        errorMessage = parsedMessage
      }

      resolveTerminal({
        sessionState: getCancelledSessionState(errorMessage),
        runOutcome: {
          termination: runDeadlineExceeded
            ? 'deadline_exhausted'
            : runSignal.aborted
              ? 'cancelled'
              : 'failed',
          cause: {
            code: runDeadlineExceeded
              ? 'run_deadline_exhausted'
              : runSignal.aborted
                ? 'run_cancelled'
                : 'runtime_error',
            message: errorMessage,
          },
        },
        output: {
          type: 'error',
          message: errorMessage,
          ...(statusCode !== undefined && { statusCode }),
          ...(errorCode !== undefined && { error: errorCode }),
          ...(countryCode !== undefined && { countryCode }),
          ...(countryBlockReason !== undefined && { countryBlockReason }),
          ...(ipPrivacySignals !== undefined && { ipPrivacySignals }),
        },
      })
    })

  let terminalState = await terminalPromise
  // A timeout/cancel first aborts the shared signal; cooperative runtime and
  // tools then unwind. Legacy overrides are raced against that signal, so a
  // non-cooperative promise cannot hold the public run open or publish late
  // output. Normal completion also waits for callMainPrompt's cleanup.
  await promptExecution
  // Cancellation may resolve before the runtime records its last in-flight
  // action. Preserve that settled evidence after unwinding, without changing
  // the selected terminal reason or the interruption transcript.
  const settledActions =
    settledRuntimeState?.sessionState?.mainAgentState.actionOutcomes ??
    sessionState.mainAgentState.actionOutcomes
  if (settledActions) {
    terminalState = projectRunOutcomes({
      ...terminalState,
      actionOutcomes: settledActions,
    })
  }
  await callbackQueue
  callbacksEnabled = false
  unsubscribeJobEvents()
  hostServices.rootSignal.removeEventListener('abort', markRootDeadline)
  await stopBrowserSessionsByOwner({
    // Same resolved owner identity the job tools scope by: browser sessions
    // follow the stable session seed (not the per-turn promptId), so
    // browses opened this run are still owned next turn until stopped here.
    clientSessionId: trustedJobOwner.clientSessionId,
  })
  // Dispose warm language servers; no-op when no language-intelligence tool ran.
  try {
    await languageIntelligenceService?.dispose()
  } catch {
    // best-effort
  }
  const cleanupLibrarianClone = (cloneDir: string) => {
    try {
      rmSync(cloneDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup; the path is constrained to an owned /tmp prefix.
    }
  }
  for (const cloneDir of ownedLibrarianCloneDirs) {
    if (terminalState.output.type === 'error') {
      cleanupLibrarianClone(cloneDir)
      continue
    }
    // Keep successful clones alive long enough for the parent to inspect the
    // returned relevantFiles. Bound the lifetime to avoid permanent leaks.
    const cleanupTimer = setTimeout(
      () => cleanupLibrarianClone(cloneDir),
      30 * 60 * 1000,
    )
    cleanupTimer.unref?.()
  }
  if (callbackFailure) {
    logger?.warn(
      { error: callbackFailure },
      'Run completed after one or more client callbacks failed',
    )
  }
  if (terminalState.sessionState && memoryV2Coordinator) {
    await raceAgainstAbort(
      memoryV2Coordinator.finishTurn({
        agentState: terminalState.sessionState.mainAgentState,
        output: terminalState.output,
        signal: runSignal,
      }),
      runSignal,
    ).catch(() => {})
  }
  // Persist task memory whenever a cwd is set. The gate lives in
  // persistRunTaskMemory and deliberately ignores output.type, so cancelled,
  // aborted, and errored runs still contribute the committed memory the
  // session produced (saveMergedTaskMemory merges rather than overwrites).
  // Do not re-add an output.type === 'error' gate here.
  await persistRunTaskMemory({
    cwd,
    terminalState,
    priorMemory: hydratedTaskMemory,
    fs,
    logger,
  })
  return terminalState
}

/**
 * Memory-overhaul P4 build-order item 2: builds the playbook-gate outcome
 * reporter wired into this run's agent-runtime deps, so gate verdicts reach
 * the persisted effectiveness counters in production runs (design record
 * .agents/sessions/memory-overhaul-2026-10/design-phase2-4-rederived.md
 * §P4 build order).
 *
 * PURE helper, exported for tests (the applyListJobsDigestGate precedent):
 * it references only the `repository` PARAMETER and the supplied `logger`,
 * never runOnce closure state. Returns `undefined` when no Memory V2
 * repository is configured or the repository lacks the optional
 * `recordPlaybookGateOutcome` member (fakes and backends without playbook
 * support), in which case the runtime deps carry no `onPlaybookGateOutcome`
 * key at all and the run stays byte-identical to an unwired one.
 *
 * The returned closure forwards the STORE signature —
 * `recordPlaybookGateOutcome(event.playbookId, event.outcome)` — never the
 * whole event (`triggerSignature` is not a store parameter), and satisfies
 * the AgentRuntimeDeps contract: it NEVER throws and NEVER rejects. A
 * synchronous store throw is caught and a rejected store promise gets a
 * `.catch()`; both log at debug and no-op. That is the deliberate
 * wiring-site decision: a failed report must not affect the gated tool call,
 * including a store throw like 'The playbook was not found.' (mid-session
 * retirement). The store member is bound to the repository once here so the
 * receiver survives the detached call (it may be a class method).
 */
export function buildPlaybookGateOutcomeReporter(
  repository: MemoryV2ClientConfig['repository'] | undefined,
  logger?: Logger,
): ((event: PlaybookGateOutcomeEvent) => void) | undefined {
  if (!repository?.recordPlaybookGateOutcome) {
    return undefined
  }
  const record = repository.recordPlaybookGateOutcome.bind(repository)
  const logFailure = (error: unknown) =>
    logger?.debug?.({ error }, 'Failed to record playbook gate outcome')
  return (event) => {
    try {
      record(event.playbookId, event.outcome).catch(logFailure)
    } catch (error) {
      logFailure(error)
    }
  }
}

/**
 * Per-turn change-gate for list_jobs digests. Compares the row fingerprint of
 * the freshly-produced digest (folded with its truncatedCount) against the
 * last fingerprint this turn and, when nothing meaningful changed, swaps the
 * full table for a tiny suppression note.
 *
 * Exported for tests. `lastFingerprint` is the run-closure state (null on the
 * first call of a turn, which always returns the full digest). The caller owns
 * storing `nextFingerprint` back into that state.
 *
 * The suppression payload intentionally omits `jobs` entirely: an empty array
 * would read as "no jobs exist", which is false.
 */

export function applyListJobsDigestGate(
  lastFingerprint: string | null,
  output: ToolResultOutput[],
): { output: ToolResultOutput[]; nextFingerprint: string | null } {
  // Only gate a well-formed single json digest. Overrides, errors, or custom
  // list_jobs shapes are passed through untouched and do not update the gate.
  const first = output[0]
  if (output.length !== 1 || first?.type !== 'json') {
    return { output, nextFingerprint: lastFingerprint }
  }
  const value = first.value
  const jobs =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { jobs?: unknown }).jobs
      : undefined
  if (!Array.isArray(jobs)) {
    return { output, nextFingerprint: lastFingerprint }
  }
  // fingerprintListJobsRows ignores tail/startedAt by design, so chattiness
  // (new buffered output) and wall-clock drift do not reset the gate. Fold in
  // the digest value's truncatedCount so a change in how many rows were capped
  // off (identical selected rows, different truncation) still busts the gate.
  const rawTruncatedCount = (value as { truncatedCount?: unknown })
    .truncatedCount
  const truncatedCount =
    typeof rawTruncatedCount === 'number' ? rawTruncatedCount : 0
  const nextFingerprint = `${fingerprintListJobsRows(jobs as ListJobsViewRow[])}|${truncatedCount}`
  if (lastFingerprint !== null && nextFingerprint === lastFingerprint) {
    return {
      output: [
        {
          type: 'json',
          value: {
            unchanged: true,
            note: 'No job changes since the previous list_jobs digest this turn; the earlier digest is still current.',
          },
        },
      ],
      nextFingerprint: lastFingerprint,
    }
  }
  return { output, nextFingerprint }
}

/**
 * Per-turn change-gate for git_status observations. Compares the fingerprint
 * of the freshly-produced observation against the last fingerprint this turn
 * and, when the worktree is byte-identical, swaps the full observation for a
 * tiny suppression note.
 *
 * Exported for tests. `lastFingerprint` is the run-closure state (null on the
 * first call of a turn, which always returns the full observation). The caller
 * owns storing `nextFingerprint` back into that state.
 *
 * This gates the BUILT-IN git_status tool result (`gitStatus` in
 * sdk/src/tools/git-status.ts), whose json value is shaped
 * `{ branch?: string, status: string, diff?: string, truncated?: true }`.
 * `status` is the dirty-file porcelain body the base2 gate's
 * `extractGitStatusFiles` parses, so a suppression payload that omits the
 * fields yields the same file set as the prior (identical) observation.
 *
 * The fingerprint serializes every field the tool can return (branch, status,
 * diff, truncated) via an explicit per-field encoding — never
 * `JSON.stringify(value)`, whose key order is not guaranteed. `branch` is
 * included deliberately: a commit changes the branch line while the dirty
 * status/diff can stay fixed, and that must bust the gate.
 *
 * The suppression payload intentionally omits the git fields entirely: an
 * empty `status` would read as "clean tree", which is false. The gate is
 * fail-safe: any result that is not a well-formed single-json git_status
 * observation (including errorMessage shapes) passes through untouched and
 * does not update the fingerprint.
 */
export function applyGitStatusGate(
  lastFingerprint: string | null,
  output: ToolResultOutput[],
): { output: ToolResultOutput[]; nextFingerprint: string | null } {
  // Only gate a well-formed single json git_status result. Overrides, errors,
  // or custom git_status shapes are passed through untouched and do not
  // update the gate.
  const first = output[0]
  if (output.length !== 1 || first?.type !== 'json') {
    return { output, nextFingerprint: lastFingerprint }
  }
  const value = first.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { output, nextFingerprint: lastFingerprint }
  }
  const record = value as {
    branch?: unknown
    status?: unknown
    diff?: unknown
    truncated?: unknown
  }
  // `status` (the dirty-file porcelain body) is always present on a real
  // observation; errorMessage results lack it and pass through. `diff` /
  // `branch` / `truncated` are optional (diff only when include_diff ran,
  // branch only when upstream info exists, truncated only when capped).
  if (typeof record.status !== 'string') {
    return { output, nextFingerprint: lastFingerprint }
  }
  // Serialize every field the tool can return via an explicit per-field
  // encoding (never JSON.stringify key order, which is not guaranteed), so
  // any change busts the gate and no returned field is dropped from the
  // comparison. Absent optional fields encode as empty. NUL is a safe
  // separator: git porcelain/diff text never contains it. `branch` is folded
  // in because a commit changes the branch line while status/diff can stay
  // fixed, and that must bust the gate.
  const nextFingerprint = stableHash(
    `branch=${typeof record.branch === 'string' ? record.branch : ''}` +
      '\u0000' +
      `status=${record.status}` +
      '\u0000' +
      `diff=${typeof record.diff === 'string' ? record.diff : ''}` +
      '\u0000' +
      `truncated=${record.truncated === true ? 'true' : ''}`,
  )
  if (lastFingerprint !== null && nextFingerprint === lastFingerprint) {
    return {
      output: [
        {
          type: 'json',
          value: {
            unchanged: true,
            note: 'Worktree is byte-identical to the previous git_status observation this turn; the earlier status/diff/branch/truncated are still current, so do not re-request git_status to retrieve them.',
          },
        },
      ],
      nextFingerprint: lastFingerprint,
    }
  }
  return { output, nextFingerprint }
}

function requireCwd(cwd: string | undefined, toolName: string): string {
  if (!cwd) {
    throw new Error(
      `cwd is required for the ${toolName} tool. Please provide cwd in OpenbuffClientOptions or override the ${toolName} tool.`,
    )
  }
  return cwd
}

function requireCapabilityIssuer(
  capabilityIssuer: ReadCapabilityIssuer | undefined,
  toolName: string,
): ReadCapabilityIssuer {
  if (!capabilityIssuer) {
    throw new Error(
      `a read capability issuer is required for the ${toolName} tool. Please provide cwd in OpenbuffClientOptions or override the ${toolName} tool.`,
    )
  }
  return capabilityIssuer
}

async function readFiles({
  filePaths,
  ranges,
  override,
  fileFilter,
  cwd,
  fs,
  signal,
  capabilityIssuer,
}: {
  filePaths: string[]
  ranges?: FileLineRange[]
  override?: NonNullable<
    Required<OpenbuffClientOptions>['overrideTools']['read_files']
  >
  fileFilter?: FileFilter
  cwd?: string
  fs: CodebuffFileSystem
  signal: AbortSignal
  capabilityIssuer?: ReadCapabilityIssuer
}) {
  if (override) {
    const output = await executeOverride({
      override,
      input: { filePaths, ranges },
      signal,
    })
    return normalizeReadFilesOverrideResult({
      filePaths,
      ranges,
      raw: output,
    })
  }
  return getFilesStructured({
    filePaths,
    ranges,
    cwd: requireCwd(cwd, 'read_files'),
    fs,
    fileFilter,
    signal,
    capabilityIssuer,
  })
}

/**
 * Dispatches one client tool call and applies the post-dispatch mutation
 * wiring (workspace state/journal advance plus change-observer notification).
 * Exported so tests can drive that wiring directly instead of only through a
 * full run.
 */
export async function handleToolCall({
  action,
  overrides,
  customToolDefinitions,
  cwd,
  fs,
  fileFilter,
  filesystemPolicy,
  intentLog,
  trustedJobOwner,
  capabilityIssuer,
  logger,
  env,
  inheritEnv = true,
  harnessStateDir,
  approvalReceiptIds,
  approvalMode,
  requestApproval,
  approvedClientMcpTools,
  approvalService,
  harnessWorkspaceIdentity,
  getWorkspaceState,
  setWorkspaceState,
  advanceWorkspaceJournal,
  onConfirmedWorkspaceTransition,
  onFilesChanged,
  onFilesystemMutation,
  verifyExternalMutation,
  getLanguageIntelligence,
  diagnosticDelta,
  executionContext,
  resources,
  capturedHookConfiguration,
  diagnosticPreflightEnabled,
  terminalShell,
  getTerminalLaunchMetadata,
  prepareTransferredLaunch,
  resolveMcpRequest,
  getBrowserExecution,
  signal: requestedSignal,
}: {
  action: ServerAction<'tool-call-request'>
  overrides: NonNullable<OpenbuffClientOptions['overrideTools']>
  customToolDefinitions: Record<string, CustomToolDefinition>
  cwd?: string
  fs: CodebuffFileSystem
  fileFilter?: FileFilter
  filesystemPolicy?: FilesystemAuthorityPolicy
  /** P2-T5: durable transaction-intent log for multi-file commit loops. */
  intentLog?: TransactionIntentLog
  /** Trusted owner injected into every process-job op; never model-derived. */
  trustedJobOwner: JobOwner
  capabilityIssuer?: ReadCapabilityIssuer
  logger?: Logger
  env?: Record<string, string | undefined>
  inheritEnv?: boolean
  harnessStateDir?: string
  approvalReceiptIds: string[]
  approvalMode: HarnessApprovalMode
  requestApproval?: OpenbuffClientOptions['requestApproval']
  /** Per-run set of already-approved client-origin MCP tool keys (P1-T2).
   * Optional so existing direct callers/tests keep working; when absent, the
   * gate still enforces approval but with a fresh local set for this call. */
  approvedClientMcpTools?: Set<string>
  approvalService?: HarnessApprovalService
  harnessWorkspaceIdentity?: {
    repositoryId: string
    workspaceId: string
  }
  getWorkspaceState: () => WorkspaceStateV1 | undefined
  setWorkspaceState: (state: WorkspaceStateV1) => void
  advanceWorkspaceJournal?: (params: {
    source: string
    operationId?: string
    receiptId?: string
    actions: FilesystemMutationEvent['actions']
  }) => WorkspaceStateV1
  /** Private composition callback, invoked only for a canonical local transition before LSP sync. */
  onConfirmedWorkspaceTransition?: (transition: ConfirmedWorkspaceTransition) => void
  onFilesChanged?: OpenbuffClientOptions['onFilesChanged']
  onFilesystemMutation?: OpenbuffClientOptions['onFilesystemMutation']
  verifyExternalMutation?: OpenbuffClientOptions['verifyExternalMutation']
  /**
   * P3-T2 (LI-01): lazily builds/returns this run's shared language-intelligence
   * service. Optional so existing direct `handleToolCall` callers keep working;
   * when absent the four LSP read tools fall back to a spawner-less service that
   * degrades each query into a structured result instead of throwing.
   */
  getLanguageIntelligence?: () => LanguageIntelligenceService
  /** Audit fix (B): fail-open diagnostic-delta preflight injector threaded
   * into run_file_change_hooks (and forwarded to run_targeted_validation).
   * Optional so existing direct callers/tests keep working; absent means the
   * preflight seam stays off. The OPENBUFF_DIAGNOSTIC_PREFLIGHT flag check
   * lives inside runFileChangeHooks. */
  diagnosticDelta?: DiagnosticDeltaHook
  executionContext?: ExecutionAdapterContext
  resources?: BoundResourceFactory
  capturedHookConfiguration?: CapturedHookConfiguration
  diagnosticPreflightEnabled?: boolean
  terminalShell?: Parameters<typeof runTerminalCommand>[0]['terminalShell']
  getTerminalLaunchMetadata?: Parameters<typeof runTerminalCommand>[0]['getTerminalLaunchMetadata']
  prepareTransferredLaunch?: Parameters<typeof runTerminalCommand>[0]['prepareTransferredLaunch']
  resolveMcpRequest?: (config: MCPConfig) => Promise<MediatedMcpRequest>
  getBrowserExecution?: () => Parameters<typeof browserLogs>[2]
  signal?: AbortSignal
}): Promise<{
  output: ToolResultOutput[]
  canonicalReceipt?: CommitReceiptV1
}> {
  const toolName = action.toolName
  const signal = executionContext?.signal ?? requestedSignal
  const lspRequest = executionContext ? { execution: executionContext.execution, signal } : undefined
  // P3-T2 (LI-01): resolve the shared language-intelligence service. runOnce
  // injects a getter closing over this run's spawn/cwd; direct handleToolCall
  // callers (tests) fall back to a spawner-less service whose queries degrade
  // into a structured errorMessage result rather than throwing.
  let fallbackLanguageIntelligence: LanguageIntelligenceService | undefined
  const resolveLanguageIntelligence = (): LanguageIntelligenceService => {
    if (getLanguageIntelligence) return getLanguageIntelligence()
    fallbackLanguageIntelligence ??= createLanguageIntelligence({
      cwd: requireCwd(cwd, 'language intelligence'),
      // Direct handleToolCall callers (tests) run against THIS call's fs, so
      // the splice seam is still filesystem-owned rather than raw node disk.
      fs,
    })
    return fallbackLanguageIntelligence
  }
  const input =
    typeof action.input === 'string'
      ? parseJsonBounded(action.input)
      : action.input
  const normalizedAction =
    input === action.input ? action : { ...action, input }

  if (signal?.aborted) {
    throw createAbortError(signal)
  }

  // Handle MCP tool calls when mcpConfig is present
  if (action.mcpConfig) {
    // P1-T2: gate the FIRST call of each tool from a `client`-origin MCP
    // config behind the host approval callback. Trusted origins
    // (`user`/`project`, and any explicitly trusted mark) proceed unchanged
    // with no approval. `resolveMCPConfigOrigin` fails closed to `client` for
    // unmarked configs, so an unmarked config is gated too — matching every
    // other origin consumer.
    if (resolveMCPConfigOrigin(action.mcpConfig) === 'client') {
      // Stable per-(server-config, tool) key. `getMCPClientCacheKey` is the
      // same identity `getMCPClient` computes downstream, so computing it here
      // first is safe. If it can ever throw for a malformed config, fall back
      // to a JSON key so a key failure never bypasses the gate.
      let cacheKey: string
      try {
        cacheKey = getMCPClientCacheKey(action.mcpConfig, { origin: 'client' })
      } catch {
        cacheKey = JSON.stringify(action.mcpConfig)
      }
      const approvalKey = `${cacheKey}\u0000${toolName}`
      // When no per-run set is threaded in, use a fresh local set so behavior
      // is defined (the gate still enforces approval for this call).
      const approvedTools = approvedClientMcpTools ?? new Set<string>()
      if (!approvedTools.has(approvalKey)) {
        if (requestApproval) {
          // NUL-free, human-readable approval target derived from the config.
          const serverLabel =
            action.mcpConfig.type === 'stdio'
              ? action.mcpConfig.command
              : action.mcpConfig.url
          const approved = await requestApproval({
            action: 'mcp-tool',
            target: `${serverLabel} ${toolName}`,
            commandHash: hashCommand(approvalKey),
            reason: `MCP tool '${toolName}' comes from a client-supplied (untrusted) MCP server and is running for the first time this run.`,
            risk: 'high',
          })
          if (!approved) {
            // Denied: do NOT call the tool. Return the same error-output shape
            // the branch uses for a thrown MCP error so callers parse it
            // identically to a failed call.
            return {
              output: [
                {
                  type: 'json',
                  value: {
                    errorMessage: `Client MCP tool '${toolName}' was denied approval.`,
                  },
                },
              ],
            }
          }
        }
        // Approved by the host, or fail-open when no host approver exists
        // (headless/CI). Record the key so subsequent calls of this same tool
        // this run run freely.
        approvedTools.add(approvalKey)
      }
    }
    try {
      if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input)))
        throw new Error('MCP tool arguments must be an object.')
      if (!resolveMcpRequest) throw new ExecutionRefusalError({ ok: false, reason: 'unavailable', cause: 'Captured MCP execution context is unavailable' })
      const request = await resolveMcpRequest(action.mcpConfig)
      try {
      if (
        typeof action.mcpCatalogGeneration === 'number' &&
        request.generation !== action.mcpCatalogGeneration
      ) {
        throw new Error(
          'MCP tool catalog changed before dispatch; rediscover the server tools before retrying.',
        )
      }
      const result = await request.callTool(
        {
          name: toolName,
          arguments: input as Record<string, unknown> | undefined,
        },
        undefined,
        { signal },
      )
      return { output: result }
      } finally { request.release() }
    } catch (error) {
      return {
        output: [
          {
            type: 'json',
            value: {
              errorMessage:
                error instanceof Error ? error.message : String(error),
              ...(isExecutionRefusalError(error) ? { executionRefusal: error.refusal } :
                executionRefusalFromError(error)),
            },
          },
        ],
      }
    }
  }

  let result: ToolResultOutput[]
  let canonicalReceipt: CommitReceiptV1 | undefined
  let confirmedWorkspaceState: WorkspaceStateV1 | undefined
  // Returned by tools whose declared output is a compact receipt rather than
  // the file_mutation_result payload (write_audit_findings, rename_symbol,
  // code_action), so the post-dispatch mutation block below still observes
  // their filesystem actions. It is returned for applied AND not_applied
  // writes, so the
  // `getConfirmedAppliedActionsV1` gate below — not its presence — decides
  // whether anything landed. That receipt intentionally stays compact: the
  // emitted FilesystemMutationEvent, which carries
  // workspaceRevision/workspaceSnapshotId, is the correlation channel for the
  // artifact write.
  let compactReceiptMutation: FileMutationResultV1 | undefined
  if (!toolNames.includes(toolName as ToolName)) {
    const customToolHandler = customToolDefinitions[toolName]

    if (!customToolHandler) {
      throw new Error(
        `Custom tool handler not found for user input ID ${action.userInputId}`,
      )
    }
    // Apply the original schema once at the host execution boundary. Provider
    // projections cannot preserve Zod defaults, transforms, async refinements
    // or UTF-16 length semantics. JSON-only legacy hosts are validated here too;
    // a serialized descriptor must never become an unvalidated handler call.
    let customInput = input
    {
      let inputSchema = customToolHandler.inputSchema
      if (typeof inputSchema?.safeParseAsync !== 'function') {
        try {
          inputSchema = jsonSchemaToZod(inputSchema)
        } catch (error) {
          return {
            output: [
              {
                type: 'json',
                value: {
                  errorMessage: `Unsupported input schema for ${toolName}: ${String(error)}`,
                },
              },
            ],
          }
        }
      }
      const validation = inputSchema.safeParseAsync(input)
      const parsed = signal
        ? await raceAgainstAbort(validation, signal)
        : await validation
      if (!parsed.success) {
        const details = parsed.error.issues
          .map((issue) => {
            const path = issue.path.map(String).join('.') || 'input'
            return `${path}: ${issue.message}`
          })
          .join('; ')
        return {
          output: [
            {
              type: 'json',
              value: {
                errorMessage: `Invalid parameters for ${toolName}: ${details}`,
              },
            },
          ],
        }
      }
      customInput = parsed.data
    }
    const authorizedPaths: NonNullable<
      CustomToolExecutionContext['authorizedPaths']
    >[number][] = []
    if (customToolHandler.pathParameters?.length) {
      try {
        if (!cwd)
          throw new Error(
            'The host requires a project root for declared filesystem effects.',
          )
        const authority = getDefaultFilesystemAuthority(
          cwd,
          fs,
          fileFilter,
          filesystemPolicy,
        )
        for (const target of selectExternalToolPaths(
          customInput,
          customToolHandler.pathParameters,
        )) {
          if (!isSafeProjectRelativePath(target.path))
            throw new Error('Declared tool path has an unsafe path form.')
          let operationPath: string
          if (target.access === 'write') {
            const pendingAuthorization = authority.authorizePath(
              target.path,
              'overwrite',
            )
            const authorization = signal
              ? await raceAgainstAbort(pendingAuthorization, signal)
              : await pendingAuthorization
            if (!authorization.allowed)
              throw new Error(
                `Declared write path refused (${authorization.code}).`,
              )
            operationPath = authorization.path.operationPath
          } else {
            const resolved = await resolveFilePathForFileSystemReadOperation(
              cwd,
              target.path,
              fs,
            )
            if (!resolved)
              throw new Error(
                'Declared read path is outside the allowed filesystem scope.',
              )
            const aliases = getScopedReadPolicyAliases(
              resolved.scope,
              resolved.operationPath,
            )
            if (
              fileFilter &&
              aliases.some((alias) => fileFilter(alias).status === 'blocked')
            )
              throw new Error('Declared read path refused (custom_filter).')
            const evaluation = authority.policy.evaluate({
              operation: 'read',
              phase: 'resolve',
              portablePath: resolved.relativePath,
              canonicalPath: resolved.operationPath,
              canonicalParentPath: path.dirname(resolved.operationPath),
            })
            const decision = signal
              ? await raceAgainstAbort(Promise.resolve(evaluation), signal)
              : await evaluation
            if (!decision.allowed)
              throw new Error(
                `Declared read path refused (${decision.code ?? 'host_policy'}).`,
              )
            operationPath = resolved.operationPath
          }
          authorizedPaths.push(
            Object.freeze({
              ...target,
              inputPath: target.path,
              path: operationPath,
            }),
          )
          signal?.throwIfAborted()
        }
      } catch (error) {
        signal?.throwIfAborted()
        return {
          output: [
            {
              type: 'json',
              value: { errorMessage: String(error), permissionDenied: true },
            },
          ],
        }
      }
    }
    const customExecutionContext: CustomToolExecutionContext = {
      signal,
      execution: executionContext,
      ...(authorizedPaths.length
        ? { authorizedPaths: Object.freeze(authorizedPaths) }
        : {}),
    }
    return {
      output: signal
        ? await raceAgainstAbort(
            customToolHandler.execute(customInput, customExecutionContext),
            signal,
          )
        : await customToolHandler.execute(customInput, customExecutionContext),
    }
  }

  try {
    let override =
      toolName === 'read_files'
        ? undefined
        : overrides[toolName as Exclude<PublishedToolName, 'read_files'>]
    if (
      !override &&
      (toolName === 'str_replace' || toolName === 'create_plan')
    ) {
      // Reuse the write_file override for single-file editing tools that send
      // FileChange-shaped payloads to the client.
      override = overrides['write_file']
    }

    const isClientTool = clientToolNames.includes(toolName as ClientToolName)
    if (!override && !isClientTool) {
      throw new Error(
        `Tool not implemented in SDK. Please provide an override or modify your agent to not use this tool: ${toolName}`,
      )
    }
    const parsed = isClientTool
      ? clientToolCallSchema.parse(normalizedAction)
      : undefined

    if (override) {
      const overrideSignal = signal ?? new AbortController().signal
      result = (await executeOverride({
        override: override as OverrideDescriptor<
          typeof input,
          ToolResultOutput[]
        >,
        input,
        signal: overrideSignal,
        executionContext,
      })) as ToolResultOutput[]
      if (
        toolName === 'write_file' ||
        toolName === 'str_replace' ||
        toolName === 'create_plan' ||
        toolName === 'edit_transaction' ||
        // Compact-receipt mutating tool: an override for it can still return a
        // `file_mutation_result` part, which would otherwise self-certify
        // `applied` and advance workspace state/journal without attestation.
        toolName === 'write_audit_findings' ||
        toolName === 'replace_range'
      ) {
        result = await Promise.all(
          result.map(async (part) => {
            if (part.type !== 'json') return part
            const parsed = fileMutationResultV1Schema.safeParse(part.value)
            if (!parsed.success) return part
            if (
              verifyExternalMutation &&
              (await verifyExternalMutation({
                toolName,
                callId: action.requestId,
                result: parsed.data,
              }))
            ) {
              if (parsed.data.authorityReceipt?.callId === action.requestId) {
                canonicalReceipt = parsed.data.authorityReceipt
              }
              return part
            }
            return {
              type: 'json' as const,
              value: fileMutationResultV1Schema.parse({
                ...parsed.data,
                outcome: 'unconfirmed',
                actions: parsed.data.actions.map((action) => ({
                  ...action,
                  outcome: 'unconfirmed',
                  beforeHash: null,
                  afterHash: null,
                  rollback: undefined,
                })),
                authorityTier: null,
                receiptId: undefined,
                errors: [
                  ...parsed.data.errors,
                  {
                    code: 'malformed_result',
                    message:
                      'External mutation overrides cannot self-certify filesystem application.',
                    retryable: false,
                  },
                ],
                freshCapabilities: [],
              }),
            }
          }),
        )
      }
    } else if (toolName === 'end_turn') {
      // Mirror the runtime end_turn handler's fail-closed scoping: list ONLY
      // jobs owned by THIS run's trusted owner (the registry pairs owner
      // equality on clientSessionId + rootRunId). An unscoped
      // `listRunning()` here would surface other client sessions' jobs.
      const runningJobs = jobRegistry
        .listRunning({
          clientSessionId: trustedJobOwner.clientSessionId,
          rootRunId: trustedJobOwner.rootRunId,
        })
        .filter((job) => job.kind === 'process')
      result = [
        {
          type: 'json',
          value:
            runningJobs.length === 0
              ? { message: 'Turn ended.' }
              : {
                  message: `Turn ended. ${runningJobs.length} background job(s) are still running. Use check_job/read_logs/kill_job to manage them.`,
                  pendingBackgroundJobs: runningJobs.slice(0, 5).map((job) => ({
                    jobId: job.jobId,
                    command: job.label,
                    startedAt: job.startedAt ?? job.createdAt,
                  })),
                  ...(runningJobs.length > 5
                    ? { pendingBackgroundJobsTruncated: runningJobs.length - 5 }
                    : {}),
                },
        },
      ]
    } else if (toolName === 'write_audit_findings') {
      const audit = await writeAuditFindings({
        parameters: input,
        cwd: requireCwd(cwd, toolName),
        fs,
        signal,
        fileFilter,
        filesystemPolicy,
        callId: action.requestId,
        logger,
      })
      result = audit.output
      compactReceiptMutation = audit.mutation
    } else if (
      toolName === 'write_file' ||
      toolName === 'str_replace' ||
      toolName === 'create_plan'
    ) {
      result = await changeFile({
        parameters: input,
        cwd: requireCwd(cwd, toolName),
        fs,
        signal,
        fileFilter,
        filesystemPolicy,
        capabilityIssuer,
        callId: action.requestId,
        logger,
      })
    } else if (toolName === 'edit_transaction') {
      result = await changeFiles({
        parameters: input,
        cwd: requireCwd(cwd, toolName),
        fs,
        signal,
        fileFilter,
        filesystemPolicy,
        intentLog,
        capabilityIssuer,
        callId: action.requestId,
        logger,
      })
    } else if (toolName === 'replace_range') {
      result = await replaceRange({
        parameters: input,
        cwd: requireCwd(cwd, toolName),
        fs,
        signal,
        fileFilter,
        filesystemPolicy,
        // The issuer is constructed exactly when `cwd` is set; assert it
        // explicitly rather than depending on evaluation order of the sibling
        // `cwd: requireCwd(...)` property.
        capabilityIssuer: requireCapabilityIssuer(capabilityIssuer, toolName),
        callId: action.requestId,
        logger,
      })
    } else if (toolName === 'run_terminal_command') {
      const projectRoot = requireCwd(cwd, 'run_terminal_command')
      if (parsed?.toolName !== 'run_terminal_command') {
        throw new Error(
          'Expected a parsed run_terminal_command client tool call',
        )
      }
      const terminalInput = parsed.input
      // `permission_profile` passes through verbatim from the client tool call
      // input, but that input is constructed by the agent runtime handler
      // (handleRunTerminalCommand), which always sets it from the agent
      // template's declared `terminalPermissionProfile` (defaulting to
      // 'full-access') and never from model/tool input — see the parity test
      // in packages/agent-runtime/src/tools/handlers/tool/__tests__/
      // run-terminal-command.test.ts. The per-profile policy engine is
      // therefore clamped to the template declaration, never widened by the
      // model. The schema on the SDK side still validates the value.
      result = await runTerminalCommand({
        ...terminalInput,
        permission_profile: executionContext?.profile.policy as typeof terminalInput.permission_profile ?? terminalInput.permission_profile,
        timeout_seconds: terminalInput.timeout_seconds ?? -1,
        // Ownership identity is runtime-injected from trusted run state; any
        // model-supplied `owner` in terminalInput is overridden here.
        owner: trustedJobOwner,
        cwd: path.resolve(projectRoot, terminalInput.cwd ?? '.'),
        projectRoot,
        env,
        inheritEnv,
        signal,
        executionContext,
        terminalShell,
        getTerminalLaunchMetadata,
        prepareTransferredLaunch,
      })
    } else if (toolName === 'read_image') {
      result = await readImages({
        paths: (input as { paths: string[] }).paths,
        cwd: requireCwd(cwd, 'read_image'),
        fs,
        signal,
        fileFilter,
      })
    } else if (toolName === 'inspect_3d_asset') {
      if (fs.hostProcessView === false) {
        throw new Error(
          'inspect_3d_asset is unsupported because this filesystem adapter declares a different host process view.',
        )
      }
      result = await inspect3dAsset({
        path: (input as { path: string }).path,
        cwd: requireCwd(cwd, 'inspect_3d_asset'),
        fs,
        signal,
        execution: executionContext,
        fileFilter,
      })
    } else if (toolName === 'render_3d_preview') {
      if (fs.hostProcessView === false) {
        throw new Error(
          'render_3d_preview is unsupported because this filesystem adapter declares a different host process view.',
        )
      }
      const previewInput = input as {
        path: string
        views: Array<'camera' | 'perspective' | 'front' | 'side' | 'top'>
        mode: 'material' | 'clay' | 'wireframe'
        width: number
        height: number
      }
      result = await render3dPreview({
        ...previewInput,
        cwd: requireCwd(cwd, 'render_3d_preview'),
        fs,
        signal,
        execution: executionContext,
        fileFilter,
      })
    } else if (toolName === 'edit_3d_asset') {
      if (fs.hostProcessView === false) {
        throw new Error(
          'edit_3d_asset is unsupported because this filesystem adapter declares a different host process view.',
        )
      }
      const editInput = input as {
        path: string
        source_hash: string
        operations: Record<string, unknown>[]
      }
      result = await edit3dAsset({
        path: editInput.path,
        sourceHash: editInput.source_hash,
        operations: editInput.operations,
        cwd: requireCwd(cwd, 'edit_3d_asset'),
        fs,
        operationId: action.requestId,
        signal,
        execution: executionContext,
        fileFilter,
      })
    } else if (toolName === 'browser_logs') {
      // M1-T7: any model-supplied `_browserOwner` in the tool input is
      // IGNORED — owner identity is stamped from trusted runtime state
      // (trustedJobOwner) exactly like the check_job/kill_job/read_logs
      // branches, so a prompt-injected tool call can never claim another
      // session's browser sessions.
      const browserInput = input as Parameters<typeof browserLogs>[0] & {
        _browserOwner?: BrowserSessionOwner
      }
      const { _browserOwner, ...browserAction } = browserInput
      void _browserOwner
      result = await browserLogs(
        browserAction as Parameters<typeof browserLogs>[0],
        { ...trustedJobOwner, projectRoot: cwd },
        getBrowserExecution?.(),
      )
    } else if (toolName === 'code_search') {
      if (fs.hostProcessView === false) {
        throw new Error(
          'code_search is unsupported because this filesystem adapter declares a different host process view. Provide a tool override.',
        )
      }
      const codeSearchInput = input as Omit<
        Parameters<typeof codeSearch>[0],
        'projectPath'
      >
      result = await codeSearch({
        ...codeSearchInput,
        projectPath: requireCwd(cwd, 'code_search'),
        signal,
        fileFilter,
      })
    } else if (toolName === 'find_files_matching_content') {
      if (fs.hostProcessView === false) {
        throw new Error(
          'find_files_matching_content is unsupported because this filesystem adapter declares a different host process view. Provide a tool override.',
        )
      }
      const findFilesInput = input as Omit<
        Parameters<typeof findFilesMatchingContent>[0],
        'projectPath'
      >
      result = await findFilesMatchingContent({
        ...findFilesInput,
        projectPath: requireCwd(cwd, 'find_files_matching_content'),
        signal,
        fileFilter,
      })
    } else if (toolName === 'list_directory') {
      result = await listDirectory({
        directoryPath: (input as { path: string }).path,
        offset: (input as { offset?: number }).offset,
        limit: (input as { limit?: number }).limit,
        projectPath: requireCwd(cwd, 'list_directory'),
        fs,
        fileFilter,
      })
    } else if (toolName === 'glob') {
      result = await glob({
        pattern: (input as { pattern: string; cwd?: string }).pattern,
        projectPath: requireCwd(cwd, 'glob'),
        cwd: (input as { pattern: string; cwd?: string }).cwd,
        fs,
        fileFilter,
      })
    } else if (toolName === 'run_file_change_hooks') {
      if (fs.hostProcessView === false) {
        throw new Error(
          'run_file_change_hooks is unsupported because hook commands cannot see this filesystem adapter. Provide a tool override.',
        )
      }
      result = await runFileChangeHooks({
        files: (input as { files?: string[] }).files ?? [],
        cwd: requireCwd(cwd, 'run_file_change_hooks'),
        env,
        signal,
        fileSystem: fs,
        diagnosticDelta,
        executionContext,
        capturedConfiguration: capturedHookConfiguration,
        diagnosticPreflightEnabled,
        terminalShell,
        getTerminalLaunchMetadata,
      })
    } else if (toolName === 'check_job') {
      // The trusted owner overrides any model-supplied owner in the input.
      // M2-T4 (Fix 4): the runtime abort signal is likewise pinned OVER any
      // model-supplied input value, so a spoofed `signal` in tool input cannot
      // substitute its own for cancellation.
      result = await checkJob({
        ...(input as Omit<Parameters<typeof checkJob>[0], 'owner' | 'signal' | 'executionContext'>),
        signal,
        executionContext,
        owner: trustedJobOwner,
      })
    } else if (toolName === 'kill_job') {
      result = await killJob({
        ...(input as Omit<Parameters<typeof killJob>[0], 'owner'>),
        owner: trustedJobOwner,
      })
    } else if (toolName === 'read_logs') {
      const readLogsInput = input as Omit<
        Parameters<typeof readLogs>[0],
        'cwd' | 'owner' | 'fileFilter'
      >
      result = await readLogs({
        ...readLogsInput,
        cwd: requireCwd(cwd, 'read_logs'),
        owner: trustedJobOwner,
        // ER-4: host read policy is runtime-injected, exactly like the
        // read_image / list_directory branches; model input cannot supply it.
        fileFilter,
        readPolicy: fs.hostReadPolicy,
      })
    } else if (toolName === 'list_jobs') {
      // Any model-supplied `input.owner` is ignored entirely; scoping always
      // comes from the trusted run owner.
      result = await listJobs({ owner: trustedJobOwner })
    } else if (toolName === 'git_status') {
      const gitStatusInput = input as Omit<
        Parameters<typeof gitStatus>[0],
        'cwd'
      >
      result = await gitStatus({
        ...gitStatusInput,
        cwd: requireCwd(cwd, 'git_status'),
        signal,
        executionContext,
      })
    } else if (toolName === 'inspect_workspace') {
      result = await inspectWorkspace({
        cwd: requireCwd(cwd, 'inspect_workspace'),
        signal,
        executionContext,
      })
    } else if (toolName === 'get_task') {
      result = getTask({
        cwd: requireCwd(cwd, 'get_task'),
        session: (input as { session?: string }).session,
      })
    } else if (toolName === 'get_change_review_bundle') {
      result = await getChangeReviewBundle({
        cwd: requireCwd(cwd, 'get_change_review_bundle'),
        max_chars: (input as { max_chars?: number }).max_chars,
        stateDir: harnessStateDir,
        workspaceState: getWorkspaceState(),
        signal,
        executionContext,
      })
    } else if (toolName === 'run_targeted_validation') {
      const validationInput = input as {
        snapshot_id: string
        files: string[]
        artifact_kinds?: string[]
      }
      result = await runTargetedValidation({
        cwd: requireCwd(cwd, 'run_targeted_validation'),
        snapshotId: validationInput.snapshot_id,
        files: validationInput.files,
        artifactKinds: validationInput.artifact_kinds,
        env,
        signal,
        fileSystem: fs,
        diagnosticDelta,
        executionContext,
        capturedConfiguration: capturedHookConfiguration,
        diagnosticPreflightEnabled,
        terminalShell,
        getTerminalLaunchMetadata,
        workspaceState: getWorkspaceState(),
      })
    } else if (toolName === 'inspect_environment') {
      result = await inspectEnvironment(
        requireCwd(cwd, 'inspect_environment'),
        signal,
        executionContext,
      )
    } else if (toolName === 'get_affected_tests') {
      result = await getAffectedTests(
        requireCwd(cwd, 'get_affected_tests'),
        (input as { files: string[] }).files,
        signal,
      )
    } else if (toolName === 'go_to_definition') {
      result = await goToDefinition(
        resolveLanguageIntelligence(),
        input as { path: string; line: number; character: number },
        lspRequest,
      )
    } else if (toolName === 'find_references') {
      result = await findReferences(
        resolveLanguageIntelligence(),
        input as { path: string; line: number; character: number },
        lspRequest,
      )
    } else if (toolName === 'hover_type') {
      result = await hoverType(
        resolveLanguageIntelligence(),
        input as { path: string; line: number; character: number },
        lspRequest,
      )
    } else if (toolName === 'workspace_symbol') {
      result = await workspaceSymbol(
        resolveLanguageIntelligence(),
        input as { query: string },
        lspRequest,
      )
    } else if (toolName === 'rename_symbol') {
      // P4-T2: the semantic-edit apply tools route their changed files through
      // the SAME multi-file commit path as edit_transaction (per-file broker
      // CAS, CommitReceiptV1s, P2-T5 intent log, rollback). The deps passed
      // below mirror the edit_transaction branch exactly. Their published
      // output is a compact named result rather than a file_mutation_result
      // payload, so the underlying mutation rides the compact-receipt channel
      // (the writeAuditFindings precedent) into the post-dispatch block and
      // the journaling/LSP-sync wiring stays automatic with no new machinery.
      const applied = await renameSymbol(
        resolveLanguageIntelligence(),
        input as {
          path: string
          line: number
          character: number
          new_name: string
        },
        {
          cwd: requireCwd(cwd, toolName),
          fs,
          signal,
          fileFilter,
          filesystemPolicy,
          capabilityIssuer,
          intentLog,
          callId: action.requestId,
          logger,
        },
        lspRequest,
      )
      result = applied.output
      compactReceiptMutation = applied.mutation
    } else if (toolName === 'code_action') {
      const applied = await codeAction(
        resolveLanguageIntelligence(),
        input as {
          path: string
          line: number
          character: number
          kind: string
        },
        {
          cwd: requireCwd(cwd, toolName),
          fs,
          signal,
          fileFilter,
          filesystemPolicy,
          capabilityIssuer,
          intentLog,
          callId: action.requestId,
          logger,
        },
        lspRequest,
      )
      result = applied.output
      compactReceiptMutation = applied.mutation
    } else if (toolName === 'extract_symbol') {
      const applied = await extractSymbol(
        resolveLanguageIntelligence(),
        input as {
          path: string
          line: number
          character: number
          destination_path: string
          symbol_name: string
        },
        {
          cwd: requireCwd(cwd, toolName),
          fs,
          signal,
          fileFilter,
          filesystemPolicy,
          capabilityIssuer,
          intentLog,
          callId: action.requestId,
          logger,
        },
        lspRequest,
      )
      result = applied.output
      compactReceiptMutation = applied.mutation
    } else if (toolName === 'get_build_targets') {
      result = await getBuildTargets(
        requireCwd(cwd, 'get_build_targets'),
        (input as { files: string[] }).files,
        signal,
        executionContext,
      )
    } else if (toolName === 'inspect_codebase_structure') {
      result = inspectCodebaseStructureTool(
        requireCwd(cwd, toolName),
        (input as { scope?: string[] }).scope,
      )
    } else if (toolName === 'inspect_feature_completeness') {
      result = inspectFeatureCompletenessTool(
        requireCwd(cwd, toolName),
        input as { feature: string; snapshot_id: string; scope?: string[] },
      )
    } else if (toolName === 'evaluate_audit_coverage') {
      result = evaluateAuditCoverageTool(
        requireCwd(cwd, toolName),
        input as Parameters<typeof evaluateAuditCoverageTool>[1],
      )
    } else if (toolName === 'git_branch') {
      // The Zod schema (`common/src/tools/params/tool/git-branch.ts`) exposes
      // snake_case input: `{ branch_name, switch, allow_dirty }`. The SDK
      // `gitBranch()` function (`sdk/src/tools/git-branch.ts`) expects
      // camelCase: `{ branchName, switch, allowDirty }`. Map the keys
      // explicitly here — an unsafe `...gitBranchInput` spread would pass
      // `branch_name`/`allow_dirty` through verbatim, leaving `branchName`
      // as `undefined` (fails the name regex → every dispatch call errors).
      // `switch` is the same key in both shapes; it is forwarded as-is.
      const branchInput = input as {
        branch_name: string
        switch?: boolean
        allow_dirty?: boolean
      }
      const branchResult = await gitBranch({
        branchName: branchInput.branch_name,
        switch: branchInput.switch,
        allowDirty: branchInput.allow_dirty,
        cwd: requireCwd(cwd, 'git_branch'),
        signal,
        executionContext,
      })
      // gitBranch returns a single GitBranchResult object; the dispatcher
      // expects a ToolResultOutput[] (array of { type: 'json', value }).
      // Mirror the shape gitStatus returns by wrapping the value in a tuple.
      const { errorMessage, ...successValue } = branchResult
      result = [
        {
          type: 'json',
          value: errorMessage !== undefined ? { errorMessage, ...(branchResult.executionRefusal ? { executionRefusal: branchResult.executionRefusal } : {}) } : successValue,
        },
      ]
    } else {
      throw new Error(
        `Tool not implemented in SDK. Please provide an override or modify your agent to not use this tool: ${toolName}`,
      )
    }
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError(signal)
    }
    result = [
      {
        type: 'json',
        value: {
          errorMessage:
            error &&
            typeof error === 'object' &&
            'message' in error &&
            typeof error.message === 'string'
              ? error.message
              : typeof error === 'string'
                ? error
                : 'Unknown error',
          ...(isExecutionRefusalError(error) ? { executionRefusal: error.refusal } :
            executionRefusalFromError(error)),
        },
      },
    ]
  }
  // Shared selector, so this scan cannot diverge from the one the
  // compact-receipt tools run over their own output parts.
  const resultMutation = findFileMutationResult(result)
  // Fall back to the compact-receipt channel (see its declaration).
  const mutationValue = resultMutation ?? compactReceiptMutation ?? null
  const confirmedActions = mutationValue
    ? getConfirmedAppliedActionsV1(mutationValue)
    : []
  if (!canonicalReceipt && mutationValue && cwd) {
    canonicalReceipt = getDefaultFilesystemAuthority(cwd, fs, fileFilter, filesystemPolicy)
      .getCanonicalReceipt(mutationValue.operationId, action.requestId)
  }
  // `mutationValue` is re-tested here so TypeScript narrows it for the whole
  // block below instead of repeating non-null assertions on every use.
  if (mutationValue && confirmedActions.length > 0) {
    // Shaped once and reused below, so the journal record and the emitted
    // event can never describe different actions.
    const changedActions: FilesystemMutationEvent['actions'] =
      confirmedActions.map((confirmed) => ({
        action: confirmed.action,
        path: confirmed.path,
        ...(confirmed.destinationPath
          ? { destinationPath: confirmed.destinationPath }
          : {}),
        beforeHash: confirmed.beforeHash,
        afterHash: confirmed.afterHash,
      }))
    const workspaceChange = {
      source: `sdk:${toolName}`,
      operationId: mutationValue.operationId,
      ...(mutationValue.receiptId
        ? { receiptId: mutationValue.receiptId }
        : {}),
      actions: changedActions,
    }
    const beforeWorkspaceState = getWorkspaceState()
    const workspaceState = advanceWorkspaceJournal
      ? advanceWorkspaceJournal(workspaceChange)
      : advanceWorkspaceState(beforeWorkspaceState, workspaceChange)
    setWorkspaceState(workspaceState)
    confirmedWorkspaceState = workspaceState
    onConfirmedWorkspaceTransition?.({ before: beforeWorkspaceState, after: workspaceState, ...workspaceChange, canonicalReceipt })
    // Audit fix (C): push the committed files into any already-running
    // language server so post-edit LSP answers are not stale. Guarded and
    // fail-open: sync can never fail the run that just committed the write.
    // Only successfully-written project-relative paths are synced; a move
    // syncs its destination path.
    const syncedPaths = changedActions
      .filter((changed) => changed.action !== 'delete')
      .map((changed) =>
        changed.action === 'move' ? changed.destinationPath : changed.path,
      )
      .filter((changedPath): changedPath is string => Boolean(changedPath))
    // Audit fix: deleted paths are forwarded separately as a didClose so a
    // warm language server drops its stale open-document state for files
    // that no longer exist (they are excluded from syncedPaths above).
    const closedPaths = changedActions
      .filter((changed) => changed.action === 'delete')
      .map((changed) => changed.path)
      .filter((changedPath): changedPath is string => Boolean(changedPath))
    if (syncedPaths.length > 0 || closedPaths.length > 0) {
      try {
        await getLanguageIntelligence?.().syncMutatedFiles(syncedPaths, {
          closedPaths,
        }, lspRequest)
      } catch (error) {
        logger?.warn({ error }, 'Language-server document sync failed')
      }
    }
    // Only a mutation that was actually part of `result` can be enriched in
    // place. Tools whose declared output is a compact receipt reach this block
    // through `compactReceiptMutation`; their receipt schema declares no
    // workspace fields (a consumer parsing it through `outputSchema` would
    // strip them), so those hosts read the coordinates from the
    // FilesystemMutationEvent emitted below instead.
    if (resultMutation) {
      const enrichedMutation = fileMutationResultV1Schema.parse({
        ...mutationValue,
        workspaceRevision: workspaceState.revision,
        workspaceSnapshotId: workspaceState.snapshotId,
        ...(mutationValue.authorityReceipt
          ? {
              authorityReceipt: {
                ...mutationValue.authorityReceipt,
                workspaceRevision: workspaceState.revision,
                workspaceSnapshotId: workspaceState.snapshotId,
              },
            }
          : {}),
      })
      result = result.map((part) =>
        part.type === 'json' && part.value === mutationValue
          ? { type: 'json' as const, value: enrichedMutation }
          : part,
      )
    }
    const event: FilesystemMutationEvent = {
      toolName,
      callId: action.requestId,
      operationId: mutationValue.operationId,
      ...(mutationValue.receiptId
        ? { receiptId: mutationValue.receiptId }
        : {}),
      workspaceRevision: workspaceState.revision,
      workspaceSnapshotId: workspaceState.snapshotId,
      actions: changedActions,
    }
    if (onFilesystemMutation) {
      try {
        await onFilesystemMutation(event)
      } catch (error) {
        logger?.warn({ error }, 'Filesystem mutation observer failed')
        try {
          await onFilesChanged?.()
        } catch (fallbackError) {
          logger?.warn(
            { error: fallbackError },
            'File-change fallback observer failed',
          )
        }
      }
    } else {
      try {
        await onFilesChanged?.()
      } catch (error) {
        logger?.warn({ error }, 'File-change observer failed')
      }
    }
  } else if (
    toolName === 'run_terminal_command' ||
    Boolean(customToolDefinitions[toolName]) ||
    Boolean(action.mcpConfig)
  ) {
    try {
      await onFilesChanged?.()
    } catch (error) {
      logger?.warn({ error }, 'Unknown-mutation observer failed')
    }
  }
  if (canonicalReceipt && confirmedWorkspaceState) {
    // These coordinates come from the local confirmed workspace transition.
    // Keep independent authority evidence aligned with the enriched envelope
    // so reconciliation can retain its verified exact after-content.
    canonicalReceipt = {
      ...canonicalReceipt,
      workspaceRevision: confirmedWorkspaceState.revision,
      workspaceSnapshotId: confirmedWorkspaceState.snapshotId,
    }
  }
  return {
    output: result,
    ...(canonicalReceipt ? { canonicalReceipt } : {}),
  }
}

/**
 * Extracts an HTTP status code from an error message string.
 * Parses common error patterns to identify the underlying status code.
 * Returns the status code if found, undefined otherwise.
 */
export const extractStatusCodeFromMessage = (
  errorMessage: string,
): number | undefined => {
  const lowerMessage = errorMessage.toLowerCase()

  // AI SDK's built-in retry error (e.g., "Failed after 4 attempts. Last error: Service Unavailable")
  // The AI SDK already retried 4 times, but we still want our SDK wrapper to retry 3 more times
  if (
    lowerMessage.includes('failed after') &&
    lowerMessage.includes('attempts')
  ) {
    // Extract the underlying error type from the message
    if (lowerMessage.includes('service unavailable')) {
      return 503
    }
    if (lowerMessage.includes('timeout')) {
      return 408
    }
    if (lowerMessage.includes('connection refused')) {
      return 503
    }
    // Default to 500 for other AI SDK retry failures
    return 500
  }

  if (
    errorMessage.includes('503') ||
    lowerMessage.includes('service unavailable')
  ) {
    return 503
  }
  if (errorMessage.includes('504')) {
    return 504
  }
  if (errorMessage.includes('502')) {
    return 502
  }
  if (lowerMessage.includes('timeout') || errorMessage.includes('408')) {
    return 408
  }
  if (
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('connection refused')
  ) {
    return 503
  }
  if (lowerMessage.includes('dns') || lowerMessage.includes('enotfound')) {
    return 503
  }
  if (lowerMessage.includes('server error') || errorMessage.includes('500')) {
    return 500
  }
  if (errorMessage.includes('429') || lowerMessage.includes('rate limit')) {
    return 429
  }
  if (
    lowerMessage.includes('network error') ||
    lowerMessage.includes('fetch failed')
  ) {
    return 503
  }

  return undefined
}

async function handlePromptResponse({
  action,
  resolve,
  onError,
  initialSessionState,
}: {
  action: ServerAction<'prompt-response'> | ServerAction<'prompt-error'>
  resolve: (value: RunReturnType) => any
  onError: (error: { message: string }) => void
  initialSessionState: SessionState
}) {
  if (action.type === 'prompt-error') {
    onError({ message: action.message })

    const statusCode = extractStatusCodeFromMessage(action.message)
    resolve({
      sessionState: initialSessionState,
      output: {
        type: 'error',
        message: action.message,
        ...(statusCode !== undefined && { statusCode }),
      },
    })
  } else if (action.type === 'prompt-response') {
    // Stop enforcing session state schema! It's a black box we will pass back to the server.
    // Only check the output schema.
    const parsedOutput = AgentOutputSchema.safeParse(action.output)
    if (!parsedOutput.success) {
      const message = [
        'Received invalid prompt response from server:',
        JSON.stringify(parsedOutput.error.issues),
        'If this issues persists, please contact support@openbuff.dev',
      ].join('\n')
      onError({ message })
      resolve({
        sessionState: initialSessionState,
        output: {
          type: 'error',
          message,
        },
      })
      return
    }
    const { sessionState, output } = action

    const state: RunState = {
      sessionState,
      output: output ?? {
        type: 'error',
        message: 'No output from agent',
      },
    }
    resolve(state)
  } else {
    action satisfies never
    onError({
      message: 'Internal error: prompt response type not handled',
    })
    resolve({
      sessionState: initialSessionState,
      output: {
        type: 'error',
        message: 'Internal error: prompt response type not handled',
      },
    })
  }
}
