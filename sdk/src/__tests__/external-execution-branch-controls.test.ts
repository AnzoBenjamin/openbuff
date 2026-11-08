import { describe, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { browserLogs } from '../tools/browser-logs'
import { inspect3dAsset } from '../tools/3d-assets'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { isSupervisedSpawnSelfExecMode, resolveSupervisedChildEntryPath } from '@codebuff/agent-runtime/supervision/supervised-spawn'
import { runClientMcpControl } from './fixtures/external-branch-run-client'
import {
  BASE_CONTROLS, BLENDER_BRANCHES, CHROME_BRANCHES, controlFixture,
  runBlenderBranch, runChromeBranch, runMcpBranch, runMcpRequestIsolation, runMcpStartupWaiterIsolation, runSupervisedBranch,
} from './fixtures/external-branch-controls'
import type { BranchFixture, Control } from './fixtures/external-branch-controls'

// Prepared R3 controls. Execution requires the root's successor freeze and
// authorization. Synthetic boundary observations are not OS process evidence.
const REPO = path.resolve(import.meta.dir, '../../..')
const EVIDENCE = path.join(REPO, 'docs/execution/body-roadmap/evidence/B19/implementation/branch-controls-r3/external')
const SOURCES = [
  'sdk/src/__tests__/external-execution-branch-controls.test.ts',
  'sdk/src/__tests__/fixtures/external-branch-controls.ts',
  'sdk/src/__tests__/fixtures/external-branch-mcp-server.cjs',
  'sdk/src/__tests__/fixtures/external-branch-run-client.ts',
  'sdk/src/__tests__/fixtures/external-branch-compiled-entry.ts',
  'sdk/src/run.ts', 'sdk/src/client.ts',
  'sdk/src/custom-tool.ts', 'common/src/templates/agent-validation.ts',
  'sdk/src/host-execution.ts', 'sdk/src/host-config.ts', 'sdk/src/services/run-mcp-execution.ts',
  'sdk/src/tools/browser-logs.ts', 'sdk/src/tools/3d-assets.ts',
  'common/src/util/execution-context.ts', 'common/src/mcp/client.ts', 'common/src/mcp/stdio-transport.ts',
  'packages/agent-runtime/src/supervision/supervised-spawn.ts',
  'packages/agent-runtime/src/supervision/process-supervisor.ts',
  'packages/agent-runtime/src/supervision/child-entry.ts',
  'packages/agent-runtime/src/run-agent-step.ts', 'packages/agent-runtime/src/tools/tool-executor.ts',
  'packages/agent-runtime/src/run-programmatic-step.ts',
] as const
type Case = { producer: string; matrixBranch: string; runtimeBranch: string; control: string; evidenceKind?: string }
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
let invocationHashes: { sourceHashes: Record<string, string>; toolchain: object } | undefined
function captureInvocationHashes() {
  return invocationHashes ??= {
    sourceHashes: Object.fromEntries(SOURCES.map(file => [file, digest(path.join(REPO, file))])),
    toolchain: { executable: process.execPath, sha256: digest(process.execPath), bun: Bun.version, platform: process.platform },
  }
}

function writeEvidence(meta: Case, f: BranchFixture, result: unknown, failure: unknown) {
  if (!process.env.B19_EXTERNAL_EVIDENCE_DIR) return
  if (path.resolve(process.env.B19_EXTERNAL_EVIDENCE_DIR) !== EVIDENCE)
    throw new Error('B19_EXTERNAL_EVIDENCE_DIR must name this lane\'s explicitly owned evidence directory')
  mkdirSync(EVIDENCE, { recursive: true })
  const id = `${meta.producer}--${meta.matrixBranch}--${meta.control}`
  writeFileSync(path.join(EVIDENCE, `${id}.json`), JSON.stringify({
    schemaVersion: 1, caseId: id, ...meta, status: failure ? 'failed' : 'passed',
    evidenceKind: meta.evidenceKind ?? 'actual-consumer-with-synthetic-process-boundary',
    ...captureInvocationHashes(),
    capturedConfigurationSnapshotId: f.snapshot.snapshotId,
    cancellationScope: f.control === 'delayed-authorizer-cancellation' ? f.cancellationScope : 'request',
    request: { aborted: f.context.signal?.aborted, originalActionExpiryMs: 1100 },
    boundaryCalls: f.calls.map(({ signal, ...call }) => ({ ...call,
      signalPresent: signal !== undefined, signalAbortedAtCaptureEnd: signal?.aborted,
      identicalToRequestSignal: signal === f.context.signal,
      resourceSignalVisibility: signal ? 'actual-node-spawn-options' : 'not-exposed-by-settle-spawn-seam',
    })),
    actualBoundaryCallCount: f.calls.length,
    targetBoundaryCallCount: f.calls.filter(call => call.branch === meta.runtimeBranch).length,
    authorizerInputs: f.policyInputs,
    genuineHostEvents: f.host.events,
    authorityCorrelation: 'Launch/owner/resource/generation/request/lease/binding and decision IDs are genuine host facts; opaque permit handles are not exposed by these consumers.',
    consumerResult: result, settledConsumerResults: f.consumerResults, failure,
    chromePeerEvents: f.chromePeerEvents,
    limitations: ['No SDK run.ts callback-edge proof', 'Synthetic PIDs do not prove OS process existence or death',
      'No OS containment, compiled self-exec, B20/B21/B25/B28/B29 completeness, independent approval, or candidate acceptance'],
  }, (_key, item) => item instanceof Error ? { ...item, name: item.name, message: item.message } : item, 2) + '\n')
}

async function drainBoundaryContinuations() {
  await new Promise<void>(resolve => setImmediate(resolve))
  await new Promise<void>(resolve => setImmediate(resolve))
}

function firstJson(result: unknown): Record<string, unknown> {
  if (!Array.isArray(result)) throw new Error('Expected a consumer tool result array')
  const entry = result.find(item => item?.type === 'json')
  if (!entry?.value || typeof entry.value !== 'object') throw new Error('Expected consumer JSON result')
  return entry.value
}

function assertMcpSuccess(intent: 'discovery' | 'call', result: unknown, text = 'branch-mcp-reply') {
  expect(result).not.toBeInstanceOf(Error)
  if (intent === 'discovery') expect(result).toMatchObject({ complete: true })
  else expect(result).toEqual([{ type: 'json', value: {
    schemaVersion: 1, kind: 'mcp_tool_result', content: [{ type: 'text', text }],
  } }])
}

function assertCapturedBoundary(f: BranchFixture) {
  for (const call of f.calls) {
    const admission = f.policyInputs.find(input => input.facts.launchId === call.launchId)
    expect(admission).toBeDefined()
    if (!admission) throw new Error('No real authorization for captured boundary')
    expect(call.executable).toBe(admission.target.executable)
    expect(call.argv).toEqual(admission.target.argv)
    expect(call.cwd).toBe(admission.target.cwd)
    expect(call.env.PATH).toBe('/usr/bin:/bin')
    expect(call.env.HOME).toBe('/captured/home')
    expect(call.env.PROJECT_VALUE).toBe('branch-ordinary')
    expect(call.env.OPENAI_API_KEY).toBeUndefined()
    expect(call.env.OPENBUFF_API_KEY).toBeUndefined()
    expect(call.env.CUSTOM_PROVIDER_KEY).toBeUndefined()
    expect(admission.facts.configurationSnapshotId).toBe(f.snapshot.snapshotId)
    expect(admission.facts.environment.entryCount).toBe(Object.keys(call.env).length)
    expect(admission.facts.executionBindingVersion).toBe(2)
    expect(admission.bindingDigest).toBe(admission.facts.executionBindingDigest)
    expect(admission.classification.invocationKind).toBe('argv')
    for (const key of ['ownerId', 'resourceId', 'resourceGeneration', 'requestId', 'leaseId', 'destinationId'] as const)
      expect(admission.facts[key].length).toBeGreaterThan(0)
    const events = f.host.events.filter(event => 'facts' in event && event.facts.launchId === call.launchId)
    expect(events.map(event => event.phase)).toContain('admitted')
    expect(events.map(event => event.phase)).toContain('dispatched')
    const observed = events.some(event => event.phase === 'spawn-observed')
    expect(observed || events.some(event => event.phase === 'dispatch-failed')).toBe(true)
    if (call.observerMethods) expect(call.observerMethods).toEqual(['failure', 'spawnObserved'])
    else expect(call.signal).toBeInstanceOf(AbortSignal)
  }
  for (const event of f.host.events) {
    if (!('facts' in event)) continue
    const facts = event.facts
    expect(facts.configurationSnapshotId).toBe(f.snapshot.snapshotId)
    if (facts.correlation.kind === 'action') {
      expect(facts.deadlines.action.kind).toBe('finite')
      if (facts.deadlines.action.kind === 'finite') expect(facts.deadlines.action.expiresAtMs).toBe(1100)
      if (facts.deadlines.requestAdmission.kind === 'finite') expect(facts.deadlines.requestAdmission.expiresAtMs).toBeLessThanOrEqual(1100)
    }
    if (['planned', 'admitted', 'dispatched', 'no-launch'].includes(event.phase)) expect(facts.profile.active).toBeNull()
    if (event.phase === 'spawn-observed') expect(facts.profile.active).not.toBeNull()
    expect(facts.profile.enforced.some(item => item.capability === 'process-tree-containment' && item.status === 'enforced')).toBe(false)
  }
  expect(JSON.stringify(f.host.events)).not.toContain('branch-sentinel')
}

async function executeCase(meta: Case, f: BranchFixture, run: () => Promise<unknown>, verify: () => void) {
  let result: unknown, failure: unknown
  try {
    result = await run()
    await drainBoundaryContinuations()
    assertCapturedBoundary(f)
    verify()
  } catch (error) { failure = error; throw error }
  finally { try { writeEvidence(meta, f, result, failure) } finally { f.close() } }
  return result
}

function assertLaunchControl(f: BranchFixture, expectedCalls: string[]) {
  expect(f.calls.map(call => call.branch)).toEqual(expectedCalls)
  if (['happy', 'denied', 'unavailable', 'delayed-authorizer-cancellation'].includes(f.control))
    expect(f.authorizations.some(facts => facts.branchId === f.targetBranch)).toBe(true)
  const targetEvents = f.host.events.filter(event => 'facts' in event && event.facts.branchId === f.targetBranch)
  if (f.control !== 'happy') {
    expect(targetEvents.some(event => event.phase === 'dispatched' || event.phase === 'spawn-observed')).toBe(false)
    if (f.control === 'denied' || f.control === 'unavailable') {
      const refusal = targetEvents.find(event => event.phase === 'no-launch')
      expect(refusal?.phase === 'no-launch' ? refusal.refusal.reason : undefined).toBe(f.control)
    }
  }
}

describe('B19 R3 actual external branch consumers', () => {
  for (const branch of BLENDER_BRANCHES) {
    const later = branch === 'blender.validate'
    const controls: readonly Control[] = later ? [...BASE_CONTROLS, 'exhausted-before-later-branch'] : BASE_CONTROLS
    for (const control of controls) test(`sdk.blender ${branch} ${control}`, async () => {
      const f = controlFixture(branch, control, later)
      await executeCase({ producer: 'sdk.blender', matrixBranch: branch, runtimeBranch: branch, control }, f,
        async () => {
          const result = await runBlenderBranch(f, branch)
          const consumer = firstJson(result)
          if (control === 'happy') {
            if (branch === 'blender.edit' || branch === 'blender.validate') {
              expect(consumer.outcome).toBe('not_applied')
              expect(consumer.executionRefusal).toBeUndefined()
            } else expect(consumer.error).toBeUndefined()
          }
          return result
        }, () => {
          const expected = later ? ['blender.edit'] : []
          if (control === 'happy') {
            expected.push(branch)
            if (branch === 'blender.edit') expected.push('blender.validate')
          }
          assertLaunchControl(f, expected)
        })
    })
  }

  for (const branch of CHROME_BRANCHES) {
    const later = branch !== 'chrome.probe'
    const controls: readonly Control[] = later ? [...BASE_CONTROLS, 'exhausted-before-later-branch'] : BASE_CONTROLS
    for (const control of controls) test(`sdk.chrome ${branch} ${control}`, async () => {
      const f = controlFixture(branch, control, later, later ? 'root-resource-lifetime' : 'request')
      await executeCase({ producer: 'sdk.chrome', matrixBranch: branch, runtimeBranch: branch, control }, f,
        async () => {
          const result = await runChromeBranch(f, branch)
          expect(firstJson(result).success).toBe(control === 'happy')
          return result
        }, () => {
          const expected = later ? ['chrome.probe'] : []
          if (control === 'happy') { expected.push(branch); if (!later) expected.push('chrome.pipe') }
          assertLaunchControl(f, expected)
        })
    }, 10_000)
  }

  for (const retry of [false, true]) {
    const branch = `supervised.source.${retry ? 'retry' : 'initial'}`
    const controls: readonly Control[] = retry ? [...BASE_CONTROLS, 'exhausted-before-later-branch'] : BASE_CONTROLS
    for (const control of controls) test(`sdk.supervision ${branch} ${control}`, async () => {
      const f = controlFixture(branch, control, retry)
      await executeCase({ producer: 'sdk.supervision', matrixBranch: branch, runtimeBranch: branch, control }, f,
        async () => {
          const result = await runSupervisedBranch(f, retry)
          if (control === 'happy') expect(result).toMatchObject({ outcome: 'ok', receipt: { status: 'completed' } })
          return result
        }, () => {
          const expected = retry ? ['supervised.source.initial'] : []
          if (control === 'happy') expected.push(branch)
          assertLaunchControl(f, expected)
          if (retry) {
            const initial = f.calls[0]!
            const events = f.host.events.filter(event => 'facts' in event && event.facts.launchId === initial.launchId)
            expect(events.some(event => event.phase === 'spawn-observed')).toBe(false)
            expect(events.some(event => event.phase === 'dispatch-failed')).toBe(true)
            if (control === 'happy') {
              expect(f.calls[1]!.launchId).not.toBe(initial.launchId)
              expect(f.calls[1]!.cwd).not.toBe(initial.cwd)
            }
          }
          for (const call of f.calls) expect(call.argv[0]).toBe('--no-env-file')
        })
    })
  }

  for (const intent of ['discovery', 'call'] as const) {
    const producer = intent === 'discovery' ? 'sdk.mcp-discovery' : 'sdk.mcp-call'
    const matrixBranch = intent === 'discovery' ? 'mcp.discovery-start' : 'mcp.call-start'
    for (const control of BASE_CONTROLS) test(`${producer} ${matrixBranch} ${control}`, async () => {
      const f = controlFixture('mcp.initial-connect', control, false, 'root-resource-lifetime')
      await executeCase({ producer, matrixBranch, runtimeBranch: 'mcp.initial-connect', control }, f,
        async () => {
          const result = await runMcpBranch(f, intent)
          if (control === 'happy') assertMcpSuccess(intent, result.result)
          else expect(result.result).toBeInstanceOf(Error)
          return result
        }, () => assertLaunchControl(f, control === 'happy' ? ['mcp.initial-connect'] : []))
    })

    for (const control of [...BASE_CONTROLS, 'exhausted-before-later-branch'] as const) test(`${producer} mcp.reuse ${control}`, async () => {
      const f = controlFixture('mcp.reuse', control, true)
      await executeCase({ producer, matrixBranch: 'mcp.reuse', runtimeBranch: 'mcp.reuse', control }, f,
        async () => {
          const result = await runMcpBranch(f, intent)
          if (control === 'happy') assertMcpSuccess(intent, result.result)
          else expect(result.result).toBeInstanceOf(Error)
          return result
        }, () => {
          expect(f.calls.map(call => call.branch)).toEqual(['mcp.initial-connect'])
          const reuse = f.host.events.filter(event => event.phase === 'resource-reused')
          expect(reuse).toHaveLength(control === 'happy' ? 1 : 0)
          if (['happy', 'denied', 'unavailable', 'delayed-authorizer-cancellation'].includes(control))
            expect(f.authorizations.some(facts => facts.branchId === 'mcp.reuse')).toBe(true)
          if (control === 'happy') {
            const observed = f.host.events.find(event => event.phase === 'spawn-observed')
            expect(observed?.phase).toBe('spawn-observed')
            if (observed?.phase === 'spawn-observed' && reuse[0]?.phase === 'resource-reused') {
              expect(reuse[0].originalLaunchId).toBe(observed.facts.launchId)
              expect(reuse[0].processObservationId).toBe(observed.processObservationId)
              expect(reuse[0].facts.resourceGeneration).toBe(observed.facts.resourceGeneration)
              expect(reuse[0].facts.leaseId).not.toBe(observed.facts.leaseId)
            }
          }
        })
    })

    test(`${producer} real.mcp-env captured destination`, async () => {
      const f = controlFixture('mcp.initial-connect', 'happy')
      await executeCase({ producer, matrixBranch, runtimeBranch: 'mcp.initial-connect', control: 'real-mcp-env',
        evidenceKind: 'real-local-node-stdio-peer-through-owned-transport' }, f,
      async () => {
        const observed = await runMcpBranch(f, intent, true)
        assertMcpSuccess(intent, observed.result, 'branch-mcp-peer')
        expect(observed.peer.env).toEqual(f.calls[0]!.env)
        expect(observed.peer.env.PROJECT_VALUE).toBe('branch-ordinary')
        expect(observed.peer.env.OPENAI_API_KEY).toBeUndefined()
        expect(observed.peer.env.CUSTOM_PROVIDER_KEY).toBeUndefined()
        expect(observed.sameCaptureAfterMutation).toBe(true)
        expect(f.calls[0]!.argv).not.toContain('caller-mutated-after-capture')
        const event = f.host.events.find(event => event.phase === 'spawn-observed')
        expect(event?.phase === 'spawn-observed' ? event.pid : undefined).toBe(observed.peer.pid)
        return observed
      }, () => assertLaunchControl(f, ['mcp.initial-connect']))
    }, 10_000)

    test(`${producer} request cancellation preserves another lease`, async () => {
      const f = controlFixture('mcp.initial-connect', 'happy')
      await executeCase({ producer, matrixBranch: 'mcp.reuse', runtimeBranch: 'mcp.reuse', control: 'request-versus-resource-lifetime' }, f,
        async () => {
          const result = await runMcpRequestIsolation(f, intent)
          assertMcpSuccess(intent, result.result)
          expect(result.firstId).toBe(result.secondId)
          expect(result.cancelledResult).not.toBe('unexpected-success')
          expect(result.requesterAborted).toBe(true)
          expect(result.actualResourceSignalAborted).toBe(false)
          expect(result.distinctRequestAndResourceSignals).toBe(true)
          return result
        }, () => {
          expect(f.calls).toHaveLength(1)
          expect(f.host.events.filter(event => event.phase === 'spawn-observed')).toHaveLength(1)
          expect(f.host.events.some(event => event.phase === 'resource-reused')).toBe(true)
        })
    })

    test(`${producer} delayed authorizer waiter cancellation preserves startup for another lease`, async () => {
      const f = controlFixture('mcp.initial-connect', 'delayed-authorizer-cancellation')
      await executeCase({ producer, matrixBranch, runtimeBranch: 'mcp.initial-connect', control: 'delayed-authorizer-waiter-only-cancellation' }, f,
        async () => {
          const result = await runMcpStartupWaiterIsolation(f, intent)
          assertMcpSuccess(intent, result.result)
          expect(result.firstRefused).toBe(true)
          expect(result.requesterAborted).toBe(true)
          expect(result.resourceAborted).toBe(false)
          return result
        }, () => {
          expect(f.calls.map(call => call.branch)).toEqual(['mcp.initial-connect'])
          expect(f.host.events.filter(event => event.phase === 'spawn-observed')).toHaveLength(1)
          expect(f.host.events.some(event => event.phase === 'resource-reused')).toBe(true)
        })
    })
  }

  test('missing Blender context is separate from branch admission controls', async () => {
    const f = controlFixture('blender.inspect-blend', 'happy')
    const legacy = spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('Unexpected legacy Node launch') })
    try {
      await executeCase({ producer: 'sdk.blender', matrixBranch: 'blender.inspect-blend', runtimeBranch: 'blender.inspect-blend', control: 'missing-context',
        evidenceKind: 'actual-consumer-missing-context-with-legacy-node-spawn-spy' }, f,
        async () => {
          const result = await inspect3dAsset({ path: 'scene.blend', cwd: f.root, fs: createNodeFileSystem() })
          expect(firstJson(result).executionRefusal).toMatchObject({ reason: 'unavailable' })
          return result
        }, () => {
          expect(legacy).not.toHaveBeenCalled()
          expect(f.calls).toHaveLength(0)
          expect(f.host.events).toHaveLength(0)
        })
    } finally { legacy.mockRestore() }
  })

  test('missing Chrome context is separate from branch admission controls', async () => {
    const f = controlFixture('chrome.probe', 'happy')
    const legacy = spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('Unexpected legacy Node launch') })
    try {
      await executeCase({ producer: 'sdk.chrome', matrixBranch: 'chrome.probe', runtimeBranch: 'chrome.probe', control: 'missing-context',
        evidenceKind: 'actual-consumer-missing-context-with-legacy-node-spawn-spy' }, f,
        async () => {
          const result = await browserLogs({ type: 'snapshot' }, `missing-context:${f.root}`)
          expect(firstJson(result).success).toBe(false)
          return result
        }, () => {
          expect(legacy).not.toHaveBeenCalled()
          expect(f.calls).toHaveLength(0)
          expect(f.host.events).toHaveLength(0)
        })
    } finally { legacy.mockRestore() }
  })
})

describe('B19 R3 successor actual OpenbuffClient.run MCP producer edges', () => {
  for (const edge of ['discovery-start', 'discovery-reuse', 'call-start', 'call-reuse'] as const) {
    const controls: readonly Control[] = edge === 'discovery-start' ? BASE_CONTROLS : [...BASE_CONTROLS, 'exhausted-before-later-branch']
    for (const control of controls) test(`actual-sdk-run ${edge} ${control}`, async () => {
      const producer = edge.startsWith('discovery') ? 'sdk.mcp-discovery' : 'sdk.mcp-call'
      const matrixBranch = edge.endsWith('reuse') ? 'mcp.reuse' : edge === 'discovery-start' ? 'mcp.discovery-start' : 'mcp.call-start'
      const observed = await runClientMcpControl(edge, control)
      let failure: unknown
      try {
        expect(observed.error).toBeUndefined()
        expect(observed.networkAttempts).toBe(0)
        const boundaries = observed.boundaryCalls.filter(call => call.family === 'mcp-stdio')
        expect(boundaries).toHaveLength(edge === 'discovery-start' ? (control === 'happy' ? 1 : 0) : edge === 'call-start' && control === 'happy' ? 2 : 1)
        if (['happy', 'denied', 'unavailable', 'delayed-authorizer-cancellation'].includes(control))
          expect(observed.targetAuthorizations.length).toBeGreaterThan(0)
        if (boundaries.length) {
          expect(observed.hostCount).toBe(1)
          expect(observed.serviceSnapshots).toEqual(observed.hostSnapshotIds)
          for (const call of boundaries) {
            expect(call.executable).toBe('/fixture/run-mcp-peer')
            expect(call.argv).toEqual([])
            expect(call.env.PROJECT_VALUE).toBe('run-captured-public')
            expect(call.env.OPENAI_API_KEY).toBeUndefined()
            expect(call.env.CUSTOM_PROVIDER_KEY).toBeUndefined()
            expect(call.resourceSignalPresent).toBe(true)
            expect(call.signalEqualsRunRequest).toBe(false)
            expect(observed.authorizations.some(input => input.facts.launchId === call.launchId &&
              input.facts.configurationSnapshotId === observed.hostSnapshotIds[0])).toBe(true)
          }
        }
        const mcpEvents = observed.events.filter(event => 'facts' in event && event.facts.family === 'mcp-stdio')
        const targetIds = new Set(observed.targetAuthorizations.map(input => input.facts.launchId))
        const targetEvents = mcpEvents.filter(event => 'facts' in event && targetIds.has(event.facts.launchId))
        if (control !== 'happy') expect(targetEvents.some(event => ['dispatched', 'spawn-observed', 'resource-reused'].includes(event.phase))).toBe(false)
        if (edge.endsWith('start') && (control === 'denied' || control === 'unavailable'))
          expect(targetEvents.some(event => event.phase === 'no-launch' && event.refusal.reason === control)).toBe(true)
        for (const event of mcpEvents) if (event.phase === 'no-launch') expect(event.facts.profile.active).toBeNull()
        const calls = observed.peerMessages.filter(message => message.method === 'tools/call')
        expect(calls).toHaveLength(edge === 'call-reuse' && control === 'happy' ? 2 : 0)
        if (control === 'happy') {
          expect(observed.generatorEntered).toBe(true)
          expect(observed.checkpoints).toHaveLength(1)
          expect(observed.checkpoints[0]).toMatchObject({ edge, control, closedDiscoveryPeer: edge === 'call-start' })
          expect(observed.result?.output.type).toBe('structuredOutput')
          expect(observed.serviceRequests.some(request => (request.correlation as { kind?: string }).kind === 'host-operation')).toBe(true)
          if (edge.startsWith('call')) expect(observed.serviceRequests.some(request => (request.correlation as { kind?: string }).kind === 'action')).toBe(true)
          if (edge === 'call-start') {
            expect(JSON.stringify(observed.result)).toContain('MCP tool catalog changed before dispatch')
            const starts = mcpEvents.filter(event => event.phase === 'spawn-observed')
            expect(starts).toHaveLength(2)
            if (starts[0]?.phase === 'spawn-observed' && starts[1]?.phase === 'spawn-observed')
              expect(starts[1].facts.resourceGeneration).not.toBe(starts[0].facts.resourceGeneration)
          }
          if (edge === 'call-reuse') {
            const uses = mcpEvents.filter(event => event.phase === 'resource-reused' && event.facts.correlation.kind === 'action')
            expect(uses).toHaveLength(2)
            for (const use of uses) if (use.phase === 'resource-reused' && use.facts.correlation.kind === 'action') {
              const correlation = use.facts.correlation
              expect(observed.result?.actionOutcomes?.some(action => action.actionId === correlation.actionId && action.attemptId === correlation.attemptId)).toBe(true)
            }
          }
        }
      } catch (error) { failure = error; throw error }
      finally {
        if (process.env.B19_EXTERNAL_EVIDENCE_DIR) {
          if (path.resolve(process.env.B19_EXTERNAL_EVIDENCE_DIR) !== EVIDENCE) throw new Error('Evidence path is outside this lane')
          const directory = path.join(EVIDENCE, 'run-client')
          mkdirSync(directory, { recursive: true })
          writeFileSync(path.join(directory, `${edge}--${control}.json`), JSON.stringify({
            schemaVersion: 1, producer, matrixBranch, runtimeBranch: edge.endsWith('reuse') ? 'mcp.reuse' : 'mcp.initial-connect',
            status: failure ? 'failed' : 'passed', evidenceKind: 'actual-openbuff-client-run-with-call-through-capture-and-policy-spies',
            ...captureInvocationHashes(), observed, failure,
            limits: ['Synthetic MCP boundary; helper Node processes are separately listed',
              'Call-start after dead discovery transport preserves the actual stale-catalog refusal',
              'No replacement run host, action authority, MCP service, runtime loop, or tool-call callback',
              'No complete MCP lifecycle, OS containment, independent approval, or candidate acceptance claim'],
          }, (_key, item) => item instanceof Error ? { ...item, name: item.name, message: item.message } : item, 2) + '\n')
        }
      }
    }, 15_000)
  }

  test('source mode cannot establish supervised self-exec branches', () => {
    expect(isSupervisedSpawnSelfExecMode()).toBe(false)
    expect(resolveSupervisedChildEntryPath()).not.toContain('$bunfs')
    expect(resolveSupervisedChildEntryPath()).not.toContain('~BUN')
  })
})
