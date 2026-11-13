import { expect, test } from 'bun:test'
import { SCIP_INDEXER_COMMANDS } from '@codebuff/indexer/scip-runner'
import { branchStates, createToolchainBranchFixture, hasLaunchFacts, observeBranchCase } from '../../../../sdk/src/__tests__/fixtures/toolchain-branch-authority'
import { ExecutionRefusalError } from '../../../../sdk/src/services/execution-launch'
import { handleIndexCommand } from '../index-command'
import type { IndexCommandDeps } from '../index-command'

for (const entry of SCIP_INDEXER_COMMANDS) {
  for (const phase of ['detect', 'index'] as const) {
    for (const state of branchStates) {
      const branchId = `scip.async.${phase}.${entry.id}`
      test(`cli.scip ${branchId} ${state} actual index command and default runner`, async () => {
        const fixture = createToolchainBranchFixture({ producerId: 'cli.scip', branchId, state, variant: 'handleIndexCommand-default-runner' })
        const snapshot = { version: '2' as const, projectRoot: fixture.root, builtAt: 1, fileCount: 0, files: {}, graph: { nodes: {}, edges: [] } }
        let contextRequests = 0
        const manager: NonNullable<ReturnType<IndexCommandDeps['getManager']>['manager']> = {
          markStale() {}, ensureBuilt() {}, async waitUntilReady() { return true }, isSemanticReady() { return false },
          getSnapshot: () => snapshot,
          query: () => ({ results: [], ready: true, totalIndexed: 0, indexAge: 0, snapshot: { snapshotId: fixture.id },
            status: { state: 'ready', ready: true, stale: false, refreshing: false, semantic: 'disabled', totalIndexed: 0,
              indexAge: 0, diagnostics: [], message: 'Fixture metadata available' } }),
          async queryBlended() { return this.query('') },
          async adoptMergedIndex() { throw new Error('The empty fixture dump must never request index adoption') },
        }
        await observeBranchCase(fixture, async () => {
          // Manager/root setup is injected. The command's default runScipIngest
          // and its real Node runner, authority, parsing and output stay live.
          const output = await handleIndexCommand(`scip ${entry.id}`, {
            getManager: () => ({ enabled: true, semanticEnabled: false, manager }), getRoot: () => fixture.root,
            async getExecutionContext() {
              contextRequests++
              if (fixture.zeroSelection && !fixture.zeroSelection.ok) throw new ExecutionRefusalError(fixture.zeroSelection)
              return fixture.baseContext
            },
          })
          fixture.recordResult({ output, contextRequests })
          fixture.settlePolicies()
          await Promise.allSettled(fixture.children.map(child => child.close))
          const events = fixture.events.filter(hasLaunchFacts).filter(event => event.facts.branchId === branchId)
          const upstreamGate = state === 'pre-aborted' || state === 'deadline-zero'
          expect(contextRequests).toBe(1)
          expect(events.some(event => event.phase === 'planned')).toBe(!upstreamGate)
          expect(events.filter(event => event.phase === 'dispatched')).toHaveLength(state === 'allow' ? 1 : 0)
          expect(events.filter(event => event.phase === 'spawn-observed')).toHaveLength(state === 'allow' ? 1 : 0)
          const targets = fixture.spawns.filter(launch => launch.command === entry.bin && launch.argv[0] === (phase === 'detect' ? '--version' : 'index'))
          expect(targets).toHaveLength(state === 'allow' ? 1 : 0)
          if (state === 'allow') {
            expect(output).toContain(`${entry.id}: ok (0 precise edges merged)`)
            expect(targets[0].kind).toBe('node')
          } else {
            expect(output).not.toContain('Hint: install')
            if (phase === 'index' && !upstreamGate) expect(fixture.spawns.filter(launch => launch.argv[0] === '--version')).toHaveLength(1)
          }
          for (const launch of fixture.spawns) {
            expect(launch.cwd).toBe(fixture.root)
            expect(launch.env?.PATH).toBe(fixture.binaryRoot)
            expect(launch.env?.PROJECT_VALUE).toBe('captured-public')
            for (const key of ['OPENAI_API_KEY', 'CUSTOM_PROVIDER_KEY', 'DELETE_ME', 'HOME']) expect(launch.env).not.toHaveProperty(key)
          }
          return { output, contextRequests }
        })
      }, 15_000)
    }
  }
}
