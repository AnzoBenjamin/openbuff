import { describe, expect, test } from 'bun:test'
import { terminalCommandOutputSchema } from '../tool/run-terminal-command'
import { runFileChangeHooksParams } from '../tool/run-file-change-hooks'

describe('terminal result projection preserves execution outcomes', () => {
  test('keeps no-launch refusals and timed-out output artifacts', () => {
    const refusal = { ok: false as const, reason: 'deadline-exhausted' as const, cause: 'Local deadline exhausted' }
    const value = { command: 'printf partial', errorMessage: refusal.cause, executionRefusal: refusal,
      timedOut: true, stdout: 'partial', exitCode: -1, fullLogPath: '/tmp/terminal-output.log', logBytes: 7,
      logPersisted: true, executionBindingVersion: 2 as const, executionBindingDigest: 'binding' }
    expect(terminalCommandOutputSchema.parse(value)).toEqual(value)
  })

  test('keeps observed background start and owning launch metadata', () => {
    const value = { command: 'sleep 1', processId: 123, backgroundProcessStatus: 'running' as const,
      startingCwd: '/project', detached: true, jobId: 'job', logFile: '/tmp/job.log',
      executionBindingVersion: 2 as const, executionBindingDigest: 'binding' }
    expect(terminalCommandOutputSchema.parse(value)).toEqual(value)
  })

  test('keeps omitted-output status and excerpts', () => {
    const value = { command: 'printf output', stdoutOmittedForLength: true as const, status: 'failed' as const,
      stdoutExcerpt: 'head', stderrExcerpt: 'error', exitCode: 1, fullLogPath: '/tmp/full.log' }
    expect(terminalCommandOutputSchema.parse(value)).toEqual(value)
  })

  test('keeps diagnostic phase and refusal through hook output parsing', () => {
    const executionRefusal = { ok: false as const, reason: 'unavailable' as const, cause: 'Selected execution backend is unavailable' }
    const value = { hookName: 'diagnostic-delta', validationStatus: 'diagnostic_delta_unavailable',
      diagnosticStatus: 'unavailable', executionRefusal, observations: { basis: 'current_only', after: {
        diagnostics: [], commands: [{ command: 'tsc', status: 'unavailable', phase: 'current', executionRefusal,
          outputTruncated: false, diagnosticCount: 0, coverageStatus: 'unavailable' }],
        coverage: { status: 'unavailable', requestedFiles: ['a.ts'], observedFiles: [], unobservedFiles: ['a.ts'], reasons: [executionRefusal.cause] },
      } } }
    expect(runFileChangeHooksParams.outputSchema.parse([{ type: 'json', value: [value] }])).toEqual([{ type: 'json', value: [value] }])
  })
})
