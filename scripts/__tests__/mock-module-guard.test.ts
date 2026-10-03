import { describe, expect, test } from 'bun:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeTestFile, runMockModuleGuard } from '../mock-module-guard'

describe('mock-module guard', () => {
  test('flags a createRequire capture read lazily inside its own mock factory', () => {
    const src = [
      "import { createRequire } from 'node:module'",
      'const requireReal = createRequire(import.meta.url)',
      "const real = requireReal('../x')",
      "mock.module('../x', () => ({ ...real, fn: () => real.fn() }))",
    ].join('\n')
    const findings = analyzeTestFile('a.test.ts', src)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.line).toBe(3)
  })

  test('accepts a createRequire capture that is only spread eagerly', () => {
    const src = [
      "import { createRequire } from 'node:module'",
      'const requireReal = createRequire(import.meta.url)',
      "const real = requireReal('../x')",
      "mock.module('../x', () => ({ ...real, fn: () => 1 }))",
    ].join('\n')
    expect(analyzeTestFile('a2.test.ts', src)).toEqual([])
  })

  test('flags a live await-import namespace delegated to from its own mock factory', () => {
    const src = [
      "const real = await import('../x')",
      "mock.module('../x', () => ({",
      '  ...real,',
      '  fn: (...a: unknown[]) => real.fn(...a),',
      '}))',
    ].join('\n')
    const findings = analyzeTestFile('b.test.ts', src)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.line).toBe(1)
    expect(findings[0]!.message).toContain("{ ...(await import('../x')) }")
  })

  test('flags a static namespace import read lazily inside its own mock factory', () => {
    const src = [
      "import * as real from '../x'",
      "mock.module('../x', () => ({ ...real, fn: (a: number) => real.fn(a) }))",
    ].join('\n')
    expect(analyzeTestFile('c.test.ts', src)).toHaveLength(1)
  })

  test('accepts a live namespace that is only spread eagerly', () => {
    const src = [
      "const real = await import('../x')",
      "mock.module('../x', () => ({ ...real, fn: () => 1 }))",
    ].join('\n')
    expect(analyzeTestFile('c2.test.ts', src)).toEqual([])
  })

  test('accepts the snapshot shape', () => {
    const src = [
      "const real = { ...(await import('../x')) }",
      "mock.module('../x', () => ({",
      '  ...real,',
      '  fn: (...a: unknown[]) => real.fn(...a),',
      '}))',
    ].join('\n')
    expect(analyzeTestFile('d.test.ts', src)).toEqual([])
  })

  test('ignores namespace bindings of a different module than the one mocked', () => {
    const src = [
      "import * as other from '../y'",
      "mock.module('../x', () => ({ fn: () => other.value }))",
    ].join('\n')
    expect(analyzeTestFile('e.test.ts', src)).toEqual([])
  })

  test('ignores type-only references (typeof ns.fn) inside the factory', () => {
    const src = [
      "import * as real from '../x'",
      'const realFn = real.fn',
      "mock.module('../x', () => ({",
      '  fn: (a: Parameters<typeof real.fn>[0]) => realFn(a),',
      '}))',
    ].join('\n')
    expect(analyzeTestFile('g.test.ts', src)).toEqual([])
  })

  test('ignores files without mock.module (createRequire alone is fine)', () => {
    const src = [
      "import { createRequire } from 'node:module'",
      'const r = createRequire(import.meta.url)',
    ].join('\n')
    expect(analyzeTestFile('f.test.ts', src)).toEqual([])
  })

  test('the repository itself has no findings', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
    expect(runMockModuleGuard(root)).toEqual([])
  })
})
