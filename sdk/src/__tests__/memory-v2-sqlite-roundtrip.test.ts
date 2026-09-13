import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  MemorySessionIdSchema,
  ProjectIdSchema,
} from '@codebuff/common/types/memory-v2'

import {
  auditTaskMemoryV1Migration,
  importTaskMemoryV1,
} from '../services/memory-v2/v1-migration'
import {
  loadPersistedTaskMemory,
  saveMergedTaskMemory,
} from '../services/task-memory-store'

import type { TaskMemoryV1 } from '@codebuff/common/types/task-memory'

// Package placement: this test lives in the sdk package (not beside the cli
// backend test) because the real Bun SQLite backend needs nothing beyond the
// plain `bun test` runner — `bun:sqlite` is built into the Bun runtime and the
// existing backend test (cli/src/services/memory-v2/__tests__/bun-sqlite-memory-repository.test.ts)
// runs with no special preload or flags, exactly like the sdk suite
// (`bun --cwd sdk test`). The backend is imported through the same
// workspace-relative source path the cli backend test itself uses for its own
// imports, so the sdk runner opens the real store unchanged. The migration
// (`importTaskMemoryV1`/`auditTaskMemoryV1Migration`) and V1 store
// (`saveMergedTaskMemory`/`loadPersistedTaskMemory`) functions are the exact
// modules re-exported from the `@openbuff/sdk` package root (sdk/src/index.ts);
// they are imported from source here like every other sdk test, because the
// `@openbuff/sdk` specifier resolves to the built dist/, which plain
// `bun test` does not build first.
import { openBunSQLiteMemoryRepository } from '../../../cli/src/services/memory-v2/bun-sqlite-memory-repository'

const projectId = ProjectIdSchema.parse('project:sqlite-roundtrip')
const sessionId = MemorySessionIdSchema.parse('memory-cli')

// Non-empty categories whose marker sourceItemCounts keys are NOT in
// alphabetical order (`decisions` < `path-evidence` < `requirements`). The
// Bun SQLite repository persists event payloads via key-sorted stableJson and
// export() re-parses them, so the re-read marker arrives with sorted record
// keys while the in-memory draft keeps insertion order. Without the
// canonicalizeForCompare fix in equalEventDraft, the audit below mismatches
// on exactly this key-order round-trip and reports imported-body-mismatch.
const runMemory: TaskMemoryV1 = {
  schemaVersion: 1,
  goal: 'Excluded from the import; retained only in the persisted V1 record.',
  requirements: ['req-1'],
  decisions: ['dec-1'],
  filesInspected: [],
  editsMade: [],
  validationResults: [],
  reviewReceipts: [],
  blockers: [],
  nextActions: [],
  historicalSummary: '',
  evidence: [
    {
      id: 'ev-1',
      kind: 'read',
      summary: 'round-trip path evidence',
      path: 'src/roundtrip.ts',
      stale: false,
    },
  ],
  revision: 0,
  updatedAt: 0,
  checksum: 'seeded-by-save',
}

describe('V1→V2 migration against the real Bun SQLite backend', () => {
  let tempRoot: string | undefined

  afterEach(async () => {
    if (tempRoot !== undefined) {
      rmSync(tempRoot, { recursive: true, force: true })
      tempRoot = undefined
    }
  })

  test('import + audit round-trip the marker sourceItemCounts through real SQLite storage', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'openbuff-memory-v2-roundtrip-'))
    const rootDir = tempRoot

    // Seed a valid V1 record through the real store and load it back, so the
    // persisted checksum/revision round-trip is exercised too.
    const saved = await saveMergedTaskMemory({ rootDir, runMemory })
    expect(saved).toBeDefined()
    const memory = await loadPersistedTaskMemory({ rootDir })
    expect(memory).toBeDefined()
    if (!memory) throw new Error('expected persisted V1 task memory')
    expect(memory.requirements).toEqual(['req-1'])
    expect(memory.decisions).toEqual(['dec-1'])
    expect(memory.evidence).toHaveLength(1)

    // Open the REAL backend: creates <tempRoot>/.openbuff/memory/memory-v2.sqlite.
    const opened = await openBunSQLiteMemoryRepository({
      repositoryRoot: rootDir,
    })
    if (opened.status !== 'ok') {
      throw new Error(
        `expected the real backend to open, got ${opened.error.kind}: ${opened.error.message}`,
      )
    }
    const repository = opened.repository
    try {
      expect(repository.databasePath).toBe(
        path.join(rootDir, '.openbuff', 'memory', 'memory-v2.sqlite'),
      )

      const imported = await importTaskMemoryV1({
        memory,
        projectId,
        sessionId,
        repository,
      })
      expect(imported.outcome).toBe('imported')
      if (imported.outcome !== 'imported') return
      expect(imported.sourceItemCounts).toEqual({
        blockers: 0,
        decisions: 1,
        'edits-made': 0,
        'files-inspected': 0,
        'historical-summary': 0,
        'next-actions': 0,
        'path-evidence': 1,
        requirements: 1,
        'review-receipts': 0,
        'validation-results': 0,
      })

      const audit = await auditTaskMemoryV1Migration({
        memory,
        projectId,
        repository,
      })
      expect(audit.outcome).toBe('exact')
      if (audit.outcome !== 'exact') return
      // The key assertion: the audit re-derived its counts from the
      // SQLite-reparsed marker envelope (sorted record keys) and still
      // certifies an exact match against the in-memory import outcome.
      expect(audit.sourceItemCounts).toEqual(imported.sourceItemCounts)
    } finally {
      await repository.close()
    }
  })
})
