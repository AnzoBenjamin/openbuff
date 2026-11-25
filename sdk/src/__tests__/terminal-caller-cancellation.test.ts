import { describe, expect, it, spyOn } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import {
  createDirectHostExecution,
  createHostExecutionServices,
  executionClock,
} from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { trustedNodeSpawn } from '../services/execution-launch'
import * as executionLaunch from '../services/execution-launch'
import { __runGitForSafetyForTest, runTerminalCommand } from '../tools/run-terminal-command'
import { createExecutionProcessRecorder } from './fixtures/b19-terminal-execution'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type {
  AsyncDecision,
  PolicyInput,
} from '@codebuff/common/types/contracts/execution-context'

const cwd = process.cwd()
const hostConfiguration = {
  environment: { PATH: '/usr/bin:/bin' },
  platform: process.platform,
  invocationCwd: cwd,
  projectRoot: cwd,
  home: { kind: 'none' as const },
  globals: { kind: 'disabled' as const },
  selection: { kind: 'none' as const },
  trust: { ancestorConfig: false, projectReadableRoots: false },
}

function makeHost(spawn: CodebuffSpawn, limitMs = 10_000) {
  const hostSignal = new AbortController()
  const result = createDirectHostExecution({
    cwd,
    hostConfiguration,
    spawn,
    signal: hostSignal.signal,
    limit: { kind: 'finite', durationMs: limitMs },
    profile: {
      policy: 'full-access',
      preferredBackend: 'portable-ts',
      required: ['exact-env'],
      allowBackendFallback: false,
    },
  })
  if (!result.ok) throw new Error(result.cause)
  return { ...result.value, hostSignal }
}

function makeControlledHost(
  spawn: CodebuffSpawn,
  options: {
    policy?: 'full-access' | 'git-commit'
    authorize?: (input: PolicyInput) => Promise<AsyncDecision>
  } = {},
) {
  const snapshot = loadHostConfigSnapshot({
    inputs: hostConfiguration,
    fs: nodeConfigReadFs,
  })
  if (snapshot.status !== 'complete') throw new Error(snapshot.cause)
  const boundary = captureRootDeadline({
    clock: executionClock,
    limit: { kind: 'finite', durationMs: 10_000 },
  })
  if (!boundary.ok) throw new Error(boundary.cause)
  const hostSignal = new AbortController()
  const services = createHostExecutionServices({
    snapshot: snapshot.snapshot,
    boundary: boundary.value,
    clock: executionClock,
    childInheritanceEnvironment: hostConfiguration.environment,
    signal: hostSignal.signal,
    spawn,
    profile: {
      policy: options.policy ?? 'full-access',
      preferredBackend: 'portable-ts',
      required: ['exact-env'],
      allowBackendFallback: false,
    },
    approvalMode: 'allow-all',
    authorizeAsync: options.authorize,
  })
  if (!services.ok) throw new Error(services.cause)
  const direct = services.value.directOperation()
  if (!direct.ok) throw new Error(direct.cause)
  return { ...direct.value, hostServices: services.value, hostSignal }
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++)
    await new Promise((resolve) => setImmediate(resolve))
  expect(predicate()).toBe(true)
}

function run(
  host: ReturnType<typeof makeHost>,
  signal: AbortSignal,
  command = 'printf started',
  process_type: 'SYNC' | 'BACKGROUND' = 'SYNC',
) {
  return runTerminalCommand({
    command,
    process_type,
    cwd,
    signal,
    executionContext: host.executionContext,
    terminalShell: { executable: '/bin/bash', args: ['-c'] },
    getTerminalLaunchMetadata: host.hostServices.getTerminalLaunchMetadata,
  })
}

describe('independent terminal caller cancellation', () => {
  it.each(['host', 'deadline'] as const)(
    'Git safety joins %s cleanup and keeps output until it finishes',
    async (kind) => {
      const processes = createExecutionProcessRecorder({ autoClose: false })
      const host = makeHost(processes.spawn, kind === 'deadline' ? 100 : 10_000)
      let release!: () => void
      let requested = false
      const gate = new Promise<void>((resolve) => { release = resolve })
      let markRequested!: () => void
      const requestSeen = new Promise<void>((resolve) => { markRequested = resolve })
      const dispatch = executionLaunch.dispatchNodeLaunch
      const spy = spyOn(executionLaunch, 'dispatchNodeLaunch').mockImplementation((...args) => {
        const actual = dispatch(...args)
        if (!actual.ok) return actual
        const scope = actual.value.scope
        return { ...actual, value: { ...actual.value, scope: { ...scope,
          requestStop: (reason, force) => {
            requested = true
            markRequested()
            return scope.requestStop(reason, force).then(async (result) => { await gate; return result })
          },
        } } }
      })
      try {
        const pending = __runGitForSafetyForTest(['diff', '--cached', '--check'], cwd, undefined, {
          executionContext: host.executionContext, branchId: 'terminal.safety.check',
        })
        let completed = false
        void pending.then(() => { completed = true })
        await waitFor(() => !!processes.calls[0]?.child.stdout?.listenerCount('data'))
        const git = processes.calls[0]
        git.child.stdout!.emit('data', Buffer.from('before'))
        git.child.stderr!.emit('data', Buffer.from('error-before'))
        if (kind === 'host') host.hostSignal.abort(new Error('host stopped'))
        await requestSeen
        await new Promise((resolve) => setImmediate(resolve))
        expect(requested).toBe(true)
        expect(completed).toBe(false)
        git.child.stdout!.emit('data', Buffer.from('-during'))
        git.child.stderr!.emit('data', Buffer.from('-during'))
        release()
        expect(await pending).toMatchObject({
          exitCode: -1, stdout: 'before-during', stderr: 'error-before-during',
          executionRefusal: { reason: kind === 'host' ? 'cancelled' : 'deadline-exhausted' },
        })
      } finally {
        release()
        for (const call of processes.calls) call.finish()
        spy.mockRestore()
      }
    },
  )

  it('keeps Git output during caller cleanup when close races cancellation', async () => {
    const processes = createExecutionProcessRecorder({ autoClose: false, closeOnKill: false })
    const host = makeHost(processes.spawn)
    const caller = new AbortController()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const dispatch = executionLaunch.dispatchNodeLaunch
    const spy = spyOn(executionLaunch, 'dispatchNodeLaunch').mockImplementation((...args) => {
      const actual = dispatch(...args)
      if (!actual.ok) return actual
      const scope = actual.value.scope
      return { ...actual, value: { ...actual.value, scope: { ...scope,
        requestStop: (reason, force) => scope.requestStop(reason, force).then(async (result) => { await gate; return result }),
      } } }
    })
    try {
      const pending = __runGitForSafetyForTest(['status', '--porcelain'], cwd, undefined, {
        signal: caller.signal, executionContext: host.executionContext, captureDirtyOutput: true,
        branchId: 'terminal.safety.dirty-before',
      })
      let completed = false
      void pending.then(() => { completed = true })
      await waitFor(() => !!processes.calls[0]?.child.stdout?.listenerCount('data'))
      const git = processes.calls[0]
      git.child.stdout!.emit('data', Buffer.from('before'))
      git.child.stderr!.emit('data', Buffer.from('error-before'))
      caller.abort(new Error('caller stopped'))
      git.finish()
      await new Promise((resolve) => setImmediate(resolve))
      git.child.stdout!.emit('data', Buffer.from('-during'))
      git.child.stderr!.emit('data', Buffer.from('-during'))
      expect(completed).toBe(false)
      release()
      expect(await pending).toMatchObject({
        exitCode: -1, stdout: 'before-during', stderr: 'error-before-during',
        executionRefusal: { reason: 'cancelled', cause: 'caller stopped' },
      })
    } finally {
      release()
      for (const call of processes.calls) call.finish()
      spy.mockRestore()
    }
  })

  it.each(['failed', 'reject'] as const)('reports %s Git cleanup without losing the stop reason', async (failure) => {
    const processes = createExecutionProcessRecorder({ autoClose: false })
    const host = makeHost(processes.spawn)
    const caller = new AbortController()
    const dispatch = executionLaunch.dispatchNodeLaunch
    const spy = spyOn(executionLaunch, 'dispatchNodeLaunch').mockImplementation((...args) => {
      const actual = dispatch(...args)
      if (!actual.ok) return actual
      const scope = actual.value.scope
      return { ...actual, value: { ...actual.value, scope: { ...scope,
        requestStop: (reason, force) => scope.requestStop(reason, force).then((result) => {
          if (failure === 'reject') throw new Error('controlled cleanup rejection')
          return { ...result, status: 'failed' as const, cause: 'controlled cleanup failure' }
        }),
      } } }
    })
    try {
      const pending = __runGitForSafetyForTest(['diff', '--cached', '--check'], cwd, undefined, {
        signal: caller.signal, executionContext: host.executionContext, branchId: 'terminal.safety.check',
      })
      await waitFor(() => !!processes.calls[0]?.child.stdout?.listenerCount('data'))
      caller.abort(new Error('caller stopped'))
      const result = await pending
      expect(result.exitCode).toBe(-1)
      expect(result.executionRefusal?.reason).toBe('cancelled')
      expect(result.executionRefusal?.cause).toContain('caller stopped')
      expect(result.executionRefusal?.cause).toContain('cleanup')
    } finally {
      for (const call of processes.calls) call.finish()
      spy.mockRestore()
    }
  })

  it('fails a normally exited Git process when scope cleanup fails', async () => {
    const processes = createExecutionProcessRecorder({ autoClose: false })
    const host = makeHost(processes.spawn)
    const dispatch = executionLaunch.dispatchNodeLaunch
    const spy = spyOn(executionLaunch, 'dispatchNodeLaunch').mockImplementation((...args) => {
      const actual = dispatch(...args)
      if (!actual.ok) return actual
      const scope = actual.value.scope
      return { ...actual, value: { ...actual.value, scope: { ...scope,
        requestStop: (reason, force) => scope.requestStop(reason, force).then((result) => ({
          ...result, status: 'failed' as const, cause: 'controlled cleanup failure',
        })),
      } } }
    })
    try {
      const pending = __runGitForSafetyForTest(['diff', '--cached', '--check'], cwd, undefined, {
        executionContext: host.executionContext, branchId: 'terminal.safety.check',
      })
      await waitFor(() => !!processes.calls[0]?.child.stdout?.listenerCount('data'))
      processes.calls[0].finish(0)
      const result = await pending
      expect(result.exitCode).toBe(-1)
      expect(result.cleanupFailed).toBe(true)
      expect(result.executionRefusal?.reason).toBe('unavailable')
      expect(result.executionRefusal?.cause).toContain('controlled cleanup failure')
    } finally {
      for (const call of processes.calls) call.finish()
      spy.mockRestore()
    }
  })

  it('reports unconfirmed Git cleanup if a cancelled child never closes', async () => {
    const processes = createExecutionProcessRecorder({ autoClose: false, closeOnKill: false })
    const host = makeHost(processes.spawn)
    const caller = new AbortController()
    try {
      const pending = __runGitForSafetyForTest(['diff', '--cached', '--check'], cwd, undefined, {
        signal: caller.signal, executionContext: host.executionContext, branchId: 'terminal.safety.check',
      })
      await waitFor(() => !!processes.calls[0]?.child.stdout?.listenerCount('data'))
      const git = processes.calls[0]
      git.child.stdout!.emit('data', Buffer.from('partial'))
      caller.abort(new Error('caller stopped'))
      const result = await pending
      expect(result.exitCode).toBe(-1)
      expect(result.stdout).toBe('partial')
      expect(result.cleanupFailed).toBe(true)
      expect(result.executionRefusal?.reason).toBe('cancelled')
      expect(result.executionRefusal?.cause).toContain('cleanup')
      expect(git.signals).toEqual(['SIGTERM', 'SIGKILL'])
    } finally {
      for (const call of processes.calls) call.finish()
    }
  }, 5_000)

  it('does not dispatch the shell after failed dirty-before cleanup', async () => {
    const processes = createExecutionProcessRecorder()
    const host = makeHost(processes.spawn)
    const dispatch = executionLaunch.dispatchNodeLaunch
    const spy = spyOn(executionLaunch, 'dispatchNodeLaunch').mockImplementation((...args) => {
      const actual = dispatch(...args)
      if (!actual.ok) return actual
      const scope = actual.value.scope
      return { ...actual, value: { ...actual.value, scope: { ...scope,
        requestStop: (reason, force) => scope.requestStop(reason, force).then((result) => ({
          ...result, status: 'failed' as const, cause: 'controlled cleanup failure',
        })),
      } } }
    })
    try {
      const result = await run(host, new AbortController().signal)
      expect(result[0].value).toMatchObject({ executionRefusal: { reason: 'unavailable' } })
      expect('errorMessage' in result[0].value && result[0].value.errorMessage).toContain('cleanup')
      expect(processes.calls.map((call) => call.executable)).toEqual(['git'])
    } finally {
      for (const call of processes.calls) call.finish()
      spy.mockRestore()
    }
  })

  it('reports failed dirty-after cleanup without losing completed shell output', async () => {
    const processes = createExecutionProcessRecorder({
      reply: (executable) => executable === '/bin/bash' ? { stdout: 'completed' } : {},
    })
    const host = makeHost(processes.spawn)
    const dispatch = executionLaunch.dispatchNodeLaunch
    const spy = spyOn(executionLaunch, 'dispatchNodeLaunch').mockImplementation((...args) => {
      const actual = dispatch(...args)
      if (!actual.ok || actual.value.facts().branchId !== 'terminal.safety.dirty-after') return actual
      const scope = actual.value.scope
      return { ...actual, value: { ...actual.value, scope: { ...scope,
        requestStop: (reason, force) => scope.requestStop(reason, force).then((result) => ({
          ...result, status: 'failed' as const, cause: 'controlled cleanup failure',
        })),
      } } }
    })
    try {
      const result = await run(host, new AbortController().signal)
      expect(result[0].value).toMatchObject({
        stdout: 'completed', exitCode: 0,
        executionRefusal: { reason: 'unavailable' },
        dirtyObservationRefusal: { reason: 'unavailable' },
      })
      expect('errorMessage' in result[0].value && result[0].value.errorMessage).toContain('cleanup')
    } finally {
      for (const call of processes.calls) call.finish()
      spy.mockRestore()
    }
  })

  it('honors caller cancellation after Git close while native completion is pending', async () => {
    const processes = createExecutionProcessRecorder({ autoClose: false })
    const host = makeHost(processes.spawn)
    const caller = new AbortController()
    let releaseNative!: () => void
    let releaseCleanup!: () => void
    const nativeGate = new Promise<void>((resolve) => { releaseNative = resolve })
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const dispatch = executionLaunch.dispatchNodeLaunch
    const spy = spyOn(executionLaunch, 'dispatchNodeLaunch').mockImplementation((...args) => {
      const actual = dispatch(...args)
      if (!actual.ok) return actual
      const scope = actual.value.scope
      return { ...actual, value: { ...actual.value,
        nativeResult: nativeGate.then(() => undefined) as typeof actual.value.nativeResult,
        scope: { ...scope,
          requestStop: (reason, force) => scope.requestStop(reason, force).then(async (result) => { await cleanupGate; return result }),
        },
      } }
    })
    try {
      const pending = __runGitForSafetyForTest(['diff', '--cached', '--check'], cwd, undefined, {
        signal: caller.signal, executionContext: host.executionContext, branchId: 'terminal.safety.check',
      })
      let completed = false
      void pending.then(() => { completed = true })
      await waitFor(() => !!processes.calls[0]?.child.stdout?.listenerCount('data'))
      const git = processes.calls[0]
      git.child.stdout!.emit('data', Buffer.from('before'))
      git.finish()
      caller.abort(new Error('caller stopped'))
      releaseNative()
      await new Promise((resolve) => setImmediate(resolve))
      expect(completed).toBe(false)
      git.child.stdout!.emit('data', Buffer.from('-during'))
      releaseCleanup()
      expect(await pending).toMatchObject({
        exitCode: -1, stdout: 'before-during',
        executionRefusal: { reason: 'cancelled', cause: 'caller stopped' },
      })
    } finally {
      releaseNative()
      releaseCleanup()
      for (const call of processes.calls) call.finish()
      spy.mockRestore()
    }
  })
  it.each([false, true])(
    'BACKGROUND detach=%s stops before handoff and ignores cancellation after handoff',
    async (detach) => {
      const temp = fs.mkdtempSync(path.join(cwd, '.terminal-cancel-test-'))
      const previousTmp = process.env.TMPDIR
      process.env.TMPDIR = temp
      try {
        for (const abortDuringSpawn of [true, false]) {
          const processes = createExecutionProcessRecorder({ autoClose: false })
          const caller = new AbortController()
          const spawn: CodebuffSpawn = (executable, args, options) => {
            const child = processes.spawn(executable, args, options)
            const call = processes.calls.at(-1)!
            if (executable === 'git') queueMicrotask(() => call.finish())
            else if (abortDuringSpawn) caller.abort(new Error('caller stopped'))
            return child
          }
          const host = makeControlledHost(spawn)
          const owner = {
            clientSessionId: `caller-${detach}-${abortDuringSpawn}`,
            rootRunId: 'run',
            parentRunId: 'run',
            parentAgentId: 'agent',
          }
          const scope = host.hostServices.registerRun(owner)
          if (!scope.ok) throw new Error(scope.cause)
          const action = scope.value.action({
            actionId: 'background',
            attemptId: 'attempt',
            basisId: 'basis',
          })
          if (!action.ok) throw new Error(action.cause)
          const receiver = host.hostServices.createBackgroundReceiver(
            owner.clientSessionId,
          )
          if (!receiver.ok) throw new Error(receiver.cause)
          const result = await runTerminalCommand({
            command: 'printf started',
            process_type: 'BACKGROUND',
            detach,
            owner,
            cwd,
            signal: caller.signal,
            executionContext: action.value,
            terminalShell: { executable: '/bin/bash', args: ['-c'] },
            getTerminalLaunchMetadata:
              host.hostServices.getTerminalLaunchMetadata,
            ...(detach
              ? {
                  prepareTransferredLaunch: (target) =>
                    receiver.value.prepareLaunch(action.value, target),
                }
              : {}),
          })
          const shell = processes.calls.find(
            (call) => call.executable === '/bin/bash',
          )!
          expect(shell).toBeDefined()
          expect(shell.options.signal).not.toBe(caller.signal)
          if (abortDuringSpawn) {
            expect(result[0].value).toMatchObject({
              executionRefusal: { reason: 'cancelled' },
            })
            expect(shell.signals).toEqual(['SIGTERM'])
          } else {
            expect(result[0].value).toMatchObject({
              backgroundProcessStatus: 'running',
              detached: detach,
            })
            caller.abort(new Error('caller stopped after handoff'))
            await new Promise((resolve) => setImmediate(resolve))
            expect(shell.signals).toEqual([])
            expect(shell.options.signal?.aborted).toBe(false)
            shell.finish()
          }
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
      } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = previousTmp
        fs.rmSync(temp, { recursive: true, force: true })
      }
    },
  )
  it('returns during pending admission and never dispatches after late approval', async () => {
    const processes = createExecutionProcessRecorder()
    let release!: (decision: AsyncDecision) => void
    let entered = false
    const host = makeControlledHost(processes.spawn, {
      authorize: async () => {
        entered = true
        return new Promise((resolve) => {
          release = resolve
        })
      },
    })
    const caller = new AbortController()
    const pending = run(host, caller.signal)
    try {
      await waitFor(() => entered)
      caller.abort(new Error('caller stopped'))
      const result = await Promise.race([
        pending,
        new Promise<undefined>((resolve) => setTimeout(resolve, 200)),
      ])
      expect(result?.[0].value).toMatchObject({
        executionRefusal: { reason: 'cancelled' },
      })
    } finally {
      release({ ok: true, basis: 'explicit-policy', decisionId: 'late' })
    }
    await new Promise((resolve) => setImmediate(resolve))
    expect(processes.calls).toHaveLength(0)
  })

  it('joins both concurrent commit safety processes on caller cancellation', async () => {
    const processes = createExecutionProcessRecorder({
      autoClose: false,
      closeOnKill: false,
    })
    const host = makeControlledHost(processes.spawn, { policy: 'git-commit' })
    const caller = new AbortController()
    const pending = run(host, caller.signal, 'git commit -m "safe"')
    try {
      await waitFor(() => processes.calls.length === 2)
      expect(processes.calls.every((call) => call.executable === 'git')).toBe(
        true,
      )
      caller.abort(new Error('caller stopped'))
      await new Promise((resolve) => setImmediate(resolve))
      expect(processes.calls.map((call) => call.signals)).toEqual([
        ['SIGTERM'],
        ['SIGTERM'],
      ])
      let completed = false
      void pending.then(() => {
        completed = true
      })
      processes.calls[0].finish(undefined, 'SIGTERM')
      await new Promise((resolve) => setImmediate(resolve))
      expect(completed).toBe(false)
      processes.calls[1].finish(undefined, 'SIGTERM')
      expect((await pending)[0].value).toMatchObject({
        safetyPreflightFailed: true,
        executionRefusal: { reason: 'cancelled' },
      })
      expect(processes.calls).toHaveLength(2)
    } finally {
      for (const call of processes.calls) call.finish()
    }
  })

  it('reports the second commit safety process cleanup failure along with cancellation', async () => {
    const processes = createExecutionProcessRecorder({ autoClose: false })
    const host = makeControlledHost(processes.spawn, { policy: 'git-commit' })
    const caller = new AbortController()
    const dispatch = executionLaunch.dispatchNodeLaunch
    const spy = spyOn(executionLaunch, 'dispatchNodeLaunch').mockImplementation((...args) => {
      const actual = dispatch(...args)
      if (!actual.ok || actual.value.facts().branchId !== 'terminal.safety.diff') return actual
      const scope = actual.value.scope
      return { ...actual, value: { ...actual.value, scope: { ...scope,
        requestStop: (reason, force) => scope.requestStop(reason, force).then((result) => ({
          ...result, status: 'failed' as const, cause: 'diff cleanup failure',
        })),
      } } }
    })
    try {
      const pending = run(host, caller.signal, 'git commit -m "safe"')
      await waitFor(() => processes.calls.length === 2)
      caller.abort(new Error('caller stopped'))
      const result = await pending
      expect(result[0].value).toMatchObject({
        safetyPreflightFailed: true, executionRefusal: { reason: 'cancelled' },
      })
      expect('errorMessage' in result[0].value && result[0].value.errorMessage).toContain('diff cleanup failure')
    } finally {
      for (const call of processes.calls) call.finish()
      spy.mockRestore()
    }
  })
  it('cancels a pending Git admission without dispatching it after approval', async () => {
    const processes = createExecutionProcessRecorder()
    let release!: (decision: AsyncDecision) => void
    let entered = false
    const host = makeControlledHost(processes.spawn, {
      authorize: async (input) => {
        if (input.facts.branchId === 'terminal.safety.dirty-before') {
          entered = true
          return new Promise((resolve) => {
            release = resolve
          })
        }
        return { ok: true, basis: 'explicit-policy', decisionId: 'approved' }
      },
    })
    const caller = new AbortController()
    const pending = run(host, caller.signal)
    try {
      await waitFor(() => entered)
      caller.abort(new Error('caller stopped'))
      const result = await Promise.race([
        pending,
        new Promise<undefined>((resolve) => setTimeout(resolve, 200)),
      ])
      expect(result?.[0].value).toMatchObject({
        executionRefusal: { reason: 'cancelled' },
      })
    } finally {
      release({ ok: true, basis: 'explicit-policy', decisionId: 'late' })
    }
    await new Promise((resolve) => setImmediate(resolve))
    expect(processes.calls).toHaveLength(0)
  })
  it('retains the complete dirty status when a caller signal is present', async () => {
    const processes = createExecutionProcessRecorder({ autoClose: false })
    const before = Array.from(
      { length: 300 },
      (_, i) => `?? preexisting-${i}.txt\n`,
    ).join('')
    let gitCount = 0
    const spawn: CodebuffSpawn = (executable, args, options) => {
      const child = processes.spawn(executable, args, options)
      const call = processes.calls.at(-1)!
      queueMicrotask(() => {
        if (executable === 'git')
          child.stdout?.emit(
            'data',
            Buffer.from(before + (++gitCount === 2 ? '?? new.txt\n' : '')),
          )
        call.finish()
      })
      return child
    }
    const host = makeHost(spawn)
    const result = await run(host, new AbortController().signal)
    expect(result[0].value).toMatchObject({ touchedPaths: ['new.txt'] })
  })
  it('refuses an already cancelled caller before admission', async () => {
    const processes = createExecutionProcessRecorder()
    const host = makeHost(processes.spawn)
    const caller = new AbortController()
    caller.abort(new Error('caller stopped'))
    const result = await run(host, caller.signal)
    expect(result[0].value).toMatchObject({
      executionRefusal: { reason: 'cancelled' },
    })
    expect(processes.calls).toHaveLength(0)
    expect(host.hostSignal.signal.aborted).toBe(false)
  })

  it.each(['SYNC', 'BACKGROUND'] as const)(
    'joins dirty-before cleanup before refusing %s dispatch',
    async (processType) => {
      const processes = createExecutionProcessRecorder({
        autoClose: false,
        closeOnKill: false,
      })
      const host = makeHost(processes.spawn)
      const caller = new AbortController()
      const pending = run(host, caller.signal, 'printf started', processType)
      try {
        await waitFor(() => processes.calls.length === 1)
        const git = processes.calls[0]
        expect(git.executable).toBe('git')
        caller.abort(new Error('caller stopped'))
        await new Promise((resolve) => setImmediate(resolve))
        expect(git.signals).toEqual(['SIGTERM'])
        let completed = false
        void pending.then(() => {
          completed = true
        })
        await new Promise((resolve) => setImmediate(resolve))
        expect(completed).toBe(false)
        git.finish(undefined, 'SIGTERM')
        const result = await pending
        expect(result[0].value).toMatchObject({
          executionRefusal: { reason: 'cancelled' },
        })
        expect(processes.calls).toHaveLength(1)
        expect(git.options.signal).not.toBe(caller.signal)
        expect(git.options.signal?.aborted).toBe(false)
      } finally {
        for (const call of processes.calls) call.finish()
      }
    },
  )

  it('stops a running SYNC command, joins cleanup and preserves output', async () => {
    const processes = createExecutionProcessRecorder({
      autoClose: false,
      closeOnKill: false,
    })
    const spawn: CodebuffSpawn = (executable, args, options) => {
      const child = processes.spawn(executable, args, options)
      if (executable === 'git')
        queueMicrotask(() => processes.calls.at(-1)!.finish())
      return child
    }
    const host = makeHost(spawn)
    const caller = new AbortController()
    const pending = run(host, caller.signal)
    try {
      await waitFor(() =>
        processes.calls.some((call) => call.executable === '/bin/bash'),
      )
      const shell = processes.calls.find(
        (call) => call.executable === '/bin/bash',
      )!
      shell.child.stdout?.emit('data', Buffer.from('partial'))
      caller.abort(new Error('caller stopped'))
      await new Promise((resolve) => setImmediate(resolve))
      expect(shell.signals).toEqual(['SIGTERM'])
      let completed = false
      void pending.then(() => {
        completed = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(completed).toBe(false)
      shell.finish(undefined, 'SIGTERM')
      const result = await pending
      expect(result[0].value).toMatchObject({
        executionRefusal: { reason: 'cancelled' },
        stdout: 'partial',
        processCleanup: { status: 'complete' },
      })
      expect(shell.options.signal).not.toBe(caller.signal)
      expect(shell.options.signal?.aborted).toBe(false)
      const planned = host.hostServices.events.find(
        (event) =>
          event.phase === 'planned' && event.facts.branchId === 'terminal.sync',
      )
      expect(
        planned?.phase === 'planned' &&
          planned.facts.deadlines.resourceLifetime.kind,
      ).toBe('finite')
      expect(host.hostSignal.signal.aborted).toBe(false)
    } finally {
      for (const call of processes.calls) call.finish()
    }
  })

  it('cancels a real SYNC process independently and keeps its output', async () => {
    const caller = new AbortController()
    const realSpawn = trustedNodeSpawn()
    const spawn: CodebuffSpawn = (executable, args, options) => {
      const child = realSpawn(executable, args, options)
      if (executable === '/bin/bash')
        child.stdout?.once('data', () =>
          caller.abort(new Error('real caller stopped')),
        )
      return child
    }
    const host = makeHost(spawn)
    const result = await run(host, caller.signal, 'printf started; sleep 30')
    expect(result[0].value).toMatchObject({
      stdout: 'started',
      executionRefusal: { reason: 'cancelled' },
      processCleanup: { status: 'complete' },
    })
    expect(host.hostSignal.signal.aborted).toBe(false)
  }, 10_000)

  it('returns partial output and unconfirmed cleanup when a cancelled child never closes', async () => {
    const processes = createExecutionProcessRecorder({
      autoClose: false,
      closeOnKill: false,
    })
    const spawn: CodebuffSpawn = (executable, args, options) => {
      const child = processes.spawn(executable, args, options)
      const call = processes.calls.at(-1)!
      if (executable === 'git') queueMicrotask(() => call.finish())
      return child
    }
    const host = makeHost(spawn)
    const caller = new AbortController()
    const pending = run(host, caller.signal)
    try {
      await waitFor(() =>
        processes.calls.some((call) => call.executable === '/bin/bash'),
      )
      const shell = processes.calls.find(
        (call) => call.executable === '/bin/bash',
      )!
      shell.child.stdout?.emit('data', Buffer.from('partial'))
      caller.abort(new Error('caller stopped'))
      const result = await pending
      expect(result[0].value).toMatchObject({
        stdout: 'partial',
        executionRefusal: { reason: 'cancelled' },
        processCleanup: {
          status: 'failed',
          cleanupAuthorityRetained: true,
          finalObservation: { scopePresence: 'living' },
        },
      })
      expect(shell.signals).toEqual(['SIGTERM', 'SIGKILL'])
    } finally {
      for (const call of processes.calls) call.finish()
    }
  }, 5_000)

  it('keeps the host deadline authoritative when the caller remains active', async () => {
    const processes = createExecutionProcessRecorder({ autoClose: false })
    const spawn: CodebuffSpawn = (executable, args, options) => {
      const child = processes.spawn(executable, args, options)
      const call = processes.calls.at(-1)!
      if (executable === 'git') queueMicrotask(() => call.finish())
      return child
    }
    const host = makeHost(spawn, 150)
    const caller = new AbortController()
    const result = await run(host, caller.signal)
    expect(result[0].value).toMatchObject({
      timedOut: true,
      executionRefusal: { reason: 'deadline-exhausted' },
    })
    expect(caller.signal.aborted).toBe(false)
    expect(host.hostSignal.signal.aborted).toBe(false)
  })

  it('joins cancelled dirty-after observation without losing completed command output', async () => {
    const processes = createExecutionProcessRecorder({
      autoClose: false,
      closeOnKill: false,
    })
    let gitCount = 0
    const spawn: CodebuffSpawn = (executable, args, options) => {
      const child = processes.spawn(executable, args, options)
      const call = processes.calls.at(-1)!
      if (executable === 'git' && ++gitCount === 1)
        queueMicrotask(() => call.finish())
      if (executable === '/bin/bash')
        queueMicrotask(() => {
          child.stdout?.emit('data', Buffer.from('completed'))
          call.finish()
        })
      return child
    }
    const host = makeHost(spawn)
    const caller = new AbortController()
    const pending = run(host, caller.signal)
    try {
      await waitFor(() => gitCount === 2)
      const git = processes.calls.at(-1)!
      caller.abort(new Error('caller stopped'))
      await new Promise((resolve) => setImmediate(resolve))
      expect(git.signals).toEqual(['SIGTERM'])
      let completed = false
      void pending.then(() => {
        completed = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(completed).toBe(false)
      git.finish(undefined, 'SIGTERM')
      expect((await pending)[0].value).toMatchObject({
        stdout: 'completed',
        exitCode: 0,
        executionRefusal: { reason: 'cancelled' },
      })
    } finally {
      for (const call of processes.calls) call.finish()
    }
  })
})
