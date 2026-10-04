import { EventEmitter } from 'node:events'

import { describe, expect, test } from 'bun:test'

import {
  createDiagnosticCommandRunner,
  createDiagnosticDeltaHook,
  MAX_CAPTURED_STREAM_BYTES,
} from '../services/diagnostic-delta-runner'
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
import type { ChildProcess } from 'node:child_process'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

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

  test('fans the capture commands out with bounded parallelism', async () => {
    // perf: diagnostic-preflight-serial-commands-hot-path — the per-capture
    // command loop used to run strictly serially, adding up to ~8 minutes of
    // hook latency under the 120s default timeout. Multiple languages yield
    // multiple commands; the fan-out must overlap them with a bounded
    // in-flight window instead of awaiting each in turn.
    let inFlight = 0
    let maxInFlight = 0
    const run: DiagnosticCommandRunner = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      return { stdout: '[]' }
    }
    await captureDiagnostics({
      files: ['src/a.ts', 'src/b.py', 'src/c.rs', 'src/d.go'],
      cwd: '/repo',
      runCommand: run,
    })
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(4)
  })

  test('parallel fan-out still joins diagnostics in deterministic command order', async () => {
    // The bounded window must not reorder output: diagnostics join in the
    // same command order the serial loop produced, per repeated runs. Each
    // command returns its native parseable shape (tsc plain-text compiler
    // lines, eslint JSON) with a deliberately skewed delay so a reordered
    // join would flip the result.
    const run: DiagnosticCommandRunner = async ({ command }) => {
      await new Promise((resolve) =>
        setTimeout(resolve, command.startsWith('tsc') ? 20 : 5),
      )
      if (command === 'tsc --noEmit --pretty false') {
        return { stdout: 'src/a.ts(1,1): error TS1: from tsc' }
      }
      return {
        stdout: JSON.stringify([
          {
            filePath: 'src/a.ts',
            messages: [
              {
                message: 'from eslint',
                line: 2,
                column: 1,
                ruleId: 'ES1',
                severity: 2,
              },
            ],
          },
        ]),
      }
    }
    const first = await captureDiagnostics({
      files: ['src/a.ts'],
      cwd: '/repo',
      runCommand: run,
    })
    const second = await captureDiagnostics({
      files: ['src/a.ts'],
      cwd: '/repo',
      runCommand: run,
    })
    expect(first.map((d) => d.code)).toEqual(second.map((d) => d.code))
    expect(first.map((d) => d.code)).toEqual(['TS1', 'ES1'])
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

// ---------------------------------------------------------------------------
// createDiagnosticDeltaHook — production wiring for the preflight seam
// ---------------------------------------------------------------------------
describe('createDiagnosticDeltaHook', () => {
  type FakeSpawnCall = {
    file: string
    args: string[]
    options: unknown
  }

  function fakeSpawn(
    results: Record<string, { exitCode?: number; stdout?: string } | 'error'>,
  ): { spawn: CodebuffSpawn; calls: FakeSpawnCall[] } {
    const calls: FakeSpawnCall[] = []
    const spawn = (
      file: string,
      args: readonly string[] | undefined,
      options: unknown,
    ) => {
      calls.push({ file, args: [...(args ?? [])], options })
      const stdout = new EventEmitter()
      const child = Object.assign(new EventEmitter(), {
        stdout,
      }) as unknown as ChildProcess
      process.nextTick(() => {
        const spec = results[file]
        if (spec === 'error') {
          child.emit('error', new Error('spawn ENOENT'))
          return
        }
        if (spec?.stdout) stdout.emit('data', spec.stdout)
        child.emit('close', spec?.exitCode ?? 0)
      })
      return child
    }
    return { spawn: spawn as unknown as CodebuffSpawn, calls }
  }

  test('runs preflightDiagnosticDelta over the argv-array child-process seam', async () => {
    const { spawn, calls } = fakeSpawn({})
    const hook = createDiagnosticDeltaHook({ spawn })
    const result = await hook({ files: ['src/a.ts'], cwd: '/repo', env: {} })
    // No tool output -> empty baseline and after-capture -> acceptance; a
    // hook-seam preflight never fabricates a rejection.
    expect(result).toEqual({ rejected: false })
    // Commands execute as argv arrays over spawn, never through a shell.
    const tscCall = calls.find((call) => call.file === 'tsc')
    expect(tscCall).toBeDefined()
    expect(Array.isArray(tscCall?.args)).toBe(true)
    expect(tscCall?.args).toContain('--noEmit')
    expect(tscCall?.options).toMatchObject({ cwd: '/repo' })
  })

  test('skips the second capture when applyEdit is a no-op (hook seam)', async () => {
    const { spawn, calls } = fakeSpawn({
      tsc: { exitCode: 0, stdout: '[]' },
      eslint: { exitCode: 0, stdout: '[]' },
    })
    const hook = createDiagnosticDeltaHook({ spawn })
    await hook({ files: ['src/a.ts'], cwd: '/repo', env: {} })
    // The hook seam's applyEdit is a no-op, so each diagnostic command must
    // run exactly once per hook invocation — not once per capture (twice).
    const tscCalls = calls.filter((call) => call.file === 'tsc')
    const eslintCalls = calls.filter((call) => call.file === 'eslint')
    expect(tscCalls).toHaveLength(1)
    expect(eslintCalls).toHaveLength(1)
  })

  test('is fail-open: a throwing preflight resolves to undefined', async () => {
    const { spawn } = fakeSpawn({})
    const hook = createDiagnosticDeltaHook({
      spawn,
      preflight: (async () => {
        throw new Error('preflight exploded')
      }) as unknown as typeof preflightDiagnosticDelta,
    })
    await expect(
      hook({ files: ['src/a.ts'], cwd: '/repo' }),
    ).resolves.toBeUndefined()
  })

  test('an absent diagnostic tool yields no diagnostics and no rejection', async () => {
    const { spawn } = fakeSpawn({ tsc: 'error' })
    const hook = createDiagnosticDeltaHook({ spawn })
    const result = await hook({ files: ['src/a.ts'], cwd: '/repo' })
    expect(result).toEqual({ rejected: false })
  })
})

// ---------------------------------------------------------------------------
// createDiagnosticCommandRunner — byte-bounded, multibyte-safe stream capture
// (perf: diagnostic-capture-utf8-chunk-split)
// ---------------------------------------------------------------------------
describe('createDiagnosticCommandRunner stream capture', () => {
  /** Spawn fake whose stdout is delivered as raw byte chunks. */
  function bufferSpawn(stdoutChunks: Buffer[]): CodebuffSpawn {
    return ((file: string) => {
      const stdout = new EventEmitter()
      const child = Object.assign(new EventEmitter(), {
        stdout,
      }) as unknown as ChildProcess
      process.nextTick(() => {
        for (const chunk of stdoutChunks) stdout.emit('data', chunk)
        child.emit('close', 0)
      })
      return child
    }) as unknown as CodebuffSpawn
  }

  test('decodes a multibyte UTF-8 sequence split across stream chunks intact', async () => {
    // '😀' is 4 UTF-8 bytes; the fake stream splits it mid-sequence. The old
    // per-chunk chunk.toString() decode turned each half into U+FFFD.
    const emoji = Buffer.from('😀', 'utf8')
    const runCommand = createDiagnosticCommandRunner({
      spawn: bufferSpawn([
        Buffer.from('prefix '),
        emoji.subarray(0, 2),
        emoji.subarray(2),
        Buffer.from(' suffix'),
      ]),
    })
    const result = await runCommand({
      command: 'tsc --noEmit',
      cwd: '/repo',
      timeoutSeconds: 5,
    })
    expect(result.stdout).toBe('prefix 😀 suffix')
    expect(result.stdout).not.toContain('\uFFFD')
  })

  test('caps the capture in BYTES and never splits a multibyte char at the boundary', async () => {
    const emoji = Buffer.from('😀', 'utf8') // 4 bytes
    // Multibyte-heavy stream past the byte cap, chunked at 63-byte boundaries
    // so chunks split emojis. The old UTF-16-length cap would have retained
    // MORE than the named byte budget (1 UTF-16 unit per 4-byte emoji).
    const emojiCount = Math.ceil((MAX_CAPTURED_STREAM_BYTES + 64) / emoji.length)
    const payload = Buffer.concat(
      Array.from({ length: emojiCount }, () => emoji),
    )
    const chunks: Buffer[] = []
    for (let i = 0; i < payload.length; i += 63) {
      chunks.push(payload.subarray(i, i + 63))
    }
    const runCommand = createDiagnosticCommandRunner({
      spawn: bufferSpawn(chunks),
    })
    const result = await runCommand({
      command: 'tsc --noEmit',
      cwd: '/repo',
      timeoutSeconds: 5,
    })
    // Exactly the named byte cap is retained, and the truncation boundary
    // lands on a whole emoji (cap is divisible by 4), so no U+FFFD appears.
    expect(Buffer.byteLength(result.stdout ?? '', 'utf8')).toBe(
      MAX_CAPTURED_STREAM_BYTES,
    )
    expect(result.stdout).toBe('😀'.repeat(MAX_CAPTURED_STREAM_BYTES / 4))
    expect(result.stdout).not.toContain('\uFFFD')
  })
})

// ---------------------------------------------------------------------------
// createDiagnosticCommandRunner — SIGTERM→SIGKILL escalation
// (perf: diagnostic-runner-timeout-no-sigkill-escalation)
// ---------------------------------------------------------------------------
describe('createDiagnosticCommandRunner timeout escalation', () => {
  /** Spawn fake whose child ignores SIGTERM and terminates only on SIGKILL. */
  function sigtermIgnoringSpawn(): {
    spawn: CodebuffSpawn
    signals: string[]
  } {
    const signals: string[] = []
    const spawn = ((file: string) => {
      const stdout = new EventEmitter()
      const child = Object.assign(new EventEmitter(), {
        stdout,
        kill: (signal?: string) => {
          signals.push(signal ?? 'SIGTERM')
          if (signal === 'SIGKILL') {
            // A SIGTERM-ignoring child only terminates on SIGKILL.
            process.nextTick(() => child.emit('close', null))
          }
        },
      }) as unknown as ChildProcess
      return child
    }) as unknown as CodebuffSpawn
    return { spawn, signals }
  }

  test('settles at the deadline and reaps a SIGTERM-ignoring child via SIGKILL', async () => {
    const { spawn, signals } = sigtermIgnoringSpawn()
    const runCommand = createDiagnosticCommandRunner({
      spawn,
      sigtermGraceMs: 25,
    })
    const started = performance.now()
    const result = await runCommand({
      command: 'tsc --noEmit',
      cwd: '/repo',
      timeoutSeconds: 0.05,
    })
    // The result settles AT the deadline (the SIGTERM), not at the SIGKILL
    // escalation: the escalation bounds the leaked child's lifetime without
    // delaying callers on the hot file-change path.
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(result.timedOut).toBe(true)
    // SIGTERM at the deadline, then the SIGKILL escalation after the grace.
    // The escalation deliberately does NOT delay the settled result, so it
    // fires after the promise resolves — wait past the injected grace before
    // asserting the escalation sequence.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
