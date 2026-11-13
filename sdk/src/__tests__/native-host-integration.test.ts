import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'

import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { OpenbuffClient } from '../client'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { runTerminalCommand } from '../tools/run-terminal-command'
import {
  createDirectHostExecution,
  createHostExecutionServices,
} from '../host-execution'
import {
  admitNodeLaunch,
  captureNodeTarget,
  deriveExecutionContext,
  dispatchNodeLaunch,
  prepareNodeLaunch,
} from '../services/execution-launch'
import {
  calibrateNativeClock,
  joinNativeScopeCleanup,
  nativeFilterSha256,
  NativeFrameDecoder,
  retainedNativeScopes,
  verifyNativeInstallation,
} from '../services/native-exec'
import {
  createControlledExecutionClock,
  executionValue,
} from './fixtures/b19-terminal-execution'
import { createNativeRunCleanupFixture } from './fixtures/b21-native-run-cleanup'
import { createNodeFileSystem } from '../tools/node-filesystem'
import {
  getBackgroundJobAdapter,
  killBackgroundJob,
} from '../tools/background-jobs'

import type { ChildProcess } from 'node:child_process'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { JournalEvent } from '@codebuff/common/types/contracts/agent-runtime'
import type {
  AsyncDecision,
  ExecutionAdapterContext,
  PolicyInput,
  ProfileRequest,
} from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { HostExecutionOptions } from '../host-execution'
import type { NodeTargetInput } from '../services/execution-launch'
import type { NativeHostExecution } from '../services/native-host-execution'

const disposals: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose()
})
const nativeProfile = (
  overrides: Partial<ProfileRequest> = {},
): ProfileRequest => ({
  policy: 'workspace-write',
  preferredBackend: 'native-exec',
  required: ['exact-env'],
  allowBackendFallback: false,
  ...overrides,
})

/** Real descriptor verification plus synthetic calibration; no native binary is executed. */
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b21-native-host-'))
  disposals.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'checked.elf')
  fs.copyFileSync('/usr/bin/bash', file)
  fs.chmodSync(file, 0o700)
  const sha256 = createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')
  const installation = executionValue(
    verifyNativeInstallation({
      artifact: {
        path: file,
        sha256,
        platform: 'linux-x64-gnu',
        crateVersion: '0.1.0',
        workspaceProtocol: '1',
      },
      bwrap: { path: '/usr/bin/bash', sha256 },
    }),
  )
  disposals.push(() => installation.close())
  const controlled = createControlledExecutionClock()
  const mapping = executionValue(
    await calibrateNativeClock(installation, controlled.clock, (heldFd) => {
      expect(fs.fstatSync(heldFd).isFile()).toBe(true)
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
    }),
  )
  const inputs = {
    environment: { PATH: '/usr/bin' },
    platform: 'linux' as const,
    invocationCwd: root,
    projectRoot: root,
    home: { kind: 'none' as const },
    globals: { kind: 'disabled' as const },
    selection: { kind: 'none' as const },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  }
  const captured = loadHostConfigSnapshot({ inputs, fs: nodeConfigReadFs })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const snapshot = captured.snapshot
  const runtimePaths = ['/usr/bin/bash']
  const native: NativeHostExecution = {
    installation,
    mapping,
    clock: controlled.clock,
    runtimePaths,
    network: 'deny',
    landlock: 'required',
  }
  function host(overrides: Partial<HostExecutionOptions> = {}) {
    const controller = new AbortController()
    disposals.push(() => controller.abort())
    const clock = overrides.clock ?? controlled.clock
    const boundary = executionValue(
      captureRootDeadline({ clock, limit: { kind: 'unbounded' } }),
    )
    const result = createHostExecutionServices({
      snapshot,
      boundary,
      clock,
      childInheritanceEnvironment: inputs.environment,
      profile: nativeProfile(),
      nativeExecution: native,
      signal: controller.signal,
      authorizeAsync: async () => ({
        ok: true,
        basis: 'explicit-policy',
        decisionId: randomUUID(),
      }),
      authorizeSync: () => ({
        ok: true,
        basis: 'explicit-sync-policy',
        decisionId: randomUUID(),
      }),
      ...overrides,
    })
    return { result, controller }
  }
  return { root, file, native, runtimePaths, inputs, host, ...controlled }
}

function target(
  context: ExecutionAdapterContext,
  overrides: Partial<NodeTargetInput> = {},
): NodeTargetInput {
  return {
    executionContext: context,
    executable: '/usr/bin/bash',
    argv: ['--version'],
    cwd: context.projectRoot,
    branchId: `native-test:${randomUUID()}`,
    adapterOptions: { shell: false },
    ...overrides,
  }
}

/** Pending monitor fixture deliberately emits no spawn or native control report. */
function pendingMonitor() {
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    stdin = new PassThrough()
  const reports = new PassThrough(),
    decoder = new NativeFrameDecoder()
  const sent: Record<string, unknown>[] = [],
    kills: string[] = []
  let closed = false
  const control = new Writable({
    write(bytes, _encoding, done) {
      sent.push(...decoder.push(Buffer.from(bytes)))
      done()
      if (sent.some((frame) => frame.type === 'stop')) queueMicrotask(finish)
    },
  })
  const state = Object.assign(new EventEmitter(), {
    pid: 42_424_321,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, control, reports],
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill(signal = 'SIGTERM') {
      kills.push(signal)
      finish()
      return true
    },
  })
  // Consume readable sides so end/drain events occur without fabricated native evidence.
  stdout.resume()
  stderr.resume()
  reports.resume()
  function finish() {
    if (closed) return
    closed = true
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
  }
  disposals.push(finish)
  const calls: Array<{ executable: string; argv: readonly string[] }> = []
  const spawn: CodebuffSpawn = (executable, argv = []) => {
    calls.push({ executable, argv })
    return state as unknown as ChildProcess
  }
  return { spawn, sent, kills, calls, finish }
}

describe('SDK native host selection and capture', () => {
  test('missing native host refuses the requested backend before policy', async () => {
    const f = await fixture()
    let approvals = 0
    const { result } = f.host({
      nativeExecution: undefined,
      authorizeAsync: async () => {
        approvals++
        return { ok: true, basis: 'explicit-policy', decisionId: 'never' }
      },
    })
    // Construction retains the requested profile; target preparation reports
    // the unavailable backend without asking policy or dispatching a child.
    const host = executionValue(result)
    const context = executionValue(host.directOperation()).executionContext
    expect(prepareNodeLaunch(target(context))).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
    expect(approvals).toBe(0)
    expect(host.events.some((event) => event.phase === 'dispatched')).toBe(false)
  })

  test('explicit fallback selects portable when native is absent', async () => {
    const f = await fixture()
    const host = executionValue(
      f.host({
        nativeExecution: undefined,
        profile: nativeProfile({ allowBackendFallback: true }),
      }).result,
    )
    const context = executionValue(host.directOperation()).executionContext
    const launch = executionValue(prepareNodeLaunch(target(context)))
    expect(launch.facts().profile.selected?.backend).toBe('portable-ts')
    expect((await admitNodeLaunch(launch)).ok).toBe(true)
  })

  for (const invalid of [
    'copied-mapping',
    'copied-installation',
    'foreign-clock',
  ] as const)
    test(`${invalid} cannot acquire native selection`, async () => {
      const f = await fixture()
      const native = {
        ...f.native,
        ...(invalid === 'copied-mapping'
          ? { mapping: { ...f.native.mapping } }
          : {}),
        ...(invalid === 'copied-installation'
          ? { installation: { ...f.native.installation } }
          : {}),
        ...(invalid === 'foreign-clock' ? { clock: { ...f.clock } } : {}),
      }
      const host = executionValue(f.host({ nativeExecution: native }).result)
      const context = executionValue(host.directOperation()).executionContext
      expect(prepareNodeLaunch(target(context))).toMatchObject({
        ok: false,
        reason: 'unavailable',
      })
      expect(host.events.some((event) => event.phase === 'admitted')).toBe(
        false,
      )
    })

  test('invalid calibration fallback cannot weaken required filesystem isolation', async () => {
    const f = await fixture()
    const host = executionValue(
      f.host({
        nativeExecution: { ...f.native, mapping: { ...f.native.mapping } },
        profile: nativeProfile({
          required: ['exact-env', 'filesystem-isolation'],
          allowBackendFallback: true,
        }),
      }).result,
    )
    const launch = executionValue(
      prepareNodeLaunch(
        target(executionValue(host.directOperation()).executionContext),
      ),
    )
    expect(launch.facts().profile.selected).toBeNull()
    expect(await admitNodeLaunch(launch)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
  })

  test('pins, argv, runtime roster and child PATH are captured before queued approval', async () => {
    const f = await fixture()
    let policy: PolicyInput | undefined
    let release!: (value: AsyncDecision) => void
    const approval = new Promise<AsyncDecision>((resolve) => {
      release = resolve
    })
    const host = executionValue(
      f.host({
        authorizeAsync: async (input) => {
          policy = input
          return approval
        },
      }).result,
    )
    const context = executionValue(host.directOperation()).executionContext
    const argv = ['--version'],
      overlay = { PATH: '/usr/bin' },
      adapter = { shell: false, label: 'captured' }
    const launch = executionValue(
      prepareNodeLaunch(
        target(context, {
          executable: 'bash',
          argv,
          environmentOverlay: overlay,
          adapterOptions: adapter,
        }),
      ),
    )
    const admission = admitNodeLaunch(launch)
    expect(policy).toBeDefined()
    argv[0] = 'changed'
    overlay.PATH = '/missing'
    adapter.label = 'changed'
    f.runtimePaths.push('/missing')
    expect(policy!.target.executable).toBe(fs.realpathSync('/usr/bin/bash'))
    expect(policy!.target.argv).toEqual(['--version'])
    expect(policy!.target.environmentOverlay?.PATH).toBe('/usr/bin')
    // Bun asymmetric matchers mutate their actual input; inspect a separate copy.
    expect({ ...policy!.target.adapterOptions }).toMatchObject({
      label: 'captured',
      runtime: 'node',
      nativeAdapter: 'openbuff.exec.v1',
      nativeArtifactSha256: f.native.installation.artifact.sha256,
      nativePlatform: 'linux-x64-gnu',
      nativeBuildVersion: '0.1.0',
      nativeWorkspaceProtocol: '1',
      nativeBwrapSha256: f.native.installation.bwrap.sha256,
      nativeFilterSha256: nativeFilterSha256('deny'),
      nativeNetwork: 'deny',
      nativeLandlock: 'required',
      nativeMountDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(Object.isFrozen(policy!.target.adapterOptions)).toBe(true)
    expect(
      Reflect.set(policy!.target.adapterOptions, 'nativeNetwork', 'inherit'),
    ).toBe(false)
    expect(Reflect.set(policy!.target.argv, '0', 'policy-mutated')).toBe(false)
    expect(
      Reflect.set(
        policy!.target.environmentOverlay!,
        'PATH',
        '/policy-mutated',
      ),
    ).toBe(false)
    expect(
      Reflect.set(policy!.target.profile.required, '0', 'memory-limit'),
    ).toBe(false)
    expect(policy!.facts.profile.selected?.backend).toBe('native-exec')
    expect(policy!.facts.profile.active).toBeNull()
    expect(policy!.facts.profile.enforced).toEqual([
      { capability: 'exact-env', status: 'unknown' },
    ])
    const digest = policy!.bindingDigest
    release({ ok: true, basis: 'explicit-policy', decisionId: 'queued' })
    expect((await admission).ok).toBe(true)
    expect(launch.facts().executionBindingDigest).toBe(digest)
  })

  test('captured child environment resolves PATH without ambient lookup', async () => {
    const f = await fixture()
    const host = executionValue(
      f.host({ inheritEnv: false, env: { PATH: '/missing' } }).result,
    )
    const context = executionValue(host.directOperation()).executionContext
    expect(
      captureNodeTarget(target(context, { executable: 'bash' })),
    ).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(
      executionValue(
        captureNodeTarget(
          target(context, {
            executable: 'bash',
            environmentOverlay: { PATH: '/usr/bin' },
          }),
        ),
      ).executable,
    ).toBe(fs.realpathSync('/usr/bin/bash'))
  })

  test('derived genuine action context inherits native registration', async () => {
    const f = await fixture(),
      host = executionValue(f.host().result)
    const context = executionValue(
      deriveExecutionContext(
        executionValue(host.directOperation()).executionContext,
        'bounded-native',
        { kind: 'finite', durationMs: 300 },
      ),
    )
    const launch = executionValue(prepareNodeLaunch(target(context)))
    expect(launch.facts().profile.selected?.backend).toBe('native-exec')
    expect(launch.facts().deadlines.requestAdmission).toMatchObject({
      kind: 'finite',
      expiresAtMs: 400,
    })
  })

  test('copied action port cannot select or prepare a native launch', async () => {
    const f = await fixture(),
      host = executionValue(f.host().result)
    const original = executionValue(host.directOperation()).executionContext
    const copied = { ...original, execution: { ...original.execution } }
    const captured = executionValue(captureNodeTarget(target(copied)))
    expect(captured.adapterOptions.nativeAdapter).toBeUndefined()
    expect(prepareNodeLaunch(target(copied)).ok).toBe(false)
  })

  for (const family of [
    'mcp-stdio',
    'lsp',
    'configured-hook',
    'supervised-child',
    'chrome',
    'blender',
  ] as const)
    test(`${family} cannot acquire one-shot native selection`, async () => {
      const f = await fixture(),
        host = executionValue(f.host().result)
      const context = executionValue(host.directOperation()).executionContext
      expect(prepareNodeLaunch(target(context, { family }))).toMatchObject({
        ok: false,
        reason: 'unavailable',
      })
      const fallback = executionValue(
        host.directOperation({
          profile: nativeProfile({ allowBackendFallback: true }),
        }),
      ).executionContext
      const launch = executionValue(
        prepareNodeLaunch(target(fallback, { family })),
      )
      expect(launch.facts().profile.selected?.backend).toBe('portable-ts')
      expect(
        launch
          .facts()
          .profile.available.find((value) => value.backend === 'native-exec')
          ?.capabilities,
      ).toEqual([])
      const isolated = executionValue(
        host.directOperation({
          profile: nativeProfile({
            allowBackendFallback: true,
            required: ['filesystem-isolation'],
          }),
        }),
      ).executionContext
      const refused = executionValue(
        prepareNodeLaunch(target(isolated, { family })),
      )
      expect(await admitNodeLaunch(refused)).toMatchObject({
        ok: false,
        reason: 'unavailable',
      })
    })

  test('full access captures inherited network and disabled Landlock with honest capabilities', async () => {
    const f = await fixture()
    let policy: PolicyInput | undefined
    const host = executionValue(
      f.host({
        profile: nativeProfile({
          policy: 'full-access',
          optional: [
            'filesystem-isolation',
            'network-isolation',
            'process-tree-containment',
            'memory-limit',
          ],
        }),
        authorizeAsync: async (input) => {
          policy = input
          return { ok: true, basis: 'explicit-policy', decisionId: 'full' }
        },
      }).result,
    )
    const launch = executionValue(
      prepareNodeLaunch(
        target(executionValue(host.directOperation()).executionContext),
      ),
    )
    executionValue(await admitNodeLaunch(launch))
    expect(policy!.target.adapterOptions).toMatchObject({
      nativeNetwork: 'inherit',
      nativeLandlock: 'disabled',
      nativeFilterSha256: nativeFilterSha256('inherit'),
    })
    const profile = launch.facts().profile
    expect(profile.selected).toMatchObject({
      backend: 'native-exec',
      cancellation: 'cooperative',
      policy: 'full-access',
    })
    expect(
      profile.available.find((value) => value.backend === 'native-exec')
        ?.capabilities,
    ).toEqual(['exact-env', 'cooperative-cancellation'])
    expect(
      profile.enforced
        .filter((value) => value.capability !== 'exact-env')
        .every((value) => value.status === 'not-enforced'),
    ).toBe(true)
    const context = executionValue(
      host.directOperation({
        profile: nativeProfile({
          policy: 'full-access',
          required: ['network-isolation'],
          allowBackendFallback: true,
        }),
      }),
    ).executionContext
    expect(
      await admitNodeLaunch(executionValue(prepareNodeLaunch(target(context)))),
    ).toMatchObject({ ok: false, reason: 'unavailable' })
    const deadlineContext = executionValue(
      host.directOperation({
        profile: nativeProfile({
          policy: 'full-access',
          required: ['deadline-termination'],
          allowBackendFallback: true,
        }),
      }),
    ).executionContext
    expect(
      await admitNodeLaunch(
        executionValue(prepareNodeLaunch(target(deadlineContext))),
      ),
    ).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  test('direct host entrypoint preserves native calibration clock and explicit installation', async () => {
    const f = await fixture()
    const controller = new AbortController()
    disposals.push(() => controller.abort())
    const direct = executionValue(
      createDirectHostExecution({
        cwd: f.root,
        hostConfiguration: f.inputs,
        nativeExecution: f.native,
        profile: nativeProfile(),
        signal: controller.signal,
        limit: { kind: 'finite', durationMs: 500 },
        approvalMode: 'allow-all',
      }),
    )
    const launch = executionValue(
      prepareNodeLaunch(target(direct.executionContext)),
    )
    expect(launch.facts().profile.selected?.backend).toBe('native-exec')
    expect(launch.facts().deadlines.action).toMatchObject({
      domainId: f.clock.domainId,
      expiresAtMs: 600,
    })
    expect((await admitNodeLaunch(launch)).ok).toBe(true)
  })
})

describe('SDK native dispatch and resource cleanup ownership', () => {
  test('actual SDK run returns unknown native cleanup without a logger and excludes its live transferred job', async () => {
    const f = await fixture()
    const runtime = await createNativeRunCleanupFixture(f.clock)
    const config = path.join(f.root, 'run-config.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        autoFileChangeHooks: false,
        providers: {
          fixture: {
            type: 'openai-compatible',
            baseURL: 'https://fixture.invalid/v1',
            models: ['fixture-model'],
          },
        },
      }),
    )
    const agent: AgentDefinition = {
      id: 'b21-native-run-cleanup',
      displayName: 'Native run cleanup DI control',
      model: 'fixture-model',
      terminalPermissionProfile: 'full-access',
      toolNames: ['run_terminal_command', 'set_output'],
      outputMode: 'structured_output',
      handleSteps: function* () {
        const failed = yield {
          toolName: 'run_terminal_command',
          input: {
            command: 'printf native-failed-fixture',
            process_type: 'SYNC',
            timeout_seconds: -1,
          },
        }
        const transferred = yield {
          toolName: 'run_terminal_command',
          input: {
            command: 'printf native-live-fixture',
            process_type: 'BACKGROUND',
            detach: true,
            timeout_seconds: -1,
          },
        }
        yield {
          toolName: 'set_output',
          input: {
            failed: failed.toolResult,
            transferred: transferred.toolResult,
            fixtureCompleted: true,
          },
        }
      },
    }
    let networkAttempts = 0
    const forbidNetwork = () => {
      networkAttempts++
      throw new Error('Network forbidden in native SDK run DI fixture')
    }
    const network = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(async () => forbidNetwork(), { preconnect: forbidNetwork }),
    )
    const journal: JournalEvent[] = []
    let jobId: string | undefined
    let projectionReceipt: Record<string, unknown> | undefined
    try {
      const client = new OpenbuffClient({
        cwd: f.root,
        projectFiles: {},
        knowledgeFiles: {},
        hostConfiguration: {
          ...f.inputs,
          environment: {
            ...f.inputs.environment,
            OPENBUFF_PROCESS_SUPERVISION: '0',
            OPENBUFF_TELEMETRY: '0',
            DO_NOT_TRACK: '1',
          },
          selection: { kind: 'explicit', path: config, required: true },
        },
        configReadFs: nodeConfigReadFs,
        fsSource: createNodeFileSystem(),
        spawnSource: runtime.spawn,
        nativeExecution: runtime.native,
        executionProfile: nativeProfile({ policy: 'full-access' }),
        approvalMode: 'allow-all',
        harnessStateDir: path.join(f.root, 'harness'),
        handleEvent: () => {},
        journalWriter: {
          append: (_runId, event) => journal.push(structuredClone(event)),
        },
      })
      expect(client.options.logger).toBeUndefined()
      const result = await client.run({
        agent,
        prompt: 'Exercise retained native cleanup and session transfer',
      })
      projectionReceipt = {
        fixtureKind: 'actual-SDK-run-with-synthetic-native-reports',
        output: result.output,
        runOutcome: result.runOutcome,
        taskAcceptance: result.taskAcceptance,
        actionOutcomes: result.actionOutcomes,
        executionCleanup: result.executionCleanup,
        terminalJournal: journal.filter(
          (event) => (event.payload as { terminal?: boolean }).terminal,
        ),
        nativeOSAcceptance: false,
      }
      expect(result.output.type).toBe('structuredOutput')
      if (result.output.type !== 'structuredOutput' || !result.output.value)
        throw new Error('Programmatic fixture did not complete')
      const values = result.output.value
      const failed = values.failed as Array<{
        type: string
        value: Record<string, unknown>
      }>
      const transferred = values.transferred as Array<{
        type: string
        value: Record<string, unknown>
      }>
      expect(values.fixtureCompleted).toBe(true)
      expect(failed[0].value).toMatchObject({
        executionRefusal: { reason: 'unavailable' },
      })
      expect(
        (failed[0].value.executionRefusal as { cause: string }).cause,
      ).toContain('DI-only synthetic native cleanup remains unconfirmed')
      expect(transferred[0].value).toMatchObject({
        backgroundProcessStatus: 'running',
        detached: true,
      })
      jobId = String(transferred[0].value.jobId)
      const job = getBackgroundJobAdapter(jobId)
      expect(job?.nodeLaunch).toBeDefined()
      const live = job!.nodeLaunch!
      expect(live.input.resourceSignal.aborted).toBe(false)
      expect(live.scope.currentCleanup()).toBeUndefined()
      expect(live.facts().profile.active?.backend).toBe('native-exec')
      const failedCall = runtime.calls.find(
        (call) =>
          !call.entered &&
          call.targetArgv?.includes('printf native-failed-fixture'),
      )
      expect(failedCall).toBeDefined()
      expect(
        result.executionCleanup?.some(
          (cleanup) =>
            cleanup.launchFacts?.launchId === failedCall!.launchId &&
            cleanup.status === 'unknown' &&
            cleanup.cleanupAuthorityRetained,
        ),
      ).toBe(true)
      expect(
        result.executionCleanup?.every(
          (cleanup) => cleanup.scopeId !== live.scope.scopeId,
        ),
      ).toBe(true)
      expect(Object.isFrozen(result.executionCleanup)).toBe(true)
      expect(result.runOutcome).toEqual({ termination: 'completed' })
      expect(
        journal.some(
          (event) => (event.payload as { terminal?: boolean }).terminal,
        ),
      ).toBe(true)
      expect(
        (
          journal.find(
            (event) => (event.payload as { terminal?: boolean }).terminal,
          )!.payload as { runOutcome?: unknown }
        ).runOutcome,
      ).toEqual(result.runOutcome)
      expect(
        result.actionOutcomes?.some(
          (outcome) =>
            outcome.toolName === 'run_terminal_command' &&
            outcome.outcome !== 'succeeded',
        ),
      ).toBe(true)
      expect(runtime.calls.filter((call) => call.entered)).toHaveLength(1)
      const liveCall = runtime.calls.find((call) => call.entered)!
      expect(liveCall.reports.map((frame) => frame.type)).toEqual([
        'initialized',
        'prepared',
        'target-created',
        'target-entered',
      ])
      const prepared = liveCall.reports[1]
      const created = liveCall.reports[2]
      const entered = liveCall.reports[3]
      expect(prepared).toMatchObject({
        waiterPid: runtime.identityChild.pid,
        waiterStartTime: '42',
        pidNamespace: null,
        namespaceDepth: null,
      })
      expect(created).toMatchObject({
        waiterPid: prepared.waiterPid,
        waiterStartTime: prepared.waiterStartTime,
        targetPid: Number(prepared.waiterPid) + 1,
        targetLocalPid: Number(prepared.waiterPid) + 1,
        targetStartTime: '43',
        pidNamespace: null,
        namespaceDepth: null,
      })
      expect(created.targetPid).not.toBe(created.waiterPid)
      expect(entered).toMatchObject({
        ...created,
        type: 'target-entered',
        pid: created.targetPid,
        observation: 'exec-image',
      })
      expect(
        failedCall!.reports.some((frame) => frame.type === 'target-created'),
      ).toBe(false)
      expect(
        failedCall!.reports.find((frame) => frame.type === 'final'),
      ).toMatchObject({
        waiterPid: runtime.identityChild.pid,
        waiterStartTime: '42',
        targetPid: null,
        targetLocalPid: null,
        targetStartTime: null,
        pidNamespace: null,
        namespaceDepth: null,
        targetUsage: null,
        waitStatusSource: 'not-observed',
        cleanup: { complete: false },
      })
      expect(
        runtime.calls
          .find((call) => call.entered)
          ?.commands.some((frame) => frame.type === 'stop'),
      ).toBe(false)
      expect(runtime.identityChild.exitCode).toBeNull()
      expect(networkAttempts).toBe(0)
      expect(network.mock.calls).toHaveLength(0)
    } finally {
      if (jobId) killBackgroundJob(jobId)
      const identityCleanup = await runtime.dispose()
      network.mockRestore()
      expect(identityCleanup.observedClose).toBe(true)
      expect(identityCleanup.closedBeforeFixtureDisposal).toBe(false)
      expect(identityCleanup.nativeTargetExecuted).toBe(false)
      const liveFinal = runtime.calls
        .find((call) => call.entered)
        ?.reports.find((frame) => frame.type === 'final')
      // The fixture reports a valid private tuple without inventing death proof.
      if (liveFinal) {
        expect(liveFinal).toMatchObject({
          waiterPid: runtime.identityChild.pid,
          waiterStartTime: '42',
          targetPid: runtime.identityChild.pid! + 1,
          targetLocalPid: runtime.identityChild.pid! + 1,
          targetStartTime: '43',
          pidNamespace: null,
          namespaceDepth: null,
          targetUsage: null,
          waitStatusSource: 'not-observed',
          cleanup: { complete: false },
        })
      }
      const capture = process.env.B21_NATIVE_HOST_RUN_EVIDENCE_DIR
      if (capture) {
        const directory = path.resolve(capture)
        const owned = path.resolve(
          import.meta.dir,
          '../../../docs/execution/body-roadmap/evidence/B21/native-host-waiter-fixtures-20261112-r1',
        )
        if (!directory.startsWith(`${owned}${path.sep}`))
          throw new Error(
            'Native run capture directory is outside owned packet',
          )
        fs.writeFileSync(
          path.join(directory, 'native-run-identity-fixture.json'),
          JSON.stringify(identityCleanup, null, 2) + '\n',
          { flag: 'wx' },
        )
        if (projectionReceipt)
          fs.writeFileSync(
            path.join(directory, 'native-run-projection.json'),
            JSON.stringify(
              {
                ...projectionReceipt,
                syntheticNativeCalls: runtime.calls.map((call) => ({
                  launchId: call.launchId,
                  scopeId: call.scopeId,
                  entered: call.entered,
                  closed: call.closed,
                  commands: call.commands,
                  reports: call.reports,
                  fakeKillSignals: call.fakeKillSignals,
                })),
              },
              null,
              2,
            ) + '\n',
            { flag: 'wx' },
          )
      }
    }
  }, 15_000)

  test('terminal consumer dispatches its registered native launch after approval', async () => {
    const f = await fixture()
    const policies: PolicyInput[] = []
    const calls: string[] = []
    const host = executionValue(
      f.host({
        profile: nativeProfile({
          policy: 'full-access',
          allowBackendFallback: true,
        }),
        authorizeAsync: async (input) => {
          policies.push(input)
          return {
            ok: true,
            basis: 'explicit-policy',
            decisionId: randomUUID(),
          }
        },
        spawn: (command) => {
          calls.push(command)
          throw new Error('injected-terminal-native-failure')
        },
      }).result,
    )
    const output = await runTerminalCommand({
      command: 'printf native-fixture',
      process_type: 'SYNC',
      cwd: f.root,
      projectRoot: f.root,
      timeout_seconds: -1,
      executionContext: executionValue(host.directOperation()).executionContext,
      terminalShell: { executable: '/usr/bin/bash', args: ['-c'] },
      getTerminalLaunchMetadata: host.getTerminalLaunchMetadata,
    })
    const terminal = policies.find(
      (input) => input.target.shellCommandBytes === 'printf native-fixture',
    )
    expect(terminal).toBeDefined()
    expect(terminal!.facts.profile.selected?.backend).toBe('native-exec')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((command) => command === '/proc/self/fd/5')).toBe(true)
    expect(output[0].value).toMatchObject({
      executionRefusal: { ok: false, reason: 'unavailable' },
    })
    expect(
      host.events.some(
        (event) =>
          event.phase === 'dispatch-failed' &&
          event.facts.launchId === terminal!.facts.launchId,
      ),
    ).toBe(true)
  })

  test('selected native dispatch never invokes the portable callback after native setup throws', async () => {
    const f = await fixture()
    let nativeCalls = 0,
      portableCalls = 0
    const host = executionValue(
      f.host({
        profile: nativeProfile({ allowBackendFallback: true }),
        spawn: (command, argv) => {
          nativeCalls++
          expect(command).toBe('/proc/self/fd/5')
          expect(argv?.slice(0, 2)).toEqual(['exec', '--expiry-ns'])
          throw new Error('injected-native-setup-failure')
        },
      }).result,
    )
    const launch = executionValue(
      prepareNodeLaunch(
        target(executionValue(host.directOperation()).executionContext),
      ),
    )
    const admitted = executionValue(await admitNodeLaunch(launch))
    const result = dispatchNodeLaunch(admitted, () => {
      portableCalls++
      throw new Error('portable must not run')
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'unavailable',
      dispatchFailed: true,
      cause: expect.stringContaining('injected-native-setup-failure'),
    })
    expect(nativeCalls).toBe(1)
    expect(portableCalls).toBe(0)
    expect(launch.facts().profile.active).toBeNull()
    expect(
      dispatchNodeLaunch(admitted, () => {
        portableCalls++
        throw new Error('never')
      }).ok,
    ).toBe(false)
    expect(nativeCalls).toBe(1)
    expect(portableCalls).toBe(0)
  })

  for (const kind of ['unregistered-prepared', 'copied-prepared'] as const)
    test(`${kind} refuses selected native without portable dispatch`, async () => {
      const f = await fixture()
      let nativeCalls = 0,
        portableCalls = 0
      const host = executionValue(
        f.host({
          spawn: () => {
            nativeCalls++
            throw new Error('never')
          },
        }).result,
      )
      const context = executionValue(host.directOperation()).executionContext
      const launch =
        kind === 'unregistered-prepared'
          ? executionValue(
              context.execution.prepareTarget({
                target: executionValue(captureNodeTarget(target(context))),
              }),
            )
          : executionValue(prepareNodeLaunch(target(context)))
      const admitted = executionValue(await admitNodeLaunch(launch))
      const value =
        kind === 'copied-prepared'
          ? { ...admitted, launch: { ...launch } }
          : admitted
      const result = dispatchNodeLaunch(value, () => {
        portableCalls++
        throw new Error('never')
      })
      expect(result).toMatchObject(
        kind === 'copied-prepared'
          ? {
              ok: false,
              reason: 'invalid-context',
              cause: 'Execution dispatch facade failed',
            }
          : {
              ok: false,
              reason: 'unavailable',
              cause: 'Selected native launch has no host-registered adapter',
            },
      )
      expect(nativeCalls).toBe(0)
      expect(portableCalls).toBe(0)
    })

  for (const drift of ['closed-installation', 'changed-descriptor'] as const)
    test(`${drift} after approval refuses native without fallback`, async () => {
      const f = await fixture()
      let calls = 0
      const host = executionValue(
        f.host({
          profile: nativeProfile({ allowBackendFallback: true }),
          spawn: () => {
            calls++
            throw new Error('never')
          },
        }).result,
      )
      const launch = executionValue(
        prepareNodeLaunch(
          target(executionValue(host.directOperation()).executionContext),
        ),
      )
      const admitted = executionValue(await admitNodeLaunch(launch))
      if (drift === 'closed-installation') f.native.installation.close()
      else fs.appendFileSync(f.file, Buffer.from([0x5a]))
      expect(
        dispatchNodeLaunch(admitted, () => {
          calls++
          throw new Error('never')
        }).ok,
      ).toBe(false)
      expect(calls).toBe(0)
    })

  for (const transferred of [false, true])
    test(`${transferred ? 'session-transferred' : 'root-owned'} pending native resource respects cleanup ownership`, async () => {
      const f = await fixture(),
        monitor = pendingMonitor()
      const { result, controller } = f.host({ spawn: monitor.spawn })
      const host = executionValue(result),
        context = executionValue(
          host.directOperation({ limit: { kind: 'finite', durationMs: 500 } }),
        ).executionContext
      const input = target(context, {
        family: 'background-job',
        processType: 'BACKGROUND',
      })
      const launch = transferred
        ? executionValue(
            executionValue(
              host.createBackgroundReceiver('synthetic-session'),
            ).prepareLaunch(context, executionValue(captureNodeTarget(input))),
          )
        : executionValue(prepareNodeLaunch(input))
      let portableCalls = 0
      const handle = executionValue(
        dispatchNodeLaunch(
          executionValue(await admitNodeLaunch(launch)),
          () => {
            portableCalls++
            throw new Error('never')
          },
        ),
      )
      const hostId = handle.facts().hostContextId
      expect(monitor.calls).toHaveLength(1)
      expect(monitor.calls[0].argv).toEqual([
        'exec',
        '--expiry-ns',
        '600000000',
      ])
      expect(portableCalls).toBe(0)
      expect(handle.facts().profile.active).toBeNull()
      expect(retainedNativeScopes(hostId)).toContain(handle.scope)
      controller.abort()
      expect(handle.input.resourceSignal.aborted).toBe(!transferred)
      expect(handle.input.deadlines.resourceLifetime).toMatchObject({
        kind: 'finite',
        domainId: f.clock.domainId,
        expiresAtMs: 600,
      })
      const joined = await joinNativeScopeCleanup(hostId)
      if (transferred) {
        expect(joined).toEqual([])
        expect(monitor.sent).toEqual([])
        expect(monitor.kills).toEqual([])
        monitor.finish()
        expect((await handle.started).ok).toBe(false)
        const cleanup = await handle.scope.requestStop('owner-shutdown')
        expect(cleanup.status).toBe('unknown')
        expect(cleanup.cleanupAuthorityRetained).toBe(true)
      } else {
        expect(joined).toHaveLength(1)
        expect(joined[0]).toMatchObject({
          status: 'unknown',
          cleanupAuthorityRetained: true,
        })
        expect(monitor.sent).toMatchObject([
          { type: 'stop', reason: 'owner-cancel' },
        ])
      }
      expect((await handle.nativeResult!).ok).toBe(false)
      expect((await handle.started).ok).toBe(false)
      expect(retainedNativeScopes(hostId)).toContain(handle.scope)
      expect(handle.facts().profile.active).toBeNull()
      f.advance(500)
    })
})
