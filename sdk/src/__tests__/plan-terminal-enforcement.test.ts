import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import { OpenbuffClient } from '../client'
import { createHostExecutionServices, executionClock } from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { prepareNodeLaunch } from '../services/execution-launch'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { sdkCallbackOptions } from './sdk-callback-fixture'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type {
  ExecutionAdapterContext,
  ProfileRequest,
  Result,
} from '@codebuff/common/types/contracts/execution-context'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { OpenbuffClientOptions } from '../run'

let root: string,
  fetches: number,
  shellCalls: string[],
  events: PrintModeEvent[]
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
const readOnly: ProfileRequest = {
  policy: 'read-only',
  preferredBackend: 'native-exec',
  required: [
    'exact-env',
    'filesystem-isolation',
    'network-isolation',
    'process-tree-containment',
  ],
  allowBackendFallback: false,
}
const full: ProfileRequest = {
  policy: 'full-access',
  preferredBackend: 'portable-ts',
  required: ['exact-env'],
  allowBackendFallback: false,
}

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-plan-enforcement-')),
  )
  fs.writeFileSync(path.join(root, 'old.txt'), 'retained-token\n')
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'touch SCRIPT_MARKER' } }),
  )
  fetches = 0
  shellCalls = []
  events = []
  const forbidden = () => {
    fetches++
    throw new Error('No providers in plan terminal controls')
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
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}
function options(extra: OpenbuffClientOptions = {}): OpenbuffClientOptions {
  return {
    ...sdkCallbackOptions(root, { fsSource: createNodeFileSystem() }),
    harnessStateDir: path.join(root, 'harness'),
    repositoryIntelligence: false,
    approvalMode: 'allow-all',
    handleEvent: (event) => {
      events.push(event)
    },
    spawnSource: (command, argv = [], spawnOptions) => {
      if (path.basename(command) === 'bash') shellCalls.push(argv.at(-1) ?? '')
      return nodeSpawn(command, [...argv], spawnOptions ?? {})
    },
    ...extra,
  }
}
function program(
  planOnly: boolean,
  declared: 'read-only' | 'full-access' = 'full-access',
): AgentDefinition {
  return {
    id: planOnly ? 'plan-enforcement-program' : 'execute-enforcement-program',
    displayName: 'Terminal enforcement control',
    model: 'unused-fixture',
    toolNames: ['run_terminal_command', 'set_output'],
    terminalPermissionProfile: declared,
    outputMode: 'structured_output',
    programmaticConfig: { planOnly },
    handleSteps: function* ({ prompt }) {
      if (!prompt)
        throw new Error('Terminal control requires its command prompt')
      const { toolResult } = yield {
        toolName: 'run_terminal_command',
        input: { command: prompt, process_type: 'SYNC', timeout_seconds: 10 },
      }
      yield { toolName: 'set_output', input: { result: toolResult } }
    },
  }
}
async function run(
  planOnly: boolean,
  command: string,
  extra: OpenbuffClientOptions = {},
  declared: 'read-only' | 'full-access' = 'full-access',
) {
  return new OpenbuffClient(options(extra)).run({
    agent: program(planOnly, declared),
    prompt: command,
  })
}

describe('plan terminal enforcement without native provisioning', () => {
  for (const command of ['printf plan-probe', 'bun run test']) {
    test(`refuses ${command} rather than treating lexical approval as read-only enforcement`, async () => {
      const result = await run(true, command)
      expect(shellCalls).toEqual([])
      expect(fs.existsSync(path.join(root, 'SCRIPT_MARKER'))).toBe(false)
      const text = JSON.stringify({ output: result.output, events })
      expect(text).toContain('plan_mode_read_only')
      expect(text).toContain('native')
      expect(
        result.actionOutcomes?.some(
          (outcome) =>
            outcome.toolName === 'run_terminal_command' &&
            outcome.outcome === 'refused',
        ),
      ).toBe(true)
    })
  }

  test('a terminal override cannot claim an OS-enforced plan result or mutate the workspace', async () => {
    let overrides = 0
    const result = await run(true, 'printf plan-probe', {
      overrideTools: {
        run_terminal_command: async () => {
          overrides++
          fs.writeFileSync(path.join(root, 'OVERRIDE_MARKER'), 'written')
          return [
            {
              type: 'json',
              value: { command: 'printf plan-probe', exitCode: 0 },
            },
          ]
        },
      },
    })
    expect(overrides).toBe(0)
    expect(shellCalls).toEqual([])
    expect(fs.existsSync(path.join(root, 'OVERRIDE_MARKER'))).toBe(false)
    expect(JSON.stringify({ output: result.output, events })).toContain(
      'plan_mode_read_only',
    )
  })

  test('execute mode retains ordinary portable project scripts', async () => {
    const result = await run(false, 'bun run test')
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(shellCalls).toContain('bun run test')
    expect(fs.existsSync(path.join(root, 'SCRIPT_MARKER'))).toBe(true)
  })

  test('non-plan declared read-only inspection retains its portable behavior', async () => {
    const result = await run(false, 'printf execute-read-only', {}, 'read-only')
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(shellCalls).toContain('printf execute-read-only')
    expect(JSON.stringify(result.output)).toContain('execute-read-only')
  })

  test('file and search tools remain usable in a credential-free plan run', async () => {
    const agent: AgentDefinition = {
      id: 'plan-read-search-control',
      displayName: 'Plan read/search control',
      model: 'unused-fixture',
      programmaticConfig: { planOnly: true },
      toolNames: ['read_files', 'glob', 'code_search', 'set_output'],
      outputMode: 'structured_output',
      handleSteps: function* () {
        const read = yield {
          toolName: 'read_files',
          input: { paths: ['old.txt'] },
        }
        const found = yield { toolName: 'glob', input: { pattern: '*.txt' } }
        const searched = yield {
          toolName: 'code_search',
          input: { pattern: 'retained-token', paths: ['old.txt'] },
        }
        yield {
          toolName: 'set_output',
          input: {
            read: read.toolResult,
            found: found.toolResult,
            searched: searched.toolResult,
          },
        }
      },
    }
    const result = await new OpenbuffClient(options()).run({
      agent,
      prompt: 'Inspect without terminal access',
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(JSON.stringify(result.output)).toContain('retained-token')
    expect(JSON.stringify(result.output)).toContain('old.txt')
    expect(shellCalls).toEqual([])
  })
})

describe('host-authenticated plan profile bounds', () => {
  function host() {
    const captured = loadHostConfigSnapshot({
      inputs: options().hostConfiguration!,
      fs: nodeConfigReadFs,
    })
    if (captured.status !== 'complete') throw new Error(captured.cause)
    return value(
      createHostExecutionServices({
        snapshot: captured.snapshot,
        boundary: value(
          captureRootDeadline({
            clock: executionClock,
            limit: { kind: 'unbounded' },
          }),
        ),
        childInheritanceEnvironment: captured.snapshot.inputs.environment,
        approvalMode: 'allow-all',
      }),
    )
  }
  function target(context: ExecutionAdapterContext) {
    return {
      executionContext: context,
      executable: '/usr/bin/bash',
      argv: ['--version'],
      cwd: root,
      branchId: 'plan.bound-target',
      adapterOptions: { shell: false },
    }
  }
  test('a copied context cannot replace the registered read-only profile with portable full access', () => {
    const services = host(),
      original = value(
        services.directOperation({ profile: readOnly }),
      ).executionContext
    const forged = { ...original, profile: full }
    expect(prepareNodeLaunch(target(forged))).toMatchObject({
      ok: false,
      reason: 'invalid-context',
    })
    expect(services.events.some((event) => event.phase === 'dispatched')).toBe(
      false,
    )
  })
  test('a new child run cannot widen its authenticated read-only parent profile', () => {
    const services = host(),
      parent = value(
        services.directOperation({ profile: readOnly }),
      ).executionContext
    const child = value(
      services.registerRun(
        {
          clientSessionId: 'plan-child-client',
          rootRunId: 'plan-root',
          parentRunId: 'plan-child',
          parentAgentId: 'plan-child-agent',
        },
        parent,
      ),
    )
    const context = value(child.operation())
    expect(context.profile).toEqual(readOnly)
    expect(child.operation({ profile: full })).toMatchObject({
      ok: false,
      reason: 'invalid-context',
    })
    expect(child.operation({ mode: 'user' })).toMatchObject({
      ok: false,
      reason: 'invalid-context',
    })
    expect(prepareNodeLaunch(target(context))).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
  })
  test('detached preparation cannot widen the authenticated sending profile', () => {
    const services = host(),
      parent = value(
        services.directOperation({ profile: readOnly }),
      ).executionContext
    const receiver = value(
      services.createBackgroundReceiver('plan-transfer-client'),
    )
    expect(
      receiver.prepareLaunch(parent, {
        executable: '/usr/bin/bash',
        argv: ['-c', 'printf should-not-start'],
        shellCommandBytes: 'printf should-not-start',
        cwd: root,
        projectRoot: root,
        allowedPaths: [root],
        profile: full,
        mode: 'assistant',
        processType: 'BACKGROUND',
        family: 'background-job',
        branchId: 'plan.forged-transfer',
        adapterOptions: { runtime: 'node', shell: false },
      }),
    ).toMatchObject({ ok: false, reason: 'invalid-context' })
    expect(
      services.events.some((event) => event.phase === 'resource-transferred'),
    ).toBe(false)
  })
})
