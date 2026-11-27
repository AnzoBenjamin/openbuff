import { expect, test } from 'bun:test'
import type { ProviderConfigFileInput } from '@openbuff/sdk'
import {
  runProviderDiagnostics,
  type ProviderDiagnostic,
} from '../provider-diagnostics'
import {
  clearAgentRouteOverride,
  validateCustomOpenbuffProvider,
} from '../openbuff-provider'

test('provider draft validation uses persisted config rules and names the invalid field', () => {
  const valid = {
    id: 'custom',
    type: 'openai-compatible' as const,
    baseURL: 'https://example.test/v1',
    apiKeyEnv: 'CUSTOM_KEY',
    models: ['model'],
  }
  expect(validateCustomOpenbuffProvider(valid)).toBeNull()
  expect(validateCustomOpenbuffProvider({ ...valid, id: '-bad' })?.field).toBe(
    'id',
  )
  expect(
    validateCustomOpenbuffProvider({ ...valid, baseURL: 'not-a-url' })?.field,
  ).toBe('baseURL')
  expect(
    validateCustomOpenbuffProvider({ ...valid, apiKeyEnv: 'bad-key' })?.field,
  ).toBe('apiKeyEnv')
  expect(
    validateCustomOpenbuffProvider({ ...valid, baseURL: 'http://example.test' })
      ?.field,
  ).toBe('baseURL')
})

test('hung check does not withhold successful rows; cancellation settles and suppresses late updates', async () => {
  const controller = new AbortController()
  const rows: ProviderDiagnostic[] = []
  let late: (result: { ok: boolean; message: string }) => void = () => {}
  const run = runProviderDiagnostics({
    ids: ['hung', 'one', 'two', 'queued'],
    signal: controller.signal,
    concurrency: 3,
    check: async (id) =>
      id === 'hung'
        ? new Promise((resolve) => {
            late = resolve
          })
        : { ok: true, message: id },
    onResult: (row) => rows.push(row),
  })
  await Bun.sleep(5)
  expect(
    rows.filter((row) => row.state === 'succeeded').map((row) => row.id),
  ).toEqual(['one', 'two', 'queued'])
  controller.abort()
  await run
  const before = rows.length
  late({ ok: true, message: 'late' })
  await Bun.sleep(5)
  expect(rows.length).toBe(before)
  expect(
    rows.some((row) => row.id === 'hung' && row.state === 'succeeded'),
  ).toBe(false)
})

test('clearing an override restores inheritance and preserves other settings', () => {
  const config: ProviderConfigFileInput = {
    defaultModel: 'provider/default',
    agents: { reviewer: 'provider/review', helper: 'provider/helper' },
    agentReasoningEfforts: {
      reviewer: 'high' as const,
      helper: 'low' as const,
    },
  }
  clearAgentRouteOverride(config, 'reviewer')
  expect(config).toEqual({
    defaultModel: 'provider/default',
    agents: { helper: 'provider/helper' },
    agentReasoningEfforts: { helper: 'low' },
  })
})
