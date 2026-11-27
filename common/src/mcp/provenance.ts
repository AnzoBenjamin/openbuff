import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import { markMCPConfigOrigin, originOf, resolveMCPConfigOrigin } from './client'
import { mcpConfigSchema } from '../types/mcp'

import type { MCPConfig, MCPConfigOrigin } from '../types/mcp'

type HostBinding = {
  agentId: string
  serverName: string
  digest: string
  origin: MCPConfigOrigin
  config: MCPConfig
}

type HostScope = {
  projectRoot: string
  bindings: Map<string, HostBinding>
  activeReferences: Map<string, string>
}

// References are capabilities issued by this host, not serialized trust labels.
// Expiration is fail-closed; a restarted host must reload authoritative configs.
const scopes = new Map<string, HostScope>()
const MAX_HOST_SCOPES = 256
const MAX_SCOPE_BINDINGS = 1_024

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function mcpConfigDigest(config: MCPConfig): string {
  return createHash('sha256')
    .update(canonical(mcpConfigSchema.parse(config)))
    .digest('hex')
}

function snapshot(config: MCPConfig, origin: MCPConfigOrigin): MCPConfig {
  const copy = mcpConfigSchema.parse(config)
  if (copy.type === 'stdio') {
    Object.freeze(copy.args)
    Object.freeze(copy.env)
  } else {
    Object.freeze(copy.params)
    Object.freeze(copy.headers)
  }
  markMCPConfigOrigin(copy, origin)
  return Object.freeze(copy)
}

function getScope(sessionReference: string, projectRoot: string): HostScope {
  const scope = scopes.get(sessionReference)
  if (!scope)
    throw new Error(
      'MCP host bindings are unavailable or expired; reload the server configuration on this host.',
    )
  if (scope.projectRoot !== path.resolve(projectRoot))
    throw new Error('MCP host reference belongs to a different project.')
  return scope
}

function createScope(projectRoot: string): string {
  const reference = randomUUID()
  scopes.set(reference, {
    projectRoot: path.resolve(projectRoot),
    bindings: new Map(),
    activeReferences: new Map(),
  })
  while (scopes.size > MAX_HOST_SCOPES)
    scopes.delete(scopes.keys().next().value!)
  return reference
}

export type McpReferencedTemplate = {
  id: string
  mcpServers?: Record<string, MCPConfig>
  mcpServerReferences?: Record<string, string>
}

function canBindTemplate(template: McpReferencedTemplate): boolean {
  if (
    !template ||
    typeof template !== 'object' ||
    typeof template.id !== 'string'
  )
    return false
  if (template.mcpServers === undefined) return true
  if (
    !template.mcpServers ||
    typeof template.mcpServers !== 'object' ||
    Array.isArray(template.mcpServers)
  )
    return false
  if (
    template.mcpServerReferences !== undefined &&
    (!template.mcpServerReferences ||
      typeof template.mcpServerReferences !== 'object' ||
      Array.isArray(template.mcpServerReferences) ||
      Object.values(template.mcpServerReferences).some(
        (ref) => typeof ref !== 'string',
      ))
  )
    return false
  return Object.values(template.mcpServers).every(
    (config) => mcpConfigSchema.safeParse(config).success,
  )
}

/** Bind exact server identities before the session or child crosses JSON. */
export function bindMcpSession(params: {
  projectRoot: string
  sessionReference?: string
  templates: Record<string, McpReferencedTemplate>
  /** A child rebind submits a subset; SDK session loading submits the complete
   * collection, which revokes removed or invalid template owners. */
  templateScope?: 'complete' | 'subset'
}): {
  sessionReference?: string
  templates: Record<string, McpReferencedTemplate>
} {
  const entries = Object.entries(params.templates)
  // Leave malformed raw definitions for normal per-agent validation. A bad
  // sibling must not prevent the host from binding healthy templates.
  const bindableEntries = entries.filter(([, template]) =>
    canBindTemplate(template),
  )
  const hasServers = bindableEntries.some(
    ([, template]) => Object.keys(template.mcpServers ?? {}).length > 0,
  )
  if (!hasServers && !params.sessionReference)
    return {
      sessionReference: params.sessionReference,
      templates: params.templates,
    }

  let sessionReference = params.sessionReference
  if (sessionReference && !scopes.has(sessionReference)) {
    if (!hasServers) return { templates: params.templates }
    // A trusted loader can rebind after a restart. Persisted objects alone
    // cannot attest their provenance, even when executionSource says local.
    const unavailable = bindableEntries.some(([, template]) =>
      Object.entries(template.mcpServers ?? {}).some(
        ([name, config]) =>
          template.mcpServerReferences?.[name] &&
          originOf(config) === undefined,
      ),
    )
    if (unavailable)
      throw new Error(
        'MCP host bindings from the previous process are unavailable; reload the server configuration.',
      )
    sessionReference = undefined
  }
  sessionReference ??= createScope(params.projectRoot)
  const scope = getScope(sessionReference, params.projectRoot)
  if (params.templateScope !== 'subset') {
    const owners = new Set(bindableEntries.map(([, template]) => template.id))
    for (const [owner, reference] of scope.activeReferences) {
      if (!owners.has(scope.bindings.get(reference)!.agentId)) {
        scope.bindings.delete(reference)
        scope.activeReferences.delete(owner)
      }
    }
  }
  const templates: Record<string, McpReferencedTemplate> = Object.create(null)
  for (const [key, template] of entries) {
    if (!canBindTemplate(template)) {
      templates[key] = template
      continue
    }
    // Removing or replacing a configured server revokes its previous ref.
    // An in-flight request using that older authority must rediscover/rebind.
    for (const [owner, reference] of scope.activeReferences) {
      const binding = scope.bindings.get(reference)!
      if (
        binding.agentId === template.id &&
        !Object.hasOwn(template.mcpServers ?? {}, binding.serverName)
      ) {
        scope.bindings.delete(reference)
        scope.activeReferences.delete(owner)
      }
    }
    if (!Object.keys(template.mcpServers ?? {}).length) {
      templates[key] = template
      continue
    }
    const servers: Record<string, MCPConfig> = Object.create(null)
    const references: Record<string, string> = Object.create(null)
    for (const [serverName, config] of Object.entries(
      template.mcpServers ?? {},
    )) {
      const digest = mcpConfigDigest(config)
      const owner = JSON.stringify([template.id, serverName])
      const activeReference = scope.activeReferences.get(owner)
      const activeBinding = activeReference
        ? scope.bindings.get(activeReference)
        : undefined
      const oldReference = template.mcpServerReferences?.[serverName]
      const oldBinding = oldReference
        ? scope.bindings.get(oldReference)
        : undefined
      const sourceOrigin = originOf(config)
      if (oldReference && !oldBinding && sourceOrigin === undefined)
        throw new Error(
          `MCP reference for ${template.id}/${serverName} is unknown in this session.`,
        )
      if (
        oldBinding &&
        (oldBinding.agentId !== template.id ||
          oldBinding.serverName !== serverName)
      )
        throw new Error(
          `MCP reference does not belong to ${template.id}/${serverName}.`,
        )
      if (
        oldBinding &&
        oldBinding.digest !== digest &&
        sourceOrigin === undefined
      )
        throw new Error(
          `MCP configuration changed without a host binding for ${template.id}/${serverName}.`,
        )

      // An explicit source downgrade remains authoritative. Loader-provided
      // replacements mint new refs rather than rewriting an immutable binding.
      if (
        oldBinding &&
        oldBinding.digest === digest &&
        (sourceOrigin === undefined || sourceOrigin === oldBinding.origin)
      ) {
        servers[serverName] = oldBinding.config
        references[serverName] = oldReference!
      } else if (
        !oldReference &&
        activeBinding?.digest === digest &&
        sourceOrigin === activeBinding.origin
      ) {
        // The same authoritative loader may supply a fresh object each turn.
        // Reuse its active immutable binding instead of revoking equivalent work.
        servers[serverName] = activeBinding.config
        references[serverName] = activeReference!
      } else {
        if (scope.bindings.size >= MAX_SCOPE_BINDINGS && !activeReference)
          throw new Error(
            'MCP host binding limit reached; start a new session.',
          )
        const origin = resolveMCPConfigOrigin(config)
        const hostConfig = snapshot(config, origin)
        const reference = randomUUID()
        if (activeReference) scope.bindings.delete(activeReference)
        scope.bindings.set(reference, {
          agentId: template.id,
          serverName,
          digest,
          origin,
          config: hostConfig,
        })
        scope.activeReferences.set(owner, reference)
        servers[serverName] = hostConfig
        references[serverName] = reference
      }
    }
    templates[key] = {
      ...template,
      mcpServers: servers,
      mcpServerReferences: references,
    }
  }
  return { sessionReference, templates }
}

export type McpReferenceParams = {
  mcpConfig: MCPConfig
  mcpReference?: string
  mcpAgentId?: string
  mcpServerName?: string
}

/** Resolve from host state and execute that snapshot, never a peer's label. */
export function resolveMcpHostBinding(
  params: McpReferenceParams & {
    projectRoot: string
    sessionReference: string
  },
): { config: MCPConfig; origin: MCPConfigOrigin } {
  const scope = getScope(params.sessionReference, params.projectRoot)
  const binding = params.mcpReference
    ? scope.bindings.get(params.mcpReference)
    : undefined
  if (!binding)
    throw new Error(
      'MCP server reference is missing or unknown in this session.',
    )
  if (
    binding.agentId !== params.mcpAgentId ||
    binding.serverName !== params.mcpServerName
  )
    throw new Error('MCP server reference has the wrong agent or server owner.')
  if (binding.digest !== mcpConfigDigest(params.mcpConfig))
    throw new Error(
      'MCP server reference does not match the supplied configuration.',
    )
  if (
    scope.activeReferences.get(
      JSON.stringify([binding.agentId, binding.serverName]),
    ) !== params.mcpReference
  )
    throw new Error('MCP server reference has been replaced or revoked.')
  return { config: binding.config, origin: binding.origin }
}

export type McpBridgeScope = {
  projectRoot: string
  sessionReference: string
  agentId: string
  mcpServers: Record<string, MCPConfig>
  mcpServerReferences: Record<string, string>
}

export function createMcpBridgeScope(request: {
  agentType: string
  fileContext?: unknown
  localAgentTemplates?: unknown
}): McpBridgeScope | undefined {
  const context = request.fileContext as
    | { projectRoot?: string; mcpSessionReference?: string }
    | undefined
  const templates = request.localAgentTemplates as
    | Record<string, McpReferencedTemplate>
    | undefined
  const template =
    templates && Object.hasOwn(templates, request.agentType)
      ? templates[request.agentType]
      : undefined
  if (
    !template ||
    !context?.projectRoot ||
    !context.mcpSessionReference ||
    !Object.keys(template.mcpServers ?? {}).length ||
    !template.mcpServerReferences
  )
    return undefined
  return {
    projectRoot: context.projectRoot,
    sessionReference: context.mcpSessionReference,
    agentId: template.id,
    mcpServers: template.mcpServers!,
    mcpServerReferences: template.mcpServerReferences,
  }
}

/** The parent fixes the child owner; wire arguments cannot select a sibling. */
export function resolveMcpBridgeParams<T extends McpReferenceParams>(
  params: T,
  scope?: McpBridgeScope,
): T {
  if (!scope)
    throw new Error(
      'MCP execution is unavailable without a host-bound child server scope.',
    )
  const name = params.mcpServerName
  if (!name || !Object.hasOwn(scope.mcpServers, name))
    throw new Error('MCP server is not configured for this supervised child.')
  if (
    params.mcpAgentId !== scope.agentId ||
    params.mcpReference !== scope.mcpServerReferences[name]
  )
    throw new Error(
      'MCP request has a mismatched child owner or server reference.',
    )
  const { config } = resolveMcpHostBinding({
    ...params,
    projectRoot: scope.projectRoot,
    sessionReference: scope.sessionReference,
    mcpAgentId: scope.agentId,
  })
  return { ...params, mcpConfig: config, mcpAgentId: scope.agentId }
}
