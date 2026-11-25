import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { registerInjectedNodeScopeDriver } from '@codebuff/common/util/node-process-scope'
import { executionClock } from '../host-execution'
import { nodeConfigReadFs } from '../host-config'
import { createConfiguredDirectHostExecution } from '../services/direct-host-execution'
import {
  admitNodeLaunch,
  dispatchNodeLaunch,
  prepareNodeLaunch,
  retainedNodeScopes,
  trustedNodeSpawn,
} from '../services/execution-launch'
import { retainedNativeScopes } from '../services/native-exec'
import {
  createExecutionProcessRecorder,
  executionValue,
} from './fixtures/b19-terminal-execution'
import { createNativeRunCleanupFixture } from './fixtures/b21-native-run-cleanup'

import type { ChildProcess } from 'node:child_process'
import type { ProfileRequest } from '@codebuff/common/types/contracts/execution-context'
import type { ScopeObservation } from '@codebuff/common/types/contracts/process-scope'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { HostConfigurationInputs } from '../host-config'

const disposals: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

const portableProfile: ProfileRequest = {
  policy: 'workspace-write',
  preferredBackend: 'portable-ts',
  required: ['exact-env'],
  allowBackendFallback: false,
}

function fixture(execution?: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'configured-direct-host-'))
  disposals.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const configPath = path.join(root, 'openbuff.json')
  fs.writeFileSync(configPath, JSON.stringify({ providers: {}, execution }))
  const inputs: HostConfigurationInputs = {
    environment: { PATH: '/usr/bin', INHERITED: 'captured-only' },
    platform: process.platform,
    invocationCwd: root,
    projectRoot: root,
    home: { kind: 'none' },
    globals: { kind: 'disabled' },
    selection: { kind: 'explicit', path: configPath, required: true },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  }
  return { root, configPath, inputs }
}

function target(
  executionContext: Parameters<typeof prepareNodeLaunch>[0]['executionContext'],
  cwd: string,
) {
  return {
    executionContext,
    executable: 'bash',
    argv: ['-c', 'printf configured-direct-fixture'],
    shellCommandBytes: 'printf configured-direct-fixture',
    cwd,
    family: 'sync-shell' as const,
    branchId: 'terminal.sync',
    adapterOptions: { shell: false, stdio: 'pipe', detached: true },
  }
}

describe('configured direct host operation', () => {
  test('captures one configuration snapshot and exact user cwd/env/profile; close owns live Node cleanup', async () => {
    const f = fixture({ profile: portableProfile })
    const controller = new AbortController()
    const recorder = createExecutionProcessRecorder({ autoClose: false })
    const env = { PATH: '/explicit/bin', EXPLICIT: 'captured-before-await' }
    let reads = 0
    const pending = createConfiguredDirectHostExecution({
      cwd: f.root,
      projectRoot: f.root,
      hostConfiguration: f.inputs,
      configReadFs: {
        ...nodeConfigReadFs,
        readFile(file) {
          reads++
          return nodeConfigReadFs.readFile(file)
        },
      },
      env,
      inheritEnv: false,
      signal: controller.signal,
      limit: { kind: 'finite', durationMs: 600_000 },
      mode: 'user',
      spawn: recorder.spawn,
    })
    env.EXPLICIT = 'mutated-after-entry'
    const host = executionValue(await pending)
    disposals.push(host.close)
    expect(reads).toBe(2) // Initial named read and consistency recheck, one capture.
    fs.writeFileSync(
      f.configPath,
      JSON.stringify({
        execution: { profile: { ...portableProfile, policy: 'read-only' } },
      }),
    )
    expect(
      host.hostServices.provider.snapshot.loaded.config.execution?.profile,
    ).toEqual(portableProfile)
    expect(host.executionContext.mode).toBe('user')
    expect(host.executionContext.projectRoot).toBe(f.root)
    expect(host.executionContext.profile).toEqual(portableProfile)
    expect(host.executionContext.spawn).toBe(recorder.spawn)
    const prepared = executionValue(
      prepareNodeLaunch(target(host.executionContext, f.root)),
    )
    expect(prepared.facts().deadlines.action).toMatchObject({ kind: 'finite' })
    const handle = executionValue(
      dispatchNodeLaunch(
        executionValue(await admitNodeLaunch(prepared)),
        (input) =>
          trustedNodeSpawn(host.executionContext)(
            input.executable,
            [...input.argv],
            {
              cwd: input.cwd,
              env: input.env,
              detached: true,
              stdio: 'pipe',
            },
          ),
      ),
    )
    expect((await handle.started).ok).toBe(true)
    expect(recorder.calls).toHaveLength(1)
    expect(recorder.calls[0].options.env).toEqual({
      PATH: '/explicit/bin',
      EXPLICIT: 'captured-before-await',
    })
    expect(recorder.calls[0].options.cwd).toBe(f.root)
    let reentrantClose: Promise<readonly unknown[]> | undefined
    host.executionContext.signal?.addEventListener(
      'abort',
      () => {
        reentrantClose = host.close()
      },
      { once: true },
    )
    const close = host.close()
    expect(reentrantClose).toBe(close)
    expect(host.executionContext.signal?.aborted).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    expect(host.close()).toBe(close)
    const cleanup = await close
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]).toMatchObject({
      status: 'complete',
      selectedTier: 'injected',
    })
    expect(recorder.calls[0].closed).toBe(true)
    expect(host.close()).toBe(close)
    expect(await host.close()).toBe(cleanup)
    expect(reads).toBe(2)
    expect(
      prepareNodeLaunch(target(host.executionContext, f.root)),
    ).toMatchObject({ ok: false, reason: 'cancelled' })
  })

  test('assistant remains the default and inheritance uses only the captured environment', async () => {
    const f = fixture()
    const host = executionValue(
      await createConfiguredDirectHostExecution({
        cwd: f.root,
        hostConfiguration: f.inputs,
        env: { OVERLAY: 'present' },
      }),
    )
    disposals.push(host.close)
    expect(host.executionContext.mode).toBe('assistant')
    const launch = executionValue(
      prepareNodeLaunch(target(host.executionContext, f.root)),
    )
    const admitted = executionValue(await admitNodeLaunch(launch))
    const recorder = createExecutionProcessRecorder()
    const handle = executionValue(
      dispatchNodeLaunch(admitted, (input) =>
        recorder.spawn(input.executable, [...input.argv], { env: input.env }),
      ),
    )
    expect((await handle.started).ok).toBe(true)
    expect(recorder.calls[0].options.env).toEqual({
      PATH: '/usr/bin',
      INHERITED: 'captured-only',
      OVERLAY: 'present',
    })
    expect((await host.close())[0].originalDeadline.kind).toBe('unbounded')
  })

  test('caller cancellation after setup fences dispatch and owns current cleanup', async () => {
    const f = fixture(),
      controller = new AbortController()
    const host = executionValue(
      await createConfiguredDirectHostExecution({
        cwd: f.root,
        hostConfiguration: f.inputs,
        signal: controller.signal,
      }),
    )
    disposals.push(host.close)
    controller.abort(new Error('caller ended'))
    expect(host.executionContext.signal?.aborted).toBe(true)
    expect(
      prepareNodeLaunch(target(host.executionContext, f.root)),
    ).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(await host.close()).toEqual([])
  })

  test('configuration reads consume the original finite root budget', async () => {
    const f = fixture()
    let readObserved = false
    const result = await createConfiguredDirectHostExecution({
      cwd: f.root,
      hostConfiguration: f.inputs,
      limit: { kind: 'finite', durationMs: 1 },
      configReadFs: {
        ...nodeConfigReadFs,
        readFile(file) {
          readObserved = true
          const until = performance.now() + 10
          while (performance.now() < until) {
            /* synchronous capture cost */
          }
          return nodeConfigReadFs.readFile(file)
        },
      },
    })
    expect(readObserved).toBe(true)
    expect(result).toMatchObject({
      ok: false,
      reason: 'deadline-exhausted',
      cleanup: [],
    })
  })

  test('missing configuration and already-ended caller refuse without a process', async () => {
    const f = fixture(),
      recorder = createExecutionProcessRecorder()
    fs.unlinkSync(f.configPath)
    expect(
      await createConfiguredDirectHostExecution({
        cwd: f.root,
        hostConfiguration: f.inputs,
        spawn: recorder.spawn,
      }),
    ).toMatchObject({ ok: false, reason: 'unavailable', cleanup: [] })
    const controller = new AbortController()
    controller.abort()
    expect(
      await createConfiguredDirectHostExecution({
        cwd: f.root,
        hostConfiguration: { ...f.inputs, selection: { kind: 'none' } },
        signal: controller.signal,
        spawn: recorder.spawn,
      }),
    ).toMatchObject({ ok: false, reason: 'cancelled', cleanup: [] })
    expect(recorder.calls).toHaveLength(0)
  })

  test('discovered project execution declaration stays refused despite read trust', async () => {
    const f = fixture({ profile: portableProfile })
    const result = await createConfiguredDirectHostExecution({
      cwd: f.root,
      hostConfiguration: {
        ...f.inputs,
        selection: { kind: 'discover' },
        trust: { ancestorConfig: true, projectReadableRoots: true },
      },
      mode: 'user',
    })
    expect(result).toMatchObject({ ok: false, reason: 'denied', cleanup: [] })
  })
})

function nativeDeclaration() {
  const executable = '/usr/bin/bash'
  const sha256 = createHash('sha256')
    .update(fs.readFileSync(executable))
    .digest('hex')
  return {
    profile: { ...portableProfile, preferredBackend: 'native-exec' as const },
    native: {
      artifact: {
        path: executable,
        sha256,
        platform: 'linux-x64-gnu' as const,
        crateVersion: '0.1.0' as const,
        workspaceProtocol: '1' as const,
      },
      bwrap: { path: executable, sha256 },
      runtimePaths: [executable],
      network: 'deny' as const,
      landlock: 'optional' as const,
    },
  }
}

/** Synthetic version/cleanup observations with genuine held descriptor checks. */
function versionDriver(
  options: { beforeReport?: () => void; unknown?: boolean } = {},
) {
  const calls: Parameters<CodebuffSpawn>[] = []
  let uncertain = options.unknown ?? false
  const spawn: CodebuffSpawn = (...args) => {
    calls.push(args)
    const stdout = new PassThrough(),
      stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      pid: 808080,
      stdout,
      stderr,
      stdin: null,
      exitCode: null,
      signalCode: null,
      kill: () => false,
    }) as unknown as ChildProcess
    const observe = (): ScopeObservation => ({
      sampledAtMs: executionClock.nowMs(),
      clockDomainId: executionClock.domainId,
      leader: 'exited-reaped',
      scopePresence: uncertain ? 'unknown' : 'absent',
      members: [],
      membershipComplete: !uncertain,
      identity: uncertain ? 'unknown' : 'verified',
      streams: { stdin: 'closed', stdout: 'drained', stderr: 'drained' },
    })
    registerInjectedNodeScopeDriver(child, {
      leaderExited: Promise.resolve('exited-reaped'),
      streamsFinished: Promise.resolve(observe().streams),
      observe: async () => observe(),
      signal: async (signal) => ({
        signal,
        atMs: executionClock.nowMs(),
        targetTier: 'injected',
        result: uncertain ? 'unknown' : 'already-absent',
      }),
      closeInput() {},
    })
    queueMicrotask(() => {
      child.emit('spawn')
      options.beforeReport?.()
      stdout.end(
        JSON.stringify({
          execProtocol: 'openbuff.exec.v1',
          workspaceProtocol: '1',
          crateVersion: '0.1.0',
          platform: 'linux-x64-gnu',
          monotonicNs: '100000000',
        }),
      )
      stderr.end()
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
    })
    return child
  }
  return {
    spawn,
    calls,
    async recover(hostId: string) {
      uncertain = false
      for (const scope of retainedNodeScopes(hostId))
        await scope.retryCleanup(true)
    },
  }
}

describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')(
  'configured direct native setup',
  () => {
    test('trusted native declaration is selected and its descriptor closes once after joined setup', async () => {
      const declaration = nativeDeclaration(),
        f = fixture(declaration),
        driver = versionDriver()
      const host = executionValue(
        await createConfiguredDirectHostExecution({
          cwd: f.root,
          hostConfiguration: f.inputs,
          mode: 'user',
          spawn: driver.spawn,
          env: { EXPLICIT: 'target-only' },
          inheritEnv: false,
        }),
      )
      disposals.push(host.close)
      expect(driver.calls).toHaveLength(1)
      expect(driver.calls[0].slice(0, 2)).toEqual([
        '/proc/self/fd/5',
        ['version', '--json'],
      ])
      expect(driver.calls[0][2]?.env).toEqual({ LANG: 'C', LC_ALL: 'C' })
      const fd = (driver.calls[0][2]?.stdio as number[])[5]
      expect(fs.fstatSync(fd).isFile()).toBe(true)
      expect(host.executionContext.profile).toEqual(declaration.profile)
      expect(host.executionContext.mode).toBe('user')
      expect(host.hostServices.profile.preferredBackend).toBe('native-exec')
      expect(host.cleanup).toHaveLength(1)
      expect(host.cleanup[0].status).toBe('complete')
      const close = host.close()
      expect(host.close()).toBe(close)
      expect(await close).toEqual(host.cleanup)
      expect(() => fs.fstatSync(fd)).toThrow()
    })

    test('corrupt native declaration fails closed even when fallback is allowed', async () => {
      const declaration = nativeDeclaration()
      declaration.native.artifact.sha256 = '0'.repeat(64)
      declaration.profile.allowBackendFallback = true
      const f = fixture(declaration),
        driver = versionDriver()
      expect(
        await createConfiguredDirectHostExecution({
          cwd: f.root,
          hostConfiguration: f.inputs,
          mode: 'user',
          spawn: driver.spawn,
        }),
      ).toMatchObject({
        ok: false,
        reason: 'unavailable',
        cause: expect.stringContaining('checksum mismatch'),
        cleanup: [],
      })
      expect(driver.calls).toHaveLength(0)
    })

    test('caller cancellation during calibration preserves setup cleanup and closes descriptor', async () => {
      const f = fixture(nativeDeclaration()),
        controller = new AbortController()
      const driver = versionDriver({
        beforeReport: () =>
          controller.abort(new Error('caller cancelled setup')),
      })
      const result = await createConfiguredDirectHostExecution({
        cwd: f.root,
        hostConfiguration: f.inputs,
        spawn: driver.spawn,
        signal: controller.signal,
      })
      expect(result).toMatchObject({ ok: false, reason: 'cancelled' })
      expect(result.ok ? [] : result.cleanup).toHaveLength(1)
      expect(result.ok ? null : result.cleanup[0].status).toBe('complete')
      const fd = (driver.calls[0][2]?.stdio as number[])[5]
      expect(() => fs.fstatSync(fd)).toThrow()
    })

    test('unknown setup cleanup stays a refusal with retained observations', async () => {
      const f = fixture(nativeDeclaration()),
        driver = versionDriver({ unknown: true })
      const result = await createConfiguredDirectHostExecution({
        cwd: f.root,
        hostConfiguration: f.inputs,
        spawn: driver.spawn,
      })
      expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
      if (result.ok) throw new Error('uncertain setup must refuse')
      expect(result.cleanup).toHaveLength(1)
      expect(result.cleanup[0]).toMatchObject({
        status: 'unknown',
        cleanupAuthorityRetained: true,
      })
      disposals.push(() =>
        driver.recover(result.cleanup[0].launchFacts!.hostContextId),
      )
    })

    test('close joins an owned native scope and returns incomplete native cleanup', async () => {
      const declaration = nativeDeclaration()
      declaration.profile.policy = 'full-access'
      const f = fixture(declaration),
        driver = versionDriver()
      const native = await createNativeRunCleanupFixture(executionClock)
      disposals.push(native.dispose)
      const spawn: CodebuffSpawn = (command, argv, options) =>
        argv?.[0] === 'version'
          ? driver.spawn(command, argv, options)
          : native.spawn(command, argv, options)
      const host = executionValue(
        await createConfiguredDirectHostExecution({
          cwd: f.root,
          hostConfiguration: f.inputs,
          mode: 'user',
          limit: { kind: 'finite', durationMs: 5000 },
          spawn,
        }),
      )
      disposals.push(host.close)
      const prepared = executionValue(
        prepareNodeLaunch({
          ...target(host.executionContext, f.root),
          argv: ['-c', 'printf native-live-fixture'],
          shellCommandBytes: 'printf native-live-fixture',
        }),
      )
      const handle = executionValue(
        dispatchNodeLaunch(
          executionValue(await admitNodeLaunch(prepared)),
          () => {
            throw new Error('native must use its registered adapter')
          },
        ),
      )
      executionValue(await handle.started)
      const fd = (driver.calls[0][2]?.stdio as number[])[5]
      let descriptorOpenAtNativeClose = false
      native.calls[0].child.once('close', () => {
        descriptorOpenAtNativeClose = fs.fstatSync(fd).isFile()
      })
      const cleanup = await host.close()
      expect(cleanup).toHaveLength(2)
      expect(cleanup[0]).toBe(host.cleanup[0])
      expect(cleanup[1]).toMatchObject({
        status: 'unknown',
        cleanupAuthorityRetained: true,
      })
      expect(descriptorOpenAtNativeClose).toBe(true)
      expect(() => fs.fstatSync(fd)).toThrow()
      expect(
        native.calls[0].commands.some((command) => command.type === 'stop'),
      ).toBe(true)
      expect(retainedNativeScopes(handle.facts().hostContextId)).toContain(
        handle.scope,
      )
      expect(native.portable.calls).toHaveLength(0)
    })
  },
)
