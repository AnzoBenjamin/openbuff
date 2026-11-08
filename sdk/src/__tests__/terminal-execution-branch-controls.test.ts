import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

import { createDiagnosticCommandRunner } from '../services/diagnostic-delta-runner'
import { DIAGNOSTIC_COMMAND_INVOCATIONS } from '../services/diagnostic-delta'
import { isExecutionRefusalError, refusalForSignal } from '../services/execution-launch'
import { resolveWorkspaceIdentity } from '../services/repository-identity'
import { runFileChangeHooks } from '../tools/file-change-hooks'
import { computeWorktreeSnapshotIdentity, getChangeReviewBundle } from '../tools/get-change-review-bundle'
import { gitBranch } from '../tools/git-branch'
import { gitStatus } from '../tools/git-status'
import { inspectWorkspace } from '../tools/inspect-workspace'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { listDirtyPaths, runTerminalCommand } from '../tools/run-terminal-command'
import {
  branchControlStatesR3, branchProgramR3,
  createTerminalBranchFixtureR3, deadlineMsR3,
} from './fixtures/b19-terminal-branch-authority-r3'

import type { BranchControlStateR3, TerminalBranchCaseR3, TerminalBranchFixtureR3 } from './fixtures/b19-terminal-branch-authority-r3'
import type { LaunchEvent, PolicyInput, Refusal } from '@codebuff/common/types/contracts/execution-context'
import type { AgentDefinition, ToolCall } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { RunState } from '../run-state'

const evidenceRoot = path.resolve(import.meta.dir, '../../../docs/execution/body-roadmap/evidence/B19/implementation/branch-controls-r3/terminal')
const plan = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'prepared-cases.json'), 'utf8')) as {
  states: BranchControlStateR3[]
  caseCount: number
  cases: TerminalBranchCaseR3[]
  companionCases: {
    replacementEnvironmentHappy: TerminalBranchCaseR3[]
    unboundedParentHookHappy: TerminalBranchCaseR3[]
    successfulTransferredSurvivor: TerminalBranchCaseR3[]
  }
}
const applicability = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'producer-applicability.json'), 'utf8')) as {
  edgeCount: number
  edges: Array<{ branchId: string; producerId: string; applicability: string; sourceRefs: string[]; explanation: string; executed: boolean }>
}

function statusInput(branchId: string) {
  return {
    include_diff: branchId.includes('.diff-'),
    staged: branchId.includes('.diff-staged.'),
    ...(branchId.endsWith('.filtered') ? { path: 'tracked.ts' } : {}),
  }
}

function sdkProgram(): AgentDefinition {
  return branchProgramR3(function* ({ prompt, agentState }) {
    if (!prompt) throw new Error('R3 SDK program requires captured fixture JSON')
    const { testCase: selected, sourceFile, mutationContent } = JSON.parse(prompt) as {
      testCase: TerminalBranchCaseR3; sourceFile: string; mutationContent: string
    }
    // The SDK serializes this generator; every runtime helper stays inside it.
    function branchCallR3(toolName: string, input: unknown): ToolCall {
      return { toolName, input } as ToolCall
    }
    function snapshotIdFrom(result: unknown): string | undefined {
      if (!Array.isArray(result)) return undefined
      for (const part of result) {
        if (part?.type === 'json' && typeof part.value?.snapshotId === 'string') return part.value.snapshotId
      }
      return undefined
    }
    function statusInput(branchId: string) {
      return {
        include_diff: branchId.includes('.diff-'),
        staged: branchId.includes('.diff-staged.'),
        ...(branchId.endsWith('.filtered') ? { path: 'tracked.ts' } : {}),
      }
    }
    const results: unknown[] = []
    const isDiagnostic = selected.branchId.startsWith('diagnostic.')
    if (isDiagnostic && (selected.phase === 'baseline' || selected.phase === 'after')) {
      const mutation = yield branchCallR3('write_file', { path: sourceFile,
        instructions: 'Create the owned diagnostic fixture source.', content: mutationContent })
      results.push({ tool: 'write_file', result: mutation.toolResult })
      if (selected.phase === 'baseline') {
        yield branchCallR3('set_output', { results, actor: { agentId: agentState.agentId, runId: agentState.runId } })
        return
      }
    }
    let targetTool: string
    let input: unknown
    if (selected.producerId === 'sdk.broker-bootstrap' || selected.producerId === 'sdk.journal-bootstrap') {
      yield branchCallR3('set_output', { results, bootstrapCompleted: true })
      return
    }
    if (selected.producerId === 'sdk.targeted-validation') {
      const bundle = yield branchCallR3('get_change_review_bundle', {})
      results.push({ tool: 'get_change_review_bundle', result: bundle.toolResult })
      const snapshotId = snapshotIdFrom(bundle.toolResult)
      if (!snapshotId) throw new Error(`Actual SDK bundle did not return the targeted-validation seed: ${JSON.stringify(bundle.toolResult)}`)
      targetTool = 'run_targeted_validation'
      input = { snapshot_id: snapshotId, files: [sourceFile], artifact_kinds: [] }
    } else if (selected.producerId === 'sdk.push-workspace') {
      targetTool = 'run_terminal_command'
      input = { command: 'git push origin r3-work', process_type: 'SYNC', timeout_seconds: -1 }
    } else if (selected.producerId === 'sdk.inspect-workspace') {
      targetTool = 'inspect_workspace'
      input = {}
    } else if (selected.producerId === 'sdk.git-status') {
      targetTool = 'git_status'
      input = statusInput(selected.branchId)
    } else if (selected.producerId === 'sdk.bundle') {
      targetTool = 'get_change_review_bundle'
      input = {}
    } else if (selected.producerId === 'sdk.hooks' || selected.producerId === 'sdk.diagnostic') {
      targetTool = 'run_file_change_hooks'
      input = { files: [sourceFile] }
    } else {
      targetTool = 'run_terminal_command'
      input = {
        command: selected.branchId === 'terminal.safety.check' || selected.branchId === 'terminal.safety.diff'
          ? 'git commit -m r3-fixture' : 'printf r3-terminal-fixture',
        process_type: selected.branchId.startsWith('background.') ? 'BACKGROUND' : 'SYNC',
        ...(selected.branchId === 'background.transferred' ? { detach: true } : {}),
        timeout_seconds: -1,
      }
    }
    const response = yield branchCallR3(targetTool, input)
    results.push({ tool: targetTool, result: response.toolResult })
    yield branchCallR3('set_output', { results, actor: { agentId: agentState.agentId, runId: agentState.runId } })
  })
}

/** Direct adapter rows are explicitly supplemental, except the named direct API edges. */
async function invokeDirect(fixture: TerminalBranchFixtureR3): Promise<unknown> {
  if (!fixture.context) {
    if (fixture.registrationRefusal) return { registrationRefusal: fixture.registrationRefusal, consumerInvoked: false }
    throw new Error('R3 direct context was not registered')
  }
  const context = fixture.context
  const selected = fixture.testCase
  const common = { cwd: fixture.root, signal: context.signal, executionContext: context }
  try {
    if (selected.producerId === 'direct.git-branch' || selected.branchId.startsWith('git-branch.')) {
      return await gitBranch({ ...common, branchName: 'r3-fixture-branch',
        switch: selected.branchId !== 'git-branch.create', allowDirty: false })
    }
    if (selected.branchId.startsWith('git-status.')) {
      return await gitStatus({ ...common, ...statusInput(selected.branchId),
        ...(selected.branchId.includes('.bounded.') ? { timeoutMs: 10_000 } : {}) })
    }
    if (selected.branchId.startsWith('identity.')) {
      return await resolveWorkspaceIdentity({ ...common, phase: selected.phase,
        ...(selected.branchId.includes('.bounded.') ? { timeoutMs: 10_000 } : {}) })
    }
    if (selected.branchId.startsWith('workspace.')) return await inspectWorkspace(common)
    if (selected.branchId === 'terminal.legacy-dirty') {
      const paths = await listDirtyPaths(fixture.root, context.signal, undefined, context)
      return { paths: paths ? [...paths] : null }
    }
    if (selected.branchId.startsWith('terminal.') || selected.branchId.startsWith('background.')) {
      return await runTerminalCommand({ ...common, projectRoot: fixture.root,
        command: selected.branchId === 'terminal.safety.check' || selected.branchId === 'terminal.safety.diff'
          ? 'git commit -m r3-fixture' : 'printf r3-terminal-fixture',
        process_type: selected.branchId.startsWith('background.') ? 'BACKGROUND' : 'SYNC',
        detach: selected.branchId === 'background.transferred', timeout_seconds: -1,
        env: fixture.childOverrides, mode: selected.mode,
        getTerminalLaunchMetadata: fixture.getTerminalLaunchMetadata,
        prepareTransferredLaunch: fixture.prepareTransferredLaunch,
        owner: { clientSessionId: 'r3-direct-session', rootRunId: 'r3-direct-fixture', parentRunId: 'r3-direct-fixture', parentAgentId: 'r3-direct-agent' },
      })
    }
    if (selected.branchId.startsWith('hook.')) {
      return await runFileChangeHooks({ ...common, files: [fixture.sourceFile], env: fixture.childOverrides,
        fileSystem: createNodeFileSystem(), capturedConfiguration: fixture.capturedHookConfiguration,
        getTerminalLaunchMetadata: fixture.getTerminalLaunchMetadata })
    }
    if (selected.branchId.startsWith('diagnostic.')) {
      const commandId = selected.branchId.split('.')[1]
      const command = Object.entries(DIAGNOSTIC_COMMAND_INVOCATIONS).find(([, invocation]) => invocation.id === commandId)?.[0]
      if (!command) throw new Error(`No frozen diagnostic invocation for ${commandId}`)
      return await createDiagnosticCommandRunner({ spawn: fixture.processRecorder.spawn })({ ...common,
        command, timeoutSeconds: 120, env: fixture.childOverrides, phase: selected.phase as 'baseline' | 'current' | 'after' })
    }
    if (selected.branchId === 'bundle.snapshot-head' || selected.branchId === 'bundle.snapshot-porcelain') {
      return await computeWorktreeSnapshotIdentity({ ...common, phase: selected.phase })
    }
    if (selected.branchId.startsWith('bundle.')) return await getChangeReviewBundle(common)
    throw new Error(`No direct adapter selector for ${selected.branchId}`)
  } catch (error) {
    if (isExecutionRefusalError(error)) return { executionRefusal: error.refusal, thrownRefusalName: error.name }
    if (context.signal?.aborted && error === context.signal.reason) {
      return { executionRefusal: refusalForSignal(context.signal), consumerRejected: true,
        thrownAbortReason: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error }
    }
    throw error
  }
}

function targetInputs(fixture: TerminalBranchFixtureR3, inputStart = 0) {
  const selected = fixture.policyInputs.slice(inputStart).filter(fixture.matches)
  // Broker and journal intentionally share the retained bootstrap context.
  // Their later matching launches never become the selected producer edge.
  const selectedLaunchId = fixture.controlInput?.facts.launchId
  return selectedLaunchId ? selected.filter(input => input.facts.launchId === selectedLaunchId) : selected
}

function targetEvents(fixture: TerminalBranchFixtureR3, events: readonly LaunchEvent[], inputs: readonly PolicyInput[]) {
  const ids = new Set(inputs.map(input => input.facts.launchId))
  return events.filter(event => 'facts' in event && ids.has(event.facts.launchId))
}

function refusalsFrom(value: unknown): Refusal[] {
  if (value === null || typeof value !== 'object') return []
  const object = value as Record<string, unknown>
  const found = object.ok === false && typeof object.reason === 'string' ? [object as unknown as Refusal] : []
  return [...found, ...Object.values(object).flatMap(refusalsFrom)]
}

async function settleWithin<T>(pending: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending.then(value => ({ kind: 'settled' as const, value }), error => ({ kind: 'rejected' as const, error })),
      new Promise<{ kind: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function assertActualSdkIdentity(fixture: TerminalBranchFixtureR3, input: PolicyInput, result: RunState) {
  const correlation = input.facts.correlation
  if (fixture.testCase.origin === 'host-observation') {
    expect(correlation.kind).toBe('host-observation')
    if (correlation.kind !== 'host-observation') throw new Error('Bootstrap fabricated action correlation')
    expect(correlation.purpose).toBe('repository-bootstrap')
    expect(correlation.hostContextId).toBe(input.facts.hostContextId)
    expect(correlation).not.toHaveProperty('actionId')
    const inputIndex = fixture.policyInputs.indexOf(input)
    const entry = fixture.consumerEntries.find(candidate => candidate.producerId === fixture.testCase.producerId
      && candidate.firstPolicyInput <= inputIndex && (candidate.afterPolicyInput ?? Infinity) > inputIndex)
    expect(entry).toBeDefined()
    expect(entry?.authenticContextRegistered).toBe(true)
    expect(entry?.registeredCorrelation).toEqual(correlation)
    return
  }
  expect(correlation.kind).toBe('action')
  if (correlation.kind !== 'action') throw new Error('SDK tool lost registered action correlation')
  const action = result.actionOutcomes?.find(entry => entry.actionId === correlation.actionId)
  expect(action).toBeDefined()
  if (!action) throw new Error('SDK receipt has no outcome for the registered launch action')
  const mainActor = result.sessionState?.mainAgentState
  if (!mainActor) throw new Error('SDK receipt has no main session actor')
  const mainRunId = mainActor.runId
  const mainAgentId = mainActor.agentId
  if (typeof mainRunId !== 'string' || mainRunId.length === 0) throw new Error('SDK session actor has no run ID')
  if (typeof mainAgentId !== 'string' || mainAgentId.length === 0) throw new Error('SDK session actor has no agent ID')
  expect(action.attemptId).toBe(correlation.attemptId)
  const expectedTool = fixture.testCase.sdkActionTool ?? ({
    'sdk.bundle': 'get_change_review_bundle', 'sdk.inspect-workspace': 'inspect_workspace',
    'sdk.git-status': 'git_status', 'sdk.targeted-validation': 'run_targeted_validation', 'sdk.hooks': 'run_file_change_hooks',
  } as Record<string, string>)[fixture.testCase.producerId] ?? 'run_terminal_command'
  expect(action.toolName).toBe(expectedTool)
  expect(correlation.owner.parentRunId).toBe(action.runId)
  expect(correlation.owner.rootRunId).toBe(mainRunId)
  expect(correlation.owner.parentAgentId).toBe(mainAgentId)
  const callback = fixture.callbacks.find(event => event.type === 'tool_result' && event.actionOutcome?.actionId === correlation.actionId)
  expect(callback).toBeDefined()
}

function assertHappyCapture(fixture: TerminalBranchFixtureR3, result: unknown, inputs: PolicyInput[]) {
  expect(inputs.length).toBeGreaterThan(0)
  const launches = new Set(inputs.map(input => input.facts.launchId))
  const calls = fixture.processRecorder.calls.filter(call => launches.has(call.launchId))
  expect(calls.length).toBeGreaterThan(0)
  for (const input of inputs) {
    const call = calls.find(entry => entry.launchId === input.facts.launchId)
    expect(call).toBeDefined()
    if (!call) throw new Error(`Selected target was not dispatched: ${fixture.testCase.id}`)
    expect(call.executable).toBe(input.target.executable)
    expect(call.argv).toEqual(input.target.argv)
    expect(call.options.cwd).toBe(fixture.root)
    expect(call.options.env).toEqual(fixture.expectedEnvironment)
    expect(call.options.shell).toBe(false)
    expect(call.resourceSignal).toBeDefined()
    expect(call.signalAbortedAtDispatch).toBe(false)
    expect(input.facts.environment.inherited).toBe(Object.hasOwn(fixture.expectedEnvironment, 'GIT_CONFIG_NOSYSTEM'))
    expect(input.facts.environment.entryCount).toBe(Object.keys(fixture.expectedEnvironment).length)
    expect(input.facts.profile.requested).toEqual(fixture.profile)
    expect(input.facts.profile.available.some(backend => backend.backend === 'portable-ts' && backend.capabilities.includes('exact-env'))).toBe(true)
    const phases = fixture.events.filter(event => 'facts' in event && event.facts.launchId === input.facts.launchId).map(event => event.phase)
    expect(phases).toContain('planned')
    expect(phases).toContain('admitted')
    expect(phases).toContain('dispatched')
    expect(phases).toContain('spawn-observed')
    const observed = fixture.events.find(event => event.phase === 'spawn-observed' && event.facts.launchId === input.facts.launchId)
    expect(observed && 'facts' in observed && observed.facts.profile.active).not.toBeNull()
    const registered = fixture.contexts.find(entry => JSON.stringify(entry.initialCorrelation) === JSON.stringify(input.facts.correlation))
    expect(registered).toBeDefined()
    if (!registered) throw new Error('No authentic private correlation registration for selected launch')
    expect(input.facts.deadlines.action).toEqual(registered.initialDeadline)
    const privateExpiry = deadlineMsR3(registered.initialDeadline)
    const resourceExpiry = deadlineMsR3(input.facts.deadlines.resourceLifetime)
    if (privateExpiry !== null && resourceExpiry !== null) expect(resourceExpiry).toBeLessThanOrEqual(privateExpiry)
    if (fixture.testCase.rootUnbounded && fixture.testCase.branchId.startsWith('hook.configured.')) {
      expect(registered.initialDeadline.kind).toBe('unbounded')
      if (fixture.testCase.hookTimeout === -1) {
        expect(input.facts.deadlines.requestAdmission.kind).toBe('unbounded')
        expect(input.facts.deadlines.resourceLifetime.kind).toBe('unbounded')
      } else {
        expect(resourceExpiry).not.toBeNull()
        const observedAt = fixture.policyObservedAtMs.get(input.facts.launchId)
        if (observedAt === undefined || resourceExpiry === null) throw new Error('Configured hook deadline lacks a private clock observation')
        expect(resourceExpiry - observedAt).toBeGreaterThan(295_000)
        expect(resourceExpiry - observedAt).toBeLessThanOrEqual(300_000)
      }
    }
    if (fixture.testCase.phase) expect(input.target.adapterOptions.phase).toBe(fixture.testCase.phase)
    if (fixture.testCase.route === 'sdk-run') assertActualSdkIdentity(fixture, input, result as RunState)
    else expect(input.facts.correlation.kind).toBe('host-operation')
    if (fixture.testCase.branchId === 'background.transferred') {
      const transfer = fixture.events.find(event => event.phase === 'resource-transferred' && event.resourceId === input.facts.resourceId)
      expect(transfer).toBeDefined()
      if (transfer?.phase !== 'resource-transferred') throw new Error('Transferred background branch lacks an authentic committed transfer')
      expect(transfer.newOwnerId).toBe(input.facts.ownerId)
      expect(transfer.correlation).toEqual(input.facts.correlation)
      expect(input.binding.detachTransferId).toBe(transfer.transferId)
    }
  }
  expect(JSON.stringify(fixture.events)).not.toContain('r3-canonical-sentinel')
  expect(JSON.stringify(fixture.events)).not.toContain('r3-configured-sentinel')
  expect(JSON.stringify(fixture.events)).not.toContain('r3-canonical-reinjection')
  expect(JSON.stringify(fixture.events)).not.toContain('r3-configured-reinjection')
}

async function exercise(testCase: TerminalBranchCaseR3, state: BranchControlStateR3, inherited = true) {
  const fixture = createTerminalBranchFixtureR3(testCase, state, inherited)
  let result: unknown
  let outcome: 'passed' | 'failed' = 'failed'
  let failure: unknown
  let pending: Promise<unknown> | undefined
  let settledBeforePolicyRelease: boolean | undefined
  let attemptCallStart = 0
  let attemptInputStart = 0
  let selectedLaunchIds: string[] = []
  let selectedTargetDispatchCount: number | undefined
  let lateTargetDispatchCount: number | undefined
  try {
    const invoke = () => testCase.route === 'sdk-run' ? fixture.runSdk(sdkProgram()) : invokeDirect(fixture)
    if (state === 'exhausted-before-later-branch' && testCase.route !== 'sdk-run') {
      // Repeat the real direct consumer under the SAME registered private
      // budget. Earlier target/helper launches are retained separately.
      fixture.disarm()
      await invoke()
      fixture.arm()
      fixture.exhaust()
    }
    const callStart = fixture.processRecorder.calls.length
    attemptCallStart = callStart
    const eventStart = fixture.events.length
    const inputStart = fixture.policyInputs.length
    attemptInputStart = inputStart
    pending = invoke()
    if (state === 'delayed-authorizer-cancellation') {
      await Promise.race([fixture.ready, pending.then(() => { throw new Error('Named consumer finished without reaching the selected delayed-authorizer edge') })])
      const beforeCancelCalls = fixture.processRecorder.calls.length
      if (testCase.route === 'sdk-run') fixture.stop.abort(new Error('R3 cancellation while selected authorizer is pending'))
      else fixture.requestStop.abort(new Error('R3 cancellation while selected authorizer is pending'))
      const cancellation = await settleWithin(pending, 1_000)
      settledBeforePolicyRelease = cancellation.kind === 'settled' && !fixture.policyReleased
      expect(settledBeforePolicyRelease).toBe(true)
      if (cancellation.kind === 'rejected') throw cancellation.error
      if (cancellation.kind !== 'settled') throw new Error('Selected admission did not settle before policy release')
      result = cancellation.value
      if (testCase.branchId === 'background.transferred') {
        expect(fixture.controlInput?.binding.detachTransferId).not.toBeNull()
        expect(fixture.controlInput?.facts.correlation.kind).toBe(testCase.origin)
      }
      fixture.release()
      expect((await settleWithin(fixture.policyFinished, 1_000)).kind).toBe('settled')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      const selectedIds = new Set(targetInputs(fixture, inputStart).map(input => input.facts.launchId))
      lateTargetDispatchCount = fixture.processRecorder.calls.slice(beforeCancelCalls).filter(call => selectedIds.has(call.launchId)).length
      expect(fixture.processRecorder.calls.length).toBe(beforeCancelCalls)
      expect(lateTargetDispatchCount).toBe(0)
    } else result = await pending
    await Promise.resolve()
    const inputs = targetInputs(fixture, inputStart)
    const selectedEvents = targetEvents(fixture, fixture.events.slice(eventStart), inputs)
    const launchIds = new Set(inputs.map(input => input.facts.launchId))
    selectedLaunchIds = [...launchIds]
    const targetCalls = fixture.processRecorder.calls.slice(callStart).filter(call => launchIds.has(call.launchId))
    selectedTargetDispatchCount = targetCalls.length
    if (state === 'happy') assertHappyCapture(fixture, result, inputs)
    else {
      expect(targetCalls).toHaveLength(0)
      expect(selectedEvents.some(event => event.phase === 'dispatched' || event.phase === 'spawn-observed')).toBe(false)
      const expectedReason = state === 'denied' || state === 'unavailable' ? state
        : state === 'pre-aborted' || state === 'delayed-authorizer-cancellation' ? 'cancelled' : 'deadline-exhausted'
      const receipts = selectedEvents.filter((event): event is Extract<LaunchEvent, { phase: 'no-launch' }> => event.phase === 'no-launch')
      if (state === 'denied' || state === 'unavailable' || state === 'delayed-authorizer-cancellation'
        || state === 'exhausted-before-later-branch' && testCase.route === 'sdk-run') {
        expect(fixture.controlInput).toBeDefined()
        expect(receipts.length).toBeGreaterThan(0)
        expect(receipts.some(event => event.refusal.reason === expectedReason)).toBe(true)
      } else if (testCase.route === 'sdk-run') {
        // An outer entry refusal has no constructed target/branch receipt.
        expect(fixture.hosts).toHaveLength(0)
        expect(fixture.processRecorder.calls).toHaveLength(0)
        expect((result as RunState).runOutcome?.termination).toBe(state === 'pre-aborted' ? 'cancelled' : 'deadline_exhausted')
      } else {
        expect(refusalsFrom(result).some(refusal => refusal.reason === expectedReason)).toBe(true)
      }
      for (const event of receipts) expect(event.facts.profile.active).toBeNull()
      if (state === 'exhausted-before-later-branch') {
        if (testCase.route !== 'sdk-run') expect(callStart).toBeGreaterThan(0)
        else if (testCase.supportsEarlierBranchExhaustion) expect(fixture.earlierDispatchCountAtControl).toBeGreaterThan(0)
      }
    }
    if (testCase.route === 'sdk-run' && state !== 'pre-aborted' && state !== 'deadline-zero') {
      expect(fixture.hosts).toHaveLength(1)
      expect(fixture.configReads.every(file => file === (fixture.hostConfiguration.selection.kind === 'explicit' ? fixture.hostConfiguration.selection.path : undefined))).toBe(true)
    }
    expect(fixture.networkAttempts()).toBe(0)
    outcome = 'passed'
  } catch (error) {
    failure = error
    throw error
  } finally {
    // Even a cancellation regression cannot leave a deferred policy or global
    // fixture observer live for the next case. Its failure remains retained.
    if (state === 'delayed-authorizer-cancellation') {
      fixture.release()
      if (pending) await settleWithin(pending, 1_000)
      if (fixture.controlInput) await settleWithin(fixture.policyFinished, 1_000)
    }
    fixture.persist({ result, controlCoverage: {
      branchReceiptConstructed: fixture.controlInput !== undefined,
      outerEntryGateOnly: testCase.route === 'sdk-run' && (state === 'pre-aborted' || state === 'deadline-zero'),
      laterBranchExhaustionApplicable: testCase.supportsEarlierBranchExhaustion !== false,
      supplementalAdapterOnly: testCase.route === 'supplemental-direct-adapter',
      settledBeforePolicyRelease,
      attemptCallStart, attemptInputStart, selectedLaunchIds, selectedTargetDispatchCount, lateTargetDispatchCount,
      earlierLaunchIds: fixture.processRecorder.calls.slice(0, attemptCallStart).map(call => call.launchId),
      earlierTargetDispatchCount: fixture.processRecorder.calls.slice(0, attemptCallStart).filter(call => call.branchId === testCase.branchId).length,
      earlierHelperLaunchIds: fixture.processRecorder.calls.slice(0, attemptCallStart).filter(call => call.branchId !== testCase.branchId).map(call => call.launchId),
    } }, outcome, failure)
    fixture.dispose()
  }
}

describe('B19 R3 terminal producer and branch controls', () => {
  test('the prepared roster distinguishes each approved producer edge from supplemental adapters and N/A', () => {
    expect(plan.states).toEqual([...branchControlStatesR3])
    expect(plan.cases).toHaveLength(plan.caseCount)
    expect(applicability.edges).toHaveLength(applicability.edgeCount)
    expect(applicability.edgeCount).toBe(156)
    expect(new Set(applicability.edges.map(edge => `${edge.branchId}:${edge.producerId}`)).size).toBe(156)
    for (const edge of applicability.edges) {
      if (edge.applicability === 'source-backed-not-applicable') {
        expect(edge.executed).toBe(false)
        expect(edge.sourceRefs.length).toBeGreaterThan(0)
        expect(edge.explanation.length).toBeGreaterThan(0)
        expect(plan.cases.some(testCase => testCase.branchId === edge.branchId && testCase.producerId === edge.producerId)).toBe(false)
      } else expect(plan.cases.some(testCase => testCase.branchId === edge.branchId && testCase.producerId === edge.producerId)).toBe(true)
    }
    expect(new Set(plan.cases.filter(testCase => testCase.route === 'supplemental-direct-adapter').map(testCase => testCase.branchId)).size).toBe(64)
  })

  const rows = plan.cases.flatMap(testCase => branchControlStatesR3.map(state => [`${testCase.id}:${state}`, testCase, state] as const))
  test.each(rows)('%s', async (_name, testCase, state) => { await exercise(testCase, state) }, 15_000)

  // Replacement environment is independently captured through every actual
  // prepared consumer variant, rather than inferred from merge helper tests.
  test.each(plan.companionCases.replacementEnvironmentHappy.map(testCase => [testCase.id, testCase] as const))('%s', async (_name, testCase) => {
    await exercise(testCase, 'happy', false)
  }, 15_000)

  test.each(plan.companionCases.unboundedParentHookHappy.map(testCase => [testCase.id, testCase] as const))('%s', async (_name, testCase) => {
    await exercise(testCase, 'happy')
  }, 15_000)

  test.each(plan.companionCases.successfulTransferredSurvivor.map(testCase => [testCase.id, testCase] as const))('%s', async (_name, selected) => {
    const fixture = createTerminalBranchFixtureR3(selected, 'happy')
    let result: unknown
    let failure: unknown
    let outcome: 'passed' | 'failed' = 'failed'
    let survivorObserved = false
    let finiteCapObserved = false
    try {
      result = await fixture.runSdk(sdkProgram())
      const inputs = targetInputs(fixture)
      assertHappyCapture(fixture, result, inputs)
      const input = inputs[0]
      const call = fixture.processRecorder.calls.find(entry => entry.launchId === input.facts.launchId)
      if (!call || !call.resourceSignal) throw new Error('Transferred resource has no captured Node resource signal')
      expect(fixture.hosts[0].rootSignal.aborted).toBe(true)
      expect(call.closed).toBe(false)
      expect(call.resourceSignal.aborted).toBe(false)
      const originalExpiry = deadlineMsR3(input.facts.deadlines.resourceLifetime)
      expect(originalExpiry).not.toBeNull()
      fixture.stop.abort(new Error('Successful sender has completed; resource remains receiver-owned'))
      expect(call.resourceSignal.aborted).toBe(false)
      expect(call.closed).toBe(false)
      survivorObserved = true
      expect(deadlineMsR3(input.facts.deadlines.resourceLifetime)).toBe(originalExpiry)
      fixture.exhaust()
      expect(call.resourceSignal.aborted).toBe(true)
      expect(call.requestedSignals).toContain('SIGKILL')
      finiteCapObserved = true
      expect(fixture.processRecorder.calls.filter(entry => entry.launchId === input.facts.launchId)).toHaveLength(1)
      outcome = 'passed'
    } catch (error) {
      failure = error
      throw error
    } finally {
      fixture.persist({ result, controlCoverage: { successfulTransferredResourceSurvivesSender: survivorObserved,
        retainedFiniteCap: finiteCapObserved, osProcessSurvivalCertified: false } }, outcome, failure)
      fixture.dispose()
    }
  }, 15_000)
})
