import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import * as nodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { recordToolEvidenceInTaskMemory } from '@codebuff/agent-runtime/util/task-memory'
import { stableHash } from '@codebuff/common/util/stable-hash'

import { collectWorkspaceMoves, persistRunTaskMemory } from '../run'
import {
  codebuffFsToNodePromises,
  inspectPersistedTaskMemoryV1,
  loadPersistedTaskMemory,
  pruneStaleTaskMemoryEvidence,
  reconcileTaskMemoryEvidence,
  saveMergedTaskMemory,
} from '../services/task-memory-store'
import { changeFile } from '../tools/change-file'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { getFilesStructured } from '../tools/read-files'

import type { RunState } from '../run-state'
import type { WorkspaceJournalService } from '../services/workspace-journal'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type {
  TaskMemoryEvidenceV1,
  TaskMemoryV1,
} from '@codebuff/common/types/task-memory'

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

  test('inspector distinguishes absent, valid, invalid, and unreadable without writes', async () => {
    expect(await inspectPersistedTaskMemoryV1({ rootDir })).toEqual({
      status: 'absent',
    })

    const saved = await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory(),
    })
    if (!saved) throw new Error('expected saved memory')
    expect(await inspectPersistedTaskMemoryV1({ rootDir })).toEqual({
      status: 'valid',
      memory: saved,
    })
    const memoryPath = path.join(
      rootDir,
      '.openbuff',
      'memory',
      'task-memory.json',
    )
    await writeFile(memoryPath, '{private malformed contents')
    expect(await inspectPersistedTaskMemoryV1({ rootDir })).toEqual({
      status: 'invalid',
      reason: 'malformed-json',
    })
    await writeFile(memoryPath, JSON.stringify({ schemaVersion: 1 }))
    expect(await inspectPersistedTaskMemoryV1({ rootDir })).toEqual({
      status: 'invalid',
      reason: 'schema-invalid',
    })
    await writeFile(memoryPath, JSON.stringify({ ...saved, checksum: 'wrong' }))
    expect(await inspectPersistedTaskMemoryV1({ rootDir })).toEqual({
      status: 'invalid',
      reason: 'checksum-mismatch',
    })

    let writeCalls = 0
    const readOnlyFs = {
      readFile: async () => {
        throw Object.assign(new Error('/private/path denied'), {
          code: 'EACCES',
        })
      },
      mkdir: async () => {
        writeCalls++
      },
      rename: async () => {
        writeCalls++
      },
      stat: async () => {
        throw new Error('unused')
      },
      unlink: async () => {
        writeCalls++
      },
      writeFile: async () => {
        writeCalls++
      },
    } as unknown as import('../services/task-memory-store').TaskMemoryStoreFs
    await expect(
      inspectPersistedTaskMemoryV1({ rootDir, fs: readOnlyFs }),
    ).resolves.toEqual({
      status: 'unreadable',
      reason: 'read-failed',
    })
    expect(writeCalls).toBe(0)
    expect(
      await loadPersistedTaskMemory({ rootDir, fs: readOnlyFs }),
    ).toBeUndefined()
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
        makeEvidence({
          id: 'ev-a',
          path: 'a.ts',
          freshnessHash: sha256('alpha'),
        }),
        makeEvidence({
          id: 'ev-b',
          path: 'b.ts',
          freshnessHash: sha256('beta'),
        }),
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

  test('ancestor symlink escapes go stale without reading outside the project', async () => {
    if (process.platform === 'win32') return
    const outsideDir = await mkdtemp(
      path.join(tmpdir(), 'task-memory-symlink-outside-'),
    )
    try {
      const outsideContents = 'outside through ancestor link'
      await writeFile(path.join(outsideDir, 'secret.ts'), outsideContents)
      await symlink(outsideDir, path.join(rootDir, 'linked'))

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
      const reconciled = await reconcileTaskMemoryEvidence({
        memory: makeMemory({
          evidence: [
            makeEvidence({
              id: 'ev-ancestor-link',
              path: 'linked/secret.ts',
              freshnessHash: sha256(outsideContents),
            }),
          ],
        }),
        rootDir,
        fs: spyingFs,
      })

      expect(reconciled.evidence[0]!.stale).toBe(true)
      expect(readFileCalls).toEqual([])
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('ancestor replacement after realpath cannot redirect descriptor hashing outside', async () => {
    if (process.platform === 'win32') return
    const outsideDir = await mkdtemp(
      path.join(tmpdir(), 'task-memory-race-outside-'),
    )
    try {
      await mkdir(path.join(rootDir, 'inside'))
      await writeFile(path.join(rootDir, 'inside', 'secret.ts'), 'inside body')
      await writeFile(path.join(outsideDir, 'secret.ts'), 'outside secret')
      const linkedPath = path.join(rootDir, 'linked')
      await symlink(path.join(rootDir, 'inside'), linkedPath)
      const candidate = path.join(linkedPath, 'secret.ts')
      let replaced = false
      const racingFs = new Proxy(nodeFsPromises, {
        get(target, prop) {
          if (prop === 'realpath') {
            return async (requested: string) => {
              const resolved = await nodeFsPromises.realpath(requested)
              if (
                !replaced &&
                path.resolve(requested) === path.resolve(candidate)
              ) {
                replaced = true
                await rm(linkedPath)
                await symlink(outsideDir, linkedPath)
              }
              return resolved
            }
          }
          return Reflect.get(target, prop)
        },
      })

      const reconciled = await reconcileTaskMemoryEvidence({
        memory: makeMemory({
          evidence: [
            makeEvidence({
              id: 'ev-raced-link',
              path: 'linked/secret.ts',
              freshnessHash: sha256('outside secret'),
            }),
          ],
        }),
        rootDir,
        fs: racingFs,
      })

      expect(replaced).toBe(true)
      expect(reconciled.evidence[0]!.stale).toBe(true)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('small evidence uses bounded descriptor reads rather than pathname readFile', async () => {
    const contents = 'small stable body'
    await writeFile(path.join(rootDir, 'small.ts'), contents)
    let readFileCalls = 0
    const boundedFs = new Proxy(nodeFsPromises, {
      get(target, prop) {
        if (prop === 'readFile') {
          return async () => {
            readFileCalls++
            return Buffer.alloc(2_000_000)
          }
        }
        return Reflect.get(target, prop)
      },
    })

    const reconciled = await reconcileTaskMemoryEvidence({
      memory: makeMemory({
        evidence: [
          makeEvidence({
            id: 'ev-small-bounded',
            path: 'small.ts',
            freshnessHash: sha256(contents),
          }),
        ],
      }),
      rootDir,
      fs: boundedFs,
    })

    expect(reconciled.evidence[0]!.stale).toBe(false)
    expect(readFileCalls).toBe(0)
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

  test('concurrent saves serialize: unique tmp names, distinct monotonic revisions', async () => {
    const writtenPaths: string[] = []
    const spyingFs = {
      ...new Proxy(nodeFsPromises, {
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
      }),
      createFileExclusive: async (
        file: Parameters<typeof writeFile>[0],
        data: Parameters<typeof writeFile>[1],
      ) => {
        await writeFile(file, data, { flag: 'wx', mode: 0o600 })
      },
    }

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
    // Each save's own decision is present in its own returned record; the
    // later one also carries the earlier one's, because serialization makes
    // it merge against the committed record instead of an empty one.
    expect(savedA?.decisions).toContain('Save A')
    expect(savedB?.decisions).toContain('Save B')

    // Each save targeted its own tmp file — a fixed `.tmp` name would
    // collapse these into one colliding path.
    const tmpWrites = writtenPaths.filter((written) => written.endsWith('.tmp'))
    expect(tmpWrites).toHaveLength(2)
    expect(new Set(tmpWrites).size).toBe(2)

    // Revision uniqueness across overlapping writers: the load→revision→
    // commit section is serialized, so the second save derives its revision
    // from the first one's committed record instead of publishing the same
    // number with a different payload.
    expect([savedA!.revision, savedB!.revision].sort()).toEqual([1, 2])

    // Exactly one record remains, it carries the winning revision, and no
    // *.tmp or *.lock litter survives.
    const memoryDir = path.join(rootDir, '.openbuff', 'memory')
    expect(await readdir(memoryDir)).toEqual(['task-memory.json'])
    const reloaded = await loadPersistedTaskMemory({ rootDir })
    expect(reloaded?.revision).toBe(2)
    // The later save merged the earlier one's decisions rather than dropping
    // them, which is only possible because it read the committed record.
    expect([...reloaded!.decisions].sort()).toEqual(['Save A', 'Save B'])
  })

  test('an old live lock fails closed without stealing or committing', async () => {
    const initial = await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({ decisions: ['Initial'] }),
    })
    const memoryPath = path.join(
      rootDir,
      '.openbuff',
      'memory',
      'task-memory.json',
    )
    const lockPath = `${memoryPath}.lock`
    const owner = `${JSON.stringify({
      token: 'external-owner',
      pid: process.pid,
      createdAt: Date.now() - 60_000,
    })}\n`
    await writeFile(lockPath, owner, { flag: 'wx', mode: 0o600 })
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    const blocked = await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({ decisions: ['Must not commit'] }),
    })

    expect(blocked).toBeUndefined()
    expect(await readFile(lockPath, 'utf8')).toBe(owner)
    const reloaded = await loadPersistedTaskMemory({ rootDir })
    expect(reloaded?.revision).toBe(initial?.revision)
    expect(reloaded?.decisions).toEqual(['Initial'])
    await rm(lockPath)
  })

  test('an old orphaned lock fails closed instead of risking replacement-owner deletion', async () => {
    const memoryPath = path.join(
      rootDir,
      '.openbuff',
      'memory',
      'task-memory.json',
    )
    await mkdir(path.dirname(memoryPath), { recursive: true })
    const lockPath = `${memoryPath}.lock`
    await writeFile(
      lockPath,
      `${JSON.stringify({
        token: 'crashed-owner',
        pid: 2_147_483_647,
        createdAt: Date.now() - 60_000,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    const saved = await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({ decisions: ['Recovered'] }),
    })

    expect(saved).toBeUndefined()
    expect(await readFile(lockPath, 'utf8')).toContain('crashed-owner')
  })

  test('adapter that ignores wx cannot enter persistence without explicit exclusive create', async () => {
    let renameCalls = 0
    const unsafeAdapter = {
      mkdir: async () => {},
      readFile: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      rename: async () => {
        renameCalls++
      },
      stat: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      unlink: async () => {},
      // Deliberately accepts and ignores the wx option.
      writeFile: async () => {},
    } as unknown as import('../services/task-memory-store').TaskMemoryStoreFs

    expect(
      await saveMergedTaskMemory({
        rootDir,
        runMemory: makeMemory(),
        fs: unsafeAdapter,
      }),
    ).toBeUndefined()
    expect(renameCalls).toBe(0)
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

  test('large evidence uses a streamed whole-content hash and detects tail changes', async () => {
    const prefix = 'b'.repeat(1_000_000)
    const original = `${prefix}original-tail`
    const filePath = path.join(rootDir, 'huge.ts')
    await writeFile(filePath, original)

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
          freshnessHash: sha256(original),
        }),
      ],
    })

    const reconciled = await reconcileTaskMemoryEvidence({
      memory,
      rootDir,
      fs: spyingFs,
    })
    expect(reconciled.evidence[0]!.stale).toBe(false)
    expect(readFileCalls).toEqual([])

    await writeFile(filePath, `${prefix}changed-tail`)
    const changed = await reconcileTaskMemoryEvidence({
      memory,
      rootDir,
      fs: spyingFs,
    })
    expect(changed.evidence[0]!.stale).toBe(true)
  })

  test('codebuffFsToNodePromises forwards host open for whole-content streaming', async () => {
    const prefix = 'c'.repeat(1_000_000)
    const contents = `${prefix}tail-beyond-cap`
    await writeFile(path.join(rootDir, 'huge-adapter.ts'), contents)

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
            freshnessHash: sha256(contents),
          }),
        ],
      }),
      rootDir,
      fs: storeFs,
    })
    // The canonical whole-content digest is produced without a buffered
    // read on the adapter path.
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
    // Fail closed without declaring the evidence stale: inability to verify is
    // not proof that the file changed, and prune must preserve it.
    expect(readFileCalls).toEqual([])
    expect(reconciled.evidence[0]!.stale).not.toBe(true)
  })

  test('legacy large-file prefix hashes validate and backfill to versioned whole hashes', async () => {
    const prefix = 'p'.repeat(1_000_000)
    const contents = `${prefix}legacy-tail`
    await writeFile(path.join(rootDir, 'legacy-large.ts'), contents)
    const legacyMemory = makeMemory({
      evidence: [
        makeEvidence({
          id: 'ev-legacy-large',
          path: 'legacy-large.ts',
          freshnessHash: sha256(prefix),
        }),
      ],
    })

    const reconciled = await reconcileTaskMemoryEvidence({
      memory: legacyMemory,
      rootDir,
    })
    expect(reconciled.evidence[0]).toMatchObject({
      stale: false,
      freshnessHash: `sha256-whole:${sha256(contents)}`,
    })

    await saveMergedTaskMemory({ rootDir, runMemory: legacyMemory })
    expect(await pruneStaleTaskMemoryEvidence({ rootDir })).toEqual({
      status: 'pruned',
      removed: 0,
      remaining: 1,
    })
    const persisted = await loadPersistedTaskMemory({ rootDir })
    expect(persisted?.evidence[0]?.freshnessHash).toBe(
      `sha256-whole:${sha256(contents)}`,
    )
  })

  test('prune preserves stale large evidence when an unversioned hash does not match', async () => {
    const currentContents = `${'c'.repeat(1_000_000)}current-tail`
    await writeFile(path.join(rootDir, 'legacy-algorithm.ts'), currentContents)
    await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({
        evidence: [
          makeEvidence({
            id: 'ev-unversioned-mismatch',
            path: 'legacy-algorithm.ts',
            // Above the historical boundary, a bare digest cannot say whether
            // this mismatch reflects changed content or a legacy prefix
            // algorithm. Even an inherited stale verdict is therefore
            // insufficient authority for destructive pruning.
            freshnessHash: sha256(`${'l'.repeat(1_000_000)}legacy-tail`),
            stale: true,
          }),
        ],
      }),
    })

    const persistedBeforePrune = (await loadPersistedTaskMemory({ rootDir }))!
    const reconciled = await reconcileTaskMemoryEvidence({
      memory: persistedBeforePrune,
      rootDir,
    })
    expect(reconciled.evidence[0]?.stale).toBe(true)

    // Reconciliation truthfully reports the mismatch, but prune must not use
    // an ambiguous unversioned algorithm as sole authority to delete a present
    // file's evidence.
    expect(await pruneStaleTaskMemoryEvidence({ rootDir })).toEqual({
      status: 'pruned',
      removed: 0,
      remaining: 1,
    })
    expect((await loadPersistedTaskMemory({ rootDir }))?.evidence[0]?.id).toBe(
      'ev-unversioned-mismatch',
    )
  })

  test('unknown and malformed hash formats cannot turn inherited stale flags into prune authority', async () => {
    await writeFile(path.join(rootDir, 'unknown-format.ts'), 'contents')
    await writeFile(path.join(rootDir, 'malformed-version.ts'), 'contents')
    await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({
        evidence: [
          makeEvidence({
            id: 'ev-unknown-format',
            path: 'unknown-format.ts',
            freshnessHash: 'future-digest-format:value',
            stale: true,
          }),
          makeEvidence({
            id: 'ev-malformed-version',
            path: 'malformed-version.ts',
            freshnessHash: 'sha256-whole:not-a-valid-digest',
            stale: true,
          }),
          {
            id: 'ev-pathless-legacy',
            kind: 'read',
            summary: 'Legacy evidence without a path',
            freshnessHash: 'legacy-unknown-format',
            stale: true,
          },
        ],
      }),
    })

    expect(await pruneStaleTaskMemoryEvidence({ rootDir })).toEqual({
      status: 'pruned',
      removed: 0,
      remaining: 3,
    })
    expect(
      (await loadPersistedTaskMemory({ rootDir }))?.evidence.map(
        (item) => item.id,
      ),
    ).toEqual([
      'ev-unknown-format',
      'ev-malformed-version',
      'ev-pathless-legacy',
    ])
  })

  test('an explicit versioned mismatch authorizes pruning changed present evidence', async () => {
    await writeFile(path.join(rootDir, 'changed-versioned.ts'), 'new contents')
    await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({
        evidence: [
          makeEvidence({
            id: 'ev-versioned-mismatch',
            path: 'changed-versioned.ts',
            freshnessHash: `sha256-whole:${sha256('old contents')}`,
          }),
        ],
      }),
    })

    expect(await pruneStaleTaskMemoryEvidence({ rootDir })).toEqual({
      status: 'pruned',
      removed: 1,
      remaining: 0,
    })
    expect((await loadPersistedTaskMemory({ rootDir }))?.evidence).toEqual([])
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
          // Odd indexes carry a valid but mismatching whole-content hash and
          // must flip stale even when they land in later batches.
          ...(index % 2 === 1
            ? { freshnessHash: '0'.repeat(64) }
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

  test('AC7: the streaming boundary retains the whole-content hash contract', async () => {
    const contents = 'a'.repeat(1_000_001)
    const memory = makeMemory({
      evidence: [
        makeEvidence({
          id: 'ev-big',
          path: 'big.ts',
          freshnessHash: sha256(contents),
        }),
      ],
    })
    await writeFile(path.join(rootDir, 'big.ts'), contents)
    const reconciled = await reconcileTaskMemoryEvidence({ memory, rootDir })
    expect(reconciled.evidence[0]!.stale).toBe(false)
  })
})

describe('recorded tool evidence round trip', () => {
  // End-to-end over the REAL producer/consumer pair: a real file on disk, a
  // real read_files anchor hash (or mutation afterHash), the runtime recorder,
  // the store's save, and the store's reconcile. Both suites used to build their
  // own hashes in-test (synthetic `sha256:aaa` in agent-runtime, bare hex here),
  // so the prefix mismatch between the two packages passed both while every
  // recorded entry reconciled stale on the next session.
  let rootDir: string

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'task-memory-roundtrip-'))
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  test('a real read_files anchor hash reconciles fresh in the next session', async () => {
    // LF content: the read anchor digest is LF-normalized while the store
    // digests raw bytes, so the canonical committed form must reconcile.
    await writeFile(path.join(rootDir, 'read-me.ts'), 'export const a = 1\n')

    const readResult = await getFilesStructured({
      filePaths: ['read-me.ts'],
      cwd: rootDir,
      fs: createNodeFileSystem(),
      capabilityIssuer: { projectId: rootDir, runId: 'roundtrip-read' },
    })
    const readItem = readResult.results[0]!
    const anchorHash =
      'editAnchor' in readItem ? readItem.editAnchor?.contentHash : undefined
    expect(anchorHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    const memory = recordToolEvidenceInTaskMemory({
      toolName: 'read_files',
      callId: 'roundtrip-read-1',
      output: [{ type: 'json', value: readResult }],
    })
    const recorded = memory!.evidence.find(
      (item) => item.id === 'read:read-me.ts',
    )!
    // Stored in the store's canonical bare-hex form, so `digest ===
    // item.freshnessHash` can match.
    expect(recorded.freshnessHash).toBe(sha256('export const a = 1\n'))

    expect(
      await saveMergedTaskMemory({ rootDir, runMemory: memory }),
    ).toBeDefined()
    const reconciled = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
    })
    const reconciledRead = reconciled.evidence.find(
      (item) => item.id === 'read:read-me.ts',
    )!
    expect(reconciledRead.stale).toBe(false)
    expect(reconciledRead.verifiedAt).toBeDefined()

    // Same evidence after the file changes must flip stale, so the assertion
    // above cannot be satisfied by a hash comparison that never runs.
    await writeFile(path.join(rootDir, 'read-me.ts'), 'export const a = 2\n')
    const afterChange = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
    })
    expect(
      afterChange.evidence.find((item) => item.id === 'read:read-me.ts')!.stale,
    ).toBe(true)
  })

  test('a real mutation afterHash reconciles fresh in the next session', async () => {
    const mutation = await changeFile({
      parameters: {
        type: 'file',
        path: 'edited.ts',
        content: 'export const edited = true\n',
        expectedHash: null,
      },
      cwd: rootDir,
      fs: createNodeFileSystem(),
      capabilityIssuer: { projectId: rootDir, runId: 'roundtrip-edit' },
    })
    const mutationValue =
      mutation[0]?.type === 'json'
        ? (mutation[0].value as {
            outcome: string
            actions: Array<{ afterHash: string | null }>
          })
        : undefined
    expect(mutationValue?.outcome).toBe('applied')
    expect(mutationValue!.actions[0]!.afterHash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    )

    const memory = recordToolEvidenceInTaskMemory({
      toolName: 'str_replace',
      callId: 'roundtrip-edit-1',
      output: mutation,
    })
    const recorded = memory!.evidence.find(
      (item) => item.id === 'edit:edited.ts',
    )!
    // The mutation namespace is byte-exact rather than LF-normalized, but it is
    // stored in the same bare-hex spelling the store compares against.
    expect(recorded.freshnessHash).toBe(sha256('export const edited = true\n'))

    expect(
      await saveMergedTaskMemory({ rootDir, runMemory: memory }),
    ).toBeDefined()
    const reconciled = await reconcileTaskMemoryEvidence({
      memory: (await loadPersistedTaskMemory({ rootDir }))!,
      rootDir,
    })
    expect(
      reconciled.evidence.find((item) => item.id === 'edit:edited.ts')!.stale,
    ).toBe(false)
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

  test('persistRunTaskMemory persists success and aborted runs, skips missing memory and cwd', async () => {
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

      // Cancelled/aborted runs carry an `error` output but still learned real
      // things, and saveMergedTaskMemory merges rather than overwrites, so the
      // partial session must contribute instead of being discarded.
      const errored = await persistRunTaskMemory({
        cwd: gateRoot,
        terminalState: {
          output: { type: 'error', message: 'boom' },
          sessionState: {
            mainAgentState: {
              taskMemory: makeMemory({ decisions: ['Learned before Ctrl-C'] }),
            },
          },
        } as unknown as RunState,
      })
      expect(errored?.decisions).toContain('Learned before Ctrl-C')

      // Successful run without task memory writes nothing.
      const noMemory = await persistRunTaskMemory({
        cwd: gateRoot,
        terminalState: {
          output: { type: 'structuredOutput', value: null },
          sessionState: { mainAgentState: {} },
        } as unknown as RunState,
      })
      expect(noMemory).toBeUndefined()

      // No cwd means no store location, so nothing is written either.
      const noCwd = await persistRunTaskMemory({
        terminalState: {
          output: { type: 'lastMessage', value: [] },
          sessionState: {
            mainAgentState: {
              taskMemory: makeMemory({ decisions: ['Nowhere to go'] }),
            },
          },
        } as unknown as RunState,
      })
      expect(noCwd).toBeUndefined()

      // The merged record retains the earlier successful decision too.
      const reloaded = await loadPersistedTaskMemory({ rootDir: gateRoot })
      expect(reloaded?.decisions).toContain('Keep me')
      expect(reloaded?.decisions).toContain('Learned before Ctrl-C')
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
        createFileExclusive: async (
          filePath: string,
          data: string | Buffer,
        ) => {
          if (files.has(filePath)) {
            throw Object.assign(new Error('exists'), { code: 'EEXIST' })
          }
          files.set(filePath, String(data))
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

describe('pruneStaleTaskMemoryEvidence', () => {
  let rootDir: string
  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), 'task-mem-prune-'))
  })
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  test('drops stale entries, keeps fresh ones and paths without staleness', async () => {
    await writeFile(path.join(rootDir, 'fresh.ts'), 'fresh body')
    await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({
        evidence: [
          makeEvidence({
            id: 'ev-stale',
            path: 'gone.ts',
            freshnessHash: sha256('old body'),
          }),
          makeEvidence({
            id: 'ev-fresh',
            path: 'fresh.ts',
            freshnessHash: sha256('fresh body'),
          }),
        ],
      }),
    })

    const result = await pruneStaleTaskMemoryEvidence({ rootDir })

    expect(result).toEqual({ status: 'pruned', removed: 1, remaining: 1 })
    const reloaded = await loadPersistedTaskMemory({ rootDir })
    expect(reloaded?.evidence.map((item) => item.id)).toEqual(['ev-fresh'])
    expect(reloaded?.revision).toBeGreaterThan(0)
  })

  test('a save after a prune keeps revisions monotonic and does not resurrect pruned evidence', async () => {
    await writeFile(path.join(rootDir, 'fresh.ts'), 'fresh body')
    // Session hydrates the pre-prune record, then the prune publishes a new
    // revision behind its back.
    const hydrated = await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({
        evidence: [
          makeEvidence({
            id: 'ev-stale',
            path: 'gone.ts',
            freshnessHash: sha256('old body'),
          }),
          makeEvidence({
            id: 'ev-fresh',
            path: 'fresh.ts',
            freshnessHash: sha256('fresh body'),
          }),
        ],
      }),
    })
    const pruned = await pruneStaleTaskMemoryEvidence({ rootDir })
    expect(pruned).toEqual({ status: 'pruned', removed: 1, remaining: 1 })
    const afterPrune = (await loadPersistedTaskMemory({ rootDir }))!

    // The stale session saves using its pre-prune hydrated record as prior.
    const saved = await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({ decisions: ['Later work'] }),
      priorMemory: hydrated,
    })

    // Unique + monotonic past the prune's revision, and the dropped evidence
    // is not written back.
    expect(saved!.revision).toBeGreaterThan(afterPrune.revision)
    expect(saved!.evidence.map((item) => item.id)).toEqual(['ev-fresh'])
    const reloaded = await loadPersistedTaskMemory({ rootDir })
    expect(reloaded?.revision).toBe(saved!.revision)
    expect(reloaded?.evidence.map((item) => item.id)).toEqual(['ev-fresh'])
    expect(reloaded?.decisions).toEqual(['Later work'])
  })

  test('an end-of-run save does not resurrect evidence a mid-session prune dropped', async () => {
    // Live session: it hydrates the record, `/memory prune` runs from inside
    // that same session, and the run then saves while `runMemory.evidence`
    // still holds the pruned entry.
    await writeFile(path.join(rootDir, 'fresh.ts'), 'fresh body')
    const staleEvidence = makeEvidence({
      id: 'ev-stale',
      path: 'gone.ts',
      freshnessHash: sha256('old body'),
    })
    const freshEvidence = makeEvidence({
      id: 'ev-fresh',
      path: 'fresh.ts',
      freshnessHash: sha256('fresh body'),
    })
    const hydrated = await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({ evidence: [staleEvidence, freshEvidence] }),
    })

    expect(await pruneStaleTaskMemoryEvidence({ rootDir })).toEqual({
      status: 'pruned',
      removed: 1,
      remaining: 1,
    })

    const saved = await saveMergedTaskMemory({
      rootDir,
      // Still-hydrated session memory: it carries the pruned entry verbatim
      // plus evidence this run recorded itself.
      runMemory: makeMemory({
        evidence: [
          staleEvidence,
          freshEvidence,
          makeEvidence({ id: 'ev-new', path: 'fresh.ts' }),
        ],
      }),
      priorMemory: hydrated,
    })

    // The pruned id stays gone, while evidence the run itself produced is
    // still persisted.
    expect(saved!.evidence.map((item) => item.id)).toEqual([
      'ev-fresh',
      'ev-new',
    ])
    const reloaded = await loadPersistedTaskMemory({ rootDir })
    expect(reloaded?.evidence.map((item) => item.id)).toEqual([
      'ev-fresh',
      'ev-new',
    ])
  })

  test('workspaceMoves keep moved-file evidence instead of deleting it', async () => {
    await writeFile(path.join(rootDir, 'old.ts'), 'moved body')
    await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({
        evidence: [
          makeEvidence({
            id: 'ev-moved',
            path: 'old.ts',
            freshnessHash: sha256('moved body'),
          }),
        ],
      }),
    })
    // Renamed on disk exactly as hydration's move contract describes.
    await rm(path.join(rootDir, 'old.ts'))
    await mkdir(path.join(rootDir, 'nested'), { recursive: true })
    await writeFile(path.join(rootDir, 'nested', 'new.ts'), 'moved body')

    // With the moves supplied the entry rebinds and nothing is pruned.
    expect(
      await pruneStaleTaskMemoryEvidence({
        rootDir,
        workspaceMoves: [{ from: 'old.ts', to: 'nested/new.ts' }],
      }),
    ).toEqual({ status: 'pruned', removed: 0, remaining: 1 })
    expect(
      (await loadPersistedTaskMemory({ rootDir }))?.evidence.map(
        (item) => item.id,
      ),
    ).toEqual(['ev-moved'])

    // The successful compatibility backfill persists the rebound path and
    // versioned whole-content hash. A later prune no longer needs the journal
    // move to preserve the same evidence.
    expect(await pruneStaleTaskMemoryEvidence({ rootDir })).toEqual({
      status: 'pruned',
      removed: 0,
      remaining: 1,
    })
    expect(
      (await loadPersistedTaskMemory({ rootDir }))?.evidence[0],
    ).toMatchObject({
      id: 'ev-moved',
      path: 'nested/new.ts',
      freshnessHash: `sha256-whole:${sha256('moved body')}`,
    })
  })

  test('pruning treats evidence through an escaping ancestor symlink as stale', async () => {
    if (process.platform === 'win32') return
    const outsideDir = await mkdtemp(
      path.join(tmpdir(), 'task-memory-prune-outside-'),
    )
    try {
      const outsideContents = 'outside prune target'
      await writeFile(path.join(outsideDir, 'secret.ts'), outsideContents)
      await symlink(outsideDir, path.join(rootDir, 'linked'))
      await saveMergedTaskMemory({
        rootDir,
        runMemory: makeMemory({
          evidence: [
            makeEvidence({
              id: 'ev-prune-link',
              path: 'linked/secret.ts',
              freshnessHash: sha256(outsideContents),
            }),
          ],
        }),
      })

      expect(await pruneStaleTaskMemoryEvidence({ rootDir })).toEqual({
        status: 'pruned',
        removed: 1,
        remaining: 0,
      })
      expect((await loadPersistedTaskMemory({ rootDir }))?.evidence).toEqual([])
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('returns zero removals for a fully fresh versioned record without rewriting', async () => {
    await writeFile(path.join(rootDir, 'ok.ts'), 'ok')
    const saved = await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({
        evidence: [
          makeEvidence({
            id: 'ev-ok',
            path: 'ok.ts',
            freshnessHash: `sha256-whole:${sha256('ok')}`,
          }),
        ],
      }),
    })

    const result = await pruneStaleTaskMemoryEvidence({ rootDir })

    expect(result).toEqual({ status: 'pruned', removed: 0, remaining: 1 })
    expect(await loadPersistedTaskMemory({ rootDir })).toEqual(saved)
  })

  test('reports a missing record and write failures as distinct outcomes', async () => {
    expect(await pruneStaleTaskMemoryEvidence({ rootDir })).toEqual({
      status: 'no-record',
    })

    await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({
        evidence: [
          makeEvidence({ id: 'ev-gone', path: 'gone.ts', freshnessHash: 'x' }),
        ],
      }),
    })
    const noRenameAdapter = {
      mkdir: nodeFsPromises.mkdir.bind(nodeFsPromises),
      readFile: nodeFsPromises.readFile.bind(nodeFsPromises),
      stat: nodeFsPromises.stat.bind(nodeFsPromises),
      realpath: nodeFsPromises.realpath.bind(nodeFsPromises),
      createFileExclusive: async (
        file: Parameters<typeof writeFile>[0],
        data: Parameters<typeof writeFile>[1],
      ) => {
        await writeFile(file, data, { flag: 'wx', mode: 0o600 })
      },
      open: nodeFsPromises.open.bind(nodeFsPromises),
      unlink: nodeFsPromises.unlink.bind(nodeFsPromises),
      writeFile: nodeFsPromises.writeFile.bind(nodeFsPromises),
    } as unknown as CodebuffFileSystem
    // A rename-less adapter is a FAILED prune, not an absent record: the
    // stale entry it would have dropped is still there.
    expect(
      await pruneStaleTaskMemoryEvidence({
        rootDir,
        fs: codebuffFsToNodePromises(noRenameAdapter),
      }),
    ).toEqual({
      status: 'failed',
      reason: 'write-failed',
      removed: 1,
      remaining: 0,
    })
    // No tmp litter left behind by the degraded write.
    expect(await readdir(path.join(rootDir, '.openbuff', 'memory'))).toEqual([
      'task-memory.json',
    ])
    // And the record itself is untouched.
    const reloaded = await loadPersistedTaskMemory({ rootDir })
    expect(reloaded?.evidence.map((item) => item.id)).toEqual(['ev-gone'])
  })

  test('refuses to reuse a revision another writer published mid-prune', async () => {
    await saveMergedTaskMemory({
      rootDir,
      runMemory: makeMemory({
        evidence: [
          makeEvidence({ id: 'ev-gone', path: 'gone.ts', freshnessHash: 'x' }),
        ],
      }),
    })
    const before = (await loadPersistedTaskMemory({ rootDir }))!

    // Simulate a concurrent save landing after prune reads its initial record.
    // Intercept only task-memory.json (never the ownership-token lock file),
    // return the original bytes to prune, and publish the newer revision before
    // prune's guarded reload inside the lock.
    const memoryPath = path.resolve(
      rootDir,
      '.openbuff',
      'memory',
      'task-memory.json',
    )
    let advanced = false
    const racingFs = {
      ...new Proxy(nodeFsPromises, {
        get(target, prop) {
          if (prop === 'readFile') {
            return async (
              ...args: Parameters<typeof nodeFsPromises.readFile>
            ) => {
              const requestedPath = path.resolve(String(args[0]))
              if (!advanced && requestedPath === memoryPath) {
                const original = await nodeFsPromises.readFile(...args)
                advanced = true
                await saveMergedTaskMemory({
                  rootDir,
                  runMemory: makeMemory({ decisions: ['Concurrent save'] }),
                  priorMemory: before,
                })
                return original
              }
              return nodeFsPromises.readFile(...args)
            }
          }
          return Reflect.get(target, prop)
        },
      }),
      createFileExclusive: async (
        file: Parameters<typeof writeFile>[0],
        data: Parameters<typeof writeFile>[1],
      ) => {
        await writeFile(file, data, { flag: 'wx', mode: 0o600 })
      },
    } as import('../services/task-memory-store').TaskMemoryStoreFs

    const result = await pruneStaleTaskMemoryEvidence({
      rootDir,
      fs: racingFs,
    })

    expect(result).toEqual({
      status: 'failed',
      reason: 'concurrent-write',
      removed: 1,
      remaining: 0,
    })
    // The concurrent save's revision survives intact — the prune did not
    // overwrite it under a duplicate revision number.
    const reloaded = (await loadPersistedTaskMemory({ rootDir }))!
    expect(reloaded.revision).toBeGreaterThan(before.revision)
    expect(reloaded.decisions).toEqual(['Concurrent save'])
  })
})
