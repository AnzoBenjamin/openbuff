import { afterAll, expect, test } from 'bun:test'
import { appendFileSync } from 'node:fs'

const output = process.env.OPENBUFF_FILE_PICKER_DIAGNOSTIC
if (!output) throw new Error('Missing owned diagnostic output')
let fetches = 0
globalThis.fetch = Object.assign(async () => {
  fetches++
  throw new Error('File-picker diagnostic refused external fetch')
}, { preconnect() {} }) as typeof fetch

// Match the failing integration's published SDK import and source mock seam.
const { OpenbuffClient } = await import('@openbuff/sdk')
const { setupE2eMocks, teardownE2eMocks } = await import('../../../../../../sdk/e2e/utils/e2e-mocks')
const { default: picker } = await import('../../../../../../agents/file-explorer/file-picker')
const { default: lister } = await import('../../../../../../agents/file-explorer/file-lister')

const projectFiles = {
  'src/index.ts': 'export const main = true\n',
  'src/services/user-service.ts': 'export class UserService {}\n',
  'src/services/auth-service.ts': 'export class AuthService {}\n',
  'package.json': '{"name":"file-picker-diagnostic"}',
}

afterAll(() => {
  teardownE2eMocks()
  expect(fetches).toBe(0)
})

test.each([false, true])('spawned file-lister explicit model: %s', async (explicitModel) => {
  setupE2eMocks()
  const messages: string[] = []
  const record = (data: unknown, message?: string) => {
    if (typeof data === 'string') messages.push(data)
    if (message) messages.push(message)
    if (data && typeof data === 'object' && 'error' in data) {
      const error = data.error
      messages.push(error instanceof Error ? error.message : String(error))
    }
  }
  const events: unknown[] = []
  const client = new OpenbuffClient({
    cwd: '/tmp/openbuff-file-picker-diagnostic-project',
    projectFiles,
    agentDefinitions: [picker, explicitModel ? { ...lister, model: 'anthropic/claude-haiku-4.5' } : lister] as never,
    logger: { debug: record, info: record, warn: record, error: record },
  })
  const run = await client.run({
    agent: picker.id,
    prompt: 'Find files related to user authentication',
    handleEvent: event => { events.push(event) },
  })
  appendFileSync(output, JSON.stringify({ explicitModel, output: run.output, messages, events, fetches }) + '\n')
  if (explicitModel) {
    expect(JSON.stringify(run.output)).toContain('src/services/user-service.ts')
    expect(JSON.stringify(run.output)).toContain('src/services/auth-service.ts')
  } else {
    expect(run.output).toEqual({ type: 'structuredOutput', value: null })
    expect(messages.join('\n')).toContain('No model configured')
  }
})
