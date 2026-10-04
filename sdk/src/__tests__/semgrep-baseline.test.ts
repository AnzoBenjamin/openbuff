import { beforeEach, describe, expect, test } from 'bun:test'

import {
  clearSemgrepAvailabilityCache,
  makeSpawnRunner,
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

type ScanResult = {
  exitCode: number
  stdout: string
  stderr: string
}

/** Wraps a scan runner so the --version probe always succeeds. The scan
 * function may be sync or async — the runner seam is async. */
const availableRunner =
  (scan: (argv: string[]) => ScanResult | Promise<ScanResult>): SemgrepRunner =>
  async (argv) =>
    argv[0] === '--version' ? versionOk : scan(argv)

describe('runSemgrepBaseline', () => {
  beforeEach(() => {
    clearSemgrepAvailabilityCache()
  })

  test('reports semgrep-not-found when the binary is absent', async () => {
    const calls: string[][] = []
    const runner: SemgrepRunner = async (argv) => {
      calls.push(argv)
      return { exitCode: -1, stdout: '', stderr: 'spawn semgrep ENOENT' }
    }
    const result = await runSemgrepBaseline({
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

  test('caches the availability probe per cwd', async () => {
    let versionCalls = 0
    const runner: SemgrepRunner = async (argv) => {
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
    await runSemgrepBaseline(params)
    await runSemgrepBaseline(params)
    expect(versionCalls).toBe(1)
  })

  test('single-flights concurrent cold-cache availability probes', async () => {
    // perf: semgrep-availability-probe-no-single-flight — concurrent
    // cold-cache callers of runSemgrepBaseline against the same cwd join one
    // in-flight `semgrep --version` probe instead of each spawning their own
    // (3s timeout each), mirroring the scip-runner's inFlightDetections.
    let versionCalls = 0
    const runner: SemgrepRunner = async (argv) => {
      if (argv[0] === '--version') {
        versionCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 30))
        return versionOk
      }
      return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
    }
    const params = {
      cwd: '/tmp/semgrep-test-single-flight',
      baselineCommit: 'abc1234',
      files: ['a.py'],
      runner,
    }
    const [first, second] = await Promise.all([
      runSemgrepBaseline(params),
      runSemgrepBaseline(params),
    ])
    expect(first.status).toBe('ok')
    expect(second.status).toBe('ok')
    expect(versionCalls).toBe(1)
  })

  test('keys the availability cache by the injected runner, not only by cwd', async () => {
    // compat: availability-cache-ignores-injected-runner — two distinct
    // SemgrepRunner implementations used against the same cwd within the TTL
    // must not observe each other's availability verdict through the
    // exported runner seam.
    let unavailableVersionCalls = 0
    const availableRun: SemgrepRunner = async (argv) =>
      argv[0] === '--version'
        ? versionOk
        : { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
    const unavailableRun: SemgrepRunner = async (argv) => {
      if (argv[0] === '--version') {
        unavailableVersionCalls += 1
        return { exitCode: -1, stdout: '', stderr: 'spawn semgrep ENOENT' }
      }
      return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
    }
    const cwd = '/tmp/semgrep-test-runner-keyed-cache'
    const available = await runSemgrepBaseline({
      cwd,
      baselineCommit: 'abc1234',
      files: ['a.py'],
      runner: availableRun,
    })
    expect(available.status).toBe('ok')
    const unavailable = await runSemgrepBaseline({
      cwd,
      baselineCommit: 'abc1234',
      files: ['a.py'],
      runner: unavailableRun,
    })
    expect(unavailable).toEqual({
      status: 'unavailable',
      reason: 'semgrep-not-found',
      findings: [],
    })
    expect(unavailableVersionCalls).toBe(1)
    // Caching still applies within a single runner: a second call with the
    // same runner + cwd must not re-probe.
    const unavailableAgain = await runSemgrepBaseline({
      cwd,
      baselineCommit: 'abc1234',
      files: ['a.py'],
      runner: unavailableRun,
    })
    expect(unavailableAgain.status).toBe('unavailable')
    expect(unavailableVersionCalls).toBe(1)
  })

  test('FIFO-trims the availability cache so it cannot grow without bound', async () => {
    // Insert more distinct cwds than the cache cap; the oldest entries must
    // be evicted (perf: semgrep-availability-cache-unbounded). Eviction is
    // observable: the next probe for an evicted cwd re-runs `--version`.
    const probedCwds: string[] = []
    const runner: SemgrepRunner = async (argv, cwd) => {
      if (argv[0] === '--version') {
        probedCwds.push(cwd)
        return versionOk
      }
      return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
    }
    for (let i = 0; i < 300; i++) {
      await runSemgrepBaseline({
        cwd: `/tmp/semgrep-trim-${i}`,
        baselineCommit: 'abc1234',
        files: [],
        runner,
      })
    }
    // Each distinct cwd probed exactly once during the sweep.
    expect(probedCwds).toHaveLength(300)
    // Re-visiting the OLDEST cwd (evicted long ago by the FIFO cap) must
    // probe again; the NEWEST cwd (still inside the cap) must stay cached.
    await runSemgrepBaseline({
      cwd: '/tmp/semgrep-trim-0',
      baselineCommit: 'abc1234',
      files: [],
      runner,
    })
    await runSemgrepBaseline({
      cwd: '/tmp/semgrep-trim-299',
      baselineCommit: 'abc1234',
      files: [],
      runner,
    })
    const countFor = (cwd: string) =>
      probedCwds.filter((entry) => entry === cwd).length
    expect(countFor('/tmp/semgrep-trim-0')).toBe(2)
    expect(countFor('/tmp/semgrep-trim-299')).toBe(1)
  })

  test('parses SARIF stdout into findings on a clean run', async () => {
    let scanArgv: string[] = []
    const runner = availableRunner((argv) => {
      scanArgv = argv
      return { exitCode: 0, stdout: SARIF_WITH_FINDING, stderr: '' }
    })
    const result = await runSemgrepBaseline({
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

  test('runs the scan without blocking the event loop', async () => {
    let eventLoopTurns = 0
    let eventLoopRan = false
    const interval = setInterval(() => {
      eventLoopTurns += 1
      if (eventLoopTurns >= 3) {
        eventLoopRan = true
        clearInterval(interval)
      }
    }, 5)
    // A deliberately slow scan: while it is in flight the event loop must
    // stay live (spawn/async runner), which the repeating interval proves.
    const runner = availableRunner(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
    })
    const result = await runSemgrepBaseline({
      cwd: '/tmp/semgrep-test-event-loop',
      baselineCommit: 'abc1234',
      files: ['a.py'],
      runner,
    })
    clearInterval(interval)
    expect(result.status).toBe('ok')
    expect(eventLoopRan).toBe(true)
  })

  test('skips the scan entirely when the caller captured a before-bundle', async () => {
    let called = false
    const runner: SemgrepRunner = async () => {
      called = true
      return versionOk
    }
    const result = await runSemgrepBaseline({
      cwd: '/tmp/semgrep-test-skip',
      baselineCommit: 'abc1234',
      files: ['a.py'],
      runner,
      skipScan: true,
    })
    expect(result).toEqual({
      status: 'skipped',
      reason: 'before-bundle-skipped',
      findings: [],
    })
    expect(called).toBe(false)
  })

  test('surfaces a bounded stderr snippet on nonzero exit', async () => {
    const runner = availableRunner(() => ({
      exitCode: 7,
      stdout: '',
      stderr: `boom ${'x'.repeat(1_000)}`,
    }))
    const result = await runSemgrepBaseline({
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

  test('rejects an invalid baseline ref without invoking the runner', async () => {
    let called = false
    const runner: SemgrepRunner = async () => {
      called = true
      return versionOk
    }
    const result = await runSemgrepBaseline({
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

  test('accepts hex shas and safe ref names', async () => {
    const refs = ['abc1234', 'a'.repeat(40), 'origin/main', 'release-1.2']
    const seen: string[] = []
    for (const [index, baselineCommit] of refs.entries()) {
      const runner = availableRunner((argv) => {
        seen.push(argv[1])
        return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
      })
      const result = await runSemgrepBaseline({
        cwd: `/tmp/semgrep-test-refs-${index}`,
        baselineCommit,
        files: ['a.py'],
        runner,
      })
      expect(result.status).toBe('ok')
    }
    expect(seen).toEqual(refs.map((ref) => `--baseline-commit=${ref}`))
  })

  test('rejects a traversal-shaped ref without invoking the runner', async () => {
    let called = false
    const runner: SemgrepRunner = async () => {
      called = true
      return versionOk
    }
    const result = await runSemgrepBaseline({
      cwd: '/tmp/semgrep-test-traversal-ref',
      baselineCommit: 'a~../../x',
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

  test('rejects a ref containing ".." without invoking the runner', async () => {
    let called = false
    const runner: SemgrepRunner = async () => {
      called = true
      return versionOk
    }
    const refs = ['../../etc/passwd', 'a../b', 'safe/../ref']
    for (const [index, baselineCommit] of refs.entries()) {
      const result = await runSemgrepBaseline({
        cwd: `/tmp/semgrep-test-dotdot-${index}`,
        baselineCommit,
        files: ['a.py'],
        runner,
      })
      expect(result).toEqual({
        status: 'error',
        reason: 'invalid-baseline-commit',
        findings: [],
      })
    }
    expect(called).toBe(false)
  })

  test('accepts a ref with a trailing slash (compat contract)', async () => {
    let seenRef = ''
    const runner = availableRunner((argv) => {
      seenRef = argv[1]
      return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
    })
    const result = await runSemgrepBaseline({
      cwd: '/tmp/semgrep-test-trailing-slash',
      baselineCommit: 'origin/main/',
      files: ['a.py'],
      runner,
    })
    expect(result.status).toBe('ok')
    expect(seenRef).toBe('--baseline-commit=origin/main/')
  })

  test('accepts the documented HEAD~N shorthand (compat contract)', async () => {
    // HEAD~N remains part of the documented contract for direct callers of
    // runSemgrepBaseline; only bounded digit suffixes are accepted so the
    // 'a~../../x' traversal vector stays rejected.
    const refs = ['HEAD~1', 'HEAD~12']
    const seen: string[] = []
    for (const [index, baselineCommit] of refs.entries()) {
      const runner = availableRunner((argv) => {
        seen.push(argv[1])
        return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
      })
      const result = await runSemgrepBaseline({
        cwd: `/tmp/semgrep-test-head-tilde-${index}`,
        baselineCommit,
        files: ['a.py'],
        runner,
      })
      expect(result.status).toBe('ok')
    }
    expect(seen).toEqual(refs.map((ref) => `--baseline-commit=${ref}`))
  })

  test('accepts bounded branch~N refs (compat contract)', async () => {
    // Direct callers may hand a conservative ref name with a bounded digit
    // tilde suffix straight to the scan; the ref travels as a single argv
    // token, so this is safe as long as `..` and non-digit tilde suffixes
    // stay rejected.
    const refs = ['main~1', 'release-1.2~10']
    const seen: string[] = []
    for (const [index, baselineCommit] of refs.entries()) {
      const runner = availableRunner((argv) => {
        seen.push(argv[1])
        return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
      })
      const result = await runSemgrepBaseline({
        cwd: `/tmp/semgrep-test-branch-tilde-${index}`,
        baselineCommit,
        files: ['a.py'],
        runner,
      })
      expect(result.status).toBe('ok')
    }
    expect(seen).toEqual(refs.map((ref) => `--baseline-commit=${ref}`))
  })

  test('rejects unsafe tilde refs (traversal vector) without invoking the runner', async () => {
    let called = false
    const runner: SemgrepRunner = async () => {
      called = true
      return versionOk
    }
    const refs = ['a~../../x', 'HEAD~~', 'HEAD~1a', 'main~x']
    for (const [index, baselineCommit] of refs.entries()) {
      const result = await runSemgrepBaseline({
        cwd: `/tmp/semgrep-test-tilde-ref-${index}`,
        baselineCommit,
        files: ['a.py'],
        runner,
      })
      expect(result).toEqual({
        status: 'error',
        reason: 'invalid-baseline-commit',
        findings: [],
      })
    }
    expect(called).toBe(false)
  })

  test('caps --include patterns at the file budget', async () => {
    let scanArgv: string[] = []
    const runner = availableRunner((argv) => {
      scanArgv = argv
      return { exitCode: 0, stdout: EMPTY_SARIF, stderr: '' }
    })
    const files = Array.from({ length: 250 }, (_, i) => `src/file-${i}.py`)
    const result = await runSemgrepBaseline({
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
    // The cap is surfaced, not silent.
    expect(result.status === 'ok' && result.truncated).toBe(true)
  })

  test('omits the truncated flag when the file list fits the cap', async () => {
    const runner = availableRunner(() => ({
      exitCode: 0,
      stdout: EMPTY_SARIF,
      stderr: '',
    }))
    const result = await runSemgrepBaseline({
      cwd: '/tmp/semgrep-test-no-truncation',
      baselineCommit: 'abc1234',
      files: ['a.py', 'b.py'],
      runner,
    })
    expect(result.status).toBe('ok')
    expect(result.status === 'ok' && result.truncated).toBeUndefined()
  })

  test('reports semgrep-timeout when the scan is killed by the deadline', async () => {
    let seenTimeout = 0
    const runner: SemgrepRunner = async (argv, _cwd, timeoutMs) => {
      if (argv[0] === '--version') return versionOk
      seenTimeout = timeoutMs
      return { exitCode: -1, stdout: '', stderr: '', signal: 'SIGTERM' }
    }
    const result = await runSemgrepBaseline({
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

  test('spawn runner settles at the deadline even when the child ignores SIGTERM', async () => {
    // perf: semgrep-timeout-relies-on-sigterm-cooperation — the deadline must
    // not depend on the child cooperating with SIGTERM. The promise settles
    // at the deadline itself (spawnSync-compatible shape: exitCode -1 and a
    // SIGTERM signal), and a short grace timer escalates to SIGKILL so a
    // child that trapped SIGTERM cannot outlive the bound.
    const runner = makeSpawnRunner('sh', { sigtermGraceMs: 50 })
    const startedAt = Date.now()
    const result = await runner(
      ['-c', 'trap "" TERM; while :; do sleep 1; done'],
      '/tmp',
      50,
    )
    const elapsed = Date.now() - startedAt
    expect(result.exitCode).toBe(-1)
    expect(result.signal).toBe('SIGTERM')
    expect(result.stderr).toContain('timed out')
    // Settled at the deadline, not stretched by the SIGTERM-ignoring child
    // (generous margin for slow CI; SIGKILL fires at deadline + grace).
    expect(elapsed).toBeLessThan(5_000)
  })
})
