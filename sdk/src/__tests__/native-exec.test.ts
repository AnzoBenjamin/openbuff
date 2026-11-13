import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  captureNativeMountPolicy,
  calibrateNativeClock,
  joinNativeScopeCleanup,
  retainedNativeScopes,
  dispatchNativeLaunch,
  encodeNativeFrame,
  NativeFrameDecoder,
  nativeAdapterOptions,
  nativeExpiryNs,
  verifyNativeInstallation,
} from '../services/native-exec'
import {
  createControlledExecutionClock,
  createTerminalExecutionFixture,
} from './fixtures/b19-terminal-execution'
import { createNativeRunCleanupFixture } from './fixtures/b21-native-run-cleanup'
import { admitNodeLaunch } from '../services/execution-launch'
import type {
  ProfileRequest,
  Result,
} from '@codebuff/common/types/contracts/execution-context'
import type {
  NativeDispatchHandle,
  VerifiedNativeInstallation,
} from '../services/native-exec'

const directories: string[] = []
const opened: VerifiedNativeInstallation[] = []
afterEach(() => {
  for (const installation of opened.splice(0)) installation.close()
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b21-artifact-'))
  directories.push(dir)
  const file = path.join(dir, 'native.elf')
  fs.copyFileSync('/usr/bin/bash', file)
  fs.chmodSync(file, 0o700)
  const sha256 = createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')
  const options = {
    artifact: {
      path: file,
      sha256,
      platform: 'linux-x64-gnu' as const,
      crateVersion: '0.1.0',
      workspaceProtocol: '1',
    },
    bwrap: { path: '/usr/bin/bash', sha256 },
  }
  return { dir, file, options }
}
function install(options: Parameters<typeof verifyNativeInstallation>[0]) {
  const result = verifyNativeInstallation(options)
  if (!result.ok) throw new Error(result.cause)
  opened.push(result.value)
  return result.value
}
function mounts(dir: string) {
  const result = captureNativeMountPolicy({
    projectRoot: dir,
    allowedPaths: [],
    runtimePaths: [],
    policy: 'workspace-write',
  })
  if (!result.ok) throw new Error(result.cause)
  return result.value
}

describe('native artifact generation before target dispatch', () => {
  test('missing, nonregular, nonexecutable and corrupt files refuse', () => {
    const { dir, file, options } = fixture()
    expect(
      verifyNativeInstallation({
        ...options,
        artifact: { ...options.artifact, path: `${file}-missing` },
      }).ok,
    ).toBe(false)
    expect(
      verifyNativeInstallation({
        ...options,
        artifact: { ...options.artifact, path: dir },
      }).ok,
    ).toBe(false)
    fs.chmodSync(file, 0o600)
    expect(verifyNativeInstallation(options).ok).toBe(false)
    fs.chmodSync(file, 0o700)
    fs.appendFileSync(file, Buffer.from([0x5a]))
    expect(verifyNativeInstallation(options).ok).toBe(false)
  })
  test('opened selected ELF survives pathname replacement without selecting replacement bytes', () => {
    const { dir, file, options } = fixture(),
      installation = install(options),
      policy = mounts(dir)
    fs.renameSync(file, `${file}-original`)
    fs.writeFileSync(file, 'corrupt replacement')
    expect(nativeAdapterOptions(installation, policy).ok).toBe(true)
    expect(verifyNativeInstallation(options).ok).toBe(false)
  })
  test('same-inode byte drift and copied installation registration refuse', () => {
    const { dir, file, options } = fixture(),
      installation = install(options),
      policy = mounts(dir)
    expect(nativeAdapterOptions({ ...installation }, policy).ok).toBe(false)
    fs.appendFileSync(file, Buffer.from([0x5a]))
    expect(nativeAdapterOptions(installation, policy).ok).toBe(false)
  })
  test('workspace lexical symlink does not authorize its external target', () => {
    const { dir } = fixture()
    const link = path.join(dir, 'outside')
    fs.symlinkSync('/usr', link)
    expect(
      captureNativeMountPolicy({
        projectRoot: dir,
        allowedPaths: [link],
        runtimePaths: [],
        policy: 'workspace-write',
      }).ok,
    ).toBe(false)
  })
  test('an unregistered clock mapping cannot restart an original deadline', () => {
    const { options } = fixture(),
      installation = install(options)
    const clock = { domainId: 'test-clock', nowMs: () => 100 }
    expect(
      nativeExpiryNs(
        {
          domainId: 'test-clock',
          hostSendMs: 1,
          hostReceiveMs: 2,
          nativeSampleNs: '1000',
        },
        installation,
        clock,
        350,
      ).ok,
    ).toBe(false)
  })
})

describe('native private output framing', () => {
  test('partial headers and bodies decode only complete frames', () => {
    const decoder = new NativeFrameDecoder(),
      frame = encodeNativeFrame({ type: 'prepared', scopeId: 'scope' })
    const values: Record<string, unknown>[] = []
    for (const byte of frame) values.push(...decoder.push(Buffer.from([byte])))
    expect(values).toEqual([{ type: 'prepared', scopeId: 'scope' }])
    decoder.end()
  })
  test('EOF in partial frames and zero/oversized lengths refuse', () => {
    const decoder = new NativeFrameDecoder()
    decoder.push(Buffer.from([2, 0]))
    expect(() => decoder.end()).toThrow()
    expect(() => new NativeFrameDecoder().push(Buffer.alloc(4))).toThrow()
    const oversized = Buffer.alloc(4)
    oversized.writeUInt32LE(65537)
    expect(() => new NativeFrameDecoder().push(oversized)).toThrow()
  })
  test('duplicate nested fields, invalid UTF8, malformed/nonobject JSON refuse', () => {
    for (const body of [
      Buffer.from('{"x":{"a":1,"a":2}}'),
      Buffer.from([0xff]),
      Buffer.from('{'),
      Buffer.from('[]'),
    ]) {
      const header = Buffer.alloc(4)
      header.writeUInt32LE(body.length)
      expect(() =>
        new NativeFrameDecoder().push(Buffer.concat([header, body])),
      ).toThrow()
    }
  })
  test('raw target binary is not a valid native control frame', () => {
    expect(() =>
      new NativeFrameDecoder().push(
        Buffer.from('RAW-TARGET\0\xff\n', 'latin1'),
      ),
    ).toThrow()
  })
})

describe('owned native calibration settlement controls', () => {
  function missingCloseChild() {
    const child = new EventEmitter() as ChildProcess
    const kills: string[] = []
    Object.assign(child, {
      pid: 42,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill(signal: string) {
        kills.push(signal)
        return true
      },
    })
    return { child, kills }
  }
  test('an already exhausted owned deadline refuses without setup', async () => {
    const controlled = createControlledExecutionClock()
    const h = createTerminalExecutionFixture({
      ...controlled,
      actionLimit: { kind: 'finite', durationMs: 25 },
    })
    try {
      const installation = install(fixture().options)
      controlled.advance(25)
      let calls = 0
      const result = await calibrateNativeClock(
        installation,
        controlled.clock,
        () => {
          calls++
          throw new Error('must not dispatch')
        },
        h.context.signal,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('deadline-exhausted')
      expect(calls).toBe(0)
    } finally {
      h.dispose()
    }
  })
  test('owned deadline settles even without close and retains setup cleanup description', async () => {
    const controlled = createControlledExecutionClock()
    const h = createTerminalExecutionFixture({
      ...controlled,
      actionLimit: { kind: 'finite', durationMs: 25 },
    })
    try {
      const installation = install(fixture().options),
        fake = missingCloseChild()
      const pending = calibrateNativeClock(
        installation,
        controlled.clock,
        () => ({ ok: true, value: fake.child }),
        h.context.signal,
      )
      controlled.advance(25)
      const result = await pending
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('deadline-exhausted')
        expect(result).toMatchObject({
          cleanupPending: true,
          setupPid: 42,
          cleanupAuthority: 'original-host-setup-owner',
        })
      }
      expect(fake.kills).toEqual(['SIGKILL'])
      fake.child.emit('close', 0)
      expect(result.ok).toBe(false)
    } finally {
      h.dispose()
    }
  })
  test('independent setup timeout is unavailable and bounded without close', async () => {
    const installation = install(fixture().options),
      fake = missingCloseChild()
    const start = performance.now()
    const result = await calibrateNativeClock(
      installation,
      { domainId: 'owned-calibration-timeout', nowMs: () => performance.now() },
      () => ({ ok: true, value: fake.child }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unavailable')
    expect(performance.now() - start).toBeLessThan(2500)
    expect(fake.kills).toEqual(['SIGKILL'])
  }, 3000)
  for (const scenario of [
    'deadline-error',
    'cancel-error',
    'deadline-close',
  ] as const) {
    test(`earlier child ${scenario} listener preserves original signal provenance`, async () => {
      const controlled = createControlledExecutionClock()
      const h = createTerminalExecutionFixture({
        ...controlled,
        actionLimit: { kind: 'finite', durationMs: 25 },
      })
      const cancel = new AbortController()
      const signal =
        scenario === 'cancel-error' ? cancel.signal : h.context.signal!
      const installation = install(fixture().options),
        fake = missingCloseChild()
      signal.addEventListener(
        'abort',
        () => {
          if (scenario === 'deadline-close') {
            fake.child.stdout!.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  execProtocol: 'openbuff.exec.v1',
                  workspaceProtocol: '1',
                  crateVersion: '0.1.0',
                  platform: 'linux-x64-gnu',
                  monotonicNs: '1000000',
                }),
              ),
            )
            fake.child.emit('close', 0)
          } else
            fake.child.emit('error', new Error('Execution deadline exhausted'))
        },
        { once: true },
      )
      try {
        const pending = calibrateNativeClock(
          installation,
          controlled.clock,
          () => ({ ok: true, value: fake.child }),
          signal,
        )
        if (scenario === 'cancel-error')
          cancel.abort('Execution deadline exhausted')
        else controlled.advance(25)
        const result = await pending
        expect(result.ok).toBe(false)
        if (!result.ok)
          expect(result.reason).toBe(
            scenario === 'cancel-error' ? 'cancelled' : 'deadline-exhausted',
          )
      } finally {
        h.dispose()
      }
    })
  }
})

describe('private dispatch installation ownership', () => {
  function value<T>(result: Result<T>): T {
    if (!result.ok) throw new Error(result.cause)
    return result.value
  }
  async function registered() {
    const controlled = createControlledExecutionClock()
    // Only the fixture's separately owned Bash supplies executable identity;
    // all native entry/status/control bytes in these tests are injected.
    const f = await createNativeRunCleanupFixture(controlled.clock)
    const h = createTerminalExecutionFixture({
      ...controlled,
      resolveProfile: (requested) => ({
        requested,
        available: [
          {
            backend: 'native-exec',
            generation: f.native.installation.artifact.sha256,
            capabilities: ['exact-env', 'cooperative-cancellation'],
            unavailableReasons: [],
          },
        ],
        selected: {
          backend: 'native-exec',
          generation: f.native.installation.artifact.sha256,
          policy: requested.policy,
          cancellation: 'cooperative',
        },
        active: null,
        enforced: [],
      }),
    })
    const mounts = value(
      captureNativeMountPolicy({
        projectRoot: process.cwd(),
        allowedPaths: [],
        runtimePaths: ['/usr/bin/bash'],
        policy: 'full-access',
      }),
    )
    const selection = {
      network: 'inherit' as const,
      landlock: 'disabled' as const,
    }
    const pins = value(
      nativeAdapterOptions(f.native.installation, mounts, selection),
    )
    const profile: ProfileRequest = {
      policy: 'full-access',
      preferredBackend: 'native-exec',
      required: ['exact-env'],
      allowBackendFallback: false,
    }
    const target = value(
      h.context.execution.prepareTarget({
        target: {
          executable: '/usr/bin/bash',
          argv: ['-c', 'printf native-live-fixture'],
          cwd: process.cwd(),
          projectRoot: process.cwd(),
          allowedPaths: [],
          mode: 'assistant',
          processType: 'SYNC',
          family: 'sync-shell',
          branchId: 'fixture.private-installation-lease',
          profile,
          adapterOptions: {
            ...pins,
            runtime: 'node',
            stdio: 'pipe',
            shell: false,
            detached: false,
          },
        },
      }),
    )
    return {
      controlled,
      f,
      h,
      mounts,
      selection,
      admitted: value(await admitNodeLaunch(target)),
    }
  }
  function successfulFinal(frame: Record<string, unknown>) {
    return {
      ...frame,
      exitCode: 7,
      signal: null,
      waitStatusSource: 'native-target-wait',
      wrapperExitCode: 0,
      wrapperSignal: null,
      cause: null,
      targetUsage: {
        cpuMicros: 12,
        maxRssKiB: 34,
        scope: 'actual-target-wait4; maxrss is target peak',
      },
      cleanup: {
        ...(frame.cleanup as Record<string, unknown>),
        complete: true,
        outerChildReaped: true,
        allChildrenReaped: true,
      },
    }
  }
  async function protocolControl(
    transform: (frame: Record<string, unknown>) => Record<string, unknown>[],
  ) {
    const r = await registered()
    try {
      const dispatched = value(
        dispatchNativeLaunch(r.admitted, {
          installation: r.f.native.installation,
          mapping: r.f.native.mapping,
          clock: r.controlled.clock,
          mounts: r.mounts,
          ...r.selection,
          spawn(command, argv, options) {
            const child = r.f.spawn(command, argv, options)
            const original = child.stdio[4] as PassThrough
            const reports = new PassThrough()
            const decoder = new NativeFrameDecoder()
            original.on('data', (bytes: Buffer) => {
              for (const frame of decoder.push(bytes)) {
                for (const successor of transform(frame))
                  reports.write(encodeNativeFrame(successor))
              }
            })
            original.once('end', () => reports.end())
            Object.assign(child, {
              stdio: [...child.stdio.slice(0, 4), reports],
            })
            return child
          },
        }),
      )
      const native = dispatched as NativeDispatchHandle
      const started = await native.started
      const drained = Promise.all([
        new Promise<void>((resolve) =>
          dispatched.child.stdout!.once('end', resolve),
        ),
        new Promise<void>((resolve) =>
          dispatched.child.stderr!.once('end', resolve),
        ),
      ])
      r.f.calls[0].finish()
      const result = await native.nativeResult
      await drained
      const cleanup = await dispatched.scope.requestStop('normal-leader-exit')
      return { started, result, cleanup }
    } finally {
      r.h.dispose()
      await r.f.dispose()
    }
  }
  test('a genuine target wait can differ from the wrapper exit', async () => {
    const r = await protocolControl((frame) => [
      frame.type === 'final' ? successfulFinal(frame) : frame,
    ])
    expect(r.started.ok).toBe(true)
    expect(value(r.result)).toMatchObject({
      exitCode: 7,
      wrapperExitCode: 0,
      waitStatusSource: 'native-target-wait',
      targetUsage: { cpuMicros: 12 },
    })
    expect(r.cleanup.status).toBe('complete')
  })
  test('qualified unavailable target wait fails while retaining physical cleanup proof', async () => {
    const r = await protocolControl((frame) => {
      if (frame.type !== 'final') return [frame]
      return [
        {
          ...successfulFinal(frame),
          exitCode: null,
          signal: null,
          waitStatusSource: 'not-observed',
          targetUsage: null,
          cause: 'Genuine native target wait status unavailable',
        },
      ]
    })
    expect(r.started.ok).toBe(true)
    expect(r.result).toMatchObject({
      ok: false,
      reason: 'unavailable',
      cause: 'Genuine native target wait status unavailable',
    })
    expect(r.cleanup).toMatchObject({
      status: 'complete',
      cleanupAuthorityRetained: false,
    })
  })
  for (const corruption of [
    'direct-target',
    'bwrap-target-exit',
    'bwrap-status-ambiguous',
    'missing-unavailable-cause',
    'empty-unavailable-cause',
    'whitespace-unavailable-cause',
    'unobserved-target-usage',
    'genuine-missing-target-usage',
  ] as const) {
    test(`current waiter final refuses ${corruption} followed by genuine status`, async () => {
      const r = await protocolControl((frame) => {
        if (frame.type !== 'final') return [frame]
        const genuine = successfulFinal(frame)
        const unavailable = {
          ...genuine,
          exitCode: null,
          signal: null,
          targetUsage: null,
          waitStatusSource: 'not-observed',
          cause: 'Genuine native target wait status unavailable',
        }
        const invalid =
          corruption === 'genuine-missing-target-usage'
            ? { ...genuine, targetUsage: null }
            : corruption === 'direct-target' ||
                corruption === 'bwrap-target-exit'
              ? {
                  ...genuine,
                  waitStatusSource: corruption,
                  wrapperExitCode: 7,
                  targetUsage: null,
                }
              : corruption === 'bwrap-status-ambiguous'
                ? { ...unavailable, waitStatusSource: corruption }
                : corruption === 'unobserved-target-usage'
                  ? { ...unavailable, targetUsage: genuine.targetUsage }
                  : {
                      ...unavailable,
                      cause:
                        corruption === 'missing-unavailable-cause'
                          ? null
                          : corruption === 'empty-unavailable-cause'
                            ? ''
                            : ' \t\n',
                    }
        return [invalid, genuine]
      })
      expect(r.started.ok).toBe(true)
      expect(r.result.ok).toBe(false)
      expect(r.cleanup).toMatchObject({
        status: 'unknown',
        cleanupAuthorityRetained: true,
      })
    })
  }
  for (const corruption of [
    'malformed-status',
    'target-pid',
    'waiter-generation',
    'scope-tier',
    'entry-regression',
  ] as const) {
    test(`invalid final ${corruption} cannot be laundered by a later valid final`, async () => {
      const r = await protocolControl((frame) => {
        if (frame.type !== 'final') return [frame]
        const valid = successfulFinal(frame)
        const invalid = {
          ...valid,
          ...(corruption === 'malformed-status' ? { exitCode: '7' } : {}),
          ...(corruption === 'target-pid'
            ? { targetPid: Number(frame.targetPid) + 1 }
            : {}),
          ...(corruption === 'waiter-generation'
            ? { waiterStartTime: '99' }
            : {}),
          ...(corruption === 'scope-tier'
            ? {
                pidNamespace: 'pid:[123]',
                namespaceDepth: 2,
                cleanup: {
                  ...valid.cleanup,
                  scopeTier: 'linux-pid-namespace',
                  pidNamespace: 'pid:[123]',
                  namespaceAbsent: true,
                  initAbsent: true,
                },
              }
            : {}),
          ...(corruption === 'entry-regression'
            ? {
                targetEntry: 'not-entered',
                exitCode: null,
                waitStatusSource: 'not-observed',
                targetUsage: null,
              }
            : {}),
        }
        return [invalid, valid]
      })
      expect(r.started.ok).toBe(true)
      expect(r.result.ok).toBe(false)
      expect(r.cleanup).toMatchObject({
        status: 'unknown',
        cleanupAuthorityRetained: true,
      })
    })
  }
  for (const corruption of [
    'created-waiter',
    'entered-target',
    'repeat-created',
  ]) {
    test(`invalid ${corruption} refuses target entry`, async () => {
      const r = await protocolControl((frame) => {
        if (frame.type === 'target-created') {
          if (corruption === 'created-waiter')
            return [{ ...frame, waiterStartTime: '99' }]
          if (corruption === 'repeat-created') return [frame, frame]
        }
        if (frame.type === 'target-entered' && corruption === 'entered-target')
          return [{ ...frame, targetPid: Number(frame.pid) + 1 }]
        return [frame]
      })
      expect(r.started.ok).toBe(false)
      expect(r.result.ok).toBe(false)
      expect(r.cleanup.status).toBe('unknown')
    })
  }
  test('owner close blocks new work while the live registered dispatch keeps its held generation', async () => {
    const r = await registered()
    let held = -1
    try {
      const dispatched = value(
        dispatchNativeLaunch(r.admitted, {
          installation: r.f.native.installation,
          mapping: r.f.native.mapping,
          clock: r.controlled.clock,
          mounts: r.mounts,
          ...r.selection,
          spawn(command, argv, options) {
            held = Number(
              options?.stdio instanceof Array ? options.stdio[5] : -1,
            )
            const child = r.f.spawn(command, argv, options)
            r.f.native.installation.close()
            expect(fs.fstatSync(held).isFile()).toBe(true)
            return child
          },
        }),
      )
      expect((await dispatched.started).ok).toBe(true)
      expect(
        nativeAdapterOptions(r.f.native.installation, r.mounts, r.selection).ok,
      ).toBe(false)
      expect(
        nativeExpiryNs(
          r.f.native.mapping,
          r.f.native.installation,
          r.controlled.clock,
          500,
        ).ok,
      ).toBe(false)
      expect(fs.fstatSync(held).isFile()).toBe(true)
      r.f.calls[0].finish()
      await dispatched.nativeResult
      expect(() => fs.fstatSync(held)).toThrow()
    } finally {
      r.h.dispose()
      await r.f.dispose()
    }
  })
  test('no-process spawn failure releases the held lease after owner close', async () => {
    const r = await registered()
    let held = -1
    try {
      const dispatched = dispatchNativeLaunch(r.admitted, {
        installation: r.f.native.installation,
        mapping: r.f.native.mapping,
        clock: r.controlled.clock,
        mounts: r.mounts,
        ...r.selection,
        spawn(_command, _argv, options) {
          held = Number(options?.stdio instanceof Array ? options.stdio[5] : -1)
          r.f.native.installation.close()
          expect(fs.fstatSync(held).isFile()).toBe(true)
          throw new Error('owned no-process spawn failure')
        },
      })
      expect(dispatched.ok).toBe(false)
      expect(() => fs.fstatSync(held)).toThrow()
      expect(r.f.calls).toHaveLength(0)
    } finally {
      r.h.dispose()
      await r.f.dispose()
    }
  })
  test('post-spawn setup throw keeps failed-kill monitor root-visible until close', async () => {
    const r = await registered()
    const hostId = r.admitted.launch.facts().hostContextId
    const signals: string[] = []
    let held = -1
    try {
      const dispatched = dispatchNativeLaunch(r.admitted, {
        installation: r.f.native.installation,
        mapping: r.f.native.mapping,
        clock: r.controlled.clock,
        mounts: r.mounts,
        ...r.selection,
        spawn(command, argv, options) {
          held = Number(options?.stdio instanceof Array ? options.stdio[5] : -1)
          const child = r.f.spawn(command, argv, options)
          Object.defineProperty(child, 'stdio', {
            get() {
              throw new Error('owned post-spawn stdio refusal')
            },
          })
          child.kill = (signal) => {
            signals.push(String(signal))
            return false
          }
          r.f.native.installation.close()
          return child
        },
      })
      expect(dispatched.ok).toBe(false)
      const scopes = retainedNativeScopes(hostId)
      expect(scopes).toHaveLength(1)
      const results = await joinNativeScopeCleanup(hostId)
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        status: 'unknown',
        cleanupAuthorityRetained: true,
      })
      expect(fs.fstatSync(held).isFile()).toBe(true)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(r.f.calls[0].commands).toHaveLength(0)
      const closed = new Promise((resolve) =>
        r.f.calls[0].child.once('close', resolve),
      )
      const drained = Promise.all([
        new Promise((resolve) =>
          r.f.calls[0].child.stdout!.once('end', resolve),
        ),
        new Promise((resolve) =>
          r.f.calls[0].child.stderr!.once('end', resolve),
        ),
      ])
      r.f.calls[0].finish()
      await closed
      await drained
      const successor = await scopes[0].retryCleanup(true)
      expect(successor.firstStopAtMs).toBe(results[0].firstStopAtMs)
      expect(successor.observeUntilMs).toBe(results[0].observeUntilMs)
      expect(successor.cleanupAuthorityRetained).toBe(false)
      expect(() => fs.fstatSync(held)).toThrow()
      expect(retainedNativeScopes(hostId)).toHaveLength(0)
    } finally {
      r.h.dispose()
      await r.f.dispose()
    }
  }, 3000)
})
