import path from 'path'

import { MAX_AGENT_STEPS_DEFAULT } from '@codebuff/common/constants/agents'
import { AskUserBridge } from '@codebuff/common/utils/ask-user-bridge'
import { IndexManager } from '@codebuff/indexer'
import { loadProviderConfigSync } from '@openbuff/sdk'

import { getProjectRoot } from '../project-files'
import {
  createEventHandler,
  createStreamChunkHandler,
} from './sdk-event-handlers'
import { ensureIndexWorkspaceWatcher } from './index-workspace-watcher'

import type { EventHandlerState } from './sdk-event-handlers'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { AgentState } from '@codebuff/common/types/session-state'
import type {
  AgentDefinition,
  FileFilter,
  MessageContent,
  RunState,
  FilesystemMutationEvent,
} from '@openbuff/sdk'

export type CreateRunConfigParams = {
  logger: Logger
  agent: AgentDefinition | string
  prompt: string
  content: MessageContent[] | undefined
  previousRunState: RunState | null
  agentDefinitions: AgentDefinition[]
  eventHandlerState: EventHandlerState
  signal: AbortSignal
  costMode?: 'lite' | 'normal' | 'max' | 'experimental' | 'ask'
  extraCodebuffMetadata?: Record<string, string>
  // P2-3: Mid-turn checkpoint. When provided, the SDK invokes this callback
  // with the main agent's state snapshot every ~30s during the step loop.
  // The CLI host persists it so a crashed session can resume mid-turn.
  onCheckpoint?: (agentState: AgentState) => void
  // P2-3: When true, the user prompt is already present in the restored
  // messageHistory (from a checkpoint), so loopAgentSteps must NOT re-append it.
  resumeInterruptedTurn?: boolean
}

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.crt',
  '.cer',
])
const SENSITIVE_BASENAMES = new Set([
  '.htpasswd',
  '.netrc',
  'credentials',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'auth.json',
  '.pypirc',
  'terraform.tfvars',
  '.terraformrc',
])

// Pattern matches (grouped by match type)
const SENSITIVE_PATTERNS = {
  prefix: ['id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa'], // SSH private keys
  suffix: ['_credentials'],
  substring: ['kubeconfig', '.tfstate'],
}

const isEnvFile = (basename: string) =>
  (basename === '.env' || basename.startsWith('.env.')) &&
  !isEnvTemplateFile(basename)

const matchesPattern = (str: string) =>
  SENSITIVE_PATTERNS.prefix.some(
    (p) => str.startsWith(p) && !str.endsWith('.pub'),
  ) ||
  SENSITIVE_PATTERNS.suffix.some((s) => str.endsWith(s)) ||
  SENSITIVE_PATTERNS.substring.some((sub) => str.includes(sub))

const ENV_TEMPLATE_SUFFIXES = ['.env.example', '.env.sample', '.env.template']

export const isEnvTemplateFile = (filePath: string) =>
  ENV_TEMPLATE_SUFFIXES.some((suffix) =>
    path.basename(filePath).endsWith(suffix),
  )

/**
 * Check if a file is a sensitive file that should be blocked from reading.
 */
export function isSensitiveFile(filePath: string): boolean {
  const basename = path.basename(filePath)
  const basenameLower = basename.toLowerCase()
  const ext = path.extname(filePath).toLowerCase()

  return (
    isEnvFile(basename) ||
    SENSITIVE_EXTENSIONS.has(ext) ||
    SENSITIVE_BASENAMES.has(basenameLower) ||
    matchesPattern(basenameLower)
  )
}

/**
 * Resolve the optional per-run agent step cap. Unset defaults to unlimited;
 * `maxAgentSteps` remains available for users who want a fixed bound.
 */
function resolveMaxAgentSteps(): number {
  try {
    const configured = loadProviderConfigSync().config.maxAgentSteps
    if (
      typeof configured === 'number' &&
      (configured === -1 || configured > 0)
    ) {
      return Math.floor(configured)
    }
  } catch {
    // Best-effort; never let config loading break run creation.
  }
  return MAX_AGENT_STEPS_DEFAULT
}

const HARNESS_APPROVAL_TARGET_DISPLAY_MAX = 200

export type HarnessApprovalRequest = {
  action: string
  target: string
  reason: string
  risk: 'routine' | 'high'
}

function truncateForApprovalDisplay(
  target: string,
  maxLength = HARNESS_APPROVAL_TARGET_DISPLAY_MAX,
): string {
  if (target.length <= maxLength) return target
  return `${target.slice(0, Math.max(0, maxLength - 1))}…`
}

/**
 * Build the ask-user question payload for harness terminal approvals.
 * Keeps the Allow once label stable so createRunConfig can check the selection.
 */
export function buildHarnessApprovalPrompt(request: HarnessApprovalRequest) {
  const displayTarget = truncateForApprovalDisplay(request.target)
  const isHighRisk = request.risk === 'high'

  return {
    header: isHighRisk ? 'High-risk action' : 'Confirm action',
    question: isHighRisk
      ? `This may destroy data, deploy, or run eval code.\nAllow ${request.action}: ${displayTarget}?`
      : `Allow ${request.action}?\n${displayTarget}`,
    options: [
      {
        label: 'Allow once',
        description: isHighRisk
          ? `${request.reason} Runs once for this command only. High impact: may destroy worktree data, deploy, or evaluate code.`
          : `${request.reason} Routine classified action; single-use for this exact target.`,
      },
      {
        label: 'Deny',
        description: 'Block this command and continue without running it.',
      },
    ],
    multiSelect: false as const,
  }
}

export const createRunConfig = (params: CreateRunConfigParams) => {
  const {
    logger,
    agent,
    prompt,
    content,
    previousRunState,
    agentDefinitions,
    eventHandlerState,
    costMode,
    extraCodebuffMetadata,
    onCheckpoint,
    resumeInterruptedTurn,
  } = params

  try {
    const indexingConfig = loadProviderConfigSync().config.indexing
    if (indexingConfig.enabled !== false) {
      const projectRoot = getProjectRoot()
      const manager = IndexManager.getInstance(projectRoot, indexingConfig)
      ensureIndexWorkspaceWatcher({
        projectRoot,
        config: indexingConfig,
        manager,
      })
    }
  } catch {
    // Best-effort; age-based index integrity sweeps remain available.
  }

  const approvalMode =
    loadProviderConfigSync().config.approvalMode ?? 'balanced'

  return {
    logger,
    agent,
    prompt,
    content,
    previousRun: previousRunState ?? undefined,
    agentDefinitions,
    maxAgentSteps: resolveMaxAgentSteps(),
    handleStreamChunk: createStreamChunkHandler(eventHandlerState),
    handleEvent: createEventHandler(eventHandlerState),
    signal: params.signal,
    costMode,
    extraCodebuffMetadata,
    onCheckpoint,
    resumeInterruptedTurn,
    approvalMode,
    requestApproval: async (request: HarnessApprovalRequest) => {
      const response = (await AskUserBridge.request('harness-approval', [
        buildHarnessApprovalPrompt(request),
      ])) as {
        answers?: Array<{ selectedOption?: string }>
        skipped?: boolean
      }
      return response.answers?.[0]?.selectedOption === 'Allow once'
    },
    onFilesystemMutation: (event: FilesystemMutationEvent) => {
      try {
        const indexingConfig = loadProviderConfigSync().config.indexing
        if (indexingConfig.enabled === false) return
        const changedPaths: string[] = []
        const deletedPaths: string[] = []
        for (const action of event.actions) {
          if (action.action === 'delete') {
            deletedPaths.push(action.path)
          } else if (action.action === 'move') {
            deletedPaths.push(action.path)
            if (action.destinationPath)
              changedPaths.push(action.destinationPath)
          } else {
            changedPaths.push(action.path)
          }
        }
        IndexManager.getInstance(
          getProjectRoot(),
          indexingConfig,
        ).markPathsChanged({
          changedPaths,
          deletedPaths,
          complete: true,
          revision: event.workspaceRevision,
        })
      } catch {
        // Best-effort; never let index bookkeeping affect the run.
      }
    },
    // Unknown mutation surfaces (terminal/custom/MCP tools) cannot provide a
    // safe path delta. Retain the compatibility callback as a conservative
    // full-refresh fallback; confirmed SDK mutations use the detailed callback
    // above and do not invoke this path.
    onFilesChanged: () => {
      try {
        const indexingConfig = loadProviderConfigSync().config.indexing
        if (indexingConfig.enabled === false) return
        IndexManager.getInstance(getProjectRoot(), indexingConfig).markStale()
      } catch {
        // Best-effort; never let index bookkeeping affect the run.
      }
    },
    fileFilter: ((filePath: string) => {
      if (isSensitiveFile(filePath)) return { status: 'blocked' }
      if (isEnvTemplateFile(filePath)) return { status: 'allow-example' }
      return { status: 'allow' }
    }) satisfies FileFilter,
  }
}
