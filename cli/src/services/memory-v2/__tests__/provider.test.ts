import { describe, expect, test } from 'bun:test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BunSQLiteMemoryRepository } from '../bun-sqlite-memory-repository'
import { ProjectMemoryV2Provider } from '../provider'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function repository(root: string): Promise<BunSQLiteMemoryRepository> {
  const opened = await BunSQLiteMemoryRepository.open({ repositoryRoot: root })
  if (opened.status === 'error') throw new Error(opened.error.message)
  return opened.repository
}

function countCloses(repo: BunSQLiteMemoryRepository) {
  let closes = 0
  const close = repo.close.bind(repo)
  repo.close = async () => { closes++; await close() }
  return () => closes
}

const shadow = { requested: 'shadow-v2', effective: 'shadow-v2' } as const
const optIn = { requested: 'sqlite-v2-opt-in', effective: 'sqlite-v2-opt-in' } as const

describe('ProjectMemoryV2Provider', () => {
  test('deduplicates opener while returning two independent leases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openbuff-memory-provider-dedup-'))
    const repo = await repository(root)
    let calls = 0
    const provider = new ProjectMemoryV2Provider(async () => {
      calls++
      return { status: 'ok', repository: repo }
    })
    const [first, second] = await Promise.all([provider.open(root, shadow), provider.open(root, shadow)])
    expect(calls).toBe(1)
    expect(first.status).toBe('available')
    expect(second.status).toBe('available')
    expect(first).not.toBe(second)
    if (first.status === 'available' && second.status === 'available') {
      expect(first.repository).toBe(second.repository)
      expect(first.release).not.toBe(second.release)
      expect(String(first.projectId)).toMatch(/^project:/)
      await first.release()
      await second.release()
    }
    await provider.close()
  })

  test('retirement waits for both active leases and closes exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openbuff-memory-provider-leases-'))
    const repo = await repository(root)
    const closes = countCloses(repo)
    const provider = new ProjectMemoryV2Provider(async () => ({ status: 'ok', repository: repo }))
    const first = await provider.open(root, shadow)
    const second = await provider.open(root, shadow)
    if (first.status !== 'available' || second.status !== 'available') throw new Error('expected leases')
    await provider.close()
    expect(closes()).toBe(0)
    await first.release()
    await first.release()
    expect(closes()).toBe(0)
    await second.release()
    await second.release()
    await provider.close()
    expect(closes()).toBe(1)
  })

  test('root and authority switches retire leased repositories until release', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'openbuff-memory-provider-first-'))
    const secondRoot = mkdtempSync(join(tmpdir(), 'openbuff-memory-provider-second-'))
    const repos = [await repository(firstRoot), await repository(secondRoot), await repository(secondRoot)]
    const closes = repos.map(countCloses)
    const provider = new ProjectMemoryV2Provider(async () => ({ status: 'ok', repository: repos.shift()! }))
    const first = await provider.open(firstRoot, shadow)
    const second = await provider.open(secondRoot, shadow)
    expect(closes[0]!()).toBe(0)
    if (first.status === 'available') await first.release()
    expect(closes[0]!()).toBe(1)
    const third = await provider.open(secondRoot, optIn)
    expect(closes[1]!()).toBe(0)
    if (second.status === 'available') await second.release()
    expect(closes[1]!()).toBe(1)
    await provider.close()
    expect(closes[2]!()).toBe(0)
    if (third.status === 'available') await third.release()
    expect(closes[2]!()).toBe(1)
  })

  test('pending open reset never publishes and closes exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openbuff-memory-provider-race-'))
    const gate = deferred<{ status: 'ok'; repository: BunSQLiteMemoryRepository }>()
    const repo = await repository(root)
    const closes = countCloses(repo)
    const provider = new ProjectMemoryV2Provider(() => gate.promise)
    const opening = provider.open(root, shadow)
    await provider.close()
    gate.resolve({ status: 'ok', repository: repo })
    expect(await opening).toMatchObject({ status: 'unavailable', reason: 'reset-during-open' })
    expect(closes()).toBe(1)
  })

  test('opener failure remains retryable and clean reopen succeeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openbuff-memory-provider-retry-'))
    const repo = await repository(root)
    let calls = 0
    const provider = new ProjectMemoryV2Provider(async () => {
      calls++
      return calls === 1
        ? { status: 'error' as const, error: { kind: 'busy' as const, message: 'busy', retryable: true } }
        : { status: 'ok' as const, repository: repo }
    })
    expect(await provider.open(root, shadow)).toMatchObject({ status: 'unavailable', retryable: true })
    const reopened = await provider.open(root, shadow)
    expect(reopened.status).toBe('available')
    expect(calls).toBe(2)
    if (reopened.status === 'available') await reopened.release()
    await provider.close()
  })

  test('opt-in failure remains opt-in with project id while shadow falls back', async () => {
    const provider = new ProjectMemoryV2Provider(async () => ({
      status: 'error',
      error: { kind: 'io', message: '/secret/database.sqlite', retryable: false },
    }))
    const opted = await provider.open('/project', optIn)
    expect(opted).toMatchObject({ status: 'unavailable', effectiveAuthority: 'sqlite-v2-opt-in' })
    if (opted.status === 'unavailable') {
      expect(opted.projectId).toBeDefined()
      expect(opted.degradation).toContain('V1 remains disabled')
      expect(opted.degradation).not.toContain('/secret')
    }
    expect(await provider.open('/project', shadow)).toMatchObject({ status: 'unavailable', effectiveAuthority: 'json-v1' })
  })

  test('json-v1 and invalid authority never invoke SQLite', async () => {
    let calls = 0
    const provider = new ProjectMemoryV2Provider(async () => {
      calls++
      throw new Error('must not open')
    })
    expect(await provider.open('/project', { requested: 'json-v1', effective: 'json-v1' })).toMatchObject({ status: 'unavailable', effectiveAuthority: 'json-v1' })
    expect(await provider.open('/project', { requested: 'bad', effective: 'json-v1', reason: 'invalid-authority' })).toMatchObject({ status: 'unavailable', reason: 'invalid-authority' })
    expect(calls).toBe(0)
  })
})
