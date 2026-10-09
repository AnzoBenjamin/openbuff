import { createHash } from 'crypto'
import { isIP } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import {
  allowedLoopbackMcpFromEnv,
  createPinnedMcpFetch,
  isAllowedLoopbackMcpAuthority,
  resolvePinnedMcpAddress,
} from './dns-pinning'

import type { MCPConfig, MCPConfigOrigin } from '../types/mcp'
import type { ToolResultOutput } from '../types/messages/content-part'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  BlobResourceContents,
  CallToolResult,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js'

const runningClients: Record<string, Client> = {}
const listToolsCache: Record<
  string,
  ReturnType<typeof Client.prototype.listTools>
> = {}

/**
 * Hard cap on concurrently live MCP clients. Each registry entry holds an
 * OPEN transport (a spawned stdio process or a kept-alive HTTP connection),
 * so an unbounded registry leaks processes/file descriptors for the process
 * lifetime. Eviction is LRU-by-registration: the oldest registered id is
 * dropped (with its listTools cache entry) when the cap is exceeded.
 */
const maxRunningClients = 64

/** Insertion-ordered registry keys mirroring runningClients, for LRU eviction. */
const runningClientOrder = new Set<string>()

/**
 * In-flight connect promises memoized per cache identity (the same key
 * runningClients uses). Concurrent getMCPClient calls for one config share
 * ONE connect instead of racing two transports; the memo is cleared when the
 * promise settles, so a rejected connect is retried by the next call.
 */
const pendingConnects = new Map<string, Promise<string>>()

function registerRunningClient(key: string): void {
  runningClientOrder.add(key)
  while (runningClientOrder.size > maxRunningClients) {
    const oldest = runningClientOrder.values().next()
    if (oldest.done || oldest.value === key) break
    runningClientOrder.delete(oldest.value)
    delete runningClients[oldest.value]
    // listTools cache entries are keyed `${clientId}\0${argsHash}` (see
    // listMCPTools), so eviction must sweep every per-args entry belonging to
    // the evicted client rather than a single bare-clientId key.
    const evictedPrefix = `${oldest.value}\0`
    for (const cacheKey of Object.keys(listToolsCache)) {
      if (cacheKey.startsWith(evictedPrefix)) delete listToolsCache[cacheKey]
    }
  }
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
function substituteEnvInValue(value: string): string {
  const missing: string[] = []
  const result = value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, varName) => {
    const envValue = process.env[varName]
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
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = substituteEnvInValue(value)
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
 * Recognizes a host written entirely as numeric IPv4 components — decimal
 * ('2130706433', '127.1'), hex ('0x7f.0.0.1'), or octal ('0177.0.0.1') — the
 * non-dotted forms that net.isIP does not recognize but that URL parsers and
 * resolvers interpret as IPv4 addresses.
 */
function isNumericIpv4Candidate(host: string): boolean {
  return host
    .split('.')
    .every(
      (component) =>
        /^\d+$/.test(component) || /^0[xX][0-9a-fA-F]+$/.test(component),
    )
}

/**
 * Parses one component of a numeric IPv4 encoding. Accepts decimal ('10'),
 * hex ('0x7f'), and octal ('0177', per inet_aton leading-zero semantics);
 * returns null for a malformed component (e.g. the invalid octal '008').
 */
function parseIpv4NumericComponent(component: string): number | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(component)) {
    const value = parseInt(component, 16)
    return Number.isInteger(value) ? value : null
  }
  if (/^0[0-9]+$/.test(component)) {
    // A leading zero makes the component octal; digits outside 0-7 are
    // malformed rather than decimal.
    if (!/^[0-7]+$/.test(component.slice(1))) {
      return null
    }
    const value = parseInt(component, 8)
    return Number.isInteger(value) ? value : null
  }
  if (/^\d+$/.test(component)) {
    const value = parseInt(component, 10)
    return Number.isInteger(value) ? value : null
  }
  return null
}

/**
 * Canonicalizes a numeric IPv4 host written in a non-dotted or shorthand
 * form into the standard dotted-quad string, following inet_aton semantics:
 * all but the last component are single bytes and the last component carries
 * the remaining bytes ('127.1' -> 127.0.0.1, '2130706433' -> 127.0.0.1).
 * Returns null when the host is not a valid numeric IPv4 encoding.
 */
function canonicalizeIpv4Shorthand(host: string): string | null {
  const components = host.split('.')
  if (components.length > 4) {
    return null
  }
  const values: number[] = []
  for (const component of components) {
    const value = parseIpv4NumericComponent(component)
    if (value === null) {
      return null
    }
    values.push(value)
  }
  // The last component spans (5 - components.length) bytes of the address;
  // every earlier component is a single byte.
  const lastMultiplier = 256 ** (5 - components.length)
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] > 255) {
      return null
    }
  }
  const last = values[values.length - 1]
  if (last >= lastMultiplier) {
    return null
  }
  let address = 0
  for (let i = 0; i < values.length - 1; i++) {
    address = address * 256 + values[i]
  }
  address = address * lastMultiplier + last
  return [
    (address >>> 24) & 255,
    (address >>> 16) & 255,
    (address >>> 8) & 255,
    address & 255,
  ].join('.')
}

/**
 * True for a private/loopback/link-local/metadata address that a client-origin
 * (untrusted protocol peer, NEW-1) MCP server must not be allowed to reach.
 *
 * Synchronous and dependency-free (node:net only): it does NOT perform DNS
 * resolution, so a bare unresolved hostname that is not one of the blocked
 * suffixes/names returns false. DNS-rebinding hardening is a separate concern
 * (noted for P1-T2). Non-dotted/shorthand numeric IPv4 encodings
 * ('2130706433', '127.1', '0x7f.0.0.1', '0177.0.0.1') are canonicalized and
 * re-checked before the hostname fallback, and a malformed numeric host fails
 * closed. This mirrors the IPv4/IPv6 private-range shape of agent-runtime's
 * web-search-utils, re-implemented locally because common cannot depend on
 * packages/agent-runtime.
 */
export function isBlockedMcpAddress(host: string): boolean {
  const kind = isIP(host)
  if (kind === 4) {
    return isBlockedIpv4(host)
  }
  if (kind === 6) {
    return isBlockedIpv6(host)
  }
  // Non-dotted/shorthand numeric IPv4 encodings are not recognized by isIP
  // but resolve to IPv4 addresses when used as URL hosts. Canonicalize and
  // re-check; a numeric host that fails canonicalization is malformed and
  // fails closed (blocked).
  if (isNumericIpv4Candidate(host)) {
    const canonical = canonicalizeIpv4Shorthand(host)
    return canonical === null ? true : isBlockedIpv4(canonical)
  }
  // Non-IP host: block loopback/metadata names and internal suffixes.
  const lower = host.toLowerCase()
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === 'metadata' ||
    lower === 'metadata.google.internal'
  )
}

function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p))
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    // Malformed input reaching this synchronous guard fails closed.
    return true
  }
  const [a, b, c] = parts
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
  if (a >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false
}

function isBlockedIpv6(host: string): boolean {
  const lower = host.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) defers to the IPv4 rule.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) {
    return isBlockedIpv4(mapped[1])
  }
  const firstHextet = lower.split(':')[0]
  if (firstHextet) {
    const value = parseInt(firstHextet, 16)
    if (!Number.isNaN(value)) {
      if ((value & 0xfe00) === 0xfc00) return true // fc00::/7 (unique-local, fc/fd)
      if ((value & 0xffc0) === 0xfe80) return true // fe80::/10 (link-local)
      if ((value & 0xff00) === 0xff00) return true // ff00::/8 (multicast)
    }
  }
  return false
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
): ResolvedMCPConfigValues {
  const substitute = originAllowsEnvSubstitution(origin)
  if (config.type === 'stdio') {
    return {
      type: 'stdio',
      command: config.command,
      args: [...config.args],
      env: substitute ? substituteEnvInRecord(config.env) : { ...config.env },
    }
  }
  if (config.type === 'http' || config.type === 'sse') {
    return {
      type: config.type,
      url: config.url,
      params: { ...config.params },
      headers: substitute
        ? substituteEnvInRecord(config.headers)
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
  if (key in runningClients) {
    return key
  }

  // Double-connect race: concurrent getMCPClient calls for the SAME config
  // identity share one in-flight connect promise instead of each building a
  // transport (previously both raced, and the loser's transport/client was
  // discarded while its socket/process stayed open). The memo entry is
  // cleared when the promise settles, so a REJECTED connect is retried by
  // the next call rather than served from a poisoned memo.
  const pending = pendingConnects.get(key)
  if (pending) {
    return pending
  }
  const connectPromise = connectMCPClient(
    config,
    origin,
    allowedLoopbackMcp,
    key,
  ).finally(() => {
    pendingConnects.delete(key)
  })
  pendingConnects.set(key, connectPromise)
  return connectPromise
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
  config: MCPConfig,
  origin: MCPConfigOrigin,
  allowedLoopbackMcp: readonly string[] | undefined,
  key: string,
): Promise<string> {
  const resolved = resolveMCPConfigValues(config, origin)
  let transport: Transport
  if (resolved.type === 'stdio') {
    transport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      stderr: 'ignore',
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
      !isAllowedLoopbackMcpAuthority(
        hostname,
        url.port,
        allowedLoopbackMcp,
      )
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

  await client.connect(transport)
  runningClients[key] = client
  registerRunningClient(key)

  return key
}

export function listMCPTools(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.listTools>
): ReturnType<typeof Client.prototype.listTools> {
  const client = runningClients[clientId]
  if (!client) {
    throw new Error(`listTools: client not found with id: ${clientId}`)
  }
  // The cache is keyed per (client, serialized call args), not per client:
  // two listTools calls with different arguments (e.g. a no-args listing and
  // a cursor-paged one) have different responses, so an entry cached for one
  // call shape must never be replayed for another. Distinct keys also mean
  // the rejection deletion below fires for the exact call that failed instead
  // of being masked by an entry cached under different args.
  const cacheKey = `${clientId}\0${stableHash(args)}`
  if (!listToolsCache[cacheKey]) {
    const pending = client.listTools(...args)
    listToolsCache[cacheKey] = pending
    // A REJECTED listTools must not poison the cache forever: drop the entry
    // once the failure settles so the next call retries against the
    // (possibly recovered) client instead of replaying the cached rejection.
    void pending.catch(() => {
      if (listToolsCache[cacheKey] === pending) {
        delete listToolsCache[cacheKey]
      }
    })
  }
  return listToolsCache[cacheKey]
}

function getResourceData(
  resource: TextResourceContents | BlobResourceContents,
): string {
  if ('text' in resource) return resource.text as string
  if ('blob' in resource) return resource.blob as string
  return ''
}

export async function callMCPTool(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.callTool>
): Promise<ToolResultOutput[]> {
  const client = runningClients[clientId]
  if (!client) {
    throw new Error(`callTool: client not found with id: ${clientId}`)
  }
  const callResult = await client.callTool(...args)
  const result = callResult as CallToolResult
  const content = result.content

  return content.map((c: (typeof content)[number]) => {
    if (c.type === 'text') {
      return {
        type: 'json',
        value: c.text,
      } satisfies ToolResultOutput
    }
    if (c.type === 'audio') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'image') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'resource') {
      return {
        type: 'media',
        data: getResourceData(c.resource),
        mediaType: c.resource.mimeType ?? 'text/plain',
      } satisfies ToolResultOutput
    }
    const fallbackValue =
      'uri' in c && typeof (c as { uri: unknown }).uri === 'string'
        ? (c as { uri: string }).uri
        : JSON.stringify(c)
    return {
      type: 'json',
      value: fallbackValue,
    } satisfies ToolResultOutput
  })
}
