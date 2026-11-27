import { describe, expect, test } from 'bun:test'

import { initialSessionState } from '../run-state'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { branchStates, createToolchainBranchFixture, hasLaunchFacts, observeBranchCase } from './fixtures/toolchain-branch-authority'
import { createToolchainSdkConsumer } from './fixtures/toolchain-branch-sdk-client'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

// Discovered during R3: these supplement the immutable 136-branch roster.
const queryGuards = ['--no-pager', '--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false'] as const
const branches = [
  ['session.git.status', [...queryGuards, 'status']],
  ['session.git.diff', [...queryGuards, 'diff', '--no-ext-diff', '--no-textconv', '--submodule=short']],
  ['session.git.diff-cached', [...queryGuards, 'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--cached']],
  ['session.git.shortlog', [...queryGuards, 'shortlog', 'HEAD~10..HEAD']],
] as const

const strategy: AgentDefinition = {
  id: 'b19-session-git-control', displayName: 'Startup Git authority control',
  model: 'fixture/fixture-model', toolNames: ['set_output'], outputMode: 'structured_output',
  handleSteps: function* () {
    yield { toolName: 'set_output', input: { strategyEntered: true } }
  },
}

describe('B19 supplemental actual SDK startup Git observations', () => {
  for (const [branchId, argv] of branches) {
    for (const state of branchStates) {
      test(`${branchId} ${state} authenticated startup host operation`, async () => {
        const fixture = createToolchainBranchFixture({ producerId: 'sdk.session-initialization', branchId, state,
          variant: 'initial-SDK-host-operation', realGit: true })
        fixture.seedGitRepository()
        const consumer = createToolchainSdkConsumer(fixture)
        try {
          await observeBranchCase(fixture, async () => {
            const run = await consumer.runAgent(strategy)
            fixture.settlePolicies()
            await Promise.allSettled(fixture.children.map(entry => entry.close))
            await Promise.resolve()
            const events = fixture.events.filter(hasLaunchFacts).filter(event => event.facts.branchId === branchId)
            const upstream = state === 'pre-aborted' || state === 'deadline-zero'
            expect(consumer.snapshots).toHaveLength(upstream ? 0 : 1)
            expect(consumer.providerCalls).toBe(0)
            expect(events.filter(event => event.phase === 'planned')).toHaveLength(upstream ? 0 : 1)
            expect(events.filter(event => event.phase === 'dispatched')).toHaveLength(state === 'allow' ? 1 : 0)
            expect(events.filter(event => event.phase === 'spawn-observed')).toHaveLength(state === 'allow' ? 1 : 0)
            const targets = fixture.spawns.filter(call => call.kind === 'node' && call.command === 'git' &&
              JSON.stringify(call.argv) === JSON.stringify(argv))
            expect(targets).toHaveLength(state === 'allow' ? 1 : 0)
            for (const event of events) {
              const correlation = event.facts.correlation
              if (correlation.kind !== 'host-operation') throw new Error('Startup observation lacks authentic host-operation correlation')
              expect(correlation.operationId).toBeTruthy()
              expect(correlation.hostContextId).toBe(event.facts.hostContextId)
              expect(correlation).not.toHaveProperty('owner')
              expect(correlation).not.toHaveProperty('actionId')
              expect(event.facts.configurationSnapshotId).toBe(consumer.snapshots[0])
              expect(event.facts.profile.requested.policy).toBe('full-access')
              if (event.phase === 'no-launch') expect(event.facts.profile.active).toBeNull()
            }
            for (const call of fixture.spawns) {
              expect(call.cwd).toBe(fixture.root)
              expect(call.env?.PATH).toBe(fixture.binaryRoot)
              expect(call.env?.PROJECT_VALUE).toBe('captured-public')
              for (const name of ['OPENAI_API_KEY', 'CUSTOM_PROVIDER_KEY', 'DELETE_ME', 'HOME'])
                expect(call.env).not.toHaveProperty(name)
            }
            if (state === 'allow' || state === 'denied' || state === 'unavailable')
              expect(run.runOutcome?.termination).toBe('completed')
            return fixture.recordResult({ run, snapshots: consumer.snapshots, providerCalls: consumer.providerCalls,
              targetArgv: argv, upstreamGate: upstream, proof: 'Actual SDK startup, real Git boundary, injected selected policy/private clock' })
          })
        } finally { consumer.close() }
      }, 15_000)
    }
  }

  test('standalone session construction without authority starts no ambient Git child', async () => {
    const fixture = createToolchainBranchFixture({ producerId: 'direct.session-initialization', branchId: 'session.git.no-context',
      state: 'allow', variant: 'missing-authority' })
    await observeBranchCase(fixture, async () => {
      let rawSpawns = 0
      const logs: Array<Record<string, unknown>> = []
      const state = await initialSessionState({ cwd: fixture.root, projectFiles: {}, knowledgeFiles: {}, userKnowledgeFiles: {},
        agentDefinitions: [strategy], persistentMemory: false, fs: createNodeFileSystem(),
        spawn: () => { rawSpawns++; throw new Error('Ambient Git spawn must not run without authority') },
        logger: { debug: object => { logs.push(object as Record<string, unknown>) }, info: () => {}, warn: () => {}, error: () => {} } })
      expect(rawSpawns).toBe(0)
      expect(fixture.spawns).toHaveLength(0)
      const refusals = logs.filter(log => log.executionRefusal)
      expect(refusals).toHaveLength(4)
      for (const refusal of refusals) expect(refusal.executionRefusal).toMatchObject({ reason: 'unavailable' })
      expect(state.fileContext.gitChanges).toEqual({ status: '', diff: '', diffCached: '', lastCommitMessages: '' })
      return fixture.recordResult({ rawSpawns, gitChanges: state.fileContext.gitChanges, refusals,
        proof: 'Internal compatibility construction refuses optional Git observations before any spawn' })
    })
  })
})
