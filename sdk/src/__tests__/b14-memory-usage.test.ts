import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenbuffClient } from '../client'
import { BunSQLiteMemoryRepository } from '../../../cli/src/services/memory-v2/bun-sqlite-memory-repository'
import {
  MemoryEventDraftSchema,
  ProjectIdSchema,
} from '@codebuff/common/types/memory-v2'
import { getExactContentHash } from '@codebuff/common/util/content-hash'
import { startFakeLlmServer, silentLogger } from './fixtures/fake-llm-server'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

const owned: string[] = [],
  repositories: BunSQLiteMemoryRepository[] = [],
  servers: ReturnType<typeof startFakeLlmServer>[] = []
afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close()
  for (const server of servers.splice(0)) server.stop()
  for (const root of owned.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
const agent: AgentDefinition = {
  id: 'b14-reader',
  displayName: 'B14 reader',
  toolNames: ['read_files', 'set_output'],
  outputMode: 'structured_output',
  handleSteps: function* ({ params }) {
    yield 'STEP'
    yield { toolName: 'read_files', input: { paths: [String(params?.path)] } }
    yield { toolName: 'set_output', input: { ok: true } }
  },
}

for (const scenario of [
  'unchanged-a',
  'unrelated-c',
  'required-refresh',
  'changed-after-emission',
] as const)
  test(`B14 actual SDK request/read ${scenario} retains only justified efficiency signals`, async () => {
    const selected = scenario === 'unrelated-c' ? 'c' : 'a'
    const home = process.env.HOME,
      root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-b14-usage-')),
      )
    owned.push(root)
    fs.mkdirSync(path.join(root, 'src'))
    for (const file of ['a', 'b', 'c'])
      fs.writeFileSync(
        path.join(root, `src/${file}.ts`),
        `export const ${file} = 1\n`,
      )
    const server = startFakeLlmServer()
    servers.push(server)
    const config = path.join(root, 'provider.json')
    fs.writeFileSync(
      config,
      JSON.stringify({
        defaultModel: 'fixture/model',
        indexing: { enabled: false },
        providers: {
          fixture: {
            type: 'openai-compatible',
            baseURL: `${server.baseURL}/v1`,
            models: ['model'],
          },
        },
      }),
    )
    const opened = await BunSQLiteMemoryRepository.open({
      repositoryRoot: root,
    })
    if (opened.status === 'error') throw new Error(opened.error.message)
    const repository = opened.repository
    repositories.push(repository)
    const projectId = ProjectIdSchema.parse('project:b14-usage'),
      at = new Date().toISOString()
    for (const id of ['a', 'b']) {
      const selector = { kind: 'file', path: `src/${id}.ts` },
        digest = getExactContentHash(
          fs.readFileSync(path.join(root, selector.path), 'utf8'),
        )
      const observation = {
        observationId: `observation:b14-${id}`,
        taskId: 'task:old',
        kind: 'discovery',
        summary: `Routing B14 source ${id} evidence`,
        detail: `The routing B14 source ${id} value stays one.`,
        confidence: 0.9,
        selectors: [selector],
        tags: ['routing'],
        observedAt: at,
        provenance: {
          origin: 'repository',
          recordedBy: 'fixture',
          sourceEventIds: [],
          metadata: {},
        },
        evidence: [
          {
            selector,
            artifact: {
              artifactId: `artifact:${id}`,
              location: selector.path,
              classification: {
                kind: 'source',
                generated: false,
                sensitivity: 'internal',
                labels: [],
              },
            },
            provenance: {
              origin: 'repository',
              recordedBy: 'fixture',
              sourceEventIds: [],
              metadata: {},
            },
            capturedAt: at,
            contentDigest: digest,
            excerpt: `export const ${id} = 1`,
          },
        ],
      }
      const event = MemoryEventDraftSchema.parse({
        schemaVersion: 2,
        eventSchemaVersion: 1,
        eventType: 'observation.recorded',
        eventId: `event:b14-${id}`,
        projectId,
        sessionId: 'session:old',
        occurredAt: at,
        payload: { payloadSchemaVersion: 1, observation },
      })
      expect(
        (
          await repository.append({
            schemaVersion: 2,
            projectId,
            events: [event],
          })
        ).outcome,
      ).toBe('appended')
      expect(
        (
          await repository.verify({
            schemaVersion: 2,
            projectId,
            sessionId: 'session:verify',
            action: {
              kind: 'verify',
              observationId: `observation:b14-${id}`,
              selector,
              observedDigest: digest,
            },
          } as never)
        ).outcome,
      ).toBe('recorded')
    }
    const observedEvents: unknown[] = []
    const client = new OpenbuffClient({
      cwd: root,
      agentDefinitions: [agent],
      projectFiles: {},
      knowledgeFiles: {},
      userKnowledgeFiles: {},
      ...(scenario === 'required-refresh'
        ? { repositoryIntelligence: false as const }
        : {}),
      harnessStateDir: path.join(root, 'harness'),
      logger: silentLogger,
      handleEvent(event) {
        observedEvents.push(event)
        if (
          scenario === 'changed-after-emission' &&
          event.type === 'text' &&
          server.requests.length
        )
          fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 2\n')
      },
      memoryV2: {
        repository,
        projectId,
        authority: 'sqlite-v2-opt-in',
        capture: 'safe',
      },
      hostConfiguration: {
        environment: {
          PATH: process.env.PATH,
          OPENBUFF_PROCESS_SUPERVISION: '0',
          OPENBUFF_TELEMETRY: '0',
          DO_NOT_TRACK: '1',
        },
        platform: process.platform,
        invocationCwd: root,
        projectRoot: root,
        home: { kind: 'none' },
        globals: { kind: 'disabled' },
        selection: { kind: 'explicit', path: config, required: true },
        trust: { ancestorConfig: false, projectReadableRoots: false },
      },
    })
    const result = await client.run({
      agent: agent.id,
      prompt: 'Inspect routing B14 source evidence without changing it.',
      params: { path: `src/${selected}.ts` },
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(server.requests).toHaveLength(1)
    const request = JSON.stringify(server.requests[0].body.messages)
    expect(request).toContain('observation:b14-a')
    expect(request).toContain('observation:b14-b')
    expect(
      [
        ...(result.sessionState?.mainAgentState.memoryV2EmittedObservationIds ??
          []),
      ].sort(),
    ).toEqual(['observation:b14-a', 'observation:b14-b'])
    const events = await repository.listEvents({ limit: 1000 })
    if (events.status === 'error') throw new Error(events.error.message)
    const reuse = events.events
      .filter((event) => event.eventType === 'observation.reused')
      .map(
        (event) =>
          event.payload as {
            ignored: Array<{ observationId: string; mechanism: string }>
          },
      )
    expect(
      reuse.flatMap((event) => event.ignored),
      JSON.stringify({
        receipt: result.sessionState?.mainAgentState.memoryUsageTurn,
        live: result.sessionState?.mainAgentState.memoryReuse,
        context: result.sessionState?.mainAgentState.memoryV2Context,
      }),
    ).toEqual(
      scenario === 'unchanged-a'
        ? [{ observationId: 'observation:b14-a', mechanism: 'reread-despite' }]
        : [],
    )
    const usage = await repository.getUsage({ projectId })
    expect(usage.status).toBe('ok')
    if (usage.status === 'ok')
      expect(
        usage.usage
          .filter((row) => row.ignoredCount > 0)
          .map((row) => row.observationId),
      ).toEqual(scenario === 'unchanged-a' ? ['observation:b14-a'] : [])
    const capture = process.env.OPENBUFF_TEST_B14_EVIDENCE_DIR
    if (capture) {
      fs.mkdirSync(capture, { recursive: true })
      fs.writeFileSync(
        path.join(capture, `${scenario}.json`),
        JSON.stringify(
          {
            scenario,
            providerRequests: server.requests,
            observedEvents,
            emitted:
              result.sessionState?.mainAgentState.memoryV2EmittedObservationIds,
            context: result.sessionState?.mainAgentState.memoryV2Context,
            canonicalEvents: events.events,
            usage,
            homeUnchanged: process.env.HOME === home,
          },
          null,
          2,
        ),
      )
    }
    expect(process.env.HOME).toBe(home)
  }, 20_000)
