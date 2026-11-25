import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { OpenbuffClient } from '../client'
import { startFakeLlmServer, silentLogger } from './fixtures/fake-llm-server'
import { nodeConfigReadFs } from '../host-config'
import type { FakeLlmServer } from './fixtures/fake-llm-server'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { OpenbuffClientOptions } from '../run'

let root: string, server: FakeLlmServer, configPath: string, configBytes: string
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-run-model-')),
  )
  server = startFakeLlmServer()
  configPath = path.join(root, 'config.json')
  configBytes = JSON.stringify({
    defaultModel: 'fake/default',
    modes: { default: 'fake/mode' },
    agents: {
      'model-wire-root': 'fake/agent',
      'model-wire-child': 'fake/child',
    },
    defaultReasoningEffort: 'low',
    providers: {
      fake: {
        type: 'openai-compatible',
        baseURL: `${server.baseURL}/v1`,
        models: [
          'default',
          'mode',
          'agent',
          'child',
          'selected-a',
          'selected-b',
        ],
        modelCapabilities: {
          'selected-a': { context: { windowTokens: 12_000 } },
          'selected-b': { context: { windowTokens: 24_000 } },
        },
      },
    },
  })
  fs.writeFileSync(configPath, configBytes)
})
afterEach(() => {
  server.stop()
  expect(fs.readFileSync(configPath, 'utf8')).toBe(configBytes)
  fs.rmSync(root, { recursive: true, force: true })
})
function options(extra: OpenbuffClientOptions = {}): OpenbuffClientOptions {
  return {
    cwd: root,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    handleEvent() {},
    logger: silentLogger,
    runTimeoutMs: 5_000,
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
      selection: { kind: 'explicit', path: configPath, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
    configReadFs: nodeConfigReadFs,
    ...extra,
  }
}
const rootAgent: AgentDefinition = {
  id: 'model-wire-root',
  displayName: 'Model wire root',
  model: 'fake/default',
  toolNames: [],
  systemPrompt: 'Say ok and stop.',
  outputMode: 'last_message',
}
const child: AgentDefinition = {
  ...rootAgent,
  id: 'model-wire-child',
  displayName: 'Model wire child',
}

describe('captured per-run model wire routing', () => {
  test('explicit run model wins over configured agent routing; a later run returns to config', async () => {
    const client = new OpenbuffClient(options())
    const selected = await client.run({
      agent: rootAgent,
      prompt: 'Say ok',
      model: 'fake/selected-a',
    })
    expect(
      selected.runOutcome?.termination,
      JSON.stringify(selected.output),
    ).toBe('completed')
    const ordinary = await client.run({ agent: rootAgent, prompt: 'Say ok' })
    expect(
      ordinary.runOutcome?.termination,
      JSON.stringify(ordinary.output),
    ).toBe('completed')
    expect(server.requests.map((request) => request.body.model)).toEqual([
      'selected-a',
      'agent',
    ])
  })
  test('parallel run overrides stay isolated within one client', async () => {
    const client = new OpenbuffClient(options())
    const results = await Promise.all(
      ['fake/selected-a', 'fake/selected-b'].map((model) =>
        client.run({ agent: rootAgent, prompt: 'Say ok', model }),
      ),
    )
    expect(
      results.every((result) => result.runOutcome?.termination === 'completed'),
    ).toBe(true)
    expect(server.requests.map((request) => request.body.model).sort()).toEqual(
      ['selected-a', 'selected-b'],
    )
  })
  test('the explicit run choice reaches spawned actors without rewriting their template route', async () => {
    const parent: AgentDefinition = {
      ...rootAgent,
      toolNames: ['spawn_agents', 'set_output'],
      spawnableAgents: [child.id],
      outputMode: 'structured_output',
      handleSteps: function* () {
        const spawned = yield {
          toolName: 'spawn_agents',
          input: {
            agents: [{ agent_type: 'model-wire-child', prompt: 'Say ok' }],
          },
        }
        yield { toolName: 'set_output', input: { spawned: spawned.toolResult } }
      },
    }
    const result = await new OpenbuffClient(options()).run({
      agent: parent,
      agentDefinitions: [child],
      prompt: 'Call the child',
      model: 'fake/selected-a',
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(server.requests.map((request) => request.body.model)).toEqual([
      'selected-a',
    ])
    expect(
      result.sessionState?.fileContext.agentTemplates?.[child.id]?.model,
    ).toBe('fake/default')
  })
  for (const model of ['', '   ', 'fake/selected-a\n', 'unconfigured/missing'])
    test(`invalid or unroutable override ${JSON.stringify(model)} never falls back to configured primary`, async () => {
      const result = await new OpenbuffClient(options()).run({
        agent: rootAgent,
        prompt: 'Must not request a configured fallback',
        model,
      })
      expect(result.output.type).toBe('error')
      expect(server.requests).toHaveLength(0)
    })
  test('configured failover still uses the explicit backup rather than reselecting the run primary', async () => {
    const config = JSON.parse(configBytes)
    config.failoverModels = ['fake/selected-b']
    configBytes = JSON.stringify(config)
    fs.writeFileSync(configPath, configBytes)
    server.script.push({ kind: 'status', status: 401 })
    const result = await new OpenbuffClient(options()).run({
      agent: rootAgent,
      prompt: 'Say ok after fallback',
      model: 'fake/selected-a',
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(server.requests.map((request) => request.body.model)).toEqual([
      'selected-a',
      'selected-b',
    ])
  })

  test('JSON configuration cannot set the host-only run model marker', async () => {
    configBytes = JSON.stringify({
      ...JSON.parse(configBytes),
      runModel: 'fake/selected-b',
    })
    fs.writeFileSync(configPath, configBytes)
    const result = await new OpenbuffClient(options()).run({
      agent: rootAgent,
      prompt: 'Use configured routing',
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(server.requests.map((request) => request.body.model)).toEqual([
      'agent',
    ])
  })

  test('actual source CLI forwards --model and preserves NDJSON framing', async () => {
    const cli = path.resolve(
      import.meta.dir,
      '../../../cli/src/binary-entry.ts',
    )
    const configDir = path.join(root, 'cli-config')
    fs.mkdirSync(configDir)
    const child = spawn(
      process.execPath,
      [
        '--no-env-file',
        '--no-install',
        cli,
        'run',
        '--json',
        '--agent',
        'thinker',
        '--model',
        'fake/selected-a',
        '--timeout',
        '15',
        '-p',
        'Say ok and stop.',
      ],
      {
        cwd: root,
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          USER: process.env.USER,
          OPENBUFF_CONFIG_DIR: configDir,
          OPENBUFF_PROVIDER_CONFIG: configPath,
          OPENBUFF_TELEMETRY: '0',
          DO_NOT_TRACK: '1',
          OPENBUFF_PROCESS_SUPERVISION: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const stdout: Buffer[] = [],
      stderr: Buffer[] = []
    child.stdout.on('data', (bytes) => stdout.push(Buffer.from(bytes)))
    child.stderr.on('data', (bytes) => stderr.push(Buffer.from(bytes)))
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve)
        child.once('error', reject)
      })
      expect(code, Buffer.concat(stderr).toString('utf8')).toBe(0)
      const events = Buffer.concat(stdout)
        .toString('utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      expect(events.length).toBeGreaterThan(0)
      expect(events.every((event) => typeof event.type === 'string')).toBe(true)
      expect(
        events.some(
          (event) => event.type === 'text' && event.text.includes('ok'),
        ),
      ).toBe(true)
      expect(server.requests.length).toBeGreaterThan(0)
      expect(
        server.requests.every((request) => request.body.model === 'selected-a'),
      ).toBe(true)
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
    }
  }, 25_000)

  test('continuing a run does not silently retain the previous turn model override', async () => {
    const client = new OpenbuffClient(options())
    const previous = await client.run({
      agent: rootAgent,
      prompt: 'Say ok',
      model: 'fake/selected-a',
    })
    const next = await client.run({
      agent: rootAgent,
      prompt: 'Say ok again',
      previousRun: previous,
    })
    expect(next.runOutcome?.termination, JSON.stringify(next.output)).toBe(
      'completed',
    )
    expect(server.requests.map((request) => request.body.model)).toEqual([
      'selected-a',
      'agent',
    ])
  })
})
