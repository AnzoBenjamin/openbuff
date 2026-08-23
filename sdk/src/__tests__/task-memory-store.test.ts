import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import * as nodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { stableHash } from '@codebuff/common/util/stable-hash'

import {
  collectWorkspaceMoves,
  persistRunTaskMemory,
} from '../run'
import {
  codebuffFsToNodePromises,
  loadPersistedTaskMemory,
  reconcileTaskMemoryEvidence,
  saveMergedTaskMemory,
} from '../services/task-memory-store'

import type { RunState } from '../run-state'
import type { WorkspaceJournalService } from '../services/workspace-journal'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { TaskMemoryEvidenceV1, TaskMemoryV1 } from '@codebuff/common/types/task-memory'

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function makeMemory(overrides: Partial<TaskMemoryV1> = {}): TaskMemoryV1 {
  return {
    schemaVersion: 1,
    goal: 'Test goal',
    requirements: [],
    decisions: [],
    filesInspected: [],
    editsMade: [],
    validationResults: [],
    reviewReceipts: [],
    blockers: [],
    nextActions: [],
    historicalSummary: '',
    evidence: [],
    revision: 0,
    updatedAt: 1_000,
    checksum: 'deadbeef',
    ...overrides,
  }
}

function makeEvidence(
  overrides: Partial<TaskMemoryEvidenceV1> & { id: string; path: string },
): TaskMemoryEvidenceV1 {
  return {
    kind: 'read',
    summary: `Evidence for ${overrides.path}`,
    ...overrides,
  }
}

describe('task-memory-store', () => {
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'task-memory-store-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  test('AC1: save then load+reconcile verifies fresh evidence', async () => {
    await writeFile(path.join(rootDir, 'a.ts'), 'export const a = 1')
    const memory = makeMemory({
      decisions: ['Prefer ErrorOr results'],
      evidence: [
        makeEvidence({
          id: 'ev-a',
          path: 'a.ts',
          freshnessHash: sha256('export const a = 1'),
        }),
      ],
    })
    const saved = await saveMergedTaskMemory({ rootDir, runMemory: memory })
    expect(saved).toBeDefined()

    const loaded = await loadPersistedTaskMemory({ rootDir })
    expect(loaded?.decisions).toEqual(['Prefer ErrorOr results'])
    const reconciled = await reconcileTaskMemoryEvidence({
      memory: loaded!,
      rootDir,
    })
    expect(reconciled.evidence[0]!.stale).toBe(false)
    expect(reconciled.evidence[0]!.verifiedAt).toBeDefined()
  })

  test('AC2: mutated file marks exactly its own evidence stale', async () => {
    await writeFile(path.join(rootDir, 'a.ts'), 'alpha')
    await writeFile(path.join(rootDir, 'b.ts'), 'beta')
    const memory = makeMemory({
      evidence: [
        makeEvidence({ id: 'ev-a', path: 'a.ts', freshnessHash: sha256('alpha') }),
        makeEvidence({ id: 'ev-b', path: 'b.ts', freshnessHash: sha256('beta') }),
      ],
    })
    await saveMergedTaskMemory({ rootDir, runMemory: memory })

    await writeFile(path.join(rootDir, 'b.ts'), 'beta-changed')
    const reconciled = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
    })
    expect(reconciled.evidence[0]!.stale).toBe(false)
    expect(reconciled.evidence[1]!.stale).toBe(true)
  })

  test('AC3: workspace move rebinds evidence to the destination', async () => {
    await writeFile(path.join(rootDir, 'old.ts'), 'contents')
    const memory = makeMemory({
      evidence: [
        makeEvidence({
          id: 'ev-old',
          path: 'old.ts',
          freshnessHash: sha256('contents'),
        }),
      ],
    })
    await saveMergedTaskMemory({ rootDir, runMemory: memory })

    // Rename on disk: old.ts -> nested/new.ts with identical content.
    await rm(path.join(rootDir, 'old.ts'))
    await mkdir(path.join(rootDir, 'nested'), { recursive: true })
    await writeFile(path.join(rootDir, 'nested', 'new.ts'), 'contents')

    const withoutMoves = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
    })
    expect(withoutMoves.evidence[0]!.stale).toBe(true)
    expect(withoutMoves.evidence[0]!.path).toBe('old.ts')

    const withMoves = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
      workspaceMoves: [{ from: 'old.ts', to: 'nested/new.ts' }],
    })
    expect(withMoves.evidence[0]!.stale).toBe(false)
    expect(withMoves.evidence[0]!.path).toBe('nested/new.ts')
  })

  test('chained moves rebind evidence past the first hop', async () => {
    await writeFile(path.join(rootDir, 'a.ts'), 'chained contents')
    const memory = makeMemory({
      evidence: [
        makeEvidence({
          id: 'ev-chain',
          path: 'a.ts',
          freshnessHash: sha256('chained contents'),
        }),
      ],
    })
    await saveMergedTaskMemory({ rootDir, runMemory: memory })

    // Renamed twice on disk; the journal holds a→b then b→c.
    await rm(path.join(rootDir, 'a.ts'))
    await mkdir(path.join(rootDir, 'deep'), { recursive: true })
    await writeFile(path.join(rootDir, 'deep', 'c.ts'), 'chained contents')

    const reconciled = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
      workspaceMoves: [
        { from: 'a.ts', to: 'b.ts' },
        { from: 'b.ts', to: 'deep/c.ts' },
      ],
    })
    expect(reconciled.evidence[0]!.path).toBe('deep/c.ts')
    expect(reconciled.evidence[0]!.stale).toBe(false)
  })

  test('cyclic move chains terminate on the first revisited path', async () => {
    const memory = makeMemory({
      evidence: [makeEvidence({ id: 'ev-cycle', path: 'a.ts' })],
    })
    const reconciled = await reconcileTaskMemoryEvidence({
      memory,
      rootDir,
      workspaceMoves: [
        { from: 'a.ts', to: 'b.ts' },
        { from: 'b.ts', to: 'a.ts' },
      ],
    })
    expect(reconciled.evidence[0]!.path).toBe('b.ts')
  })

  test('AC4: corrupt persisted file is ignored silently', async () => {
    const memoryPath = path.join(
      rootDir,
      '.openbuff',
      'memory',
      'task-memory.json',
    )
    await mkdir(path.dirname(memoryPath), { recursive: true })
    await writeFile(memoryPath, '{not json at all')
    const loaded = await loadPersistedTaskMemory({ rootDir })
    expect(loaded).toBeUndefined()
  })

  test('merge dedupes lists and bumps revision monotonically', async () => {
    const prior = makeMemory({
      decisions: ['Decision A', 'Decision B'],
      revision: 3,
      updatedAt: 500,
    })
    const run = makeMemory({
      decisions: ['Decision B', 'Decision C'],
      revision: 1,
    })
    const saved = await saveMergedTaskMemory({
      rootDir,
      runMemory: run,
      priorMemory: prior,
    })
    expect(saved?.decisions).toEqual(['Decision A', 'Decision B', 'Decision C'])
    expect(saved?.revision).toBe(4)

    const reloaded = await loadPersistedTaskMemory({ rootDir })
    expect(reloaded?.revision).toBe(4)
  })

  test('no run memory means no filesystem writes', async () => {
    const saved = await saveMergedTaskMemory({ rootDir })
    expect(saved).toBeUndefined()
    await expect(
      stat(path.join(rootDir, '.openbuff', 'memory', 'task-memory.json')),
    ).rejects.toThrow()
  })

  test('AC5: missing evidence file marks the entry stale and preserves its path', async () => {
    await writeFile(path.join(rootDir, 'gone.ts'), 'vanishing')
    const memory = makeMemory({
      evidence: [
        makeEvidence({
          id: 'ev-gone',
          path: 'gone.ts',
          freshnessHash: sha256('vanishing'),
        }),
      ],
    })
    await saveMergedTaskMemory({ rootDir, runMemory: memory })
    await rm(path.join(rootDir, 'gone.ts'))

    const reconciled = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
    })
    expect(reconciled.evidence[0]!.stale).toBe(true)
    expect(reconciled.evidence[0]!.path).toBe('gone.ts')
  })

  test('AC6: path-traversal evidence goes stale without reading any file', async () => {
    // Readable file OUTSIDE rootDir whose contents match the recorded
    // freshnessHash: if the lexical containment guard ever let the escape
    // through, hashing the decoy would flip this evidence fresh instead of
    // stale — so stale:true plus zero readFile calls pins the fail-closed
    // behavior rather than a mere missing-file outcome.
    const outsideDir = await mkdtemp(
      path.join(tmpdir(), 'task-memory-outside-'),
    )
    try {
      const outsideContents = 'secret outside the project root'
      const escapePath = `../${path.basename(outsideDir)}/outside.ts`
      await writeFile(path.join(outsideDir, 'outside.ts'), outsideContents)

      const readFileCalls: string[] = []
      const spyingFs = new Proxy(nodeFsPromises, {
        get(target, prop) {
          if (prop === 'readFile') {
            return async (
              ...args: Parameters<typeof nodeFsPromises.readFile>
            ) => {
              readFileCalls.push(String(args[0]))
              return nodeFsPromises.readFile(...args)
            }
          }
          return Reflect.get(target, prop)
        },
      })

      const memory = makeMemory({
        evidence: [
          makeEvidence({
            id: 'ev-escape',
            path: escapePath,
            freshnessHash: sha256(outsideContents),
          }),
        ],
      })

      const reconciled = await reconcileTaskMemoryEvidence({
        memory,
        rootDir,
        fs: spyingFs,
      })
      expect(reconciled.evidence[0]!.stale).toBe(true)
      expect(reconciled.evidence[0]!.path).toBe(escapePath)
      expect(readFileCalls).toEqual([])
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('saveMergedTaskMemory never throws on schema-invalid run memory', async () => {
    const saved = await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({ goal: 'x'.repeat(8_001) }),
    })
    expect(saved).toBeUndefined()
    await expect(
      stat(path.join(rootDir, '.openbuff', 'memory', 'task-memory.json')),
    ).rejects.toThrow()
  })

  test('persisted task-memory.json is written owner-only (mode 0o600)', async () => {
    const saved = await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory(),
    })
    expect(saved).toBeDefined()
    const stats = await stat(
      path.join(rootDir, '.openbuff', 'memory', 'task-memory.json'),
    )
    // POSIX-only: Windows stat modes do not carry reliable owner rwx bits,
    // so the 0o600 contract is asserted only where the kernel honors it.
    if (process.platform !== 'win32') {
      expect(stats.mode & 0o777).toBe(0o600)
    } else {
      expect(stats.isFile()).toBe(true)
    }
  })

  test('concurrent saves rely on unique tmp names: both persist, no tmp litter', async () => {
    const writtenPaths: string[] = []
    const spyingFs = new Proxy(nodeFsPromises, {
      get(target, prop) {
        if (prop === 'writeFile') {
          return async (
            ...args: Parameters<typeof nodeFsPromises.writeFile>
          ) => {
            writtenPaths.push(String(args[0]))
            return nodeFsPromises.writeFile(...args)
          }
        }
        return Reflect.get(target, prop)
      },
    })

    const [savedA, savedB] = await Promise.all([
      saveMergedTaskMemory({
        rootDir,
        runMemory: makeMemory({ decisions: ['Save A'] }),
        fs: spyingFs,
      }),
      saveMergedTaskMemory({
        rootDir,
        runMemory: makeMemory({ decisions: ['Save B'] }),
        fs: spyingFs,
      }),
    ])
    // Overlapping writeFile/rename sequences both completed: the unique
    // pid+uuid tmp suffix kept them from clobbering each other mid-flight.
    expect(savedA?.decisions).toEqual(['Save A'])
    expect(savedB?.decisions).toEqual(['Save B'])

    // Each save targeted its own tmp file — a fixed `.tmp` name would
    // collapse these into one colliding path.
    const tmpWrites = writtenPaths.filter((written) =>
      written.endsWith('.tmp'),
    )
    expect(tmpWrites).toHaveLength(2)
    expect(new Set(tmpWrites).size).toBe(2)

    // Exactly one record remains and no *.tmp litter survives.
    const memoryDir = path.join(rootDir, '.openbuff', 'memory')
    expect(await readdir(memoryDir)).toEqual(['task-memory.json'])
    const reloaded = await loadPersistedTaskMemory({ rootDir })
    expect(reloaded?.revision).toBe(1)
    expect(['Save A', 'Save B']).toContain(reloaded!.decisions[0])
  })

  test('missing renameFile capability degrades to a skipped save with no tmp litter', async () => {
    // Adapter without the optional renameFile capability (only the members
    // the store consumes): mirrors virtual-fs hosts that cannot rename
    // atomically.
    const codebuffFs = {
      mkdir: nodeFsPromises.mkdir.bind(nodeFsPromises),
      readFile: nodeFsPromises.readFile.bind(nodeFsPromises),
      stat: nodeFsPromises.stat.bind(nodeFsPromises),
      unlink: nodeFsPromises.unlink.bind(nodeFsPromises),
      writeFile: nodeFsPromises.writeFile.bind(nodeFsPromises),
    } as unknown as CodebuffFileSystem

    const saved = await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory(),
      fs: codebuffFsToNodePromises(codebuffFs),
    })
    expect(saved).toBeUndefined()

    // The degraded save must leave nothing behind: no persisted record and
    // no *.tmp litter from the abandoned atomic-rename attempt.
    const memoryDir = path.join(rootDir, '.openbuff', 'memory')
    expect(await readdir(memoryDir)).toEqual([])
  })

  test('oversized evidence hashing streams leading bytes instead of buffering the whole file', async () => {
    const prefix = 'b'.repeat(1_000_000)
    await writeFile(path.join(rootDir, 'huge.ts'), `${prefix}tail-beyond-cap`)

    const readFileCalls: string[] = []
    const spyingFs = new Proxy(nodeFsPromises, {
      get(target, prop) {
        if (prop === 'readFile') {
          return async (
            ...args: Parameters<typeof nodeFsPromises.readFile>
          ) => {
            readFileCalls.push(String(args[0]))
            return nodeFsPromises.readFile(...args)
          }
        }
        return Reflect.get(target, prop)
      },
    })

    const memory = makeMemory({
      evidence: [
        makeEvidence({
          id: 'ev-huge',
          path: 'huge.ts',
          freshnessHash: sha256(prefix),
        }),
      ],
    })
    const reconciled = await reconcileTaskMemoryEvidence({
      memory,
      rootDir,
      fs: spyingFs,
    })
    // Digest still honors the leading-bytes contract AND the whole-file
    // buffered read was never taken on the default node fs path.
    expect(reconciled.evidence[0]!.stale).toBe(false)
    expect(readFileCalls).toEqual([])
  })

  test('codebuffFsToNodePromises forwards host open so adapter-backed hashing streams', async () => {
    const prefix = 'c'.repeat(1_000_000)
    await writeFile(
      path.join(rootDir, 'huge-adapter.ts'),
      `${prefix}tail-beyond-cap`,
    )

    // Host carrying `open` beyond its published type — what a spread of
    // fs.promises / createNodeFileSystem() looks like — plus a readFile spy.
    const readFileCalls: string[] = []
    const hostWithOpen = new Proxy(nodeFsPromises, {
      get(target, prop) {
        if (prop === 'readFile') {
          return async (
            ...args: Parameters<typeof nodeFsPromises.readFile>
          ) => {
            readFileCalls.push(String(args[0]))
            return nodeFsPromises.readFile(...args)
          }
        }
        return Reflect.get(target, prop)
      },
    }) as unknown as CodebuffFileSystem

    const storeFs = codebuffFsToNodePromises(hostWithOpen)
    expect(typeof storeFs.open).toBe('function')

    const reconciled = await reconcileTaskMemoryEvidence({
      memory: makeMemory({
        evidence: [
          makeEvidence({
            id: 'ev-huge-adapter',
            path: 'huge-adapter.ts',
            freshnessHash: sha256(prefix),
          }),
        ],
      }),
      rootDir,
      fs: storeFs,
    })
    // Digest honors the leading-bytes contract AND the buffered whole-file
    // read was never taken on the adapter path either.
    expect(reconciled.evidence[0]!.stale).toBe(false)
    expect(readFileCalls).toEqual([])
  })

  test('adapter without open skips oversized reads instead of buffering them', async () => {
    const prefix = 'f'.repeat(1_000_000)
    await writeFile(
      path.join(rootDir, 'huge-no-open.ts'),
      `${prefix}tail-beyond-cap`,
    )

    const readFileCalls: string[] = []
    const codebuffFs = {
      mkdir: nodeFsPromises.mkdir.bind(nodeFsPromises),
      readFile: async (file: string) => {
        readFileCalls.push(String(file))
        return nodeFsPromises.readFile(file)
      },
      stat: nodeFsPromises.stat.bind(nodeFsPromises),
      unlink: nodeFsPromises.unlink.bind(nodeFsPromises),
      writeFile: nodeFsPromises.writeFile.bind(nodeFsPromises),
    } as unknown as CodebuffFileSystem

    const reconciled = await reconcileTaskMemoryEvidence({
      memory: makeMemory({
        evidence: [
          makeEvidence({
            id: 'ev-huge-no-open',
            path: 'huge-no-open.ts',
            freshnessHash: sha256(prefix),
          }),
        ],
      }),
      rootDir,
      fs: codebuffFsToNodePromises(codebuffFs),
    })
    // Fail-closed: without a partial-read primitive the multi-GB body is
    // never buffered; the unverified entry goes stale instead.
    expect(readFileCalls).toEqual([])
    expect(reconciled.evidence[0]!.stale).toBe(true)
  })

  test('batched reconciliation preserves order and per-item verdicts past one chunk', async () => {
    // Spans three chunks at the 16-per-batch concurrency cap.
    const total = 40
    const evidence: TaskMemoryEvidenceV1[] = []
    for (let index = 0; index < total; index += 1) {
      const name = `f${index}.ts`
      const contents = `content-${index}`
      await writeFile(path.join(rootDir, name), contents)
      evidence.push(
        makeEvidence({
          id: `ev-${index}`,
          path: name,
          // Odd indexes carry a mismatching hash and must flip stale even
          // when they land in later batches.
          ...(index % 2 === 1
            ? { freshnessHash: 'mismatched' }
            : { freshnessHash: sha256(contents) }),
        }),
      )
    }
    const reconciled = await reconcileTaskMemoryEvidence({
      memory: makeMemory({ evidence }),
      rootDir,
    })
    expect(reconciled.evidence.map((item) => item.id)).toEqual(
      evidence.map((item) => item.id),
    )
    reconciled.evidence.forEach((item, index) => {
      expect(item.stale).toBe(index % 2 === 1)
    })
  })

  test('AC7: oversized evidence files hash only their leading bytes', async () => {
    const prefix = 'a'.repeat(1_000_000)
    const memory = makeMemory({
      evidence: [
        makeEvidence({
          id: 'ev-big',
          path: 'big.ts',
          freshnessHash: sha256(prefix),
        }),
      ],
    })
    await writeFile(path.join(rootDir, 'big.ts'), prefix)
    const reconciled = await reconcileTaskMemoryEvidence({ memory, rootDir })
    expect(reconciled.evidence[0]!.stale).toBe(false)

    // Documented trade-off: mutations beyond the size cap do not flip
    // staleness because only the leading bytes feed the digest.
    await writeFile(path.join(rootDir, 'big.ts'), `${prefix}tail-changed`)
    const afterBeyondCap = await reconcileTaskMemoryEvidence({
      memory,
      rootDir,
    })
    expect(afterBeyondCap.evidence[0]!.stale).toBe(false)
  })
})

describe('run integration gates', () => {
  test('collectWorkspaceMoves extracts moves, maps destinations, bounds to last 64', async () => {
    const movesRoot = await mkdtemp(path.join(tmpdir(), 'workspace-moves-'))
    try {
      const moves = Array.from({ length: 70 }, (_, index) => ({
        from: `f${index}.ts`,
        to: `t${index}.ts`,
      }))
      const fakeJournal = {
        read: () => ({
          revision: 1,
          snapshotId: 'snapshot',
          updatedAt: 0,
          changes: [
            {
              revision: 1,
              source: 'test',
              occurredAt: 0,
              actions: [
                ...moves.map((move) => ({
                  action: 'move' as const,
                  path: move.from,
                  destinationPath: move.to,
                })),
                { action: 'update' as const, path: 'ignored.ts' },
              ],
            },
          ],
        }),
      } as unknown as WorkspaceJournalService

      // undefined journal yields no moves without touching storage.
      expect(collectWorkspaceMoves(undefined)).toEqual([])

      const collected = collectWorkspaceMoves(fakeJournal)
      expect(collected).toHaveLength(64)
      expect(collected[0]).toEqual({ from: 'f6.ts', to: 't6.ts' })
      expect(collected[63]).toEqual({ from: 'f69.ts', to: 't69.ts' })
    } finally {
      await rm(movesRoot, { recursive: true, force: true })
    }
  })

  test('persistRunTaskMemory persists success, skips error runs and missing memory', async () => {
    const gateRoot = await mkdtemp(path.join(tmpdir(), 'persist-gate-'))
    try {
      const persisted = await persistRunTaskMemory({
        cwd: gateRoot,
        terminalState: {
          output: { type: 'lastMessage', value: [] },
          sessionState: {
            mainAgentState: {
              taskMemory: makeMemory({ decisions: ['Keep me'] }),
            },
          },
        } as unknown as RunState,
      })
      expect(persisted?.decisions).toEqual(['Keep me'])

      // Error runs (also cancelled/aborted shape) must never write.
      const errored = await persistRunTaskMemory({
        cwd: gateRoot,
        terminalState: {
          output: { type: 'error', message: 'boom' },
          sessionState: {
            mainAgentState: {
              taskMemory: makeMemory({ decisions: ['Poison'] }),
            },
          },
        } as unknown as RunState,
      })
      expect(errored).toBeUndefined()

      // Successful run without task memory writes nothing either.
      const noMemory = await persistRunTaskMemory({
        cwd: gateRoot,
        terminalState: {
          output: { type: 'structuredOutput', value: null },
          sessionState: { mainAgentState: {} },
        } as unknown as RunState,
      })
      expect(noMemory).toBeUndefined()

      // And the error run did not overwrite the good record from above.
      const reloaded = await loadPersistedTaskMemory({ rootDir: gateRoot })
      expect(reloaded?.decisions).toEqual(['Keep me'])
    } finally {
      await rm(gateRoot, { recursive: true, force: true })
    }
  })

  test('persistRunTaskMemory routes writes through the injected run filesystem', async () => {
    const gateRoot = await mkdtemp(path.join(tmpdir(), 'persist-gate-vfs-'))
    try {
      // Minimal in-memory adapter: proves the merged record flows through
      // the injected filesystem and never reaches real disk under gateRoot.
      const files = new Map<string, string>()
      const writeFileCalls: string[] = []
      const virtualFs = {
        mkdir: async () => {},
        readFile: async (file: string) => {
          const contents = files.get(file)
          if (contents === undefined) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          }
          return Buffer.from(contents)
        },
        // CodebuffFileSystem exposes atomic renames under the optional
        // `renameFile` capability (not node's `rename`).
        renameFile: async (oldPath: string, newPath: string) => {
          const contents = files.get(oldPath)
          if (contents === undefined) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          }
          files.delete(oldPath)
          files.set(newPath, contents)
        },
        stat: async () => ({ size: 0, mode: 0o600 }),
        unlink: async (filePath: string) => {
          files.delete(filePath)
        },
        writeFile: async (filePath: string, data: string | Buffer) => {
          writeFileCalls.push(String(filePath))
          files.set(String(filePath), String(data))
        },
      } as unknown as CodebuffFileSystem

      const persisted = await persistRunTaskMemory({
        cwd: gateRoot,
        terminalState: {
          output: { type: 'lastMessage', value: [] },
          sessionState: {
            mainAgentState: {
              taskMemory: makeMemory({ decisions: ['Virtual only'] }),
            },
          },
        } as unknown as RunState,
        fs: virtualFs,
      })
      expect(persisted?.decisions).toEqual(['Virtual only'])

      // The record lives in the adapter, not on real disk under gateRoot:
      // this fails if persistRunTaskMemory ever drops back to default node fs.
      expect(writeFileCalls.length).toBeGreaterThan(0)
      await expect(
        stat(path.join(gateRoot, '.openbuff', 'memory', 'task-memory.json')),
      ).rejects.toThrow()
    } finally {
      await rm(gateRoot, { recursive: true, force: true })
    }
  })
})

describe('stableHash FNV-1a canonical vectors', () => {
  test('pins the padded 8-hex byte format shared with agent-runtime commitTaskMemory', () => {
    expect(stableHash('')).toBe('811c9dc5')
    expect(stableHash('a')).toBe('e40c292c')
    for (const sample of ['', 'a', 'hello world', 'task-memory']) {
      expect(stableHash(sample)).toMatch(/^[0-9a-f]{8}$/)
      expect(stableHash(sample)).toBe(stableHash(sample))
    }
  })
})

describe('load and reconcile edge branches', () => {
  // Self-contained rootDir: this describe sits outside the main suite's
  // beforeEach/afterEach scope.
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'task-memory-edge-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  test('loadPersistedTaskMemory rejects records whose checksum does not match', async () => {
    await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({ decisions: ['Intact'] }),
    })
    const memoryPath = path.join(
      rootDir,
      '.openbuff',
      'memory',
      'task-memory.json',
    )
    const tampered = JSON.parse(await readFile(memoryPath, 'utf8'))
    tampered.decisions = ['Tampered']
    await writeFile(memoryPath, JSON.stringify(tampered))
    expect(await loadPersistedTaskMemory({ rootDir })).toBeUndefined()
  })

  test('normalizes Windows-style separators when matching workspace moves', async () => {
    await mkdir(path.join(rootDir, 'nested'), { recursive: true })
    await writeFile(path.join(rootDir, 'nested', 'new.ts'), 'moved content')
    const memory = makeMemory({
      evidence: [
        makeEvidence({
          id: 'ev-win',
          path: 'nested\\old.ts',
          freshnessHash: sha256('moved content'),
        }),
      ],
    })
    const reconciled = await reconcileTaskMemoryEvidence({
      memory,
      rootDir,
      workspaceMoves: [{ from: 'nested/old.ts', to: 'nested/new.ts' }],
    })
    expect(reconciled.evidence[0]!.path).toBe('nested/new.ts')
    expect(reconciled.evidence[0]!.stale).toBe(false)
  })

  test('evidence without a freshnessHash is treated fresh while the file exists', async () => {
    await writeFile(path.join(rootDir, 'any.ts'), 'whatever')
    const memory = makeMemory({
      evidence: [makeEvidence({ id: 'ev-nohash', path: 'any.ts' })],
    })
    const reconciled = await reconcileTaskMemoryEvidence({ memory, rootDir })
    expect(reconciled.evidence[0]!.stale).toBe(false)
    expect(reconciled.evidence[0]!.verifiedAt).toBeDefined()
  })
})
