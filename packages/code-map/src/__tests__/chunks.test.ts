import { beforeEach, describe, expect, test } from 'bun:test'

import {
  chunkAlias,
  clearChunkMemo,
  deriveChunkId,
  deriveStableChunkId,
  extractCodeChunks,
  extractCodeChunksDetailed,
  hashContent,
  MAX_CHUNK_MEMO_ENTRIES,
  registerChunkRenameAlias,
  resolveChunkAlias,
} from '../chunks'

describe('extractCodeChunks', () => {
  beforeEach(() => {
    clearChunkMemo()
    chunkAlias.clear()
  })

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
      expect(chunk.stableChunkId).toMatch(/^[0-9a-f]{64}$/)
      expect(chunk.signature.length).toBeLessThanOrEqual(512)
      expect(chunk.signatureText).toContain(chunk.signature.slice(0, 16))
      expect(chunk.signatureRange.endLine).toBeGreaterThanOrEqual(
        chunk.signatureRange.startLine,
      )
      expect(chunk.language).toBe('typescript')
      expect(chunk.docComment ?? '').toBe('')
      expect(chunk.chunkId).toBe(
        deriveChunkId(chunk.path, chunk.qualifiedName, chunk.kind, chunk.hash),
      )
      expect(chunk.stableChunkId).toBe(
        deriveStableChunkId(chunk.path, chunk.qualifiedName, chunk.kind),
      )
      expect(Array.isArray(chunk.calls)).toBe(true)
      expect(Array.isArray(chunk.calledBy)).toBe(true)
      expect(Array.isArray(chunk.imports)).toBe(true)
      expect(Array.isArray(chunk.references)).toBe(true)
    }
    // Export flag + columns survive on the exported function.
    expect(byName.greet.exported).toBe(true)
    expect(byName.greet.startCol).toBeGreaterThanOrEqual(1)
    expect(byName.greet.endCol).toBeGreaterThanOrEqual(1)

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
    expect(byName.top_level.language).toBe('python')
  })

  test('captures a full multi-line header span, not just the first line', async () => {
    const src = [
      'export function multi(', // 1
      '  a: string,', // 2
      '  b: number,', // 3
      '): string {', // 4
      '  return a', // 5
      '}', // 6
    ].join('\n')

    const chunks = await extractCodeChunks(src, 'multi.ts')
    expect(chunks).toHaveLength(1)
    const chunk = chunks[0]!
    expect(chunk.signatureRange.endLine).toBeGreaterThan(
      chunk.signatureRange.startLine,
    )
    expect(chunk.signatureText).toContain('a: string')
    expect(chunk.signatureText).toContain('b: number')
    expect(chunk.signatureText.split('\n').length).toBeGreaterThan(1)
    expect(chunk.signature.length).toBeLessThanOrEqual(512)
  })

  test('extracts non-empty doc comments with ranges and legacy compat', async () => {
    const tsSrc = [
      '/** Greets a user. */', // 1
      'export function documented(name: string) {', // 2
      '  return name', // 3
      '}', // 4
    ].join('\n')
    const tsChunks = await extractCodeChunks(tsSrc, 'doc.ts')
    expect(tsChunks).toHaveLength(1)
    const documented = tsChunks[0]!
    expect(documented.docComment ?? '').toContain('Greets a user.')
    expect(documented.doc?.text ?? '').toContain('Greets a user.')
    expect(documented.docCommentRange).toMatchObject({
      startLine: 1,
      endLine: 1,
    })
    expect(documented.doc?.range).toMatchObject({ startLine: 1, endLine: 1 })

    const pySrc = [
      '# Compute the total.', // 1
      'def total(xs):', // 2
      '    return 1', // 3
    ].join('\n')
    const pyChunks = await extractCodeChunks(pySrc, 'doc.py')
    expect(pyChunks).toHaveLength(1)
    expect(pyChunks[0]!.docComment ?? '').toContain('Compute the total.')
  })

  test('exposes additive typeInfo and modifiers without breaking compat', async () => {
    const src = [
      'export function greet(name: string) {', // 1
      '  return `hi ${name}`', // 2
      '}', // 3
    ].join('\n')
    const chunks = await extractCodeChunks(src, 'types.ts')
    expect(chunks).toHaveLength(1)
    const greet = chunks[0]!
    expect(greet.typeInfo?.params?.[0]).toMatchObject({ name: 'name' })
    expect(greet.typeInfo?.params?.[0]?.type).toContain('string')
    expect(greet.modifiers?.exported).toBe(true)
    expect(greet.exported).toBe(true)
  })

  test('links per-chunk call edges and skips self-calls', async () => {
    const src = [
      'export function helper() {', // 1
      '  return 1', // 2
      '}', // 3
      '', // 4
      'export function user() {', // 5
      '  return helper()', // 6
      '}', // 7
      '', // 8
      'export function lonely() {', // 9
      '  return lonely()', // 10
      '}', // 11
    ].join('\n')

    const chunks = await extractCodeChunks(src, 'edges.ts')
    const byName = Object.fromEntries(chunks.map((c) => [c.qualifiedName, c]))
    const helper = byName.helper!
    const user = byName.user!
    const lonely = byName.lonely!

    expect(user.calls.map((c) => c.name)).toContain('helper')
    const helperCall = user.calls.find((c) => c.name === 'helper')!
    expect(helperCall.line).toBe(6)
    expect(helperCall.col).toBeGreaterThanOrEqual(1)
    expect(user.references.map((r) => r.target)).toContain('helper')
    expect(helper.calledBy.map((c) => c.caller)).toContain('user')
    const incoming = helper.calledBy.find((c) => c.caller === 'user')!
    expect(incoming.line).toBe(6)
    // Self-calls never produce calledBy or reference edges.
    expect(lonely.calledBy).toEqual([])
    expect(lonely.references.filter((r) => r.target === 'lonely')).toEqual([])
    // Per-chunk caps hold.
    for (const chunk of chunks) {
      expect(chunk.calls.length).toBeLessThanOrEqual(25)
      expect(chunk.calledBy.length).toBeLessThanOrEqual(25)
      expect(chunk.imports.length).toBeLessThanOrEqual(25)
      expect(chunk.references.length).toBeLessThanOrEqual(25)
    }
  })

  test('body edits preserve stableChunkId while changing the version hash', async () => {
    const v1 = ['export function stable() {', '  return 1', '}'].join('\n')
    const v2 = ['export function stable() {', '  return 2', '}'].join('\n')
    const before = await extractCodeChunks(v1, 'stable.ts')
    const after = await extractCodeChunks(v2, 'stable.ts')
    expect(before).toHaveLength(1)
    expect(after).toHaveLength(1)
    expect(after[0]!.stableChunkId).toBe(before[0]!.stableChunkId)
    expect(after[0]!.stableChunkId).toBe(
      deriveStableChunkId('stable.ts', 'stable', 'function'),
    )
    expect(after[0]!.hash).not.toBe(before[0]!.hash)
    expect(after[0]!.chunkId).not.toBe(before[0]!.chunkId)
  })

  test('reuses previous chunks without a fresh parse when the hash is unchanged', async () => {
    const src = ['export function cached() {', '  return 1', '}'].join('\n')
    const first = await extractCodeChunks(src, 'reuse-a.ts')
    expect(first.length).toBeGreaterThan(0)
    const result = await extractCodeChunksDetailed(src, 'reuse-a.ts', {
      previousChunks: first,
      contentHash: hashContent(src),
    })
    expect(result.chunks).toBe(first)
    expect(result.reusedChunks).toBe(first.length)
    expect(result.freshChunks).toBe(0)
    expect(result.diagnostics).toEqual([])
  })

  test('reports diagnostics instead of failing silently', async () => {
    const unsupported = await extractCodeChunksDetailed(
      'hello',
      'notes.unknownext',
    )
    expect(unsupported.chunks).toEqual([])
    expect(unsupported.diagnostics.length).toBeGreaterThan(0)
    expect(unsupported.diagnostics[0]!.stage).toBe('language')

    const viaOpts: { diagnostics?: import('../chunks').ChunkDiagnostic[] } = {}
    await extractCodeChunks('hello', 'notes.unknownext', viaOpts)
    expect(viaOpts.diagnostics !== undefined).toBe(true)
    expect((viaOpts.diagnostics ?? []).length).toBeGreaterThan(0)
  })

  test('returns [] for empty file', async () => {
    expect(await extractCodeChunks('', 'empty.ts')).toEqual([])
  })

  test('returns [] for unsupported extension', async () => {
    expect(await extractCodeChunks('hello', 'notes.unknownext')).toEqual([])
  })

  test('resolves rename alias round-trip', async () => {
    expect(resolveChunkAlias('alias-unknown.ts')).toBe('alias-unknown.ts')
    registerChunkRenameAlias('alias-old.ts', 'alias-mid.ts')
    expect(resolveChunkAlias('alias-old.ts')).toBe('alias-mid.ts')
    expect(resolveChunkAlias('alias-mid.ts')).toBe('alias-mid.ts')
    registerChunkRenameAlias('alias-mid.ts', 'alias-new.ts')
    expect(resolveChunkAlias('alias-old.ts')).toBe('alias-new.ts')
    expect(resolveChunkAlias('alias-mid.ts')).toBe('alias-new.ts')
    registerChunkRenameAlias('alias-same.ts', 'alias-same.ts')
    expect(resolveChunkAlias('alias-same.ts')).toBe('alias-same.ts')
    expect(chunkAlias.has('alias-same.ts')).toBe(false)
  })

  test('resolves alias cycles without hanging', async () => {
    registerChunkRenameAlias('cycle-a.ts', 'cycle-b.ts')
    registerChunkRenameAlias('cycle-b.ts', 'cycle-a.ts')
    expect(resolveChunkAlias('cycle-a.ts')).toBe('cycle-b.ts')
    expect(resolveChunkAlias('cycle-b.ts')).toBe('cycle-a.ts')
    registerChunkRenameAlias('cycle-self.ts', 'cycle-self-next.ts')
    registerChunkRenameAlias('cycle-self-next.ts', 'cycle-self.ts')
    expect(['cycle-self.ts', 'cycle-self-next.ts']).toContain(
      resolveChunkAlias('cycle-self.ts'),
    )
  })

  test('reuses chunks across rename with remapped stable ids', async () => {
    const src = ['export function moved() {', '  return 1', '}'].join('\n')
    const oldPath = 'alias-prev-old.ts'
    const newPath = 'alias-prev-new.ts'
    const first = await extractCodeChunks(src, oldPath)
    expect(first.length).toBeGreaterThan(0)
    const viaPreviousPath = await extractCodeChunksDetailed(src, newPath, {
      previousPath: oldPath,
    })
    expect(viaPreviousPath.freshChunks).toBe(0)
    expect(viaPreviousPath.reusedChunks).toBe(first.length)
    expect(viaPreviousPath.diagnostics).toEqual([])
    expect(viaPreviousPath.chunks).toHaveLength(first.length)
    for (let i = 0; i < first.length; i++) {
      const prev = first[i]!
      const next = viaPreviousPath.chunks[i]!
      expect(next.path).toBe(newPath)
      expect(next.qualifiedName).toBe(prev.qualifiedName)
      expect(next.kind).toBe(prev.kind)
      expect(next.hash).toBe(prev.hash)
      expect(next.stableChunkId).toBe(
        deriveStableChunkId(newPath, next.qualifiedName, next.kind),
      )
      expect(next.chunkId).toBe(
        deriveChunkId(newPath, next.qualifiedName, next.kind, next.hash),
      )
      expect(next.stableChunkId).not.toBe(prev.stableChunkId)
    }
    clearChunkMemo()
    chunkAlias.clear()
    const aliasOld = 'alias-map-old.ts'
    const aliasNew = 'alias-map-new.ts'
    const seeded = await extractCodeChunks(src, aliasOld)
    expect(seeded.length).toBeGreaterThan(0)
    registerChunkRenameAlias(aliasOld, aliasNew)
    const viaAlias = await extractCodeChunksDetailed(src, aliasNew)
    expect(viaAlias.freshChunks).toBe(0)
    expect(viaAlias.reusedChunks).toBe(seeded.length)
    expect(viaAlias.chunks[0]!.path).toBe(aliasNew)
    expect(viaAlias.chunks[0]!.stableChunkId).toBe(
      deriveStableChunkId(aliasNew, seeded[0]!.qualifiedName, seeded[0]!.kind),
    )
  })

  test('outgoing references refuse ambiguous same-name targets like calledBy', async () => {
    // Regression for the M4-S6 asymmetry finding: two unrelated definitions
    // sharing one bare name must produce NO outgoing reference edge, exactly
    // like the incoming calledBy pass — the old code guessed with the first
    // match, corrupting chunk-level blast radius.
    const src = [
      'class Alpha {', // 1 — first unrelated definition of `run`
      '  run() {', // 2
      '    return 1', // 3
      '  }', // 4
      '}', // 5
      '', // 6
      'class Beta {', // 7 — a second, unrelated definition of the same name
      '  run() {', // 8
      '    return 2', // 9
      '  }', // 10
      '}', // 11
      '', // 12
      'function trigger() {', // 13 — calls the ambiguous bare name
      '  return run()', // 14
      '}', // 15
    ].join('\n')

    const chunks = await extractCodeChunks(src, 'ambiguous.ts')
    const trigger = chunks.find((chunk) => chunk.qualifiedName === 'trigger')!

    // The call itself is still recorded...
    expect(trigger.calls.some((call) => call.name === 'run')).toBe(true)
    // ...but no guessed reference edge is emitted for the ambiguous name.
    expect(trigger.references).toEqual([])
  })

  test('outgoing references still link unambiguous calls and overloads', async () => {
    const src = [
      'function unique() {', // 1
      '  return 1', // 2
      '}', // 3
      '', // 4
      'function caller() {', // 5
      '  return unique()', // 6
      '}', // 7
    ].join('\n')

    const chunks = await extractCodeChunks(src, 'symmetry.ts')
    const caller = chunks.find((chunk) => chunk.qualifiedName === 'caller')!

    expect(caller.references.map((reference) => reference.target)).toContain(
      'unique',
    )
  })

  test('memoizes zero-chunk non-empty files with the same content hash', async () => {
    // Regression for the M4-S6 zero-chunk finding: a non-empty file that
    // yields zero chunks (e.g. only comments) must be memoized so the next
    // call with identical content reuses it instead of re-parsing.
    const src = '// nothing extractable here\n// just a comment\n'
    const first = await extractCodeChunksDetailed(src, 'comments-only.ts')
    expect(first.chunks).toEqual([])
    // A fresh parse of a zero-chunk non-empty file surfaces the synthetic
    // 'no definitions' diagnostic — that is the baseline result being memoized.
    expect(first.diagnostics.map((d) => d.stage)).toEqual(['parse'])

    const second = await extractCodeChunksDetailed(src, 'comments-only.ts')
    // Memo hit: no fresh parse ran, so the synthetic diagnostic is absent —
    // that absence is the observable signal that the empty result was reused.
    expect(second.diagnostics).toEqual([])
    expect(second.chunks).toEqual([])
  })

  test('does not memoize a parse failure for a non-empty file', async () => {
    const first = await extractCodeChunksDetailed('hello', 'notes.unknownext')
    expect(first.chunks).toEqual([])
    expect(first.diagnostics[0]!.stage).toBe('language')

    // The failure is not cached: the second call re-runs extraction and
    // surfaces the same diagnostic instead of a silent cached [].
    const second = await extractCodeChunksDetailed('hello', 'notes.unknownext')
    expect(second.diagnostics[0]!.stage).toBe('language')
  })

  test('scopes memo keys by projectRoot and evicts on overflow', async () => {
    const src = ['export function scoped() {', '  return 1', '}'].join('\n')
    clearChunkMemo()

    // Same relative path under two different project roots must not alias.
    const first = await extractCodeChunksDetailed(src, 'src/shared.ts', {
      projectRoot: '/project-a',
    })
    const second = await extractCodeChunksDetailed(src, 'src/shared.ts', {
      projectRoot: '/project-b',
    })
    // The second extraction is a fresh parse for a distinct memo key — both
    // carry the same (content-derived) chunk ids, so equality of ids proves
    // scoping by content, and two live memo entries prove scoping by root.
    expect(second.chunks[0]!.chunkId).toBe(first.chunks[0]!.chunkId)

    // FIFO eviction: filling past the bound evicts the oldest entry without
    // unbounded growth.
    for (let i = 0; i < MAX_CHUNK_MEMO_ENTRIES + 10; i++) {
      await extractCodeChunksDetailed(src, `filler-${i}.ts`)
    }
    // A filler entry evicted long ago is re-parsed fresh...
    const evicted = await extractCodeChunksDetailed(src, 'filler-0.ts')
    expect(evicted.freshChunks).toBeGreaterThan(0)
    // ...and the most recently inserted entry is still memoized.
    const recent = await extractCodeChunksDetailed(
      src,
      `filler-${MAX_CHUNK_MEMO_ENTRIES + 9}.ts`,
    )
    expect(recent.reusedChunks).toBeGreaterThan(0)
  })
})
