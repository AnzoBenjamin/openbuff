import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import {
  archiveEvictedToolResults,
  archivePreCompaction,
} from '@codebuff/agent-runtime/util/context-archive'
import {
  openBunSQLiteMemoryRepository,
  type BunSQLiteMemoryRepository,
} from '../bun-sqlite-memory-repository'

const owned: string[] = []
const stores: BunSQLiteMemoryRepository[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const dir of owned.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const text = (i: number) =>
  `RESULT-${String(i).padStart(3, '0')}\n${'x'.repeat(32_748)}\nTAIL-${String(i).padStart(3, '0')}`
const archive = (runId: string, at: number, count = 1) => {
  const state = { ...getInitialAgentState(), runId }
  archiveEvictedToolResults(
    state,
    Array.from({ length: count }, (_, i) => ({
      toolCallId: `result-${i}`,
      toolName: 'read_files',
      content: [
        {
          type: 'json' as const,
          value: text(i).replace(
            'xxxx',
            runId === 'old' ? 'oooo' : runId === 'new' ? 'nnnn' : 'xxxx',
          ),
        },
      ],
      stepIndex: i,
    })),
    at,
  )
  archivePreCompaction(
    state,
    state.compactionArchive![0].messages.map(
      (message) =>
        ({
          ...message,
          content: [{ type: 'json', value: '[pointer]' }],
        }) as never,
    ),
    'semantic_compaction',
    0,
    at + 1,
  )
  // This test only uses the original snapshot; real-pointer shadowing is covered by the runtime fixture.
  state.compactionArchive = state.compactionArchive!.slice(0, 1)
  return {
    runId,
    snapshots: state.compactionArchive,
    bodies: state.contextArchiveBodies,
  }
}
async function open(options: Record<string, unknown> = {}, dir?: string) {
  const root = dir ?? mkdtempSync(path.join(tmpdir(), 'openbuff-b13-store-'))
  if (!dir) owned.push(root)
  const result = await openBunSQLiteMemoryRepository({
    repositoryRoot: root,
    ...options,
  })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error(JSON.stringify(result))
  stores.push(result.repository)
  return { root, repository: result.repository }
}

describe('B13 normalized original archive policy', () => {
  it('persists 30 distinct originals, reopens, and pages the exact hash and tail', async () => {
    const now = Date.now(),
      { root, repository } = await open()
    const request = archive('source-run', now, 30)
    const saved = await repository.persistContextArchiveSnapshots(request)
    expect(saved.status).toBe('ok')
    expect(saved.retention?.retainedBodies).toBe(30)
    await repository.close()
    const reopened = (await open({}, root)).repository
    for (let i = 0; i < 30; i++) {
      let offsetBytes = 0,
        recovered = '',
        sha256: string | undefined
      do {
        const page = await reopened.readContextArchiveBodyPage({
          toolCallId: `result-${i}`,
          sourceRunId: 'source-run',
          offsetBytes,
          maxBytes: 4096,
          expectedSha256: sha256,
        })
        expect(page.status).toBe('ok')
        if (page.status !== 'ok') throw new Error(JSON.stringify(page))
        recovered += page.text
        sha256 ??= page.sha256
        expect(page.utf8Bytes).toBe(32_768)
        if (page.nextOffset === null) break
        expect(page.nextOffset).toBeGreaterThan(offsetBytes)
        offsetBytes = page.nextOffset
      } while (true)
      expect(recovered).toBe(text(i))
    }
    expect(
      (
        await reopened.readContextArchiveBodyPage({
          toolCallId: 'result-0',
          expectedSha256: '0'.repeat(64),
        })
      ).status,
    ).toBe('corrupt')
    const database = new Database(reopened.databasePath, { readonly: true })
    expect(
      (database.query('PRAGMA user_version').get() as { user_version: number })
        .user_version,
    ).toBe(7)
    expect(
      (
        database
          .query(
            'SELECT count(*) count FROM context_archive_bodies WHERE instr(body,?1)>0',
          )
          .get('x'.repeat(1000)) as { count: number }
      ).count,
    ).toBe(0)
    database.close()
  })
  it('discloses quota cutoff and an old envelope cannot resurrect a removed original', async () => {
    const now = Date.now(),
      { repository } = await open({
        contextArchiveRetention: { mode: 'rolling', maxBytes: 50_000 },
      })
    const first = archive('old', now, 1),
      second = archive('new', now + 1, 1)
    expect(
      (await repository.persistContextArchiveSnapshots(first)).status,
    ).toBe('ok')
    const saved = await repository.persistContextArchiveSnapshots(second)
    expect(saved.retention?.status).toBe('cutoff')
    expect(saved.retention!.logicalBytes).toBeLessThanOrEqual(50_000)
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'result-0',
          sourceRunId: 'old',
        })
      ).status,
    ).toBe('expired')
    await repository.persistContextArchiveSnapshots(first)
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'result-0',
          sourceRunId: 'old',
        })
      ).status,
    ).toBe('expired')
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'result-0',
          sourceRunId: 'new',
        })
      ).status,
    ).toBe('ok')
  })
  it('expiry includes the current run and protected overflow refuses atomically', async () => {
    let now = Date.now()
    const { repository } = await open({
      contextArchiveRetention: {
        mode: 'rolling',
        ttlMs: 100,
        maxBytes: 50_000,
      },
      contextArchiveNow: () => now,
    })
    const request = archive('current', now)
    expect(
      (await repository.persistContextArchiveSnapshots(request)).status,
    ).toBe('ok')
    now += 200
    expect(
      (await repository.loadContextArchiveSnapshots({ runId: 'current' }))
        .snapshots,
    ).toEqual([])
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'result-0',
          sourceRunId: 'current',
        })
      ).status,
    ).toBe('expired')
    const pinned = archive('pinned', now)
    pinned.snapshots![0].pinned = true
    expect(
      (await repository.persistContextArchiveSnapshots(pinned)).status,
    ).toBe('ok')
    const excessive = archive('excessive', now + 1, 2)
    excessive.snapshots![0].pinned = true
    const refused = await repository.persistContextArchiveSnapshots(excessive)
    expect(refused.retention?.status).toBe('retention-capacity')
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'result-0',
          sourceRunId: 'pinned',
        })
      ).status,
    ).toBe('ok')
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'result-0',
          sourceRunId: 'excessive',
        })
      ).status,
    ).toBe('missing')
  })
  it('source-run ambiguity, Unicode cursors, conflicting originals and corruption fail closed', async () => {
    const now = Date.now(),
      { repository } = await open()
    const one = archive('one', now),
      two = archive('two', now + 1)
    expect((await repository.persistContextArchiveSnapshots(one)).status).toBe(
      'ok',
    )
    expect((await repository.persistContextArchiveSnapshots(two)).status).toBe(
      'ok',
    )
    expect(
      (await repository.readContextArchiveBodyPage({ toolCallId: 'result-0' }))
        .status,
    ).toBe('ambiguous')
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'result-0',
          sourceRunId: 'foreign',
        })
      ).status,
    ).toBe('missing')
    const state = { ...getInitialAgentState(), runId: 'unicode' }
    archiveEvictedToolResults(
      state,
      [
        {
          toolCallId: 'unicode-call',
          toolName: 'read_files',
          content: [{ type: 'json', value: 'A🙂€B' }],
          stepIndex: 3,
        },
      ],
      now + 2,
    )
    expect(
      (
        await repository.persistContextArchiveSnapshots({
          runId: 'unicode',
          snapshots: state.compactionArchive!,
          bodies: state.contextArchiveBodies,
        })
      ).status,
    ).toBe('ok')
    const page = await repository.readContextArchiveBodyPage({
      toolCallId: 'unicode-call',
      maxBytes: 5,
    })
    expect(page).toMatchObject({
      status: 'ok',
      text: 'A🙂',
      startByte: 0,
      endByte: 5,
      nextOffset: 5,
    })
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'unicode-call',
          offsetBytes: 2,
        })
      ).status,
    ).toBe('invalid-cursor')
    const changed = { ...getInitialAgentState(), runId: 'one' }
    archiveEvictedToolResults(
      changed,
      [
        {
          toolCallId: 'result-0',
          toolName: 'read_files',
          content: [{ type: 'json', value: 'conflicting original' }],
          stepIndex: 0,
        },
      ],
      now + 3,
    )
    const refused = await repository.persistContextArchiveSnapshots({
      runId: 'one',
      snapshots: changed.compactionArchive!,
      bodies: changed.contextArchiveBodies,
    })
    expect(refused.persisted).toBe(0)
    expect(refused.status).toBe('degraded')
    expect(
      await repository.readContextArchiveBodyPage({
        toolCallId: 'result-0',
        sourceRunId: 'one',
        maxBytes: 10,
      }),
    ).toMatchObject({ status: 'ok', text: 'RESULT-000' })
    const database = new Database(repository.databasePath)
    database
      .query(
        'UPDATE context_archive_original_bodies SET text=?1 WHERE body_id=?2',
      )
      .run('corrupt', Object.keys(state.contextArchiveBodies!)[0])
    database.close()
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'unicode-call',
        })
      ).status,
    ).toBe('corrupt')
  })

  it('new pointer timestamps cannot renew an original TTL, while an explicit pin protects its closure', async () => {
    let now = Date.now()
    const { repository } = await open({
      contextArchiveRetention: { mode: 'rolling', ttlMs: 1000 },
      contextArchiveNow: () => now,
    })
    const request = archive('owner', now)
    await repository.persistContextArchiveSnapshots(request)
    const pointer = structuredClone(request.snapshots![0])
    pointer.archivedAt += 500
    pointer.provenance = pointer.provenance!.map((item) => ({
      ...item,
      kind: 'pointer' as const,
      retainedRange: undefined,
    }))
    pointer.messages = pointer.messages.map(
      (message) =>
        ({
          ...message,
          content: [{ type: 'json', value: 'pointer only' }],
        }) as never,
    )
    now += 500
    expect(
      (
        await repository.persistContextArchiveSnapshots({
          ...request,
          snapshots: [pointer],
        })
      ).status,
    ).toBe('ok')
    now = request.snapshots![0].provenance![0].capturedAt! + 1001
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'result-0',
          sourceRunId: 'owner',
        })
      ).status,
    ).toBe('expired')
    expect(
      (
        await repository.persistContextArchiveSnapshots({
          ...request,
          snapshots: [pointer],
        })
      ).persisted,
    ).toBe(0)
    const pinned = archive('protected', now)
    pinned.snapshots![0].pinned = true
    await repository.persistContextArchiveSnapshots(pinned)
    now += 2000
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'result-0',
          sourceRunId: 'protected',
        })
      ).status,
    ).toBe('ok')
  })

  it('constructor policy is captured, 4MiB quota is logical bytes, and shared originals are charged once', async () => {
    const policy = { mode: 'rolling' as const, maxBytes: 4 * 1024 * 1024 }
    const { repository } = await open({ contextArchiveRetention: policy })
    policy.maxBytes = 1
    const request = archive('quota-four-mib', Date.now(), 160)
    const saved = await repository.persistContextArchiveSnapshots(request)
    expect(saved.retention!.maxBytes).toBe(4 * 1024 * 1024)
    expect(saved.retention!.logicalBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(saved.retention!.status).toBe('cutoff')
    const { repository: shared } = await open()
    const first = archive('shared-one', Date.now()),
      second = archive('shared-two', Date.now() + 1)
    await shared.persistContextArchiveSnapshots(first)
    const once = (await shared.persistContextArchiveSnapshots(second))
      .retention!
    expect(once.retainedBodies).toBe(1)
    expect(once.retainedSnapshots).toBe(2)
    expect(once.sqliteBytes).toBeGreaterThan(0)
    expect(once.walBytes).toBeGreaterThanOrEqual(0)
  })

  it('keep-until-delete is explicitly unbounded aggregate storage, and malformed policy never opens a store', async () => {
    const { repository } = await open({
      contextArchiveRetention: { mode: 'keep-until-delete' },
    })
    const saved = await repository.persistContextArchiveSnapshots(
      archive('old-unbounded', 1),
    )
    expect(saved.retention).toMatchObject({
      mode: 'keep-until-delete',
      retainedBodies: 1,
    })
    expect(saved.retention?.maxBytes).toBeUndefined()
    expect(
      (
        await repository.readContextArchiveBodyPage({
          toolCallId: 'result-0',
          sourceRunId: 'old-unbounded',
        })
      ).status,
    ).toBe('ok')
    const result = await openBunSQLiteMemoryRepository({
      repositoryRoot: owned[0],
      contextArchiveRetention: { mode: 'rolling', maxBytes: -1 },
    })
    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.error.kind).toBe('invalid')
  })
})
