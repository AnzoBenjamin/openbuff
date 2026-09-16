import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import {
  committedSurfaceReceiptId,
  deriveCommittedSurfaceFileSet,
  MAX_COMMITTED_SURFACE_FILES,
} from '../base2/gate-committed-surface'

function makeDeriveInput(overrides?: {
  runtimeFiles?: string[]
  narrowingHint?: string[]
  isReviewable?: (path: string) => boolean
  markerFor?: (path: string) => string
  cap?: number
}) {
  const marker: Record<string, string> = {
    'src/kept.ts':
      'sha256:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2:42',
    'src/other.ts':
      'sha256:b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2:24',
    'src/deleted.ts': 'missing',
    'src/locked.ts': 'unreadable:EACCES',
    'notes.md':
      'sha256:c1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2:9',
    'src/symlinked.ts':
      'symlink-sha256:d1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2:7',
  }
  return {
    runtimeFiles: overrides?.runtimeFiles ?? Object.keys(marker),
    ...(overrides?.narrowingHint !== undefined
      ? { narrowingHint: overrides.narrowingHint }
      : {}),
    isReviewable:
      overrides?.isReviewable ?? ((path: string) => !path.endsWith('.md')),
    markerFor:
      overrides?.markerFor ??
      ((path: string) => marker[path] ?? 'unreadable:enoent'),
    ...(overrides?.cap !== undefined ? { cap: overrides.cap } : {}),
  }
}

describe('deriveCommittedSurfaceFileSet', () => {
  test('keeps only reviewable paths with verifiable 64-hex sha256 markers, sorted', () => {
    const result = deriveCommittedSurfaceFileSet(
      makeDeriveInput({
        runtimeFiles: [
          'src/other.ts',
          'src/kept.ts',
          'src/deleted.ts',
          'src/locked.ts',
          'notes.md',
        ],
      }),
    )
    expect(result).toEqual({
      status: 'ok',
      files: ['src/kept.ts', 'src/other.ts'],
    })
  })

  test('accepts symlink-sha256 markers as verifiable bytes', () => {
    const result = deriveCommittedSurfaceFileSet(
      makeDeriveInput({ runtimeFiles: ['src/symlinked.ts'] }),
    )
    expect(result).toEqual({ status: 'ok', files: ['src/symlinked.ts'] })
  })

  test('normalizes backslashes and dedupes preserving first-seen order', () => {
    // Dedupe is observable only through the count/sort: both spellings normalize
    // to one path, so a broken dedupe would yield a duplicate entry.
    const result = deriveCommittedSurfaceFileSet(
      makeDeriveInput({ runtimeFiles: ['src\\kept.ts', 'src/kept.ts'] }),
    )
    expect(result).toEqual({ status: 'ok', files: ['src/kept.ts'] })
  })

  test('narrowingHint intersects the runtime files (non-hint files drop out)', () => {
    const result = deriveCommittedSurfaceFileSet(
      makeDeriveInput({
        runtimeFiles: ['src/kept.ts', 'src/other.ts'],
        narrowingHint: ['src/other.ts'],
      }),
    )
    expect(result).toEqual({ status: 'ok', files: ['src/other.ts'] })
  })

  test('a hint listing files the runtime never observed contributes nothing', () => {
    const result = deriveCommittedSurfaceFileSet(
      makeDeriveInput({
        runtimeFiles: ['src/kept.ts'],
        narrowingHint: ['src/never-seen.ts'],
      }),
    )
    expect(result).toEqual({ status: 'empty' })
  })

  test('an empty or non-array narrowingHint is ignored (no narrowing)', () => {
    const narrowed = deriveCommittedSurfaceFileSet(
      makeDeriveInput({
        runtimeFiles: ['src/kept.ts', 'src/other.ts'],
        narrowingHint: [],
      }),
    )
    expect(narrowed).toEqual({
      status: 'ok',
      files: ['src/kept.ts', 'src/other.ts'],
    })
  })

  test('returns empty when nothing survives the filters (never an ok [])', () => {
    const result = deriveCommittedSurfaceFileSet(
      makeDeriveInput({ runtimeFiles: ['src/deleted.ts', 'notes.md'] }),
    )
    expect(result).toEqual({ status: 'empty' })
  })

  test('returns overflow with the total when the fileset exceeds the cap', () => {
    const many: string[] = []
    for (let i = 0; i < 5; i++) many.push(`src/generated-${i}.ts`)
    const result = deriveCommittedSurfaceFileSet(
      makeDeriveInput({
        runtimeFiles: many,
        markerFor: () =>
          'sha256:e1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2:1',
        cap: 4,
      }),
    )
    expect(result).toEqual({ status: 'overflow', total: 5 })
  })

  test('caps at MAX_COMMITTED_SURFACE_FILES (40) by default', () => {
    expect(MAX_COMMITTED_SURFACE_FILES).toBe(40)
    const many: string[] = []
    for (let i = 0; i < 41; i++) many.push(`src/bulk-${i}.ts`)
    const markerFor = () =>
      'sha256:f1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2:1'
    expect(
      deriveCommittedSurfaceFileSet({
        runtimeFiles: many,
        isReviewable: () => true,
        markerFor,
      }),
    ).toEqual({ status: 'overflow', total: 41 })
    expect(
      deriveCommittedSurfaceFileSet({
        runtimeFiles: many.slice(0, 40),
        isReviewable: () => true,
        markerFor,
      }),
    ).toEqual({ status: 'ok', files: many.slice(0, 40).sort() })
  })

  test('an invalid cap falls back to the 40 default', () => {
    const many: string[] = []
    for (let i = 0; i < 41; i++) many.push(`src/bulk-${i}.ts`)
    const result = deriveCommittedSurfaceFileSet({
      runtimeFiles: many,
      isReviewable: () => true,
      markerFor: () =>
        'sha256:0db2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2:1',
      cap: Number.NaN,
    })
    expect(result).toEqual({ status: 'overflow', total: 41 })
  })
})

describe('committedSurfaceReceiptId', () => {
  test('embeds the kind and the first 16 fingerprint chars', () => {
    const fingerprint = `v3:${'a'.repeat(64)}`
    expect(committedSurfaceReceiptId('P2-T3', fingerprint)).toBe(
      `plan-gate:P2-T3:committed-surface:${fingerprint.slice(0, 16)}`,
    )
  })

  test('a different fingerprint yields a different receipt id', () => {
    const first = committedSurfaceReceiptId('P2-T3', `v3:${'a'.repeat(64)}`)
    const second = committedSurfaceReceiptId('P2-T3', `v3:${'b'.repeat(64)}`)
    expect(first).not.toBe(second)
  })
})

describe('committed-surface inline base2 copy matches export', () => {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )

  test('base2 declares and calls the committed-surface helpers', () => {
    expect(base2Source).toContain('function deriveCommittedSurfaceFileSet(')
    expect(base2Source).toContain('deriveCommittedSurfaceFileSet({')
    expect(base2Source).toContain('function committedSurfaceReceiptId(')
    expect(base2Source).toContain('committedSurfaceReceiptId(')
  })

  test('the spliced region mirrors the module copy exactly (parity)', () => {
    const moduleSource = readFileSync(
      new URL('../base2/gate-committed-surface.ts', import.meta.url),
      'utf8',
    )
    // The generator splices each module declaration through the TypeScript
    // printer, which re-indents bodies, re-wraps statements and parameter
    // lists, and emits trailing semicolons the module source (repo style)
    // omits. None of that is logic. Compare the two copies CANONICALLY:
    // extract each declaration by brace depth (from the `function <name>(`
    // token until depth returns to zero — safe for these pure helpers, which
    // contain no brace-bearing string/template/regex literals), then strip ALL
    // whitespace and semicolons. That tolerates every printer formatting
    // choice while failing on any token change (renamed identifier, altered
    // condition, dropped or added line). Substring name checks alone would
    // pass even when the inline copy drifted into stale semantics.
    const canonicalize = (source: string, name: string): string => {
      const begin = source.search(
        new RegExp(`^(?:export )?function ${name}\\(`, 'm'),
      )
      if (begin < 0) {
        throw new Error(`Unable to find function ${name} in source`)
      }
      let depth = 0
      let end = -1
      for (let i = begin; i < source.length; i += 1) {
        const ch = source[i]
        if (ch === '{') depth += 1
        else if (ch === '}') {
          depth -= 1
          if (depth === 0) {
            end = i + 1
            break
          }
        }
      }
      if (end < 0) {
        throw new Error(`Unbalanced braces extracting function ${name}`)
      }
      return (
        source
          .slice(begin, end)
          .replace(/;/g, '')
          .replace(/\s+/g, '')
          // The printer drops the module's trailing commas when it re-breaks a
          // multi-line parameter list single-line; a trailing comma before a
          // closer is non-semantic, so strip it on both sides.
          .replace(/,([)\]])/g, '$1')
      )
    }
    for (const name of [
      'isAttestableCommittedSurfaceMarker',
      'deriveCommittedSurfaceFileSet',
      'committedSurfaceReceiptId',
    ]) {
      const moduleCopy = canonicalize(moduleSource, name)
      const inlineCopy = canonicalize(base2Source, name)
      // Drop the leading `export` token the module copy carries (the generator
      // strips it when splicing) — whitespace is already collapsed, so the
      // bare token prefix is exact — then require an identical canonical form.
      expect(inlineCopy).toBe(moduleCopy.replace(/^export/, ''))
    }
  })
})
