import {
  ensureAgentTemplateZodSchemas,
  validateAgents,
} from '@codebuff/common/templates/agent-validation'
import {
  normalizeAgentIdForLookup,
  parsePublishedAgentId,
} from '@codebuff/common/util/agent-id-parsing'
import { DEFAULT_ORG_PREFIX } from '@codebuff/common/util/agent-name-normalization'

import type { DynamicAgentValidationError } from '@codebuff/common/templates/agent-validation'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { FetchAgentFromDatabaseFn } from '@codebuff/common/types/contracts/database'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type { ProjectFileContext } from '@codebuff/common/util/file'
import {
  markAllMCPConfigOrigins,
  propagateMCPConfigOrigins,
} from '@codebuff/common/mcp/client'

/**
 * Single function to look up an agent template with clear priority order:
 * 1. localAgentTemplates (dynamic agents + static templates)
 * 2. Database cache
 * 3. Database query
 */
export async function getAgentTemplate(
  params: {
    agentId: string
    localAgentTemplates: Record<string, AgentTemplate>
    fetchAgentFromDatabase: FetchAgentFromDatabaseFn
    databaseAgentCache: Map<string, AgentTemplate | null>
    logger: Logger
  } & ParamsExcluding<FetchAgentFromDatabaseFn, 'parsedAgentId'>,
): Promise<AgentTemplate | null> {
  const {
    agentId,
    localAgentTemplates,
    fetchAgentFromDatabase,
    databaseAgentCache,
    logger,
  } = params
  const normalizedAgentId = normalizeAgentIdForLookup(agentId)

  // 1. Check localAgentTemplates first (dynamic agents + static templates).
  // Coerce at resolution: templates that crossed a JSON boundary (bundled
  // agents, parent→child bridge round-trip) arrive with plain JSON-Schema
  // schema members that crash asSchema on the model surface.
  if (localAgentTemplates[agentId]) {
    return ensureAgentTemplateZodSchemas(localAgentTemplates[agentId])
  }
  if (normalizedAgentId !== agentId && localAgentTemplates[normalizedAgentId]) {
    return ensureAgentTemplateZodSchemas(localAgentTemplates[normalizedAgentId])
  }

  // 2. Check database cache
  if (databaseAgentCache.has(agentId)) {
    return databaseAgentCache.get(agentId) || null
  }
  if (
    normalizedAgentId !== agentId &&
    databaseAgentCache.has(normalizedAgentId)
  ) {
    return databaseAgentCache.get(normalizedAgentId) || null
  }

  const parsed = parsePublishedAgentId(normalizedAgentId)
  if (!parsed) {
    // If agentId doesn't parse as publisher/agent format, try as codebuff/agentId
    const codebuffParsed = parsePublishedAgentId(
      `${DEFAULT_ORG_PREFIX}${normalizedAgentId}`,
    )
    if (codebuffParsed) {
      const dbAgent = await fetchAgentFromDatabase({
        ...params,
        parsedAgentId: codebuffParsed,
      })
      if (dbAgent) {
        // Coerce at resolution (see the local-template branch): database
        // templates cross a JSON boundary and arrive with plain schema members.
        const coercedAgent = ensureAgentTemplateZodSchemas(dbAgent)
        // Database agents are untrusted protocol content: mark their MCP
        // configs 'client' so $VAR references are never expanded. The cache
        // stores this same object, so cached copies keep the mark.
        markAllMCPConfigOrigins(coercedAgent.mcpServers, 'client')
        // Cache only specific versions to avoid stale 'latest' results, the
        // same policy as the main database branch below: an unversioned
        // fallback lookup resolves 'latest' and must not be pinned in the
        // cache for the process lifetime.
        if (codebuffParsed.version && codebuffParsed.version !== 'latest') {
          databaseAgentCache.set(coercedAgent.id, coercedAgent)
        }
        return coercedAgent
      }
    }
    logger.debug({ agentId }, 'getAgentTemplate: Failed to parse agent ID')
    return null
  }

  // 3. Query database (only for publisher/agent-id format)
  const dbAgent = await fetchAgentFromDatabase({
    ...params,
    parsedAgentId: parsed,
  })
  // Coerce at resolution (see the local-template branch): database templates
  // cross a JSON boundary and arrive with plain schema members.
  const coercedAgent = dbAgent
    ? ensureAgentTemplateZodSchemas(dbAgent)
    : dbAgent
  if (coercedAgent) {
    // Database agents are untrusted protocol content: mark their MCP
    // configs 'client' so $VAR references are never expanded. The cache
    // stores this same object, so cached copies keep the mark.
    markAllMCPConfigOrigins(coercedAgent.mcpServers, 'client')
  }
  if (coercedAgent && parsed.version && parsed.version !== 'latest') {
    // Cache only specific versions to avoid stale 'latest' results
    databaseAgentCache.set(coercedAgent.id, coercedAgent)
  }
  return coercedAgent
}

/**
 * Assemble local agent templates from fileContext + static templates
 */
export function assembleLocalAgentTemplates(params: {
  fileContext: ProjectFileContext
  logger: Logger
}): {
  agentTemplates: Record<string, AgentTemplate>
  validationErrors: DynamicAgentValidationError[]
} {
  const { fileContext, logger } = params
  // Load dynamic agents using the service
  const { templates: dynamicTemplates, validationErrors } = validateAgents({
    agentTemplates: fileContext.agentTemplates,
    logger,
  })

  // Origin marking for the validated templates that reach getMCPClient.
  // Provenance — not the WeakMap alone — decides trust here: agentTemplates
  // flowing through fileContext may have been cloned or serialized on the way
  // in (client.run clones agentDefinitions; session-state overrides round-trip
  // through JSON), which erases WeakMap origin marks. The string
  // `executionSource` field survives those hops, so it is the durable
  // provenance signal:
  //
  // - 'local'/'bundled' (trusted on-disk material, stamped by loadLocalAgents
  //   and bundled templates): re-attach any source marks that survived the
  //   hop (NEW-1 no-upgrade invariant), then blanket-mark the remaining
  //   configs 'project' so $VAR substitution keeps working.
  // - 'database' (untrusted protocol content fetched from the database, e.g.
  //   re-passed through client.run({ agentDefinitions }) into
  //   fileContext.agentTemplates): the 'client' mark applied at fetch time
  //   does not survive serialization, so re-mark 'client' here — $VAR
  //   references stay literal and an erased mark can never be silently
  //   upgraded.
  // - no recorded executionSource (unknown provenance): no blanket mark.
  //   Unmarked configs fail closed to 'client' at resolve time, with the
  //   one-time diagnosability warning when they still contain $VAR
  //   references — never a silent 'project' upgrade.
  //
  // validateSingleAgent's Zod re-parse creates fresh mcpServers objects with
  // no origin mark, so propagation must happen before any blanket mark: a
  // 'client' source mark always propagates and can never be upgraded by the
  // trusted blanket mark below.
  for (const rawTemplate of Object.values(fileContext.agentTemplates ?? {})) {
    const validated =
      rawTemplate && typeof rawTemplate.id === 'string'
        ? dynamicTemplates[rawTemplate.id]
        : undefined
    if (!validated) {
      continue
    }
    propagateMCPConfigOrigins(rawTemplate.mcpServers, validated.mcpServers)
    if (
      rawTemplate.executionSource === 'local' ||
      rawTemplate.executionSource === 'bundled'
    ) {
      markAllMCPConfigOrigins(validated.mcpServers, 'project')
    } else if (rawTemplate.executionSource === 'database') {
      markAllMCPConfigOrigins(validated.mcpServers, 'client')
    }
  }

  // Use dynamic templates only

  const agentTemplates = { ...dynamicTemplates }
  return { agentTemplates, validationErrors }
}

/**
 * Clear the database agent cache (useful for testing)
 */
export function clearDatabaseCache(params: {
  databaseAgentCache: Map<string, AgentTemplate | null>
}): void {
  const { databaseAgentCache } = params

  databaseAgentCache.clear()
}
