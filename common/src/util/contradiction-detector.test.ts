import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  detectContradictions,
  deriveTopicKey,
  extractStableChunkIds,
  resolveSupersessionHead,
  STABLE_CHUNK_ID_METADATA_KEY,
  type ContradictionCandidate,
} from './contradiction-detector'

const live = (
  observationId: string,
  overrides: Partial<ContradictionCandidate> = {},
): ContradictionCandidate => ({
  observationId,
  kind: 'decision',
  stableChunkIds: ['chunk:shared'],
  forgotten: false,
  superseded: false,
  corrected: false,
  ...overrides,
})

describe('deriveTopicKey', () => {
  test('is deterministic and order-insensitive', () => {
    const ordered = deriveTopicKey(['chunk:a', 'chunk:b'])
    expect(ordered).not.toBeNull()
    expect(deriveTopicKey(['chunk:b', 'chunk:a'])).toBe(ordered)
    expect(deriveTopicKey(['chunk:a', 'chunk:b', 'chunk:a'])).toBe(ordered)
  })

  test('returns null when empty after cleanup', () => {
    expect(deriveTopicKey([])).toBeNull()
    expect(deriveTopicKey([''])).toBeNull()
    expect(deriveTopicKey(['chunk:a', 7, null, ''] as never)).not.toBeNull()
  })

  test('different chunk sets produce different keys', () => {
    expect(deriveTopicKey(['chunk:a'])).not.toBe(deriveTopicKey(['chunk:b']))
  })
})

describe('extractStableChunkIds', () => {
  test('reads only the canonical stableChunkId key', () => {
    expect(
      extractStableChunkIds({
        [STABLE_CHUNK_ID_METADATA_KEY]: 'lines-1-10',
        claimId: 'c'.repeat(64),
      }),
    ).toEqual(['lines-1-10'])
    expect(extractStableChunkIds({ claimId: 'c'.repeat(64) })).toEqual([])
  })

  test('accepts the persisted chunk-id shape and rejects malformed values', () => {
    expect(extractStableChunkIds({ stableChunkId: 'chunk:symbol:7' })).toEqual([
      'chunk:symbol:7',
    ])
    expect(extractStableChunkIds({ stableChunkId: 'b'.repeat(64) })).toEqual([
      'b'.repeat(64),
    ])
    expect(extractStableChunkIds({ stableChunkId: 'a'.repeat(128) })).toEqual([
      'a'.repeat(128),
    ])
    expect(extractStableChunkIds({ stableChunkId: 'a'.repeat(129) })).toEqual([])
    expect(extractStableChunkIds({ stableChunkId: '-leading-dash' })).toEqual([])
    expect(extractStableChunkIds({ stableChunkId: 'has space' })).toEqual([])
    expect(extractStableChunkIds({ stableChunkId: 7 })).toEqual([])
  })

  test('tolerates malformed metadata without throwing', () => {
    expect(extractStableChunkIds(undefined)).toEqual([])
    expect(extractStableChunkIds(null)).toEqual([])
    expect(extractStableChunkIds(['stableChunkId'])).toEqual([])
    expect(extractStableChunkIds('stableChunkId')).toEqual([])
  })
})

describe('detectContradictions', () => {
  test('groups live decision/constraint observations sharing chunk ids', () => {
    const candidates = detectContradictions({
      observations: [
        live('observation:a'),
        live('observation:b'),
        live('observation:c', { kind: 'constraint' }),
      ],
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.observationIds).toEqual([
      'observation:a',
      'observation:b',
      'observation:c',
    ])
  })

  test('excludes retracted states and non-decision/constraint kinds', () => {
    const candidates = detectContradictions({
      observations: [
        live('observation:a'),
        live('observation:f', { forgotten: true }),
        live('observation:s', { superseded: true }),
        live('observation:c', { corrected: true }),
        live('observation:k', { kind: 'fact' }),
        live('observation:e', { kind: 'evidence' }),
      ],
    })
    expect(candidates).toHaveLength(0)
  })

  test('excludes observations without a topic anchor', () => {
    const candidates = detectContradictions({
      observations: [live('observation:a'), live('observation:b', { stableChunkIds: [] })],
    })
    expect(candidates).toHaveLength(0)
  })

  test('requires at least two members per topic', () => {
    const candidates = detectContradictions({
      observations: [live('observation:a')],
    })
    expect(candidates).toHaveLength(0)
  })

  test('sorts members by code point and caps them at 4 per topic', () => {
    const candidates = detectContradictions({
      observations: [
        live('observation:d'),
        live('observation:b'),
        live('observation:c'),
        live('observation:a'),
        live('observation:e'),
      ],
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.observationIds).toEqual([
      'observation:a',
      'observation:b',
      'observation:c',
      'observation:d',
    ])
  })

  test('caps groups at 16 and sorts groups by topicKey', () => {
    const observations: ContradictionCandidate[] = []
    for (let index = 0; index < 18; index++) {
      const chunk = `chunk:${index}`
      observations.push(
        live(`observation:${index}-a`, { stableChunkIds: [chunk] }),
        live(`observation:${index}-b`, { stableChunkIds: [chunk] }),
      )
    }
    const candidates = detectContradictions({ observations })
    expect(candidates).toHaveLength(16)
    const sortedKeys = [...candidates.map(({ topicKey }) => topicKey)].sort()
    expect(candidates.map(({ topicKey }) => topicKey)).toEqual(sortedKeys)
  })
})

describe('resolveSupersessionHead', () => {
  test('follows the chain A -> B -> C to C', () => {
    const head = resolveSupersessionHead(
      'observation:a',
      new Map([
        ['observation:a', 'observation:b'],
        ['observation:b', 'observation:c'],
      ]),
    )
    expect(head).toBe('observation:c')
  })

  test('is cycle-safe and tolerates missing edges', () => {
    const cyclic = new Map([
      ['observation:a', 'observation:b'],
      ['observation:b', 'observation:a'],
    ])
    expect(resolveSupersessionHead('observation:a', cyclic)).toBe(
      'observation:a',
    )
    expect(resolveSupersessionHead('observation:z', cyclic)).toBe(
      'observation:z',
    )
  })
})

describe('P7 purity (contradiction-detector)', () => {
  test('imports only node:crypto and never consults an ambient clock', () => {
    const source = readFileSync(
      join(import.meta.dir, 'contradiction-detector.ts'),
      'utf8',
    )
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    const imports = code
      .split('\n')
      .filter((line) => line.startsWith('import '))
    expect(imports).toEqual(["import { createHash } from 'node:crypto'"])
    expect(code.includes('Date.now')).toBe(false)
  })
})
