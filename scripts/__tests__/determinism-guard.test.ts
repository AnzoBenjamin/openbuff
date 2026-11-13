import { expect, test, beforeEach, afterEach } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  runDeterminismGuard,
  writeDeterminismBaseline,
} from '../determinism-guard'
import type { DeterminismBaseline } from '../determinism-guard'

const FIXED_GENERATED_AT = '2026-01-01T00:00:00.000Z'

/** Write a production file under the fixture's scanned subtree. */
function writeSrcFile(
  root: string,
  relativeName: string,
  content: string,
): void {
  const target = join(root, 'packages', 'agent-runtime', 'src', relativeName)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function baselinePath(root: string): string {
  return join(root, 'scripts', 'determinism-guard-baseline.json')
}

function writeBaseline(
  root: string,
  files: DeterminismBaseline['files'],
): void {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  const baseline: DeterminismBaseline = {
    schemaVersion: 1,
    generatedAt: FIXED_GENERATED_AT,
    files,
  }
  writeFileSync(baselinePath(root), JSON.stringify(baseline, null, 2))
}

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'dg-'))
})

afterEach(() => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('flags an unmarked Date.now() call in agent-runtime production code', () => {
  writeSrcFile(
    tmpRoot,
    'clock-user.ts',
    'export function now(): number {\n  return Date.now()\n}\n',
  )

  const result = runDeterminismGuard(tmpRoot)

  expect(result.score).toBe(1)
  const finding = result.findings.find(
    (f) => f.path === 'packages/agent-runtime/src/clock-user.ts',
  )
  expect(finding).toBeDefined()
  expect(finding!.line).toBe(2)
  expect(finding!.message).toContain('unmarked Date.now call')
})

test('suppresses a call with a deferral marker within 8 lines above', () => {
  writeSrcFile(
    tmpRoot,
    'deferred.ts',
    [
      '// TODO(P2-T1b): route through the injected clock once deps are threaded.',
      'export function now(): number {',
      '  return Date.now()',
      '}',
      '',
    ].join('\n'),
  )

  expect(runDeterminismGuard(tmpRoot).score).toBe(0)
})

test('marker window is exactly 8 lines: suppressed at 8, flagged at 9', () => {
  // Marker on line 1, call on line 9: window covers lines 1..9, suppressed.
  writeSrcFile(
    tmpRoot,
    'at-eight.ts',
    [
      '// NOTE(P2-T1): deferred to the P2-T1b slice.',
      ...Array.from({ length: 7 }, () => '// filler'),
      'export const t = Date.now()',
    ].join('\n') + '\n',
  )
  // Marker on line 1, call on line 10: window covers lines 2..10, flagged.
  writeSrcFile(
    tmpRoot,
    'at-nine.ts',
    [
      '// TODO(P2-T2): deferred to the journaling slice.',
      ...Array.from({ length: 8 }, () => '// filler'),
      'export const t = Date.now()',
    ].join('\n') + '\n',
  )

  const result = runDeterminismGuard(tmpRoot)

  expect(result.score).toBe(1)
  expect(result.findings[0]!.path).toBe('packages/agent-runtime/src/at-nine.ts')
  expect(result.findings[0]!.line).toBe(10)
})

test('baseline pins existing calls and fails on newly added unmarked calls', () => {
  writeSrcFile(
    tmpRoot,
    'ledger.ts',
    'export function a(): number {\n  return Date.now()\n}\n',
  )
  writeBaseline(tmpRoot, {
    'packages/agent-runtime/src/ledger.ts': { dateNow: 1, randomUuid: 0 },
  })
  expect(runDeterminismGuard(tmpRoot).score).toBe(0)

  appendFileSync(
    join(tmpRoot, 'packages', 'agent-runtime', 'src', 'ledger.ts'),
    'export function b(): number {\n  return Date.now()\n}\n',
  )

  const result = runDeterminismGuard(tmpRoot)

  // Only the EXCESS (the appended, later) call fails — the pinned call passes.
  expect(result.score).toBe(1)
  expect(result.findings[0]!.path).toBe('packages/agent-runtime/src/ledger.ts')
  expect(result.findings[0]!.line).toBe(5)
})

test('a file absent from the baseline fails on every unmarked call', () => {
  writeSrcFile(
    tmpRoot,
    'new-file.ts',
    'export const t = Date.now()\nexport const u = crypto.randomUUID()\n',
  )

  const result = runDeterminismGuard(tmpRoot)

  expect(result.score).toBe(2)
})

test('flags bare randomUUID() only when it is imported from node:crypto', () => {
  writeSrcFile(
    tmpRoot,
    'imported-uuid.ts',
    "import { randomUUID } from 'node:crypto'\n\nexport function id(): string {\n  return randomUUID()\n}\n",
  )
  writeSrcFile(
    tmpRoot,
    'local-uuid.ts',
    "function randomUUID(): string {\n  return 'not-crypto'\n}\n\nexport function id(): string {\n  return randomUUID()\n}\n",
  )
  writeSrcFile(
    tmpRoot,
    'qualified-uuid.ts',
    'export const makeId = (): string => crypto.randomUUID()\n',
  )

  const result = runDeterminismGuard(tmpRoot)

  const imported = result.findings.filter(
    (f) => f.path === 'packages/agent-runtime/src/imported-uuid.ts',
  )
  expect(imported.length).toBe(1)
  expect(imported[0]!.line).toBe(4)
  expect(imported[0]!.message).toContain('unmarked randomUUID call')
  expect(
    result.findings.some((f) => f.path.endsWith('local-uuid.ts')),
  ).toBe(false)
  const qualified = result.findings.filter(
    (f) => f.path === 'packages/agent-runtime/src/qualified-uuid.ts',
  )
  expect(qualified.length).toBe(1)
})

test('test files and __tests__ directories are not scanned', () => {
  writeSrcFile(tmpRoot, 'covered.test.ts', 'export const t = Date.now()\n')
  writeSrcFile(tmpRoot, 'covered.test.tsx', 'export const t = Date.now()\n')
  writeSrcFile(tmpRoot, '__tests__/helper.ts', 'export const t = Date.now()\n')

  expect(runDeterminismGuard(tmpRoot).score).toBe(0)
})

test('writeDeterminismBaseline emits byte-identical, key-sorted JSON', () => {
  writeSrcFile(tmpRoot, 'b-second.ts', 'export const id = crypto.randomUUID()\n')
  // Marker-suppressed calls are not counted into the baseline.
  writeSrcFile(
    tmpRoot,
    'a-first.ts',
    'export const t = Date.now()\n// TODO(P2-T2): deferred\nexport const u = Date.now()\n',
  )

  const first = writeDeterminismBaseline(tmpRoot, {
    generatedAt: FIXED_GENERATED_AT,
  })
  const firstBytes = readFileSync(baselinePath(tmpRoot))
  const second = writeDeterminismBaseline(tmpRoot, {
    generatedAt: FIXED_GENERATED_AT,
  })
  const secondBytes = readFileSync(baselinePath(tmpRoot))

  expect(secondBytes.equals(firstBytes)).toBe(true)
  const text = firstBytes.toString('utf8')
  expect(text.indexOf('"packages/agent-runtime/src/a-first.ts"')).toBeLessThan(
    text.indexOf('"packages/agent-runtime/src/b-second.ts"'),
  )
  expect(text.endsWith('\n')).toBe(true)
  expect(first).toEqual({
    schemaVersion: 1,
    generatedAt: FIXED_GENERATED_AT,
    files: {
      'packages/agent-runtime/src/a-first.ts': { dateNow: 1, randomUuid: 0 },
      'packages/agent-runtime/src/b-second.ts': { dateNow: 0, randomUuid: 1 },
    },
  })
  expect(second.files).toEqual(first.files)
})

test('throws a clear error naming the baseline file when it is malformed', () => {
  writeSrcFile(tmpRoot, 'clock-user.ts', 'export const t = Date.now()\n')
  mkdirSync(join(tmpRoot, 'scripts'), { recursive: true })
  writeFileSync(baselinePath(tmpRoot), '{ not json')

  expect(() => runDeterminismGuard(tmpRoot)).toThrow(
    /determinism-guard-baseline\.json/,
  )
})

test('throws when the baseline shape is wrong (fail closed)', () => {
  writeSrcFile(tmpRoot, 'clock-user.ts', 'export const t = Date.now()\n')
  mkdirSync(join(tmpRoot, 'scripts'), { recursive: true })
  writeFileSync(
    baselinePath(tmpRoot),
    JSON.stringify({ schemaVersion: 2, generatedAt: '', files: {} }),
  )

  expect(() => runDeterminismGuard(tmpRoot)).toThrow(
    /determinism-guard-baseline\.json/,
  )
})
