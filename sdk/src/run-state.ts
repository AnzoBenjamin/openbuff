import * as os from 'os'
import path from 'path'
import { createHash } from 'node:crypto'

import { getFileTokenScores } from '@codebuff/code-map/parse'
import { getSystemInfo } from '@codebuff/common/util/system-info'
import {
  KNOWLEDGE_FILE_NAMES_LOWERCASE,
  isKnowledgeFile,
} from '@codebuff/common/constants/knowledge'
import {
  getProjectFileTree,
  getAllFilePaths,
} from '@codebuff/common/project-file-tree'
import {
  getInitialSessionState,
  sanitizeAgentStateSecurityMaps,
} from '@codebuff/common/types/session-state'
import { getErrorObject } from '@codebuff/common/util/error'
import { cloneDeep } from 'lodash'
import z from 'zod/v4'
import { externalToolAlias } from '@codebuff/common/tools/external-tool'
import { toolNames } from '@codebuff/common/tools/constants'
import {
  assertExternalToolInputSchema,
  projectHostToolInputSchema,
  projectZodSchema,
  type JsonSchema,
} from '@codebuff/common/util/json-schema'

import { getSdkEnv } from './env'
import { loadLocalAgents } from './agents/load-agents'
import {
  codebuffFsToNodePromises,
  loadPersistedTaskMemory,
  reconcileTaskMemoryEvidence,
} from './services/task-memory-store'
import { loadSkills } from './skills/load-skills'
import { loadInstructionFiles } from './instruction-files'
import { runGit } from './tools/git-status'

// Re-export for SDK consumers
export {
  KNOWLEDGE_FILE_NAMES,
  PRIMARY_KNOWLEDGE_FILE_NAME,
  isKnowledgeFile,
} from '@codebuff/common/constants/knowledge'

import type { CustomToolDefinition } from './custom-tool'
import type { LoadedInstructionFiles } from './instruction-files'
import type { WorkspaceMoveRecord } from './services/task-memory-store'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  ActionOutcome,
  RunOutcome,
  TaskAcceptance,
} from '@codebuff/common/types/run-outcome'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type {
  AgentOutput,
  AgentState,
  SessionState,
} from '@codebuff/common/types/session-state'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'
import type { CleanupResult } from '@codebuff/common/types/contracts/process-scope'
import type {
  CustomToolDefinitions,
  FileTreeNode,
} from '@codebuff/common/util/file'
import type * as fsType from 'fs'

/**
 * Given a list of candidate file paths, selects the one with highest priority.
 * Priority order: knowledge.md > AGENTS.md > CLAUDE.md (case-insensitive).
 * Returns undefined if no knowledge files are found.
 * @internal Exported for testing
 */
export function selectHighestPriorityKnowledgeFile(
  candidates: string[],
): string | undefined {
  // Loop through priorities and find the first match directly
  for (const priorityName of KNOWLEDGE_FILE_NAMES_LOWERCASE) {
    const match = candidates.find((f) => f.toLowerCase().endsWith(priorityName))
    if (match) return match
  }
  return undefined
}

export type RunState = {
  sessionState?: SessionState
  output: AgentOutput
  runOutcome?: RunOutcome
  taskAcceptance?: TaskAcceptance
  actionOutcomes?: ActionOutcome[]
  /** Physical root-owned cleanup observations, collected after logical completion. */
  executionCleanup?: readonly CleanupResult[]
}

/** Project the runtime's three outcome levels onto the public SDK result. */
export function projectRunOutcomes(
  state: RunState,
  overrides?: { runOutcome?: RunOutcome; taskAcceptance?: TaskAcceptance },
): RunState {
  const agentState = state.sessionState?.mainAgentState
  let runOutcome =
    overrides?.runOutcome ??
    state.runOutcome ??
    agentState?.runOutcome ??
    (state.output.type === 'error'
      ? {
          termination: 'failed' as const,
          cause: { code: 'run_error', message: state.output.message },
        }
      : undefined)
  if (
    state.output.type === 'error' &&
    runOutcome?.termination === 'completed'
  ) {
    runOutcome = {
      termination: 'failed',
      cause: { code: 'run_error', message: state.output.message },
    }
  }
  const taskAcceptance = overrides?.taskAcceptance ??
    state.taskAcceptance ??
    agentState?.taskAcceptance ?? { status: 'unknown' as const }
  const actionOutcomes =
    state.actionOutcomes ?? agentState?.actionOutcomes ?? []
  const output =
    runOutcome &&
    runOutcome.termination !== 'completed' &&
    state.output.type !== 'error'
      ? {
          type: 'error' as const,
          message:
            runOutcome.cause?.message ??
            `Run ${runOutcome.termination.replaceAll('_', ' ')}.`,
        }
      : state.output
  return {
    ...state,
    output,
    ...(runOutcome ? { runOutcome } : {}),
    taskAcceptance,
    actionOutcomes,
    ...(state.sessionState && agentState
      ? {
          sessionState: {
            ...state.sessionState,
            mainAgentState: {
              ...agentState,
              ...(runOutcome ? { runOutcome } : {}),
              taskAcceptance,
              actionOutcomes,
            },
          },
        }
      : {}),
  }
}

/**
 * Defense-in-depth runtime guard for the targeted-copy contract
 * (targeted-copy-shared-nodes-contract): withMessageHistory and
 * applyOverridesToSessionState deliberately SHARE deeper nested nodes
 * (taskMemory, workspaceState, playbookContext, message-history entry
 * objects, fileContext subtrees) instead of deep-cloning them, so isolation
 * between RunState generations rests on the copy-on-write convention — every
 * runtime writer assigns a freshly built revision rather than mutating in
 * place. A single mutating consumer would otherwise silently corrupt the
 * caller's original state across runs.
 *
 * Freezing the shared nested nodes makes any in-place nested write from such
 * a consumer fail loudly (frozen-object TypeError in strict mode) or no-op,
 * instead of silently aliasing state across runs. DEV AND TEST ONLY: under
 * NODE_ENV=production the traversal is skipped so the hot run-startup path
 * pays no per-state O(state-graph) freeze cost.
 */
function deepFreezeSharedStateNodes(value: unknown): void {
  if (getSdkEnv().NODE_ENV === 'production') return
  const seen = new Set<object>()
  const freezeDeep = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const obj = node as object
    if (seen.has(obj)) return
    seen.add(obj)
    Object.freeze(obj)
    for (const key of Object.keys(obj)) {
      freezeDeep((obj as Record<string, unknown>)[key])
    }
  }
  freezeDeep(value)
}

export type InitialSessionStateOptions = {
  cwd?: string
  /** Captured root for session metadata and skills when workspace cwd is absent. */
  contextCwd?: string
  /** Captured home directory. null disables home lookup; undefined retains standalone defaults. */
  homeDir?: string | null
  /** Include home skill directories. Defaults to true for standalone callers. */
  includeGlobalSkills?: boolean
  /**
   * Include project `.agents/skills` / `.claude/skills`. Defaults to true for
   * standalone callers; `run()` passes its project trust decision (N02).
   */
  includeProjectSkills?: boolean
  /** Optional directory path to load skills from. When provided, skills are loaded from this directory instead of the default locations. */
  skillsDir?: string
  projectFiles?: Record<string, string>
  projectContextMode?: 'paths' | 'symbols'
  knowledgeFiles?: Record<string, string>
  /** User-provided knowledge files that will be merged with home directory files */
  userKnowledgeFiles?: Record<string, string>
  agentDefinitions?: AgentDefinition[]
  customToolDefinitions?: CustomToolDefinition[]
  maxAgentSteps?: number
  fs?: CodebuffFileSystem
  spawn?: CodebuffSpawn
  /** Captured host authority for optional startup Git observations. */
  executionContext?: ExecutionAdapterContext
  logger?: Logger
  /** Set false to skip loading persisted task memory for this session. */
  persistentMemory?: boolean
  /** Known file moves used to rebind persisted evidence paths at hydration. */
  workspaceMoves?: WorkspaceMoveRecord[]
}

/**
 * Processes agent definitions array and converts handleSteps functions to strings
 */
function processAgentDefinitions(
  agentDefinitions: AgentDefinition[],
): Record<string, any> {
  const processedAgentTemplates: Record<string, any> = {}
  agentDefinitions.forEach((definition) => {
    const processedConfig = { ...definition } as Record<string, any>
    if (
      processedConfig.handleSteps &&
      typeof processedConfig.handleSteps === 'function'
    ) {
      processedConfig.handleSteps = processedConfig.handleSteps.toString()
    }
    if (processedConfig.id) {
      processedAgentTemplates[processedConfig.id] = processedConfig
    }
  })
  return processedAgentTemplates
}

/**
 * Processes custom tool definitions into the format expected by SessionState.
 * Converts Zod schemas to JSON Schema format so they can survive JSON serialization.
 */
function hasObjectInputSchema(schema: JsonSchema): boolean {
  if (schema === false) return true
  if (schema === true) return false
  if (schema.type === 'object') return true
  if (
    Array.isArray(schema.type) &&
    schema.type.length &&
    schema.type.every((type) => type === 'object')
  )
    return true
  if (
    Array.isArray(schema.allOf) &&
    schema.allOf.some((member) => hasObjectInputSchema(member))
  )
    return true
  return ['anyOf', 'oneOf'].some(
    (key) =>
      Array.isArray(schema[key]) &&
      schema[key].length > 0 &&
      schema[key].every((member: JsonSchema) => hasObjectInputSchema(member)),
  )
}

function processCustomToolDefinitions(
  customToolDefinitions: CustomToolDefinition[],
): CustomToolDefinitions {
  const definitions: CustomToolDefinitions = Object.create(null)
  const names = new Set<string>()
  for (const toolDefinition of customToolDefinitions) {
    const identity = {
      kind: 'custom' as const,
      toolName: toolDefinition.toolName,
    }
    const alias = externalToolAlias(identity)
    if (
      names.has(toolDefinition.toolName) ||
      Object.hasOwn(definitions, alias)
    ) {
      throw new Error(
        `Duplicate custom tool identity or alias: ${toolDefinition.toolName}`,
      )
    }
    if (toolNames.includes(alias as (typeof toolNames)[number])) {
      throw new Error(
        `Custom tool conflicts with built-in tool: ${toolDefinition.toolName}`,
      )
    }
    names.add(toolDefinition.toolName)
    // Convert Zod schema to JSON Schema format so it survives JSON serialization
    // The agent-runtime will wrap this with AI SDK's jsonSchema() helper
    // Check the original input shape before advisory normalization can omit
    // declared fields. A transform-created handler member is not an input.
    assertExternalToolInputSchema(
      projectZodSchema(toolDefinition.inputSchema, 'input'),
    )
    const jsonSchema = projectHostToolInputSchema(toolDefinition.inputSchema)
    if (!hasObjectInputSchema(jsonSchema))
      throw new Error(
        `Unsupported input schema for custom tool ${toolDefinition.toolName}: tool calls require an object-root input schema.`,
      )
    definitions[alias] = {
      inputSchema: jsonSchema,
      description: toolDefinition.description,
      endsAgentStep: toolDefinition.endsAgentStep,
      exampleInputs: toolDefinition.exampleInputs,
      identity,
      ...(toolDefinition.pathParameters
        ? { pathParameters: toolDefinition.pathParameters }
        : {}),
    }
  }
  return definitions
}

/**
 * Computes project file indexes (file tree and token scores)
 */
type ProjectIndexInput = {
  cwd: string
  fileTree: FileTreeNode[]
  filePaths: string[]
  readFile?: (filePath: string) => string | null | Promise<string | null>
  logger?: Logger
  fsIdentity: CodebuffFileSystem
}

// Keep only the last reusable project index. The cache contains digests, not
// source text; callers receive copies so later session mutations cannot alter
// the retained result. Incomplete parses must be retried normally.
let completeProjectIndexCache:
  | {
      cwd: string
      fsIdentity: CodebuffFileSystem
      scoreProject: typeof getFileTokenScores
      filePaths: string[]
      digests: Map<string, string>
      fileTokenScores: Record<string, any>
      tokenCallers: Record<string, any>
    }
  | undefined

const contentDigest = (content: string): string =>
  createHash('sha256').update(content).digest('hex')

const MAX_DISCOVERED_PROJECT_READ_BYTES = 1_000_000

/**
 * Session-boot parse budget: computeProjectIndex runs before the first LLM
 * call, so its tree-sitter pass must stay bounded regardless of repository
 * size. The indexer's own build keeps the generous library defaults; this
 * budget bounds only the synchronous-feeling cold-start pass. 64MB covers
 * every repository the file-tree discovery (gitignore-aware) can yield in
 * practice without truncating, while capping pathological workspaces.
 * Exported for testing.
 */
export const SESSION_STATE_MAX_TOTAL_PARSE_BYTES = 64_000_000

export async function computeProjectIndex(
  params: ProjectIndexInput,
  scoreProject: typeof getFileTokenScores = getFileTokenScores,
): Promise<{
  fileTree: FileTreeNode[]
  fileTokenScores: Record<string, any>
  tokenCallers: Record<string, any>
}> {
  const { cwd, fileTree, filePaths, readFile, logger, fsIdentity } = params
  let fileTokenScores = {}
  let tokenCallers = {}

  if (filePaths.length > 0) {
    try {
      const cached = completeProjectIndexCache
      if (
        readFile &&
        cached &&
        cached.cwd === cwd &&
        cached.fsIdentity === fsIdentity &&
        cached.scoreProject === scoreProject &&
        cached.filePaths.length === filePaths.length &&
        filePaths.every((filePath, i) => filePath === cached.filePaths[i])
      ) {
        let unchanged = true
        for (const filePath of cached.digests.keys()) {
          let content: string | null
          try {
            content = await readFile(filePath)
          } catch {
            unchanged = false
            break
          }
          if (
            content === null ||
            contentDigest(content) !== cached.digests.get(filePath)
          ) {
            unchanged = false
            break
          }
        }
        if (unchanged) {
          return {
            fileTree,
            fileTokenScores: structuredClone(cached.fileTokenScores),
            tokenCallers: structuredClone(cached.tokenCallers),
          }
        }
      }
      const digests = new Map<string, string>()
      const trackingReader =
        readFile &&
        (async (filePath: string) => {
          const content = await readFile(filePath)
          if (content !== null) digests.set(filePath, contentDigest(content))
          return content
        })
      const tokenData = await scoreProject(
        cwd,
        filePaths,
        trackingReader,
        undefined,
        { maxTotalBytes: SESSION_STATE_MAX_TOTAL_PARSE_BYTES },
      )
      fileTokenScores = tokenData.tokenScores
      tokenCallers = tokenData.tokenCallers
      // Unsupported extensions are deterministically skipped independent of
      // file contents. Any other skipped file (budget, I/O, grammar failure)
      // may become parseable later and must prevent caching.
      const onlyUnsupported =
        tokenData.coverage.skippedFiles === tokenData.diagnostics.length &&
        tokenData.diagnostics.every(
          (diagnostic) =>
            diagnostic.stage === 'language' &&
            diagnostic.message.startsWith(
              'No tree-sitter language configuration available',
            ),
        )
      if (onlyUnsupported && digests.size === tokenData.coverage.parsedFiles) {
        completeProjectIndexCache = {
          cwd,
          fsIdentity,
          scoreProject,
          filePaths: [...filePaths],
          digests,
          fileTokenScores: structuredClone(fileTokenScores),
          tokenCallers: structuredClone(tokenCallers),
        }
      }
      if (tokenData.coverage?.truncated) {
        logger?.debug?.(
          {
            parsedFiles: tokenData.coverage.parsedFiles,
            skippedFiles: tokenData.coverage.skippedFiles,
            maxTotalBytes: SESSION_STATE_MAX_TOTAL_PARSE_BYTES,
          },
          'Session-state parse budget truncated token scoring',
        )
      }
    } catch (error) {
      // If token scoring fails, continue with empty scores
      logger?.debug?.(
        { error: getErrorObject(error) },
        'Failed to generate parsed symbol scores',
      )
    }
  }

  return { fileTree, fileTokenScores, tokenCallers }
}

function getProjectIndexInput(params: {
  cwd: string
  fs: CodebuffFileSystem
  logger: Logger
  projectFiles?: Record<string, string>
  discoveredProject?: { fileTree: FileTreeNode[]; filePaths: string[] }
}): ProjectIndexInput | undefined {
  const { cwd, fs, logger, projectFiles, discoveredProject } = params

  if (projectFiles) {
    const filePaths = Object.keys(projectFiles).sort()
    return {
      cwd,
      fileTree: buildFileTree(filePaths),
      filePaths,
      readFile: (filePath: string) => projectFiles[filePath] || null,
      fsIdentity: fs,
      logger,
    }
  }

  if (discoveredProject) {
    return {
      cwd,
      fileTree: discoveredProject.fileTree,
      filePaths: discoveredProject.filePaths.sort(),
      readFile: createDiscoveredProjectReader({ cwd, fs, logger }),
      fsIdentity: fs,
      logger,
    }
  }

  return undefined
}

function createDiscoveredProjectReader(params: {
  cwd: string
  fs: CodebuffFileSystem
  logger: Logger
}): (filePath: string) => Promise<string | null> {
  const { cwd, fs, logger } = params

  return async (filePath: string) => {
    const fullPath = path.join(cwd, filePath)
    try {
      const stats = await fs.stat(fullPath)
      if (getFileSize(stats) > MAX_DISCOVERED_PROJECT_READ_BYTES) {
        return null
      }
      return await fs.readFile(fullPath, 'utf8')
    } catch (error) {
      logger.debug?.(
        { filePath, error: getErrorObject(error) },
        'Failed to read discovered project file for symbol scoring',
      )
      return null
    }
  }
}

/**
 * An unknown size fails closed. `stat` is adapter-supplied, so a stat that
 * omits `size` must not read past `MAX_DISCOVERED_PROJECT_READ_BYTES`: it is
 * reported as over the cap (and therefore skipped) instead of as zero bytes,
 * which would pull every discovered file fully into memory.
 */
function getFileSize(stats: Awaited<ReturnType<CodebuffFileSystem['stat']>>) {
  return typeof stats.size === 'number' ? stats.size : Number.POSITIVE_INFINITY
}

// So a hung `git` subprocess (unusual FS state, network FS, etc.) cannot
// block session startup forever (M3-T1): a finite, conservative default
// wall-clock bound per git invocation, applied via the child's own timeout,
// with capture aborting so a hung child is killed rather than leaked.
const GIT_CHANGES_TIMEOUT_MS = 5_000

/**
 * Optional project observations use the captured host operation. Missing
 * authority leaves them unavailable without restoring ambient child inputs.
 */
async function getGitChanges(params: {
  cwd: string
  spawn?: CodebuffSpawn
  executionContext?: ExecutionAdapterContext
  logger: Logger
}): Promise<{
  status: string
  diff: string
  diffCached: string
  lastCommitMessages: string
}> {
  const { cwd, spawn, logger } = params
  const executionContext = params.executionContext && spawn
    ? Object.freeze({ ...params.executionContext, spawn }) : params.executionContext
  const read = async (argv: readonly string[], branchId: string, message: string) => {
    const result = await runGit(argv, cwd, executionContext?.signal, {
      executionContext, branchId, timeoutMs: GIT_CHANGES_TIMEOUT_MS,
    })
    if (result.exitCode !== 0) {
      logger.debug?.({ exitCode: result.exitCode, executionRefusal: result.executionRefusal }, message)
      return ''
    }
    return result.stdout
  }
  const [status, diff, diffCached, shortlog] = await Promise.all([
    read(['status'], 'session.git.status', 'Failed to get git status'),
    read(['diff'], 'session.git.diff', 'Failed to get git diff'),
    read(['diff', '--cached'], 'session.git.diff-cached', 'Failed to get git diff --cached'),
    read(['shortlog', 'HEAD~10..HEAD'], 'session.git.shortlog', 'Failed to get lastCommitMessages'),
  ])

  return {
    status,
    diff,
    diffCached,
    lastCommitMessages: shortlog.trim().split('\n').slice(1).reverse().map(line => line.trim()).join('\n'),
  }
}

/**
 * Discovers project paths using .gitignore patterns when projectFiles is undefined.
 * This intentionally does not read every file into memory; large repositories can
 * contain generated or binary files that are expensive to retain before parsing.
 */
async function discoverProjectPaths(params: {
  cwd: string
  fs: CodebuffFileSystem
}): Promise<{ fileTree: FileTreeNode[]; filePaths: string[] }> {
  const { cwd, fs } = params

  const fileTree = await getProjectFileTree({ projectRoot: cwd, fs })
  const filePaths = getAllFilePaths(fileTree)

  return { fileTree, filePaths }
}

/**
 * Loads user knowledge files from the home directory.
 * Checks for ~/.knowledge.md, ~/.AGENTS.md, and ~/.CLAUDE.md with priority fallback.
 * Matching is case-insensitive (e.g., ~/.KNOWLEDGE.md will match).
 * Returns a record with the tilde-prefixed path as key (e.g., "~/.knowledge.md").
 * @internal Exported for testing
 */
export async function loadUserKnowledgeFiles(params: {
  fs: CodebuffFileSystem
  logger: Logger
  /** Captured home directory. null disables lookup; undefined uses standalone defaults. */
  homeDir?: string | null
}): Promise<Record<string, string>> {
  const { fs, logger } = params
  if (params.homeDir === null) return {}
  const homeDir = params.homeDir === undefined ? os.homedir() : params.homeDir
  const userKnowledgeFiles: Record<string, string> = {}

  // List home directory to find knowledge files case-insensitively
  let entries: string[]
  try {
    entries = await fs.readdir(homeDir)
  } catch (error) {
    logger.debug?.(
      { homeDir, error: getErrorObject(error) },
      'Failed to read home directory',
    )
    return userKnowledgeFiles
  }

  // Find hidden files that match our knowledge file patterns (case-insensitive)
  // Build a map of lowercase name -> actual filename for priority selection
  const candidates = new Map<string, string>()
  for (const entry of entries) {
    if (!entry.startsWith('.')) continue
    const nameWithoutDot = entry.slice(1) // Remove leading dot
    const lowerName = nameWithoutDot.toLowerCase()
    if (KNOWLEDGE_FILE_NAMES_LOWERCASE.includes(lowerName)) {
      candidates.set(lowerName, entry)
    }
  }

  // Select highest priority file (priority: knowledge.md > AGENTS.md > CLAUDE.md)
  for (const priorityName of KNOWLEDGE_FILE_NAMES_LOWERCASE) {
    const actualFileName = candidates.get(priorityName)
    if (actualFileName) {
      const filePath = path.join(homeDir, actualFileName)
      try {
        const content = await fs.readFile(filePath, 'utf8')
        // Use tilde notation with the actual filename (preserving case)
        const tildeKey = `~/${actualFileName}`
        userKnowledgeFiles[tildeKey] = content
        // Only use the first file found (highest priority)
        break
      } catch (error) {
        logger.debug?.(
          { filePath, error: getErrorObject(error) },
          'Failed to read user knowledge file',
        )
      }
    }
  }

  return userKnowledgeFiles
}

/**
 * Selects knowledge files from a list of file paths with fallback logic.
 * For each directory, checks for knowledge.md first, then AGENTS.md, then CLAUDE.md.
 * @internal Exported for testing
 */
export function selectKnowledgeFilePaths(allFilePaths: string[]): string[] {
  const knowledgeCandidates = allFilePaths.filter(isKnowledgeFile)

  // Group candidates by directory
  const byDirectory = new Map<string, string[]>()
  for (const filePath of knowledgeCandidates) {
    const dir = path.dirname(filePath)
    if (!byDirectory.has(dir)) {
      byDirectory.set(dir, [])
    }
    byDirectory.get(dir)!.push(filePath)
  }

  const selectedFiles: string[] = []

  // For each directory, select one knowledge file using priority fallback
  for (const files of byDirectory.values()) {
    const selected = selectHighestPriorityKnowledgeFile(files)
    if (selected) {
      selectedFiles.push(selected)
    }
  }

  return selectedFiles
}

/**
 * Auto-derives instruction files from in-memory project files: every
 * knowledge file per directory plus contained `@path` imports (N08).
 */
async function deriveKnowledgeFiles(
  projectFiles: Record<string, string>,
  logger: Logger,
  cwd?: string,
): Promise<LoadedInstructionFiles> {
  const normalized = new Map(
    Object.entries(projectFiles).map(([key, content]) => [
      key.split(path.sep).join('/').replace(/^\.\//, ''),
      content,
    ]),
  )
  return loadInstructionFiles({
    projectRoot: cwd ?? path.resolve('/'),
    filePaths: [...normalized.keys()],
    logger,
    readVirtualFile: (relativePath) => normalized.get(relativePath),
  })
}

/**
 * Loads instruction files from disk: ancestors up to the git root, every
 * knowledge file per project directory, and contained `@path` imports (N08).
 */
async function loadKnowledgeFilesFromPaths(params: {
  cwd: string
  filePaths: string[]
  fs: CodebuffFileSystem
  logger: Logger
}): Promise<LoadedInstructionFiles> {
  return loadInstructionFiles({
    projectRoot: params.cwd,
    filePaths: params.filePaths,
    fs: params.fs,
    logger: params.logger,
  })
}

export async function initialSessionState(
  params: InitialSessionStateOptions,
): Promise<SessionState> {
  const { cwd, maxAgentSteps, skillsDir, homeDir, includeGlobalSkills, includeProjectSkills } = params
  let {
    agentDefinitions,
    customToolDefinitions,
    projectFiles,
    knowledgeFiles,
    userKnowledgeFiles: providedUserKnowledgeFiles,
    fs,
    spawn,
    logger,
    persistentMemory,
    workspaceMoves,
  } = params
  if (!agentDefinitions) {
    agentDefinitions = []
  }
  if (!customToolDefinitions) {
    customToolDefinitions = []
  }
  if (!fs) {
    fs = (require('fs') as typeof fsType).promises
  }
  if (!logger) {
    logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
  }

  let discoveredProject:
    | { fileTree: FileTreeNode[]; filePaths: string[] }
    | undefined

  // Auto-discover project files if not provided and cwd is available
  if (projectFiles === undefined && cwd) {
    discoveredProject = await discoverProjectPaths({ cwd, fs })
  }
  let instructionFiles: LoadedInstructionFiles['instructionFiles'] | undefined
  if (knowledgeFiles === undefined) {
    const loaded = projectFiles
      ? await deriveKnowledgeFiles(projectFiles, logger, cwd)
      : cwd && discoveredProject
        ? await loadKnowledgeFilesFromPaths({
            cwd,
            filePaths: discoveredProject.filePaths,
            fs,
            logger,
          })
        : { knowledgeFiles: {}, instructionFiles: [] }
    knowledgeFiles = loaded.knowledgeFiles
    instructionFiles = loaded.instructionFiles
  }

  let processedAgentTemplates: Record<string, any> = {}
  if (agentDefinitions && agentDefinitions.length > 0) {
    processedAgentTemplates = processAgentDefinitions(agentDefinitions)
  } else if (homeDir !== null) {
    processedAgentTemplates = await loadLocalAgents({
      ...(homeDir === undefined ? {} : { agentsPath: path.join(homeDir, '.agents') }),
      includeProjectAgents: false,
      verbose: false,
    })
  }
  const processedCustomToolDefinitions = processCustomToolDefinitions(
    customToolDefinitions,
  )

  let fileTree: FileTreeNode[] = []
  let fileTokenScores: Record<string, any> = {}
  let tokenCallers: Record<string, any> = {}

  const projectIndex = cwd
    ? getProjectIndexInput({ cwd, fs, logger, projectFiles, discoveredProject })
    : undefined
  if (projectIndex && params.projectContextMode === 'paths') {
    fileTree = projectIndex.fileTree
  } else if (projectIndex) {
    const result = await computeProjectIndex(projectIndex)
    fileTree = result.fileTree
    fileTokenScores = result.fileTokenScores
    tokenCallers = result.tokenCallers
  }

  // Gather git changes if cwd is available
  const gitChanges = cwd
    ? await getGitChanges({ cwd, spawn, logger, executionContext: params.executionContext })
    : {
        status: '',
        diff: '',
        diffCached: '',
        lastCommitMessages: '',
      }

  // Load user knowledge files from home directory and merge with any provided ones
  const homeKnowledgeFiles = await loadUserKnowledgeFiles({ fs, logger, homeDir })
  const userKnowledgeFiles = {
    ...homeKnowledgeFiles,
    ...providedUserKnowledgeFiles,
  }

  // Metadata and skills share the captured root without admitting workspace IO.
  const contextCwd = cwd ?? params.contextCwd ?? process.cwd()
  const skills = await loadSkills({
    cwd: contextCwd,
    skillsPath: skillsDir,
    homeDir,
    includeGlobalSkills,
    includeProjectSkills,
    verbose: false,
  })

  const initialState = getInitialSessionState({
    projectRoot: contextCwd,
    cwd: contextCwd,
    fileTreeSource: projectFiles !== undefined ? 'virtual' : 'live',
    fileTree,
    fileTokenScores,
    tokenCallers,
    knowledgeFiles,
    ...(instructionFiles ? { instructionFiles } : {}),
    userKnowledgeFiles,
    agentTemplates: processedAgentTemplates,
    customToolDefinitions: processedCustomToolDefinitions,
    skills,
    ...(includeProjectSkills === false ? { projectSkillsTrusted: false } : {}),
    gitChanges,
    changesSinceLastChat: {},
    shellConfigFiles: {},
    systemInfo: getSystemInfo(undefined, { homeDir }),
  })

  // Hydrate durable task memory from previous sessions when enabled. Any
  // failure must never block session start; worst case this session starts
  // without memory and repopulates it after the run.
  if (persistentMemory !== false && cwd) {
    try {
      // Route store IO through the injected filesystem so virtual-fs hosts
      // keep using their abstraction instead of raw node fs.
      const storeFs = codebuffFsToNodePromises(fs)
      const priorMemory = await loadPersistedTaskMemory({
        rootDir: cwd,
        fs: storeFs,
      })
      if (priorMemory) {
        initialState.mainAgentState.taskMemory =
          await reconcileTaskMemoryEvidence({
            memory: priorMemory,
            rootDir: cwd,
            workspaceMoves,
            fs: storeFs,
          })
      }
    } catch (error) {
      logger.debug?.(
        { error: getErrorObject(error) },
        'Failed to hydrate persisted task memory',
      )
    }
  }

  if (maxAgentSteps !== undefined) {
    initialState.mainAgentState.stepsRemaining = maxAgentSteps
  }

  return initialState
}

export async function generateInitialRunState({
  cwd,
  skillsDir,
  homeDir,
  includeGlobalSkills,
  projectFiles,
  knowledgeFiles,
  userKnowledgeFiles,
  agentDefinitions,
  customToolDefinitions,
  maxAgentSteps,
  fs,
  persistentMemory,
  workspaceMoves,
  executionContext,
  logger,
}: {
  cwd: string
  skillsDir?: string
  homeDir?: string | null
  includeGlobalSkills?: boolean
  projectFiles?: Record<string, string>
  knowledgeFiles?: Record<string, string>
  userKnowledgeFiles?: Record<string, string>
  agentDefinitions?: AgentDefinition[]
  customToolDefinitions?: CustomToolDefinition[]
  maxAgentSteps?: number
  fs: CodebuffFileSystem
  /** Set false to skip loading persisted task memory for this session. */
  persistentMemory?: boolean
  /** Known file moves used to rebind persisted evidence paths at hydration. */
  workspaceMoves?: WorkspaceMoveRecord[]
  executionContext?: ExecutionAdapterContext
  logger?: Logger
}): Promise<RunState> {
  return {
    sessionState: await initialSessionState({
      cwd,
      skillsDir,
      homeDir,
      includeGlobalSkills,
      projectFiles,
      knowledgeFiles,
      userKnowledgeFiles,
      agentDefinitions,
      customToolDefinitions,
      maxAgentSteps,
      fs,
      persistentMemory,
      workspaceMoves,
      executionContext,
      logger,
    }),
    output: {
      type: 'error',
      message: 'No output yet',
    },
  }
}

export function withAdditionalMessage({
  runState,
  message,
}: {
  runState: RunState
  message: Message
}): RunState {
  const newRunState = structuredClone(runState)

  if (newRunState.sessionState) {
    newRunState.sessionState.mainAgentState.messageHistory.push(message)
  }

  return newRunState
}

export function withMessageHistory({
  runState,
  messages,
}: {
  runState: RunState
  messages: Message[]
}): RunState {
  // Runtime controls can be mutated in place or frozen by the CLI store.
  // Copy those controls while retaining shared transcript bodies and the
  // copy-on-write memory nodes. Install the supplied history as before.
  const newRunState = runState.sessionState
    ? {
        ...runState,
        sessionState: {
          ...runState.sessionState,
          mainAgentState: {
            ...copyAgentStateForResume(runState.sessionState.mainAgentState),
            messageHistory: messages,
          },
        },
      }
    : { ...runState }

  if (newRunState.sessionState && runState.sessionState) {
    // Runtime guard for the sharing contract (dev/test only): freeze the
    // nested nodes SHARED with the caller's original state, so a future
    // in-place writer fails at this boundary instead of silently aliasing
    // the caller's state across runs. Note the pre-change JSON round-trip
    // clone incidentally dropped undefined/function fields; the targeted
    // copy preserves them — pinned by the targeted-copy tests.
    deepFreezeSharedStateNodes(
      newRunState.sessionState.mainAgentState.taskMemory,
    )
    deepFreezeSharedStateNodes(
      newRunState.sessionState.mainAgentState.workspaceState,
    )
    deepFreezeSharedStateNodes(
      newRunState.sessionState.mainAgentState.playbookContext,
    )
  }

  return newRunState
}

/**
 * A saved state may be frozen by the CLI store. Runtime control fields are
 * mutated in place (for example base2ActiveWork and childRunIds), so a resumed
 * run must own them even when the saved state is not frozen. Exclude immutable
 * transcript/archive payloads and copy-on-write memory before cloning controls:
 * copying a whole session would re-walk every historical tool result.
 */
function copyAgentStateForResume(state: AgentState): AgentState {
  const {
    messageHistory,
    compactionArchive,
    contextConsolidations,
    taskMemory,
    workspaceState,
    playbookContext,
    subagents,
    ...controls
  } = state
  return {
    ...cloneDeep(controls),
    messageHistory: [...messageHistory],
    subagents: subagents.map(copyAgentStateForResume),
    ...(compactionArchive === undefined
      ? {}
      : { compactionArchive: [...compactionArchive] }),
    ...(contextConsolidations === undefined
      ? {}
      : { contextConsolidations: [...contextConsolidations] }),
    ...(taskMemory === undefined ? {} : { taskMemory }),
    ...(workspaceState === undefined ? {} : { workspaceState }),
    ...(playbookContext === undefined ? {} : { playbookContext }),
  }
}

/**
 * Applies overrides to an existing session state, allowing specific fields to be updated
 * even when continuing from a previous run.
 */
export async function applyOverridesToSessionState(
  cwd: string | undefined,
  baseSessionState: SessionState,
  overrides: {
    /** Current captured metadata root; does not enable workspace discovery. */
    contextCwd?: string
    homeDir?: string | null
    includeGlobalSkills?: boolean
    includeProjectSkills?: boolean
    skillsDir?: string
    userKnowledgeFiles?: Record<string, string>
    projectFiles?: Record<string, string>
    projectContextMode?: 'paths' | 'symbols'
    knowledgeFiles?: Record<string, string>
    agentDefinitions?: AgentDefinition[]
    customToolDefinitions?: CustomToolDefinition[]
    maxAgentSteps?: number
  },
  runtime?: {
    fs?: CodebuffFileSystem
    logger?: Logger
  },
): Promise<SessionState> {
  // Copy the nodes this function and the continuing run mutate. Historical
  // message bodies, archived snapshots and copy-on-write memory remain shared;
  // runtime controls and appendable arrays must not alias a previous run.
  // Security maps still pass through the restore sanitizer below.
  const sessionState: SessionState = {
    ...baseSessionState,
    fileContext: { ...baseSessionState.fileContext },
    mainAgentState: copyAgentStateForResume(baseSessionState.mainAgentState),
  }
  if (overrides.contextCwd !== undefined) {
    sessionState.fileContext.cwd = cwd ?? overrides.contextCwd
  }

  // Runtime guard for the targeted-copy contract (dev/test only): freeze the
  // deeper nodes SHARED verbatim with baseSessionState, so a future in-place
  // writer fails at this boundary instead of silently corrupting the caller's
  // original state (see deepFreezeSharedStateNodes).
  deepFreezeSharedStateNodes(sessionState.mainAgentState.taskMemory)
  deepFreezeSharedStateNodes(sessionState.mainAgentState.workspaceState)
  deepFreezeSharedStateNodes(sessionState.mainAgentState.playbookContext)

  // M2-T3: session state restores from untrusted persisted JSON
  // (JSON.parse-and-cast upstream of this call), so shape-validate and strip
  // the security maps at this restore boundary before any consumer trusts
  // them.
  sessionState.mainAgentState = sanitizeAgentStateSecurityMaps(
    sessionState.mainAgentState,
  )

  // Apply maxAgentSteps override
  if (overrides.maxAgentSteps !== undefined) {
    sessionState.mainAgentState.stepsRemaining = overrides.maxAgentSteps
  }

  // Refresh project context for every continued run. Explicit projectFiles
  // remain authoritative for virtual/in-memory projects; otherwise rediscover
  // the live filesystem so creates, deletes, renames, and symbol changes are
  // reflected in the next system prompt.
  if (cwd) {
    const fs = runtime?.fs ?? (require('fs') as typeof fsType).promises
    const logger = runtime?.logger ?? {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    const discoveredProject =
      overrides.projectFiles === undefined
        ? await discoverProjectPaths({ cwd, fs })
        : undefined
    const projectIndex = getProjectIndexInput({
      cwd,
      fs,
      logger,
      projectFiles: overrides.projectFiles,
      discoveredProject,
    })
    if (projectIndex) {
      const { fileTree, fileTokenScores, tokenCallers } =
        overrides.projectContextMode === 'paths'
          ? {
              fileTree: projectIndex.fileTree,
              fileTokenScores: {},
              tokenCallers: {},
            }
          : await computeProjectIndex(projectIndex)
      sessionState.fileContext.fileTreeSource =
        overrides.projectFiles !== undefined ? 'virtual' : 'live'
      sessionState.fileContext.fileTree = fileTree
      sessionState.fileContext.fileTokenScores = fileTokenScores
      sessionState.fileContext.tokenCallers = tokenCallers
    }

    if (overrides.knowledgeFiles === undefined) {
      const loaded = overrides.projectFiles
        ? await deriveKnowledgeFiles(overrides.projectFiles, logger, cwd)
        : discoveredProject
          ? await loadKnowledgeFilesFromPaths({
              cwd,
              filePaths: discoveredProject.filePaths,
              fs,
              logger,
            })
          : { knowledgeFiles: {}, instructionFiles: [] }
      sessionState.fileContext.knowledgeFiles = loaded.knowledgeFiles
      sessionState.fileContext.instructionFiles = loaded.instructionFiles
    }
  } else if (overrides.projectFiles !== undefined) {
    // Explicit virtual files without a cwd cannot be scored safely.
    sessionState.fileContext.fileTreeSource = 'virtual'
    sessionState.fileContext.fileTree = []
    sessionState.fileContext.fileTokenScores = {}
    sessionState.fileContext.tokenCallers = {}

    if (overrides.knowledgeFiles === undefined) {
      const loaded = await deriveKnowledgeFiles(
        overrides.projectFiles,
        runtime?.logger ?? { debug() {}, info() {}, warn() {}, error() {} },
      )
      sessionState.fileContext.knowledgeFiles = loaded.knowledgeFiles
      sessionState.fileContext.instructionFiles = loaded.instructionFiles
    }
  }

  // Apply knowledgeFiles override
  if (overrides.knowledgeFiles !== undefined) {
    sessionState.fileContext.knowledgeFiles = overrides.knowledgeFiles
    // Caller-supplied files carry no load-order records; the prompt then
    // falls back to the root-file rendering.
    delete sessionState.fileContext.instructionFiles
  }

  if (overrides.homeDir !== undefined) {
    // Persisted sessions do not distinguish automatically loaded home files
    // from caller values at those same keys. Refresh that namespace from the
    // current policy; callers can explicitly supply an override again.
    const retained = Object.fromEntries(Object.entries(
      baseSessionState.fileContext.userKnowledgeFiles ?? {},
    ).filter(([key]) => !(key.startsWith('~/.') &&
      KNOWLEDGE_FILE_NAMES_LOWERCASE.includes(key.slice(3).toLowerCase()))))
    const homeKnowledgeFiles = await loadUserKnowledgeFiles({
      fs: runtime?.fs ?? (require('fs') as typeof fsType).promises,
      logger: runtime?.logger ?? { debug() {}, info() {}, warn() {}, error() {} },
      homeDir: overrides.homeDir,
    })
    sessionState.fileContext.userKnowledgeFiles = {
      ...retained,
      ...homeKnowledgeFiles,
      ...overrides.userKnowledgeFiles,
    }
    sessionState.fileContext.systemInfo = {
      ...sessionState.fileContext.systemInfo,
      homedir: overrides.homeDir ?? '',
    }
  } else if (overrides.userKnowledgeFiles !== undefined) {
    sessionState.fileContext.userKnowledgeFiles = {
      ...sessionState.fileContext.userKnowledgeFiles,
      ...overrides.userKnowledgeFiles,
    }
  }

  if (overrides.contextCwd !== undefined || overrides.homeDir !== undefined ||
    overrides.includeGlobalSkills !== undefined || overrides.skillsDir !== undefined ||
    overrides.includeProjectSkills !== undefined) {
    sessionState.fileContext.skills = await loadSkills({
      cwd: cwd ?? overrides.contextCwd ?? baseSessionState.fileContext.cwd,
      homeDir: overrides.homeDir,
      includeGlobalSkills: overrides.includeGlobalSkills,
      includeProjectSkills: overrides.includeProjectSkills,
      skillsPath: overrides.skillsDir,
      verbose: false,
    })
    if (overrides.includeProjectSkills === false) sessionState.fileContext.projectSkillsTrusted = false
    else delete sessionState.fileContext.projectSkillsTrusted
  }

  // Apply agentDefinitions override (merge by id, last-in wins)
  if (overrides.agentDefinitions !== undefined) {
    const processedAgentTemplates = processAgentDefinitions(
      overrides.agentDefinitions,
    )
    sessionState.fileContext.agentTemplates = {
      ...sessionState.fileContext.agentTemplates,
      ...processedAgentTemplates,
    }
  }

  // Apply customToolDefinitions override (replace by toolName)
  if (overrides.customToolDefinitions !== undefined) {
    const processedCustomToolDefinitions = processCustomToolDefinitions(
      overrides.customToolDefinitions,
    )
    sessionState.fileContext.customToolDefinitions = {
      ...sessionState.fileContext.customToolDefinitions,
      ...processedCustomToolDefinitions,
    }
  }

  return sessionState
}

/**
 * Builds a hierarchical file tree from a flat list of file paths
 */
function buildFileTree(filePaths: string[]): FileTreeNode[] {
  const tree: Record<string, FileTreeNode> = {}

  // Build the tree structure
  for (const filePath of filePaths) {
    const parts = filePath.split('/')

    for (let i = 0; i < parts.length; i++) {
      const currentPath = parts.slice(0, i + 1).join('/')
      const isFile = i === parts.length - 1

      if (!tree[currentPath]) {
        tree[currentPath] = {
          name: parts[i],
          type: isFile ? 'file' : 'directory',
          filePath: currentPath,
          children: isFile ? undefined : [],
        }
      }
    }
  }

  // Organize into hierarchical structure
  const rootNodes: FileTreeNode[] = []
  const processed = new Set<string>()

  for (const [path, node] of Object.entries(tree)) {
    if (processed.has(path)) continue

    const parentPath = path.substring(0, path.lastIndexOf('/'))
    if (parentPath && tree[parentPath]) {
      // This node has a parent, add it to parent's children
      const parent = tree[parentPath]
      if (
        parent.children &&
        !parent.children.some((child) => child.filePath === path)
      ) {
        parent.children.push(node)
      }
    } else {
      // This is a root node
      rootNodes.push(node)
    }
    processed.add(path)
  }

  // Sort function for nodes
  function sortNodes(nodes: FileTreeNode[]): void {
    nodes.sort((a, b) => {
      // Directories first, then files
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    // Recursively sort children
    for (const node of nodes) {
      if (node.children) {
        sortNodes(node.children)
      }
    }
  }

  sortNodes(rootNodes)
  return rootNodes
}
