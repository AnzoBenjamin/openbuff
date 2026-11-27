import path from 'node:path'

import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { createHostExecutionServices, executionClock } from '../host-execution'
import {
  captureAmbientHostInputs,
  loadHostConfigSnapshot,
  nodeConfigReadFs,
} from '../host-config'
import { configureHostExecution } from './configured-host-execution'
import { captureTerminalTimeoutPolicy } from './terminal-timeout-policy'
import { joinNodeScopeCleanup } from './execution-launch'
import { joinNativeScopeCleanup } from './native-exec'

import type {
  BoundResourceFactory,
  ExecutionAdapterContext,
  Refusal,
} from '@codebuff/common/types/contracts/execution-context'
import type { CleanupResult } from '@codebuff/common/types/contracts/process-scope'
import type {
  createDirectHostExecution,
  RunHostServices,
} from '../host-execution'
import type { LspResourceFactory } from './lsp-multiplexer'

export type ConfiguredDirectHostExecutionOptions = Parameters<
  typeof createDirectHostExecution
>[0] &
  Readonly<{ mode?: 'assistant' | 'user' }>

export type ConfiguredDirectHostExecution = Readonly<{
  hostServices: RunHostServices
  executionContext: ExecutionAdapterContext
  resources: BoundResourceFactory
  lspResources: LspResourceFactory
  /** Observations from configuration setup; close also returns operation cleanup. */
  cleanup: readonly CleanupResult[]
  close(): Promise<readonly CleanupResult[]>
}>

export type ConfiguredDirectHostExecutionResult =
  | Readonly<{ ok: true; value: ConfiguredDirectHostExecution }>
  | (Refusal &
      Readonly<{
        cleanup: readonly CleanupResult[]
        setupRefusal?: Refusal
      }>)

const emptyCleanup: readonly CleanupResult[] = Object.freeze([])
const refuse = (
  refusal: Refusal,
  cleanup: readonly CleanupResult[] = emptyCleanup,
): ConfiguredDirectHostExecutionResult => Object.freeze({ ...refusal, cleanup })

/** Configured outer host operation with an owned, joinable execution lifetime. */
export async function createConfiguredDirectHostExecution(
  options: ConfiguredDirectHostExecutionOptions,
): Promise<ConfiguredDirectHostExecutionResult> {
  const timeoutPolicy = captureTerminalTimeoutPolicy(
    options.terminalTimeoutPolicy,
  )
  if (!timeoutPolicy.ok) return refuse(timeoutPolicy)
  options = Object.freeze({
    ...options,
    terminalTimeoutPolicy: timeoutPolicy.value,
    env: options.env && Object.freeze({ ...options.env }),
    profile:
      options.profile &&
      Object.freeze({
        ...options.profile,
        required: Object.freeze([...options.profile.required]),
        ...(options.profile.optional
          ? { optional: Object.freeze([...options.profile.optional]) }
          : {}),
      }),
  })
  const clock = options.nativeExecution?.clock ?? executionClock
  // Configuration reads and calibration consume this original root budget.
  const boundary = captureRootDeadline({
    clock,
    limit: options.limit ?? { kind: 'unbounded' },
  })
  if (!boundary.ok) return refuse(boundary)
  const inputs =
    options.hostConfiguration ??
    captureAmbientHostInputs({
      cwd: path.resolve(options.cwd),
      projectRoot: path.resolve(options.projectRoot ?? options.cwd),
    })
  const captured = loadHostConfigSnapshot({
    inputs,
    fs: options.configReadFs ?? nodeConfigReadFs,
  })
  if (captured.status !== 'complete')
    return refuse({ ok: false, reason: 'unavailable', cause: captured.cause })
  const snapshot = captured.snapshot
  const completion = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, completion.signal])
    : completion.signal
  const configured = await configureHostExecution({
    snapshot,
    clock,
    boundary: boundary.value,
    signal,
    profile: options.profile,
    nativeExecution: options.nativeExecution,
    spawnSource: options.spawn,
  })
  if (!configured.ok) {
    completion.abort(new Error('Direct host setup refused'))
    return refuse(
      configured,
      'cleanup' in configured ? configured.cleanup : emptyCleanup,
    )
  }
  const configuration = configured.value
  const services = createHostExecutionServices({
    ...options,
    snapshot,
    clock,
    boundary: boundary.value,
    childInheritanceEnvironment: Object.freeze({
      ...snapshot.inputs.environment,
    }),
    signal,
    profile: configuration.profile,
    nativeExecution: configuration.nativeExecution,
    spawn: configuration.spawn ?? options.spawn,
  })
  if (!services.ok) {
    completion.abort(new Error('Direct host setup refused'))
    configuration.close()
    return refuse(services, configuration.cleanup)
  }
  const hostServices = services.value
  let closing: Promise<readonly CleanupResult[]> | undefined
  function close(): Promise<readonly CleanupResult[]> {
    if (closing) return closing
    // Publish the join before abort listeners can reenter close.
    closing = Promise.resolve()
      .then(() => {
        const event = hostServices.events[0]
        const hostContextId = event
          ? 'facts' in event
            ? event.facts.hostContextId
            : event.hostContextId
          : ''
        return Promise.allSettled([
          joinNodeScopeCleanup(hostContextId),
          joinNativeScopeCleanup(hostContextId),
        ])
      })
      .then((results) => {
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        )
        if (errors.length)
          throw new AggregateError(
            errors,
            'Direct host process cleanup join failed',
          )
        return Object.freeze([
          ...configuration.cleanup,
          ...results.flatMap((result) =>
            result.status === 'fulfilled' ? result.value : [],
          ),
        ])
      })
      .finally(() => configuration.close())
    completion.abort(new Error('Direct host execution scope completed'))
    return closing
  }
  const direct = hostServices.directOperation({
    mode: options.mode ?? 'assistant',
    signal: options.signal,
  })
  if (!direct.ok) return refuse(direct, await close())
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      hostServices,
      ...direct.value,
      cleanup: configuration.cleanup,
      close,
    }),
  })
}
