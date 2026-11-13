import { createHash, randomUUID } from 'crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { mcpToolResult } from './result'
import {
  CompatibilityStdioTransport,
  OwnedStdioTransport,
} from './stdio-transport'
import { isBlockedHost } from '../util/ip-address-policy'
import { jsonSchemaToZod } from '../util/json-schema'

import {
  allowedLoopbackMcpFromEnv,
  createPinnedMcpFetch,
  isAllowedLoopbackMcpAuthority,
  resolvePinnedMcpAddress,
} from './dns-pinning'

import type {
  MCPConfig,
  MCPConfigOrigin,
  McpCatalogTool,
  McpToolCatalog,
} from '../types/mcp'
import type { ToolResultOutput } from '../types/messages/content-part'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type {
  ActionExecutionPort,
  BoundResourcePort,
} from '../types/contracts/execution-context'
import type { CodebuffSpawn } from '../types/spawn'
import type {
  McpToolCallArguments,
  McpToolCatalogOptions,
  MediatedMcpRequest,
} from './request'

export type { McpToolCatalogOptions, MediatedMcpRequest } from './request'

const runningClients: Record<string, Client> = {}
const listToolsCache: Record<
  string,
  ReturnType<typeof Client.prototype.listTools>
> = {}
const listToolsExpiry = new Map<string, number>()
const catalogCache = new Map<
  string,
  { generation: number; expiresAt: number; promise: Promise<McpToolCatalog> }
>()
const cacheTtlMs = 30_000
let nextClientGeneration = 0

type ClientState = {
  client: Client
  transport: Transport
  connection: ConnectionReservation
  generation: number
  origin: MCPConfigOrigin
  closed: boolean
  /** A string client ID never grants access to a mediated resource. */
  mediated?: boolean
  disconnection: AbortController
  invalidation: AbortController
  outputContracts: Map<
    string,
    { schema: unknown; validator?: ReturnType<typeof jsonSchemaToZod> }
  >
}
const clientStates = new Map<string, ClientState>()
// Detached transports whose close rejected remain owned independently of any
// newer connection registered under the same cache identity.
const pendingClientCleanup = new Map<string, Set<ClientState>>()
const clientCleanupAttempts = new WeakMap<ClientState, Promise<void>>()

/** Connecting and detached cleanup owners count until physical cleanup. */
const maxRunningClients = 64
type ConnectionReservation = {
  readonly key: string
  phase: 'connecting' | 'live' | 'closing' | 'cleanup-failed' | 'complete'
  leases: number
  activeUses: number
  state?: ClientState
  /** One successor owns the slot after this exact instance cleans up. */
  successor?: ConnectionReservation
}
const physicalConnections = new Set<ConnectionReservation>()
/** Connection instances in registration order, independent of catalog changes. */
const runningClientOrder = new Set<ClientState>()

export class McpClientCapacityError extends Error {
  readonly name = 'McpClientCapacityError'
  readonly code = 'MCP_CLIENT_CAPACITY'
  readonly maxRunningClients = maxRunningClients
  readonly occupied = physicalConnections.size

  constructor(
    readonly reason: 'all-connections-busy' | 'cleanup-failed',
    readonly cleanupClientId?: string,
    cause?: unknown,
  ) {
    super(
      reason === 'cleanup-failed'
        ? 'MCP capacity unavailable: physical transport cleanup failed'
        : `MCP capacity exhausted: all ${maxRunningClients} connections are leased, active, or closing`,
      { cause },
    )
  }
}

/** Counts physical reservations, including cleanup that protocol close precedes. */
export function getMCPClientCapacity(): Readonly<{
  limit: number
  occupied: number
  connecting: number
  live: number
  closing: number
  cleanupFailed: number
}> {
  const count = (phase: ConnectionReservation['phase']) =>
    [...physicalConnections].filter((connection) => connection.phase === phase)
      .length
  return {
    limit: maxRunningClients,
    occupied: physicalConnections.size,
    connecting: count('connecting'),
    live: count('live'),
    closing: count('closing'),
    cleanupFailed: count('cleanup-failed'),
  }
}

function leaseClient(connection: ConnectionReservation): () => void {
  connection.leases++
  let released = false
  return () => {
    if (released) return
    released = true
    connection.leases--
  }
}

function reserveConnection(pending: PendingConnection): Promise<string> {
  const release = leaseClient(pending.connection)
  return pending.promise.then(
    (id) => {
      // The compatibility string ID protects delivery, not future method use.
      setTimeout(release, 0)
      return id
    },
    (error) => {
      release()
      throw error
    },
  )
}

function withClientUse<T>(
  state: ClientState,
  invoke: () => Promise<T>,
): Promise<T> {
  if (state.closed || clientStates.get(state.connection.key) !== state)
    throw new Error('MCP connection instance is no longer available')
  state.connection.activeUses++
  const release = () => state.connection.activeUses--
  try {
    return invoke().finally(release)
  } catch (error) {
    release()
    throw error
  }
}

function finishPhysicalConnection(connection: ConnectionReservation): void {
  const held = physicalConnections.delete(connection)
  connection.phase = 'complete'
  const successor = connection.successor
  connection.successor = undefined
  // Move the slot before resolving cleanup, so another connect cannot steal it.
  if (held && successor) physicalConnections.add(successor)
}

async function reservePhysicalCapacity(
  connection: ConnectionReservation,
): Promise<void> {
  if (physicalConnections.size < maxRunningClients) {
    physicalConnections.add(connection)
    return
  }
  const victim = [...runningClientOrder].find(
    (state) =>
      !state.closed &&
      state.connection.phase === 'live' &&
      state.connection.leases === 0 &&
      state.connection.activeUses === 0,
  )
  if (!victim) throw new McpClientCapacityError('all-connections-busy')
  victim.connection.successor = connection
  // Reserve close and detach before invoking any transport callback. Parallel
  // connects can each claim one idle victim, never the same physical slot.
  detachRunningClient(victim.connection.key, victim)
  try {
    await cleanupClient(victim.connection.key, victim)
  } catch (error) {
    victim.connection.successor = undefined
    throw new McpClientCapacityError(
      'cleanup-failed',
      victim.connection.key,
      error,
    )
  }
}

/**
 * In-flight connect promises memoized per cache identity (the same key
 * runningClients uses). Concurrent getMCPClient calls for one config share
 * ONE connect instead of racing two transports; the memo is cleared when the
 * promise settles, so a rejected connect is retried by the next call.
 */
type PendingConnection = {
  connection: ConnectionReservation
  promise: Promise<string>
}
const pendingConnects = new Map<string, PendingConnection>()

function getOrStartConnection(
  key: string,
  start: (connection: ConnectionReservation) => Promise<string>,
): PendingConnection {
  const state = clientStates.get(key)
  if (state && !state.closed)
    return { connection: state.connection, promise: Promise.resolve(key) }
  const existing = pendingConnects.get(key)
  if (existing) return existing
  const connection: ConnectionReservation = {
    key,
    phase: 'connecting',
    leases: 0,
    activeUses: 0,
  }
  let pending: PendingConnection
  // Publish the pending identity before capacity cleanup can call user/SDK
  // callbacks reentrantly. No transport is constructed before reservation.
  const promise = Promise.resolve()
    .then(() => reservePhysicalCapacity(connection))
    .then(() => start(connection))
    .catch((error) => {
      if (!connection.state) finishPhysicalConnection(connection)
      throw error
    })
    .finally(() => {
      if (pendingConnects.get(key) === pending) pendingConnects.delete(key)
    })
  pending = { connection, promise }
  pendingConnects.set(key, pending)
  return pending
}
const capturedRemoteKeys = new WeakMap<CapturedMcpConfig, string>()
type MediatedResourceState = {
  port: BoundResourcePort
  connected: boolean
  restartReason?: 'observed-adapter-failure' | 'dead-entry-reacquire'
}
const mediatedResources = new Map<string, MediatedResourceState>()

function clearClientToolCaches(key: string): void {
  const prefix = `${key}\0`
  for (const cacheKey of Object.keys(listToolsCache)) {
    if (cacheKey.startsWith(prefix)) {
      delete listToolsCache[cacheKey]
      listToolsExpiry.delete(cacheKey)
    }
  }
  catalogCache.delete(key)
}

function invalidateClientState(key: string, state: ClientState): void {
  if (clientStates.get(key) === state) clearClientToolCaches(key)
  state.generation = ++nextClientGeneration
  state.invalidation.abort(new Error('MCP tool catalog generation changed'))
  state.invalidation = new AbortController()
  state.outputContracts.clear()
}

function observeOutputContracts(
  state: ClientState,
  tools: McpCatalogTool[],
  replace = false,
): void {
  const contracts: ClientState['outputContracts'] = replace
    ? new Map()
    : state.outputContracts
  for (const tool of tools) {
    if (tool.outputSchema !== undefined)
      contracts.set(tool.name, { schema: structuredClone(tool.outputSchema) })
    else contracts.delete(tool.name)
  }
  state.outputContracts = contracts
}

function detachRunningClient(key: string, state: ClientState): void {
  if (clientStates.get(key) === state) {
    clearClientToolCaches(key)
    delete runningClients[key]
    clientStates.delete(key)
  }
  runningClientOrder.delete(state)
  if (state.closed) return
  state.closed = true
  state.connection.phase = 'closing'
  state.disconnection.abort(new Error('MCP connection closed'))
  invalidateClientState(key, state)
}

export function getMCPClientGeneration(clientId: string): number | undefined {
  const state = clientStates.get(clientId)
  return state && !state.closed ? state.generation : undefined
}

function cleanupClient(
  clientId: string,
  state: ClientState,
  retry = false,
): Promise<void> {
  const existing = clientCleanupAttempts.get(state)
  if (existing && (!retry || state.connection.phase !== 'cleanup-failed'))
    return existing
  let owned = pendingClientCleanup.get(clientId)
  if (!owned) pendingClientCleanup.set(clientId, (owned = new Set()))
  owned.add(state)
  let resolveClose!: () => void
  let rejectClose!: (error: unknown) => void
  const closing = new Promise<void>((resolve, reject) => {
    resolveClose = resolve
    rejectClose = reject
  })
  const attempt = closing.then(
    () => {
      finishPhysicalConnection(state.connection)
      owned.delete(state)
      if (owned.size === 0 && pendingClientCleanup.get(clientId) === owned)
        pendingClientCleanup.delete(clientId)
    },
    (error) => {
      state.connection.phase = 'cleanup-failed'
      throw error
    },
  )
  // Reserve the promise before close may invoke onclose synchronously.
  clientCleanupAttempts.set(state, attempt)
  state.connection.phase = 'closing'
  try {
    // The SDK may clear Client's transport from its onclose callback before
    // close rejects. Keep and retry the concrete transport for this generation.
    const cleanup =
      retry &&
      (state.transport instanceof OwnedStdioTransport ||
        state.transport instanceof CompatibilityStdioTransport)
        ? state.transport.retryCleanup()
        : state.transport.close()
    cleanup.then(resolveClose, rejectClose)
  } catch (error) {
    rejectClose(error)
  }
  return attempt
}

/** Report detached transports whose close has not yet succeeded. */
export function getPendingMCPClientCleanupCount(clientId: string): number {
  return pendingClientCleanup.get(clientId)?.size ?? 0
}

/** Enumerate cleanup owners, including failures from background eviction. */
export function getPendingMCPClientCleanups(): Array<{
  clientId: string
  count: number
}> {
  return [...pendingClientCleanup].map(([clientId, states]) => ({
    clientId,
    count: states.size,
  }))
}

/** Retry only detached generations, never the current registered client. */
export async function retryMCPClientCleanup(clientId: string): Promise<void> {
  const states = [...(pendingClientCleanup.get(clientId) ?? [])]
  const results = await Promise.allSettled(
    states.map((state) => cleanupClient(clientId, state, true)),
  )
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (failures.length) throw new AggregateError(failures, 'MCP cleanup failed')
}

/** Explicitly release a transport; old callbacks cannot detach its replacement. */
export async function closeMCPClient(clientId: string): Promise<void> {
  const state = clientStates.get(clientId)
  if (state) {
    detachRunningClient(clientId, state)
    await cleanupClient(clientId, state)
    return
  }
  // A protocol close can detach before physical cleanup finishes.
  await Promise.all(
    [...(pendingClientCleanup.get(clientId) ?? [])].map((detached) =>
      cleanupClient(clientId, detached),
    ),
  )
}

async function registerRunningClient(
  key: string,
  state: ClientState,
): Promise<void> {
  runningClients[key] = state.client
  clientStates.set(key, state)
  state.connection.phase = 'live'
  runningClientOrder.add(state)
}

/**
 * Thrown when a trusted-origin MCP config references a `$VAR` whose value is
 * absent from this process's environment. Carries every missing variable name
 * collected during a single substitution pass so one value/record produces one
 * clear error. Only reachable on the trusted-origin substitution path
 * ('user'/'project'); a 'client'-origin config never substitutes and never
 * throws (NEW-1).
 */
export class MissingMcpEnvVarError extends Error {
  readonly missingVars: string[]

  constructor(missingVars: string[], label?: string) {
    const plural = missingVars.length === 1 ? '' : 's'
    const suffix = label ? ` (${label})` : ''
    super(
      `Missing environment variable${plural} ${missingVars.join(', ')} ` +
        `referenced by MCP config${suffix}`,
    )
    this.name = 'MissingMcpEnvVarError'
    this.missingVars = missingVars
  }
}

/**
 * Substitutes environment variable references ($VAR_NAME) in a string with their values.
 * Supports both simple replacement ("$VAR_NAME") and interpolation ("Bearer $VAR_NAME").
 *
 * Uses a SINGLE `replace` pass (the substituted output is never re-scanned), so
 * a resolved value that itself contains a `$`+uppercase sequence is emitted
 * verbatim. Undefined vars are collected during the pass; if any were missing,
 * a {@link MissingMcpEnvVarError} listing all of them is thrown after the pass.
 */
function substituteEnvInValue(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const missing: string[] = []
  const result = value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, varName) => {
    const envValue = environment[varName]
    if (envValue === undefined) {
      missing.push(varName)
      // Keep the literal in the (discarded-on-throw) output; the missing var
      // is recorded and reported once the whole value has been scanned.
      return match
    }
    return envValue
  })
  if (missing.length > 0) {
    throw new MissingMcpEnvVarError(missing)
  }
  return result
}

/**
 * Substitutes environment variable references in all values of a record.
 */
function substituteEnvInRecord(
  record: Record<string, string>,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = substituteEnvInValue(value, environment)
  }
  return result
}

/**
 * Matches a `$VAR_NAME`-style environment variable reference (same shape the
 * substitution above expands for trusted origins). Used to detect configs
 * whose values would previously have been expanded but are now used literally
 * at the fail-closed 'client' origin.
 */
function containsEnvVarReference(value: string): boolean {
  return /\$[A-Z_][A-Z0-9_]*/.test(value)
}

/**
 * Who authored an MCP server config. This decides whether `$VAR` references
 * are expanded from this process's environment.
 *
 * - `'user'` / `'project'`: written by the local user (home or project
 *   `mcp.json`, `openbuff.json`, local agent definitions). `$VAR` references
 *   in stdio `env` and remote `headers` are substituted from `process.env`, as
 *   before.
 * - `'client'`: supplied by a protocol peer, e.g. an ACP editor sending
 *   `session/new { mcpServers }`. Its values are used LITERALLY. Expanding them
 *   would let an untrusted peer read BYOK/OAuth secrets out of this process
 *   (e.g. an http server whose header is `Authorization: $OPENROUTER_API_KEY`
 *   pointing at an attacker URL).
 *
 * Origin is recorded in the module-level registry ({@link markMCPConfigOrigin})
 * by trusted callers, never read from config content, so an untrusted config
 * cannot claim a trusted origin.
 *
 * The type itself is defined in `../types/mcp` (a Client-free module) and
 * re-exported here for back-compat; keeping the definition out of this
 * SDK-heavy module prevents the MCP `Client` type graph from leaking into the
 * SDK's public `.d.ts` bundle through trusted-loader modules that only need
 * the origin type.
 */
export type { MCPConfigOrigin } from '../types/mcp'

/**
 * Origin registry sidecar for MCP configs. Origin is stored out of band (a
 * WeakMap keyed by the config object), never on the config itself, so an
 * untrusted config cannot claim a trusted origin from its own content.
 */
const mcpConfigOrigins = new WeakMap<MCPConfig, MCPConfigOrigin>()

/**
 * Records the origin of an MCP config in the module-level registry.
 *
 * Overwrite rule (NEW-1): a config already marked 'client' can never be
 * upgraded to a trusted origin. Trusted-loader blanket marks stamp whole
 * `mcpServers` records 'project'/'user' unconditionally (e.g. local agent
 * assembly over fileContext.agentTemplates), so without this guard an
 * untrusted config that reached trusted material would silently regain $VAR
 * expansion. Trusted origins may still overwrite each other (e.g.
 * 'project' -> 'user'), and any origin may downgrade to 'client' (fail
 * closed).
 */
export function markMCPConfigOrigin(
  config: MCPConfig,
  origin: MCPConfigOrigin,
): void {
  if (mcpConfigOrigins.get(config) === 'client') {
    return
  }
  mcpConfigOrigins.set(config, origin)
}

/**
 * Marks every MCP config in a server map (silently no-ops on undefined/empty)
 * so trusted loaders can stamp a whole `mcpServers` record in one call.
 * Entries already marked 'client' keep their untrusted mark (see
 * {@link markMCPConfigOrigin}).
 *
 * The value type is generic because callers pass server maps typed by
 * different (structurally near-identical) config schemas — the agent
 * definition schema vs the validated MCPConfig schema — and only object
 * identity matters for the WeakMap-backed mark.
 */
export function markAllMCPConfigOrigins<T extends object>(
  servers: Record<string, T> | undefined,
  origin: MCPConfigOrigin,
): void {
  if (!servers) {
    return
  }
  for (const config of Object.values(servers)) {
    markMCPConfigOrigin(config as MCPConfig, origin)
  }
}

/**
 * Re-attaches origin marks from a source record of MCP configs onto a freshly
 * built target record keyed by the same server names.
 *
 * Validation re-parses (e.g. Zod in validateSingleAgent) create brand-new
 * config objects that have no WeakMap entry, so a trusted blanket mark after
 * the re-parse would silently upgrade any config that was already marked
 * 'client' before the hop — defeating the NEW-1 no-upgrade invariant. This
 * helper carries the source marks across the identity-losing hop first:
 *
 * - a 'client' source mark always propagates (downgrading an already trusted
 *   target mark — fail closed);
 * - a trusted source mark only fills in targets that are still unmarked.
 */
export function propagateMCPConfigOrigins<S extends object, T extends object>(
  source: Record<string, S> | undefined,
  target: Record<string, T> | undefined,
): void {
  if (!source || !target) {
    return
  }
  for (const [name, targetConfig] of Object.entries(target)) {
    const sourceConfig = source[name]
    if (!sourceConfig) {
      continue
    }
    const sourceOrigin = originOf(sourceConfig as MCPConfig)
    if (!sourceOrigin) {
      continue
    }
    if (
      sourceOrigin === 'client' ||
      originOf(targetConfig as MCPConfig) === undefined
    ) {
      markMCPConfigOrigin(targetConfig as MCPConfig, sourceOrigin)
    }
  }
}

/**
 * Returns the origin recorded for an MCP config, or undefined when it is
 * unmarked. Unmarked configs are treated as untrusted 'client' origins (fail
 * closed): trusted on-disk loaders must mark their configs 'user' or
 * 'project' explicitly to keep $VAR substitution.
 */
export function originOf(config: MCPConfig): MCPConfigOrigin | undefined {
  return mcpConfigOrigins.get(config)
}

function originAllowsEnvSubstitution(origin: MCPConfigOrigin): boolean {
  return origin === 'user' || origin === 'project'
}

/**
 * Emits a one-time warning when an UNMARKED config containing `$VAR`
 * references is used at the fail-closed 'client' origin.
 *
 * Before origin marking existed, every config — including configs passed
 * programmatically straight to `client.run` — had its `$VAR` references
 * expanded from `process.env`. The fail-closed default now uses such values
 * literally, so an upgrading SDK caller's MCP server can be launched with a
 * literal `'$NOTION_TOKEN'`-style value whose only visible symptom is a
 * remote-side auth failure. This warning is the diagnosability signal for
 * that migration path; the fail-closed behavior itself is intentional.
 *
 * Never warns for:
 * - explicitly marked 'client' configs (protocol peers): literal values are
 *   the intended, security-motivated behavior there;
 * - configs without any `$VAR` reference: their behavior did not change.
 *
 * Deduplication is keyed on the config content (type, endpoint, and the
 * record holding the references), so repeated uses of an equivalent config
 * warn once per process rather than once per call — bounded by the number of
 * distinct unmarked configs, mirroring the `runningClients` registry.
 */
const failClosedWarnedKeys = new Set<string>()

export function diagnoseFailClosedEnvRefs(
  config: MCPConfig,
  origin: MCPConfigOrigin,
): void {
  if (origin !== 'client' || originOf(config) !== undefined) {
    return
  }
  const record = config.type === 'stdio' ? config.env : config.headers
  const fieldsWithRefs = Object.entries(record)
    .filter(([, value]) => containsEnvVarReference(value))
    .map(([key]) => key)
  if (fieldsWithRefs.length === 0) {
    return
  }
  const dedupKey = JSON.stringify([
    config.type,
    config.type === 'stdio' ? config.command : config.url,
    record,
  ])
  if (failClosedWarnedKeys.has(dedupKey)) {
    return
  }
  failClosedWarnedKeys.add(dedupKey)
  console.warn(
    `[mcp] MCP server config has no recorded origin and is treated as ` +
      `untrusted ('client' origin): $VAR references will NOT be expanded ` +
      `from this process's environment; literal values are used as-is ` +
      `(fields: ${fieldsWithRefs.join(', ')}). If this config is local and ` +
      `trusted, load it via loadMCPConfig()/loadLocalAgents() or mark it ` +
      `with markMCPConfigOrigin(config, 'project') before running.`,
  )
}

/**
 * Resolves the effective origin for an MCP config: an explicit `options`
 * origin or a recorded mark wins; an unmarked config fails closed to
 * 'client' — and, when that silent downgrade would change behavior (the
 * config still contains `$VAR` references), emits the one-time
 * diagnosability warning from {@link diagnoseFailClosedEnvRefs}.
 */
export function resolveMCPConfigOrigin(
  config: MCPConfig,
  options?: { origin?: MCPConfigOrigin },
): MCPConfigOrigin {
  const origin = options?.origin ?? originOf(config)
  if (origin) {
    return origin
  }
  diagnoseFailClosedEnvRefs(config, 'client')
  return 'client'
}

/**
 * True for a private/loopback/link-local/metadata address that a client-origin
 * (untrusted protocol peer, NEW-1) MCP server must not be allowed to reach.
 *
 * Synchronous: it does NOT perform DNS resolution, so a bare unresolved
 * hostname that is not one of the blocked names/suffixes returns false. DNS
 * rebinding is handled by `dns-pinning.ts`, which classifies every resolved
 * address with this same function.
 *
 * N05: delegates to the shared egress classifier in
 * `common/src/util/ip-address-policy.ts`, which is also used by the web fetch
 * tool. It canonicalizes every IPv4 spelling (decimal, octal, hex,
 * shorthand), unmaps IPv4-mapped/compatible/NAT64/6to4 IPv6 forms (including
 * the hex form `::ffff:7f00:1` that WHATWG URL produces), and fails closed on
 * a malformed numeric host.
 */
export function isBlockedMcpAddress(host: string): boolean {
  return isBlockedHost(host)
}

export type ResolvedMCPConfigValues =
  | {
      type: 'stdio'
      command: string
      args: string[]
      env: Record<string, string>
    }
  | {
      type: 'http' | 'sse'
      url: string
      params: Record<string, string>
      headers: Record<string, string>
    }

/**
 * Returns the effective values used to connect to an MCP server. `$VAR`
 * substitution applies only to trusted origins (see {@link MCPConfigOrigin}).
 *
 * Failure mode for batch callers (RF-1-7a1e4076): at a trusted
 * ('user'/'project') origin a referenced-but-undefined `$VAR` throws
 * {@link MissingMcpEnvVarError} (one error per value, listing every missing
 * name collected in that value's single substitution pass). A 'client' origin
 * never substitutes and so never throws. This function resolves exactly ONE
 * config, so a caller that enumerates a whole `mcpServers` map (directly or via
 * {@link getMCPClientCacheKey}) MUST isolate per config — as getMCPToolData
 * does with Promise.allSettled — so one server's missing var loses only that
 * server's identity/tools instead of aborting the entire enumeration.
 */
export function resolveMCPConfigValues(
  config: MCPConfig,
  origin: MCPConfigOrigin,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedMCPConfigValues {
  const substitute = originAllowsEnvSubstitution(origin)
  if (config.type === 'stdio') {
    return {
      type: 'stdio',
      command: config.command,
      args: [...config.args],
      env: substitute
        ? substituteEnvInRecord(config.env, environment)
        : { ...config.env },
    }
  }
  if (config.type === 'http' || config.type === 'sse') {
    return {
      type: config.type,
      url: config.url,
      params: { ...config.params },
      headers: substitute
        ? substituteEnvInRecord(config.headers, environment)
        : { ...config.headers },
    }
  }
  config.type satisfies never
  throw new Error(`Internal error: invalid MCP config type ${config.type}`)
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hashRecordValues(
  record: Record<string, string>,
  options?: { caseInsensitiveKeys?: boolean },
): Record<string, string> {
  // HTTP header names are case-insensitive, so they are normalized first when
  // requested (later duplicates deterministically win). Env var names are
  // case-sensitive — e.g. API_KEY and api_key are genuinely distinct variables
  // on Linux — so they keep their original case; collapsing them would make
  // two distinct stdio configs hash to the same cache identity and silently
  // drop the second server's env.
  const normalizeKey = options?.caseInsensitiveKeys
    ? (key: string) => key.toLowerCase()
    : (key: string) => key
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    normalized[normalizeKey(key)] = stableHash(value)
  }

  return Object.fromEntries(
    Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)),
  )
}

/** Captured configuration is data. Only the separately registered resource grants access. */
export type CapturedMcpConfig = Readonly<{
  origin: MCPConfigOrigin
  resolved: ResolvedMCPConfigValues
  allowedLoopbackMcp: readonly string[]
}>

export function captureMcpConfig(
  config: MCPConfig,
  options: {
    origin: MCPConfigOrigin
    environment: Readonly<Record<string, string | undefined>>
    allowedLoopbackMcp?: readonly string[]
  },
): CapturedMcpConfig {
  const resolved = resolveMCPConfigValues(
    config,
    options.origin,
    options.environment,
  )
  if (resolved.type === 'stdio') {
    Object.freeze(resolved.args)
    Object.freeze(resolved.env)
  } else {
    Object.freeze(resolved.params)
    Object.freeze(resolved.headers)
  }
  return Object.freeze({
    origin: options.origin,
    resolved: Object.freeze(resolved),
    allowedLoopbackMcp: Object.freeze([...(options.allowedLoopbackMcp ?? [])]),
  })
}

/** Remote transports retain origin/DNS/result behavior and use captured values once. */
export async function getCapturedMCPClient(
  captured: CapturedMcpConfig,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  options.signal?.throwIfAborted()
  if (captured.resolved.type === 'stdio')
    throw new Error('Captured stdio MCP requires a registered process resource')
  let key = capturedRemoteKeys.get(captured)
  if (!key) {
    key = `mcp-remote:${randomUUID()}`
    capturedRemoteKeys.set(captured, key)
  }
  const clientId = key
  return reserveConnection(
    getOrStartConnection(clientId, (connection) =>
      connectMCPClient(
        undefined,
        captured.origin,
        captured.allowedLoopbackMcp,
        clientId,
        connection,
        captured.resolved,
        undefined,
        options.signal,
      ),
    ),
  )
}

/**
 * One request lease over a host-registered stdio resource. The root constructs
 * the resource from the same captured config/destination and supplies a fresh
 * action port for every caller. Returned string IDs alone cannot invoke it.
 */
export async function getMediatedMCPClient(
  captured: CapturedMcpConfig,
  options: {
    resource: BoundResourcePort
    execution: ActionExecutionPort
    signal?: AbortSignal
    spawn?: CodebuffSpawn
  },
): Promise<MediatedMcpRequest> {
  if (captured.resolved.type !== 'stdio')
    throw new Error('A process resource is required only for stdio MCP')
  options.signal?.throwIfAborted()
  let resourceState = mediatedResources.get(options.resource.key)
  if (!resourceState) {
    resourceState = { port: options.resource, connected: false }
    mediatedResources.set(options.resource.key, resourceState)
  }
  let clientId = `mcp-resource:${resourceState.port.key}`
  if (
    !runningClients[clientId] &&
    !pendingConnects.has(clientId) &&
    (resourceState.connected || resourceState.restartReason)
  ) {
    // Authenticate this caller before the host creates another generation.
    const previous = resourceState.port.request(options.execution)
    if (!previous.ok) throw executionError(previous)
    previous.value.release()
    const replacement = resourceState.port.restart(
      resourceState.restartReason ?? 'dead-entry-reacquire',
    )
    if (!replacement.ok) throw executionError(replacement)
    resourceState.port = replacement.value
    mediatedResources.set(replacement.value.key, resourceState)
    resourceState.connected = false
    resourceState.restartReason = undefined
    clientId = `mcp-resource:${replacement.value.key}`
  }
  const requested = resourceState.port.request(options.execution)
  if (!requested.ok) throw executionError(requested)
  const access = requested.value
  let releaseClient: (() => void) | undefined
  try {
    options.signal?.throwIfAborted()
    const pending = getOrStartConnection(clientId, (connection) => {
      // start() calls prepareLaunch after all Client callbacks are installed.
      const transport = new OwnedStdioTransport({
        prepareLaunch: () => access.prepareLaunch(),
        spawn: options.spawn,
      })
      return connectMCPClient(
        undefined,
        captured.origin,
        captured.allowedLoopbackMcp,
        clientId,
        connection,
        captured.resolved,
        transport,
      ).then(
        (id) => {
          resourceState.connected = true
          return id
        },
        (error) => {
          // A policy refusal is not a crash/restart signal. A later caller
          // can renew only an attempted transport that actually failed.
          if (
            !(
              error instanceof Error && error.name === 'ExecutionAdmissionError'
            ) ||
            (error as { executionRefusal?: { reason?: string } })
              .executionRefusal?.reason === 'dispatch-failed'
          )
            resourceState.restartReason = 'observed-adapter-failure'
          throw error
        },
      )
    })
    releaseClient = leaseClient(pending.connection)
    await waitForMcpRequest(pending.promise, options.signal)
    const state = clientStates.get(clientId)
    if (
      !state ||
      state.closed ||
      state.connection !== pending.connection ||
      !state.mediated ||
      state.origin !== captured.origin
    )
      throw new Error('MCP resource connection is unavailable or incompatible')
    resourceState.connected = true
    let released = false
    let activeUses = 0
    let accessReleased = false
    const releaseWhenIdle = () => {
      if (released && activeUses === 0 && !accessReleased) {
        accessReleased = true
        try {
          access.release()
        } finally {
          releaseClient?.()
        }
      }
    }
    const use = async <T>(
      operation: string,
      invoke: () => Promise<T>,
    ): Promise<T> => {
      if (released) throw new Error('MCP request lease has been released')
      if (state.closed || clientStates.get(clientId) !== state)
        throw new Error('MCP request connection is no longer available')
      activeUses++
      state.connection.activeUses++
      try {
        options.signal?.throwIfAborted()
        const permit = await waitForMcpRequest(
          access.admitUse(operation),
          combineRequestSignals(options.signal, state.disconnection.signal),
        )
        if (!permit.ok) throw executionError(permit)
        if (state.closed || clientStates.get(clientId) !== state)
          throw new Error('MCP request connection is no longer available')
        const started = access.useNow(permit.value, invoke)
        if (!started.ok) throw executionError(started)
        return await started.value
      } finally {
        activeUses--
        state.connection.activeUses--
        releaseWhenIdle()
      }
    }
    return Object.freeze({
      id: clientId,
      get generation() {
        return !state.closed && clientStates.get(clientId) === state
          ? state.generation
          : undefined
      },
      listToolCatalog: (catalogOptions: McpToolCatalogOptions = {}) =>
        use(
          stableHash([
            'mcp.catalog.v1',
            catalogOptions.maxPages ?? null,
            catalogOptions.maxTools ?? null,
          ]),
          () =>
            listMCPToolCatalogInternal(clientId, {
              ...catalogOptions,
              signal: combineRequestSignals(
                options.signal,
                catalogOptions.signal,
              ),
            }),
        ),
      callTool: (...args: McpToolCallArguments) =>
        use(stableHash(['mcp.call.v1', args[0]]), () => {
          const [params, schema, callOptions] = args
          return callMCPToolInternal(clientId, params, schema, {
            ...callOptions,
            signal: combineRequestSignals(options.signal, callOptions?.signal),
          })
        }),
      release: () => {
        if (released) return
        released = true
        releaseWhenIdle()
      },
    })
  } catch (error) {
    try {
      access.release()
    } finally {
      releaseClient?.()
    }
    throw error
  }
}

function executionError(result: { reason: string; cause: string }): Error {
  return Object.assign(new Error(result.cause), {
    name: 'ExecutionAdmissionError',
    executionRefusal: result,
  })
}

function combineRequestSignals(
  a?: AbortSignal,
  b?: AbortSignal,
): AbortSignal | undefined {
  return a && b ? AbortSignal.any([a, b]) : (a ?? b)
}

async function waitForMcpRequest<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abort = () =>
          reject(signal.reason ?? new Error('MCP request cancelled'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
}

function requireLegacyClient(clientId: string): void {
  if (clientStates.get(clientId)?.mediated)
    throw new Error('MCP resource access requires a current request lease')
}

/**
 * Computes the cache identity for an MCP config. Because it resolves values
 * through {@link resolveMCPConfigValues}, it inherits that function's
 * trusted-origin throw (RF-1-7a1e4076): a missing `$VAR` at a 'user'/'project'
 * origin throws {@link MissingMcpEnvVarError}, while a 'client' origin never
 * throws. A batch caller enumerating a whole `mcpServers` map to build cache
 * keys must therefore isolate per config so one bad server does not abort the
 * whole batch.
 */
export function getMCPClientCacheKey(
  config: MCPConfig,
  options?: { origin?: MCPConfigOrigin },
): string {
  // Fail closed: an unmarked config is an untrusted 'client' origin.
  const origin = resolveMCPConfigOrigin(config, options)
  const resolved = resolveMCPConfigValues(config, origin)
  // Origin is part of the identity so a client-origin connection never
  // reuses a running client created for a trusted origin (or vice versa).
  if (resolved.type === 'stdio') {
    return JSON.stringify({
      origin,
      command: resolved.command,
      args: resolved.args,
      // Env var names are case-sensitive; keep their original case in the identity.
      env: hashRecordValues(resolved.env),
    })
  }
  return JSON.stringify({
    origin,
    type: resolved.type,
    url: resolved.url,
    params: resolved.params,
    // HTTP header names are case-insensitive; normalize casing in the identity.
    headers: hashRecordValues(resolved.headers, { caseInsensitiveKeys: true }),
  })
}

export async function getMCPClient(
  config: MCPConfig,
  options?: {
    origin?: MCPConfigOrigin
    /**
     * `serve.allowedLoopbackMcp`: loopback `host:port` authorities a
     * client-origin remote server may connect to. Threaded through to the
     * NEW-7 DNS pinning so an explicitly allowlisted local server is
     * permitted while every other blocked address still fails closed.
     * When omitted, the OPENBUFF_ALLOWED_LOOPBACK_MCP environment variable
     * is consulted (see {@link allowedLoopbackMcpFromEnv}) so the process
     * env is the config surface an operator can actually set for a serve
     * process without a code change.
     *
     * Fail closed (RF-3): an EMPTY array and an OMITTED option (with no
     * OPENBUFF_ALLOWED_LOOPBACK_MCP set) both mean 'no allowlist' — every
     * blocked address is refused for a client-origin server. The effective
     * value is part of the getMCPClient cache identity, so a client
     * connected under a permissive allowlist is never reused by a later
     * caller passing none.
     */
    allowedLoopbackMcp?: readonly string[]
  },
): Promise<string> {
  // Fail closed: an unmarked config is an untrusted 'client' origin.
  const origin = resolveMCPConfigOrigin(config, options)
  // The effective allowlist: the explicit option wins, else the environment
  // variable. Empty/undefined both mean 'no allowlist' (fail closed).
  const allowedLoopbackMcp =
    options?.allowedLoopbackMcp ?? allowedLoopbackMcpFromEnv()
  let key = getMCPClientCacheKey(config, { origin })
  // The effective allowlist is part of the cache identity (NEW-7): without
  // this, a client created under a permissive allowlist would be silently
  // reused by a later caller that passes no allowlist (and vice versa),
  // contradicting the fail-closed semantics documented above. An undefined
  // allowlist adds no suffix, so the plain identity stays stable for the
  // common no-allowlist case.
  if (allowedLoopbackMcp !== undefined) {
    key += `|${stableHash(allowedLoopbackMcp)}`
  }
  // Double-connect race: concurrent getMCPClient calls for the SAME config
  // identity share one in-flight connect promise instead of each building a
  // transport (previously both raced, and the loser's transport/client was
  // discarded while its socket/process stayed open). The memo entry is
  // cleared when the promise settles, so a REJECTED connect is retried by
  // the next call rather than served from a poisoned memo.
  return reserveConnection(
    getOrStartConnection(key, (connection) =>
      connectMCPClient(config, origin, allowedLoopbackMcp, key, connection),
    ),
  )
}

/**
 * Builds ONE transport/client for the given cache identity and connects it.
 * Extracted verbatim from getMCPClient (SEC-3 SSRF guard, NEW-7 DNS pinning,
 * and the argv-safe stdio spawn are unchanged) so the memoization wrapper
 * above stays small. A rejection propagates to every caller sharing the
 * memoized promise and the memo entry is cleared, so the next call retries
 * the connect instead of replaying a cached failure.
 */
async function connectMCPClient(
  config: MCPConfig | undefined,
  origin: MCPConfigOrigin,
  allowedLoopbackMcp: readonly string[] | undefined,
  key: string,
  connection: ConnectionReservation,
  captured?: ResolvedMCPConfigValues,
  ownedTransport?: Transport,
  lifetimeSignal?: AbortSignal,
): Promise<string> {
  lifetimeSignal?.throwIfAborted()
  const resolved =
    captured ?? (config ? resolveMCPConfigValues(config, origin) : undefined)
  if (!resolved) throw new Error('MCP configuration is missing')
  let transport: Transport
  if (resolved.type === 'stdio') {
    transport =
      ownedTransport ??
      new CompatibilityStdioTransport({
        command: resolved.command,
        args: resolved.args,
        env: resolved.env,
      })
  } else {
    const url = new URL(resolved.url)
    // SEC-3 SSRF guard: a client-origin (untrusted peer, NEW-1) remote server
    // must not be allowed to reach a private/loopback/link-local/metadata
    // host. Trusted origins ('user'/'project') are legitimate local configs
    // and are never restricted. This throws before any transport/socket is
    // constructed for a blocked host.
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    if (
      origin === 'client' &&
      isBlockedMcpAddress(hostname) &&
      !isAllowedLoopbackMcpAuthority(hostname, url.port, allowedLoopbackMcp)
    ) {
      throw new Error(
        `MCP client-origin server "${resolved.url}" refused: host ` +
          `${hostname} is a private/loopback address`,
      )
    }
    for (const [paramKey, value] of Object.entries(resolved.params)) {
      url.searchParams.set(paramKey, value)
    }
    const headers = resolved.headers
    if (origin === 'client') {
      // NEW-7 DNS-rebinding pinning: resolve the hostname once, refuse when
      // resolution fails or ANY resolved address is blocked (unless
      // allowlisted via serve.allowedLoopbackMcp), and pin every request the
      // transport makes to a validated address with redirects disabled. This
      // closes the TOCTOU gap left by the synchronous literal-hostname check
      // above: a hostname that re-resolves to a private IP between check and
      // connect can no longer slip through. Awaited before any transport is
      // constructed, so a refusal happens before any socket opens.
      await resolvePinnedMcpAddress(url, {
        allowedLoopbackMcp,
      })
      const pinnedFetch = createPinnedMcpFetch({
        allowedLoopbackMcp,
      })
      if (resolved.type === 'http') {
        transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers },
          fetch: pinnedFetch,
        })
      } else if (resolved.type === 'sse') {
        transport = new SSEClientTransport(url, {
          requestInit: { headers },
          fetch: pinnedFetch,
        })
      } else {
        resolved.type satisfies never
        throw new Error(
          `Internal error: invalid MCP config type ${resolved.type}`,
        )
      }
    } else if (resolved.type === 'http') {
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers,
        },
      })
    } else if (resolved.type === 'sse') {
      transport = new SSEClientTransport(url, {
        requestInit: {
          headers,
        },
      })
    } else {
      resolved.type satisfies never
      throw new Error(
        `Internal error: invalid MCP config type ${resolved.type}`,
      )
    }
  }

  const client = new Client({
    name: 'openbuff',
    version: '1.0.0',
  })

  const state: ClientState = {
    client,
    transport,
    connection,
    generation: ++nextClientGeneration,
    origin,
    closed: false,
    ...(ownedTransport ? { mediated: true } : {}),
    disconnection: new AbortController(),
    invalidation: new AbortController(),
    outputContracts: new Map(),
  }
  connection.state = state
  // Register before initialization so early notifications/disconnects fence
  // discovery too. Each callback closes over its own connection state.
  const closeForLifetime = () => {
    detachRunningClient(key, state)
    void cleanupClient(key, state).catch(() => {})
  }
  client.onclose = () => {
    lifetimeSignal?.removeEventListener('abort', closeForLifetime)
    detachRunningClient(key, state)
    void cleanupClient(key, state).catch(() => {})
  }
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    if (
      !state.closed &&
      (!clientStates.has(key) || clientStates.get(key) === state)
    )
      invalidateClientState(key, state)
  })
  lifetimeSignal?.addEventListener('abort', closeForLifetime, { once: true })
  try {
    lifetimeSignal?.throwIfAborted()
    await client.connect(transport)
    if (state.closed)
      throw new Error('MCP connection closed during initialization')
    await registerRunningClient(key, state)
    if (state.closed || clientStates.get(key) !== state)
      throw new Error('MCP connection closed during registration')
  } catch (error) {
    lifetimeSignal?.removeEventListener('abort', closeForLifetime)
    detachRunningClient(key, state)
    await cleanupClient(key, state).catch(() => {})
    throw error
  }

  return key
}

export function listMCPTools(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.listTools>
): ReturnType<typeof Client.prototype.listTools> {
  requireLegacyClient(clientId)
  return listMCPToolsInternal(clientId, ...args)
}

function listMCPToolsInternal(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.listTools>
): ReturnType<typeof Client.prototype.listTools> {
  const state = clientStates.get(clientId)
  if (!state || state.closed) {
    throw new Error(`listTools: client not found with id: ${clientId}`)
  }
  const generation = state.generation
  // Cancellation belongs to each caller; never share a signal-bound request.
  const cacheable = args[1]?.signal === undefined
  const cacheKey = `${clientId}\0${stableHash(args)}`
  const expiry = listToolsExpiry.get(cacheKey)
  if (expiry !== undefined && expiry <= Date.now()) {
    delete listToolsCache[cacheKey]
    listToolsExpiry.delete(cacheKey)
  }
  const cachedPage = listToolsCache[cacheKey]
  if (cacheable && cachedPage !== undefined) return cachedPage
  const signal = args[1]?.signal
    ? AbortSignal.any([state.invalidation.signal, args[1].signal])
    : state.invalidation.signal
  const pending = withClientUse(state, () =>
    state.client.listTools(args[0], { ...args[1], signal }).then((result) => {
      if (
        clientStates.get(clientId) !== state ||
        state.closed ||
        state.generation !== generation
      ) {
        throw new Error(
          'MCP tool catalog generation changed during page discovery',
        )
      }
      if (cacheable && listToolsCache[cacheKey] === pending)
        listToolsExpiry.set(cacheKey, Date.now() + cacheTtlMs)
      observeOutputContracts(state, result.tools)
      return result
    }),
  )
  if (cacheable) listToolsCache[cacheKey] = pending
  void pending.catch(() => {
    if (listToolsCache[cacheKey] === pending) {
      delete listToolsCache[cacheKey]
      listToolsExpiry.delete(cacheKey)
    }
  })
  return pending
}

/** Complete discovery belongs to one connection/catalog generation. */
export function listMCPToolCatalog(
  clientId: string,
  options: McpToolCatalogOptions = {},
): Promise<McpToolCatalog> {
  requireLegacyClient(clientId)
  return listMCPToolCatalogInternal(clientId, options)
}

function listMCPToolCatalogInternal(
  clientId: string,
  options: McpToolCatalogOptions = {},
): Promise<McpToolCatalog> {
  const state = clientStates.get(clientId)
  const cached = catalogCache.get(clientId)
  const cacheable = Object.keys(options).length === 0
  if (
    cacheable &&
    cached &&
    cached.generation === state?.generation &&
    cached.expiresAt > Date.now()
  )
    return cached.promise
  const promise =
    state && !state.closed
      ? withClientUse(state, () =>
          discoverMCPToolCatalog(clientId, state, options),
        )
      : discoverMCPToolCatalog(clientId, state, options)
  if (cacheable && state) {
    const entry = {
      generation: state.generation,
      expiresAt: Number.POSITIVE_INFINITY,
      promise,
    }
    catalogCache.set(clientId, entry)
    void promise.then(
      (result) => {
        if (catalogCache.get(clientId) !== entry) return
        if (
          result.complete &&
          clientStates.get(clientId) === state &&
          state.generation === result.generation
        )
          entry.expiresAt = Date.now() + cacheTtlMs
        else catalogCache.delete(clientId)
      },
      () => {
        if (catalogCache.get(clientId) === entry) catalogCache.delete(clientId)
      },
    )
  }
  return promise
}

async function discoverMCPToolCatalog(
  clientId: string,
  state: ClientState | undefined,
  options: McpToolCatalogOptions,
): Promise<McpToolCatalog> {
  const catalog: McpToolCatalog = {
    kind: 'mcp_tool_catalog',
    schemaVersion: 1,
    generation: state?.generation ?? null,
    complete: false,
    incompleteReasons: [],
    tools: [],
    ...(state ? { origin: state.origin } : {}),
  }
  const fail = (reason: string, discardTools = false): McpToolCatalog => {
    catalog.incompleteReasons.push(reason)
    if (discardTools) catalog.tools = []
    return catalog
  }
  if (!state || state.closed) return fail('client_not_found')
  const maxPages = options.maxPages ?? 128
  const maxTools = options.maxTools ?? 5000
  const timeoutMs = options.timeoutMs ?? 10_000
  for (const [name, value] of Object.entries({
    maxPages,
    maxTools,
    timeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 0)
      return fail(`invalid_limit: ${name}`)
  }
  if (options.signal?.aborted) return fail('cancelled')
  if (timeoutMs === 0) return fail('deadline_exceeded')
  const deadline = new AbortController()
  const timer = setTimeout(
    () => deadline.abort(new Error('MCP catalog deadline exceeded')),
    timeoutMs,
  )
  const signal = AbortSignal.any([
    state.invalidation.signal,
    deadline.signal,
    ...(options.signal ? [options.signal] : []),
  ])
  const seenCursors = new Set<string>()
  const tools = new Map<string, McpCatalogTool>()
  let cursor: string | undefined
  try {
    for (let page = 0; page < maxPages; page++) {
      if (signal.aborted) throw signal.reason
      // Race the signal as well as forwarding it to the SDK, so the whole
      // traversal bound also holds for a peer/request that ignores cancellation.
      let abortListener: (() => void) | undefined
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(signal.reason)
        signal.addEventListener('abort', abortListener, { once: true })
        if (signal.aborted) abortListener()
      })
      let listed: Awaited<ReturnType<typeof Client.prototype.listTools>>
      try {
        listed = await Promise.race([
          listMCPToolsInternal(
            clientId,
            cursor === undefined ? undefined : { cursor },
            { signal, timeout: timeoutMs },
          ),
          aborted,
        ])
      } finally {
        if (abortListener) signal.removeEventListener('abort', abortListener)
      }
      if (signal.aborted) throw signal.reason
      if (
        clientStates.get(clientId) !== state ||
        state.closed ||
        state.generation !== catalog.generation
      )
        return fail('generation_changed', true)
      for (const tool of listed.tools) {
        const previous = tools.get(tool.name)
        if (previous && stableHash(previous) !== stableHash(tool)) {
          tools.delete(tool.name)
          catalog.tools = [...tools.values()]
          return fail(`duplicate_tool_conflict: ${tool.name}`)
        }
        if (!previous) {
          if (tools.size >= maxTools) return fail('tool_limit')
          tools.set(tool.name, tool)
          catalog.tools.push(tool)
        }
      }
      const nextCursor = listed.nextCursor
      if (nextCursor === undefined) {
        // Replace only on a complete traversal; earlier pages retain their
        // contracts even though the vendor Client caches only its last page.
        observeOutputContracts(state, catalog.tools, true)
        catalog.complete = true
        return catalog
      }
      if (seenCursors.has(nextCursor)) return fail('cursor_loop')
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }
    return fail('page_limit')
  } catch (error) {
    if (clientStates.get(clientId) !== state || state.closed)
      return fail('connection_closed', true)
    if (state.generation !== catalog.generation)
      return fail('generation_changed', true)
    if (options.signal?.aborted) return fail('cancelled')
    if (deadline.signal.aborted) return fail('deadline_exceeded')
    return fail(
      `request_failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

export async function callMCPTool(
  clientId: string,
  ...args: McpToolCallArguments
): Promise<ToolResultOutput[]> {
  requireLegacyClient(clientId)
  return callMCPToolInternal(clientId, ...args)
}

async function callMCPToolInternal(
  clientId: string,
  ...args: McpToolCallArguments
): Promise<ToolResultOutput[]> {
  const state = clientStates.get(clientId)
  if (!state || state.closed) {
    throw new Error(`callTool: client not found with id: ${clientId}`)
  }
  const [params, resultSchema = CallToolResultSchema, options] = args
  const contract = state.outputContracts.get(params.name)
  // The vendor Client validates error structuredContent against a success
  // schema, discarding valid failure detail. Keep wire validation, and enforce
  // our generation-bound output contract only for successful peer results.
  const signal = combineRequestSignals(
    options?.signal,
    state.disconnection.signal,
  )
  const callResult = await waitForMcpRequest(
    withClientUse(state, () =>
      state.client.request({ method: 'tools/call', params }, resultSchema, {
        ...options,
        signal,
      }),
    ),
    signal,
  )
  if (state.closed || clientStates.get(clientId) !== state)
    throw new Error('MCP connection changed during tool call')
  if (contract && !callResult.isError) {
    if (callResult.structuredContent === undefined)
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Tool ${params.name} has an output schema but did not return structured content`,
      )
    contract.validator ??= jsonSchemaToZod(contract.schema)
    const parsed = contract.validator.safeParse(callResult.structuredContent)
    if (!parsed.success)
      throw new McpError(
        ErrorCode.InvalidParams,
        `Structured content does not match the tool's output schema: ${parsed.error.message}`,
      )
  }
  return mcpToolResult(callResult as CallToolResult)
}
