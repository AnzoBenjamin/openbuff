import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  createDiagnosticCommandRunner,
  createDiagnosticDeltaHook,
  MAX_CAPTURED_STREAM_BYTES,
} from '../services/diagnostic-delta-runner'
import {
  captureDiagnostics,
  captureDiagnosticObservation,
  type DiagnosticCapture,
  computeDiagnosticDelta,
  DELTA_MODE_ENV_FLAG,
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
import type { AsyncDecision, ExecutionAdapterContext } from '@codebuff/common/types/contracts/execution-context'


import {
  createControlledExecutionClock,
  createExecutionProcessRecorder,
  createTerminalExecutionFixture,
  executionDeadlineMs,
} from './fixtures/b19-terminal-execution'
import { executionRefusal } from '../services/execution-launch'

const executionHosts: ReturnType<typeof createTerminalExecutionFixture>[] = []
afterEach(() => { for (const host of executionHosts.splice(0)) host.dispose() })
function capturedExecution(cwd: string, signal?: AbortSignal) {
  const host = createTerminalExecutionFixture({ projectRoot: cwd, signal })
  executionHosts.push(host)
  return host.context
}
function createMediatedDiagnosticRunner(params: Parameters<typeof createDiagnosticCommandRunner>[0]) {
  const run = createDiagnosticCommandRunner(params)
  return (input: Parameters<typeof run>[0]) => run({
    ...input, executionContext: input.executionContext ?? capturedExecution(input.cwd, input.signal),
  })
}
function createMediatedDeltaHook(params: Parameters<typeof createDiagnosticDeltaHook>[0]) {
  const hook = createDiagnosticDeltaHook(params)
  return (input: Parameters<typeof hook>[0]) => hook({
    ...input, executionContext: input.executionContext ?? capturedExecution(input.cwd, input.signal),
  })
}
function runCapturedHooks(params: Parameters<typeof runFileChangeHooks>[0]) {
  return runFileChangeHooks({
    ...params, executionContext: params.executionContext ?? capturedExecution(params.cwd, params.signal),
    capturedConfiguration: { autoFileChangeHooks: false, fileChangeHooks: [] },
  })
}

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

function observedBaseline(
  diagnostics: LanguageDiagnostic[],
  files = ['src/a.py'],
): DiagnosticCapture {
  const commands = files[0]?.endsWith('.ts')
    ? ['tsc --noEmit --pretty false', 'eslint --format=json .']
    : ['ruff check --output-format=json', 'pyright --outputjson']
  return {
    diagnostics,
    commands: commands.map((command) => ({
      command,
      status: 'completed',
      exitCode: 0,
      outputTruncated: false,
      diagnosticCount: diagnostics.length,
      coverageStatus: 'complete',
    })),
    coverage: {
      status: 'complete',
      requestedFiles: files,
      observedFiles: files,
      unobservedFiles: [],
      reasons: [],
    },
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

  test('tolerant mode survives a line shift by matching on (file, code)', () => {
    const before = [
      makeDiagnostic({
        range: { start: { line: 5, column: 1 }, end: { line: 5, column: 1 } },
      }),
    ]
    const after = [
      makeDiagnostic({
        range: { start: { line: 8, column: 1 }, end: { line: 8, column: 1 } },
      }),
    ]
    expect(computeDiagnosticDelta(before, after, { mode: 'tolerant' })).toEqual(
      [],
    )
  })

  test('DEFAULT mode is tolerant: a line-shifted pre-existing error is not new', () => {
    // The strict default used to reject valid edits whose PRE-EXISTING
    // errors merely shifted lines; the default is now tolerant, strict is
    // opt-in.
    const before = [
      makeDiagnostic({
        range: { start: { line: 5, column: 1 }, end: { line: 5, column: 1 } },
      }),
    ]
    const after = [
      makeDiagnostic({
        range: { start: { line: 8, column: 1 }, end: { line: 8, column: 1 } },
      }),
    ]
    expect(computeDiagnosticDelta(before, after)).toEqual([])
  })

  test('strict mode flags a line-shifted pre-existing error as new', () => {
    const before = [
      makeDiagnostic({
        range: { start: { line: 5, column: 1 }, end: { line: 5, column: 1 } },
      }),
    ]
    const after = [
      makeDiagnostic({
        range: { start: { line: 8, column: 1 }, end: { line: 8, column: 1 } },
      }),
    ]
    // Strict mode matches on (file, line, column, code, severity); a line shift
    // breaks the key, so the moved diagnostic is reported as new. Strict is
    // opt-in now.
    expect(
      computeDiagnosticDelta(before, after, { mode: 'strict' }),
    ).toHaveLength(1)
  })

  test('tolerant mode still flags a genuinely new rule code', () => {
    const before = [makeDiagnostic({ code: 'E501' })]
    const after = [
      makeDiagnostic({ code: 'E501' }),
      makeDiagnostic({ code: 'F401' }),
    ]
    const delta = computeDiagnosticDelta(before, after, { mode: 'tolerant' })
    expect(delta).toHaveLength(1)
    expect(delta[0].code).toBe('F401')
  })

  test.each(['strict', 'tolerant'] as const)(
    '%s mode distinguishes severity on the same location',
    (mode) => {
      const before = [makeDiagnostic({ severity: 'warning' })]
      const after = [makeDiagnostic({ severity: 'error' })]
      expect(computeDiagnosticDelta(before, after, { mode })).toHaveLength(1)
    },
  )

  test('tolerant mode cannot spend a warning baseline to hide a shifted new error', () => {
    const before = [
      makeDiagnostic({ severity: 'error' }),
      makeDiagnostic({ severity: 'warning' }),
    ]
    const after = [
      makeDiagnostic({
        severity: 'error',
        range: { start: { line: 4, column: 1 }, end: { line: 4, column: 1 } },
      }),
      makeDiagnostic({
        severity: 'error',
        range: { start: { line: 8, column: 1 }, end: { line: 8, column: 1 } },
      }),
    ]
    const delta = computeDiagnosticDelta(before, after)
    expect(delta).toEqual([after[1]])
  })

  test('count-aware tolerant matching: a second same-code error in the same file is NEW', () => {
    // A plain per-(file, code) Set masked a genuinely NEW error that merely
    // shared a rule code with a pre-existing one. Multiset semantics consume
    // the baseline count, so the second same-code error is reported.
    const before = [makeDiagnostic({ code: 'E501' })]
    const after = [
      makeDiagnostic({ code: 'E501' }),
      makeDiagnostic({ code: 'E501', message: 'second same-code error' }),
    ]
    const delta = computeDiagnosticDelta(before, after)
    expect(delta).toHaveLength(1)
    expect(delta[0].message).toBe('second same-code error')
  })

  test('count-aware tolerant matching: N pre-existing shifted errors stay tolerated', () => {
    // Line-shifted pre-existing errors must keep matching their baseline
    // counts (pure line shifts stay tolerated), so this edit is accepted.
    const before = [
      makeDiagnostic({
        code: 'E501',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      }),
      makeDiagnostic({
        code: 'E501',
        range: { start: { line: 20, column: 1 }, end: { line: 20, column: 1 } },
      }),
    ]
    const after = [
      makeDiagnostic({
        code: 'E501',
        range: { start: { line: 3, column: 1 }, end: { line: 3, column: 1 } },
      }),
      makeDiagnostic({
        code: 'E501',
        range: { start: { line: 22, column: 1 }, end: { line: 22, column: 1 } },
      }),
    ]
    expect(computeDiagnosticDelta(before, after)).toEqual([])
  })

  test('count-aware tolerant matching is per-file, not global', () => {
    // A same-code error in a DIFFERENT file never consumes another file's
    // baseline count.
    const before = [makeDiagnostic({ code: 'E501', file: 'src/a.py' })]
    const after = [
      makeDiagnostic({ code: 'E501', file: 'src/a.py' }),
      makeDiagnostic({ code: 'E501', file: 'src/b.py' }),
    ]
    const delta = computeDiagnosticDelta(before, after)
    expect(delta).toHaveLength(1)
    expect(delta[0].file).toBe('src/b.py')
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
      supportedDiagnosticFiles([
        'src/a.ts',
        'src/a.py',
        'src/a.rs',
        'README.md',
      ]),
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
        return {
          exitCode: 0,
          stdout: invocation === 1 ? beforeJson : afterJson,
        }
      }
      return { exitCode: 0, stdout: '{"generalDiagnostics":[]}' }
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
    expect(result).toMatchObject({ rejected: false })
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
    expect(result).toMatchObject({ rejected: false })
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
    expect(result).toMatchObject({ rejected: false })
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
    expect(result).toMatchObject({ rejected: false })
  })

  test('DEFAULT delta mode is tolerant: a shifted pre-existing error is accepted', async () => {
    const before = JSON.stringify([ruffEntry('E501', 'line too long', 5)])
    const after = JSON.stringify([ruffEntry('E501', 'line too long', 8)])
    const { run } = ruffRunner(before, after)
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
    // The strict default used to reject valid edits whose PRE-EXISTING errors
    // merely shifted lines; the default is now tolerant, so the edit is
    // accepted and never rolled back.
    expect(result).toMatchObject({ rejected: false })
    expect(rolledBack).toBe(false)
  })

  test('strict delta mode is opt-in and still flags the shifted line', async () => {
    const before = JSON.stringify([ruffEntry('E501', 'line too long', 5)])
    const after = JSON.stringify([ruffEntry('E501', 'line too long', 8)])
    const { run } = ruffRunner(before, after)
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {},
      deltaMode: 'strict',
    })
    expect(result.rejected).toBe(true)
  })

  test('ambient strict mode does not replace the captured delta policy', async () => {
    const previous = process.env[DELTA_MODE_ENV_FLAG]
    process.env[DELTA_MODE_ENV_FLAG] = 'strict'
    try {
      const before = JSON.stringify([ruffEntry('E501', 'line too long', 5)])
      const after = JSON.stringify([ruffEntry('E501', 'line too long', 8)])
      const { run } = ruffRunner(before, after)
      const result = await preflightDiagnosticDelta({
        files: ['src/a.py'],
        cwd: '/repo',
        runCommand: run,
        applyEdit: () => {},
      })
      expect(result.rejected).toBe(false)
    } finally {
      if (previous === undefined) delete process.env[DELTA_MODE_ENV_FLAG]
      else process.env[DELTA_MODE_ENV_FLAG] = previous
    }
  })

  test('a throwing applyEdit rolls back and returns a structured rejection', async () => {
    const baseline = JSON.stringify([])
    const { run } = ruffRunner(baseline, baseline)
    let rolledBack = false
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {
        throw new Error('apply exploded')
      },
      rollbackEdit: () => {
        rolledBack = true
      },
    })
    // The edit is undone and the caller gets a structured rejection (deny by
    // default) instead of an unhandled throw with the edit left applied.
    expect(result).toMatchObject({
      rejected: true,
      diagnosticStatus: 'failed',
      newDiagnostics: [],
      fixIts: [],
    })
    expect(rolledBack).toBe(true)
  })

  test('a throwing applyEdit rolls back even without an explicit rollbackEdit', async () => {
    const baseline = JSON.stringify([])
    const { run } = ruffRunner(baseline, baseline)
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {
        throw new Error('apply exploded')
      },
    })
    expect(result).toMatchObject({
      rejected: true,
      diagnosticStatus: 'failed',
      newDiagnostics: [],
      fixIts: [],
    })
  })

  test('a throwing rollbackEdit does not discard the rejection result', async () => {
    const baseline = JSON.stringify([])
    const after = JSON.stringify([ruffEntry('F401', 'unused import', 2)])
    const { run } = ruffRunner(baseline, after)
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {},
      rollbackEdit: () => {
        throw new Error('rollback exploded')
      },
    })
    // The new error and its fix-its still reach the caller even though the
    // rollback itself failed; the rollback failure is logged, not thrown.
    expect(result.rejected).toBe(true)
    if (result.rejected) {
      expect(result.newDiagnostics).toHaveLength(1)
      expect(result.newDiagnostics[0].code).toBe('F401')
      expect(result.fixIts.length).toBeGreaterThanOrEqual(0)
    }
  })

  test('a supplied baseline wins over skipSecondCapture: the real after-capture runs', async () => {
    // P3 audit fix D: when a caller-supplied baseline is present, the first
    // capture is skipped and the baseline is used as `before`. The baseline
    // also wins over skipSecondCapture, so the after-capture runs for real:
    // exactly ONE ruff invocation (the after-state) proves BOTH that the
    // first capture was skipped and that the second was NOT collapsed.
    const baseline = [makeDiagnostic()]
    const after = JSON.stringify([ruffEntry('F401', 'unused import', 2)])
    // With a baseline the ONLY ruff invocation is the after-capture, so the
    // runner must serve the after-state on its first call.
    const { run, calls } = ruffRunner(after, after)
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {},
      skipSecondCapture: true,
      baseline: observedBaseline(baseline),
    })
    expect(result.rejected).toBe(true)
    if (result.rejected) {
      expect(result.newDiagnostics).toHaveLength(1)
      expect(result.newDiagnostics[0].code).toBe('F401')
    }
    const ruffCalls = calls.filter(
      (command) => command === 'ruff check --output-format=json',
    )
    expect(ruffCalls).toHaveLength(1)
  })

  test('a supplied baseline tolerates pre-existing errors and accepts the edit', async () => {
    const baseline = [makeDiagnostic()]
    const after = JSON.stringify([ruffEntry('E501', 'line too long', 1)])
    const { run } = ruffRunner('[]', after)
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {},
      baseline: observedBaseline(baseline),
    })
    expect(result).toMatchObject({ rejected: false })
  })

  test('count-aware preflight rejects a second same-code error the edit introduced', async () => {
    const before = JSON.stringify([ruffEntry('E501', 'line too long', 1)])
    const after = JSON.stringify([
      ruffEntry('E501', 'line too long', 1),
      ruffEntry('E501', 'another line too long', 30),
    ])
    const { run } = ruffRunner(before, after)
    const result = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: run,
      applyEdit: () => {},
    })
    expect(result.rejected).toBe(true)
    if (result.rejected) {
      expect(result.newDiagnostics).toHaveLength(1)
    }
  })
})

describe('B36 diagnostic observation truth', () => {
  test.each([
    ['timeout', { timedOut: true, errorMessage: 'deadline' }, 'failed'],
    ['exit127', { exitCode: 127 }, 'unavailable'],
    ['exit2', { exitCode: 2 }, 'failed'],
    ['cancelled', { cancelled: true }, 'cancelled'],
    [
      'missing',
      { errorCode: 'ENOENT', errorMessage: 'not found' },
      'unavailable',
    ],
    ['capped', { exitCode: 0, outputTruncated: true }, 'incomplete'],
    ['partial-json', { exitCode: 0, stdout: '{"reason":' }, 'unknown'],
    ['unknown', {}, 'unknown'],
    ['successful-empty', { exitCode: 0 }, 'passed'],
  ] as const)(
    '%s retains command status through delta and hooks',
    async (name, commandResult, diagnosticStatus) => {
      const delta = await preflightDiagnosticDelta({
        files: ['src/lib.rs'],
        cwd: '/repo',
        runCommand: async () => commandResult,
        applyEdit: () => {},
      })
      expect(delta.diagnosticStatus).toBe(diagnosticStatus)
      const output = await runCapturedHooks({
        files: ['src/lib.rs'],
        cwd: '/repo',
        env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true' },
      diagnosticPreflightEnabled: true,
        hooks: [{ name: 'check', command: 'true' }],
        runCommand: async () => [
          { type: 'json', value: { command: 'true', exitCode: 0 } },
        ],
        diagnosticDelta: async () => delta,
      })
      const projected = jsonValue(output)!.find(
        (row) => row.hookName === 'diagnostic-delta',
      )!
      expect(projected.validationStatus).toBe(
        `diagnostic_delta_${diagnosticStatus}`,
      )
      expect(projected.observations).toEqual(delta.observations)
      console.log(
        JSON.stringify({ b36: name, commandResult, delta, projected }),
      )
    },
  )

  test.each([
    [['src/a.swift'], 'unavailable', 'missing_language_command'],
    [['src/a.rs', 'src/a.swift'], 'incomplete', 'missing_language_command'],
    [
      ['src/a.ts', 'src/a.py', 'src/a.rs', 'src/a.go'],
      'incomplete',
      'command_cap',
    ],
    [
      Array.from({ length: 21 }, (_, i) => `src/file${i}.rs`),
      'incomplete',
      'file_cap',
    ],
  ] as const)(
    'omitted scope %j reduces coverage',
    async (files, status, reason) => {
      const capture = await captureDiagnosticObservation({
        files: [...files],
        cwd: '/repo',
        runCommand: async () => ({ exitCode: 0 }),
      })
      expect(capture.coverage.status).toBe(status)
      expect(capture.coverage.reasons).toContain(reason)
      expect(capture.coverage.unobservedFiles.length).toBeGreaterThan(0)
    },
  )

  test('parser truncation is incomplete even when both bounded diagnostic sets match', async () => {
    const stdout = Array.from(
      { length: 201 },
      (_, i) => `src/a.ts(${i + 1},1): error TS${i}: old error`,
    ).join('\n')
    const delta = await preflightDiagnosticDelta({
      files: ['src/a.ts'],
      cwd: '/repo',
      runCommand: async ({ command }) =>
        command.startsWith('tsc ') ? { exitCode: 2, stdout } : { exitCode: 0 },
      applyEdit: () => {},
    })
    expect(delta.diagnosticStatus).toBe('incomplete')
    expect(delta.observations!.after!.diagnostics).toHaveLength(200)
    expect(delta.observations!.after!.commands[0]!.outputTruncated).toBe(true)
  })

  test('a raw legacy baseline cannot certify a passed observation', async () => {
    const delta = await preflightDiagnosticDelta({
      files: ['src/a.ts'],
      cwd: '/repo',
      baseline: [],
      runCommand: async () => ({ exitCode: 0 }),
      applyEdit: () => {},
    })
    expect(delta).toMatchObject({
      rejected: false,
      diagnosticStatus: 'unknown',
    })
    expect(delta.observations!.before!.coverage.reasons).toContain(
      'legacy_baseline_has_no_observation',
    )
  })

  test('cancellation before capture neither launches commands nor applies the edit', async () => {
    const controller = new AbortController()
    controller.abort()
    let runs = 0
    let applies = 0
    const delta = await preflightDiagnosticDelta({
      files: ['src/a.rs'],
      cwd: '/repo',
      signal: controller.signal,
      runCommand: async () => {
        runs++
        return { exitCode: 0 }
      },
      applyEdit: () => {
        applies++
      },
    })
    expect(delta.diagnosticStatus).toBe('cancelled')
    expect(runs).toBe(0)
    expect(applies).toBe(0)
  })

  test('structured entries the parser cannot observe keep coverage unknown', async () => {
    const delta = await preflightDiagnosticDelta({
      files: ['src/a.py'],
      cwd: '/repo',
      runCommand: async ({ command }) =>
        command.startsWith('ruff ')
          ? {
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  filename: 'src/a.py',
                  message: 'lost diagnostic',
                  location: { row: 1 },
                },
              ]),
            }
          : { exitCode: 0 },
      applyEdit: () => {},
    })
    expect(delta.diagnosticStatus).not.toBe('passed')
    expect(delta.observations!.after!.commands[0]!.coverageStatus).toBe(
      'unknown',
    )
  })

  test('unlocated indented text is unknown instead of an empty successful observation', async () => {
    const delta = await preflightDiagnosticDelta({
      files: ['src/a.ts'],
      cwd: '/repo',
      runCommand: async () => ({
        exitCode: 0,
        stdout: '  observer returned an unknown format',
      }),
      applyEdit: () => {},
    })
    expect(delta.diagnosticStatus).toBe('unknown')
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
      makeDiagnostic({
        code: 'F402',
        fixes: [sharedFix, makeFix({ newText: 'y = 2' })],
      }),
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
    expect(
      isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: '' }),
    ).toBe(false)
    expect(
      isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: '0' }),
    ).toBe(false)
    expect(
      isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'false' }),
    ).toBe(false)
    expect(
      isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'no' }),
    ).toBe(false)
    expect(
      isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'off' }),
    ).toBe(false)
  })

  test('is ON for truthy values', () => {
    expect(
      isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: '1' }),
    ).toBe(true)
    expect(
      isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true' }),
    ).toBe(true)
    expect(
      isDiagnosticPreflightEnabled({ OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'yes' }),
    ).toBe(true)
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
    const out = await runCapturedHooks({
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
    expect(results).toEqual([
      { hookName: 'typecheck', exitCode: 0, stdout: '', stderr: '' },
    ])
  })

  test('flag ON surfaces a diagnostic-delta rejection in the hook result', async () => {
    const { run } = fakeRunner({ 'tsc --noEmit': { exitCode: 0 } })
    const newDiagnostic = makeDiagnostic({ code: 'F401' })
    const fixIt = makeFix()
    const out = await runCapturedHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: '1' },
      diagnosticPreflightEnabled: true,
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
    const out = await runCapturedHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true' },
      diagnosticPreflightEnabled: true,
      hooks: baseHooks,
      runCommand: run,
      diagnosticDelta: async () =>
        preflightDiagnosticDelta({
          files: ['src/a.ts'],
          cwd: '/repo',
          runCommand: async () => ({ exitCode: 0 }),
          applyEdit: () => {},
        }),
    })
    const results = jsonValue(out)
    const deltaResult = results?.find(
      (result) => result.hookName === 'diagnostic-delta',
    )
    expect(deltaResult).toMatchObject({
      validationStatus: 'diagnostic_delta_passed',
    })
  })

  test.each([
    { rejected: false as const },
    { rejected: false as const, diagnosticStatus: 'passed' as const },
  ])('legacy or unsupported pass assertions remain unknown', async (result) => {
    const { run } = fakeRunner({ 'tsc --noEmit': { exitCode: 0 } })
    const out = await runCapturedHooks({
      files: ['src/a.ts'],
      cwd: '/repo',
      env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: 'true' },
      diagnosticPreflightEnabled: true,
      hooks: baseHooks,
      runCommand: run,
      diagnosticDelta: async () => result,
    })
    expect(
      jsonValue(out)!.find((row) => row.hookName === 'diagnostic-delta'),
    ).toMatchObject({ validationStatus: 'diagnostic_delta_unknown' })
  })

  test('flag ON keeps unsupported files visible to the delta preflight', async () => {
    const { run } = fakeRunner({ 'tsc --noEmit': { exitCode: 0 } })
    let deltaInvoked = false
    await runCapturedHooks({
      files: ['README.md'],
      cwd: '/repo',
      env: { OPENBUFF_DIAGNOSTIC_PREFLIGHT: '1' },
      diagnosticPreflightEnabled: true,
      hooks: baseHooks,
      runCommand: run,
      diagnosticDelta: async () => {
        deltaInvoked = true
        return { rejected: false }
      },
    })
    expect(deltaInvoked).toBe(true)
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
        pid: 42_424_001, stdout, kill: () => true,
      }) as unknown as ChildProcess
      process.nextTick(() => {
        const spec = results[file]
        if (spec === 'error') {
          child.emit('error', new Error('spawn ENOENT'))
          child.emit('close', -1)
          return
        }
        child.emit('spawn')
        if (spec?.stdout) stdout.emit('data', spec.stdout)
        child.emit('close', spec?.exitCode ?? 0)
      })
      return child
    }
    return { spawn: spawn as unknown as CodebuffSpawn, calls }
  }

  test('runs preflightDiagnosticDelta over the argv-array child-process seam', async () => {
    const { spawn, calls } = fakeSpawn({})
    const hook = createMediatedDeltaHook({ spawn })
    const result = await hook({ files: ['src/a.ts'], cwd: '/repo', env: {} })
    // No tool output -> empty baseline and after-capture -> acceptance; a
    // hook-seam preflight never fabricates a rejection.
    expect(result).toMatchObject({ rejected: false })
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
    const hook = createMediatedDeltaHook({ spawn })
    await hook({ files: ['src/a.ts'], cwd: '/repo', env: {} })
    // The hook seam's applyEdit is a no-op, so each diagnostic command must
    // run exactly once per hook invocation — not once per capture (twice).
    const tscCalls = calls.filter((call) => call.file === 'tsc')
    const eslintCalls = calls.filter((call) => call.file === 'eslint')
    expect(tscCalls).toHaveLength(1)
    expect(eslintCalls).toHaveLength(1)
  })

  test('is fail-open: a throwing preflight preserves unknown observation', async () => {
    const { spawn } = fakeSpawn({})
    const hook = createMediatedDeltaHook({
      spawn,
      preflight: (async () => {
        throw new Error('preflight exploded')
      }) as unknown as typeof preflightDiagnosticDelta,
    })
    await expect(
      hook({ files: ['src/a.ts'], cwd: '/repo' }),
    ).resolves.toMatchObject({ rejected: false, diagnosticStatus: 'unknown' })
  })

  test('an absent diagnostic tool yields no diagnostics and no rejection', async () => {
    const { spawn } = fakeSpawn({ tsc: 'error' })
    const hook = createMediatedDeltaHook({ spawn })
    const result = await hook({ files: ['src/a.ts'], cwd: '/repo' })
    expect(result).toMatchObject({ rejected: false })
  })

  test('forwards a captured baseline and drops skipSecondCapture', async () => {
    // P3 audit fix D: with a baseline provider, the preflight must receive the
    // baseline and must NOT skip the after-capture, so the reject path is
    // reachable in production.
    const seen: Array<Record<string, unknown>> = []
    const spyPreflight = (async (params: Record<string, unknown>) => {
      seen.push(params)
      return { rejected: false }
    }) as unknown as typeof preflightDiagnosticDelta
    const baseline = [makeDiagnostic()]
    const hook = createMediatedDeltaHook({
      spawn: fakeSpawn({}).spawn,
      preflight: spyPreflight,
      getBaseline: () => baseline,
    })
    await hook({ files: ['src/a.ts'], cwd: '/repo', env: {} })
    expect(seen).toHaveLength(1)
    expect(seen[0].baseline).toEqual(baseline)
    expect(seen[0].skipSecondCapture).toBeUndefined()
  })

  test('without a baseline keeps the no-op + skipSecondCapture behavior', async () => {
    const seen: Array<Record<string, unknown>> = []
    const spyPreflight = (async (params: Record<string, unknown>) => {
      seen.push(params)
      return { rejected: false }
    }) as unknown as typeof preflightDiagnosticDelta
    const hook = createMediatedDeltaHook({
      spawn: fakeSpawn({}).spawn,
      preflight: spyPreflight,
      getBaseline: () => undefined,
    })
    await hook({ files: ['src/a.ts'], cwd: '/repo', env: {} })
    expect(seen).toHaveLength(1)
    expect(seen[0].baseline).toBeUndefined()
    expect(seen[0].skipSecondCapture).toBe(true)
  })

  test('a throwing baseline provider retains unknown evidence instead of fabricating a new baseline', async () => {
    const hook = createMediatedDeltaHook({
      spawn: fakeSpawn({}).spawn,
      getBaseline: () => {
        throw new Error('baseline failed')
      },
    })
    expect(
      await hook({ files: ['src/a.ts'], cwd: '/repo', env: {} }),
    ).toMatchObject({
      rejected: false,
      diagnosticStatus: 'unknown',
      observations: { reason: 'baseline_capture_failed' },
    })
  })

  test('with a baseline, a NEW error in the after-state produces a rejection', async () => {
    // The previously unreachable production path: a real pre-edit baseline
    // plus a real after-capture means a genuinely new error now rejects.
    const { spawn } = fakeSpawn({
      tsc: { exitCode: 2, stdout: 'src/a.ts(1,1): error TS2: brand new error' },
    })
    const hook = createMediatedDeltaHook({
      spawn,
      getBaseline: () => observedBaseline([], ['src/a.ts']),
    })
    const result = await hook({ files: ['src/a.ts'], cwd: '/repo', env: {} })
    expect(result?.rejected).toBe(true)
  })

  test('with a baseline, pre-existing errors are still tolerated (accepted)', async () => {
    // The baseline holds the same-code error (under both possible path
    // spellings the parser may emit), so the identical after-state is
    // tolerated and the edit is accepted.
    const { spawn } = fakeSpawn({
      tsc: {
        exitCode: 2,
        stdout: 'src/a.ts(1,1): error TS1: pre-existing error',
      },
    })
    const hook = createMediatedDeltaHook({
      spawn,
      getBaseline: () =>
        observedBaseline(
          [
            makeDiagnostic({ file: 'src/a.ts', code: 'TS1' }),
            makeDiagnostic({ file: '/repo/src/a.ts', code: 'TS1' }),
          ],
          ['src/a.ts'],
        ),
    })
    const result = await hook({ files: ['src/a.ts'], cwd: '/repo', env: {} })
    expect(result).toMatchObject({ rejected: false })
  })

  test('without a baseline the same new error still never rejects (unchanged)', async () => {
    // No-baseline behavior must stay byte-identical: the after-capture is
    // skipped, the delta collapses to empty, and the hook reports acceptance
    // even though the on-disk state contains an error.
    const { spawn } = fakeSpawn({
      tsc: { exitCode: 2, stdout: 'src/a.ts(1,1): error TS2: brand new error' },
    })
    const hook = createMediatedDeltaHook({ spawn })
    const result = await hook({ files: ['src/a.ts'], cwd: '/repo', env: {} })
    expect(result).toMatchObject({ rejected: false })
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
        pid: 42_424_001, stdout, kill: () => true,
      }) as unknown as ChildProcess
      process.nextTick(() => {
        child.emit('spawn')
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
    const runCommand = createMediatedDiagnosticRunner({
      spawn: bufferSpawn([
        Buffer.from('prefix '),
        emoji.subarray(0, 2),
        emoji.subarray(2),
        Buffer.from(' suffix'),
      ]),
    })
    const result = await runCommand({
      command: 'tsc --noEmit --pretty false',
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
    const emojiCount = Math.ceil(
      (MAX_CAPTURED_STREAM_BYTES + 64) / emoji.length,
    )
    const payload = Buffer.concat(
      Array.from({ length: emojiCount }, () => emoji),
    )
    const chunks: Buffer[] = []
    for (let i = 0; i < payload.length; i += 63) {
      chunks.push(payload.subarray(i, i + 63))
    }
    const runCommand = createMediatedDiagnosticRunner({
      spawn: bufferSpawn(chunks),
    })
    const result = await runCommand({
      command: 'tsc --noEmit --pretty false',
      cwd: '/repo',
      timeoutSeconds: 5,
    })
    // Exactly the named byte cap is retained, and the truncation boundary
    // lands on a whole emoji (cap is divisible by 4), so no U+FFFD appears.
    expect(Buffer.byteLength(result.stdout ?? '', 'utf8')).toBe(
      MAX_CAPTURED_STREAM_BYTES,
    )
    expect(result.stdout).toBe('😀'.repeat(MAX_CAPTURED_STREAM_BYTES / 4))
    expect(result.outputTruncated).toBe(true)
    expect(result.stdout).not.toContain('\uFFFD')
  })
})

// ---------------------------------------------------------------------------
// createDiagnosticCommandRunner — immediate deadline termination
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
        pid: 42_424_001, stdout,
        kill: (signal?: string) => {
          signals.push(signal ?? 'SIGTERM')
          if (signal === 'SIGKILL') {
            // A SIGTERM-ignoring child only terminates on SIGKILL.
            process.nextTick(() => child.emit('close', null))
          }
          return true
        },
      }) as unknown as ChildProcess
      process.nextTick(() => child.emit('spawn'))
      return child
    }) as unknown as CodebuffSpawn
    return { spawn, signals }
  }

  test('a synchronous successful close during timeout kill cannot erase the timeout', async () => {
    const spawn = (() => {
      const child = Object.assign(new EventEmitter(), {
        pid: 42_424_001, stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => {
          child.emit('close', 0)
          return true
        },
      })
      process.nextTick(() => child.emit('spawn'))
      return child as unknown as ChildProcess
    }) as CodebuffSpawn
    const run = createMediatedDiagnosticRunner({ spawn, sigtermGraceMs: 5 })
    const result = await run({
      command: 'tsc --noEmit --pretty false',
      cwd: '/repo',
      timeoutSeconds: 0.01,
    })
    expect(result.timedOut).toBe(true)
  })

  test('settles and kills immediately at the captured resource deadline', async () => {
    const { spawn, signals } = sigtermIgnoringSpawn()
    const runCommand = createMediatedDiagnosticRunner({
      spawn,
      sigtermGraceMs: 25,
    })
    const started = performance.now()
    const result = await runCommand({
      command: 'tsc --noEmit --pretty false',
      cwd: '/repo',
      timeoutSeconds: 0.05,
    })
    // Deadline exhaustion settles the result and requests SIGKILL immediately.
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(result.timedOut).toBe(true)
    // Waiting past the cancellation grace also checks that no second kill is armed.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(signals).toEqual(['SIGKILL'])
  })
})

describe('B19 diagnostic launch controls', () => {
  const vectors = [
    ['tsc --noEmit --pretty false', 'tsc', ['--noEmit', '--pretty', 'false']],
    ['eslint --format=json .', 'eslint', ['--format=json', '.']],
    ['ruff check --output-format=json', 'ruff', ['check', '--output-format=json']],
    ['pyright --outputjson', 'pyright', ['--outputjson']],
    ['cargo check --message-format=json', 'cargo', ['check', '--message-format=json']],
    ['go vet ./...', 'go', ['vet', './...']],
  ] as const

  for (const [command, executable, argv] of vectors) {
    for (const phase of ['baseline', 'current', 'after'] as const) {
      test(`diagnostic.${executable}.${phase} binds exact argv, env and remaining cap`, async () => {
        const manual = createControlledExecutionClock()
        const recorder = createExecutionProcessRecorder()
        const host = createTerminalExecutionFixture({
          ...manual, projectRoot: '/repo', spawn: recorder.spawn,
          actionLimit: { kind: 'finite', durationMs: 100 },
          authorize: () => {
            manual.advance(20)
            return { ok: true, basis: 'explicit-policy', decisionId: 'diagnostic-control' }
          },
        })
        executionHosts.push(host)
        const run = createDiagnosticCommandRunner({ spawn: recorder.spawn })
        const result = await run({
          command, phase, cwd: '/repo', timeoutSeconds: 0.08,
          env: { PROJECT_VALUE: 'diagnostic-overlay', OPENAI_API_KEY: 'reinsert-attempt' },
          executionContext: host.context,
        })
        expect(result.exitCode).toBe(0)
        expect(recorder.calls).toHaveLength(1)
        const actual = recorder.calls[0]
        expect(actual.executable).toBe(executable)
        expect(actual.argv).toEqual(argv)
        expect(actual.options).toMatchObject({ cwd: '/repo', shell: false, detached: false, windowsHide: false })
        expect(actual.options.env?.PROJECT_VALUE).toBe('diagnostic-overlay')
        expect(actual.options.env?.OPENAI_API_KEY).toBeUndefined()
        expect(actual.options.env?.CUSTOM_PROVIDER_KEY).toBeUndefined()
        expect(Object.isFrozen(actual.options.env)).toBe(true)
        expect(actual.options.signal).not.toBe(host.context.signal)
        const input = host.policyInputs[0]
        expect(input.facts.branchId).toBe(`diagnostic.${executable}.${phase}`)
        expect(input.target.argv).toEqual(actual.argv)
        expect(input.target.adapterOptions.phase).toBe(phase)
        expect(executionDeadlineMs(input.facts.deadlines.resourceLifetime)! - manual.clock.nowMs()).toBe(60)
        expect(host.events.filter(event => event.phase === 'spawn-observed')).toHaveLength(1)
      })
    }
  }

  test.each([
    ['', 'EMPTY_COMMAND'],
    ['__proto__', 'UNSUPPORTED_COMMAND'],
    ['constructor', 'UNSUPPORTED_COMMAND'],
    ['toString', 'UNSUPPORTED_COMMAND'],
    ['tsc --noEmit', 'UNSUPPORTED_COMMAND'],
    [' tsc --noEmit --pretty false', 'UNSUPPORTED_COMMAND'],
    ['tsc --noEmit --pretty false; printf extra', 'UNSUPPORTED_COMMAND'],
  ] as const)('unsupported diagnostic bytes %j never launch', async (command, errorCode) => {
    const recorder = createExecutionProcessRecorder()
    const host = createTerminalExecutionFixture({ projectRoot: '/repo', spawn: recorder.spawn })
    executionHosts.push(host)
    const run = createDiagnosticCommandRunner({ spawn: recorder.spawn })
    const result = await run({ command, cwd: '/repo', timeoutSeconds: 1, executionContext: host.context })
    expect(result).toMatchObject({ errorCode, executionRefusal: { reason: 'unavailable' } })
    expect(recorder.calls).toHaveLength(0)
    expect(host.policyInputs).toHaveLength(0)
  })

  test.each([
    ['missing', 'unavailable'],
    ['denied', 'denied'],
    ['expired', 'deadline-exhausted'],
    ['fabricated', 'stale-authority'],
    ['cancelled', 'cancelled'],
  ] as const)('%s diagnostic context refuses with zero spawn', async (kind, reason) => {
    const manual = createControlledExecutionClock()
    const recorder = createExecutionProcessRecorder()
    const abort = new AbortController()
    const host = createTerminalExecutionFixture({
      ...manual, projectRoot: '/repo', spawn: recorder.spawn, signal: abort.signal,
      actionLimit: { kind: 'finite', durationMs: 50 },
      ...(kind === 'denied' ? { authorize: () => executionRefusal('denied', 'controlled diagnostic denial') } : {}),
    })
    executionHosts.push(host)
    let executionContext: ExecutionAdapterContext | undefined = host.context
    if (kind === 'missing') executionContext = undefined
    if (kind === 'fabricated') executionContext = { ...host.context, execution: { ...host.context.execution } }
    if (kind === 'expired') manual.advance(50)
    if (kind === 'cancelled') abort.abort(new Error('diagnostic request cancelled'))
    const run = createDiagnosticCommandRunner({ spawn: recorder.spawn })
    const result = await run({ command: vectors[0][0], cwd: '/repo', timeoutSeconds: -1, executionContext })
    expect(result.executionRefusal).toMatchObject({ reason })
    expect(recorder.calls).toHaveLength(0)
    expect(host.events.some(event => event.phase === 'dispatched')).toBe(false)
  })

  test.each(['cancelled', 'deadline-exhausted'] as const)('%s during diagnostic admission grants no spawn', async reason => {
    const manual = createControlledExecutionClock()
    const abort = new AbortController()
    const recorder = createExecutionProcessRecorder()
    let allow!: (decision: AsyncDecision) => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const decision = new Promise<AsyncDecision>(resolve => { allow = resolve })
    const host = createTerminalExecutionFixture({
      ...manual, projectRoot: '/repo', spawn: recorder.spawn, signal: abort.signal,
      authorize: () => { entered(); return decision },
    })
    executionHosts.push(host)
    const run = createDiagnosticCommandRunner({ spawn: recorder.spawn })
    const pending = run({ command: vectors[0][0], cwd: '/repo', timeoutSeconds: 0.05, executionContext: host.context })
    await waiting
    if (reason === 'cancelled') abort.abort(new Error('cancelled while waiting'))
    else manual.advance(50)
    allow({ ok: true, basis: 'explicit-policy', decisionId: 'late-diagnostic-allow' })
    expect((await pending).executionRefusal).toMatchObject({ reason })
    expect(recorder.calls).toHaveLength(0)
  })

  test.each([80, 100])('queued diagnostics retain their original 100ms cap after %sms', async delay => {
    const manual = createControlledExecutionClock()
    const recorder = createExecutionProcessRecorder({ autoClose: false })
    const host = createTerminalExecutionFixture({ ...manual, projectRoot: '/repo', spawn: recorder.spawn })
    executionHosts.push(host)
    const env = { PROJECT_VALUE: 'before-queue' }
    const files = ['src/a.ts', 'src/a.py']
    const runCommand = createDiagnosticCommandRunner({ spawn: recorder.spawn })
    const pending = captureDiagnosticObservation({
      files, cwd: '/repo', env, timeoutSeconds: 0.1,
      runCommand, executionContext: host.context, phase: 'current',
    })
    const waitForCalls = async (count: number) => {
      for (let turn = 0; recorder.calls.length < count && turn < 50; turn++) {
        await new Promise(resolve => setImmediate(resolve))
      }
      expect(recorder.calls).toHaveLength(count)
    }
    await waitForCalls(2)
    env.PROJECT_VALUE = 'after-queue'
    files.splice(0, files.length, 'src/changed.go')
    manual.advance(delay)
    if (delay === 80) {
      recorder.calls[0].finish()
      recorder.calls[1].finish()
      await waitForCalls(4)
      for (const actual of recorder.calls.slice(2)) expect(actual.options.env?.PROJECT_VALUE).toBe('before-queue')
      const queued = host.policyInputs.filter(input => input.target.executable === 'ruff' || input.target.executable === 'pyright')
      expect(queued).toHaveLength(2)
      for (const input of queued) {
        expect(executionDeadlineMs(input.facts.deadlines.resourceLifetime)! - manual.clock.nowMs()).toBe(20)
      }
      manual.advance(20)
    }
    const capture = await pending
    expect(capture.commands.map(command => command.command)).toEqual(vectors.slice(0, 4).map(vector => vector[0]))
    expect(capture.commands.slice(2).every(command => command.status === 'timed_out')).toBe(true)
    expect(recorder.calls).toHaveLength(delay === 100 ? 2 : 4)
    for (const [index, actual] of recorder.calls.entries()) {
      expect(actual.signals).toEqual(delay === 80 && index < 2 ? [] : ['SIGKILL'])
    }
  })

  test('preflight and hook producers retain baseline, after and current phase attribution', async () => {
    const recorder = createExecutionProcessRecorder({ reply: executable => ({ stdout: executable === 'eslint' ? '[]' : '' }) })
    const host = createTerminalExecutionFixture({ projectRoot: '/repo', spawn: recorder.spawn })
    executionHosts.push(host)
    const runCommand = createDiagnosticCommandRunner({ spawn: recorder.spawn })
    await preflightDiagnosticDelta({
      files: ['src/a.ts'], cwd: '/repo', applyEdit: () => {}, runCommand, executionContext: host.context,
    })
    const hook = createDiagnosticDeltaHook({ spawn: recorder.spawn })
    await hook({ files: ['src/a.ts'], cwd: '/repo', executionContext: host.context })
    expect(host.policyInputs.map(input => input.facts.branchId)).toEqual([
      'diagnostic.tsc.baseline', 'diagnostic.eslint.baseline',
      'diagnostic.tsc.after', 'diagnostic.eslint.after',
      'diagnostic.tsc.current', 'diagnostic.eslint.current',
    ])
  })

  test('delta hook captures files, env and mode before awaiting its baseline', async () => {
    const recorder = createExecutionProcessRecorder({ reply: executable => ({
      stdout: executable === 'tsc' ? 'src/a.ts(8,1): error TS2322: type mismatch\n' : '[]',
      exitCode: executable === 'tsc' ? 2 : 0,
    }) })
    const host = createTerminalExecutionFixture({ projectRoot: '/repo', spawn: recorder.spawn })
    executionHosts.push(host)
    let release!: (value: DiagnosticCapture) => void
    let entered!: () => void
    const baseline = new Promise<DiagnosticCapture>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const factory: Parameters<typeof createDiagnosticDeltaHook>[0] = {
      spawn: recorder.spawn, deltaMode: 'tolerant', getBaseline: () => { entered(); return baseline },
    }
    const hook = createDiagnosticDeltaHook(factory)
    const files = ['src/a.ts']
    const env = { PROJECT_VALUE: 'before-baseline' }
    const pending = hook({ files, env, cwd: '/repo', executionContext: host.context })
    await waiting
    files[0] = 'src/late.py'
    env.PROJECT_VALUE = 'after-baseline'
    factory.deltaMode = 'strict'
    factory.getBaseline = () => undefined
    release(observedBaseline([makeDiagnostic({
      file: 'src/a.ts', code: 'TS2322', source: 'tsc', command: vectors[0][0], message: 'type mismatch',
      range: { start: { line: 2, column: 1 }, end: { line: 2, column: 1 } },
    })], ['src/a.ts']))
    const result = await pending
    expect(result?.rejected).toBe(false)
    expect(host.policyInputs.map(input => input.facts.branchId)).toEqual(['diagnostic.tsc.after', 'diagnostic.eslint.after'])
    for (const actual of recorder.calls) expect(actual.options.env?.PROJECT_VALUE).toBe('before-baseline')
  })
})
