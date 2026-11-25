import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'bun:test'
import z from 'zod/v4'

import { getCustomToolDefinition } from '../custom-tool'
import { createLanguageIntelligence } from '../services/language-intelligence'
import { createNodeFileSystem } from '../tools/node-filesystem'
import {
  branchStates,
  createToolchainBranchFixture,
  hasLaunchFacts,
  observeBranchCase,
  unwrap,
} from './fixtures/toolchain-branch-authority'
import { createToolchainSdkConsumer } from './fixtures/toolchain-branch-sdk-client'
import { createLspBoundaryPeer } from './fixtures/toolchain-branch-lsp-peer'
import type {
  AgentDefinition,
  ToolCall,
} from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

const definition: ToolCall = {
  toolName: 'go_to_definition',
  input: { path: 'file.ts', line: 1, character: 13 },
}
const queries = [
  {
    toolName: 'go_to_definition',
    method: 'textDocument/definition',
    input: { path: 'file.ts', line: 1, character: 13 },
  },
  {
    toolName: 'find_references',
    method: 'textDocument/references',
    input: { path: 'file.ts', line: 1, character: 13 },
  },
  {
    toolName: 'hover_type',
    method: 'textDocument/hover',
    input: { path: 'file.ts', line: 1, character: 13 },
  },
  {
    toolName: 'workspace_symbol',
    method: 'workspace/symbol',
    input: { query: 'observed' },
  },
] as const
type Branch = 'cold-start' | 'crash-restart' | 'dead-entry-reacquire' | 'reuse'

type CheckpointRegistry = Map<string, () => void>
type CheckpointGlobal = typeof globalThis & {
  [key: symbol]: CheckpointRegistry | undefined
}

/** Test-only bridge for generators that the SDK stringifies into global scope. */
function installFixtureCheckpoint(id: string, checkpoint: () => void) {
  const key = Symbol.for('openbuff.test.b19.lsp.checkpoints')
  const globals = globalThis as CheckpointGlobal
  const registry = globals[key] ?? new Map<string, () => void>()
  if (!(registry instanceof Map) || registry.has(id))
    throw new Error('LSP fixture checkpoint collision')
  globals[key] = registry
  registry.set(id, checkpoint)
  return () => {
    registry.delete(id)
    if (globals[key] === registry && registry.size === 0) delete globals[key]
  }
}

for (const query of queries) {
  // workspace_symbol never calls acquire(): it only uses an already warm
  // connection and can await its independently triggered crash restart.
  const branches: readonly Branch[] =
    query.toolName === 'workspace_symbol'
      ? ['crash-restart', 'reuse']
      : ['cold-start', 'crash-restart', 'dead-entry-reacquire', 'reuse']
  for (const branch of branches) {
    for (const state of branchStates) {
      test(`sdk.lsp-primary lsp.${branch} ${state} ${query.toolName} actual SDK dispatcher and Node boundary`, async () => {
        const branchId = `lsp.${branch}`
        const fixture = createToolchainBranchFixture({
          producerId: 'sdk.lsp-primary',
          branchId,
          state,
          realGit: true,
          variant: `OpenbuffClient.run:${query.toolName}`,
          evidenceKind:
            'real-sdk-run-private-authority-with-injected-lsp-node-peer',
          initiallyArmed: branch !== 'reuse',
          matches: (actual) => actual === branchId,
          ...(branch === 'dead-entry-reacquire'
            ? { alwaysDenied: ['lsp.crash-restart'] }
            : branch === 'crash-restart' &&
                query.toolName !== 'workspace_symbol'
              ? { alwaysDenied: ['lsp.dead-entry-reacquire'] }
              : {}),
        })
        writeFileSync(
          path.join(fixture.root, 'package.json'),
          '{"name":"lsp-branch-fixture","private":true}',
        )
        writeFileSync(
          path.join(fixture.root, 'file.ts'),
          'export const observed = 1\n',
        )
        const peers: ReturnType<typeof createLspBoundaryPeer>[] = []
        const runtimeSpawn: CodebuffSpawn = (
          command,
          argv = [],
          options = {},
        ) => {
          if (command === 'typescript-language-server') {
            const peer = createLspBoundaryPeer(command, argv, options)
            peers.push(peer)
            return peer.child
          }
          if (!fixture.baseContext.spawn)
            throw new Error(
              'The fixture must retain its actual Node helper boundary',
            )
          return fixture.baseContext.spawn(command, argv, options)
        }
        const consumer = createToolchainSdkConsumer(fixture, {
          spawn: runtimeSpawn,
        })
        let selectionEventIndex = 0
        let checkpointInvocations = 0
        const removeCheckpoint = installFixtureCheckpoint(fixture.id, () => {
          checkpointInvocations++
          if (peers.length !== 1)
            throw new Error(
              'The first SDK query must reach one injected Node peer',
            )
          selectionEventIndex = fixture.events.length
          if (branch === 'reuse') fixture.arm(true)
          else peers[0].crash()
        })
        const agent: AgentDefinition = {
          id: 'b19-lsp-primary-strategy',
          displayName: 'LSP boundary strategy',
          model: 'fixture/fixture-model',
          toolNames:
            query.toolName === 'go_to_definition'
              ? ['go_to_definition', 'set_output']
              : ['go_to_definition', query.toolName, 'set_output'],
          outputMode: 'structured_output',
          handleSteps: function* ({ prompt }) {
            const specification = JSON.parse(prompt ?? '{}')
            const first = yield specification.first
            if (!specification.second) {
              yield {
                toolName: 'set_output',
                input: { first: first.toolResult },
              }
              return
            }
            // Literal global lookup survives SDK serialization; no test closure
            // is captured and no external SDK effect handler is entered.
            const registry = (
              globalThis as typeof globalThis & {
                [key: symbol]: Map<string, () => void> | undefined
              }
            )[Symbol.for('openbuff.test.b19.lsp.checkpoints')]
            const checkpoint = registry?.get(specification.checkpointId)
            if (!checkpoint) throw new Error('Missing LSP fixture checkpoint')
            registry!.delete(specification.checkpointId)
            checkpoint()
            const second = yield specification.second
            yield {
              toolName: 'set_output',
              input: { first: first.toolResult, second: second.toolResult },
            }
          },
        }
        try {
          await observeBranchCase(fixture, async () => {
            const run = await consumer.runAgent(
              agent,
              JSON.stringify({
                checkpointId: fixture.id,
                first:
                  query.toolName === 'workspace_symbol'
                    ? definition
                    : { toolName: query.toolName, input: query.input },
                ...(branch === 'cold-start'
                  ? {}
                  : {
                      second: { toolName: query.toolName, input: query.input },
                    }),
              }),
            )
            fixture.settlePolicies()
            await new Promise((resolve) => setTimeout(resolve, 0))
            const output = fixture.recordResult({
              run,
              snapshots: consumer.snapshots,
              providerCalls: consumer.providerCalls,
              selectionEventIndex,
              checkpointInvocations,
              coordination: 'fixture-local-unchanged-workspace-basis',
              peerCaptures: peers.map((peer) => ({
                ...peer.capture,
                methods: peer.methods,
                messages: peer.messages,
                closed: peer.closed,
              })),
            })
            const events = fixture.events
              .filter(hasLaunchFacts)
              .filter((event) => event.facts.family === 'lsp')
            const upstreamGate =
              state === 'deadline-zero' ||
              (state === 'pre-aborted' && branch !== 'reuse')
            expect(consumer.snapshots).toHaveLength(upstreamGate ? 0 : 1)
            expect(consumer.providerCalls).toBe(0)
            expect(checkpointInvocations).toBe(
              branch === 'cold-start' || upstreamGate ? 0 : 1,
            )
            if (!upstreamGate) {
              expect(
                run.sessionState?.mainAgentState.workspaceState?.revision,
              ).toBe(0)
              expect(
                run.sessionState?.mainAgentState.workspaceState?.changes,
              ).toEqual([])
              expect(
                run.actionOutcomes?.some(
                  (action) => action.toolName === 'b19_lsp_coordinate',
                ),
              ).toBe(false)
            }
            if (upstreamGate) {
              expect(peers).toHaveLength(0)
              expect(
                events.filter((event) => event.phase === 'dispatched'),
              ).toHaveLength(0)
            } else if (branch === 'reuse') {
              expect(peers).toHaveLength(1)
              expect(
                events.filter((event) => event.phase === 'spawn-observed'),
              ).toHaveLength(1)
              const uses = fixture.events
                .slice(selectionEventIndex)
                .filter(
                  (event) =>
                    event.phase === 'resource-reused' &&
                    event.facts.family === 'lsp',
                )
              expect(uses).toHaveLength(state === 'allow' ? 1 : 0)
              expect(
                peers[0].methods.filter((method) => method === query.method),
              ).toHaveLength(
                (query.toolName === 'workspace_symbol' ? 0 : 1) +
                  (state === 'allow' ? 1 : 0),
              )
              if (state === 'exhausted')
                expect(
                  fixture.clockTransitions[0].earlierDispatchIds.length,
                ).toBeGreaterThan(0)
            } else {
              const target = events.filter(
                (event) => event.facts.branchId === branchId,
              )
              expect(target.some((event) => event.phase === 'planned')).toBe(
                true,
              )
              expect(
                target.filter((event) => event.phase === 'dispatched'),
              ).toHaveLength(state === 'allow' ? 1 : 0)
              expect(
                target.filter((event) => event.phase === 'spawn-observed'),
              ).toHaveLength(state === 'allow' ? 1 : 0)
              expect(peers).toHaveLength(
                (branch === 'cold-start' ? 0 : 1) + (state === 'allow' ? 1 : 0),
              )
              for (const event of target)
                if (event.phase === 'no-launch')
                  expect(event.facts.profile.active).toBeNull()
            }
            for (const peer of peers) {
              expect(peer.capture.command).toBe('typescript-language-server')
              expect(peer.capture.argv).toEqual(['--stdio'])
              expect(peer.capture.cwd).toBe(fixture.root)
              expect(peer.capture.stdio).toEqual(['pipe', 'pipe', 'pipe'])
              expect(peer.capture.env.PROJECT_VALUE).toBe('captured-public')
              for (const name of [
                'OPENAI_API_KEY',
                'CUSTOM_PROVIDER_KEY',
                'DELETE_ME',
                'HOME',
              ])
                expect(peer.capture.env).not.toHaveProperty(name)
              expect(peer.capture.resourceSignalInitiallyAborted).toBe(false)
            }
            for (const event of events) {
              expect(event.facts.configurationSnapshotId).toBe(
                consumer.snapshots[0],
              )
              expect(event.facts.profile.requested.policy).toBe('full-access')
            }
            if (state === 'allow') {
              expect(run.runOutcome?.termination).toBe('completed')
              const starts = events.filter(
                (event) => event.phase === 'spawn-observed',
              )
              const first = starts[0].facts.correlation
              expect(first.kind).toBe('action')
              if (first.kind === 'action')
                expect(
                  run.actionOutcomes?.some(
                    (action) =>
                      action.actionId === first.actionId &&
                      action.attemptId === first.attemptId,
                  ),
                ).toBe(true)
            }
            return output
          })
        } finally {
          removeCheckpoint()
          consumer.close()
        }
      }, 15_000)
    }
  }
}

// An actual external custom handler advances workspace authority even when its
// implementation only manipulates this synthetic peer. Keep that boundary as
// a separate stale-basis control, including workspace_symbol's warm-only result.
for (const query of queries) {
  const branches =
    query.toolName === 'workspace_symbol'
      ? (['crash-restart'] as const)
      : (['crash-restart', 'dead-entry-reacquire'] as const)
  for (const branch of branches) {
    test(`sdk.lsp-primary lsp.${branch} custom-coordinate stale workspace basis ${query.toolName}`, async () => {
      const branchId = `lsp.${branch}`
      const fixture = createToolchainBranchFixture({
        producerId: 'sdk.lsp-primary',
        branchId,
        state: 'allow',
        realGit: true,
        variant: `OpenbuffClient.run:${query.toolName}:custom-coordinate-stale-basis`,
        evidenceKind:
          'real-sdk-custom-effect-workspace-invalidation-with-injected-lsp-node-peer',
        matches: (actual) => actual === branchId,
        ...(branch === 'dead-entry-reacquire'
          ? { alwaysDenied: ['lsp.crash-restart'] }
          : query.toolName !== 'workspace_symbol'
            ? { alwaysDenied: ['lsp.dead-entry-reacquire'] }
            : {}),
      })
      writeFileSync(
        path.join(fixture.root, 'package.json'),
        '{"name":"lsp-branch-fixture","private":true}',
      )
      writeFileSync(
        path.join(fixture.root, 'file.ts'),
        'export const observed = 1\n',
      )
      const peers: ReturnType<typeof createLspBoundaryPeer>[] = []
      let selectionEventIndex = 0
      let checkpointInvocations = 0
      const coordinate = getCustomToolDefinition({
        toolName: 'b19_lsp_coordinate',
        inputSchema: z.object({}),
        description: 'Local fixture checkpoint',
        execute: () => {
          checkpointInvocations++
          if (peers.length !== 1)
            throw new Error(
              'The first SDK query must reach one injected Node peer',
            )
          selectionEventIndex = fixture.events.length
          peers[0].crash()
          return [{ type: 'json', value: { coordinated: true } }]
        },
      })
      const consumer = createToolchainSdkConsumer(fixture, {
        customToolDefinitions: [coordinate],
        spawn: (command, argv = [], options = {}) => {
          if (command !== 'typescript-language-server')
            return fixture.baseContext.spawn!(command, argv, options)
          const peer = createLspBoundaryPeer(command, argv, options)
          peers.push(peer)
          return peer.child
        },
      })
      const agent: AgentDefinition = {
        id: 'b19-lsp-stale-basis-strategy',
        displayName: 'LSP stale authority strategy',
        model: 'fixture/fixture-model',
        toolNames:
          query.toolName === 'go_to_definition'
            ? ['go_to_definition', 'b19_lsp_coordinate', 'set_output']
            : [
                'go_to_definition',
                query.toolName,
                'b19_lsp_coordinate',
                'set_output',
              ],
        outputMode: 'structured_output',
        handleSteps: function* ({ prompt }) {
          const specification = JSON.parse(prompt ?? '{}')
          const first = yield specification.first
          yield { toolName: 'b19_lsp_coordinate', input: {} }
          const second = yield specification.second
          yield {
            toolName: 'set_output',
            input: { first: first.toolResult, second: second.toolResult },
          }
        },
      }
      try {
        await observeBranchCase(fixture, async () => {
          const run = await consumer.runAgent(
            agent,
            JSON.stringify({
              first:
                query.toolName === 'workspace_symbol'
                  ? definition
                  : { toolName: query.toolName, input: query.input },
              second: { toolName: query.toolName, input: query.input },
            }),
          )
          fixture.settlePolicies()
          await new Promise((resolve) => setTimeout(resolve, 0))
          const output = fixture.recordResult({
            run,
            snapshots: consumer.snapshots,
            providerCalls: consumer.providerCalls,
            selectionEventIndex,
            checkpointInvocations,
            coordination: 'actual-custom-effect-workspace-invalidation',
            peerCaptures: peers.map((peer) => ({
              ...peer.capture,
              methods: peer.methods,
              messages: peer.messages,
              closed: peer.closed,
            })),
          })
          const events = fixture.events
            .filter(hasLaunchFacts)
            .filter((event) => event.facts.family === 'lsp')
          const selected = fixture.events
            .slice(selectionEventIndex)
            .filter(hasLaunchFacts)
            .filter((event) => event.facts.branchId === branchId)
          const noLaunch = selected.filter(
            (event) => event.phase === 'no-launch',
          )
          expect(checkpointInvocations).toBe(1)
          expect(consumer.snapshots).toHaveLength(1)
          expect(consumer.providerCalls).toBe(0)
          expect(peers).toHaveLength(1)
          expect(peers[0].closed).toBe(true)
          expect(
            events.filter((event) => event.phase === 'dispatched'),
          ).toHaveLength(1)
          expect(
            events.filter((event) => event.phase === 'spawn-observed'),
          ).toHaveLength(1)
          expect(selected.some((event) => event.phase === 'planned')).toBe(true)
          expect(
            selected.filter(
              (event) =>
                event.phase === 'dispatched' ||
                event.phase === 'spawn-observed',
            ),
          ).toHaveLength(0)
          expect(noLaunch.length).toBeGreaterThan(0)
          expect(
            peers[0].methods.filter((method) => method === query.method),
          ).toHaveLength(query.toolName === 'workspace_symbol' ? 0 : 1)
          const workspace = run.sessionState?.mainAgentState.workspaceState
          if (!workspace)
            throw new Error(
              'Stale-basis SDK run must expose its actual workspace state',
            )
          const actions = run.actionOutcomes ?? []
          const coordinateAction = actions.find(
            (action) => action.toolName === 'b19_lsp_coordinate',
          )
          if (!coordinateAction)
            throw new Error(
              'Custom checkpoint must have an actual SDK action outcome',
            )
          expect(workspace.revision).toBe(1)
          expect(workspace.changes).toHaveLength(1)
          expect(workspace.changes[0]).toMatchObject({
            revision: 1,
            source: 'sdk:unscoped:b19_lsp_coordinate',
            operationId: coordinateAction.actionId,
            actions: [{ action: 'unknown' }],
          })
          expect(coordinateAction.basis.workspaceRevision).toBe(0)
          expect(coordinateAction.outcome).toBe('succeeded')
          const firstAction = actions[0]
          expect(firstAction.toolName).toBe(
            query.toolName === 'workspace_symbol'
              ? 'go_to_definition'
              : query.toolName,
          )
          expect(firstAction.basis.workspaceRevision).toBe(0)
          expect(firstAction.outcome).toBe('succeeded')
          const firstStart = events.find(
            (event) => event.phase === 'spawn-observed',
          )!
          expect(firstStart.facts.correlation.kind).toBe('action')
          if (firstStart.facts.correlation.kind !== 'action')
            throw new Error(
              'Initial LSP startup must retain its action correlation',
            )
          expect(firstStart.facts.correlation.actionId).toBe(
            firstAction.actionId,
          )
          expect(firstStart.facts.correlation.attemptId).toBe(
            firstAction.attemptId,
          )
          for (const event of noLaunch) {
            expect(event.refusal).toEqual({
              ok: false,
              reason: 'stale-authority',
              cause: `Action basis changed: expected workspace.v1.0.00000000 (revision 0), actual ${workspace.snapshotId} (revision 1); attempted workspace.v1.0.00000000 (revision 0).`,
            })
            expect(event.facts.profile.active).toBeNull()
            expect(event.facts.correlation).toEqual(
              firstStart.facts.correlation,
            )
            expect(event.facts.resourceId).toBe(firstStart.facts.resourceId)
          }
          expect(run.runOutcome?.termination).toBe('completed')
          expect(run.output.type).toBe('structuredOutput')
          if (run.output.type !== 'structuredOutput')
            throw new Error('Stale LSP control must return structured output')
          const value = run.output.value as {
            second: Array<{ type: string; value: Record<string, unknown> }>
          }
          expect(value.second).toHaveLength(1)
          expect(value.second[0].type).toBe('json')
          const secondAction = actions
            .filter((action) => action.toolName === query.toolName)
            .at(-1)!
          expect(secondAction.basis.workspaceRevision).toBe(1)
          if (query.toolName === 'workspace_symbol') {
            expect(value.second[0].value.unavailable).toMatchObject({
              reason: 'no-warm-server',
              status: 'unavailable',
            })
            expect(value.second[0].value).not.toHaveProperty('executionRefusal')
            expect(secondAction.outcome).toBe('succeeded')
          } else {
            expect(value.second[0].value.executionRefusal).toEqual(
              noLaunch[0].refusal,
            )
            expect(secondAction.outcome).toBe('refused')
            expect(secondAction.cause).toEqual({
              code: 'execution_stale-authority',
              message: noLaunch[0].refusal.cause,
            })
          }
          expect(secondAction.effect).toEqual({
            status: 'unobserved',
            receiptIds: [],
            confirmedPaths: [],
          })
          for (const peer of peers) {
            expect(peer.capture.command).toBe('typescript-language-server')
            expect(peer.capture.argv).toEqual(['--stdio'])
            expect(peer.capture.cwd).toBe(fixture.root)
            expect(peer.capture.stdio).toEqual(['pipe', 'pipe', 'pipe'])
            expect(peer.capture.env.PROJECT_VALUE).toBe('captured-public')
            for (const name of [
              'OPENAI_API_KEY',
              'CUSTOM_PROVIDER_KEY',
              'DELETE_ME',
              'HOME',
            ])
              expect(peer.capture.env).not.toHaveProperty(name)
            expect(peer.capture.resourceSignalInitiallyAborted).toBe(false)
          }
          for (const event of events) {
            expect(event.facts.configurationSnapshotId).toBe(
              consumer.snapshots[0],
            )
            expect(event.facts.profile.requested.policy).toBe('full-access')
          }
          return output
        })
      } finally {
        consumer.close()
      }
    }, 15_000)
  }
}

for (const scenario of ['cold-query', 'dead-entry-query'] as const) {
  test(`sdk.lsp-primary workspace_symbol ${scenario} cannot launch the source-inapplicable acquire branch`, async () => {
    const fixture = createToolchainBranchFixture({
      producerId: 'sdk.lsp-primary',
      branchId: 'lsp.workspace-symbol-no-acquire',
      state: 'allow',
      realGit: true,
      variant: scenario,
      alwaysDenied: ['lsp.crash-restart'],
    })
    writeFileSync(
      path.join(fixture.root, 'package.json'),
      '{"name":"lsp-warm-symbol-fixture","private":true}',
    )
    writeFileSync(
      path.join(fixture.root, 'file.ts'),
      'export const observed = 1\n',
    )
    const peers: ReturnType<typeof createLspBoundaryPeer>[] = []
    const coordinate = getCustomToolDefinition({
      toolName: 'b19_lsp_coordinate',
      inputSchema: z.object({}),
      description: 'Local fixture death checkpoint',
      execute: () => {
        peers[0].crash()
        return [{ type: 'json', value: { coordinated: true } }]
      },
    })
    const consumer = createToolchainSdkConsumer(fixture, {
      customToolDefinitions: [coordinate],
      spawn: (command, argv = [], options = {}) => {
        if (command !== 'typescript-language-server')
          return fixture.baseContext.spawn!(command, argv, options)
        const peer = createLspBoundaryPeer(command, argv, options)
        peers.push(peer)
        return peer.child
      },
    })
    const agent: AgentDefinition = {
      id: 'b19-workspace-symbol-no-acquire',
      displayName: 'Warm symbol applicability',
      model: 'fixture/fixture-model',
      toolNames: [
        'go_to_definition',
        'workspace_symbol',
        'b19_lsp_coordinate',
        'set_output',
      ],
      outputMode: 'structured_output',
      handleSteps: function* ({ prompt }) {
        const specification = JSON.parse(prompt ?? '{}')
        if (specification.first) {
          yield specification.first
          yield { toolName: 'b19_lsp_coordinate', input: {} }
        }
        const result = yield {
          toolName: 'workspace_symbol',
          input: { query: 'observed' },
        }
        yield { toolName: 'set_output', input: { result: result.toolResult } }
      },
    }
    try {
      await observeBranchCase(fixture, async () => {
        const run = await consumer.runAgent(
          agent,
          JSON.stringify({
            first: scenario === 'dead-entry-query' ? definition : null,
          }),
        )
        const events = fixture.events
          .filter(hasLaunchFacts)
          .filter((event) => event.facts.family === 'lsp')
        expect(run.runOutcome?.termination).toBe('completed')
        expect(peers).toHaveLength(scenario === 'cold-query' ? 0 : 1)
        expect(
          events.filter((event) => event.phase === 'dispatched'),
        ).toHaveLength(scenario === 'cold-query' ? 0 : 1)
        expect(
          events.filter(
            (event) => event.facts.branchId === 'lsp.dead-entry-reacquire',
          ),
        ).toHaveLength(0)
        for (const peer of peers)
          expect(peer.methods).not.toContain('workspace/symbol')
        expect(consumer.providerCalls).toBe(0)
        return fixture.recordResult({
          run,
          sourceApplicability:
            'workspaceSymbol uses warmEntryForWorkspaceSymbol and never acquire',
          peerCaptures: peers.map((peer) => ({
            ...peer.capture,
            methods: peer.methods,
          })),
        })
      })
    } finally {
      consumer.close()
    }
  }, 15_000)
}

async function waitUntil(ready: () => boolean) {
  const limit = performance.now() + 1_000
  while (!ready()) {
    if (performance.now() >= limit)
      throw new Error('The local control did not reach its selected boundary')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
function requestResult<T>(value: Promise<T>) {
  return value.then(
    (result) => ({ ok: true as const, result }),
    (error) => ({
      ok: false as const,
      name: (error as Error).name,
      message: String(error),
    }),
  )
}

for (const selectedBoundary of ['cold-start-wait', 'use-admission'] as const) {
  test(`authentic shared LSP resource survives cancellation of one ${selectedBoundary} waiter`, async () => {
    const fixture = createToolchainBranchFixture({
      producerId: 'direct.lsp-resource',
      branchId: 'lsp.cold-start',
      state: 'allow',
      variant: selectedBoundary,
      evidenceKind:
        'actual-language-service-private-host-resource-with-injected-node-peer',
      ...(selectedBoundary === 'use-admission'
        ? { waitForUseOfAction: 'cancelled-waiter' }
        : {}),
    })
    writeFileSync(
      path.join(fixture.root, 'package.json'),
      '{"name":"shared-lsp-fixture","private":true}',
    )
    writeFileSync(
      path.join(fixture.root, 'file.ts'),
      'export const observed = 1\n',
    )
    const peers: ReturnType<typeof createLspBoundaryPeer>[] = []
    const service = createLanguageIntelligence({
      cwd: fixture.root,
      fs: createNodeFileSystem(),
      readPolicy: fixture.host.readPolicy,
      resourceFactory: (spec, request) =>
        fixture.scope.lspResources(spec, request),
      spawn: (command, argv = [], options = {}) => {
        const peer = createLspBoundaryPeer(command, argv, options, {
          holdInitialize: selectedBoundary === 'cold-start-wait',
        })
        peers.push(peer)
        return peer.child
      },
    })
    const firstStop = new AbortController()
    const first = unwrap(
      fixture.scope.action({
        actionId: 'cancelled-waiter',
        attemptId: 'attempt-1',
        basisId: 'fixture-basis',
        signal: firstStop.signal,
      }),
    )
    const second = unwrap(
      fixture.scope.action({
        actionId: 'continuing-waiter',
        attemptId: 'attempt-1',
        basisId: 'fixture-basis',
      }),
    )
    const query = (character: number) => ({
      path: 'file.ts',
      line: 1,
      character,
    })
    try {
      await observeBranchCase(fixture, async () => {
        if (selectedBoundary === 'use-admission') {
          const warm = unwrap(
            fixture.scope.action({
              actionId: 'warm-request',
              attemptId: 'attempt-1',
              basisId: 'fixture-basis',
            }),
          )
          await service.goToDefinition(query(1), {
            execution: warm.execution,
            signal: warm.signal,
          })
        }
        const cancelled = requestResult(
          service.goToDefinition(query(2), {
            execution: first.execution,
            signal: first.signal,
          }),
        )
        const continuing = service.goToDefinition(query(3), {
          execution: second.execution,
          signal: second.signal,
        })
        await waitUntil(() =>
          selectedBoundary === 'cold-start-wait'
            ? peers[0]?.methods.includes('initialize') === true
            : fixture.policy.some(
                (input) =>
                  input.facts.correlation.kind === 'action' &&
                  input.facts.correlation.actionId === 'cancelled-waiter' &&
                  input.facts.profile.active !== null,
              ),
        )
        firstStop.abort(new Error('Only the first LSP waiter was cancelled'))
        const beforeRelease = await cancelled
        expect(beforeRelease.ok).toBe(false)
        expect(first.signal?.aborted).toBe(true)
        expect(second.signal?.aborted).toBe(false)
        expect(peers).toHaveLength(1)
        expect(peers[0].resourceSignalAborted).toBe(false)
        expect(peers[0].closed).toBe(false)
        const signalBeforeRelease = peers[0].resourceSignalAborted
        peers[0].releaseInitialize()
        const secondResult = await continuing
        fixture.settlePolicies()
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(peers).toHaveLength(1)
        expect(peers[0].closed).toBe(false)
        expect(
          peers[0].messages.filter(
            (message) =>
              message.method === 'textDocument/definition' &&
              message.params?.position?.character === 2,
          ),
        ).toHaveLength(0)
        expect(
          peers[0].messages.filter(
            (message) =>
              message.method === 'textDocument/definition' &&
              message.params?.position?.character === 3,
          ),
        ).toHaveLength(1)
        const starts = fixture.events.filter(
          (event) => event.phase === 'spawn-observed',
        )
        const uses = fixture.events.filter(
          (event) => event.phase === 'resource-reused',
        )
        expect(starts).toHaveLength(1)
        expect(
          uses.some(
            (event) =>
              event.phase === 'resource-reused' &&
              event.facts.correlation.kind === 'action' &&
              event.facts.correlation.actionId === 'continuing-waiter',
          ),
        ).toBe(true)
        return fixture.recordResult({
          beforeRelease,
          secondResult,
          signalBeforeRelease,
          firstRequestAborted: first.signal?.aborted,
          secondRequestAborted: second.signal?.aborted,
          peers: peers.map((peer) => ({
            ...peer.capture,
            messages: peer.messages,
            resourceSignalAborted: peer.resourceSignalAborted,
            closed: peer.closed,
          })),
          boundary:
            'Request cancellation only; process peer and PID are synthetic, with no B20 or OS cleanup claim',
        })
      })
    } finally {
      await service.dispose()
    }
  }, 15_000)
}
