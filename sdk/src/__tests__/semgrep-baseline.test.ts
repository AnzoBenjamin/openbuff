import { beforeEach, describe, expect, test } from 'bun:test'

import {
  clearSemgrepAvailabilityCache,
  MAX_SEMGREP_FILES,
  runSemgrepBaseline,
} from '../services/semgrep-baseline'

import type { SemgrepRunner } from '../services/semgrep-baseline'

const EMPTY_SARIF = JSON.stringify({
  version: '2.1.0',
  runs: [{ tool: { driver: { name: 'semgrep' } }, results: [] }],
})

const SARIF_WITH_FINDING = JSON.stringify({
  version: '2.1.0',
  runs: [
    {
      tool: {
        driver: {
          name: 'semgrep',
          rules: [
            {
              id: 'python.lang.security.audit.exec-detected',
              name: 'exec-detected',
            },
          ],
        },
      },
      results: [
        {
          ruleId: 'python.lang.security.audit.exec-detected',
          level: 'error',
          message: { text: 'Detected the use of exec().' },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: 'app.py' },
                region: {
                  startLine: 4,
                  startColumn: 1,
                  endLine: 4,
                  endColumn: 5,
                },
              },
            },
          ],
        },
      ],
    },
  ],
})

const versionOk = { exitCode: 0, stdout: '1.45.0\n', stderr: '' }

const availableRunner =
  (
    scan: (argv: string[]) => {
      exitCode: number
      stdout: string
      stderr: string
    },
  ): SemgrepRunner =>
  (argv) =>
    argv[0] === '--version' ? versionOk : scan(argv)

describe('runSemgrepBaseline', () => {
  beforeEach(() => {
    clearSemgrepAvailabilityCache()
  })

  test('reports semgrep-not-found when the binary is absent', () => {
    const calls: string[][] = []
    const runner: SemgrepRunner = (argv) => {
      calls.push(argv)
      return { exitCode: -1, stdout: '', stderr: 'spawn semgrep ENOENT' }
    }
    const result = runSemgrepBaseline({
      cwd: '/tmp/semgrep-test-unavailable',
      baselineCommit: 'abc1234',
      files: ['a.py'],
      runner,
    })
    expect(result).toEqual({
      status: 'unavailable',
      reason: 'semgrep-not-found',
      findings: [],
    })
    expect(calls).toEqual([['--version']])
  })

  test('caches the availability probe per cwd', () => {
    let versionCalls = 0
    const runner: SemgrepRunner = (argv) => {
      if (argv[0] === '--version') {
        versionCalls += 1
        return versionOk
      }
      return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
    }
    const params = {
      cwd: '/tmp/semgrep-test-cache',
      baselineCommit: 'abc1234',
      files: ['a.py'],
      runner,
    }
    runSemgrepBaseline(params)
    runSemgrepBaseline(params)
    expect(versionCalls).toBe(1)
  })

  test('parses SARIF stdout into findings on a clean run', () => {
    let scanArgv: string[] = []
    const runner = availableRunner((argv) => {
      scanArgv = argv
      return { exitCode: 0, stdout: SARIF_WITH_FINDING, stderr: '' }
    })
    const result = runSemgrepBaseline({
      cwd: '/tmp/semgrep-test-ok',
      baselineCommit: 'abc1234',
      files: ['app.py'],
      runner,
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.toolVersion).toBe('1.45.0')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      file: 'app.py',
      severity: 'error',
      code: 'python.lang.security.audit.exec-detected',
      message: 'Detected the use of exec().',
      source: 'sarif',
      range: { start: { line: 4, column: 1 }, end: { line: 4, column: 5 } },
    })
    expect(scanArgv).toEqual([
      'scan',
      '--baseline-commit=abc1234',
      '--sarif',
      '--quiet',
      '--metrics=off',
      '--no-git-ignore',
      '--include',
      'app.py',
    ])
  })

  test('surfaces a bounded stderr snippet on nonzero exit', () => {
    const runner = availableRunner(() => ({
      exitCode: 7,
      stdout: '',
      stderr: `boom ${'x'.repeat(1_000)}`,
    }))
    const result = runSemgrepBaseline({
      cwd: '/tmp/semgrep-test-nonzero',
      baselineCommit: 'abc1234',
      files: ['a.py'],
      runner,
    })
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.reason).toContain('exit code 7')
    expect(result.reason).toContain('boom')
    expect(result.reason.length).toBeLessThan(500)
    expect(result.findings).toEqual([])
  })

  test('rejects an invalid baseline ref without invoking the runner', () => {
    let called = false
    const runner: SemgrepRunner = () => {
      called = true
      return versionOk
    }
    const result = runSemgrepBaseline({
      cwd: '/tmp/semgrep-test-invalid-ref',
      baselineCommit: 'main; rm -rf /',
      files: ['a.py'],
      runner,
    })
    expect(result).toEqual({
      status: 'error',
      reason: 'invalid-baseline-commit',
      findings: [],
    })
    expect(called).toBe(false)
  })

  test('accepts hex shas and safe ref names', () => {
    const refs = ['abc1234', 'a'.repeat(40), 'HEAD~1', 'origin/main']
    const seen: string[] = []
    refs.forEach((baselineCommit, index) => {
      const runner = availableRunner((argv) => {
        seen.push(argv[1])
        return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
      })
      const result = runSemgrepBaseline({
        cwd: `/tmp/semgrep-test-refs-${index}`,
        baselineCommit,
        files: ['a.py'],
        runner,
      })
      expect(result.status).toBe('ok')
    })
    expect(seen).toEqual(refs.map((ref) => `--baseline-commit=${ref}`))
  })

  test('caps --include patterns at the file budget', () => {
    let scanArgv: string[] = []
    const runner = availableRunner((argv) => {
      scanArgv = argv
      return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
    })
    const files = Array.from({ length: 250 }, (_, i) => `src/file-${i}.py`)
    const result = runSemgrepBaseline({
      cwd: '/tmp/semgrep-test-cap',
      baselineCommit: 'abc1234',
      files,
      runner,
    })
    expect(result.status).toBe('ok')
    const includes = scanArgv.filter(
      (_, index) => scanArgv[index - 1] === '--include',
    )
    expect(includes).toHaveLength(MAX_SEMGREP_FILES)
    expect(includes[0]).toBe('src/file-0.py')
    expect(includes.at(-1)).toBe('src/file-199.py')
  })

  test('reports semgrep-timeout when the scan is killed by the deadline', () => {
    let seenTimeout = 0
    const runner: SemgrepRunner = (argv, _cwd, timeoutMs) => {
      if (argv[0] === '--version') return versionOk
      seenTimeout = timeoutMs
      return { exitCode: -1, stdout: '', stderr: '', signal: 'SIGTERM' }
    }
    const result = runSemgrepBaseline({
      cwd: '/tmp/semgrep-test-timeout',
      baselineCommit: 'abc1234',
      files: ['a.py'],
      runner,
      timeoutMs: 1_234,
    })
    expect(result).toEqual({
      status: 'error',
      reason: 'semgrep-timeout',
      findings: [],
    })
    expect(seenTimeout).toBe(1_234)
  })
})
