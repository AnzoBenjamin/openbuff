import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { runSdkChromeControl, SDK_CHROME_BRANCHES, SDK_CHROME_CONTROLS } from './fixtures/b19-chrome-sdk-branch-controls'
import type { SdkChromeControl } from './fixtures/b19-chrome-sdk-branch-controls'

// Prepared source only until the root freezes and authorizes a successor.
// Selected-policy DI is explicit evidence; synthetic Chrome PIDs are not OS proof.
const REPO = path.resolve(import.meta.dir, '../../..')
const EVIDENCE = path.join(REPO, 'docs/execution/body-roadmap/evidence/B19/implementation/chrome-sdk-branch-controls-r1')
const SOURCES = [
  'sdk/src/__tests__/chrome-sdk-execution-branch-controls.test.ts',
  'sdk/src/__tests__/fixtures/b19-chrome-sdk-branch-controls.ts',
  'sdk/src/client.ts', 'sdk/src/run.ts', 'sdk/src/custom-tool.ts',
  'sdk/src/host-execution.ts', 'sdk/src/host-config.ts', 'sdk/src/services/harness-enforcement.ts',
  'sdk/src/services/execution-launch.ts',
  'sdk/src/tools/browser-logs.ts', 'common/src/util/execution-context.ts',
  'common/src/types/contracts/execution-context.ts', 'common/src/templates/agent-validation.ts',
  'packages/agent-runtime/src/run-programmatic-step.ts', 'packages/agent-runtime/src/run-agent-step.ts',
  'packages/agent-runtime/src/tools/tool-executor.ts',
] as const
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
let invocation: { sourceHashes: Record<string, string>; toolchain: object } | undefined
function invocationHashes() {
  return invocation ??= { sourceHashes: Object.fromEntries(SOURCES.map(file => [file, digest(path.join(REPO, file))])),
    toolchain: { executable: process.execPath, sha256: digest(process.execPath), bun: Bun.version, platform: process.platform } }
}
type Observation = Awaited<ReturnType<typeof runSdkChromeControl>>

function jsonValue(result: unknown): Record<string, unknown> {
  if (!Array.isArray(result)) throw new Error('Real browser consumer did not return a tool-result array')
  const item = result.find(entry => entry?.type === 'json')
  if (!item?.value || typeof item.value !== 'object') throw new Error('Real browser consumer did not return JSON')
  return item.value
}

function assertSdkProducer(observed: Observation) {
  expect(observed.error).toBeUndefined()
  expect(observed.networkAttempts).toBe(0)
  expect(observed.result).toBeDefined()
  expect(observed.syntheticChromeChildrenClosed).toBe(observed.syntheticChromeChildren)
  const intakeRefusal = observed.control === 'deadline-zero' ||
    observed.branch === 'chrome.probe' && observed.control === 'pre-aborted'
  if (intakeRefusal) {
    expect(observed.checkpointEntered).toBe(false)
    expect(observed.entries).toHaveLength(0)
    expect(observed.boundaryCalls).toHaveLength(0)
    expect(observed.policyInputs).toHaveLength(0)
    expect(observed.events).toHaveLength(0)
    expect(observed.hostCaptures).toHaveLength(0)
    expect(observed.hostCount).toBe(0)
    expect(observed.authorityCount).toBe(0)
    expect(observed.result?.runOutcome?.termination).toBe(observed.control === 'deadline-zero' ? 'deadline_exhausted' : 'cancelled')
    if (observed.control === 'deadline-zero') {
      expect(observed.runTimeoutMs).toBe(0)
      expect(observed.result?.runOutcome?.cause?.code).toBe('execution_deadline-exhausted')
    }
    return
  }

  expect(observed.hostCount).toBe(1)
  expect(observed.authorityCount).toBe(1)
  expect(observed.hostCaptures).toHaveLength(1)
  expect(observed.checkpointEntered).toBe(true)
  expect(observed.entries).toHaveLength(1)
  const entry = observed.entries[0]!
  expect(entry.action).toBe('snapshot')
  expect(entry.registered).toBe(true)
  expect(entry.resourceFactoryPresent).toBe(true)
  expect(entry.executablePath).toBe(observed.executable)
  expect(entry.projectRoot).toBe(observed.root)
  expect(entry.signalAbortedAtEntry).toBe(false)
  expect(typeof entry.owner).toBe('object')
  expect(entry.correlation?.kind).toBe('action')
  if (entry.correlation?.kind !== 'action' || typeof entry.owner !== 'object')
    throw new Error('SDK callback did not supply its real action and trusted browser owner')
  expect(entry.owner).toEqual({ ...entry.correlation.owner, projectRoot: observed.root })
  expect(JSON.stringify(entry.owner)).not.toContain('forged-')
  expect(entry.initialActionDeadline?.kind).toBe('finite')
  if (entry.initialActionDeadline?.kind === 'finite') {
    const rootDeadline = observed.hostCaptures[0]!.boundary.deadline
    expect(rootDeadline.kind).toBe('finite')
    if (rootDeadline.kind === 'finite') expect(entry.initialActionDeadline.expiresAtMs).toBeLessThanOrEqual(rootDeadline.expiresAtMs)
  }
  expect(observed.printEvents.some(event => event.type === 'tool_call' && event.toolName === 'browser_logs')).toBe(true)

  for (const call of observed.boundaryCalls) {
    // Earlier SDK Git processes are recorded independently and must themselves
    // have real launch authority; a previous Chrome event cannot explain them.
    expect(call.launchId).toBeDefined()
    const input = observed.policyInputs.find(item => item.facts.launchId === call.launchId)
    expect(input).toBeDefined()
    if (!input) throw new Error('SDK process boundary has no matching genuine policy input')
    expect(call.executable).toBe(input.target.executable)
    expect(call.argv).toEqual(input.target.argv)
    expect(call.cwd).toBe(input.target.cwd)
    expect(call.env.PROJECT_VALUE).toBe('sdk-chrome-captured-public')
    expect(call.env.CHROME_PATH).toBe(observed.executable)
    expect(call.env.OPENAI_API_KEY).toBeUndefined()
    expect(call.env.CUSTOM_PROVIDER_KEY).toBeUndefined()
    expect(call.signalPresent).toBe(true)
    expect(call.signalEqualsPublicRequest).toBe(false)
    expect(call.signalAbortedAtSpawn).toBe(false)
    expect(input.facts.configurationSnapshotId).toBe(observed.hostCaptures[0]!.snapshotId)
    expect(input.facts.executionBindingVersion).toBe(2)
    expect(input.facts.executionBindingDigest).toBe(input.bindingDigest)
    expect(input.facts.environment.entryCount).toBe(Object.keys(call.env).length)
    for (const key of ['launchId', 'ownerId', 'resourceId', 'resourceGeneration', 'leaseId', 'requestId', 'destinationId'] as const)
      expect(input.facts[key].length).toBeGreaterThan(0)
    const phases = observed.events.filter(event => 'facts' in event && event.facts.launchId === call.launchId).map(event => event.phase)
    expect(phases).toContain('admitted')
    expect(phases).toContain('dispatched')
    expect(phases).toContain('spawn-observed')
    if (call.family === 'chrome') {
      expect(call.executable).toBe(observed.executable)
      expect(input.facts.correlation).toEqual(entry.correlation)
      expect(input.target.processType).toBe(call.branch === 'chrome.probe' ? 'SYNC' : 'BACKGROUND')
      expect(input.classification.invocationKind).toBe('argv')
    }
  }
  const initialActionDeadline = entry.initialActionDeadline
  if (!initialActionDeadline) throw new Error('SDK callback is missing its authenticated action deadline')
  for (const event of observed.events) {
    if (!('facts' in event)) continue
    const facts = event.facts
    if (['planned', 'admitted', 'dispatched', 'no-launch'].includes(event.phase)) expect(facts.profile.active).toBeNull()
    if (event.phase === 'spawn-observed') expect(facts.profile.active).not.toBeNull()
    expect(facts.profile.enforced.some(item => item.capability === 'process-tree-containment' && item.status === 'enforced')).toBe(false)
    if (facts.family === 'chrome') {
      expect(facts.correlation).toEqual(entry.correlation)
      expect(facts.deadlines.action).toEqual(initialActionDeadline)
      if (facts.deadlines.action.kind === 'finite' && facts.deadlines.requestAdmission.kind === 'finite')
        expect(facts.deadlines.requestAdmission.expiresAtMs).toBeLessThanOrEqual(facts.deadlines.action.expiresAtMs)
    }
  }
  expect(JSON.stringify(observed.events)).not.toContain('sentinel')
}

function assertControl(observed: Observation) {
  const { branch, control } = observed
  const chromeCalls = observed.boundaryCalls.filter(call => call.family === 'chrome')
  const intakeRefusal = control === 'deadline-zero' || branch === 'chrome.probe' && control === 'pre-aborted'
  const expected: string[] = intakeRefusal || branch === 'chrome.probe' ? [] : ['chrome.probe']
  if (control === 'happy') expected.push(...(branch === 'chrome.probe' ? ['chrome.probe', 'chrome.pipe'] : [branch]))
  expect(chromeCalls.map(call => call.branch)).toEqual(expected)
  const targetEvents = observed.events.filter(event => 'facts' in event && event.facts.family === 'chrome' && event.facts.branchId === branch)
  if (control !== 'happy') expect(targetEvents.some(event => event.phase === 'dispatched' || event.phase === 'spawn-observed')).toBe(false)
  if (intakeRefusal) return
  if (['happy', 'denied', 'unavailable', 'delayed-authorizer-cancellation'].includes(control)) {
    const startupPolicies = observed.targetPolicies.filter(input => input.target.adapterOptions.resourceUseOperationDigest === undefined)
    const usePolicies = observed.targetPolicies.filter(input => input.target.adapterOptions.resourceUseOperationDigest !== undefined)
    const usesRunningBrowser = control === 'happy' && branch !== 'chrome.probe'
    expect(observed.targetPolicies).toHaveLength(usesRunningBrowser ? 2 : 1)
    expect(startupPolicies).toHaveLength(1)
    expect(usePolicies).toHaveLength(usesRunningBrowser ? 1 : 0)
    if (usesRunningBrowser) {
      const startup = startupPolicies[0]!, use = usePolicies[0]!
      const operationDigest = use.target.adapterOptions.resourceUseOperationDigest
      if (typeof operationDigest !== 'string') throw new Error('Browser reuse lacks its bound operation digest')
      expect(operationDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(use.target).toEqual({ ...startup.target,
        adapterOptions: { ...startup.target.adapterOptions, resourceUseOperationDigest: operationDigest } })
      for (const key of ['hostContextId', 'configurationSnapshotId', 'ownerId', 'resourceId', 'resourceGeneration', 'destinationId'] as const)
        expect(use.facts[key]).toBe(startup.facts[key])
      for (const key of ['launchId', 'requestId', 'leaseId', 'executionBindingDigest'] as const)
        expect(use.facts[key]).not.toBe(startup.facts[key])
      expect(use.facts.correlation).toEqual(startup.facts.correlation)
      expect(use.facts.environment).toEqual(startup.facts.environment)
      expect(use.facts.deadlines.action).toEqual(startup.facts.deadlines.action)
      expect(use.facts.deadlines.resourceLifetime).toEqual(startup.facts.deadlines.resourceLifetime)
      expect(targetEvents.map(event => event.phase)).toEqual(['planned', 'admitted', 'dispatched', 'spawn-observed', 'resource-reused'])
      const started = targetEvents.find(event => event.phase === 'spawn-observed')
      const reused = targetEvents.find(event => event.phase === 'resource-reused')
      if (started?.phase !== 'spawn-observed' || reused?.phase !== 'resource-reused')
        throw new Error('Browser startup and reuse must both have genuine lifecycle observations')
      expect(started.facts.launchId).toBe(startup.facts.launchId)
      expect(reused.facts.launchId).toBe(use.facts.launchId)
      expect(reused.originalLaunchId).toBe(started.facts.launchId)
      expect(reused.processObservationId).toBe(started.processObservationId)
      expect(reused.facts.resourceGeneration).toBe(started.facts.resourceGeneration)
      expect(reused.facts.profile.active).toEqual(started.facts.profile.active)
      expect(observed.boundaryCalls.filter(call => call.launchId === use.facts.launchId)).toHaveLength(0)
    }
  }
  if (control === 'happy') {
    expect(jsonValue(observed.entries[0]!.result)).toMatchObject({ success: true, action: 'snapshot', text: 'sdk-chrome-fixture' })
    expect(observed.result?.output.type).toBe('structuredOutput')
    const correlation = observed.entries[0]!.correlation
    if (correlation?.kind !== 'action') throw new Error('Missing real browser action')
    expect(observed.result?.actionOutcomes?.some(action => action.actionId === correlation.actionId && action.attemptId === correlation.attemptId)).toBe(true)
    expect(observed.peerMessages.some(message => message.branch === 'chrome.probe' && message.method === 'Target.getTargets')).toBe(true)
  } else {
    expect(jsonValue(observed.entries[0]!.result).success).toBe(false)
  }
  if (control === 'denied' || control === 'unavailable') {
    expect(targetEvents.some(event => event.phase === 'no-launch' && event.refusal.reason === control)).toBe(true)
  }
  if (control === 'delayed-authorizer-cancellation') {
    expect(observed.selectedPolicyCompleted).toBe(true)
    expect(targetEvents.some(event => event.phase === 'no-launch' && event.refusal.reason === 'cancelled')).toBe(true)
    expect(observed.result?.runOutcome?.termination).toBe('cancelled')
  }
  if (control === 'pre-aborted' || control === 'exhausted-before-later-branch') {
    expect(observed.transitionControls).toHaveLength(1)
    const transition = observed.transitionControls[0]!
    expect(transition.earlierChromeCalls).toBe(branch === 'chrome.probe' ? 0 : 1)
    expect(transition.earlierHelperCalls).toBe(observed.boundaryCalls.filter(call => call.family !== 'chrome').length)
    expect(transition.rootAborted).toBe(true)
    if (control === 'exhausted-before-later-branch') {
      if (branch === 'chrome.probe') expect(observed.targetPolicies).toHaveLength(1)
      expect(observed.runTimeoutMs).toBeGreaterThan(0)
      expect(transition.originalRootDeadline?.kind).toBe('finite')
      if (transition.originalRootDeadline?.kind === 'finite') {
        expect(transition.beforeMs).toBeLessThan(transition.originalRootDeadline.expiresAtMs)
        expect(transition.afterMs).toBeGreaterThan(transition.originalRootDeadline.expiresAtMs)
      }
      expect(observed.result?.runOutcome?.termination).toBe('deadline_exhausted')
    } else expect(observed.result?.runOutcome?.termination).toBe('cancelled')
  }
}

function writeEvidence(observed: Observation, failure: unknown) {
  if (!process.env.B19_CHROME_SDK_EVIDENCE_DIR) return
  const directory = path.resolve(process.env.B19_CHROME_SDK_EVIDENCE_DIR)
  const relative = path.relative(EVIDENCE, directory)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('B19_CHROME_SDK_EVIDENCE_DIR must remain inside the owned Chrome SDK R1 evidence directory')
  mkdirSync(directory, { recursive: true })
  const id = `sdk.chrome--${observed.branch}--${observed.control}`
  const artifact = path.join(directory, `${id}.json`)
  const { result, ...details } = observed
  const targetCalls = observed.boundaryCalls.filter(call => call.family === 'chrome' && call.branch === observed.branch)
  writeFileSync(artifact, JSON.stringify({ schemaVersion: 1, caseId: id,
    producer: 'sdk.chrome', selectedProducer: 'sdk/src/run.ts browser_logs callback', branch: observed.branch,
    control: observed.control, status: failure ? 'failed' : 'passed', ...invocationHashes(),
    evidenceKind: 'actual-sdk-producer-with-selected-policy-DI-and-synthetic-Chrome-boundary',
    targetBoundaryCount: targetCalls.length,
    earlierChromeHelperCount: observed.branch === 'chrome.probe' ? 0 :
      observed.boundaryCalls.filter(call => call.family === 'chrome' && call.branch === 'chrome.probe').length,
    otherChromeBoundaryCount: observed.boundaryCalls.filter(call => call.family === 'chrome' && call.branch !== observed.branch).length,
    sdkHelperBoundaryCount: observed.boundaryCalls.filter(call => call.family !== 'chrome').length,
    callbackReached: observed.entries.length > 0,
    zeroSemantics: observed.control === 'deadline-zero' ? 'literal-zero-at-public-SDK-intake' :
      observed.control === 'exhausted-before-later-branch' ? 'original-positive-parent-budget-spent' : undefined,
    observed: { ...details, result: result && { output: result.output, runOutcome: result.runOutcome, actionOutcomes: result.actionOutcomes } },
    failure,
    limitations: [
      'Denied, unavailable and delayed-authorizer cases inject only the selected policy decision; all other decisions delegate to the original host policy.',
      'Positive-budget exhaustion uses one advanced clock in the original domain and never rewrites captured deadlines.',
      'Literal-zero intake and pre-aborted probe intake intentionally do not reach the browser callback or selected branch.',
      'Chrome and CDP responses are synthetic; separately recorded SDK helper children use actual Node spawning.',
      'No OS process existence/death, containment, complete lifecycle, independent approval or candidate acceptance claim.',
    ],
  }, (_key, item) => item instanceof Error ? { ...item, name: item.name, message: item.message } : item, 2) + '\n', { flag: 'wx' })
  console.log(`B19_CHROME_SDK_CASE_EVIDENCE ${artifact}`)
}

describe('B19 actual OpenbuffClient.run Chrome producer controls', () => {
  for (const branch of SDK_CHROME_BRANCHES) {
    const controls: readonly SdkChromeControl[] = [...SDK_CHROME_CONTROLS, 'exhausted-before-later-branch']
    for (const control of controls) test(`sdk.chrome ${branch} ${control}`, async () => {
      invocationHashes()
      const observed = await runSdkChromeControl(branch, control)
      let failure: unknown
      try { assertSdkProducer(observed); assertControl(observed) }
      catch (error) { failure = error; throw error }
      finally { writeEvidence(observed, failure) }
    }, 15_000)
  }
})
