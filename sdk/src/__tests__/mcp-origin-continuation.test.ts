import { expect, test } from 'bun:test'
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  closeMCPClient,
  getMCPClientCacheKey,
  markMCPConfigOrigin,
  originOf,
} from '@codebuff/common/mcp/client'
import { assembleLocalAgentTemplates } from '@codebuff/agent-runtime/templates/agent-registry'
import { OpenbuffClient } from '../client'
import type {
  AgentDefinition,
  ToolCall,
} from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { MCPConfig, MCPConfigOrigin } from '@codebuff/common/types/mcp'
import type {
  PrintModeEvent,
  PrintModeToolResult,
} from '@codebuff/common/types/print-mode'
import type { RunState } from '../run-state'
import type { LaunchEvent } from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

const fixture = path.join(
  import.meta.dir,
  'fixtures/mcp-external-tool-server.mjs',
)
const hostVariable = 'OPENBUFF_B28_HOST_VALUE'

function configs(): Record<string, MCPConfig> {
  return Object.fromEntries(
    (['user', 'project', 'client'] as MCPConfigOrigin[]).map((origin) => {
      const config: MCPConfig = {
        type: 'stdio',
        command: process.execPath,
        args: [fixture, '["echo"]'],
        env: { OPENBUFF_MCP_FIXTURE_VALUE: '$' + hostVariable },
      }
      markMCPConfigOrigin(config, origin)
      return [origin, config]
    }),
  )
}

function childTemplate(servers: Record<string, MCPConfig>): AgentDefinition {
  return {
    id: 'mcp-origin-child',
    displayName: 'MCP origin child',
    model: 'fixture-model',
    toolNames: ['user/echo', 'project/echo', 'client/echo', 'set_output'],
    mcpServers: servers,
    outputMode: 'structured_output',
    handleSteps: function* () {
      const results = []
      for (const name of ['user/echo', 'project/echo', 'client/echo']) {
        const { toolResult } = yield {
          toolName: name,
          input: { source: name, route: '/api/v1', regex: '^a/b$' },
        } as unknown as ToolCall
        results.push(toolResult)
      }
      yield {
        toolName: 'set_output',
        input: { results, processId: process.pid },
      }
    },
  }
}

function client(root: string) {
  return new OpenbuffClient({
    cwd: root,
    // These positive origin fixtures explicitly authorize their owned interpreter peers.
    approvalMode: 'allow-all',
    harnessStateDir: path.join(root, 'harness'),
    projectFiles: {},
    knowledgeFiles: {},
    handleEvent: () => {},
  })
}

type Echo = {
  canonicalName: string
  arguments: { source: string; route: string; regex: string }
  fixtureEnv: string
}
function echoes(value: unknown): Echo[] {
  if (Array.isArray(value)) return value.flatMap(echoes)
  if (!value || typeof value !== 'object') return []
  const object = value as Record<string, unknown>
  if (object.kind === 'mcp_tool_result')
    return [object.structuredContent as Echo]
  return Object.values(object).flatMap(echoes)
}

function processIds(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(processIds)
  if (!value || typeof value !== 'object') return []
  const object = value as Record<string, unknown>
  return [
    ...(typeof object.processId === 'number' ? [object.processId] : []),
    ...Object.values(object).flatMap(processIds),
  ]
}

function assertEchoes(value: unknown) {
  const observations = echoes(value)
  expect(observations).toHaveLength(3)
  expect(
    observations.map((value) => [value.arguments.source, value.fixtureEnv]),
  ).toEqual([
    ['user/echo', 'host-expanded-fixture'],
    ['project/echo', 'host-expanded-fixture'],
    ['client/echo', '$' + hostVariable],
  ])
  for (const observation of observations) {
    expect(observation.canonicalName).toBe('echo')
    expect(observation.arguments.route).toBe('/api/v1')
    expect(observation.arguments.regex).toBe('^a/b$')
  }
}

function assertSetupRefusal(result: RunState, message: string) {
  expect(result.output).toMatchObject({
    type: 'error',
    message: expect.stringContaining(message),
  })
  expect(result.runOutcome).toMatchObject({
    termination: 'failed',
    cause: { code: 'run_setup_failed' },
  })
  expect(result.sessionState).toBeDefined()
}

async function cleanup(
  servers: Record<string, MCPConfig>,
  root: string,
  old: string | undefined,
) {
  await Promise.allSettled(
    Object.values(servers).map((config) =>
      closeMCPClient(getMCPClientCacheKey(config)),
    ),
  )
  if (old === undefined) delete process.env[hostVariable]
  else process.env[hostVariable] = old
  rmSync(root, { recursive: true, force: true })
}

test('the actual SDK and registry preserve mixed origins through JSON continuation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'openbuff-b28-origin-'))
  const old = process.env[hostVariable]
  process.env[hostVariable] = 'host-expanded-fixture'
  const servers = configs()
  try {
    const first = await client(root).run({
      agent: childTemplate(servers),
      prompt: 'fixed origin fixture',
    })
    expect(first.output.type).toBe('structuredOutput')
    assertEchoes(first.output)
    const restored = JSON.parse(JSON.stringify(first)) as RunState
    const second = await client(root).run({
      agent: 'mcp-origin-child',
      prompt: 'fixed origin fixture',
      previousRun: restored,
    })
    expect(second.output.type).toBe('structuredOutput')
    assertEchoes(second.output)
    const context = second.sessionState!.fileContext
    const registered = assembleLocalAgentTemplates({
      fileContext: context,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    })
    for (const origin of ['user', 'project', 'client'] as const) {
      expect(
        originOf(
          registered.agentTemplates['mcp-origin-child'].mcpServers[origin],
        ),
      ).toBe(origin)
      expect(
        context.agentTemplates['mcp-origin-child'].mcpServerReferences[origin],
      ).toBe(
        first.sessionState!.fileContext.agentTemplates['mcp-origin-child']
          .mcpServerReferences[origin],
      )
    }
    expect(registered.validationErrors).toEqual([])
  } finally {
    await cleanup(servers, root, old)
  }
}, 20_000)

test('an explicit unmarked host override replaces only its server and persisted tampering refuses', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'openbuff-b28-override-'))
  const old = process.env[hostVariable]
  process.env[hostVariable] = 'host-expanded-fixture'
  const servers = configs()
  const replacement = JSON.parse(JSON.stringify(servers.user)) as MCPConfig
  if (replacement.type !== 'stdio') throw new Error('Expected stdio fixture')
  replacement.env = { ...replacement.env, OPENBUFF_B28_OVERRIDE: 'replacement' }
  try {
    const first = await client(root).run({
      agent: childTemplate(servers),
      prompt: 'original host fixture',
    })
    expect(first.output.type).toBe('structuredOutput')
    const restored = JSON.parse(JSON.stringify(first)) as RunState
    const before =
      restored.sessionState!.fileContext.agentTemplates['mcp-origin-child']
        .mcpServerReferences
    const second = await client(root).run({
      agent: 'mcp-origin-child',
      prompt: 'explicit host override',
      previousRun: restored,
      mcpServers: { user: replacement },
    })
    expect(second.output.type).toBe('structuredOutput')
    expect(
      echoes(second.output).map((value) => [
        value.arguments.source,
        value.fixtureEnv,
      ]),
    ).toEqual([
      ['user/echo', '$' + hostVariable],
      ['project/echo', 'host-expanded-fixture'],
      ['client/echo', '$' + hostVariable],
    ])
    const after =
      second.sessionState!.fileContext.agentTemplates['mcp-origin-child']
        .mcpServerReferences
    expect(after.user).not.toBe(before.user)
    expect(after.project).toBe(before.project)
    expect(after.client).toBe(before.client)
    const tampered = JSON.parse(JSON.stringify(second)) as RunState
    tampered.sessionState!.fileContext.agentTemplates[
      'mcp-origin-child'
    ].mcpServers.user.env.OPENBUFF_B28_OVERRIDE = 'persisted tampering'
    const refused = await client(root).run({
      agent: 'mcp-origin-child',
      prompt: 'reject persisted tampering',
      previousRun: tampered,
    })
    assertSetupRefusal(refused, 'configuration changed')
    expect(refused.sessionState!.fileContext.agentTemplates['mcp-origin-child'].mcpServerReferences)
      .toEqual(tampered.sessionState!.fileContext.agentTemplates['mcp-origin-child'].mcpServerReferences)
  } finally {
    await closeMCPClient(getMCPClientCacheKey(replacement))
    await cleanup(servers, root, old)
  }
}, 20_000)

test('a continued SDK run refuses project and unavailable-process reference replay', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'openbuff-b28-replay-'))
  const other = mkdtempSync(path.join(tmpdir(), 'openbuff-b28-other-project-'))
  const old = process.env[hostVariable]
  process.env[hostVariable] = 'host-expanded-fixture'
  const servers = configs()
  try {
    const first = await client(root).run({
      agent: childTemplate(servers),
      prompt: 'fixed origin fixture',
    })
    expect(first.output.type).toBe('structuredOutput')
    assertEchoes(first.output)
    const replay = JSON.parse(JSON.stringify(first)) as RunState
    const crossProject = await client(other).run({
      agent: 'mcp-origin-child',
      prompt: 'fixed replay fixture',
      previousRun: replay,
    })
    assertSetupRefusal(crossProject, 'different project')
    expect(crossProject.sessionState!.fileContext.mcpSessionReference)
      .toBe(replay.sessionState!.fileContext.mcpSessionReference)
    const unavailable = JSON.parse(JSON.stringify(first)) as RunState
    unavailable.sessionState!.fileContext.mcpSessionReference =
      'a-restarted-host-reference'
    const previousProcess = await client(root).run({
      agent: 'mcp-origin-child',
      prompt: 'fixed replay fixture',
      previousRun: unavailable,
    })
    assertSetupRefusal(previousProcess, 'previous process')
    expect(previousProcess.sessionState!.fileContext.mcpSessionReference)
      .toBe(unavailable.sessionState!.fileContext.mcpSessionReference)
  } finally {
    rmSync(other, { recursive: true, force: true })
    await cleanup(servers, root, old)
  }
}, 20_000)

test('default balanced continuation refreshes trusted MCP peers and refuses the client peer', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'openbuff-b28-balanced-'))
  const old = process.env[hostVariable]
  process.env[hostVariable] = 'host-expanded-fixture'
  const servers = configs()
  try {
    const first = await client(root).run({
      agent: childTemplate(servers),
      prompt: 'fixed origin fixture',
    })
    assertEchoes(first.output)
    const restored = JSON.parse(JSON.stringify(first)) as RunState
    process.env[hostVariable] = 'continued-host-value'
    const launches: Array<{ command: string; argv: readonly string[] }> = []
    const events: LaunchEvent[] = []
    const spawn: CodebuffSpawn = (command, argv, options) => {
      launches.push({ command, argv: [...argv ?? []] })
      return nodeSpawn(command, [...argv ?? []], options ?? {})
    }
    // Omit approvalMode to exercise the real default-balanced policy.
    const balanced = new OpenbuffClient({
      cwd: root,
      harnessStateDir: path.join(root, 'harness'),
      projectFiles: {},
      knowledgeFiles: {},
      spawnSource: spawn,
      recordExecution: event => { events.push(event) },
      handleEvent: () => {},
    })
    const continued = await balanced.run({
      agent: 'mcp-origin-child',
      prompt: 'fixed origin fixture',
      previousRun: restored,
    })
    expect(continued.output.type).toBe('structuredOutput')
    if (continued.output.type !== 'structuredOutput')
      throw new Error('Balanced fixture did not return its current per-call results')
    const results = (continued.output.value as { results: unknown[] }).results
    expect(results).toHaveLength(3)
    for (const [index, toolName] of ['user/echo', 'project/echo'].entries()) {
      expect(echoes(results[index])).toMatchObject([
        {
          canonicalName: 'echo',
          arguments: { source: toolName, route: '/api/v1', regex: '^a/b$' },
          fixtureEnv: 'continued-host-value',
        },
      ])
    }
    // Bun 1.3.5 replaces nested asymmetric-matcher targets; keep the result intact.
    expect(JSON.parse(JSON.stringify(results[2]))).toMatchObject([
      { type: 'json', value: { errorMessage: expect.stringContaining('client/echo') } },
    ])
    expect(JSON.stringify(results[2])).toMatch(/not found|unavailable/i)
    expect(echoes(results[2])).toEqual([])
    expect(echoes(continued.output)).toHaveLength(2)
    expect(JSON.stringify(continued.output)).not.toContain('host-expanded-fixture')
    expect(launches.filter(launch => launch.argv.includes(fixture))).toHaveLength(2)
    const peerEvents = events.filter(event => 'facts' in event && event.facts.family === 'mcp-stdio')
    expect(peerEvents.filter(event => event.phase === 'dispatched')).toHaveLength(2)
    expect(peerEvents.filter(event => event.phase === 'spawn-observed')).toHaveLength(2)
    const refusals = peerEvents.filter((event): event is Extract<LaunchEvent, { phase: 'no-launch' }> =>
      event.phase === 'no-launch')
    expect(refusals.length).toBeGreaterThan(0)
    for (const event of refusals) {
      expect(event.refusal.reason).toBe('unavailable')
      expect(event.refusal.cause).toMatch(/approval/i)
    }
    expect(continued.sessionState!.fileContext.agentTemplates['mcp-origin-child'].mcpServerReferences)
      .toEqual(first.sessionState!.fileContext.agentTemplates['mcp-origin-child'].mcpServerReferences)
  } finally {
    await cleanup(servers, root, old)
  }
}, 20_000)

test.skipIf(process.platform === 'win32')(
  'a real supervised child discovers and invokes mixed-origin MCP servers through the SDK bridge',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'openbuff-b28-supervised-'))
    const old = process.env[hostVariable]
    const oldSupervision = process.env.OPENBUFF_PROCESS_SUPERVISION
    process.env[hostVariable] = 'host-expanded-fixture'
    process.env.OPENBUFF_PROCESS_SUPERVISION = '1'
    const servers = configs()
    const child = childTemplate(servers)
    const parent: AgentDefinition = {
      id: 'mcp-origin-parent',
      displayName: 'MCP origin parent',
      model: 'fixture-model',
      toolNames: ['spawn_agents', 'set_output'],
      spawnableAgents: [child.id],
      outputMode: 'structured_output',
      handleSteps: function* () {
        const { toolResult } = yield {
          toolName: 'spawn_agents',
          input: {
            agents: [
              {
                agent_type: 'mcp-origin-child',
                prompt: 'fixed origin fixture',
              },
            ],
          },
        }
        yield {
          toolName: 'set_output',
          input: { child: toolResult },
        }
      },
    }
    try {
      const events: PrintModeEvent[] = []
      const result = await client(root).run({
        agent: parent,
        agentDefinitions: [child],
        prompt: 'fixed supervised fixture',
        handleEvent: (event) => {
          events.push(event)
        },
      })
      expect(result.output.type).toBe('structuredOutput')
      if (result.output.type !== 'structuredOutput')
        throw new Error('fixture returned an unsuccessful output')
      if (!result.output.value || typeof result.output.value !== 'object')
        throw new Error('fixture result has no structured body')
      const reports = (result.output.value as Record<string, unknown>)
        .child as Array<{
        type: 'json'
        value: Array<{
          agentId: string
          value: {
            truncated: boolean
            artifactPersisted: boolean
            artifactPath?: string
            artifactBytes: number
          }
          agentReceipt: { outcome: string }
        }>
      }>
      expect(reports).toHaveLength(1)
      const childReport = reports[0].value[0]
      const childValue = childReport.value
      const echoEvents = events.filter(
        (event): event is PrintModeToolResult =>
          event.type === 'tool_result' &&
          event.agentId === childReport.agentId &&
          ['user/echo', 'project/echo', 'client/echo'].includes(event.toolName),
      )
      assertEchoes(echoEvents)
      for (const event of echoEvents)
        expect(event.actionOutcome?.outcome).toBe('succeeded')
      expect(childValue.truncated).toBe(true)
      expect(childReport.agentReceipt.outcome).toBe('truncated')
      expect(JSON.stringify(childValue)).toContain('truncatedNestedAgentOutput')
      expect(childValue.artifactPersisted).toBe(true)
      if (!childValue.artifactPath)
        throw new Error('fixture did not persist its full child output')
      const artifact = readFileSync(childValue.artifactPath)
      expect(artifact.byteLength).toBe(childValue.artifactBytes)
      expect(path.basename(childValue.artifactPath)).toBe(
        createHash('sha256').update(artifact).digest('hex') + '.json',
      )
      const fullChildOutput = JSON.parse(artifact.toString())
      assertEchoes(fullChildOutput)
      expect(fullChildOutput.value.results).toEqual(
        echoEvents.map((event) => event.output),
      )
      const report = JSON.stringify(result.output)
      expect(report).not.toContain('MCP execution is unavailable')
      const observedProcesses = processIds(fullChildOutput)
      expect(observedProcesses).toHaveLength(1)
      expect(observedProcesses[0]).toBeGreaterThan(0)
      expect(observedProcesses[0]).not.toBe(process.pid)
    } finally {
      if (oldSupervision === undefined)
        delete process.env.OPENBUFF_PROCESS_SUPERVISION
      else process.env.OPENBUFF_PROCESS_SUPERVISION = oldSupervision
      await cleanup(servers, root, old)
    }
  },
  30_000,
)
