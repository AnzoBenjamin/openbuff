import { describe, expect, test } from 'bun:test'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { createHostExecutionServices } from '../host-execution'
import { loadHostConfigSnapshot } from '../host-config'
import { getAgentRuntimeImpl } from '../impl/agent-runtime'

function runtime(environment: Record<string, string | undefined>) {
  const captured = loadHostConfigSnapshot({
    inputs: { environment, platform: 'linux', invocationCwd: '/virtual/project', projectRoot: '/virtual/project',
      home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' },
      trust: { ancestorConfig: false, projectReadableRoots: false } },
    fs: { readFile: () => { throw new Error('Unexpected config read') },
      stat: () => { throw new Error('Unexpected stat') },
      readDirectory: () => { throw new Error('Unexpected directory read') }, realpath: path => path },
  })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const clock = { domainId: 'captured-client-env-fixture', nowMs: () => 100 }
  const boundary = captureRootDeadline({ clock, limit: { kind: 'unbounded' } })
  if (!boundary.ok) throw new Error(boundary.cause)
  const host = createHostExecutionServices({ snapshot: captured.snapshot, clock, boundary: boundary.value,
    childInheritanceEnvironment: {}, inheritEnv: false })
  if (!host.ok) throw new Error(host.cause)
  return getAgentRuntimeImpl({ ...TEST_AGENT_RUNTIME_IMPL, apiKey: 'fixture', clientEnv: undefined,
    processSupervision: false, hostServices: host.value })
}

describe('captured SDK client environment', () => {
  test('an empty captured environment uses established literal local defaults', () => {
    expect(runtime({}).clientEnv).toEqual({
      NEXT_PUBLIC_CB_ENVIRONMENT: 'dev',
      NEXT_PUBLIC_CODEBUFF_APP_URL: 'http://localhost:3000',
      NEXT_PUBLIC_OPENBUFF_APP_URL: undefined,
      NEXT_PUBLIC_SUPPORT_EMAIL: 'support@openbuff.local',
      NEXT_PUBLIC_POSTHOG_API_KEY: 'openbuff-local',
      NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://app.posthog.com',
      NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID: undefined,
    })
  })

  test('captured overrides and optional values remain isolated across runtime instances', () => {
    const environment = {
      NEXT_PUBLIC_CB_ENVIRONMENT: 'prod' as const,
      NEXT_PUBLIC_CODEBUFF_APP_URL: 'https://captured.example',
      NEXT_PUBLIC_OPENBUFF_APP_URL: 'https://optional.example',
      NEXT_PUBLIC_SUPPORT_EMAIL: 'support@captured.example',
      NEXT_PUBLIC_POSTHOG_API_KEY: 'captured-key',
      NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://telemetry.example',
      NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID: 'captured-verification',
    }
    const first = runtime(environment)
    environment.NEXT_PUBLIC_SUPPORT_EMAIL = 'changed@example.com'
    expect(first.clientEnv.NEXT_PUBLIC_SUPPORT_EMAIL).toBe('support@captured.example')
    expect(first.clientEnv).toEqual({ ...environment, NEXT_PUBLIC_SUPPORT_EMAIL: 'support@captured.example' })
    expect(runtime({ NEXT_PUBLIC_CB_ENVIRONMENT: undefined }).clientEnv.NEXT_PUBLIC_CB_ENVIRONMENT).toBe('dev')
    expect(runtime({}).clientEnv.NEXT_PUBLIC_OPENBUFF_APP_URL).toBeUndefined()
  })

  test('explicit invalid captured values still fail validation', () => {
    expect(() => runtime({ NEXT_PUBLIC_CODEBUFF_APP_URL: '' })).toThrow()
    expect(() => runtime({ NEXT_PUBLIC_CB_ENVIRONMENT: 'invalid' })).toThrow()
  })
})
