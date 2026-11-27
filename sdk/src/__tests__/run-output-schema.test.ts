import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenbuffClient } from '../client'
import { silentLogger } from './fixtures/fake-llm-server'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { JournalEvent } from '@codebuff/common/types/contracts/agent-runtime'

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
}
let root: string
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'run-output-schema-')),
  )
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})
function setup() {
  const setupConfig = path.join(root, 'config.json')
  fs.writeFileSync(
    setupConfig,
    JSON.stringify({ defaultModel: 'fixture/model', providers: {} }),
  )
  const events: Array<{ runId: string; event: JournalEvent }> = []
  const client = new OpenbuffClient({
    cwd: root,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    logger: silentLogger,
    handleEvent() {},
    runTimeoutMs: 5_000,
    journalWriter: {
      append(runId, event) {
        events.push({ runId, event: structuredClone(event) })
      },
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
      selection: { kind: 'explicit', path: setupConfig, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  })
  return { client, events }
}
const valid: AgentDefinition = {
  id: 'schema-program',
  displayName: 'Schema program',
  toolNames: ['set_output'],
  handleSteps: function* () {
    yield { toolName: 'set_output', input: { answer: 'confirmed' } }
  },
}

describe('captured root run output contract', () => {
  test('publishes validated structured output without mutating the caller agent or persisted template', async () => {
    const { client } = setup()
    const before = { ...valid }
    const result = await client.run({
      agent: valid,
      prompt: 'Return the result',
      outputSchema: schema,
    })
    expect(result.output).toEqual({
      type: 'structuredOutput',
      value: { answer: 'confirmed' },
    })
    expect(result.runOutcome?.termination).toBe('completed')
    expect(valid).toEqual(before)
    expect(
      result.sessionState?.fileContext.agentTemplates?.[valid.id]?.outputSchema,
    ).toBeUndefined()
    const later = await client.run({
      agent: {
        ...valid,
        toolNames: [],
        handleSteps: function* () {
          yield { type: 'STEP_TEXT', text: 'ordinary output' }
        },
      },
      prompt: 'Return ordinary output',
      previousRun: result,
    })
    expect(later.output.type, JSON.stringify(later.output)).toBe('lastMessage')
  })
  test('a previous turn output cannot satisfy a new run contract without a fresh publication', async () => {
    const { client } = setup()
    const previousRun = await client.run({
      agent: valid,
      prompt: 'Publish the first result',
      outputSchema: schema,
    })
    const result = await client.run({
      agent: { ...valid, handleSteps: function* () {} },
      prompt: 'No fresh result',
      previousRun,
      outputSchema: schema,
    })
    expect(result.runOutcome).toMatchObject({
      termination: 'failed',
      cause: { code: 'output_schema_invalid' },
    })
  })

  for (const kind of ['wrong-output', 'missing-output'] as const)
    test(`${kind} is a failed run before its terminal journal publication`, async () => {
      const { client, events } = setup()
      const agent: AgentDefinition = {
        ...valid,
        handleSteps:
          kind === 'wrong-output'
            ? function* () {
                yield { toolName: 'set_output', input: { unrelated: 123 } }
              }
            : function* () {
                return
              },
      }
      const result = await client.run({
        agent,
        prompt: 'Do not claim success without the contract',
        outputSchema: schema,
      })
      expect(result.output.type).toBe('error')
      expect(result.runOutcome).toMatchObject({
        termination: 'failed',
        cause: { code: 'output_schema_invalid' },
      })
      const terminal = events.filter(
        (item) =>
          (item.event.payload as { terminal?: boolean }).terminal === true,
      )
      expect(terminal).toHaveLength(1)
      expect(JSON.stringify(terminal[0])).toContain('output_schema_invalid')
      expect(JSON.stringify(terminal[0])).not.toContain(
        '"termination":"completed"',
      )
    })
  test('the root contract does not constrain a child output or alter spawn permissions', async () => {
    const { client } = setup()
    const child: AgentDefinition = {
      id: 'schema-child',
      displayName: 'Child',
      toolNames: ['set_output'],
      outputMode: 'structured_output',
      outputSchema: {
        type: 'object',
        properties: { child: { type: 'number' } },
        required: ['child'],
      },
      handleSteps: function* () {
        yield { toolName: 'set_output', input: { child: 7 } }
      },
    }
    const parent: AgentDefinition = {
      ...valid,
      toolNames: ['spawn_agents', 'set_output'],
      spawnableAgents: [child.id],
      handleSteps: function* () {
        const spawned = yield {
          toolName: 'spawn_agents',
          input: {
            agents: [
              { agent_type: 'schema-child', prompt: 'Return child output' },
            ],
          },
        }
        yield {
          toolName: 'set_output',
          input: { answer: JSON.stringify(spawned.toolResult) },
        }
      },
    }
    const result = await client.run({
      agent: parent,
      agentDefinitions: [child],
      prompt: 'Use the child',
      outputSchema: schema,
    })
    expect(result.output.type).toBe('structuredOutput')
    expect(JSON.stringify(result.output)).toContain('child')
    expect(JSON.stringify(result.output)).toContain('7')
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
  })
  test('remote ACP refuses an unnegotiated output schema before its transport starts', async () => {
    const { AcpRemoteBackend } = await import('../client/acp-client')
    const backend = new AcpRemoteBackend({
      kind: 'socket',
      socketPath: '/never-open-for-output-schema',
      token: 'fixture',
    })
    try {
      const result = await backend.run({
        agent: valid.id,
        prompt: 'Return a result',
        outputSchema: schema,
      })
      expect(result.runOutcome).toMatchObject({
        termination: 'failed',
        cause: { code: 'remote_output_schema_unavailable' },
      })
      expect(result.output).toMatchObject({
        type: 'error',
        message: expect.stringContaining('schema'),
      })
    } finally {
      await backend.close()
    }
  })

  for (const outputSchema of [
    { type: 'array' },
    { type: 'object', $ref: 'https://never-fetch.invalid/schema' },
    { type: 'object', properties: { a: { unknownKeyword: true } } },
    { type: 'object', description: 'x'.repeat(70_000) },
  ])
    test('unsupported or oversized run schemas refuse before starting the agent', async () => {
      const { client, events } = setup()
      const result = await client.run({
        agent: valid,
        prompt: 'Must not start',
        outputSchema,
      })
      expect(result.output.type).toBe('error')
      expect(events).toHaveLength(0)
    })
})
