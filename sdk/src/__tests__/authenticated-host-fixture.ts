import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { createHostExecutionServices, executionClock } from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'

import type { Result } from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

/** Real SDK host authority for test adapters; no fabricated permits or resources. */
export function authenticatedHostFixture(root: string, options: {
  environment?: Record<string, string | undefined>
  env?: Record<string, string | undefined>
  inheritEnv?: boolean
  spawn?: CodebuffSpawn
} = {}) {
  const environment = options.environment ?? {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1',
  }
  const captured = loadHostConfigSnapshot({ fs: nodeConfigReadFs, inputs: {
    environment, platform: process.platform, invocationCwd: root, projectRoot: root,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  } })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const boundary = unwrap(captureRootDeadline({ clock: executionClock, limit: { kind: 'unbounded' } }))
  const stop = new AbortController()
  const host = unwrap(createHostExecutionServices({ snapshot: captured.snapshot, boundary,
    childInheritanceEnvironment: environment, env: options.env, inheritEnv: options.inheritEnv,
    signal: stop.signal, spawn: options.spawn, approvalMode: 'allow-all',
    profile: { policy: 'full-access', preferredBackend: 'portable-ts', required: ['exact-env'], allowBackendFallback: false },
  }))
  const direct = unwrap(host.directOperation())
  return { host, context: direct.executionContext, resources: direct.resources, lspResources: direct.lspResources,
    close: () => stop.abort(new Error('Authenticated test host disposed')) }
}
