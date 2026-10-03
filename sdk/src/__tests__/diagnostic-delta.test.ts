import { describe, expect, test } from 'bun:test'

import {
  captureDiagnostics,
  computeDiagnosticDelta,
  preflightDiagnosticDelta,
  supportedDiagnosticFiles,
  type DiagnosticCommandRunner,
} from '../services/diagnostic-delta'
import {
  isDiagnosticPreflightEnabled,
  runFileChangeHooks,
  type FileChangeHook,
} from '../tools/file-change-hooks'

import type {
  LanguageDiagnostic,
  LanguageDiagnosticTextEdit,
} from '../tools/language-diagnostics'
import type { CodebuffToolOutput } from '@codebuff/common/tools/list'

function makeDiagnostic(
  overrides: Partial<LanguageDiagnostic> = {},
): LanguageDiagnostic {
  return {
    file: 'src/a.py',
    range: {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 1 },
    },
    severity: 'error',
    code: 'E501',
    message: 'line too long',
    command: 'ruff check .',
    source: 'ruff',
    ...overrides,
  }
}

function makeFix(
  overrides: Partial<LanguageDiagnosticTextEdit> = {},
): LanguageDiagnosticTextEdit {
  return {
    file: 'src/a.py',
    newText: 'x = 1',
    range: {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 5 },
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// computeDiagnosticDelta (pure)
// ---------------------------------------------------------------------------
describe('computeDiagnosticDelta', () => {
  test('detects a new error not present in the baseline', () => {
    const before = [makeDiagnostic({ code: 'E501', message: 'existing' })]
    const after = [
      before[0],
      makeDiagnostic({ code: 'F401', message: 'unused import' }),
    ]
    const delta = computeDiagnosticDelta(before, after)
    expect(delta).toHaveLength(1)
    expect(delta[0].code).toBe('F401')
  })

  test('ignores a pre-existing error (identical diagnostic)', () => {
    const before = [makeDiagnostic()]
    const after = [makeDiagnostic()]
    expect(computeDiagnosticDelta(before, after)).toEqual([])
  })

  test('returns the whole `after` set when baseline is empty', () => {
    const after = [makeDiagnostic(), makeDiagnostic({ code: 'F401' })]
    expect(computeDiagnosticDelta([], after)).toHaveLength(2)
  })

  test('strict mode flags a line-shifted pre-existing error as new', () => {
    const before = [makeDiagnostic({ range: { start: { line: 5, column: 1 }, end: { line: 5, column: 1 } } })]
    const after = [makeDiagnostic({ range: { start: { line: 8, column: 1 }, end: { line: 8, column: 1 } } })]
    // Strict mode matches on (file, line, column, code, severity); a line shift
    // breaks the key, so the moved diagnostic is reported as new.
    expect(computeDiagnosticDelta(before, after)).toHaveLength(1)
  })

  test('tolerant mode survives a line shift by matching on (file, code)', () => {
    const before = [makeDiagnostic({ range: { start: { line: 5, column: 1 }, end: { line: 5, column: 1 } } })]
    const after = [makeDiagnostic({ range: { start: { line: 8, column: 1 }, end: { line: 8, column: 1 } } })]
    expect(computeDiagnosticDelta(before, after, { mode: 'tolerant' })).toEqual(
      [],
    )
  })

  test('tolerant mode still flags a genuinely new rule code', () => {
    const before = [makeDiagnostic({ code: 'E501' })]
    const after = [makeDiagnostic({ code: 'E501' }), makeDiagnostic({ code: 'F401' })]
    const delta = computeDiagnosticDelta(before, after, { mode: 'tolerant' })
    expect(delta).toHaveLength(1)
    expect(delta[0].code).toBe('F401')
  })

  test('strict mode distinguishes severity on the same location', () => {
    const before = [makeDiagnostic({ severity: 'warning' })]
    const after = [makeDiagnostic({ severity: 'error' })]
    expect(computeDiagnosticDelta(before, after)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// captureDiagnostics via an injected fake runner (hermetic)
// ---------------------------------------------------------------------------
describe('captureDiagnostics', () => {
  test('parses ruff JSON output from the injected runner', async () => {
    const ruffJson = JSON.stringify([
      {
        filename: 'src/a.py',
        message: 'unused import',
        location: { row: 3, column: 1 },
        end_location: { row: 3, column: 10 },
        code: 'F401',
        severity: 'error',
      },
    ])
    const run: DiagnosticCommandRunner = async ({ command }) => {
      if (command === 'ruff check --output-format=json') {
        return { stdout: ruffJson }
      }
      return { stdout: '[]' }
    }
    const diagnostics = await captureDiagnostics({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
    })
    const ruffDiag = diagnostics.find((d) => d.source === 'ruff')
    expect(ruffDiag).toBeDefined()
    expect(ruffDiag?.code).toBe('F401')
    expect(ruffDiag?.range?.start.line).toBe(3)
    expect(ruffDiag?.severity).toBe('error')
  })

  test('parses cargo JSON output from the injected runner', async () => {
    const cargoLine = JSON.stringify({
      reason: 'compiler-message',
      message: {
        level: 'error',
        message: 'mismatched types',
        code: { code: 'E0308' },
        spans: [
          {
            is_primary: true,
            file_name: 'src/lib.rs',
            line_start: 10,
            column_start: 5,
            line_end: 10,
            column_end: 9,
          },
        ],
        children: [],
      },
    })
    const run: DiagnosticCommandRunner = async ({ command }) => {
      if (command === 'cargo check --message-format=json') {
        return { stdout: `${cargoLine}\n` }
      }
      return {}
    }
    const diagnostics = await captureDiagnostics({
      files: ['src/lib.rs'],
      cwd: '/repo',
      runCommand: run,
    })
    const cargoDiag = diagnostics.find((d) => d.source === 'cargo')
    expect(cargoDiag).toBeDefined()
    expect(cargoDiag?.code).toBe('E0308')
    expect(cargoDiag?.range?.start.line).toBe(10)
    expect(cargoDiag?.severity).toBe('error')
  })

  test('a runner failure yields no diagnostics (never a fabricated rejection)', async () => {
    const run: DiagnosticCommandRunner = async () => {
      throw new Error('tool not installed')
    }
    const diagnostics = await captureDiagnostics({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
    })
    expect(diagnostics).toEqual([])
  })

  test('forwards the timeout bound to the runner seam', async () => {
    const seen: number[] = []
    const run: DiagnosticCommandRunner = async ({ timeoutSeconds }) => {
      seen.push(timeoutSeconds)
      return {}
    }
    await captureDiagnostics({
      files: ['src/a.rs'],
      cwd: '/repo',
      runCommand: run,
      timeoutSeconds: 45,
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((t) => t === 45)).toBe(true)
  })

  test('skips files with no supported diagnostic command', async () => {
    const calls: string[] = []
    const run: DiagnosticCommandRunner = async ({ command }) => {
      calls.push(command)
      return {}
    }
    await captureDiagnostics({
      files: ['README.md', 'docs/notes.txt'],
      cwd: '/repo',
      runCommand: run,
    })
    expect(calls).toEqual([])
  })

  test('runs one project-wide command per language, not per file', async () => {
    const calls: string[] = []
    const run: DiagnosticCommandRunner = async ({ command }) => {
      calls.push(command)
      return { stdout: '[]' }
    }
    await captureDiagnostics({
      files: ['src/a.py', 'src/b.py', 'src/c.py'],
      cwd: '/repo',
      runCommand: run,
    })
    const ruffCalls = calls.filter(
      (command) => command === 'ruff check --output-format=json',
    )
    expect(ruffCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// supportedDiagnosticFiles
// ---------------------------------------------------------------------------
describe('supportedDiagnosticFiles', () => {
  test('keeps files whose language has a diagnostic command', () => {
    expect(
      supportedDiagnosticFiles(['src/a.ts', 'src/a.py', 'src/a.rs', 'README.md']),
    ).toEqual(['src/a.ts', 'src/a.py', 'src/a.rs'])
  })
})

// ---------------------------------------------------------------------------
// preflightDiagnosticDelta — reject only on NEW errors
// ---------------------------------------------------------------------------
describe('preflightDiagnosticDelta', () => {
  function ruffRunner(
    beforeJson: string,
    afterJson: string,
  ): { run: DiagnosticCommandRunner; calls: string[] } {
    const calls: string[] = []
    let invocation = 0
    const run: DiagnosticCommandRunner = async ({ command }) => {
      calls.push(command)
      if (command === 'ruff check --output-format=json') {
        invocation += 1
        // First ruff invocation = baseline; subsequent = after the edit.
        return { stdout: invocation === 1 ? beforeJson : afterJson }
      }
      return { stdout: '[]' }
    }
    return { run, calls }
  }

  const ruffEntry = (code: string, message: string, row: number) => ({
    filename: 'src/a.py',
    message,
    location: { row, column: 1 },
    end_location: { row, column: 10 },
    code,
    severity: 'error',
  })

  test('accepts the edit when no new error is introduced', async () => {
    const baseline = JSON.stringify([ruffEntry('E501', 'line too long', 1)])
    const after = JSON.stringify([ruffEntry('E501', 'line too long', 1)])
    const { run } = ruffRunner(baseline, after)
    let applied = false
    let rolledBack = false
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {
        applied = true
      },
      rollbackEdit: () => {
        rolledBack = true
      },
    })
    expect(result).toEqual({ rejected: false })
    expect(applied).toBe(true)
    expect(rolledBack).toBe(false)
  })

  test('rejects and rolls back when a NEW error is introduced', async () => {
    const baseline = JSON.stringify([])
    const after = JSON.stringify([ruffEntry('F401', 'unused import', 2)])
    const { run } = ruffRunner(baseline, after)
    let rolledBack = false
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {},
      rollbackEdit: () => {
        rolledBack = true
      },
    })
    expect(result.rejected).toBe(true)
    if (result.rejected) {
      expect(result.newDiagnostics).toHaveLength(1)
      expect(result.newDiagnostics[0].code).toBe('F401')
    }
    expect(rolledBack).toBe(true)
  })

  test('does not reject when only a pre-existing error persists', async () => {
    const existing = JSON.stringify([ruffEntry('E501', 'line too long', 1)])
    const { run } = ruffRunner(existing, existing)
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {},
    })
    expect(result).toEqual({ rejected: false })
  })

  test('does not reject on a new non-error (warning) diagnostic', async () => {
    const baseline = JSON.stringify([])
    const after = JSON.stringify([
      { ...ruffEntry('W291', 'trailing whitespace', 3), severity: 'warning' },
    ])
    const { run } = ruffRunner(baseline, after)
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {},
    })
    expect(result).toEqual({ rejected: false })
  })

  test('aggregates fix-its from the new errors on rejection', async () => {
    const baseline = JSON.stringify([])
    const after = JSON.stringify([
      {
        filename: 'src/a.py',
        message: 'unused import',
        location: { row: 2, column: 1 },
        end_location: { row: 2, column: 10 },
        code: 'F401',
        severity: 'error',
        fix: {
          edits: [
            {
              content: '',
              location: { row: 2, column: 1 },
              end_location: { row: 2, column: 10 },
            },
          ],
        },
      },
    ])
    const { run } = ruffRunner(baseline, after)
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {},
    })
    expect(result.rejected).toBe(true)
    if (result.rejected) {
      expect(result.fixIts.length).toBeGreaterThan(0)
      expect(result.fixIts[0].file).toBe('src/a.py')
      expect(result.fixIts[0].newText).toBe('')
    }
  })

  test('tolerant delta mode ignores a pre-existing error whose line shifted', async () => {
    const before = JSON.stringify([ruffEntry('E501', 'line too long', 5)])
    const after = JSON.stringify([ruffEntry('E501', 'line too long', 8)])
    const { run } = ruffRunner(before, after)
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {},
      deltaMode: 'tolerant',
    })
    expect(result).toEqual({ rejected: false })
  })

  test('strict delta mode flags the shifted line as new without tolerant mode', async () => {
    const before = JSON.stringify([ruffEntry('E501', 'line too long', 5)])
    const after = JSON.stringify([ruffEntry('E501', 'line too long', 8)])
    const { run } = ruffRunner(before, after)
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {},
    })
    expect(result.rejected).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// computeDiagnosticDelta fix-it aggregation (pure, via diagnostic objects)
// ---------------------------------------------------------------------------
describe('computeDiagnosticDelta fix-it aggregation', () => {
  test('aggregates and de-duplicates fix-its across new diagnostics', () => {
    const sharedFix = makeFix()
    const before: LanguageDiagnostic[] = []
    const after = [
      makeDiagnostic({ code: 'F401', fixes: [sharedFix] }),
      makeDiagnostic({ code: 'F402', fixes: [sharedFix, makeFix({ newText: 'y = 2' })] }),
    ]
    const delta = computeDiagnosticDelta(before, after)
    const fixIts: LanguageDiagnosticTextEdit[] = []
    const seen = new Set<string>()
    for (const diagnostic of delta) {
      for (const fix of diagnostic.fixes ?? []) {
        const key = JSON.stringify(fix)
        if (seen.has(key)) continue
        seen.add(key)
        fixIts.push(fix)
      }
    }
    expect(fixIts).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Env-flag gating + hook identity
// ---------------------------------------------------------------------------
describe('isDiagnosticPreflightEnabled', () => {
  test('is OFF by default and for unset/empty/falsy values', () => {
    expect(isDiagnosticPreflightEnabled({})).toBe(false)
    expect(isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: '' })).toBe(false)
    expect(isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: '0' })).toBe(false)
    expect(isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'false' })).toBe(false)
    expect(isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'no' })).toBe(false)
    expect(isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'off' })).toBe(false)
  })

  test('is ON for truthy values', () => {
    expect(isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: '1' })).toBe(true)
    expect(isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true' })).toBe(true)
    expect(isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'yes' })).toBe(true)
  })
})

function fakeRunner(
  exitByCommand: Record<
    string,
    { exitCode: number; stdout?: string; stderr?: string }
  >,
) {
  const calls: string[] = []
  const run = (async (params: Record<string, unknown>) => {
    calls.push(params.command as string)
    const r = exitByCommand[params.command as string] ?? { exitCode: 0 }
    return [
      {
        type: 'json' as const,
        value: {
          exitCode: r.exitCode,
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
        },
      },
    ] as CodebuffToolOutput<'run_terminal_command'>
  }) as never
  return { run, calls }
}

const baseHooks: FileChangeHook[] = [
  { name: 'typecheck', command: 'tsc --noEmit' },
]

function jsonValue(
  out: CodebuffToolOutput<'run_file_change_hooks'>,
): Record<string, unknown>[] | undefined {
  const first = Array.isArray(out) ? out[0] : undefined
  return first && first.type === 'json'
    ? (first.value as Record<string, unknown>[])
    : undefined
}

describe('runFileChangeHooks diagnostic-delta gating', () => {
  test('flag OFF yields byte-identical results (no delta block runs)', async () => {
    const { run } = fakeRunner({ 'tsc --noEmit': { exitCode: 0 } })
    let deltaInvoked = false
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      env: {}, // flag unset
      hooks: baseHooks,
      runCommand: run,
      diagnosticDelta: async () => {
        deltaInvoked = true
        return { rejected: true, newDiagnostics: [], fixIts: [] }
      },
    })
    expect(deltaInvoked).toBe(false)
    const results = jsonValue(out)
    expect(results).toEqual([{ hookName: 'typecheck', exitCode: 0, stdout: '', stderr: '' }])
  })

  test('flag ON surfaces a diagnostic-delta rejection in the hook result', async () => {
    const { run } = fakeRunner({ 'tsc --noEmit': { exitCode: 0 } })
    const newDiagnostic = makeDiagnostic({ code: 'F401' })
    const fixIt = makeFix()
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: '1' },
      hooks: baseHooks,
      runCommand: run,
      diagnosticDelta: async () => ({
        rejected: true,
        newDiagnostics: [newDiagnostic],
        fixIts: [fixIt],
      }),
    })
    const results = jsonValue(out)
    const deltaResult = results?.find(
      (result) => result.hookName === 'diagnostic-delta',
    )
    expect(deltaResult).toMatchObject({
      validationStatus: 'diagnostic_delta_rejected',
    })
  })

  test('flag ON with passing preflight surfaces a passed marker', async () => {
    const { run } = fakeRunner({ 'tsc --noEmit': { exitCode: 0 } })
    const out = await runFileChangeHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true' },
      hooks: baseHooks,
      runCommand: run,
      diagnosticDelta: async () => ({ rejected: false }),
    })
    const results = jsonValue(out)
    const deltaResult = results?.find(
      (result) => result.hookName === 'diagnostic-delta',
    )
    expect(deltaResult).toMatchObject({
      validationStatus: 'diagnostic_delta_passed',
    })
  })

  test('flag ON but no supported files skips the delta preflight', async () => {
    const { run } = fakeRunner({ 'tsc --noEmit': { exitCode: 0 } })
    let deltaInvoked = false
    await runFileChangeHooks({
      files: ['README.md'],
      cwd: '/repo',
      env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: '1' },
      hooks: baseHooks,
      runCommand: run,
      diagnosticDelta: async () => {
        deltaInvoked = true
        return { rejected: false }
      },
    })
    expect(deltaInvoked).toBe(false)
  })
})
