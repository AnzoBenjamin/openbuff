import { expect, test } from 'bun:test'
import { branchStates, createToolchainBranchFixture, hasLaunchFacts, observeBranchCase } from '../../../sdk/src/__tests__/fixtures/toolchain-branch-authority'
import { defaultScipRunner, detectAvailableScipIndexers, detectAvailableScipIndexersAsync, runScipIngest, SCIP_INDEXER_COMMANDS } from './scip-runner'

for (const runtime of ['async', 'sync'] as const) {
  for (const entry of SCIP_INDEXER_COMMANDS) {
    for (const phase of ['detect', 'index'] as const) {
      for (const state of branchStates) {
        const branchId = `scip.${runtime}.${phase}.${entry.id}`
        test(`direct.scip ${branchId} ${state} ingest`, async () => {
          const fixture = createToolchainBranchFixture({ producerId: 'direct.scip', branchId, state, variant: 'ingest' })
          await observeBranchCase(fixture, async () => {
            if (fixture.zeroSelection) {
              if (fixture.zeroSelection.ok) throw new Error('Unexpected literal-zero action admission')
              expect(fixture.zeroSelection.reason).toBe('deadline-exhausted')
              expect(fixture.spawns).toHaveLength(0)
              return fixture.recordResult({ consumerInvoked: false, admissionGate: fixture.zeroSelection })
            }
            const output = fixture.recordResult(await runScipIngest(fixture.root, { indexers: [entry.id], executionContext: fixture.context,
              ...(runtime === 'sync' ? { runner: defaultScipRunner } : {}) }))
            fixture.settlePolicies()
            await Promise.allSettled(fixture.children.map(child => child.close))
            const events = fixture.events.filter(hasLaunchFacts).filter(event => event.facts.branchId === branchId)
            const upstreamGate = state === 'pre-aborted' || state === 'deadline-zero'
            expect(events.some(event => event.phase === 'planned')).toBe(!upstreamGate)
            expect(events.filter(event => event.phase === 'dispatched')).toHaveLength(state === 'allow' ? 1 : 0)
            expect(events.filter(event => event.phase === 'spawn-observed')).toHaveLength(state === 'allow' ? 1 : 0)
            const launches = fixture.spawns.filter(launch => launch.command === entry.bin && (phase === 'detect' ? launch.argv[0] === '--version' : launch.argv[0] === 'index'))
            expect(launches).toHaveLength(state === 'allow' ? 1 : 0)
            if (state === 'allow') {
              expect(output.results[0].status).toBe('ok')
              expect(launches[0].kind).toBe(runtime === 'sync' ? 'spawn-sync' : 'node')
              expect(launches[0].argv.slice(0, phase === 'detect' ? 1 : 2)).toEqual(phase === 'detect' ? ['--version'] : ['index', '--output'])
            } else {
              expect(output.results[0].executionRefusal).toBeDefined()
              expect(output.results[0].error).not.toContain('not available (detection exit')
              if (runtime === 'sync' && state === 'delayed-cancel') expect(output.results[0].executionRefusal?.reason).toBe('unavailable')
            }
            if (phase === 'index' && state !== 'allow' && !upstreamGate) expect(fixture.spawns.filter(launch => launch.argv[0] === '--version')).toHaveLength(1)
            for (const launch of fixture.spawns) {
              expect(launch.env?.PROJECT_VALUE).toBe('captured-public')
              for (const key of ['OPENAI_API_KEY', 'CUSTOM_PROVIDER_KEY', 'DELETE_ME']) expect(launch.env).not.toHaveProperty(key)
            }
            return output
          })
        }, 15_000)
      }
    }

    for (const state of branchStates) {
      const branchId = `scip.${runtime}.detect.${entry.id}`
      test(`direct.scip ${branchId} ${state} standalone-detection`, async () => {
        const fixture = createToolchainBranchFixture({ producerId: 'direct.scip', branchId, state, variant: 'standalone-detection' })
        await observeBranchCase(fixture, async () => {
          if (fixture.zeroSelection) {
            if (fixture.zeroSelection.ok) throw new Error('Unexpected literal-zero action admission')
            expect(fixture.zeroSelection.reason).toBe('deadline-exhausted')
            expect(fixture.spawns).toHaveLength(0)
            return fixture.recordResult({ consumerInvoked: false, admissionGate: fixture.zeroSelection })
          }
          let output: unknown
          try {
            output = runtime === 'sync'
              ? detectAvailableScipIndexers(fixture.root, { executionContext: fixture.context })
              : await detectAvailableScipIndexersAsync(fixture.root, { executionContext: fixture.context })
          } catch (error) {
            output = { error: String(error), refusal: (error as { refusal?: unknown }).refusal }
          }
          fixture.recordResult(output)
          fixture.settlePolicies()
          await Promise.allSettled(fixture.children.map(child => child.close))
          const events = fixture.events.filter(hasLaunchFacts).filter(event => event.facts.branchId === branchId)
          expect(events.some(event => event.phase === 'planned')).toBe(state !== 'pre-aborted' && state !== 'deadline-zero')
          expect(events.filter(event => event.phase === 'dispatched')).toHaveLength(state === 'allow' ? 1 : 0)
          expect(fixture.spawns.filter(launch => launch.command === entry.bin)).toHaveLength(state === 'allow' ? 1 : 0)
          if (state === 'allow') expect(output).toEqual(SCIP_INDEXER_COMMANDS.map(command => command.id))
          else expect(Array.isArray(output)).toBe(false)
          return output
        })
      }, 15_000)
    }
  }
}
