import { describe, expect, test } from 'bun:test'

import { deriveChunkId, extractCodeChunks } from '../chunks'

describe('extractCodeChunks', () => {
  test('extracts TS functions, classes, and methods with stable chunkId', async () => {
    const src = [
      'export function greet(name: string) {', // 1
      '  return `hi ${name}`', // 2
      '}', // 3
      '', // 4
      'class Service {', // 5
      '  run() {', // 6
      '    return 1', // 7
      '  }', // 8
      '}', // 9
    ].join('\n')

    const chunks = await extractCodeChunks(src, 'x.ts')
    const byName = Object.fromEntries(chunks.map((c) => [c.qualifiedName, c]))

    expect(byName.greet).toMatchObject({
      path: 'x.ts',
      kind: 'function',
      startLine: 1,
      endLine: 3,
      depth: 0,
    })
    expect(byName.Service).toMatchObject({
      kind: 'class',
      startLine: 5,
      endLine: 9,
      depth: 0,
    })
    expect(byName['Service/run']).toMatchObject({
      kind: 'method',
      startLine: 6,
      endLine: 8,
    })
    expect(byName['Service/run'].depth).toBeGreaterThan(0)

    for (const chunk of chunks) {
      expect(chunk.chunkId).toMatch(/^[0-9a-f]{64}$/)
      expect(chunk.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(chunk.signature.length).toBeLessThanOrEqual(512)
      expect(chunk.docComment).toBe('')
      expect(chunk.chunkId).toBe(
        deriveChunkId(chunk.path, chunk.qualifiedName, chunk.kind, chunk.hash),
      )
    }

    // Deterministic across runs.
    const again = await extractCodeChunks(src, 'x.ts')
    expect(again.map((c) => c.chunkId)).toEqual(chunks.map((c) => c.chunkId))
  })

  test('extracts Python nesting with depth-aware qualified names', async () => {
    const src = [
      'class Animal:', // 1
      '    def speak(self):', // 2
      '        return "..."', // 3
      '', // 4
      'def top_level():', // 5
      '    return 1', // 6
    ].join('\n')

    const chunks = await extractCodeChunks(src, 'a.py')
    const byName = Object.fromEntries(chunks.map((c) => [c.qualifiedName, c]))
    expect(byName.Animal).toMatchObject({ kind: 'class', startLine: 1 })
    expect(byName['Animal/speak']).toMatchObject({
      kind: 'method',
      startLine: 2,
    })
    expect(byName.top_level).toMatchObject({
      kind: 'function',
      startLine: 5,
    })
  })

  test('returns [] for empty file', async () => {
    expect(await extractCodeChunks('', 'empty.ts')).toEqual([])
  })

  test('returns [] for unsupported extension', async () => {
    expect(await extractCodeChunks('hello', 'notes.unknownext')).toEqual([])
  })
})
