import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { OpenbuffClient } from '../client'
import { createRequestAdmissionStore } from '../services/request-admission-store'
import { silentLogger } from './fixtures/fake-llm-server'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

let root: string
let harness: string
let configPath: string
let requests: Array<Record<string, unknown>>
let server: ReturnType<typeof Bun.serve>

const child: AgentDefinition = {
  id: 'admission-child',
  displayName: 'Admission child',
  model: 'fixture/model',
  toolNames: [],
  systemPrompt: 'Say ok and stop.',
}

const parent: AgentDefinition = {
  id: 'admission-parent',
  displayName: 'Admission parent',
  model: 'fixture/model',
  toolNames: ['spawn_agents', 'set_output'],
  spawnableAgents: ['admission-child'],
  outputMode: 'structured_output',
  handleSteps: function* () {
    const children = yield {
      toolName: 'spawn_agents',
      input: {
        agents: [
          { agent_type: 'admission-child', prompt: 'First sibling.' },
          { agent_type: 'admission-child', prompt: 'Second sibling.' },
        ],
      },
    }
    yield { toolName: 'set_output', input: { children: children.toolResult } }
  },
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-admission-run-')),
  )
  harness = path.join(root, 'harness')
  requests = []
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>)
      await Bun.sleep(30)
      const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
      return new Response(
        data({
          id: 'admission-run',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'ok' },
              finish_reason: null,
            },
          ],
        }) +
          data({
            id: 'admission-run',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  configPath = path.join(root, 'openbuff.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultModel: 'fixture/model',
      spending: {
        mode: 'strict-capped',
        capCents: 0.5,
        currency: 'USD',
      },
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          models: ['model'],
          defaultCapabilities: {
            context: { windowTokens: 10_000, outputTokens: 100 },
            pricing: {
              inputPerMillionTokens: 0.3,
              outputPerMillionTokens: 15,
              currency: 'USD',
            },
          },
        },
      },
    }),
  )
})

afterEach(() => {
  server.stop(true)
  fs.rmSync(root, { recursive: true, force: true })
})

function client(supervised: boolean) {
  return new OpenbuffClient({
    cwd: root,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: harness,
    logger: silentLogger,
    handleEvent() {},
    runTimeoutMs: 20_000,
    hostConfiguration: {
      environment: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: supervised ? '1' : '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
      },
      platform: process.platform,
      invocationCwd: root,
      projectRoot: root,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'explicit', path: configPath, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  })
}

describe('B09 SDK root/child/restart admission', () => {
  for (const supervised of [false, true])
    test(`two actual descendants share one root authority (supervised ${supervised})`, async () => {
      const result = await client(supervised).run({
        agent: parent,
        agentDefinitions: [child],
        prompt: 'Run both children.',
      })
      expect(
        result.runOutcome?.termination,
        JSON.stringify(result.output),
      ).toBe('completed')
      expect(requests, JSON.stringify(result.output)).toHaveLength(1)
      expect(JSON.stringify(result.output)).toContain('request_spend_refused')
      expect(result.requestAdmission).toMatchObject({
        heldUsdMicros: 450_000,
        activeAttempts: 0,
      })
      const reference =
        result.sessionState?.requestAdmission ??
        result.sessionState?.mainAgentState.requestAdmission
      expect(reference).toBeDefined()
      const store = createRequestAdmissionStore({
        directory: path.join(harness, 'request-admission'),
      })
      expect(store.snapshot(reference!.authorityId)).toMatchObject({
        heldUsdMicros: 450_000,
        activeAttempts: 0,
      })
    }, 25_000)

  test('an explicit uncapped run overrides configured finite admission without persisting the override', async () => {
    const result = await client(false).run({
      agent: parent,
      agentDefinitions: [child],
      prompt: 'Run both children.',
      spending: { mode: 'uncapped' },
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(requests).toHaveLength(2)
    expect(result.sessionState?.requestAdmission).toBeUndefined()
    expect(result.sessionState?.mainAgentState.requestAdmission).toBeUndefined()
  })

  test('legacy root maxCostCents migrates to one strict shared authority', async () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    delete config.spending
    fs.writeFileSync(configPath, JSON.stringify(config))
    const result = await client(false).run({
      agent: { ...parent, maxCostCents: 0.5 },
      agentDefinitions: [child],
      prompt: 'Run both children.',
    })
    expect(requests).toHaveLength(1)
    expect(result.requestAdmission?.policy).toEqual({
      mode: 'strict-capped',
      capCents: 0.5,
      currency: 'USD',
    })
  })

  test('refusing unverified interrupted replay retains the held spending snapshot without dispatch', async () => {
    const first = await client(false).run({
      agent: parent,
      agentDefinitions: [child],
      prompt: 'Run both children.',
    })
    expect(first.runOutcome?.termination).toBe('completed')
    expect(requests, JSON.stringify(first.output)).toHaveLength(1)
    const authorityId =
      first.sessionState?.mainAgentState.requestAdmission?.authorityId
    expect(authorityId).toBeDefined()

    const checkpoint = structuredClone(first)
    checkpoint.sessionState!.requestAdmission = {
      authorityId: 'stale-completed-turn-authority',
      policy: {
        mode: 'strict-capped',
        capCents: 0.5,
        currency: 'USD',
      },
      policyHash: '0'.repeat(64),
    }
    const resumed = await client(false).run({
      agent: parent,
      agentDefinitions: [child],
      prompt: 'Run both children.',
      previousRun: checkpoint,
      resumeInterruptedTurn: true,
    })
    expect(
      resumed.sessionState?.mainAgentState.requestAdmission?.authorityId,
    ).toBe(authorityId)
    expect(resumed.runOutcome?.cause?.code).toBe('replay_unavailable')
    expect(resumed.sessionState?.mainAgentState.requestAdmission).toEqual(
      checkpoint.sessionState?.mainAgentState.requestAdmission,
    )
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(resumed.output)).toContain(
      'no verified replay prefix',
    )
  }, 25_000)
})
