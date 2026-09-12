import { describe, expect, test } from 'bun:test'

import { ProjectIdSchema } from '@openbuff/sdk'

import {
  ManagedOpenbuffClient,
  memoryV2ClientConfigFromProvider,
} from '../codebuff-client'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const projectId = ProjectIdSchema.parse('project-test')

describe('memory V2 client ownership', () => {
  test('translates available, opt-in unavailable, shadow fallback, and json-v1 results', () => {
    const repository = {} as never
    const available = memoryV2ClientConfigFromProvider({
      status: 'available', requestedAuthority: 'sqlite-v2-opt-in', effectiveAuthority: 'sqlite-v2-opt-in',
      projectId, repository, operator: {} as never, release: async () => {},
    })
    expect(available).toMatchObject({ repository, projectId, authority: 'sqlite-v2-opt-in', mode: 'inject', capture: 'safe' })
    expect(memoryV2ClientConfigFromProvider({
      status: 'unavailable', requestedAuthority: 'sqlite-v2-opt-in', effectiveAuthority: 'sqlite-v2-opt-in',
      projectId, reason: 'storage-unavailable', degradation: 'V1 disabled', retryable: true,
    })).toEqual({ projectId, authority: 'sqlite-v2-opt-in', mode: 'inject', capture: 'safe' })
    expect(memoryV2ClientConfigFromProvider({
      status: 'unavailable', requestedAuthority: 'shadow-v2', effectiveAuthority: 'json-v1',
      reason: 'storage-unavailable', degradation: 'fallback', retryable: true,
    })).toBeUndefined()
    expect(memoryV2ClientConfigFromProvider({
      status: 'unavailable', requestedAuthority: 'json-v1', effectiveAuthority: 'json-v1',
      degradation: 'v1', retryable: false,
    })).toBeUndefined()
  })

  test('retire waits for concurrent runs and releases exactly once after success and failure', async () => {
    const first = deferred<never>()
    const second = deferred<never>()
    let calls = 0
    let releases = 0
    const client = new ManagedOpenbuffClient(
      { cwd: '/project' },
      async () => { releases++ },
      async () => (calls++ === 0 ? first.promise : second.promise),
    )
    const runOne = client.run({ agent: 'base', prompt: 'one' })
    const runTwo = client.run({ agent: 'base', prompt: 'two' })
    await client.retire()
    await client.retire()
    expect(releases).toBe(0)
    first.reject(new Error('cancelled'))
    await expect(runOne).rejects.toThrow('cancelled')
    expect(releases).toBe(0)
    second.reject(new Error('failed'))
    await expect(runTwo).rejects.toThrow('failed')
    expect(releases).toBe(1)
    await expect(client.run({ agent: 'base', prompt: 'late' })).rejects.toThrow('retired')
    await client.retire()
    expect(releases).toBe(1)
  })
})
