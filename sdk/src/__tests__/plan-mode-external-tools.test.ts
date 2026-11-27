import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import z from 'zod/v4'

import { OpenbuffClient } from '../client'
import { getCustomToolDefinition } from '../custom-tool'
import { createNodeFileSystem } from '../tools/node-filesystem'

import type {
  AgentDefinition,
  ToolCall,
} from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { OpenbuffClientOptions } from '../run'

let root: string
let calls = 0
let spawns = 0
let fetches = 0
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-plan-external-')),
  )
  calls = 0
  spawns = 0
  fetches = 0
  const forbidden = () => {
    fetches++
    throw new Error('No provider requests in plan external tests')
  }
  network = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => forbidden(), { preconnect: forbidden }),
  )
})

afterEach(() => {
  network.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
  expect(fetches).toBe(0)
})

function options(): OpenbuffClientOptions {
  return {
    cwd: root,
    fsSource: createNodeFileSystem(),
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    harnessStateDir: path.join(root, 'harness'),
    hostConfiguration: {
      environment: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
      },
      platform: process.platform,
      invocationCwd: root,
      projectRoot: root,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'none' },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
    approvalMode: 'allow-all',
    spawnSource: (command, args = [], spawnOptions) => {
      if (args.includes('never-start-this-server')) {
        spawns++
        throw new Error('Plan lineage tried to start the external MCP server')
      }
      // The SDK may inspect this owned directory with Git during startup.
      if (path.basename(command) !== 'git')
        throw new Error(`Unexpected fixture subprocess: ${command}`)
      return nodeSpawn(command, [...args], spawnOptions ?? {})
    },
    handleEvent: () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    customToolDefinitions: [
      getCustomToolDefinition({
        toolName: 'fixture_write',
        inputSchema: z.object({}),
        description: 'Owned fixture mutation',
        execute: () => {
          calls++
          fs.writeFileSync(path.join(root, 'MUTATION_MARKER'), 'written')
          return [{ type: 'json', value: { applied: true } }]
        },
      }),
    ],
  }
}

function program(planOnly: boolean, mcp: boolean): AgentDefinition {
  return {
    id: 'plan-external-program',
    displayName: 'Plan external fixture',
    model: 'unused-fixture',
    toolNames: [mcp ? 'fixture/write' : 'fixture_write', 'set_output'],
    outputMode: 'structured_output',
    programmaticConfig: { planOnly },
    ...(mcp
      ? {
          mcpServers: {
            fixture: {
              type: 'stdio' as const,
              command: process.execPath,
              args: ['never-start-this-server'],
              env: {},
            },
          },
        }
      : {}),
    handleSteps: function* ({ prompt }) {
      const name = prompt === 'mcp' ? 'fixture/write' : 'fixture_write'
      const { toolResult } = yield {
        toolName: name,
        input: {},
      } as unknown as ToolCall
      yield { toolName: 'set_output', input: { result: toolResult } }
    },
  }
}

describe('actual SDK plan-lineage external dispatch', () => {
  test('refuses an arbitrary custom callback before its mutation', async () => {
    const result = await new OpenbuffClient(options()).run({
      agent: program(true, false),
      prompt: 'fixture',
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(JSON.stringify(result.output)).toContain('plan_mode_read_only')
    expect(calls).toBe(0)
    expect(spawns).toBe(0)
    expect(fs.existsSync(path.join(root, 'MUTATION_MARKER'))).toBe(false)
    expect(result.sessionState?.mainAgentState.actionOutcomes).toContainEqual(
      expect.objectContaining({
        toolName: 'fixture_write',
        outcome: 'refused',
      }),
    )
  })

  test('refuses MCP callbacks before starting their configured server', async () => {
    const result = await new OpenbuffClient(options()).run({
      agent: program(true, true),
      prompt: 'mcp',
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(JSON.stringify(result.output)).toContain('plan_mode_read_only')
    expect(calls).toBe(0)
    expect(spawns).toBe(0)
    expect(fs.existsSync(path.join(root, 'MUTATION_MARKER'))).toBe(false)
  })

  test('keeps execute-mode custom callbacks available', async () => {
    const result = await new OpenbuffClient(options()).run({
      agent: program(false, false),
      prompt: 'fixture',
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(calls).toBe(1)
    expect(fs.readFileSync(path.join(root, 'MUTATION_MARKER'), 'utf8')).toBe(
      'written',
    )
    expect(spawns).toBe(0)
  })
})
