import {
  callMCPTool,
  captureMcpConfig,
  closeMCPClient,
  getCapturedMCPClient,
  getMCPClientGeneration,
  getMediatedMCPClient,
  listMCPToolCatalog,
  resolveMCPConfigOrigin,
} from '@codebuff/common/mcp/client'
import { allowedLoopbackMcpFromEnv } from '@codebuff/common/mcp/dns-pinning'
import { credentialRoster } from '../host-config'
import { ExecutionRefusalError } from './execution-launch'
import { raceAbort } from '../tools/concurrency'

import type { CapturedMcpConfig } from '@codebuff/common/mcp/client'
import type { MediatedMcpRequest } from '@codebuff/common/mcp/request'
import type { BoundResourcePort, DestinationHandle, ExecutionAdapterContext, HostAuthority, LifetimeHandle, TargetDescription } from '@codebuff/common/types/contracts/execution-context'
import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ExecutionScope } from '../host-execution'
import type { HostConfigSnapshot } from '../host-config'

/** A private per-run catalog of captured destinations and owned resources. */
export function createRunMcpExecution(options: Readonly<{
  snapshot: HostConfigSnapshot
  authority: HostAuthority
  rootLifetime: LifetimeHandle
  spawn: CodebuffSpawn
}>) {
  const captures = new WeakMap<MCPConfig, CapturedMcpConfig>()
  const destinations = new WeakMap<CapturedMcpConfig, DestinationHandle>()
  const resources = new WeakMap<ExecutionScope, WeakMap<CapturedMcpConfig, Map<string, BoundResourcePort>>>()
  const clients = new Set<string>()
  const registeredRootSignal = options.authority.signal(options.rootLifetime)
  if (!registeredRootSignal.ok) throw new ExecutionRefusalError(registeredRootSignal)
  const rootSignal = registeredRootSignal.value
  let disposed = false
  const roster = new Set(credentialRoster(options.snapshot).map(name =>
    options.snapshot.inputs.platform === 'win32' ? name.toUpperCase() : name))
  const allowedLoopbackMcp = allowedLoopbackMcpFromEnv(options.snapshot.inputs.environment)

  function capture(config: MCPConfig): CapturedMcpConfig {
    let captured = captures.get(config)
    if (!captured) {
      captured = captureMcpConfig(config, { origin: resolveMCPConfigOrigin(config),
        environment: options.snapshot.inputs.environment, allowedLoopbackMcp })
      captures.set(config, captured)
    }
    return captured
  }

  async function request(config: MCPConfig, scope: ExecutionScope, context: ExecutionAdapterContext): Promise<MediatedMcpRequest> {
    if (disposed) throw new ExecutionRefusalError({ ok: false, reason: 'cancelled', cause: 'Run-owned MCP scope is closed' })
    const registration = options.authority.actionRegistration(context.execution)
    if (!registration.ok) throw new ExecutionRefusalError(registration)
    const scopeBinding = options.authority.bindAction({ ...registration.value, owner: scope.owner })
    if (!scopeBinding.ok) throw new ExecutionRefusalError(scopeBinding)
    const signal = context.signal ? AbortSignal.any([registration.value.signal, context.signal]) : registration.value.signal
    signal.throwIfAborted()
    const captured = capture(config)
    const resolved = captured.resolved
    if (resolved.type !== 'stdio') {
      const id = await raceAbort(getCapturedMCPClient(captured, { signal: rootSignal }), signal)
      clients.add(id)
      if (disposed) {
        await closeMCPClient(id)
        throw new ExecutionRefusalError({ ok: false, reason: 'cancelled', cause: 'Run-owned MCP scope is closed' })
      }
      return Object.freeze({ id, get generation() { return getMCPClientGeneration(id) },
        listToolCatalog: (catalogOptions = {}) => listMCPToolCatalog(id, { ...catalogOptions,
          signal: catalogOptions.signal ? AbortSignal.any([catalogOptions.signal, signal]) : signal }),
        callTool: (...args) => {
          const [params, schema, callOptions] = args
          return callMCPTool(id, params, schema, { ...callOptions,
            signal: callOptions?.signal ? AbortSignal.any([callOptions.signal, signal]) : signal })
        },
        release() {},
      } satisfies MediatedMcpRequest)
    }
    let owned = resources.get(scope)
    if (!owned) { owned = new WeakMap(); resources.set(scope, owned) }
    let variants = owned.get(captured)
    if (!variants) { variants = new Map(); owned.set(captured, variants) }
    const variant = JSON.stringify([context.mode, context.profile, context.projectRoot, context.allowedPaths])
    let resource = variants.get(variant)
    if (!resource) {
      let destination = destinations.get(captured)
      if (!destination) {
        const registered = options.authority.registerDestination({ snapshotId: options.snapshot.snapshotId, origin: captured.origin,
          resolved: { kind: 'mcp-stdio', command: resolved.command, args: resolved.args, declaredEnv: resolved.env } })
        if (!registered.ok) throw new ExecutionRefusalError(registered)
        destination = registered.value
        destinations.set(captured, destination)
      }
      const values = Object.fromEntries(Object.entries(resolved.env).filter(([name]) =>
        roster.has(options.snapshot.inputs.platform === 'win32' ? name.toUpperCase() : name)))
      const delegation = captured.origin !== 'client' && Object.keys(values).length > 0
        ? options.authority.registerDelegation({ destination, snapshotId: options.snapshot.snapshotId, origin: captured.origin,
            purpose: 'explicit-mcp-credential-environment', expiresUnder: scope.lifetime, values, permittedOwners: [scope.owner] })
        : undefined
      if (delegation && !delegation.ok) throw new ExecutionRefusalError(delegation)
      const target: TargetDescription = { executable: resolved.command, argv: resolved.args,
        cwd: options.snapshot.inputs.projectRoot, projectRoot: context.projectRoot, allowedPaths: context.allowedPaths,
        mode: context.mode, profile: context.profile, processType: 'BACKGROUND', family: 'mcp-stdio', branchId: 'mcp.initial-connect',
        environmentOverlay: resolved.env, ...(delegation?.ok ? { delegation: delegation.value } : {}),
        adapterOptions: { runtime: 'node', stdio: 'pipe', shell: false } }
      const registered = scope.resources(target, destination)
      if (!registered.ok) throw new ExecutionRefusalError(registered)
      resource = registered.value
      variants.set(variant, resource)
    }
    const access = await getMediatedMCPClient(captured, { resource, execution: context.execution, signal, spawn: options.spawn })
    clients.add(access.id)
    if (disposed) {
      access.release()
      await closeMCPClient(access.id)
      throw new ExecutionRefusalError({ ok: false, reason: 'cancelled', cause: 'Run-owned MCP scope is closed' })
    }
    return access
  }
  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    const results = await Promise.allSettled([...clients].map(id => closeMCPClient(id)))
    clients.clear()
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
  return Object.freeze({ capture, request, dispose })
}
