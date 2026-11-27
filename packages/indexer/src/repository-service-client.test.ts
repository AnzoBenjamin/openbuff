import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEmbeddedIndexStorage } from './embedded-storage'
import { openRepositoryServiceStorage } from './repository-service-client'
import type { IndexStoragePort } from './storage-port'

const executable = path.resolve(
  import.meta.dir,
  '../../../rust/target/debug/openbuff-intelligence',
)
const root = await mkdtemp(path.join(tmpdir(), 'openbuff-port-'))
afterAll(() => rm(root, { recursive: true, force: true }))
const scope = { repositoryId: 'repo-a', worktreeId: 'worktree-a' }

async function contract(store: IndexStoragePort) {
  const missing = { scope, table: 'files', key: 'missing' }
  expect(await store.get(missing)).toBeNull()
  const first = await store.batch({
    checks: [{ ...missing, expectedVersion: null }],
    puts: [
      ...['a', 'b', 'c'].map((key) => ({
        scope,
        table: 'files',
        key,
        value: { path: key, unicode: '借入' },
      })),
      {
        scope: { ...scope, worktreeId: '@objects' },
        table: 'objects',
        key: 'blob',
        value: 'shared',
      },
    ],
  })
  expect(first.committed).toBe(true)
  const a = await store.get({ scope, table: 'files', key: 'a' })
  expect(a?.value).toEqual({ path: 'a', unicode: '借入' })
  expect(
    await store.get({
      scope: { ...scope, repositoryId: 'repo-b' },
      table: 'files',
      key: 'a',
    }),
  ).toBeNull()
  expect(
    await store.get({
      scope: { ...scope, worktreeId: 'worktree-b' },
      table: 'files',
      key: 'a',
    }),
  ).toBeNull()
  const failed = await store.batch({
    checks: [{ scope, table: 'files', key: 'a', expectedVersion: 'wrong' }],
    puts: [{ scope, table: 'files', key: 'z', value: 1 }],
  })
  expect(failed).toMatchObject({ committed: false, writes: 0 })
  expect(await store.get({ scope, table: 'files', key: 'z' })).toBeNull()
  const page = await store.query({
    scope,
    table: 'files',
    keys: ['0-missing', 'a', 'b', 'c'],
    limit: 2,
  })
  expect(page.records.map((r) => r.key)).toEqual(['a', 'b'])
  expect(page.cursor).toBe('b')
  expect(
    (
      await store.query({ scope, table: 'files', after: page.cursor, limit: 2 })
    ).records.map((r) => r.key),
  ).toEqual(['c'])
  const results = await Promise.all(
    [1, 2].map((value) =>
      store.batch({
        checks: [
          { scope, table: 'files', key: 'a', expectedVersion: a!.version },
        ],
        puts: [{ scope, table: 'files', key: 'a', value }],
      }),
    ),
  )
  expect(results.filter((r) => r.committed)).toHaveLength(1)
  expect((await store.stats()).records).toBe(4)
}

describe('repository storage port parity', () => {
  test('embedded SQLite supports scope isolation, paging and atomic CAS', async () => {
    const store = await createEmbeddedIndexStorage({
      directory: path.join(root, 'embedded'),
      identity: { ...scope, projectRoot: root },
    })
    try {
      await contract(store)
    } finally {
      await store.close()
    }
  })
  test.skipIf(!existsSync(executable) || process.platform === 'win32')(
    'Rust supports the same contract and restart recovery',
    async () => {
      const directory = path.join(root, 'native')
      await mkdir(directory, { mode: 0o700 })
      let child = spawn(executable, ['--serve', directory], { stdio: 'ignore' })
      const wait = async () => {
        for (
          let i = 0;
          i < 100 && !existsSync(path.join(directory, 'service.sock'));
          i++
        )
          await new Promise((r) => setTimeout(r, 20))
      }
      let store: IndexStoragePort | undefined
      try {
        await wait()
        store = await openRepositoryServiceStorage({ directory, executable })
        await contract(store)
        await store.close()
        store = undefined
        child.kill()
        await new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        )
        await rm(path.join(directory, 'service.sock'), { force: true })
        child = spawn(executable, ['--serve', directory], { stdio: 'ignore' })
        await wait()
        store = await openRepositoryServiceStorage({ directory, executable })
        expect((await store.stats()).records).toBe(4)
        expect(
          await store.get({
            scope: { ...scope, worktreeId: '@objects' },
            table: 'objects',
            key: 'blob',
          }),
        ).toMatchObject({ value: 'shared' })
      } finally {
        await store?.close()
        child.kill()
      }
    },
    15_000,
  )
  test('rejects a symlinked service directory before launch', async () => {
    await mkdir(path.join(root, 'target'), { mode: 0o700 })
    await symlink(path.join(root, 'target'), path.join(root, 'link'))
    await expect(
      openRepositoryServiceStorage({
        directory: path.join(root, 'link'),
        executable,
      }),
    ).rejects.toThrow('not private')
  })
})
