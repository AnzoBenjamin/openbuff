import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import * as commonExecution from '@codebuff/common/util/execution-context'
import { spyOn } from 'bun:test'
import { z } from 'zod/v4'

import { BASE_CONTROLS, BLENDER_BRANCHES } from './external-branch-controls'
import { OpenbuffClient } from '../../client'
import { getCustomToolDefinition } from '../../custom-tool'
import { nodeConfigReadFs } from '../../host-config'
import * as hostModule from '../../host-execution'
import * as assets from '../../tools/3d-assets'
import { hashFileContent } from '../../tools/filesystem-authority'
import { createNodeFileSystem } from '../../tools/node-filesystem'

import type { Control } from './external-branch-controls'
import type {
  AgentDefinition,
  ToolCall,
} from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type {
  AbsoluteDeadline,
  Clock,
  Correlation,
  HostAuthority,
  LaunchEvent,
  PolicyInput,
  RootDeadlineSeed,
  Scheduler,
} from '@codebuff/common/types/contracts/execution-context'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ChildProcess } from 'node:child_process'

export { BLENDER_BRANCHES }
export const SDK_BLENDER_CONTROLS: readonly Control[] = [
  ...BASE_CONTROLS,
  'exhausted-before-later-branch',
]
export const SDK_BLENDER_PROFILE = {
  policy: 'full-access',
  preferredBackend: 'portable-ts',
  required: ['exact-env'],
  allowBackendFallback: false,
} as const
export type SdkBlenderBranch = (typeof BLENDER_BRANCHES)[number]

// One original monotonic domain advances; captured deadlines remain untouched.
function exhaustionClock(base: Clock) {
  let offset = 0,
    nextId = 0
  const tasks = new Map<number, { expiresAt: number; callback(): void }>()
  const clock: Clock = {
    domainId: base.domainId,
    nowMs: () => base.nowMs() + offset,
  }
  const scheduler: Scheduler = {
    set(delay, callback) {
      const id = ++nextId
      tasks.set(id, { expiresAt: clock.nowMs() + delay, callback })
      return id
    },
    clear(id) {
      tasks.delete(id as number)
    },
  }
  return {
    clock,
    scheduler,
    exhaust(deadline: AbsoluteDeadline) {
      if (deadline.kind !== 'finite')
        throw new Error(
          'Blender controls require the original finite root deadline',
        )
      offset += Math.max(0, deadline.expiresAtMs - clock.nowMs()) + 1
      for (;;) {
        const due = [...tasks].find(
          ([, task]) => task.expiresAt <= clock.nowMs(),
        )
        if (!due) break
        tasks.delete(due[0])
        due[1].callback()
      }
    },
  }
}

type AssetParams = Parameters<typeof assets.inspect3dAsset>[0]
type Entry = {
  toolName: string
  path: string
  projectRoot?: string
  registered: boolean
  correlation?: Correlation
  initialActionDeadline?: AbsoluteDeadline
  signalAbortedAtEntry?: boolean
  executionPresent: boolean
  spawnAdapterPresent: boolean
  signalMatchesExecution: boolean
  operationId?: string
  sourceHash?: string
  result?: unknown
  error?: unknown
}
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4e0AAAAASUVORK5CYII=',
  'base64',
)

/** Real serialized public SDK strategy and callbacks; only Blender children are synthetic. */
export async function runSdkBlenderControl(
  branch: SdkBlenderBranch,
  control: Control,
) {
  const root = mkdtempSync(path.join(tmpdir(), 'b19-sdk-blender-'))
  const configFile = path.join(root, 'openbuff.json')
  writeFileSync(
    configFile,
    JSON.stringify({
      autoFileChangeHooks: false,
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'https://fixture.invalid/v1',
          models: ['fixture-model'],
          apiKeyEnv: 'CUSTOM_PROVIDER_KEY',
        },
      },
    }),
  )
  writeFileSync(path.join(root, 'scene.blend'), 'fixture')
  writeFileSync(path.join(root, 'scene.fbx'), 'fixture')
  const sourceHash = hashFileContent(Buffer.from('fixture'))
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: path.join(root, 'home'),
    PROJECT_VALUE: 'sdk-blender-captured-public',
    OPENAI_API_KEY: 'sdk-blender-canonical-sentinel',
    CUSTOM_PROVIDER_KEY: 'sdk-blender-configured-sentinel',
    OPENBUFF_PROCESS_SUPERVISION: '0',
    OPENBUFF_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
  }
  const stop = new AbortController()
  const events: LaunchEvent[] = [],
    policyInputs: PolicyInput[] = [],
    targetPolicies: PolicyInput[] = []
  const printEvents: PrintModeEvent[] = [],
    entries: Entry[] = []
  const hosts: hostModule.RunHostServices[] = [],
    authorities: HostAuthority[] = []
  const hostCaptures: Array<{
    snapshotId: string
    boundary: RootDeadlineSeed
  }> = []
  const boundaryCalls: Array<{
    family: string
    branch?: string
    launchId?: string
    executable: string
    argv: readonly string[]
    cwd?: string
    env: NodeJS.ProcessEnv
    signalPresent: boolean
    signalEqualsPublicRequest: boolean
    signalAbortedAtSpawn?: boolean
  }> = []
  const transitions: Array<{
    point: string
    earlierBlenderCalls: number
    earlierHelperCalls: number
    originalRootDeadline?: AbsoluteDeadline
    beforeMs: number
    afterMs: number
    rootAborted: boolean
  }> = []
  const syntheticChildren: ChildProcess[] = [],
    helpers: ChildProcess[] = [],
    helperExits: Promise<unknown>[] = []
  const completions: Promise<unknown>[] = [],
    clocks: ReturnType<typeof exhaustionClock>[] = []
  const restorers: Array<() => void> = []
  let checkpointEntered = false,
    networkAttempts = 0,
    selectedPolicyCompleted = false,
    transitionArmed = false
  let guardedCommitAttempts = 0,
    sourceUnchanged = false
  let entered!: () => void, release!: () => void, finishPolicy!: () => void
  const policyEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  const policyReleased = new Promise<void>((resolve) => {
    release = resolve
  })
  const policyCompleted = new Promise<void>((resolve) => {
    finishPolicy = resolve
  })

  function transition(point: string) {
    if (transitionArmed)
      throw new Error('Blender control transition was applied twice')
    transitionArmed = true
    const beforeMs =
      clocks[0]?.clock.nowMs() ?? hostModule.executionClock.nowMs()
    if (control === 'pre-aborted')
      stop.abort(new Error('Cancelled before selected Blender branch'))
    if (control === 'exhausted-before-later-branch') {
      const deadline = hostCaptures[0]?.boundary.deadline
      if (!deadline || !clocks[0])
        throw new Error('Missing original SDK positive parent budget')
      clocks[0].exhaust(deadline)
    }
    transitions.push({
      point,
      earlierBlenderCalls: boundaryCalls.filter(
        (call) => call.family === 'blender',
      ).length,
      earlierHelperCalls: boundaryCalls.filter(
        (call) => call.family !== 'blender',
      ).length,
      originalRootDeadline: hostCaptures[0]?.boundary.deadline,
      beforeMs,
      afterMs: clocks[0]?.clock.nowMs() ?? hostModule.executionClock.nowMs(),
      rootAborted: hosts[0]?.rootSignal.aborted ?? false,
    })
  }

  function blenderChild(
    actualBranch: string,
    options: Parameters<CodebuffSpawn>[2],
  ) {
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, {
      pid: 71919 + syntheticChildren.length,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdio: [],
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: () => {
        if (child.exitCode !== null) return true
        Object.assign(child, { exitCode: 0, killed: true })
        child.emit('exit', 0)
        child.emit('close', 0)
        return true
      },
    })
    syntheticChildren.push(child)
    queueMicrotask(() => {
      child.emit('spawn')
      if (options?.env?.OPENBUFF_3D_OUTPUT_DIR) {
        for (const view of String(options.env.OPENBUFF_3D_VIEWS).split(','))
          writeFileSync(
            path.join(
              options.env.OPENBUFF_3D_OUTPUT_DIR,
              `${view}-${options.env.OPENBUFF_3D_MODE}.png`,
            ),
            PNG,
          )
      }
      child.stdout?.emit(
        'data',
        Buffer.from('OPENBUFF_3D_JSON:{"changed":[],"objects":[]}\n'),
      )
      // Earlier edit is genuinely authorized/dispatched/observed before the
      // selected validation control spends or cancels its original budget.
      if (
        branch === 'blender.validate' &&
        actualBranch === 'blender.edit' &&
        (control === 'pre-aborted' ||
          control === 'exhausted-before-later-branch')
      )
        transition('after-edit-before-validation')
      child.kill()
    })
    return child
  }

  const spawn: CodebuffSpawn = (command, argv, options) => {
    const dispatched = [...events]
      .reverse()
      .find((event) => event.phase === 'dispatched')
    const facts =
      dispatched && 'facts' in dispatched ? dispatched.facts : undefined
    const input = policyInputs.find(
      (candidate) => candidate.facts.launchId === facts?.launchId,
    )
    const isBlender = command === 'blender'
    boundaryCalls.push({
      family: isBlender ? 'blender' : 'sdk-startup-helper',
      branch: facts?.branchId,
      launchId:
        input?.target.executable === command ? facts?.launchId : undefined,
      executable: command,
      argv: [...(argv ?? [])],
      cwd: options?.cwd?.toString(),
      env: { ...options?.env },
      signalPresent: !!options?.signal,
      signalEqualsPublicRequest: options?.signal === stop.signal,
      signalAbortedAtSpawn: options?.signal?.aborted,
    })
    if (isBlender) {
      if (!facts || facts.family !== 'blender' || !input)
        throw new Error('Blender boundary lacks genuine dispatch authority')
      return blenderChild(facts.branchId, options)
    }
    const child = nodeSpawn(command, [...(argv ?? [])], options ?? {})
    helpers.push(child)
    helperExits.push(new Promise((resolve) => child.once('close', resolve)))
    return child
  }
  const fs = Object.assign(createNodeFileSystem(), {
    mutationAuthority: 'cooperative_cas' as const,
    conditionalCommit: async () => {
      guardedCommitAttempts++
      return { applied: false as const, actualHash: null }
    },
  })
  const checkpoint = getCustomToolDefinition({
    toolName: 'b19_blender_checkpoint',
    description:
      'Mark serialized strategy entry and mutate caller inputs after SDK capture',
    inputSchema: z.object({}),
    execute: async () => {
      checkpointEntered = true
      environment.PROJECT_VALUE = 'caller-mutated-after-capture'
      return [
        { type: 'json', value: { checkpoint: 'captured-host-inputs-mutated' } },
      ]
    },
  })
  const program: AgentDefinition = {
    id: 'b19-blender-sdk-branch',
    displayName: 'B19 actual SDK Blender branch',
    model: 'fixture-model',
    toolNames: [
      'inspect_3d_asset',
      'render_3d_preview',
      'edit_3d_asset',
      'b19_blender_checkpoint',
      'set_output',
    ],
    outputMode: 'structured_output',
    handleSteps: function* ({ prompt }) {
      const selection = JSON.parse(prompt!)
      yield {
        toolName: 'b19_blender_checkpoint',
        input: {},
      } as unknown as ToolCall
      const call =
        selection.branch === 'blender.inspect-blend' ||
        selection.branch === 'blender.inspect-import'
          ? {
              toolName: 'inspect_3d_asset',
              input: {
                path:
                  selection.branch === 'blender.inspect-import'
                    ? 'scene.fbx'
                    : 'scene.blend',
              },
            }
          : selection.branch === 'blender.preview'
            ? {
                toolName: 'render_3d_preview',
                input: {
                  path: 'scene.blend',
                  views: ['front'],
                  mode: 'clay',
                  width: 128,
                  height: 128,
                },
              }
            : {
                toolName: 'edit_3d_asset',
                input: {
                  path: 'scene.blend',
                  source_hash: selection.sourceHash,
                  operations: [
                    { type: 'rename_object', object: 'Cube', new_name: 'Hero' },
                  ],
                },
              }
      const { toolResult } = yield call as unknown as ToolCall
      yield { toolName: 'set_output', input: { asset: toolResult } }
    },
  }
  let result: Awaited<ReturnType<OpenbuffClient['run']>> | undefined,
    error: unknown
  let pending: Promise<Awaited<ReturnType<OpenbuffClient['run']>>> | undefined
  async function capture(
    toolName: string,
    params: AssetParams & { operationId?: string; sourceHash?: string },
    operation: () => Promise<unknown>,
  ) {
    const registered =
      params.execution &&
      hosts[0]?.execution.actionRegistration(params.execution.execution)
    const entry: Entry = {
      toolName,
      path: params.path,
      projectRoot: params.execution?.projectRoot,
      executionPresent: !!params.execution,
      spawnAdapterPresent: typeof params.execution?.spawn === 'function',
      signalMatchesExecution: params.signal === params.execution?.signal,
      registered: registered?.ok === true,
      correlation: registered?.ok ? registered.value.correlation : undefined,
      initialActionDeadline: registered?.ok
        ? hosts[0]!.execution.deadline(registered.value.budget)
        : undefined,
      signalAbortedAtEntry: params.signal?.aborted,
      operationId: params.operationId,
      sourceHash: params.sourceHash,
    }
    entries.push(entry)
    if (control === 'pre-aborted' && branch !== 'blender.validate')
      transition('callback-entry-before-first-blender-consumer')
    const completion = operation()
    completions.push(completion)
    try {
      return (entry.result = await completion)
    } catch (caught) {
      entry.error = caught
      throw caught
    }
  }
  try {
    const createAuthority = commonExecution.createHostAuthority
    const authoritySpy = spyOn(
      commonExecution,
      'createHostAuthority',
    ).mockImplementation((inputs) => {
      const clock =
        control === 'exhausted-before-later-branch'
          ? exhaustionClock(inputs.clock)
          : undefined
      if (clock) clocks.push(clock)
      const authority = createAuthority({
        ...inputs,
        ...(clock ? { clock: clock.clock, scheduler: clock.scheduler } : {}),
        authorizeAsync: async (input) => {
          policyInputs.push(input)
          if (
            input.facts.family !== 'blender' ||
            input.facts.branchId !== branch
          )
            return inputs.authorizeAsync(input)
          targetPolicies.push(input)
          if (control === 'denied' || control === 'unavailable')
            return {
              ok: false,
              reason: control,
              cause: `Selected SDK Blender ${branch} ${control}`,
            }
          if (
            control === 'exhausted-before-later-branch' &&
            branch !== 'blender.validate'
          )
            transition('selected-policy-before-first-blender-dispatch')
          if (control === 'delayed-authorizer-cancellation') {
            entered()
            await policyReleased
            try {
              return await inputs.authorizeAsync(input)
            } finally {
              selectedPolicyCompleted = true
              finishPolicy()
            }
          }
          return inputs.authorizeAsync(input)
        },
        authorizeSync: (input) => {
          policyInputs.push(input)
          if (!inputs.authorizeSync)
            throw new Error('Original synchronous SDK policy is absent')
          return inputs.authorizeSync(input)
        },
      })
      authorities.push(authority)
      return authority
    })
    restorers.push(() => authoritySpy.mockRestore())
    const createHost = hostModule.createHostExecutionServices
    const hostSpy = spyOn(
      hostModule,
      'createHostExecutionServices',
    ).mockImplementation((options) => {
      hostCaptures.push({
        snapshotId: options.snapshot.snapshotId,
        boundary: options.boundary,
      })
      const created = createHost(options)
      if (created.ok) hosts.push(created.value)
      return created
    })
    restorers.push(() => hostSpy.mockRestore())
    const inspect = assets.inspect3dAsset,
      render = assets.render3dPreview,
      edit = assets.edit3dAsset
    const inspectSpy = spyOn(assets, 'inspect3dAsset').mockImplementation(
      (params) =>
        capture('inspect_3d_asset', params, () =>
          inspect(params),
        ) as ReturnType<typeof inspect>,
    )
    const renderSpy = spyOn(assets, 'render3dPreview').mockImplementation(
      (params) =>
        capture('render_3d_preview', params, () =>
          render(params),
        ) as ReturnType<typeof render>,
    )
    const editSpy = spyOn(assets, 'edit3dAsset').mockImplementation(
      (params) =>
        capture('edit_3d_asset', params, () => edit(params)) as ReturnType<
          typeof edit
        >,
    )
    restorers.push(
      () => inspectSpy.mockRestore(),
      () => renderSpy.mockRestore(),
      () => editSpy.mockRestore(),
    )
    const forbid = () => {
      networkAttempts++
      throw new Error(
        'Provider/network fetch forbidden in actual SDK Blender controls',
      )
    }
    const networkSpy = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(async () => forbid(), { preconnect: forbid }),
    )
    restorers.push(() => networkSpy.mockRestore())
    const client = new OpenbuffClient({
      cwd: root,
      projectFiles: {},
      knowledgeFiles: {},
      harnessStateDir: path.join(root, 'harness'),
      hostConfiguration: {
        environment,
        platform: 'linux',
        invocationCwd: root,
        projectRoot: root,
        home: { kind: 'none' },
        globals: { kind: 'disabled' },
        selection: { kind: 'explicit', path: configFile, required: true },
        trust: { ancestorConfig: false, projectReadableRoots: false },
      },
      configReadFs: nodeConfigReadFs,
      spawnSource: spawn,
      fsSource: fs,
      approvalMode: 'allow-all',
      executionProfile: SDK_BLENDER_PROFILE,
      recordExecution: (event) => events.push(event),
      handleEvent: (event) => {
        printEvents.push(event)
      },
      customToolDefinitions: [checkpoint],
    })
    pending = client.run({
      agent: program,
      prompt: JSON.stringify({ branch, control, sourceHash }),
      signal: stop.signal,
      runTimeoutMs: control === 'deadline-zero' ? 0 : 60_000,
    })
    if (control === 'delayed-authorizer-cancellation') {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          policyEntered,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Selected Blender authorizer not reached: ${branch}`,
                  ),
                ),
              5000,
            )
          }),
        ])
        stop.abort(
          new Error('SDK root cancelled during selected Blender authorization'),
        )
      } finally {
        if (timer) clearTimeout(timer)
        release()
      }
      await policyCompleted
    }
    result = await pending
    await Promise.allSettled(completions)
  } catch (caught) {
    error = caught
  } finally {
    release()
    stop.abort(new Error('SDK Blender fixture cleanup'))
    if (pending) await pending.catch(() => undefined)
    await Promise.allSettled(completions)
    for (const child of syntheticChildren) child.kill()
    for (const child of helpers)
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
    await Promise.allSettled(helperExits)
    sourceUnchanged =
      readFileSync(path.join(root, 'scene.blend'), 'utf8') === 'fixture'
    for (const restore of restorers.reverse()) restore()
    rmSync(root, { recursive: true, force: true })
  }
  return {
    branch,
    control,
    root,
    sourceHash,
    requestedProfile: SDK_BLENDER_PROFILE,
    runTimeoutMs: control === 'deadline-zero' ? 0 : 60_000,
    result,
    error,
    checkpointEntered,
    networkAttempts,
    hostCaptures,
    hostCount: hosts.length,
    authorityCount: authorities.length,
    events,
    policyInputs,
    targetPolicies,
    entries,
    printEvents,
    boundaryCalls,
    transitions,
    guardedCommitAttempts,
    sourceUnchanged,
    selectedPolicyCompleted,
    syntheticBlenderChildren: syntheticChildren.length,
    syntheticBlenderChildrenClosed: syntheticChildren.filter(
      (child) => child.exitCode !== null,
    ).length,
  }
}
