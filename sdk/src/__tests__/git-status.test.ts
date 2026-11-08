import { createMockChildProcess } from '@codebuff/common/testing/mocks'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { gitStatus, runGitBounded } from '../tools/git-status'
import { createRealExecutionProcessRecorder, createTerminalExecutionFixture } from './fixtures/b19-terminal-execution'

import type { MockChildProcess } from '@codebuff/common/testing/mocks'
import type { ChildProcess } from 'node:child_process'

function getErrorMessage(
  result: Awaited<ReturnType<typeof gitStatus>>,
): string {
  const firstEntry = result[0]
  expect(firstEntry.type).toBe('json')
  const value = firstEntry.value as { errorMessage?: string }
  expect(value.errorMessage).toBeDefined()
  return value.errorMessage ?? ''
}

describe('gitStatus', () => {
  let mockSpawn: ReturnType<typeof mock>
  let mockProcess: MockChildProcess
  const hosts: ReturnType<typeof createTerminalExecutionFixture>[] = []
  const context = (signal?: AbortSignal) => {
    const host = createTerminalExecutionFixture({ projectRoot: '/test/project', signal, spawn: mockSpawn })
    hosts.push(host)
    return host.context
  }

  beforeEach(() => {
    mockProcess = createMockChildProcess()
    mockProcess.pid = 42_424_001
    mockSpawn = mock(() => {
      setImmediate(() => mockProcess.emit('spawn'))
      return mockProcess as unknown as ChildProcess
    })
  })

  afterEach(() => {
    mock.restore()
    for (const host of hosts.splice(0)) host.dispose()
  })

  it('returns an error result when spawning git throws synchronously', async () => {
    mockSpawn = mock(() => {
      throw new Error('spawn failed')
    })
    const result = await gitStatus({ cwd: '/test/project', executionContext: context() })

    expect(getErrorMessage(result)).toContain('spawn failed')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  describe('AbortSignal handling', () => {
    it('returns an error without spawning git when already aborted', async () => {
      const controller = new AbortController()
      controller.abort(new Error('caller cancelled'))

      const result = await gitStatus({
        cwd: '/test/project',
        signal: controller.signal,
        executionContext: context(controller.signal),
      })

      expect(getErrorMessage(result)).toContain('caller cancelled')
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('kills the git process and returns an error when aborted mid-flight', async () => {
      const controller = new AbortController()
      const statusPromise = gitStatus({
        cwd: '/test/project',
        signal: controller.signal,
        executionContext: context(controller.signal),
      })

      for (let tries = 0; mockSpawn.mock.calls.length === 0 && tries < 20; tries++) {
        await new Promise(resolve => setImmediate(resolve))
      }
      expect(mockSpawn).toHaveBeenCalledTimes(1)
      controller.abort(new Error('stop git status'))

      const result = await statusPromise
      expect(getErrorMessage(result)).toContain('stop git status')
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM')
    })
  })

  it('retains an unavailable refusal when execution mediation is missing', async () => {
    const result = await gitStatus({ cwd: '/test/project' })
    expect(result[0].value).toMatchObject({ executionRefusal: { reason: 'unavailable' } })
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('retains an unsupported Git runtime failure without retrying an unguarded query', async () => {
    const pending = gitStatus({ cwd: '/test/project', executionContext: context() })
    for (let tries = 0; mockSpawn.mock.calls.length === 0 && tries < 20; tries++) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(mockSpawn.mock.calls[0][1]).toEqual([
      '--no-pager', '--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false',
      'status', '--short', '--branch',
    ])
    mockProcess.stderr.emit('data', Buffer.from('unknown option: --no-lazy-fetch\n'))
    mockProcess.emit('close', 129)
    expect(getErrorMessage(await pending)).toContain('unknown option: --no-lazy-fetch')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })
})

describe('B19 Git status and diff branch captures', () => {
  for (const bounded of [false, true]) {
    for (const filtered of [false, true]) {
      for (const diffKind of ['none', 'unstaged', 'staged'] as const) {
        const route = bounded ? 'bounded' : 'legacy'
        const membership = filtered ? 'filtered' : 'all'
        it(`${route} ${membership} ${diffKind} preserves exact real Git options`, async () => {
          const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'b19-git-status-branches-'))
          const processes = createRealExecutionProcessRecorder()
          const git = (...argv: string[]) => spawnSync('git', argv, { cwd, encoding: 'utf8' })
          let host: ReturnType<typeof createTerminalExecutionFixture> | undefined
          try {
            expect(git('init').status).toBe(0)
            expect(git('config', 'user.email', 'test@example.com').status).toBe(0)
            expect(git('config', 'user.name', 'B19 Fixture').status).toBe(0)
            fs.mkdirSync(path.join(cwd, 'src'))
            fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'initial\n')
            expect(git('add', '.').status).toBe(0)
            expect(git('commit', '-m', 'fixture initial').status).toBe(0)
            fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'changed\n')
            if (diffKind === 'staged') expect(git('add', 'src/a.ts').status).toBe(0)
            host = createTerminalExecutionFixture({
              projectRoot: cwd, policy: 'read-only', spawn: processes.spawn,
              actionLimit: { kind: 'finite', durationMs: 10_000 },
            })
            const output = await gitStatus({
              cwd, executionContext: host.context, phase: 'branch-control',
              path: filtered ? 'src/a.ts' : undefined,
              include_diff: diffKind !== 'none', staged: diffKind === 'staged',
              ...(bounded ? { timeoutMs: 5_000 } : {}),
            })
            expect(output[0].value).not.toHaveProperty('errorMessage')
            expect(output[0].value).toHaveProperty('status', expect.stringContaining('src/a.ts'))
            const suffix = filtered ? ['--', 'src/a.ts'] : []
            const guards = ['--no-pager', '--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false']
            expect(processes.calls[0].argv).toEqual([...guards, 'status', '--short', '--branch', ...suffix])
            expect(host.policyInputs[0].classification).toMatchObject({
              parseStatus: 'unsupported', effects: [{ action: 'arbitrary-code' }],
            })
            expect(host.policyInputs[0].facts.branchId).toBe(`git-status.${route}.status.${membership}`)
            expect(processes.calls).toHaveLength(diffKind === 'none' ? 1 : 2)
            if (diffKind !== 'none') {
              expect(processes.calls[1].argv).toEqual(diffKind === 'staged'
                ? [...guards, 'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--staged', '--no-color', ...suffix]
                : [...guards, 'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--no-color', ...suffix])
              expect(host.policyInputs[1].classification).toMatchObject(diffKind === 'staged'
                ? { parseStatus: 'complete', parseReason: null, effects: [] }
                : { parseStatus: 'unsupported', effects: [{ action: 'arbitrary-code' }] })
              expect(host.policyInputs[1].facts.branchId).toBe(`git-status.${route}.diff-${diffKind}.${membership}`)
              expect(output[0].value).toHaveProperty('diff', expect.stringContaining('+changed'))
            }
            for (const [index, actual] of processes.calls.entries()) {
              expect(actual.spawnObserved).toBe(true)
              expect(actual.options).toMatchObject({ cwd, shell: false, detached: false })
              expect(actual.options.env?.PROJECT_VALUE).toBe('captured-value')
              expect(actual.options.env?.OPENAI_API_KEY).toBeUndefined()
              expect(actual.options.env?.CUSTOM_PROVIDER_KEY).toBeUndefined()
              expect(Object.isFrozen(actual.options.env)).toBe(true)
              expect(actual.options.signal).not.toBe(host.context.signal)
              const facts = host.policyInputs[index].facts
              expect(facts.profile.selected?.policy).toBe('read-only')
              expect(facts.deadlines.resourceLifetime.kind).toBe('finite')
              if (facts.deadlines.resourceLifetime.kind === 'finite') {
                expect(facts.deadlines.resourceLifetime.expiresAtMs - host.clock.nowMs()).toBeLessThanOrEqual(bounded ? 5_000 : 10_000)
              }
            }
          } finally {
            host?.dispose()
            fs.rmSync(cwd, { recursive: true, force: true })
          }
        })
      }
    }
  }
})

/** Owned Unix Git configuration and helper markers; no user home or config is read. */
function ownedGitHelperFixture() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'b19-git-config-helpers-'))
  const cwd = path.join(scratch, 'repo')
  const home = path.join(scratch, 'home')
  const xdg = path.join(scratch, 'xdg')
  for (const directory of [cwd, home, xdg]) fs.mkdirSync(directory)
  const marker = path.join(scratch, 'helper-marker.txt')
  fs.writeFileSync(marker, '')
  const environment = {
    PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    B19_GIT_HELPER_MARKER: marker,
  }
  const git = (argv: string[], overlay: Record<string, string> = {}) => spawnSync('git', argv, {
    cwd, env: { ...environment, ...overlay }, encoding: 'utf8', timeout: 5_000, maxBuffer: 1_000_000,
  })
  const helper = (name: string, output = '') => {
    const filename = path.join(scratch, `${name}.sh`)
    fs.writeFileSync(filename, `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$B19_GIT_HELPER_MARKER"\n${output}\n`, { mode: 0o755 })
    return filename
  }
  try {
    expect(git(['init']).status).toBe(0)
    expect(git(['config', 'user.email', 'test@example.com']).status).toBe(0)
    expect(git(['config', 'user.name', 'B19 Owned Git']).status).toBe(0)
    fs.writeFileSync(path.join(cwd, 'sample.txt'), 'before\n')
    expect(git(['add', 'sample.txt']).status).toBe(0)
    expect(git(['commit', '-m', 'owned fixture']).status).toBe(0)
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true })
    throw error
  }
  return {
    cwd, environment, marker, git, helper,
    marks: () => fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean),
    clear: () => fs.writeFileSync(marker, ''),
    dispose: () => fs.rmSync(scratch, { recursive: true, force: true }),
  }
}

describe('B19 owned actual Git configured-helper controls', () => {
  for (const kind of ['external-config', 'external-env', 'textconv'] as const) {
    for (const staged of [false, true]) {
      it(`${kind} executes in the adverse control and is suppressed in SDK ${staged ? 'cached' : 'worktree'} reads`, async () => {
        const fixture = ownedGitHelperFixture()
        let host: ReturnType<typeof createTerminalExecutionFixture> | undefined
        try {
          const helper = fixture.helper(kind, kind === 'textconv' ? 'cat "$1"' : 'exit 0')
          const command = `'${helper.replaceAll("'", "'\\''")}'`
          const overlay: Record<string, string> = kind === 'external-env' ? { GIT_EXTERNAL_DIFF: command } : {}
          if (kind === 'external-config') expect(fixture.git(['config', 'diff.external', command]).status).toBe(0)
          if (kind === 'textconv') {
            fs.writeFileSync(path.join(fixture.cwd, '.gitattributes'), 'sample.txt diff=b19marker\n')
            expect(fixture.git(['config', 'diff.b19marker.textconv', command]).status).toBe(0)
          }
          fs.writeFileSync(path.join(fixture.cwd, 'sample.txt'), 'after\n')
          if (staged) expect(fixture.git(['add', 'sample.txt']).status).toBe(0)
          fixture.clear()
          expect(fixture.git(['diff', ...(staged ? ['--cached'] : []), '--no-color', '--', 'sample.txt'], overlay).status).toBe(0)
          const adverseMarkers = fixture.marks()
          expect(adverseMarkers.length).toBeGreaterThan(0)
          expect(adverseMarkers.every(mark => mark === kind)).toBe(true)
          fixture.clear()
          const processes = createRealExecutionProcessRecorder()
          // The fixture's deliberate policy admits unsupported worktree semantics; this is a helper-specific oracle.
          host = createTerminalExecutionFixture({
            projectRoot: fixture.cwd, environment: { ...fixture.environment, ...overlay },
            spawn: processes.spawn, policy: 'full-access', actionLimit: { kind: 'finite', durationMs: 10_000 },
          })
          const output = await gitStatus({ cwd: fixture.cwd, path: 'sample.txt', include_diff: true, staged,
            executionContext: host.context, timeoutMs: 5_000, phase: `owned-helper-${kind}` })
          expect(output[0].value).not.toHaveProperty('errorMessage')
          expect(output[0].value).toHaveProperty('diff', expect.stringContaining('+after'))
          expect(processes.calls).toHaveLength(2)
          expect(processes.calls.every(call => call.spawnObserved)).toBe(true)
          expect(fixture.marks()).toEqual([])
          expect(processes.calls[1].argv).toEqual([
            '--no-pager', '--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false',
            'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', ...(staged ? ['--staged'] : []), '--no-color', '--', 'sample.txt',
          ])
          expect(host.policyInputs[0].classification.parseStatus).toBe('unsupported')
          expect(host.policyInputs[1].classification).toMatchObject(staged
            ? { parseStatus: 'complete', parseReason: null, effects: [] }
            : { parseStatus: 'unsupported', effects: [{ action: 'arbitrary-code' }] })
          process.stdout.write(`B19 owned Git helper ${JSON.stringify({ kind, staged, adverseMarkers, sdkMarkers: fixture.marks(), targetStarts: processes.calls.length })}\n`)
        } finally {
          host?.dispose()
          fixture.dispose()
        }
      })
    }
  }

  it('disables configured textconv for an actual complete tree-to-tree SDK query', async () => {
    const fixture = ownedGitHelperFixture()
    let host: ReturnType<typeof createTerminalExecutionFixture> | undefined
    try {
      const helper = fixture.helper('tree-textconv', 'cat "$1"')
      const command = `'${helper.replaceAll("'", "'\\''")}'`
      fs.writeFileSync(path.join(fixture.cwd, '.gitattributes'), 'sample.txt diff=b19marker\n')
      expect(fixture.git(['config', 'diff.b19marker.textconv', command]).status).toBe(0)
      fs.writeFileSync(path.join(fixture.cwd, 'sample.txt'), 'after\n')
      expect(fixture.git(['add', '.gitattributes', 'sample.txt']).status).toBe(0)
      expect(fixture.git(['commit', '-m', 'owned changed tree']).status).toBe(0)
      fixture.clear()
      expect(fixture.git(['diff', '--no-color', 'HEAD~1', 'HEAD', '--']).status).toBe(0)
      const adverseMarkers = fixture.marks()
      expect(adverseMarkers).toContain('tree-textconv')
      fixture.clear()
      const processes = createRealExecutionProcessRecorder()
      host = createTerminalExecutionFixture({ projectRoot: fixture.cwd, environment: fixture.environment,
        spawn: processes.spawn, actionLimit: { kind: 'finite', durationMs: 10_000 } })
      const result = await runGitBounded(['diff', '--no-color', 'HEAD~1', 'HEAD', '--'], fixture.cwd, undefined, {
        executionContext: host.context, branchId: 'owned-tree-query', timeoutMs: 5_000, maxOutputBytes: 100_000,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('+after')
      expect(fixture.marks()).toEqual([])
      expect(processes.calls).toHaveLength(1)
      expect(processes.calls[0].spawnObserved).toBe(true)
      expect(processes.calls[0].argv).toEqual([
        '--no-pager', '--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false',
        'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--no-color', 'HEAD~1', 'HEAD', '--',
      ])
      expect(host.policyInputs[0].classification).toMatchObject({ parseStatus: 'complete', parseReason: null, effects: [] })
      process.stdout.write(`B19 owned Git tree helper ${JSON.stringify({ adverseMarkers, sdkMarkers: fixture.marks(), targetStarts: processes.calls.length })}\n`)
    } finally {
      host?.dispose()
      fixture.dispose()
    }
  })

  for (const kind of ['fsmonitor', 'post-index-change'] as const) {
    it(`${kind} executes in the adverse control and is suppressed in SDK status`, async () => {
      const fixture = ownedGitHelperFixture()
      let host: ReturnType<typeof createTerminalExecutionFixture> | undefined
      try {
        if (kind === 'fsmonitor') {
          const helper = fixture.helper(kind, "printf 'token\\000/\\000'")
          expect(fixture.git(['config', 'core.fsmonitor', helper]).status).toBe(0)
          expect(fixture.git(['config', 'core.fsmonitorHookVersion', '2']).status).toBe(0)
        } else {
          const helper = fixture.helper(kind)
          fs.copyFileSync(helper, path.join(fixture.cwd, '.git/hooks/post-index-change'))
          fs.chmodSync(path.join(fixture.cwd, '.git/hooks/post-index-change'), 0o755)
        }
        const sample = path.join(fixture.cwd, 'sample.txt')
        fs.utimesSync(sample, new Date(), new Date(Date.now() + 20_000))
        fixture.clear()
        expect(fixture.git(['status', '--short', '--branch']).status).toBe(0)
        const adverseMarkers = fixture.marks()
        expect(adverseMarkers).toContain(kind)
        fixture.clear()
        fs.utimesSync(sample, new Date(), new Date(Date.now() + 40_000))
        const processes = createRealExecutionProcessRecorder()
        host = createTerminalExecutionFixture({ projectRoot: fixture.cwd, environment: fixture.environment,
          spawn: processes.spawn, actionLimit: { kind: 'finite', durationMs: 10_000 } })
        const output = await gitStatus({ cwd: fixture.cwd, executionContext: host.context, timeoutMs: 5_000 })
        expect(output[0].value).not.toHaveProperty('errorMessage')
        expect(processes.calls).toHaveLength(1)
        expect(processes.calls[0].spawnObserved).toBe(true)
        expect(fixture.marks()).toEqual([])
        process.stdout.write(`B19 owned Git helper ${JSON.stringify({ kind, adverseMarkers, sdkMarkers: fixture.marks(), targetStarts: processes.calls.length })}\n`)
      } finally {
        host?.dispose()
        fixture.dispose()
      }
    })
  }

  it('retains configured clean-filter semantics as unsupported and can refuse before actual dispatch', async () => {
    const fixture = ownedGitHelperFixture()
    let host: ReturnType<typeof createTerminalExecutionFixture> | undefined
    try {
      const helper = fixture.helper('clean-filter', 'cat')
      const command = `'${helper.replaceAll("'", "'\\''")}'`
      fs.writeFileSync(path.join(fixture.cwd, '.gitattributes'), 'sample.txt filter=b19marker\n')
      expect(fixture.git(['config', 'filter.b19marker.clean', command]).status).toBe(0)
      expect(fixture.git(['add', '.gitattributes', 'sample.txt']).status).toBe(0)
      expect(fixture.git(['commit', '-m', 'owned filter configuration']).status).toBe(0)
      fs.writeFileSync(path.join(fixture.cwd, 'sample.txt'), 'after\n')
      fixture.clear()
      // This adverse command has the exact helper guards emitted by the SDK; a clean filter can still execute.
      expect(fixture.git([
        '--no-pager', '--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false',
        'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--no-color',
      ]).status).toBe(0)
      const adverseMarkers = fixture.marks()
      expect(adverseMarkers).toContain('clean-filter')
      fixture.clear()
      const processes = createRealExecutionProcessRecorder()
      host = createTerminalExecutionFixture({ projectRoot: fixture.cwd, environment: fixture.environment,
        spawn: processes.spawn, authorize: input => input.classification.parseStatus === 'unsupported'
          ? { ok: false, reason: 'denied', cause: 'Configured working-tree filters require explicit policy approval' }
          : { ok: true, basis: 'explicit-policy', decisionId: 'owned-query-policy' } })
      const result = await runGitBounded(['diff', '--no-color'], fixture.cwd, undefined, {
        executionContext: host.context, branchId: 'owned-filter-refusal', timeoutMs: 5_000, maxOutputBytes: 100_000,
      })
      expect(result.executionRefusal).toMatchObject({ reason: 'denied' })
      expect(processes.calls).toHaveLength(0)
      expect(host.policyInputs[0].classification).toMatchObject({ parseStatus: 'unsupported', effects: [{ action: 'arbitrary-code' }] })
      expect(host.policyInputs[0].classification.parseReason).toContain('clean/process filters')
      expect(fixture.marks()).toEqual([])
      process.stdout.write(`B19 owned Git filter ${JSON.stringify({ adverseMarkers, sdkMarkers: fixture.marks(), targetStarts: processes.calls.length })}\n`)
    } finally {
      host?.dispose()
      fixture.dispose()
    }
  })
})
