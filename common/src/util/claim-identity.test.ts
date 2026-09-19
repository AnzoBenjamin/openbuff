import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { deriveClaimId, normalizeClaimText } from './claim-identity'

describe('normalizeClaimText', () => {
  test('collapses whitespace and lowercases', () => {
    expect(normalizeClaimText('  Use   Bun\tfor\nTESTS  ')).toBe(
      'use bun for tests',
    )
  })

  test('NFC-normalizes equivalent unicode sequences', () => {
    // 'e' + combining acute vs precomposed 'é'
    expect(normalizeClaimText('cafe\u0301')).toBe(normalizeClaimText('caf\u00e9'))
  })

  test('is idempotent', () => {
    const once = normalizeClaimText('  Mixed   CASE  text\u0301 ')
    expect(normalizeClaimText(once)).toBe(once)
  })
})

describe('deriveClaimId', () => {
  test('is deterministic for identical inputs', () => {
    const first = deriveClaimId({ kind: 'decision', text: 'Use Bun' })
    const second = deriveClaimId({ kind: 'decision', text: 'Use Bun' })
    expect(first).toBe(second)
  })

  test('is insensitive to evidence order and duplicates', () => {
    const ordered = deriveClaimId({
      kind: 'decision',
      text: 'Use Bun',
      evidencePaths: ['src/a.ts', 'src/b.ts'],
    })
    const reordered = deriveClaimId({
      kind: 'decision',
      text: 'Use Bun',
      evidencePaths: ['src/b.ts', 'src/a.ts', 'src/a.ts'],
    })
    expect(ordered).toBe(reordered)
  })

  test('is sensitive to kind and text', () => {
    const base = deriveClaimId({ kind: 'decision', text: 'Use Bun' })
    expect(deriveClaimId({ kind: 'constraint', text: 'Use Bun' })).not.toBe(base)
    expect(deriveClaimId({ kind: 'decision', text: 'use BUN ' })).toBe(base)
    expect(deriveClaimId({ kind: 'decision', text: 'Use Deno' })).not.toBe(base)
  })

  test('empty and missing evidence agree and differ from non-empty evidence', () => {
    const none = deriveClaimId({ kind: 'decision', text: 'Use Bun' })
    const empty = deriveClaimId({
      kind: 'decision',
      text: 'Use Bun',
      evidencePaths: [],
    })
    expect(none).toBe(empty)
    expect(
      deriveClaimId({ kind: 'decision', text: 'Use Bun', evidencePaths: ['src/a.ts'] }),
    ).not.toBe(none)
  })

  test('produces lowercase 64-hex ids', () => {
    const id = deriveClaimId({ kind: 'decision', text: 'Use Bun' })
    expect(id).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('P7 purity (claim-identity)', () => {
  test('imports only node:crypto', () => {
    const source = readFileSync(join(import.meta.dir, 'claim-identity.ts'), 'utf8')
    const imports = source
      .split('\n')
      .filter((line) => line.startsWith('import '))
    expect(imports).toEqual(["import { createHash } from 'node:crypto'"])
  })
})
