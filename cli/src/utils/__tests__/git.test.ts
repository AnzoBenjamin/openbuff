import { describe, test, expect } from 'bun:test'

import {
  parseDiffStatsPorcelain,
  getDiffStats,
  getDiffStatsAsync,
} from '../git'

describe('parseDiffStatsPorcelain', () => {
  test('returns zeroed counts for empty output', () => {
    expect(parseDiffStatsPorcelain('')).toEqual({
      modified: 0,
      added: 0,
      deleted: 0,
    })
  })

  test('skips blank and whitespace-only lines', () => {
    const output = '\n   \n M a.ts\n\n'
    expect(parseDiffStatsPorcelain(output)).toEqual({
      modified: 1,
      added: 0,
      deleted: 0,
    })
  })

  describe('single status codes', () => {
    test('working-tree modified (" M") counts as modified', () => {
      expect(parseDiffStatsPorcelain(' M a.ts')).toEqual({
        modified: 1,
        added: 0,
        deleted: 0,
      })
    })

    test('staged modified ("M ") counts as modified via staged fallback', () => {
      expect(parseDiffStatsPorcelain('M  a.ts')).toEqual({
        modified: 1,
        added: 0,
        deleted: 0,
      })
    })

    test('staged added ("A ") counts as added', () => {
      expect(parseDiffStatsPorcelain('A  a.ts')).toEqual({
        modified: 0,
        added: 1,
        deleted: 0,
      })
    })

    test('working-tree deleted (" D") counts as deleted', () => {
      expect(parseDiffStatsPorcelain(' D a.ts')).toEqual({
        modified: 0,
        added: 0,
        deleted: 1,
      })
    })

    test('staged deleted ("D ") counts as deleted', () => {
      expect(parseDiffStatsPorcelain('D  a.ts')).toEqual({
        modified: 0,
        added: 0,
        deleted: 1,
      })
    })
  })

  describe('untracked and rename/copy mapping', () => {
    test('untracked ("??") counts as added', () => {
      expect(parseDiffStatsPorcelain('?? new.ts')).toEqual({
        modified: 0,
        added: 1,
        deleted: 0,
      })
    })

    test('rename ("R ") counts as modified', () => {
      expect(parseDiffStatsPorcelain('R  old.ts -> new.ts')).toEqual({
        modified: 1,
        added: 0,
        deleted: 0,
      })
    })

    test('copy ("C ") counts as modified', () => {
      expect(parseDiffStatsPorcelain('C  src.ts -> copy.ts')).toEqual({
        modified: 1,
        added: 0,
        deleted: 0,
      })
    })
  })

  describe('working-tree vs staged status precedence', () => {
    test('prefers working-tree status when present ("AM" -> modified)', () => {
      // staged added, working-tree modified: working-tree wins
      expect(parseDiffStatsPorcelain('AM a.ts')).toEqual({
        modified: 1,
        added: 0,
        deleted: 0,
      })
    })

    test('prefers working-tree status when present ("AD" -> deleted)', () => {
      // staged added, working-tree deleted: working-tree wins
      expect(parseDiffStatsPorcelain('AD a.ts')).toEqual({
        modified: 0,
        added: 0,
        deleted: 1,
      })
    })

    test('falls back to staged status when working-tree is clean (" ")', () => {
      expect(parseDiffStatsPorcelain('A  a.ts')).toEqual({
        modified: 0,
        added: 1,
        deleted: 0,
      })
    })
  })

  describe('excluded statuses', () => {
    test('ignored ("!!") is excluded from all counts', () => {
      expect(parseDiffStatsPorcelain('!! ignored.ts')).toEqual({
        modified: 0,
        added: 0,
        deleted: 0,
      })
    })

    test('clean status (both space) is excluded from all counts', () => {
      expect(parseDiffStatsPorcelain('   clean.ts')).toEqual({
        modified: 0,
        added: 0,
        deleted: 0,
      })
    })
  })

  test('aggregates mixed statuses across multiple lines', () => {
    const output = [
      ' M modified.ts',
      'A  added.ts',
      '?? untracked.ts',
      ' D deleted.ts',
      'R  old.ts -> renamed.ts',
      '!! ignored.ts',
    ].join('\n')

    expect(parseDiffStatsPorcelain(output)).toEqual({
      modified: 2, // modified.ts + renamed.ts
      added: 2, // added.ts + untracked.ts
      deleted: 1, // deleted.ts
    })
  })
})

describe('getDiffStats', () => {
  test('returns null when cwd is not inside a git repository', () => {
    expect(getDiffStats({ cwd: '/nonexistent-path-for-git-test' })).toBeNull()
  })
})

describe('getDiffStatsAsync', () => {
  test('returns null when cwd is not inside a git repository', async () => {
    const result = await getDiffStatsAsync({
      cwd: '/nonexistent-path-for-git-test',
    })
    expect(result).toBeNull()
  })
})
