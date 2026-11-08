import { describe, expect, test } from 'bun:test'

import { inspectEnvironment } from '../tools/inspect-environment'
import { getBuildTargets } from '../tools/get-build-targets'
import { resolveOwningTargets } from '../services/build-graph'
import { runSemgrepBaseline } from '../services/semgrep-baseline'
import { executionLimitMs } from '../services/execution-launch'
import { branchStates, createToolchainBranchFixture, hasLaunchFacts, observeBranchCase } from './fixtures/toolchain-branch-authority'
import { createToolchainSdkConsumer } from './fixtures/toolchain-branch-sdk-client'
import type { BranchFixture } from './fixtures/toolchain-branch-authority'

const versionCommands = [
  ['git', '--version'], ['bun', '--version'], ['node', '--version'], ['python3', '--version'],
  ['rustc', '--version'], ['go', 'version'], ['k6', '--version'], ['cargo', '--version'],
  ['uv', '--version'], ['poetry', '--version'], ['mvn', '--version'], ['gradle', '--version'],
  ['dotnet', '--version'], ['blender', '--version'],
] as const

async function settled(call: () => unknown | Promise<unknown>) {
  try { return { ok: true, result: await call() } }
  catch (error) { return { ok: false, error: { name: (error as Error).name, message: String(error), refusal: (error as { refusal?: unknown }).refusal } } }
}

function assertExactEnvironment(fixture: BranchFixture) {
  for (const launch of fixture.spawns) {
    expect(launch.cwd).toBe(fixture.root)
    expect(launch.env?.PATH).toBe(fixture.binaryRoot)
    expect(launch.env?.PROJECT_VALUE).toBe('captured-public')
    for (const name of ['DELETE_ME', 'OPENAI_API_KEY', 'CUSTOM_PROVIDER_KEY', 'HOME']) expect(launch.env).not.toHaveProperty(name)
  }
  for (const child of fixture.readChildren()) {
    expect(child.kind).toBe('actual-node-child')
    expect(child.cwd).toBe(fixture.root)
    expect(Number.isInteger(child.pid) && Number(child.pid) > 0).toBe(true)
    expect(child.values).toEqual({ PATH: fixture.binaryRoot, PROJECT_VALUE: 'captured-public' })
  }
}

function assertBranch(fixture: BranchFixture, branchId: string, allowed: boolean, upstreamGate = false) {
  const events = fixture.events.filter(hasLaunchFacts).filter(event => event.facts.branchId === branchId)
  expect(events.some(event => event.phase === 'planned')).toBe(!upstreamGate)
  expect(events.filter(event => event.phase === 'dispatched')).toHaveLength(allowed ? 1 : 0)
  expect(events.filter(event => event.phase === 'spawn-observed')).toHaveLength(allowed ? 1 : 0)
  if (allowed) expect(events.some(event => event.phase === 'admitted')).toBe(true)
  for (const event of events) {
    if (event.phase === 'no-launch') expect(event.facts.profile.active).toBeNull()
    if ('facts' in event) {
      expect(event.facts.correlation.kind).toBe('action')
      expect(event.facts.hostContextId).toBeTruthy()
      expect(event.facts.configurationSnapshotId).toBeTruthy()
    }
  }
}

function zeroGate(fixture: BranchFixture, branchId: string) {
  const gate = fixture.zeroSelection
  if (!gate || gate.ok) throw new Error('Expected the original literal-zero SDK budget intake refusal')
  expect(gate.reason).toBe('deadline-exhausted')
  assertBranch(fixture, branchId, false, true)
  expect(fixture.spawns).toHaveLength(0)
  return fixture.recordResult({ consumerInvoked: false, admissionGate: gate })
}

describe('B19 actual toolchain branch controls with authentic SDK host authority', () => {
  for (const [command, argument] of versionCommands) {
    for (const state of branchStates) {
      test(`sdk.toolchain version.${command} ${state}`, async () => {
        const branchId = `version.${command}`
        const fixture = createToolchainBranchFixture({ producerId: 'sdk.toolchain', branchId, state })
        await observeBranchCase(fixture, async () => {
          if (fixture.zeroSelection) return zeroGate(fixture, branchId)
          const output = fixture.recordResult(await settled(() => inspectEnvironment(fixture.root, undefined, fixture.context)))
          fixture.settlePolicies()
          await Promise.allSettled(fixture.children.map(entry => entry.close))
          assertBranch(fixture, branchId, state === 'allow', state === 'pre-aborted' || state === 'deadline-zero')
          const targets = fixture.spawns.filter(launch => launch.command === command)
          expect(targets).toHaveLength(state === 'allow' ? 1 : 0)
          if (state === 'allow') {
            expect(output.ok).toBe(true)
            expect(targets[0].argv).toEqual([argument])
            expect(targets[0].signalAborted).toBe(false)
          }
          assertExactEnvironment(fixture)
          return output
        })
      }, 15_000)
    }
  }

  for (const runtime of ['async-production', 'sync-legacy'] as const) {
    for (const command of ['cargo', 'go'] as const) {
      for (const state of branchStates) {
        test(`${runtime === 'async-production' ? 'sdk.build' : 'direct.build-legacy'} build.${runtime}.${command} ${state}`, async () => {
          const branchId = `build.${runtime}.${command}`
          const fixture = createToolchainBranchFixture({ producerId: runtime === 'async-production' ? 'sdk.build' : 'direct.build-legacy', branchId, state,
            ...(runtime === 'async-production' ? { exhaustAfterDispatchOf: `build.async-production.${command === 'cargo' ? 'go' : 'cargo'}` } : {}) })
          await observeBranchCase(fixture, async () => {
            if (fixture.zeroSelection) return zeroGate(fixture, branchId)
            const output = fixture.recordResult(await settled(() => runtime === 'async-production'
              ? getBuildTargets(fixture.root, ['file.go'], undefined, fixture.context)
              : resolveOwningTargets({ cwd: fixture.root, files: ['file.go'], executionContext: fixture.context })))
            fixture.settlePolicies()
            await Promise.allSettled(fixture.children.map(entry => entry.close))
            assertBranch(fixture, branchId, state === 'allow', state === 'pre-aborted' || state === 'deadline-zero')
            const targets = fixture.spawns.filter(launch => launch.command === command)
            expect(targets).toHaveLength(state === 'allow' ? 1 : 0)
            if (state === 'allow') {
              expect(output.ok).toBe(true)
              expect(targets[0].kind).toBe(runtime === 'async-production' ? 'node' : 'spawn-sync')
              expect(targets[0].argv).toEqual(command === 'cargo' ? ['metadata', '--no-deps', '--format-version', '1'] : ['list', '-json', './...'])
            } else if (command === 'go' && runtime === 'sync-legacy' && state !== 'pre-aborted' && state !== 'deadline-zero') {
              // Cargo metadata is an earlier independently admitted helper.
              expect(fixture.spawns.filter(launch => launch.command === 'cargo')).toHaveLength(1)
            }
            if (runtime === 'async-production' && state === 'exhausted') {
              expect(fixture.clockTransitions[0].earlierDispatchIds).toHaveLength(1)
              expect(fixture.spawns.filter(launch => launch.command !== command)).toHaveLength(1)
            }
            assertExactEnvironment(fixture)
            return output
          })
        }, 15_000)
      }
    }
  }

  for (const phase of ['version', 'scan'] as const) {
    for (const state of branchStates) {
      test(`sdk.semgrep semgrep.${phase} ${state}`, async () => {
        const branchId = `semgrep.${phase}`
        const fixture = createToolchainBranchFixture({ producerId: 'sdk.semgrep', branchId, state })
        await observeBranchCase(fixture, async () => {
          if (fixture.zeroSelection) return zeroGate(fixture, branchId)
          const output = fixture.recordResult(await runSemgrepBaseline({ cwd: fixture.root, baselineCommit: 'abc1234', files: ['file.go'], executionContext: fixture.context }))
          fixture.settlePolicies()
          await Promise.allSettled(fixture.children.map(entry => entry.close))
          const upstreamGate = state === 'pre-aborted' || state === 'deadline-zero'
          assertBranch(fixture, branchId, state === 'allow', upstreamGate)
          const targets = fixture.spawns.filter(launch => launch.command === 'semgrep' && (phase === 'version' ? launch.argv[0] === '--version' : launch.argv[0] === 'scan'))
          expect(targets).toHaveLength(state === 'allow' ? 1 : 0)
          if (state === 'allow') expect(output.status).toBe('ok')
          else {
            expect(output.status).toBe(phase === 'version' || upstreamGate ? 'unavailable' : 'error')
            if (output.status !== 'error' && output.status !== 'unavailable') throw new Error('Expected a typed Semgrep refusal')
            expect(output.executionRefusal).toBeDefined()
            if (phase === 'scan' && !upstreamGate) expect(fixture.spawns.filter(launch => launch.argv[0] === '--version')).toHaveLength(1)
          }
          assertExactEnvironment(fixture)
          return output
        })
      }, 15_000)
    }
  }

  test('a required native profile remains unavailable at the actual SDK build consumer', async () => {
    const fixture = createToolchainBranchFixture({ producerId: 'native.selection', branchId: 'build.async-production.cargo', state: 'allow', nativeRequired: true })
    await observeBranchCase(fixture, async () => {
      const output = fixture.recordResult(await settled(() => getBuildTargets(fixture.root, ['file.go'], undefined, fixture.context)))
      expect(output.ok).toBe(false)
      expect(fixture.spawns).toHaveLength(0)
      expect(fixture.events.some(event => event.phase === 'spawn-observed')).toBe(false)
      return output
    })
  })

  for (const selection of [
    ...versionCommands.map(([command]) => ({ producerId: 'sdk.toolchain', branchId: `version.${command}`,
      tool: { toolName: 'inspect_environment' as const, input: {} } })),
    ...(['cargo', 'go'] as const).map(command => ({ producerId: 'sdk.build', branchId: `build.async-production.${command}`,
      tool: { toolName: 'get_build_targets' as const, input: { files: ['file.go'] } },
      earlier: `build.async-production.${command === 'cargo' ? 'go' : 'cargo'}` })),
    ...(['version', 'scan'] as const).map(phase => ({ producerId: 'sdk.bundle', branchId: `semgrep.${phase}`,
      tool: { toolName: 'get_change_review_bundle' as const, input: {} }, repository: true })),
  ]) {
    for (const state of branchStates) {
      test(`${selection.producerId} ${selection.branchId} ${state} OpenbuffClient.run`, async () => {
        const fixture = createToolchainBranchFixture({ producerId: selection.producerId, branchId: selection.branchId, state,
          realGit: true, variant: 'OpenbuffClient.run',
          ...('earlier' in selection ? { exhaustAfterDispatchOf: selection.earlier } : {}) })
        if ('repository' in selection) fixture.seedGitRepository()
        const consumer = createToolchainSdkConsumer(fixture)
        try {
          await observeBranchCase(fixture, async () => {
            const run = await consumer.run(selection.tool)
            fixture.settlePolicies()
            await Promise.allSettled(fixture.children.map(entry => entry.close))
            const output = fixture.recordResult({ run, snapshots: consumer.snapshots, providerCalls: consumer.providerCalls })
            const upstreamGate = state === 'pre-aborted' || state === 'deadline-zero'
            assertBranch(fixture, selection.branchId, state === 'allow', upstreamGate)
            expect(consumer.snapshots).toHaveLength(upstreamGate ? 0 : 1)
            expect(consumer.providerCalls).toBe(0)
            if (state === 'allow') {
              expect(run.runOutcome?.termination).toBe('completed')
              expect(run.actionOutcomes?.some(action => action.toolName === selection.tool.toolName && action.outcome === 'succeeded')).toBe(true)
              const observed = fixture.events.find(event => event.phase === 'spawn-observed' && event.facts.branchId === selection.branchId)
              if (observed?.phase !== 'spawn-observed' || observed.facts.correlation.kind !== 'action') throw new Error('Missing actual SDK action-correlated launch')
              const correlation = observed.facts.correlation
              expect(run.actionOutcomes?.some(action => action.actionId === correlation.actionId && action.attemptId === correlation.attemptId)).toBe(true)
            }
            if (state === 'exhausted' && 'earlier' in selection) {
              const earlier = fixture.events.filter(hasLaunchFacts).filter(event => event.phase === 'dispatched' && event.facts.branchId === selection.earlier)
              expect(earlier).toHaveLength(1)
              expect(fixture.clockTransitions[0].earlierDispatchIds).toContain(earlier[0].facts.launchId)
            }
            assertExactEnvironment(fixture)
            return output
          })
        } finally { consumer.close() }
      }, 15_000)
    }
  }

  test('literal-zero SDK intake and invalid common duration have distinct original refusals', async () => {
    const fixture = createToolchainBranchFixture({ producerId: 'direct.budget-intake', branchId: 'budget.zero-layer', state: 'allow' })
    await observeBranchCase(fixture, async () => {
      const sdkIntake = executionLimitMs(0)
      const commonInput = fixture.scope.action({ actionId: 'zero-common-input', attemptId: 'attempt-zero', basisId: 'fixture-basis',
        limit: { kind: 'finite', durationMs: 0 } })
      if (sdkIntake.ok || commonInput.ok) throw new Error('A literal-zero limit must not produce launch authority')
      expect(sdkIntake.reason).toBe('deadline-exhausted')
      expect(commonInput.reason).toBe('invalid-context')
      expect(fixture.spawns).toHaveLength(0)
      return fixture.recordResult({ sdkIntake, commonInput })
    })
  })
})
