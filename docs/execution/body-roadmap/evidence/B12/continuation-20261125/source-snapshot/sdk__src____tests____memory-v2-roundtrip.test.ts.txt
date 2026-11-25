import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import {
  ProjectIdSchema,
  type MemoryEventDraft,
  type MemoryObservation,
} from '@codebuff/common/types/memory-v2'
import { OpenbuffClient } from '../client'
import { BunSQLiteMemoryRepository } from '../../../cli/src/services/memory-v2/bun-sqlite-memory-repository'
import type { MemoryRepositoryV2 } from '../services/memory-v2/types'
import {
  b12Recorder,
  B12_FACT,
  B12_DECISION,
  B12_EXCERPT,
  B12_UNRELATED,
} from './fixtures/b12-memory-agents'
import { silentLogger, startFakeLlmServer } from './fixtures/fake-llm-server'
import type { FakeLlmServer } from './fixtures/fake-llm-server'

let root: string,
  config: string,
  server: FakeLlmServer,
  repository: BunSQLiteMemoryRepository
const projectId = ProjectIdSchema.parse('project:b12-roundtrip')
const home = process.env.HOME
beforeEach(async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'b12-roundtrip-')),
  )
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(
    path.join(root, 'src/ledger.ts'),
    'export const auditCount = 7049\n',
  )
  fs.writeFileSync(
    path.join(root, 'src/style.css'),
    '.example { color: violet }\n',
  )
  server = startFakeLlmServer()
  config = path.join(root, 'config.json')
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
  const opened = await BunSQLiteMemoryRepository.open({ repositoryRoot: root })
  if (opened.status === 'error') throw new Error(opened.error.message)
  repository = opened.repository
})
afterEach(async () => {
  await repository.close()
  server.stop()
  fs.rmSync(root, { recursive: true, force: true })
  expect(process.env.HOME).toBe(home)
})
function client(port: MemoryRepositoryV2 = repository, signal?: AbortSignal) {
  return new OpenbuffClient({
    cwd: root,
    agentDefinitions: [b12Recorder],
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness-first'),
    runTimeoutMs: 15_000,
    logger: silentLogger,
    handleEvent(event) {
      if (
        signal &&
        event.type === 'tool_result' &&
        event.toolName === 'record_decision' &&
        JSON.stringify(event.output).includes(B12_UNRELATED)
      )
        cancelController?.abort(
          new Error('Owned B12 cancellation after capture'),
        )
    },
    memoryV2: {
      repository: port,
      projectId,
      authority: 'sqlite-v2-opt-in',
      capture: 'safe',
    },
    hostConfiguration: {
      environment: {
        PATH: '/usr/bin:/bin',
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
}
let cancelController: AbortController | undefined
async function observations() {
  const result = await repository.listEvents({ limit: 1000 })
  if (result.status === 'error') throw new Error(result.error.message)
  return result.events
    .filter((event) => event.eventType === 'observation.recorded')
    .map(
      (event) =>
        (event.payload as { observation: MemoryObservation }).observation,
    )
}
async function freshRead(
  state: unknown,
  prompt = 'Audit retention FACT_7049 and ledger recovery requirements',
) {
  const stateFile = path.join(root, 'run-state.json'),
    manifest = path.join(root, 'reader.json')
  fs.writeFileSync(stateFile, JSON.stringify(state))
  fs.writeFileSync(
    manifest,
    JSON.stringify({ root, config, stateFile, projectId, prompt }),
  )
  await repository.close()
  const child = spawn(
    process.execPath,
    [
      '--no-env-file',
      '--no-install',
      path.join(import.meta.dir, 'fixtures/b12-memory-reader.ts'),
      manifest,
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const out: Buffer[] = [],
    err: Buffer[] = []
  child.stdout.on('data', (bytes) => out.push(Buffer.from(bytes)))
  child.stderr.on('data', (bytes) => err.push(Buffer.from(bytes)))
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('close', resolve)
      child.once('error', reject)
    })
    expect(code, Buffer.concat(err).toString('utf8')).toBe(0)
    const value = JSON.parse(Buffer.concat(out).toString('utf8'))
    const evidenceDir = process.env.OPENBUFF_TEST_B12_EVIDENCE_DIR
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true })
      fs.writeFileSync(
        path.join(evidenceDir, `fresh-process-${crypto.randomUUID()}.json`),
        JSON.stringify(
          {
            observedAt: new Date().toISOString(),
            code,
            signal: child.signalCode,
            priorRun: state,
            resumed: value,
            providerRequests: server.requests,
            homeUnchanged: process.env.HOME === home,
          },
          null,
          2,
        ),
      )
    }
    const reopened = await BunSQLiteMemoryRepository.open({
      repositoryRoot: root,
    })
    if (reopened.status === 'error') throw new Error(reopened.error.message)
    repository = reopened.repository
    return value
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  }
}
function expectPrompt(ids: string[]) {
  expect(server.requests).toHaveLength(1)
  const messages = JSON.stringify(server.requests[0].body.messages)
  expect(messages).toContain(B12_FACT)
  expect(messages).toContain(B12_DECISION)
  expect(messages).toContain(B12_EXCERPT)
  expect(messages).not.toContain(B12_UNRELATED)
  expect(messages).not.toContain('TASK_MEMORY_CONTEXT')
  for (const id of ids) expect(messages).toContain(id)
}

describe('B12 actual local handler → SQLite → fresh process → next core prompt', () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const)
    test(`${status} retains explicit own fact, decision and rationale across a new process`, async () => {
      cancelController =
        status === 'cancelled' ? new AbortController() : undefined
      const result = await client(repository, cancelController?.signal).run({
        agent: b12Recorder.id,
        prompt: 'Record audit recovery evidence',
        params: { finish: status },
        signal: cancelController?.signal,
      })
      expect(
        result.runOutcome?.termination,
        JSON.stringify(result.output),
      ).toBe(status)
      expect(server.requests).toEqual([])
      const recorded = await observations()
      const fact = recorded.find(
        (observation) => observation.summary === B12_FACT,
      )
      const decision = recorded.find(
        (observation) => observation.summary === B12_DECISION,
      )
      expect(fact).toBeDefined()
      expect(decision).toBeDefined()
      expect(fact?.kind).toBe('fact')
      expect(decision?.kind).toBe('decision')
      expect(fact?.detail).toContain(B12_EXCERPT)
      const restored = await freshRead(result)
      expect(restored.authority.active).toBe('sqlite-v2-opt-in')
      expect(restored.authority.fallbackOccurred).toBe(false)
      expect(
        restored.queries.every(
          (query: Record<string, unknown>) => !Object.hasOwn(query, 'taskId'),
        ),
      ).toBe(true)
      expect(restored.memory.activeTask.taskId).not.toBe(
        result.sessionState?.mainAgentState.memoryV2?.activeTask.taskId,
      )
      expectPrompt([fact!.observationId, decision!.observationId])
    }, 30_000)

  for (const status of ['completed', 'failed', 'cancelled'] as const)
    for (const failure of ['precommit', 'lost-ack'] as const)
      test(`${status} ${failure} terminal checkpoint reconciles unchanged identities after reopen`, async () => {
        let failedBatch: MemoryEventDraft[] | undefined
        const original = repository.append.bind(repository)
        const port: MemoryRepositoryV2 = {
          append: async (request) => {
            if (
              !failedBatch &&
              request.events.some(
                (event) => event.eventType === 'session.ended',
              )
            ) {
              failedBatch = structuredClone(request.events)
              if (failure === 'lost-ack') await original(request)
              return {
                outcome: 'failed',
                error: {
                  code: 'unavailable',
                  message: 'Owned terminal append failure',
                  retryable: true,
                },
              }
            }
            return original(request)
          },
          query: (request) => repository.query(request),
          verify: (request) => repository.verify(request),
          health: (request) => repository.health(request),
          export: (request) => repository.export(request),
          rebuild: (request) => repository.rebuild(request),
          getClaimDedup: (request) => repository.getClaimDedup(request),
          getObservationStatus: (request) =>
            repository.getObservationStatus(request),
        }
        cancelController =
          status === 'cancelled' ? new AbortController() : undefined
        const result = await client(port, cancelController?.signal).run({
          agent: b12Recorder.id,
          prompt: 'Record audit evidence then settle',
          params: { finish: status },
          signal: cancelController?.signal,
        })
        expect(failedBatch).toBeDefined()
        expect(result.sessionState?.mainAgentState.memoryV2?.turn.status).toBe(
          'finishing',
        )
        expect(
          result.sessionState?.mainAgentState.memoryV2?.pendingTerminal?.status,
        ).toBe(status)
        const recorded = await observations(),
          fact = recorded.find(
            (observation) => observation.summary === B12_FACT,
          )
        expect(fact).toBeDefined()
        const restored = await freshRead(result)
        for (const event of failedBatch!)
          expect(
            restored.events.some(
              (item: { eventId: string }) => item.eventId === event.eventId,
            ),
          ).toBe(true)
        const oldTerminal = restored.events.find(
          (item: {
            eventType: string
            payload: { status: string }
            sessionId: string
          }) =>
            item.eventType === 'session.ended' &&
            item.sessionId ===
              result.sessionState?.mainAgentState.memoryV2?.sessionId,
        )
        expect(oldTerminal?.payload.status).toBe(status)
        const before = await repository.listEvents({ limit: 1000 })
        const retried = await repository.append({
          schemaVersion: 2,
          projectId,
          events: failedBatch!,
        })
        expect(retried.outcome).toBe('appended')
        if (retried.outcome === 'appended')
          expect(retried.entries.every((entry) => entry.duplicate)).toBe(true)
        expect(await repository.listEvents({ limit: 1000 })).toEqual(before)
        expectPrompt([fact!.observationId])
      }, 30_000)

  test('caller cancellation does not settle the SDK before its terminal memory append', async () => {
    let arrived!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = repository.append.bind(repository)
    const port: MemoryRepositoryV2 = {
      append: async (request) => {
        if (
          request.events.some((event) => event.eventType === 'session.ended')
        ) {
          arrived()
          await gate
        }
        return original(request)
      },
      query: (request) => repository.query(request),
      verify: (request) => repository.verify(request),
      health: (request) => repository.health(request),
      export: (request) => repository.export(request),
      rebuild: (request) => repository.rebuild(request),
      getClaimDedup: (request) => repository.getClaimDedup(request),
      getObservationStatus: (request) =>
        repository.getObservationStatus(request),
    }
    cancelController = new AbortController()
    let settled = false
    const pending = client(port, cancelController.signal)
      .run({
        agent: b12Recorder.id,
        prompt: 'Record audit evidence then cancel',
        params: { finish: 'cancelled' },
        signal: cancelController.signal,
      })
      .then((result) => {
        settled = true
        return result
      })
    try {
      await Promise.race([
        entered,
        pending.then(() => {
          throw new Error('SDK returned before terminal append started')
        }),
      ])
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(settled).toBe(false)
    } finally {
      release()
    }
    const result = await pending
    expect(result.runOutcome?.termination).toBe('cancelled')
    expect(result.sessionState?.mainAgentState.memoryV2?.turn.status).toBe(
      'cancelled',
    )
    const events = await repository.listEvents({ limit: 1000 })
    if (events.status === 'error') throw new Error(events.error.message)
    expect(
      events.events.some(
        (event) =>
          event.eventType === 'session.ended' &&
          (event.payload as { status: string }).status === 'cancelled',
      ),
    ).toBe(true)
  }, 20_000)

  test('genuinely captured ranked facts exceed 12k while the complete high-ranked claim survives', async () => {
    cancelController = undefined
    const result = await client().run({
      agent: b12Recorder.id,
      prompt: 'Record audit ledger facts',
      params: { finish: 'completed', fill: 20 },
    })
    const recorded = await observations()
    expect(
      recorded.filter((observation) => observation.kind === 'fact').length,
    ).toBeGreaterThanOrEqual(22)
    await freshRead(
      result,
      'Audit retention FACT_7049 exactly 7049 entries never 7048 ledger recovery',
    )
    expectPrompt([
      recorded.find((observation) => observation.summary === B12_FACT)!
        .observationId,
    ])
    const memoryText = (
      server.requests[0].body.messages as Array<{ content: unknown }>
    )
      .map((message) => JSON.stringify(message.content))
      .find((text) => text.includes('Memory V2 retrieval context'))
    expect(memoryText).toBeDefined()
  }, 35_000)
})
