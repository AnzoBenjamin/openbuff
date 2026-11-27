import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { registerInjectedNodeScopeDriver } from '@codebuff/common/util/node-process-scope'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { configureHostExecution } from '../services/configured-host-execution'
import { retainedNodeScopes } from '../services/execution-launch'
import { run } from '../run'

import type { ChildProcess } from 'node:child_process'
import type {
  Clock,
  Limit,
} from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ScopeObservation } from '@codebuff/common/types/contracts/process-scope'

const disposals: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

function fixture(limit: Limit = { kind: 'finite', durationMs: 5000 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b21-configured-host-'))
  disposals.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const executable = '/usr/bin/bash'
  const sha256 = createHash('sha256')
    .update(fs.readFileSync(executable))
    .digest('hex')
  const configPath = path.join(root, 'openbuff.json')
  const execution = {
    profile: {
      policy: 'workspace-write' as const,
      preferredBackend: 'native-exec' as const,
      required: ['exact-env' as const],
      allowBackendFallback: false,
    },
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
  fs.writeFileSync(configPath, JSON.stringify({ providers: {}, execution }))
  const inputs = {
    environment: { SECRET: 'must-not-inherit' },
    platform: 'linux' as const,
    invocationCwd: root,
    projectRoot: root,
    home: { kind: 'none' as const },
    globals: { kind: 'disabled' as const },
    selection: {
      kind: 'explicit' as const,
      path: configPath,
      required: true as const,
    },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  }
  const captured = loadHostConfigSnapshot({ inputs, fs: nodeConfigReadFs })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  let now = 100
  const clock: Clock = {
    domainId: `config-test:${randomUUID()}`,
    nowMs: () => now,
  }
  const boundary = captureRootDeadline({ clock, limit })
  if (!boundary.ok) throw new Error(boundary.cause)
  return {
    root,
    configPath,
    execution,
    inputs,
    clock,
    snapshot: captured.snapshot,
    boundary: boundary.value,
    advance(ms: number) {
      now += ms
    },
  }
}

/** Genuine descriptor checks, synthetic version response and injected cleanup; no OS enforcement credit. */
function versionSpawn(
  clock: Clock,
  unknown = false,
  observeStart = true,
  beforeReport?: () => void,
) {
  const calls: Parameters<CodebuffSpawn>[] = []
  let child: ChildProcess | undefined
  let uncertain = unknown
  const spawn: CodebuffSpawn = (...args) => {
    calls.push(args)
    const stdout = new PassThrough(),
      stderr = new PassThrough()
    child = Object.assign(new EventEmitter(), {
      pid: 707070,
      stdout,
      stderr,
      stdin: null,
      exitCode: null,
      signalCode: null,
      kill: () => false,
    }) as unknown as ChildProcess
    const observation = (): ScopeObservation => ({
      sampledAtMs: clock.nowMs(),
      clockDomainId: clock.domainId,
      leader: 'exited-reaped',
      scopePresence: uncertain ? 'unknown' : 'absent',
      members: [],
      membershipComplete: !uncertain,
      identity: uncertain ? 'unknown' : 'verified',
      streams: { stdin: 'closed', stdout: 'drained', stderr: 'drained' },
    })
    registerInjectedNodeScopeDriver(child, {
      leaderExited: Promise.resolve('exited-reaped'),
      streamsFinished: Promise.resolve(observation().streams),
      observe: async () => observation(),
      signal: async (signal) => ({
        signal,
        atMs: clock.nowMs(),
        targetTier: 'injected',
        result: uncertain ? 'unknown' : 'already-absent',
      }),
      closeInput() {},
    })
    queueMicrotask(() => {
      if (observeStart) child!.emit('spawn')
      beforeReport?.()
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
      child!.emit('exit', 0, null)
      child!.emit('close', 0, null)
    })
    return child
  }
  return {
    spawn,
    calls,
    async recover(id: string) {
      uncertain = false
      for (const scope of retainedNodeScopes(id)) await scope.retryCleanup(true)
    },
  }
}

describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')(
  'configured native host setup',
  () => {
    test('calibration uses exact descriptor arguments, locale-only environment and an original-root child budget', async () => {
      const f = fixture(),
        driver = versionSpawn(f.clock)
      const result = await configureHostExecution({
        ...f,
        spawnSource: driver.spawn,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.cause)
      disposals.push(() => result.value.close())
      expect(driver.calls).toHaveLength(1)
      const [executable, argv, options] = driver.calls[0]
      expect(executable).toBe('/proc/self/fd/5')
      expect(argv).toEqual(['version', '--json'])
      expect(options?.env).toEqual({ LANG: 'C', LC_ALL: 'C' })
      expect(options?.detached).toBe(true)
      expect(fs.fstatSync((options?.stdio as number[])[5]).isFile()).toBe(true)
      expect(result.value.cleanup).toHaveLength(1)
      expect(result.value.cleanup[0].selectedTier).toBe('injected')
      expect(result.value.cleanup[0].status).toBe('complete')
      expect(result.value.cleanup[0].originalDeadline.kind).toBe('finite')
      if (result.value.cleanup[0].originalDeadline.kind === 'finite')
        expect(result.value.cleanup[0].originalDeadline.expiresAtMs).toBe(2100)
      expect(result.value.nativeExecution?.clock).toBe(f.clock)
    })

    test('root expiry during capture cannot receive a fresh setup budget or spawn', async () => {
      const f = fixture({ kind: 'finite', durationMs: 20 }),
        driver = versionSpawn(f.clock)
      f.advance(21)
      expect(
        await configureHostExecution({ ...f, spawnSource: driver.spawn }),
      ).toMatchObject({ ok: false, reason: 'deadline-exhausted' })
      expect(driver.calls).toHaveLength(0)
    })

    test('caller cancellation while dependency is pending settles without spawning or accepting a later dependency', async () => {
      const f = fixture(),
        controller = new AbortController(),
        driver = versionSpawn(f.clock)
      let resolve!: (spawn: CodebuffSpawn) => void
      const dependency = new Promise<CodebuffSpawn>((done) => {
        resolve = done
      })
      const pending = configureHostExecution({
        ...f,
        signal: controller.signal,
        spawnSource: dependency,
      })
      controller.abort(new Error('caller cancelled'))
      expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' })
      resolve(driver.spawn)
      await Promise.resolve()
      expect(driver.calls).toHaveLength(0)
    })

    test('corrupt declared installation refuses despite fallback permission', async () => {
      const f = fixture(),
        driver = versionSpawn(f.clock)
      f.execution.native.artifact.sha256 = '0'.repeat(64)
      f.execution.profile.allowBackendFallback = true
      fs.writeFileSync(f.configPath, JSON.stringify({ execution: f.execution }))
      const recaptured = loadHostConfigSnapshot({
        inputs: f.inputs,
        fs: nodeConfigReadFs,
      })
      if (recaptured.status !== 'complete') throw new Error(recaptured.cause)
      const result = await configureHostExecution({
        ...f,
        snapshot: recaptured.snapshot,
        spawnSource: driver.spawn,
      })
      expect(result).toMatchObject({
        ok: false,
        reason: 'unavailable',
        cause: expect.stringContaining('checksum mismatch'),
      })
      expect(driver.calls).toHaveLength(0)
    })

    test('discovered project execution stays denied when broad read trust is enabled', async () => {
      const f = fixture(),
        driver = versionSpawn(f.clock)
      const captured = loadHostConfigSnapshot({
        inputs: {
          ...f.inputs,
          selection: { kind: 'discover' },
          trust: { ancestorConfig: true, projectReadableRoots: true },
        },
        fs: nodeConfigReadFs,
      })
      if (captured.status !== 'complete') throw new Error(captured.cause)
      expect(
        await configureHostExecution({
          ...f,
          snapshot: captured.snapshot,
          spawnSource: driver.spawn,
        }),
      ).toMatchObject({ ok: false, reason: 'denied' })
      expect(driver.calls).toHaveLength(0)
    })

    test('successful version bytes without an observed Node start cannot establish setup', async () => {
      const f = fixture(),
        driver = versionSpawn(f.clock, false, false)
      const result = await configureHostExecution({
        ...f,
        spawnSource: driver.spawn,
      })
      expect(result).toMatchObject({
        ok: false,
        reason: 'unavailable',
        cause: expect.stringContaining('without a validated spawn'),
      })
    })

    test('version completion after the original setup expiry cannot yield a usable mapping', async () => {
      const f = fixture({ kind: 'unbounded' }),
        driver = versionSpawn(f.clock, false, true, () => f.advance(200))
      let resolve!: (spawn: CodebuffSpawn) => void
      const source = new Promise<CodebuffSpawn>((done) => {
        resolve = done
      })
      const pending = configureHostExecution({ ...f, spawnSource: source })
      f.advance(1900)
      resolve(driver.spawn)
      expect(await pending).toMatchObject({ ok: false, reason: 'unavailable' })
      expect(driver.calls).toHaveLength(1)
    })

    test('independent setup expiry before dispatch retains unavailable provenance', async () => {
      const f = fixture({ kind: 'unbounded' }),
        driver = versionSpawn(f.clock)
      const source = Promise.resolve(driver.spawn).then((spawn) => {
        f.advance(2001)
        return spawn
      })
      expect(
        await configureHostExecution({ ...f, spawnSource: source }),
      ).toMatchObject({ ok: false, reason: 'unavailable' })
      expect(driver.calls).toHaveLength(0)
    })

    test('null injected spawn never falls back to a real process', async () => {
      const f = fixture()
      const result = await configureHostExecution({
        ...f,
        spawnSource: null as unknown as CodebuffSpawn,
      })
      expect(result).toMatchObject({
        ok: false,
        reason: 'denied',
        cause: expect.stringContaining('not callable'),
      })
      expect('cleanup' in result ? result.cleanup : []).toHaveLength(0)
    })

    test('explicit SDK profile or native installation replaces the whole config decision', async () => {
      const f = fixture(),
        driver = versionSpawn(f.clock)
      const setup = await configureHostExecution({
        ...f,
        spawnSource: driver.spawn,
      })
      if (!setup.ok) throw new Error(setup.cause)
      disposals.push(() => setup.value.close())
      const captured = loadHostConfigSnapshot({
        inputs: { ...f.inputs, selection: { kind: 'discover' } },
        fs: nodeConfigReadFs,
      })
      if (captured.status !== 'complete') throw new Error(captured.cause)
      const portable = {
        ...f.execution.profile,
        preferredBackend: 'portable-ts' as const,
      }
      const profileOnly = await configureHostExecution({
        ...f,
        snapshot: captured.snapshot,
        profile: portable,
        spawnSource: driver.spawn,
      })
      expect(profileOnly.ok).toBe(true)
      if (profileOnly.ok) {
        expect(profileOnly.value.profile).toBe(portable)
        expect(profileOnly.value.nativeExecution).toBeUndefined()
      }
      const nativeOnly = await configureHostExecution({
        ...f,
        snapshot: captured.snapshot,
        nativeExecution: setup.value.nativeExecution,
        spawnSource: driver.spawn,
      })
      expect(nativeOnly.ok).toBe(true)
      if (nativeOnly.ok) {
        expect(nativeOnly.value.profile).toBeUndefined()
        expect(nativeOnly.value.nativeExecution).toBe(
          setup.value.nativeExecution,
        )
      }
      expect(driver.calls).toHaveLength(1)
    })

    test('original root expiry during unknown setup cleanup remains a deadline refusal', async () => {
      const f = fixture(),
        clock: Clock = {
          domainId: randomUUID(),
          nowMs: () => performance.now(),
        }
      const boundary = captureRootDeadline({
        clock,
        limit: { kind: 'finite', durationMs: 80 },
      })
      if (!boundary.ok) throw new Error(boundary.cause)
      const driver = versionSpawn(clock, true)
      const result = await configureHostExecution({
        ...f,
        clock,
        boundary: boundary.value,
        spawnSource: driver.spawn,
      })
      expect(result).toMatchObject({ ok: false, reason: 'deadline-exhausted' })
      expect('cleanup' in result ? result.cleanup[0]?.status : undefined).toBe(
        'unknown',
      )
      const hostId =
        'cleanup' in result
          ? result.cleanup[0]?.launchFacts?.hostContextId
          : undefined
      expect(hostId).toBeDefined()
      disposals.push(() => driver.recover(hostId!))
    })

    test('independent setup cap is unavailable under an unbounded original root', async () => {
      const f = fixture(),
        clock: Clock = {
          domainId: randomUUID(),
          nowMs: () => performance.now(),
        }
      const boundary = captureRootDeadline({
        clock,
        limit: { kind: 'unbounded' },
      })
      if (!boundary.ok) throw new Error(boundary.cause)
      const startedAt = performance.now()
      const result = await configureHostExecution({
        ...f,
        clock,
        boundary: boundary.value,
        spawnSource: new Promise<CodebuffSpawn>(() => {}),
      })
      expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
      expect(performance.now() - startedAt).toBeLessThan(3000)
    })

    test('unknown setup cleanup blocks usable mapping and survives SDK early refusal without a logger', async () => {
      const f = fixture(),
        driver = versionSpawn(f.clock, true)
      const state = await run({
        cwd: f.root,
        hostConfiguration: f.inputs,
        spawnSource: driver.spawn,
        apiKey: 'fixture-only-key',
        fingerprintId: 'fixture-only-fingerprint',
        runTimeoutMs: 5000,
        prompt: 'No target may run',
        agent: 'fixture-unused',
      })
      expect(state.output?.type).toBe('error')
      expect(state.runOutcome?.termination).toBe('failed')
      expect(driver.calls).toHaveLength(1)
      const cleanup = state.executionCleanup
      expect(cleanup).toHaveLength(1)
      expect(cleanup?.[0].status).toBe('unknown')
      expect(cleanup?.[0].cleanupAuthorityRetained).toBe(true)
      const hostId = cleanup?.[0].launchFacts?.hostContextId
      expect(hostId).toBeDefined()
      disposals.push(() => driver.recover(hostId!))
    })
  },
)
