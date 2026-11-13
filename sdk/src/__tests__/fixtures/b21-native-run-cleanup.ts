import { spawn as spawnIdentityProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { PassThrough, Writable } from 'node:stream'

import {
  calibrateNativeClock,
  encodeNativeFrame,
  NativeFrameDecoder,
  nativeFilterSha256,
  verifyNativeInstallation,
} from '../../services/native-exec'
import {
  createExecutionProcessRecorder,
  executionValue,
} from './b19-terminal-execution'

import type { ChildProcess } from 'node:child_process'
import type { Clock } from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { NativeHostExecution } from '../../services/native-host-execution'

type Identity = Readonly<{
  nonce: string
  planDigest: string
  artifactSha256: string
}>
export type SyntheticNativeCall = {
  child: ChildProcess
  launchId?: string
  scopeId?: string
  targetArgv?: readonly string[]
  entered: boolean
  closed: boolean
  commands: Record<string, unknown>[]
  reports: Record<string, unknown>[]
  fakeKillSignals: string[]
  finish(): void
}

/**
 * A separately owned real Bash child supplies only a stable /proc/PID/exe identity.
 * All native protocol, target entry and enforcement reports below are synthetic.
 * The fake native child's kill method never signals the real identity process.
 */
export async function createNativeRunCleanupFixture(clock: Clock) {
  const executable = '/usr/bin/bash'
  const sha256 = createHash('sha256')
    .update(fs.readFileSync(executable))
    .digest('hex')
  const identityChild = spawnIdentityProcess(
    executable,
    ['-c', 'read -r fixture_identity_input'],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  )
  let identityClosed = false
  const identityExit = new Promise<
    Readonly<{ exitCode: number | null; signal: string | null }>
  >((resolve) => {
    identityChild.once('close', (exitCode, signal) => {
      identityClosed = true
      resolve({ exitCode, signal })
    })
  })
  async function setupRegistration() {
    await new Promise<void>((resolve, reject) => {
      identityChild.once('spawn', resolve)
      identityChild.once('error', reject)
    })
    const installation = executionValue(
      verifyNativeInstallation({
        artifact: {
          path: executable,
          sha256,
          platform: 'linux-x64-gnu',
          crateVersion: '0.1.0',
          workspaceProtocol: '1',
        },
        bwrap: { path: executable, sha256 },
      }),
    )
    const calibrated = await calibrateNativeClock(installation, clock, () => {
      const stdout = new PassThrough(),
        stderr = new PassThrough()
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        kill: () => false,
      })
      queueMicrotask(() => {
        stdout.end(
          JSON.stringify({
            execProtocol: 'openbuff.exec.v1',
            workspaceProtocol: '1',
            crateVersion: '0.1.0',
            platform: 'linux-x64-gnu',
            monotonicNs: '100000000',
          }),
        )
        child.emit('close', 0)
      })
      return { ok: true, value: child as unknown as ChildProcess }
    })
    if (!calibrated.ok) {
      installation.close()
      throw new Error(calibrated.cause)
    }
    return { installation, mapping: calibrated.value }
  }
  const { installation, mapping } = await setupRegistration().catch(
    async (error) => {
      identityChild.stdin?.end()
      await identityExit
      throw error
    },
  )
  const native: NativeHostExecution = {
    installation,
    mapping,
    clock,
    runtimePaths: [executable],
    network: 'inherit',
    landlock: 'disabled',
  }
  const portable = createExecutionProcessRecorder()
  const calls: SyntheticNativeCall[] = []
  const spawn: CodebuffSpawn = (command, argv = [], options) => {
    if (command !== '/proc/self/fd/5')
      return portable.spawn(command, argv, options)
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      stderr = new PassThrough(),
      reports = new PassThrough()
    const decoder = new NativeFrameDecoder()
    // These generations and the distinct target PID are synthetic protocol data.
    const waiterIdentity = {
      waiterPid: identityChild.pid!,
      waiterStartTime: '42',
      pidNamespace: null,
      namespaceDepth: null,
    }
    const targetIdentity = {
      ...waiterIdentity,
      targetPid: identityChild.pid! + 1,
      targetLocalPid: identityChild.pid! + 1,
      targetStartTime: '43',
    }
    let identity: Identity | undefined,
      plan: Record<string, unknown> | undefined
    const control = new Writable({
      write(bytes, _encoding, done) {
        const frames = decoder.push(Buffer.from(bytes))
        done()
        for (const frame of frames) {
          call.commands.push(frame)
          if (frame.type === 'initialize') {
            report({
              type: 'initialized',
              execProtocol: 'openbuff.exec.v1',
              workspaceProtocol: '1',
              crateVersion: '0.1.0',
              platform: 'linux-x64-gnu',
              filterDigests: {
                deny: nativeFilterSha256('deny'),
                inherit: nativeFilterSha256('inherit'),
              },
            })
          } else if (frame.type === 'prepare') {
            identity = {
              nonce: String(frame.nonce),
              planDigest: String(frame.planDigest),
              artifactSha256: String(frame.artifactSha256),
            }
            plan = JSON.parse(String(frame.planJson)) as Record<string, unknown>
            call.launchId = String(plan.launchId)
            call.scopeId = `DI-only-native-scope:${call.launchId}`
            call.targetArgv = Object.freeze([...(plan.argv as string[])])
            const keepLive = (plan.argv as string[]).includes(
              'printf native-live-fixture',
            )
            if (keepLive)
              report({
                type: 'prepared',
                ...identity,
                scopeId: call.scopeId,
                ...waiterIdentity,
                enforced: [
                  {
                    capability: 'exact-env',
                    status: 'enforced',
                    evidenceId: 'DI-only-synthetic-exact-env',
                  },
                ],
              })
            else queueMicrotask(() => call.finish())
          } else if (frame.type === 'commit') {
            call.entered = true
            report({
              type: 'target-created',
              ...identity,
              scopeId: call.scopeId,
              ...targetIdentity,
            })
            report({
              type: 'target-entered',
              ...identity,
              scopeId: call.scopeId,
              ...targetIdentity,
              pid: targetIdentity.targetPid,
              observation: 'exec-image',
            })
          } else if (frame.type === 'stop') queueMicrotask(() => call.finish())
        }
      },
    })
    const state = Object.assign(new EventEmitter(), {
      // The actual ELF identity is real; this process is not a native monitor.
      pid: identityChild.pid!,
      stdin,
      stdout,
      stderr,
      stdio: [stdin, stdout, stderr, control, reports],
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal = 'SIGTERM') {
        call.fakeKillSignals.push(signal)
        call.finish()
        return true
      },
    })
    function report(frame: Record<string, unknown>) {
      queueMicrotask(() => {
        if (!call.closed) {
          call.reports.push(frame)
          reports.write(encodeNativeFrame(frame))
        }
      })
    }
    const call: SyntheticNativeCall = {
      child: state as unknown as ChildProcess,
      entered: false,
      closed: false,
      commands: [],
      reports: [],
      fakeKillSignals: [],
      finish() {
        if (call.closed) return
        if (identity && plan) {
          const finalFrame = {
            type: 'final',
            ...identity,
            scopeId: call.scopeId,
            ...waiterIdentity,
            targetEntry: call.entered ? 'entered' : 'not-entered',
            targetPid: call.entered ? targetIdentity.targetPid : null,
            targetLocalPid: call.entered ? targetIdentity.targetLocalPid : null,
            targetStartTime: call.entered
              ? targetIdentity.targetStartTime
              : null,
            exitCode: null,
            signal: null,
            waitStatusSource: 'not-observed',
            wrapperExitCode: null,
            wrapperSignal: null,
            cause: 'DI-only synthetic native cleanup remains unconfirmed',
            enforced: [],
            usage: {
              cpuMicros: 0,
              maxRssKiB: 0,
              scope:
                'direct-and-adopted-wait4; maxrss is not aggregate tree memory',
            },
            targetUsage: null,
            cleanup: {
              complete: false,
              scopeTier: 'direct-child',
              pidNamespace: null,
              namespaceAbsent: null,
              initAbsent: null,
              outerChildReaped: false,
              reapedPids: [],
              stopAtNs: null,
              allChildrenReaped: false,
              reapCount: 0,
              observationsTruncated: false,
              observedAtNs: '100000000',
              originalExpiryNs: plan.expiryNs,
              signals: [],
            },
          }
          call.reports.push(finalFrame)
          reports.write(encodeNativeFrame(finalFrame))
        }
        call.closed = true
        state.exitCode = 0
        stdin.destroy()
        stdout.end()
        stderr.end()
        reports.end()
        control.end()
        queueMicrotask(() => {
          state.emit('exit', 0, null)
          state.emit('close', 0, null)
        })
      },
    }
    calls.push(call)
    stdout.resume()
    stderr.resume()
    reports.resume()
    queueMicrotask(() => state.emit('spawn'))
    return call.child
  }
  async function dispose() {
    for (const call of calls) call.finish()
    const closedBeforeFixtureDisposal = identityClosed
    // This explicit fixture owner, not the synthetic native scope, reaps Bash.
    identityChild.stdin!.end()
    const exited = await identityExit
    installation.close()
    return {
      fixtureKind: 'owned-real-Bash-identity-only',
      pid: identityChild.pid!,
      actualSpawnObserved: true,
      executable,
      sha256,
      closedBeforeFixtureDisposal,
      ownerRequestedStdinEOF: true,
      observedClose: identityClosed,
      ...exited,
      nativeTargetExecuted: false,
      syntheticMonitorCount: calls.length,
      fakeKillSignals: calls.map((call) => call.fakeKillSignals),
    }
  }
  return { native, spawn, calls, portable, identityChild, dispose }
}
