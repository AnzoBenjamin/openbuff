import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenbuffClient } from '../client'
import { loadLocalAgents } from '../agents/load-agents'
import { silentLogger, startFakeLlmServer } from './fixtures/fake-llm-server'
import type { FakeLlmServer } from './fixtures/fake-llm-server'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { JournalEvent } from '@codebuff/common/types/contracts/agent-runtime'

let root: string, server: FakeLlmServer
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'child-step-budget-')),
  )
  server = startFakeLlmServer()
})
afterEach(() => {
  server.stop()
  fs.rmSync(root, { recursive: true, force: true })
})
function setup(supervision = false) {
  const config = path.join(root, 'config.json')
  fs.writeFileSync(
    config,
    JSON.stringify({
      defaultModel: 'fixture/model',
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: `${server.baseURL}/v1`,
          models: ['model'],
        },
      },
    }),
  )
  const events: JournalEvent[] = []
  const client = new OpenbuffClient({
    cwd: root,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    logger: silentLogger,
    handleEvent() {},
    runTimeoutMs: 20_000,
    journalWriter: {
      append(_runId, event) {
        events.push(structuredClone(event))
      },
    },
    hostConfiguration: {
      environment: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: supervision ? '1' : '0',
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
  return { client, events }
}
const bounded: AgentDefinition = {
  id: 'bounded-child',
  displayName: 'Bounded child',
  model: 'fixture/model',
  maxSteps: 2,
  toolNames: [],
  handleSteps: function* () {
    for (let step = 0; step < 50; step++) yield 'STEP'
  },
}
const parent: AgentDefinition = {
  id: 'budget-parent',
  displayName: 'Budget parent',
  model: 'fixture/model',
  toolNames: ['spawn_agents', 'set_output'],
  spawnableAgents: ['bounded-child'],
  outputMode: 'structured_output',
  handleSteps: function* () {
    const result = yield {
      toolName: 'spawn_agents',
      input: {
        agents: [
          {
            agent_type: 'bounded-child',
            prompt: 'Exercise the captured limit.',
          },
        ],
      },
    }
    yield { toolName: 'set_output', input: { result: result.toolResult } }
  },
}

describe('actual SDK child inference-step limits', () => {
  for (const supervision of [false, true])
    test(`declared child budget stops after exactly two provider steps (supervised ${supervision})`, async () => {
      const { client } = setup(supervision)
      const result = await client.run({
        agent: parent,
        agentDefinitions: [bounded],
        prompt: 'Run bounded child.',
      })
      expect(
        result.runOutcome?.termination,
        JSON.stringify(result.output),
      ).toBe('completed')
      expect(server.requests).toHaveLength(2)
      expect(JSON.stringify(result.output)).toContain('step_exhausted')
      expect(JSON.stringify(result.output)).toContain('step_limit')
    }, 25_000)
  for (const supervision of [false, true])
    test(`undeclared children can complete beyond 40 inference steps (supervised ${supervision})`, async () => {
      const { client } = setup(supervision)
      const result = await client.run({
        agent: parent,
        agentDefinitions: [{ ...bounded, maxSteps: undefined }],
        prompt: 'Run child default.',
      })
      expect(
        result.runOutcome?.termination,
        JSON.stringify(result.output),
      ).toBe('completed')
      expect(server.requests).toHaveLength(50)
      expect(JSON.stringify(result.output)).not.toContain('step_exhausted')
    }, 25_000)
  test('an explicit unlimited child can complete beyond the default without changing root defaults', async () => {
    const { client } = setup()
    const result = await client.run({
      agent: parent,
      agentDefinitions: [{ ...bounded, maxSteps: -1 }],
      prompt: 'Run explicit unlimited child.',
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(server.requests).toHaveLength(50)
    expect(JSON.stringify(result.output)).not.toContain('step_exhausted')
  }, 25_000)
  test('an explicit root template step cap is honored and journaled once', async () => {
    const { client, events } = setup()
    const result = await client.run({
      agent: bounded,
      prompt: 'Run bounded root.',
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'step_exhausted',
    )
    expect(server.requests).toHaveLength(2)
    const terminal = events.filter(
      (event) => (event.payload as { terminal?: boolean }).terminal === true,
    )
    expect(terminal).toHaveLength(1)
    expect(JSON.stringify(terminal[0])).toContain('step_exhausted')
  })
  test('Markdown max_steps is loaded and reaches the actual model loop', async () => {
    const file = path.join(root, 'bounded.md')
    fs.writeFileSync(
      file,
      '---\nname: markdown-bounded\ndescription: Return a bounded answer.\ntools: []\nmax_steps: 2\n---\nSay ok.\n',
    )
    const loaded = await loadLocalAgents({ agentsPath: root, validate: true })
    expect(loaded.validationErrors).toEqual([])
    expect(loaded.agents['markdown-bounded'].maxSteps).toBe(2)
    const { client } = setup()
    const result = await client.run({
      agent: loaded.agents['markdown-bounded'],
      prompt: 'Say ok.',
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(server.requests).toHaveLength(1)
  })
})
