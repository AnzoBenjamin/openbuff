import fs from 'fs'
import path from 'path'

import { pluralize } from '@codebuff/common/util/string'
import {
  loadLocalAgents as sdkLoadLocalAgents,
  loadMCPConfigSync,
} from '@openbuff/sdk'

import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { AgentValidationError } from '@openbuff/sdk'

import { getProjectRoot } from '../project-files'
import { AGENT_MODE_TO_ID, type AgentMode } from './constants'
import { logger } from './logger'
import * as bundledAgentsModule from '../agents/bundled-agents.generated'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

// TEST-ONLY logger injection seam: lets tests replace the module logger
// without mock.module (which is registry-wide for the whole bun test worker
// and cannot be unregistered). Production behavior is unchanged when no
// logger is injected.
let injectedLogger: typeof logger | null = null

/**
 * TEST-ONLY: replace the module logger used by this registry for the
 * duration of a test; pass null to restore the production logger.
 */
export function setAgentRegistryLoggerForTests(
  value: typeof logger | null,
): void {
  injectedLogger = value
}

const activeLogger = (): typeof logger => injectedLogger ?? logger

// ============================================================================
// Constants and types
// ============================================================================

const AGENTS_DIR_NAME = '.agents'

export interface LocalAgentInfo {
  id: string
  displayName: string
  filePath: string
  /** True if this is a bundled Openbuff agent (not user-created) */
  isBundled?: boolean
}

// ============================================================================
// User agents cache (loaded via SDK at startup)
// ============================================================================

let userAgentsCache: Record<string, AgentDefinition> = {}
// Map from agent ID to source file path (for UI "Open file" links)
let userAgentFilePaths: Map<string, string> = new Map()
// Cache for MCP servers loaded from mcp.json in .agents directories
let mcpServersCache: Record<string, MCPConfig> = {}
let agentRegistryDiagnostics: AgentValidationError[] = []
let projectAgentsTrusted = false

// ============================================================================
// Registry epoch (cache-invalidation key for registry-derived caches)
// ============================================================================

/**
 * Monotonic counter bumped on EVERY registry (re)load or reset. Consumers
 * key expensive registry-derived caches on it (via getAgentRegistryEpoch —
 * e.g. the per-send local agent validation in use-agent-validation.ts) so a
 * cached result is reused between reloads and invalidated exactly when the
 * registry content can change, instead of being recomputed on every use.
 */
let agentRegistryEpoch = 0

/** Private: advance the epoch whenever registry-derived content is replaced. */
const bumpAgentRegistryEpoch = (): void => {
  agentRegistryEpoch += 1
}

/**
 * The current registry epoch. Consumers must read it once per operation and
 * key BOTH their cache read and write on that same value, so a hit is only
 * ever served for a result derived from the registry generation that is
 * still current.
 */
export const getAgentRegistryEpoch = (): number => agentRegistryEpoch

/**
 * Initialize the agent registry by loading user agents via the SDK.
 * This must be called at CLI startup before any sync agent loading functions.
 *
 * Agents are loaded from:
 * - {cwd}/.agents (project)
 * - {cwd}/../.agents (parent, e.g. monorepo root)
 * - ~/.agents (global, user's home directory)
 *
 * Later directories take precedence, so project agents override global ones.
 */
export async function initializeAgentRegistry(options?: {
  trustProjectAgents?: boolean
}): Promise<void> {
  // Derived listings must never outlive the definitions they were built from.
  // The epoch bump comes FIRST: any cache keyed on getAgentRegistryEpoch()
  // invalidates before this reload's (possibly different) content becomes
  // observable, so a consumer can never serve a pre-reload cached result.
  bumpAgentRegistryEpoch()
  cachedAgentsByMode.clear()
  cachedAgentsDir = null
  try {
    const trustProjectAgents = options?.trustProjectAgents ?? false
    projectAgentsTrusted = trustProjectAgents
    const loaded = await sdkLoadLocalAgents({
      includeProjectAgents: trustProjectAgents,
      verbose: false,
      validate: true,
    })
    userAgentsCache = loaded.agents
    userAgentFilePaths = new Map(
      Object.values(loaded.agents).map((agent) => [
        agent.id,
        agent._sourceFilePath,
      ]),
    )
    agentRegistryDiagnostics = loaded.validationErrors
  } catch (error) {
    // Keep the last known-good definitions on catastrophic refresh failure.
    activeLogger().warn(
      { error },
      'Failed to load user agents from .agents directories',
    )
    agentRegistryDiagnostics = [
      {
        agentId: '(registry)',
        filePath: '',
        message: error instanceof Error ? error.message : String(error),
      },
    ]
  }

  // Load MCP config from mcp.json files in .agents directories. The MCP
  // cache is REGISTRY-DERIVED content — loadAgentDefinitions() merges it
  // into the base agent definitions that feed validateAgents() and the
  // epoch-keyed validation cache — so this replacement must land BEFORE
  // the landing bump below (mcp-cache-epoch-gap): bumping first and
  // assigning afterwards would leave a window in which an epoch-keyed
  // consumer reads the FINAL epoch while mcpServersCache still holds the
  // OLD mcp.json, caching a stale verdict that no later bump invalidates
  // until the next reload.
  try {
    const mcpConfig = loadMCPConfigSync({
      includeProjectConfig: options?.trustProjectAgents ?? false,
      verbose: false,
    })
    mcpServersCache = mcpConfig.mcpServers
    if (Object.keys(mcpServersCache).length > 0) {
      activeLogger().debug(
        {
          mcpServers: Object.keys(mcpServersCache),
          source: mcpConfig._sourceFilePath,
        },
        '[agents] Loaded MCP servers from mcp.json',
      )
    }
  } catch (error) {
    activeLogger().warn({ error }, 'Failed to load MCP config from .agents directories')
  }

  // Landing bump: the load-start bump above already invalidated pre-reload
  // caches, but a mid-reload send (whenRegistriesReady() does not gate on
  // the project-switch path) can read the start epoch, validate the OLD
  // registry content, and cache that verdict before this reload lands.
  // Bumping here keys it to a dead epoch, so a hit is only ever served for
  // the registry generation that is still current. The bump is the LAST
  // step of the reload and runs AFTER the MCP config assignment above, so
  // every registry-derived replacement of this generation (user agents,
  // diagnostics, MCP servers) is already in place: a verdict cached under
  // the FINAL epoch is derived from the CURRENT registry — including the
  // current mcp.json — never from a pre-reload one. The same holds for a
  // failed reload: the diagnostics assigned in the catch above are part
  // of the landed generation too. The mode-listing cache is NOT
  // epoch-keyed, so it is cleared at the landing bump as well: a
  // loadLocalAgents() call during the awaited window above may have
  // repopulated it from stale content, and that listing must not outlive
  // the content replacement.
  cachedAgentsByMode.clear()
  bumpAgentRegistryEpoch()
}

/**
 * Get user agents from the cache as LocalAgentInfo[]
 */
const getUserAgentsAsLocalInfo = (): LocalAgentInfo[] => {
  return Object.values(userAgentsCache).map((def) => ({
    id: def.id,
    displayName: def.displayName || def.id,
    filePath: userAgentFilePaths.get(def.id) || '',
  }))
}

/**
 * Get user agents from the cache as AgentDefinition[]
 */
const getUserAgentDefinitions = (): AgentDefinition[] => {
  return Object.values(userAgentsCache) as AgentDefinition[]
}

// ============================================================================
// Bundled agents loading (generated at build time by prebuild-agents.ts)
// ============================================================================

const getBundledAgents = (): Record<string, AgentDefinition> => {
  return bundledAgentsModule.bundledAgents ?? {}
}

const getBundledAgentsAsLocalInfo = (): LocalAgentInfo[] => {
  return bundledAgentsModule.getBundledAgentsAsLocalInfo?.() ?? []
}

// ============================================================================
// Directory finding
// ============================================================================

let cachedAgentsDir: string | null = null

export const findAgentsDirectory = (): string | null => {
  if (cachedAgentsDir && fs.existsSync(cachedAgentsDir)) {
    return cachedAgentsDir
  }

  const projectRoot = getProjectRoot() || process.cwd()
  if (projectRoot) {
    const rootCandidate = path.join(projectRoot, AGENTS_DIR_NAME)
    if (
      fs.existsSync(rootCandidate) &&
      fs.statSync(rootCandidate).isDirectory()
    ) {
      cachedAgentsDir = rootCandidate
      return cachedAgentsDir
    }
  }

  let currentDir = process.cwd()
  const filesystemRoot = path.parse(currentDir).root

  while (true) {
    const candidate = path.join(currentDir, AGENTS_DIR_NAME)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      cachedAgentsDir = candidate
      return cachedAgentsDir
    }

    if (currentDir === filesystemRoot) {
      break
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }

    currentDir = parentDir
  }

  cachedAgentsDir = null
  return null
}

// ============================================================================
// Agent loading - LocalAgentInfo (lightweight, for UI/listing)
// ============================================================================

// Cache keyed by agent mode (or 'all' for no filtering)
const cachedAgentsByMode: Map<string, LocalAgentInfo[]> = new Map()

/**
 * Load local agents for display in the '@' menu.
 *
 * @param currentAgentMode - If provided, filters bundled agents to only include
 *   subagents of the current mode's agent (e.g., base2's spawnableAgents for DEFAULT mode).
 *   User's local agents from .agents/ are always included regardless of mode.
 */
export const loadLocalAgents = (
  currentAgentMode?: AgentMode,
): LocalAgentInfo[] => {
  const cacheKey = currentAgentMode ?? 'all'
  const cached = cachedAgentsByMode.get(cacheKey)
  if (cached) {
    return cached
  }

  // Get bundled agents - these are the default Openbuff agents
  // compiled into the CLI binary at build time
  const bundledAgentsInfo = getBundledAgentsAsLocalInfo()
  const bundledAgents = getBundledAgents()

  // Filter bundled agents to only include subagents of the current mode's agent
  let filteredBundledAgents: LocalAgentInfo[]
  if (currentAgentMode) {
    const currentAgentId = AGENT_MODE_TO_ID[currentAgentMode]
    const currentAgentDef = bundledAgents[currentAgentId]
      ? bundledAgents[currentAgentId]
      : undefined
    const spawnableAgentIds = new Set(currentAgentDef?.spawnableAgents ?? [])

    // Only include bundled agents that are in the spawnableAgents list
    filteredBundledAgents = bundledAgentsInfo.filter((agent) =>
      spawnableAgentIds.has(agent.id),
    )
  } else {
    filteredBundledAgents = bundledAgentsInfo
  }

  const results: LocalAgentInfo[] = [...filteredBundledAgents]
  const includedIds = new Set(filteredBundledAgents.map((a) => a.id))

  // Get user agents from the SDK-loaded cache
  // User agents are always included (not filtered by mode) and can override bundled agents
  const userAgents = getUserAgentsAsLocalInfo()

  // Merge user agents - they override bundled agents with same ID
  // and are always included regardless of mode filtering
  for (const userAgent of userAgents) {
    if (includedIds.has(userAgent.id)) {
      // Replace bundled agent with user's version
      const idx = results.findIndex((a) => a.id === userAgent.id)
      if (idx !== -1) {
        results[idx] = userAgent
      }
    } else {
      results.push(userAgent)
      includedIds.add(userAgent.id)
    }
  }

  const sorted = results.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'en'),
  )

  cachedAgentsByMode.set(cacheKey, sorted)
  return sorted
}

// ============================================================================
// Agent loading - AgentDefinition (full definitions for runtime)
// ============================================================================

/**
 * Load agent definitions from bundled agents and user's .agents directory.
 * Bundled agents are compiled into the CLI binary at build time.
 * User agents from .agents/ are loaded via SDK at startup and cached.
 * User agents can override bundled agents with the same ID.
 *
 * Additionally, all user agent IDs are automatically added to the spawnableAgents
 * of any base agent (agents with IDs starting with 'base'), so users can spawn
 * their custom agents without needing to modify the base agent definition.
 */
export const loadAgentDefinitions = (): AgentDefinition[] => {
  // Start with bundled agents - these are the default Openbuff agents
  const bundledAgents = getBundledAgents()
  const definitions: AgentDefinition[] = Object.values(bundledAgents).map(
    (def) => ({ ...def }),
  )
  const bundledIds = new Set(Object.keys(bundledAgents))

  // Get user agents from the SDK-loaded cache
  const userAgentDefs = getUserAgentDefinitions()
  const userAgentIds = userAgentDefs.map((def) => def.id)

  for (const agentDef of userAgentDefs) {
    // User agents override bundled agents with the same ID
    if (bundledIds.has(agentDef.id)) {
      const idx = definitions.findIndex((d) => d.id === agentDef.id)
      if (idx !== -1) {
        definitions[idx] = { ...agentDef }
      }
    } else {
      definitions.push({ ...agentDef })
    }
  }

  // Auto-add user agent IDs to spawnableAgents of base agents
  // This allows users to spawn their custom agents without needing to
  // explicitly add them to the base agent's spawnableAgents list
  if (userAgentIds.length > 0) {
    for (const def of definitions) {
      // Consider any agent with an ID starting with 'base' as a base agent
      if (def.id.startsWith('base') && def.spawnableAgents) {
        const existingSpawnable = new Set(def.spawnableAgents)
        for (const userAgentId of userAgentIds) {
          if (!existingSpawnable.has(userAgentId)) {
            def.spawnableAgents = [...def.spawnableAgents, userAgentId]
          }
        }
      }
    }
  }

  // Merge MCP servers from mcp.json into base agents
  // This allows users to configure MCP tools that are available to the main agent
  if (Object.keys(mcpServersCache).length > 0) {
    for (const def of definitions) {
      // Consider any agent with an ID starting with 'base' as a base agent
      if (def.id.startsWith('base')) {
        // Initialize mcpServers if not present
        if (!def.mcpServers) {
          def.mcpServers = {}
        }
        // Merge MCP servers (user config can override existing servers)
        def.mcpServers = {
          ...def.mcpServers,
          ...mcpServersCache,
        }
      }
    }
  }

  return definitions
}

// ============================================================================
// UI/Display utilities
// ============================================================================

export const announceLoadedAgents = (): void => {
  const agents = loadLocalAgents()
  const agentsDir = findAgentsDirectory()

  if (!agentsDir) {
    activeLogger().debug('[agents] No .agents directory found in this project.')
    return
  }

  if (!agents.length) {
    activeLogger().debug({ agentsDir }, '[agents] No agent files found')
    return
  }

  const agentIdentifiers = agents.map((agent) =>
    agent.displayName && agent.displayName !== agent.id
      ? `${agent.displayName} (${agent.id})`
      : agent.displayName || agent.id,
  )

  activeLogger().debug(
    { agentsDir, agents: agentIdentifiers },
    `[agents] Loaded ${pluralize(agents.length, 'local agent')}`,
  )
}

export const getLoadedAgentsMessage = (): string | null => {
  const agents = loadLocalAgents()
  const agentsDir = findAgentsDirectory()

  if (!agentsDir || !agents.length) {
    return null
  }

  const agentCount = agents.length
  const header = `Loaded ${pluralize(agentCount, 'local agent')} from ${agentsDir}`
  const agentList = agents
    .map((agent) => {
      const identifier =
        agent.displayName && agent.displayName !== agent.id
          ? `${agent.displayName} (${agent.id})`
          : agent.displayName || agent.id
      return `  - ${identifier}`
    })
    .join('\n')

  return `${header}\n${agentList}`
}

export const getLoadedAgentsData = (): {
  agents: LocalAgentInfo[]
  agentsDir: string
  diagnostics: AgentValidationError[]
} | null => {
  const agents = loadLocalAgents()
  const agentsDir = findAgentsDirectory()

  if ((!agentsDir || !agents.length) && agentRegistryDiagnostics.length === 0) {
    return null
  }

  return {
    agents,
    agentsDir: agentsDir ?? '',
    diagnostics: [...agentRegistryDiagnostics],
  }
}

export const getAgentRegistryDiagnostics = (): AgentValidationError[] => [
  ...agentRegistryDiagnostics,
]

export const getProjectAgentTrustStatus = (): boolean => projectAgentsTrusted

// ============================================================================
// Testing utilities
// ============================================================================

/**
 * Clear cached agent listings. Intended for test scenarios that need to
 * re-evaluate the filesystem state between cases.
 */
export const __resetLocalAgentRegistryForTests = (): void => {
  // Same invalidation contract as initializeAgentRegistry: a reset replaces
  // registry-derived content, so epoch-keyed caches must miss afterwards.
  bumpAgentRegistryEpoch()
  cachedAgentsByMode.clear()
  cachedAgentsDir = null
  userAgentsCache = {}
  userAgentFilePaths = new Map()
  mcpServersCache = {}
  agentRegistryDiagnostics = []
  projectAgentsTrusted = true
}

/**
 * Get the currently loaded MCP servers from mcp.json.
 * Useful for debugging and displaying loaded MCP configuration.
 */
export const getLoadedMCPServers = (): Record<string, MCPConfig> => {
  return { ...mcpServersCache }
}
