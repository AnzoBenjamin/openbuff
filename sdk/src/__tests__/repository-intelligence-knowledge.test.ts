import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  MemoryAppendRequestSchema,
  MemoryEventDraftSchema,
  ProjectIdSchema,
  type MemoryObservation,
} from '@codebuff/common/types/memory-v2'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { RepositoryContextPacket } from '@codebuff/common/types/contracts/repository-intelligence'
import { getExactContentHash } from '@codebuff/common/util/content-hash'
import { BunSQLiteMemoryRepository } from '../../../cli/src/services/memory-v2/bun-sqlite-memory-repository'
import { OpenbuffClient } from '../client'
import { nodeConfigReadFs } from '../host-config'
import type { OpenbuffClientOptions } from '../run'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { RepositoryIntelligenceService } from '../services/repository-intelligence'

const roots: string[] = []
const repositories: BunSQLiteMemoryRepository[] = []
const children: ChildProcess[] = []
const projectId = ProjectIdSchema.parse('project-fresh-knowledge')
const at = '2026-11-01T00:00:00.000Z'
const summary = 'Feature routing joins request state with repository knowledge'

afterEach(async () => {
  const exited = children.splice(0).map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null)
          return resolve()
        child.once('close', () => resolve())
        child.kill('SIGKILL')
      }),
  )
  await Promise.allSettled(exited)
  for (const repository of repositories.splice(0)) await repository.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-fresh-memory-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  const source =
    'export function featureRoute(request: unknown) { return request }\n'
  writeFileSync(join(root, 'src/feature.ts'), source)
  const opened = await BunSQLiteMemoryRepository.open({ repositoryRoot: root })
  if (opened.status !== 'ok') throw new Error(opened.error.kind)
  repositories.push(opened.repository)
  const observation: MemoryObservation = {
    observationId:
      'observation-feature-route' as MemoryObservation['observationId'],
    taskId: 'task-prior-session' as MemoryObservation['taskId'],
    kind: 'discovery',
    summary,
    detail:
      'The request entry point delegates feature routing into the repository intelligence consumer.',
    confidence: 0.9,
    tags: ['feature-routing'],
    observedAt: at,
    selectors: [{ kind: 'file', path: 'src/feature.ts' }],
    provenance: {
      origin: 'repository',
      recordedBy: 'prior-session',
      sourceEventIds: [],
      metadata: {},
    },
    evidence: [
      {
        selector: { kind: 'file', path: 'src/feature.ts' },
        artifact: {
          artifactId: 'artifact-feature-route',
          location: 'src/feature.ts',
          classification: {
            kind: 'source',
            generated: false,
            sensitivity: 'internal',
            labels: [],
          },
        },
        contentDigest: getExactContentHash(source),
        capturedAt: at,
        provenance: {
          origin: 'repository',
          recordedBy: 'prior-session',
          sourceEventIds: [],
          metadata: {},
        },
      },
    ],
  }
  const draft = (type: string, id: string, payload: unknown) =>
    MemoryEventDraftSchema.parse({
      schemaVersion: 2,
      eventSchemaVersion: 1,
      eventType: type,
      eventId: id,
      projectId,
      sessionId: 'session-prior',
      occurredAt: at,
      payload,
    })
  const appended = await opened.repository.append(
    MemoryAppendRequestSchema.parse({
      schemaVersion: 2,
      projectId,
      events: [
        draft('observation.recorded', 'event-prior-feature', {
          payloadSchemaVersion: 1,
          observation,
        }),
        draft('claim.pinned', 'event-prior-pin', {
          payloadSchemaVersion: 1,
          observationId: observation.observationId,
          reason: 'Reusable feature architecture',
          pinnedBy: 'operator',
          pinnedAt: at,
        }),
        draft('evidence.verified', 'event-prior-verification', {
          payloadSchemaVersion: 1,
          observationId: observation.observationId,
          selector: observation.evidence[0]!.selector,
          observedDigest: observation.evidence[0]!.contentDigest,
          verifiedAt: at,
          verifier: 'exact-source-read',
          workspaceRevision: 1,
          workspaceSnapshotId: 'prior-workspace',
        }),
      ],
    }),
  )
  expect(appended.outcome).toBe('appended')
  await opened.repository.upsertPlaybookByTriggerSignature({
    workspaceId: projectId,
    title: 'Parent source delivery',
    instruction:
      'When the parent prepares delivery, require a valid repository check receipt.',
    trigger: {
      tool: 'spawn_agents',
      spawnAgentType: 'git-committer',
      requireEvidence: [
        { kind: 'validationSucceeded', validationKinds: ['ci-local'] },
      ],
    },
    scope: {
      repos: [projectId],
      glob: ['src/**'],
      agentTypes: ['memory-parent'],
    },
    status: 'active',
    enforcement: 'warn',
    provenance: {
      origin: 'user',
      recordedBy: 'operator',
      sourceEventIds: [],
      metadata: {},
    },
  })
  await opened.repository.upsertPlaybookByTriggerSignature({
    workspaceId: projectId,
    title: 'Child scoped review',
    instruction:
      'Before the child commits source changes, require a valid repository check receipt.',
    trigger: {
      tool: 'run_terminal_command',
      terminalAction: 'git-commit',
      requireEvidence: [
        { kind: 'validationSucceeded', validationKinds: ['ci-local'] },
      ],
    },
    scope: {
      repos: [projectId],
      glob: ['src/**'],
      agentTypes: ['memory-child'],
    },
    status: 'verified',
    enforcement: 'warn',
    provenance: {
      origin: 'user',
      recordedBy: 'operator',
      sourceEventIds: [],
      metadata: {},
    },
  })
  await opened.repository.upsertPlaybookByTriggerSignature({
    workspaceId: projectId,
    title: 'Unrelated UI procedure',
    instruction: 'For UI delivery, preserve the screenshot approval condition.',
    trigger: {
      tool: 'run_terminal_command',
      terminalAction: 'git-commit',
      requireEvidence: [],
    },
    scope: {
      repos: [projectId],
      glob: ['web/**'],
      agentTypes: ['memory-parent', 'memory-child'],
    },
    status: 'active',
    enforcement: 'warn',
    provenance: {
      origin: 'user',
      recordedBy: 'operator',
      sourceEventIds: [],
      metadata: {},
    },
  })
  return { root, repository: opened.repository, observation, source }
}

function memory(repository: BunSQLiteMemoryRepository) {
  return {
    repository,
    projectId,
    authority: 'sqlite-v2-opt-in' as const,
    capture: 'off' as const,
  }
}

describe('durable knowledge before actor execution', () => {
  test('a stalled source attestation cannot block the first actor context indefinitely', async () => {
    const { root, repository } = await fixture()
    const fs = createNodeFileSystem()
    fs.realpath = () => new Promise<never>(() => {})
    const service = new RepositoryIntelligenceService({
      cwd: root,
      fs,
      memory: memory(repository),
    })
    const startedAt = Date.now()
    const packet = await service.prepare({
      actor: {
        runId: 'bounded-root',
        rootRunId: 'bounded-root',
        agentId: 'main-agent',
      },
      agentType: 'memory-parent',
      userInputId: 'bounded-input',
      query: 'Continue feature routing in src/feature.ts',
      deadlineMs: Date.now() + 50,
    })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(packet.freshness).toBe('degraded')
    expect(packet.reasons).toContain('knowledge-query-failed')
    expect(packet.knowledge).toBeUndefined()
  })

  test('two real fresh SDK runs and transcript-isolated children recall a real persisted fact before handleSteps', async () => {
    const { root, repository, source } = await fixture()
    const configPath = join(root, 'openbuff.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        autoFileChangeHooks: false,
        indexing: { enabled: false },
        providers: {
          fixture: {
            type: 'openai-compatible',
            baseURL: 'https://fixture.invalid/v1',
            models: ['fixture-model'],
            apiKeyEnv: 'FIXTURE_MODEL_KEY',
          },
        },
      }),
    )
    const packets: Array<{
      actor: RepositoryContextPacket['actor']
      role: string
      briefing: string
      metrics: RepositoryContextPacket['metrics']
      freshness: RepositoryContextPacket['freshness']
      verified: boolean
      stage: string
      observedAt: number
    }> = []
    const attestationReads: Array<{ path: string; digest: string }> = []
    const runs: Array<{
      label: string
      startedAt: number
      elapsedMs: number
      sourceAttestationReads: Array<{ path: string; digest: string }>
      actors: typeof packets
    }> = []
    let featureReads = 0,
      terminalLaunches = 0,
      networkAttempts = 0
    const fs = createNodeFileSystem()
    const observedFs = Object.create(fs, {
      readFile: {
        value: (async (file, ...args) => {
          const content = await fs.readFile(file, ...args)
          if (String(file) === join(root, 'src/feature.ts')) {
            featureReads++
            attestationReads.push({
              path: 'src/feature.ts',
              digest: getExactContentHash(
                typeof content === 'string'
                  ? content
                  : content.toString('utf8'),
              ),
            })
          }
          return content
        }) as typeof fs.readFile,
      },
    }) as typeof fs
    const forbidNetwork = () => {
      networkAttempts++
      throw new Error('Memory fixture cannot use a network')
    }
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(async () => forbidNetwork(), { preconnect: forbidNetwork }),
    )
    const defaults: OpenbuffClientOptions = {
      cwd: root,
      projectFiles: {},
      knowledgeFiles: {},
      fsSource: observedFs,
      harnessStateDir: join(root, 'harness'),
      approvalMode: 'allow-all',
      configReadFs: nodeConfigReadFs,
      hostConfiguration: {
        environment: {
          PATH: '/usr/bin:/bin',
          OPENBUFF_PROCESS_SUPERVISION: '0',
          OPENBUFF_TELEMETRY: '0',
          DO_NOT_TRACK: '1',
          FIXTURE_MODEL_KEY: 'fixture-secret',
        },
        platform: 'linux',
        invocationCwd: root,
        projectRoot: root,
        home: { kind: 'none' },
        globals: { kind: 'disabled' },
        selection: { kind: 'explicit', path: configPath, required: true },
        trust: { ancestorConfig: false, projectReadableRoots: false },
      },
      recordExecution: (event) => {
        if (
          event.phase === 'spawn-observed' &&
          event.facts.branchId === 'terminal.sync'
        )
          terminalLaunches++
      },
      spawnSource: (command, argv, options) => {
        const child = spawn(command, [...(argv ?? [])], options ?? {})
        children.push(child)
        return child
      },
    }
    const collect = (value: unknown) => {
      if (typeof value === 'string') {
        try {
          collect(JSON.parse(value))
        } catch {}
        return
      }
      if (!value || typeof value !== 'object') return
      const receipt = value as (typeof packets)[number]
      if (
        receipt.stage === 'before-first-yield' &&
        receipt.actor &&
        receipt.role
      ) {
        if (
          !packets.some((packet) => packet.actor.runId === receipt.actor.runId)
        )
          packets.push(receipt)
        return
      }
      for (const nested of Object.values(value)) collect(nested)
    }
    const child: AgentDefinition = {
      id: 'memory-child',
      displayName: 'Independent child',
      model: 'fixture-model',
      includeMessageHistory: false,
      toolNames: ['set_output'],
      outputMode: 'structured_output',
      handleSteps: function* ({ agentState }) {
        const packet = agentState.repositoryContext
        const verified = Boolean(
          packet?.metrics.reused &&
          packet.briefing.includes(
            'Verified: Feature routing joins request state with repository knowledge',
          ),
        )
        if (!packet || !verified)
          throw new Error(
            `Durable child knowledge missing before its first yield: ${JSON.stringify(packet)}`,
          )
        yield {
          toolName: 'set_output',
          input: {
            stage: 'before-first-yield',
            actor: packet.actor,
            role: packet.agentType,
            briefing: packet.briefing,
            metrics: packet.metrics,
            freshness: packet.freshness,
            observedAt: Date.now(),
            verified,
          },
        }
      },
    }
    const parent: AgentDefinition = {
      id: 'memory-parent',
      displayName: 'Fresh root actor',
      model: 'fixture-model',
      toolNames: ['spawn_agents', 'set_output'],
      spawnableAgents: [child.id],
      outputMode: 'structured_output',
      handleSteps: function* ({ agentState }) {
        const packet = agentState.repositoryContext
        const verified = Boolean(
          packet?.metrics.reused &&
          packet.briefing.includes(
            'Verified: Feature routing joins request state with repository knowledge',
          ),
        )
        if (!packet || !verified)
          throw new Error(
            'Durable root knowledge missing before its first yield',
          )
        const receipt = {
          stage: 'before-first-yield',
          actor: packet.actor,
          role: packet.agentType,
          briefing: packet.briefing,
          metrics: packet.metrics,
          freshness: packet.freshness,
          observedAt: Date.now(),
          verified,
        }
        const { toolResult } = yield {
          toolName: 'spawn_agents',
          input: {
            agents: [
              {
                agent_type: 'memory-child',
                prompt:
                  'Continue the feature architecture in src/feature.ts using repository knowledge.',
              },
            ],
          },
        }
        yield {
          toolName: 'set_output',
          input: { root: receipt, child: toolResult },
        }
      },
    }
    try {
      const firstStartedAt = Date.now(),
        firstStart = performance.now()
      const first = await new OpenbuffClient(defaults).run({
        agent: parent,
        prompt: 'Continue feature architecture in src/feature.ts',
        agentDefinitions: [child],
        memoryV2: memory(repository),
      })
      const firstElapsedMs = performance.now() - firstStart
      if (first.output.type === 'error')
        throw new Error(JSON.stringify(first.output))
      expect(first.output.type).toBe('structuredOutput')
      if (first.output.type === 'structuredOutput') collect(first.output.value)
      runs.push({
        label: 'fresh-one',
        startedAt: firstStartedAt,
        elapsedMs: firstElapsedMs,
        sourceAttestationReads: attestationReads.slice(),
        actors: packets.slice(),
      })
      expect(packets.map((packet) => packet.role)).toEqual([
        'memory-parent',
        'memory-child',
      ])
      expect(
        first.sessionState?.mainAgentState.repositoryContext?.playbooks.some(
          (rule) => rule.title === 'Parent source delivery',
        ),
      ).toBe(true)
      expect(
        first.sessionState?.mainAgentState.repositoryContext?.playbooks.some(
          (rule) =>
            ['Child scoped review', 'Unrelated UI procedure'].includes(
              rule.title,
            ),
        ),
      ).toBe(false)
      await repository.close()
      const opened = await BunSQLiteMemoryRepository.open({
        repositoryRoot: root,
      })
      if (opened.status !== 'ok') throw new Error(opened.error.kind)
      repositories.push(opened.repository)
      const secondReadStart = attestationReads.length,
        secondStartedAt = Date.now(),
        secondStart = performance.now()
      const second = await new OpenbuffClient(defaults).run({
        agent: parent,
        prompt: 'Continue feature architecture in src/feature.ts',
        agentDefinitions: [child],
        memoryV2: memory(opened.repository),
      })
      const secondElapsedMs = performance.now() - secondStart
      if (second.output.type === 'error')
        throw new Error(JSON.stringify(second.output))
      expect(second.output.type).toBe('structuredOutput')
      if (second.output.type === 'structuredOutput')
        collect(second.output.value)
      runs.push({
        label: 'fresh-two-after-reopen',
        startedAt: secondStartedAt,
        elapsedMs: secondElapsedMs,
        sourceAttestationReads: attestationReads.slice(secondReadStart),
        actors: packets.slice(2),
      })
      expect(first.sessionState?.mainAgentState.runId).not.toBe(
        second.sessionState?.mainAgentState.runId,
      )
      expect(packets.map((packet) => packet.role)).toEqual([
        'memory-parent',
        'memory-child',
        'memory-parent',
        'memory-child',
      ])
      expect(
        new Set(packets.map((packet) => packet.actor.rootRunId)).size,
      ).toBe(2)
      expect(packets[0]?.actor.runId).not.toBe(packets[1]?.actor.runId)
      expect(packets[2]?.actor.runId).not.toBe(packets[3]?.actor.runId)
      for (const packet of packets) {
        expect(packet.verified).toBe(true)
        expect(packet.briefing).toContain(summary)
        expect(packet.briefing).toContain('src/feature.ts')
        expect(packet.metrics.indexedCandidates).toBe(0)
        expect(packet.metrics.rememberedFacts).toBeGreaterThanOrEqual(1)
        expect(packet.freshness).toBe('current')
      }
      expect(featureReads).toBeGreaterThanOrEqual(4)
      for (const run of runs) {
        expect(run.actors).toHaveLength(2)
        expect(run.sourceAttestationReads.length).toBeGreaterThanOrEqual(2)
        expect(
          run.sourceAttestationReads.every(
            (read) => read.digest === getExactContentHash(source),
          ),
        ).toBe(true)
      }
      expect(terminalLaunches).toBe(0)
      expect(networkAttempts).toBe(0)
      expect(fetch.mock.calls).toHaveLength(0)
      const evidencePath = process.env.OPENBUFF_KNOWLEDGE_EVIDENCE_PATH
      if (evidencePath) {
        const path = resolve(evidencePath)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(
          path,
          JSON.stringify(
            {
              schemaVersion: 1,
              scenario:
                'two fresh SDK runs with transcript-isolated children and real reopened SQLite knowledge',
              capturedAt: new Date().toISOString(),
              modelNetworkAttempts: networkAttempts,
              terminalToolLaunches: terminalLaunches,
              sourceIndexCandidates: 0,
              expectedSourceDigest: getExactContentHash(source),
              timingScope:
                'observed integration latency; no baseline or speedup comparison',
              hitCountScope:
                'rememberedFacts counts category hits; the same fact may appear in verified and reusable categories',
              runs,
            },
            null,
            2,
          ) + '\n',
        )
      }
    } finally {
      fetch.mockRestore()
    }
  }, 30_000)

  test('fresh actors reuse unchanged dependencies across workspace revisions and reread a changed source', async () => {
    const { root, repository } = await fixture()
    let workspace = { revision: 2, snapshotId: 'unrelated-workspace' }
    const service = new RepositoryIntelligenceService({
      cwd: root,
      fs: createNodeFileSystem(),
      memory: memory(repository),
      currentWorkspace: () => workspace,
    })
    writeFileSync(
      join(root, 'src/unrelated.ts'),
      'export const unrelated = true\n',
    )
    const first = await service.prepare({
      actor: {
        runId: 'run-fresh-one',
        rootRunId: 'root-fresh-one',
        agentId: 'actor-one',
      },
      agentType: 'memory-parent',
      userInputId: 'input-one',
      query: 'Continue feature architecture in src/feature.ts',
    })
    expect(first.knowledge?.result.verifiedKnowledge).toHaveLength(1)
    expect(first.knowledge?.result.rereadRequired).toEqual([])
    writeFileSync(
      join(root, 'src/feature.ts'),
      'export function featureRoute() { return null }\n',
    )
    workspace = { revision: 3, snapshotId: 'changed-source' }
    const changed = await service.prepare({
      actor: {
        runId: 'run-fresh-two',
        rootRunId: 'root-fresh-two',
        agentId: 'actor-two',
      },
      agentType: 'memory-child',
      userInputId: 'input-two',
      query: 'Continue feature architecture in src/feature.ts',
    })
    expect(changed.knowledge?.result.verifiedKnowledge).toEqual([])
    expect(changed.knowledge?.result.rereadRequired[0]?.reason).toBe('changed')
    expect(changed.actor.rootRunId).not.toBe(first.actor.rootRunId)
    expect(changed.playbooks.map((rule) => rule.title)).toEqual([
      'Child scoped review',
    ])
    expect(readFileSync(join(root, 'src/feature.ts'), 'utf8')).toContain(
      'return null',
    )
  })
})
