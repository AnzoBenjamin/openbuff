import { EventEmitter } from 'node:events'

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { LaunchFacts } from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

export type BranchProcessReply = Readonly<{
  stdout?: string
  stderr?: string
  exitCode?: number
}>

export type BranchProcessCall = {
  launchId: string
  branchId: string
  executable: string
  argv: readonly string[]
  options: SpawnOptions
  resourceSignal: AbortSignal | undefined
  signalAbortedAtDispatch: boolean | undefined
  requestedSignals: string[]
  syntheticPid: number
  closed: boolean
  finish(exitCode?: number, signal?: string): void
}

/**
 * This is a Node adapter DI recorder, not an OS process fixture. Only genuine
 * authority dispatch events can bind the next invocation to its launch ID.
 * Synthetic spawn/close frames let the actual consumers finish without
 * installing Git, compilers, hooks, or contacting provider endpoints.
 */
export function createBranchProcessRecorderR3(options: {
  reply(executable: string, argv: readonly string[], launch: LaunchFacts): BranchProcessReply
  keepOpenBranch?: string
}) {
  const calls: BranchProcessCall[] = []
  let nextLaunch: LaunchFacts | undefined
  function bindDispatch(facts: LaunchFacts) {
    if (nextLaunch) throw new Error('An authority dispatch was not consumed by the Node adapter')
    nextLaunch = facts
  }
  const spawn: CodebuffSpawn = (executable, argv = [], supplied = {}) => {
    const facts = nextLaunch
    nextLaunch = undefined
    if (!facts) throw new Error('An unbound subprocess invocation escaped B19 authority')
    const args = Object.freeze([...argv])
    const captured: SpawnOptions = {
      ...supplied,
      env: supplied.env && { ...supplied.env },
      stdio: Array.isArray(supplied.stdio) ? [...supplied.stdio] : supplied.stdio,
    }
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const pid = 42_900_000 + calls.length
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdout,
      stderr,
      stdin: null,
      exitCode: null as number | null,
      signalCode: null as string | null,
      killed: false,
      unref() {},
      ref() {},
      kill(signal: string | number = 'SIGTERM') {
        call.requestedSignals.push(String(signal))
        if (call.closed) return false
        child.killed = true
        call.finish(undefined, String(signal))
        return true
      },
    })
    const call: BranchProcessCall = {
      launchId: facts.launchId,
      branchId: facts.branchId,
      executable,
      argv: args,
      options: captured,
      resourceSignal: supplied.signal,
      signalAbortedAtDispatch: supplied.signal?.aborted,
      requestedSignals: [],
      syntheticPid: pid,
      closed: false,
      finish(exitCode = 0, signal) {
        if (call.closed) return
        call.closed = true
        child.exitCode = signal ? null : exitCode
        child.signalCode = signal ?? null
        child.emit('exit', child.exitCode, child.signalCode)
        child.emit('close', child.exitCode, child.signalCode)
      },
    }
    calls.push(call)
    queueMicrotask(() => {
      if (call.closed) return
      child.emit('spawn')
      const reply = options.reply(executable, args, facts)
      if (reply.stdout) stdout.emit('data', Buffer.from(reply.stdout))
      if (reply.stderr) stderr.emit('data', Buffer.from(reply.stderr))
      if (facts.branchId === options.keepOpenBranch) return
      call.finish(reply.exitCode ?? 0)
    })
    return child as unknown as ChildProcess
  }
  function close() {
    for (const call of calls) if (!call.closed) call.finish(undefined, 'SIGKILL')
  }
  function snapshot() {
    return calls.map(call => ({
      launchId: call.launchId,
      branchId: call.branchId,
      executable: call.executable,
      argv: call.argv,
      options: {
        cwd: call.options.cwd,
        env: call.options.env,
        stdio: call.options.stdio,
        detached: call.options.detached,
        shell: call.options.shell,
        windowsHide: call.options.windowsHide,
      },
      resourceSignalPresent: call.resourceSignal !== undefined,
      signalAbortedAtDispatch: call.signalAbortedAtDispatch,
      resourceSignalAbortedAtCapture: call.resourceSignal?.aborted,
      requestedSignals: [...call.requestedSignals],
      syntheticPid: call.syntheticPid,
      fixtureCloseObserved: call.closed,
      observationOrigin: 'injected-node-frames',
      doesNotCertify: ['OS subprocess creation', 'process death', 'B20 cleanup', 'B19 acceptance'],
    }))
  }
  return { spawn, calls, bindDispatch, close, snapshot }
}
