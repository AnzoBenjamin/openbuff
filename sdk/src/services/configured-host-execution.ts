import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isExecutionDeadlineSignal } from '@codebuff/common/util/execution-context'
import {
  createHostExecutionServices,
  defaultExecutionProfile,
} from '../host-execution'
import { getCapturedProviderConfig } from '../host-config'
import {
  admitNodeLaunch,
  dispatchNodeLaunch,
  joinNodeScopeCleanup,
  prepareNodeLaunch,
} from './execution-launch'
import { calibrateNativeClock, verifyNativeInstallation } from './native-exec'

import type {
  Clock,
  ProfileRequest,
  Refusal,
  Result,
  RootDeadlineSeed,
} from '@codebuff/common/types/contracts/execution-context'
import type { CleanupResult } from '@codebuff/common/types/contracts/process-scope'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { HostConfigSnapshot } from '../host-config'
import type { NativeHostExecution } from './native-host-execution'
import type { NodeDispatchHandle } from './execution-launch'

type ConfiguredExecution = Readonly<{
  profile?: ProfileRequest
  nativeExecution?: NativeHostExecution
  spawn?: CodebuffSpawn
  cleanup: readonly CleanupResult[]
  close(): void
}>
export type ConfiguredExecutionResult =
  | Result<ConfiguredExecution>
  | (Refusal &
      Readonly<{ cleanup: readonly CleanupResult[]; setupRefusal?: Refusal }>)

const denied = (cause: string): Refusal => ({
  ok: false,
  reason: 'denied',
  cause,
})

/** Setup owns an original-root child budget and joins its processes on every return. */
export async function configureHostExecution(
  options: Readonly<{
    snapshot: HostConfigSnapshot
    boundary: RootDeadlineSeed
    clock: Clock
    signal?: AbortSignal
    profile?: ProfileRequest
    nativeExecution?: NativeHostExecution
    spawnSource?: CodebuffSpawn | Promise<CodebuffSpawn>
  }>,
): Promise<ConfiguredExecutionResult> {
  const declaration = getCapturedProviderConfig(options.snapshot).config
    .execution
  const empty: ConfiguredExecution = Object.freeze({
    profile: options.profile,
    nativeExecution: options.nativeExecution,
    cleanup: Object.freeze([]),
    close() {},
  })
  // Explicit SDK injection is already owned by the caller. Configuration is
  // relevant only when it supplies an otherwise missing profile/installation.
  if (
    !declaration ||
    options.profile !== undefined ||
    options.nativeExecution !== undefined
  )
    return { ok: true, value: empty }
  if (!options.snapshot.executionOrigin?.trusted)
    return denied(
      'Execution configuration must be declared in the captured user-global directory or the exact explicitly selected file',
    )
  const profile = options.profile ?? declaration.profile
  if (profile.preferredBackend !== 'native-exec' || options.nativeExecution)
    return { ok: true, value: Object.freeze({ ...empty, profile }) }
  if (!declaration.native)
    return denied('Selected native execution has no installation declaration')

  const stop = new AbortController()
  const originalRootRefusal = (): Refusal | undefined => {
    if (options.signal?.aborted)
      return {
        ok: false,
        reason: isExecutionDeadlineSignal(options.signal)
          ? 'deadline-exhausted'
          : 'cancelled',
        cause: 'Native setup original caller signal ended',
      }
    if (
      options.boundary.deadline.kind === 'finite' &&
      options.clock.nowMs() >= options.boundary.deadline.expiresAtMs
    )
      return {
        ok: false,
        reason: 'deadline-exhausted',
        cause: 'Native setup original root deadline exhausted',
      }
    return undefined
  }
  const portableProfile = Object.freeze({
    ...defaultExecutionProfile,
    policy: 'full-access' as const,
  })
  const setup = createHostExecutionServices({
    snapshot: options.snapshot,
    boundary: options.boundary,
    clock: options.clock,
    childInheritanceEnvironment: {},
    inheritEnv: false,
    env: { LANG: 'C', LC_ALL: 'C' },
    signal: options.signal
      ? AbortSignal.any([options.signal, stop.signal])
      : stop.signal,
    profile: portableProfile,
    authorizeAsync: async (input) => {
      const target = input.target
      return input.facts.correlation.kind === 'host-operation' &&
        target.executable === '/proc/self/fd/5' &&
        target.argv.length === 2 &&
        target.argv[0] === 'version' &&
        target.argv[1] === '--json' &&
        target.family === 'diagnostic-build-version-scip' &&
        target.processType === 'SYNC' &&
        target.cwd === options.snapshot.inputs.projectRoot &&
        target.shellCommandBytes === undefined &&
        target.environmentOverlay === undefined &&
        target.delegation === undefined &&
        target.adapterOptions.shell === false &&
        target.adapterOptions.detached === true &&
        target.adapterOptions.nativeVersionArtifactSha256 ===
          declaration.native!.artifact.sha256
        ? { ok: true, basis: 'explicit-policy', decisionId: randomUUID() }
        : denied('Native setup permits only the held artifact version probe')
    },
    authorizeSync: () =>
      denied(
        'Native setup requires its exact asynchronous version authorization',
      ),
  })
  if (!setup.ok) return setup
  const services = setup.value
  let installation: NativeHostExecution['installation'] | undefined
  let result: Result<Omit<ConfiguredExecution, 'cleanup' | 'close'>>
  let cleanup: readonly CleanupResult[] = []
  try {
    const operation = services.directOperation({
      limit: { kind: 'finite', durationMs: 2000 },
      profile: portableProfile,
    })
    if (!operation.ok) throw operation
    const context = operation.value.executionContext
    const setupSignal = context.signal
    if (!setupSignal)
      throw denied('Native setup has no registered operation signal')
    let removeAbort = () => {}
    const abort = new Promise<never>((_, reject) => {
      const refuse = () =>
        reject({
          ok: false,
          reason: originalRootRefusal()?.reason ?? 'unavailable',
          cause:
            'Native setup dependency did not resolve before its original operation ended',
        })
      if (setupSignal.aborted) refuse()
      else {
        setupSignal.addEventListener('abort', refuse, { once: true })
        removeAbort = () => setupSignal.removeEventListener('abort', refuse)
      }
    })
    const source: CodebuffSpawn | Promise<CodebuffSpawn> =
      options.spawnSource !== undefined
        ? options.spawnSource
        : (command, args = [], spawnOptions) =>
            nodeSpawn(command, [...args], spawnOptions ?? {})
    const spawn = await Promise.race([Promise.resolve(source), abort]).finally(
      removeAbort,
    )
    if (typeof spawn !== 'function')
      throw denied('Native setup spawn dependency is not callable')
    setupSignal.throwIfAborted()
    const verified = verifyNativeInstallation(declaration.native)
    if (!verified.ok) throw verified
    installation = verified.value
    const prepared = prepareNodeLaunch({
      executionContext: context,
      executable: '/proc/self/fd/5',
      argv: ['version', '--json'],
      cwd: options.snapshot.inputs.projectRoot,
      family: 'diagnostic-build-version-scip',
      branchId: 'host.native-calibration',
      adapterOptions: {
        shell: false,
        detached: true,
        stdio: 'descriptor-version',
        nativeVersionArtifactSha256: installation.artifact.sha256,
      },
    })
    if (!prepared.ok) throw prepared
    const admitted = await admitNodeLaunch(prepared.value)
    if (!admitted.ok) throw admitted
    let dispatchedHandle: NodeDispatchHandle | undefined
    const calibrated = await calibrateNativeClock(
      installation,
      options.clock,
      (fd) => {
        const dispatched = dispatchNodeLaunch(admitted.value, (input) =>
          spawn(input.executable, [...input.argv], {
            cwd: input.cwd,
            env: input.env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', fd],
          }),
        )
        if (dispatched.ok) dispatchedHandle = dispatched.value
        return dispatched.ok
          ? { ok: true, value: dispatched.value.child }
          : dispatched
      },
      setupSignal,
    )
    if (!calibrated.ok) throw calibrated
    if (!dispatchedHandle)
      throw denied('Native setup has no owned dispatched process')
    const started = await dispatchedHandle.started
    if (!started.ok) throw started
    const setupDeadline = prepared.value.facts().deadlines.resourceLifetime
    if (
      setupSignal.aborted ||
      (setupDeadline.kind === 'finite' &&
        options.clock.nowMs() >= setupDeadline.expiresAtMs)
    )
      throw {
        ok: false,
        reason: 'deadline-exhausted',
        cause: 'Native setup operation expired before calibration acceptance',
      }
    result = {
      ok: true,
      value: {
        profile,
        spawn,
        nativeExecution: Object.freeze({
          installation,
          mapping: calibrated.value,
          clock: options.clock,
          runtimePaths: Object.freeze([...declaration.native.runtimePaths]),
          network: declaration.native.network,
          landlock: declaration.native.landlock,
        }),
      },
    }
  } catch (error) {
    const reportedReason =
      error &&
      typeof error === 'object' &&
      'ok' in error &&
      error.ok === false &&
      'reason' in error
        ? (error as Refusal).reason
        : 'unavailable'
    const reason =
      originalRootRefusal()?.reason ??
      (reportedReason === 'deadline-exhausted' ? 'unavailable' : reportedReason)
    result = {
      ok: false,
      reason,
      cause:
        error && typeof error === 'object' && 'cause' in error
          ? String(error.cause)
          : error instanceof Error
            ? error.message
            : String(error),
    }
  } finally {
    stop.abort(new Error('Native host setup completed'))
    const event = services.events[0]
    const hostId = event
      ? 'facts' in event
        ? event.facts.hostContextId
        : event.hostContextId
      : ''
    cleanup = Object.freeze([...(await joinNodeScopeCleanup(hostId))])
  }
  const originalRefusal = originalRootRefusal()
  const setupRefusal = !result.ok ? result : undefined
  if (originalRefusal) result = originalRefusal
  if (cleanup.some((observation) => observation.status !== 'complete')) {
    installation?.close()
    return Object.freeze({
      ok: false,
      reason: result.ok ? 'unavailable' : result.reason,
      cause: result.ok
        ? 'Native setup process cleanup remains unconfirmed'
        : result.cause,
      cleanup,
      ...(originalRefusal && setupRefusal ? { setupRefusal } : {}),
    })
  }
  if (!result.ok) {
    installation?.close()
    return Object.freeze({
      ...result,
      cleanup,
      ...(originalRefusal && setupRefusal ? { setupRefusal } : {}),
    })
  }
  const ownedInstallation = installation
  return {
    ok: true,
    value: Object.freeze({
      ...result.value,
      cleanup,
      close() {
        ownedInstallation?.close()
      },
    }),
  }
}
