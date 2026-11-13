import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  BLENDER_BRANCHES,
  runSdkBlenderControl,
  SDK_BLENDER_CONTROLS,
} from './fixtures/b19-blender-sdk-branch-controls'

const REPO = path.resolve(import.meta.dir, '../../..')
const EVIDENCE = path.join(
  REPO,
  'docs/execution/body-roadmap/evidence/B19/continuation-20261111/blender-sdk-controls',
)
const SOURCES = [
  'sdk/src/__tests__/blender-sdk-execution-branch-controls.test.ts',
  'sdk/src/__tests__/fixtures/b19-blender-sdk-branch-controls.ts',
  'sdk/src/__tests__/fixtures/external-branch-controls.ts',
  'sdk/src/client.ts',
  'sdk/src/run.ts',
  'sdk/src/custom-tool.ts',
  'sdk/src/host-execution.ts',
  'sdk/src/host-config.ts',
  'sdk/src/services/harness-enforcement.ts',
  'sdk/src/services/execution-launch.ts',
  'sdk/src/tools/3d-assets.ts',
  'sdk/src/tools/node-filesystem.ts',
  'common/src/util/execution-context.ts',
  'common/src/types/contracts/execution-context.ts',
  'common/src/templates/agent-validation.ts',
  'packages/agent-runtime/src/run-programmatic-step.ts',
  'packages/agent-runtime/src/run-agent-step.ts',
  'packages/agent-runtime/src/tools/tool-executor.ts',
] as const
const digest = (file: string) =>
  createHash('sha256').update(readFileSync(file)).digest('hex')
let invocation:
  | { sourceHashes: Record<string, string>; toolchain: object }
  | undefined
function invocationHashes() {
  return (invocation ??= {
    sourceHashes: Object.fromEntries(
      SOURCES.map((file) => [file, digest(path.join(REPO, file))]),
    ),
    toolchain: {
      executable: process.execPath,
      sha256: digest(process.execPath),
      bun: Bun.version,
      platform: process.platform,
    },
  })
}
type Observation = Awaited<ReturnType<typeof runSdkBlenderControl>>
function jsonValue(result: unknown): Record<string, unknown> {
  if (!Array.isArray(result))
    throw new Error('Actual 3D callback did not return a tool-result array')
  const item = result.find((entry) => entry?.type === 'json')
  if (!item?.value || typeof item.value !== 'object')
    throw new Error('Actual 3D callback did not return JSON')
  return item.value
}
function assertSdkProducer(observed: Observation) {
  expect(observed.error).toBeUndefined()
  expect(observed.networkAttempts).toBe(0)
  expect(observed.result).toBeDefined()
  expect(observed.sourceUnchanged).toBe(true)
  expect(observed.syntheticBlenderChildrenClosed).toBe(
    observed.syntheticBlenderChildren,
  )
  if (observed.control === 'deadline-zero') {
    expect(observed.runTimeoutMs).toBe(0)
    expect(observed.checkpointEntered).toBe(false)
    expect(observed.entries).toHaveLength(0)
    expect(observed.boundaryCalls).toHaveLength(0)
    expect(observed.policyInputs).toHaveLength(0)
    expect(observed.events).toHaveLength(0)
    expect(observed.hostCaptures).toHaveLength(0)
    expect(observed.hostCount).toBe(0)
    expect(observed.authorityCount).toBe(0)
    expect(observed.result?.runOutcome?.termination).toBe('deadline_exhausted')
    expect(observed.result?.runOutcome?.cause?.code).toBe(
      'execution_deadline-exhausted',
    )
    return
  }
  expect(observed.hostCount).toBe(1)
  expect(observed.authorityCount).toBe(1)
  expect(observed.hostCaptures).toHaveLength(1)
  expect(observed.checkpointEntered).toBe(true)
  expect(observed.entries).toHaveLength(1)
  const entry = observed.entries[0]!
  const toolName = observed.branch.startsWith('blender.inspect')
    ? 'inspect_3d_asset'
    : observed.branch === 'blender.preview'
      ? 'render_3d_preview'
      : 'edit_3d_asset'
  expect(entry.toolName).toBe(toolName)
  expect(entry.path).toBe(
    observed.branch === 'blender.inspect-import' ? 'scene.fbx' : 'scene.blend',
  )
  expect(entry.projectRoot).toBe(observed.root)
  expect(entry.registered).toBe(true)
  expect(entry.executionPresent).toBe(true)
  expect(entry.spawnAdapterPresent).toBe(true)
  expect(entry.signalMatchesExecution).toBe(true)
  expect(entry.signalAbortedAtEntry).toBe(false)
  expect(entry.correlation?.kind).toBe('action')
  if (entry.correlation?.kind !== 'action')
    throw new Error('SDK callback lacks authenticated action identity')
  const rootRunId = observed.result?.sessionState?.mainAgentState.runId
  if (!rootRunId)
    throw new Error('SDK callback run lacks its settled root identity')
  expect(entry.correlation.owner.rootRunId).toBe(rootRunId)
  expect(entry.correlation.owner.parentAgentId).toBe('main-agent')
  expect(entry.correlation.owner.parentRunId).toBe(
    entry.correlation.owner.rootRunId,
  )
  expect(entry.correlation.owner.clientSessionId.length).toBeGreaterThan(0)
  expect(JSON.stringify(entry.correlation.owner)).not.toContain('forged')
  if (toolName === 'edit_3d_asset') {
    expect(entry.operationId).toBe(entry.correlation.actionId)
    expect(entry.sourceHash).toBe(observed.sourceHash)
  }
  expect(entry.initialActionDeadline?.kind).toBe('finite')
  const initialActionDeadline = entry.initialActionDeadline
  if (!initialActionDeadline)
    throw new Error('SDK callback lacks its original action deadline')
  if (entry.initialActionDeadline?.kind === 'finite') {
    const rootDeadline = observed.hostCaptures[0]!.boundary.deadline
    expect(rootDeadline.kind).toBe('finite')
    if (rootDeadline.kind === 'finite')
      expect(entry.initialActionDeadline.expiresAtMs).toBeLessThanOrEqual(
        rootDeadline.expiresAtMs,
      )
  }
  expect(
    observed.printEvents.some(
      (event) => event.type === 'tool_call' && event.toolName === toolName,
    ),
  ).toBe(true)
  for (const call of observed.boundaryCalls) {
    expect(call.launchId).toBeDefined()
    const input = observed.policyInputs.find(
      (item) => item.facts.launchId === call.launchId,
    )
    if (!input) throw new Error('SDK boundary lacks matching real policy input')
    expect(call.executable).toBe(input.target.executable)
    expect(call.argv).toEqual(input.target.argv)
    expect(call.cwd).toBe(input.target.cwd)
    expect(call.env.PROJECT_VALUE).toBe('sdk-blender-captured-public')
    expect(call.env.OPENAI_API_KEY).toBeUndefined()
    expect(call.env.CUSTOM_PROVIDER_KEY).toBeUndefined()
    expect(call.signalPresent).toBe(true)
    expect(call.signalEqualsPublicRequest).toBe(false)
    expect(call.signalAbortedAtSpawn).toBe(false)
    expect(input.facts.configurationSnapshotId).toBe(
      observed.hostCaptures[0]!.snapshotId,
    )
    expect(input.facts.executionBindingVersion).toBe(2)
    expect(input.facts.executionBindingDigest).toBe(input.bindingDigest)
    expect(input.facts.environment.entryCount).toBe(
      Object.keys(call.env).length,
    )
    for (const key of [
      'launchId',
      'ownerId',
      'resourceId',
      'resourceGeneration',
      'leaseId',
      'requestId',
      'destinationId',
    ] as const)
      expect(input.facts[key].length).toBeGreaterThan(0)
    const phases = observed.events
      .filter(
        (event) => 'facts' in event && event.facts.launchId === call.launchId,
      )
      .map((event) => event.phase)
    expect(phases).toContain('admitted')
    expect(phases).toContain('dispatched')
    expect(phases).toContain('spawn-observed')
    if (call.family === 'blender') {
      expect(call.executable).toBe('blender')
      expect(call.argv[0]).toBe('--disable-autoexec')
      expect(input.facts.correlation).toEqual(entry.correlation)
      expect(input.target.processType).toBe('SYNC')
      expect(input.classification.invocationKind).toBe('argv')
      expect(input.target.adapterOptions).toMatchObject({
        runtime: 'node',
        shell: false,
        stdio: 'ignore,pipe,pipe',
        windowsHide: true,
      })
    }
  }
  for (const event of observed.events) {
    if (!('facts' in event)) continue
    const facts = event.facts
    expect(facts.profile.requested).toEqual(observed.requestedProfile)
    expect(facts.profile.selected).toMatchObject({
      backend: 'portable-ts',
      policy: 'full-access',
      cancellation: 'cooperative',
    })
    expect(facts.profile.enforced).toContainEqual({
      capability: 'exact-env',
      status: 'enforced',
      evidenceId: 'captured-exact-environment',
    })
    if (
      ['planned', 'admitted', 'dispatched', 'no-launch'].includes(event.phase)
    )
      expect(facts.profile.active).toBeNull()
    if (event.phase === 'spawn-observed')
      expect(facts.profile.active?.policy).toBe('full-access')
    expect(
      facts.profile.enforced.some(
        (item) =>
          item.capability === 'process-tree-containment' &&
          item.status === 'enforced',
      ),
    ).toBe(false)
    if (facts.family === 'blender') {
      expect(facts.correlation).toEqual(entry.correlation)
      expect(facts.deadlines.action).toEqual(initialActionDeadline)
      if (
        facts.deadlines.action.kind === 'finite' &&
        facts.deadlines.requestAdmission.kind === 'finite'
      )
        expect(
          facts.deadlines.requestAdmission.expiresAtMs,
        ).toBeLessThanOrEqual(facts.deadlines.action.expiresAtMs)
    }
  }
  expect(JSON.stringify(observed.events)).not.toContain('sentinel')
}
function assertControl(observed: Observation) {
  const { branch, control } = observed
  const calls = observed.boundaryCalls.filter(
    (call) => call.family === 'blender',
  )
  const expected: string[] =
    control !== 'deadline-zero' && branch === 'blender.validate'
      ? ['blender.edit']
      : []
  if (control === 'happy') {
    expected.push(branch)
    if (branch === 'blender.edit') expected.push('blender.validate')
  }
  expect(calls.map((call) => call.branch)).toEqual(expected)
  const targetEvents = observed.events.filter(
    (event) =>
      'facts' in event &&
      event.facts.family === 'blender' &&
      event.facts.branchId === branch,
  )
  if (control !== 'happy')
    expect(
      targetEvents.some(
        (event) =>
          event.phase === 'dispatched' || event.phase === 'spawn-observed',
      ),
    ).toBe(false)
  if (control === 'deadline-zero') return
  const consumer = jsonValue(observed.entries[0]!.result)
  const correlation = observed.entries[0]!.correlation
  if (correlation?.kind !== 'action')
    throw new Error('Missing actual Blender action')
  const action = observed.result?.actionOutcomes?.find(
    (item) =>
      item.actionId === correlation.actionId &&
      item.attemptId === correlation.attemptId,
  )
  expect(action).toBeDefined()
  expect(action?.toolName).toBe(observed.entries[0]!.toolName)
  expect(action?.runId).toBe(correlation.owner.rootRunId)
  // SDK action normalization preserves returned JSON refusals as succeeded
  // for inspect/preview, and guarded not_applied edits as uncertain. Neither
  // is evidence that Blender launched; exact launch events are checked above.
  const cancelled =
    control === 'pre-aborted' ||
    control === 'exhausted-before-later-branch' ||
    control === 'delayed-authorizer-cancellation'
  expect(action?.outcome).toBe(
    cancelled
      ? 'cancelled'
      : observed.entries[0]!.toolName === 'edit_3d_asset'
        ? 'uncertain'
        : 'succeeded',
  )
  if (!cancelled) {
    expect(observed.result?.output.type).toBe('structuredOutput')
    expect(observed.result?.runOutcome?.termination).toBe('completed')
  }
  if (
    [
      'happy',
      'denied',
      'unavailable',
      'delayed-authorizer-cancellation',
    ].includes(control)
  )
    expect(observed.targetPolicies).toHaveLength(1)
  if (control === 'happy') {
    expect(observed.result?.output.type).toBe('structuredOutput')
    expect(observed.result?.runOutcome?.termination).toBe('completed')
    expect(consumer.error).toBeUndefined()
    expect(consumer.executionRefusal).toBeUndefined()
    if (branch === 'blender.edit' || branch === 'blender.validate') {
      expect(consumer.outcome).toBe('not_applied')
      expect(observed.guardedCommitAttempts).toBe(1)
    } else {
      expect(observed.guardedCommitAttempts).toBe(0)
      if (branch === 'blender.preview') {
        expect(consumer.receipts).toBeArray()
        expect((consumer.receipts as object[])[0]).toMatchObject({
          producer: 'blender',
          view: 'front',
          mode: 'clay',
          dimensions: { width: 128, height: 128 },
        })
      } else expect(consumer).toHaveProperty('summary')
    }
  } else {
    expect(observed.guardedCommitAttempts).toBe(0)
    if (branch === 'blender.edit' || branch === 'blender.validate')
      expect(consumer.outcome).toBe('not_applied')
    else expect(typeof consumer.error).toBe('string')
  }
  if (control === 'denied' || control === 'unavailable') {
    expect(
      targetEvents.some(
        (event) =>
          event.phase === 'no-launch' && event.refusal.reason === control,
      ),
    ).toBe(true)
    expect(consumer.executionRefusal).toMatchObject({
      ok: false,
      reason: control,
    })
  }
  if (control === 'delayed-authorizer-cancellation') {
    expect(observed.selectedPolicyCompleted).toBe(true)
    expect(
      targetEvents.some(
        (event) =>
          event.phase === 'no-launch' && event.refusal.reason === 'cancelled',
      ),
    ).toBe(true)
    expect(observed.result?.runOutcome?.termination).toBe('cancelled')
  }
  if (
    control === 'pre-aborted' ||
    control === 'exhausted-before-later-branch'
  ) {
    expect(observed.transitions).toHaveLength(1)
    const transition = observed.transitions[0]!
    expect(transition.earlierBlenderCalls).toBe(
      branch === 'blender.validate' ? 1 : 0,
    )
    expect(transition.earlierHelperCalls).toBe(
      observed.boundaryCalls.filter((call) => call.family !== 'blender').length,
    )
    expect(transition.rootAborted).toBe(true)
    if (control === 'exhausted-before-later-branch') {
      expect(observed.targetPolicies).toHaveLength(
        branch === 'blender.validate' ? 0 : 1,
      )
      expect(observed.runTimeoutMs).toBeGreaterThan(0)
      expect(transition.originalRootDeadline?.kind).toBe('finite')
      if (transition.originalRootDeadline?.kind === 'finite') {
        expect(transition.beforeMs).toBeLessThan(
          transition.originalRootDeadline.expiresAtMs,
        )
        expect(transition.afterMs).toBeGreaterThan(
          transition.originalRootDeadline.expiresAtMs,
        )
      }
      expect(observed.result?.runOutcome?.termination).toBe(
        'deadline_exhausted',
      )
    } else {
      expect(observed.targetPolicies).toHaveLength(0)
      expect(observed.result?.runOutcome?.termination).toBe('cancelled')
    }
  }
}
function writeEvidence(observed: Observation, failure: unknown) {
  if (!process.env.B19_BLENDER_SDK_EVIDENCE_DIR) return
  const directory = path.resolve(process.env.B19_BLENDER_SDK_EVIDENCE_DIR)
  const relative = path.relative(EVIDENCE, directory)
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(
      'B19_BLENDER_SDK_EVIDENCE_DIR must remain inside the owned Blender SDK evidence directory',
    )
  mkdirSync(directory, { recursive: true })
  const id = `sdk.blender--${observed.branch}--${observed.control}`
  const artifact = path.join(directory, `${id}.json`)
  const { result, ...details } = observed
  writeFileSync(
    artifact,
    JSON.stringify(
      {
        schemaVersion: 1,
        caseId: id,
        producer: 'sdk.blender',
        selectedProducer: `sdk/src/run.ts ${observed.entries[0]?.toolName ?? 'intake-refusal'} callback`,
        branch: observed.branch,
        control: observed.control,
        status: failure ? 'failed' : 'passed',
        ...invocationHashes(),
        evidenceKind:
          'actual-sdk-producer-with-selected-policy-DI-and-synthetic-Blender-boundary',
        requestedProfile: observed.requestedProfile,
        targetBoundaryCount: observed.boundaryCalls.filter(
          (call) =>
            call.family === 'blender' && call.branch === observed.branch,
        ).length,
        earlierBlenderHelperCount:
          observed.branch === 'blender.validate'
            ? observed.boundaryCalls.filter(
                (call) => call.branch === 'blender.edit',
              ).length
            : 0,
        otherBlenderBoundaryCount: observed.boundaryCalls.filter(
          (call) =>
            call.family === 'blender' && call.branch !== observed.branch,
        ).length,
        sdkHelperBoundaryCount: observed.boundaryCalls.filter(
          (call) => call.family !== 'blender',
        ).length,
        callbackReached: observed.entries.length > 0,
        zeroSemantics:
          observed.control === 'deadline-zero'
            ? 'literal-zero-at-public-SDK-intake'
            : observed.control === 'exhausted-before-later-branch'
              ? 'original-positive-parent-budget-spent'
              : undefined,
        observed: {
          ...details,
          result: result && {
            output: result.output,
            runOutcome: result.runOutcome,
            actionOutcomes: result.actionOutcomes,
          },
        },
        failure,
        limitations: [
          'Blender process/PID/output/PNG boundaries are synthetic; actual SDK startup helpers use Node spawning.',
          'Only selected denied/unavailable/delayed-policy decisions are controlled; all other policy inputs delegate to the original host policy.',
          'Pre-abort happens after actual callback entry or earlier edit; literal-zero is public SDK intake refusal with no callback.',
          'Exhaustion advances one original clock domain without replacing captured deadlines.',
          'Edit commit is a cooperative-CAS refusal fixture; happy edit/validation proves launch traversal, not an applied mutation.',
          'No installed Blender, provider/network/model request, OS containment/process-death or candidate acceptance claim.',
        ],
      },
      (_key, item) =>
        item instanceof Error
          ? {
              ...item,
              name: item.name,
              message: item.message,
              stack: item.stack,
            }
          : item,
      2,
    ) + '\n',
    { flag: 'wx' },
  )
  console.log(`B19_BLENDER_SDK_CASE_EVIDENCE ${artifact}`)
}
describe('B19 actual OpenbuffClient.run Blender producer controls', () => {
  for (const branch of BLENDER_BRANCHES)
    for (const control of SDK_BLENDER_CONTROLS)
      test(`sdk.blender ${branch} ${control}`, async () => {
        invocationHashes()
        const observed = await runSdkBlenderControl(branch, control)
        let failure: unknown
        try {
          assertSdkProducer(observed)
          assertControl(observed)
        } catch (error) {
          failure = error
          throw error
        } finally {
          writeEvidence(observed, failure)
        }
      }, 15_000)
})
