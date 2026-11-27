import {
  MemoryPlaybookSchema,
  computeTriggerSignature,
} from '@codebuff/common/types/memory-playbook'
import { ProjectIdSchema } from '@codebuff/common/types/memory-v2'
import type { MemoryRepositoryV2 } from '../services/memory-v2/types'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { OpenbuffClient } from '../client'
import { captureRunDeadline } from '../run'
import * as hostExecution from '../host-execution'
import * as llm from '../impl/llm'
import { promptSuccess } from '@codebuff/common/util/error'
import { createToolCallChunk } from '@codebuff/agent-runtime/__tests__/test-utils'
import { nodeConfigReadFs } from '../host-config'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { WorkspaceJournalService } from '../services/workspace-journal'

import type { ChildProcess } from 'node:child_process'
import type {
  AgentDefinition,
  ToolCall,
} from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { LaunchEvent } from '@codebuff/common/types/contracts/execution-context'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ConfigReadFs } from '../provider-config'
import type { HostConfigurationInputs } from '../host-config'
import type { OpenbuffClientOptions } from '../run'
import type { RunState } from '../run-state'
import type { JournalEvent } from '@codebuff/common/types/contracts/agent-runtime'
import type { AgentState } from '@codebuff/common/types/session-state'

const roots: string[] = []
const children: ChildProcess[] = []
const childExits: Promise<unknown>[] = []
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
let hostSpy: ReturnType<
  typeof spyOn<typeof hostExecution, 'createHostExecutionServices'>
>
let actualHosts: hostExecution.RunHostServices[] = []
let networkAttempts = 0
const createHost = hostExecution.createHostExecutionServices
beforeEach(() => {
  actualHosts = []
  networkAttempts = 0
  const forbidNetwork = () => {
    networkAttempts++
    throw new Error('Network is forbidden in run execution fixtures')
  }
  network = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => forbidNetwork(), { preconnect: forbidNetwork }),
  )
  // Observe the actual run-created provider context without replacing its logic.
  hostSpy = spyOn(
    hostExecution,
    'createHostExecutionServices',
  ).mockImplementation((options) => {
    const result = createHost(options)
    if (result.ok) actualHosts.push(result.value)
    return result
  })
})
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  await Promise.allSettled(childExits.splice(0))
  hostSpy.mockRestore()
  const networkCalls = network.mock.calls.length
  network.mockRestore()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
  expect(networkCalls).toBe(0)
  expect(networkAttempts).toBe(0)
})

const nodeExecutable = Bun.which('node')
if (!nodeExecutable)
  throw new Error('The real run host execution fixture requires Node on PATH')
const shellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const program: AgentDefinition = {
  id: 'b19-programmatic-host',
  displayName: 'Local execution fixture',
  model: 'fixture-model',
  toolNames: [
    'run_terminal_command',
    'run_file_change_hooks',
    'git_status',
    'set_output',
  ],
  outputMode: 'structured_output',
  handleSteps: function* ({ prompt, agentState }) {
    const results = []
    for (const call of JSON.parse(prompt ?? '[]')) {
      const { toolResult } = yield call as ToolCall
      results.push(toolResult)
    }
    yield {
      toolName: 'set_output',
      input: {
        results,
        actor: { agentId: agentState.agentId, runId: agentState.runId },
      },
    }
  },
}

function fixture(configuration: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-run-host-'))
  roots.push(root)
  const configFile = path.join(root, 'openbuff.json')
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      autoFileChangeHooks: false,
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'https://fixture.invalid/v1',
          models: ['fixture-model'],
          apiKeyEnv: 'CUSTOM_PROVIDER_KEY',
        },
      },
      ...configuration,
    }),
  )
  const environment: Record<string, string | undefined> = {
    PATH: '/usr/bin:/bin',
    HOME: path.join(root, 'home'),
    PROJECT_VALUE: 'host-public',
    DELETE_ME: 'host-delete',
    OPENAI_API_KEY: 'host-canonical-secret',
    CUSTOM_PROVIDER_KEY: 'host-configured-secret',
    OPENBUFF_PROCESS_SUPERVISION: '0',
    OPENBUFF_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
  }
  const hostConfiguration: HostConfigurationInputs = {
    environment,
    platform: 'linux',
    invocationCwd: root,
    projectRoot: root,
    home: { kind: 'none' },
    globals: { kind: 'disabled' },
    selection: { kind: 'explicit', path: configFile, required: true },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  }
  const configReads: string[] = []
  const configReadFs: ConfigReadFs = {
    readFile: (file) => {
      configReads.push(file)
      return nodeConfigReadFs.readFile(file)
    },
    stat: (file) => nodeConfigReadFs.stat(file),
    readDirectory: (file) => nodeConfigReadFs.readDirectory(file),
    realpath: (file) => nodeConfigReadFs.realpath(file),
  }
  const launches: Array<{
    command: string
    argv: readonly string[]
    env: NodeJS.ProcessEnv | undefined
  }> = []
  const spawned: ChildProcess[] = []
  const launch: CodebuffSpawn = (command, argv, options) => {
    launches.push({ command, argv: [...(argv ?? [])], env: options?.env })
    const child = spawn(command, [...(argv ?? [])], options ?? {})
    spawned.push(child)
    children.push(child)
    childExits.push(new Promise((resolve) => child.once('close', resolve)))
    return child
  }
  const events: LaunchEvent[] = [],
    callbacks: PrintModeEvent[] = []
  const defaults: OpenbuffClientOptions = {
    cwd: root,
    projectFiles: {},
    knowledgeFiles: {},
    harnessStateDir: path.join(root, '.openbuff', 'harness'),
    hostConfiguration,
    configReadFs,
    spawnSource: launch,
    fsSource: createNodeFileSystem(),
    approvalMode: 'allow-all',
    recordExecution: (event) => {
      events.push(event)
    },
    handleEvent: (event) => {
      callbacks.push(event)
    },
  }
  const client = new OpenbuffClient(defaults)
  const run = (
    calls: unknown[],
    options: OpenbuffClientOptions & { agent?: AgentDefinition } = {},
    signal?: AbortSignal,
  ) =>
    client.run({
      agent: program,
      prompt: JSON.stringify(calls),
      ...options,
      signal,
    })
  const terminal = (command: string, extra: Record<string, unknown> = {}) => ({
    toolName: 'run_terminal_command',
    input: { command, process_type: 'SYNC', ...extra },
  })
  return {
    root,
    configFile,
    environment,
    hostConfiguration,
    configReadFs,
    configReads,
    launches,
    launch,
    spawned,
    events,
    callbacks,
    run,
    terminal,
    client,
  }
}

function terminalStarts(events: LaunchEvent[]) {
  return events.filter(
    (event): event is Extract<LaunchEvent, { phase: 'spawn-observed' }> =>
      event.phase === 'spawn-observed' &&
      event.facts.family === 'sync-shell' &&
      event.facts.branchId === 'terminal.sync',
  )
}

function assertStructuredOutput(result: RunState) {
  if (result.output.type !== 'structuredOutput')
    throw new Error(
      `Expected programmatic output: ${JSON.stringify(result.output)}`,
    )
  expect(result.output.type).toBe('structuredOutput')
}

describe('B19 actual programmatic run host wiring', () => {
  test('a restored synthetic snapshot cannot override the host workspace journal', async () => {
    const f = fixture()
    const first = await f.run([f.terminal('printf first')])
    const legacy = structuredClone(first)
    legacy.sessionState!.mainAgentState.workspaceState = {
      ...legacy.sessionState!.mainAgentState.workspaceState!,
      revision: 999,
      snapshotId: 'legacy-synthetic-snapshot',
    }
    const resumed = await f.client.run({
      agent: program,
      previousRun: legacy,
      prompt: JSON.stringify([f.terminal('printf resumed')]),
    })
    assertStructuredOutput(resumed)
    expect(resumed.sessionState!.mainAgentState.workspaceState?.revision).toBe(
      2,
    )
    expect(
      resumed.actionOutcomes
        ?.filter((action) => action.toolName === 'run_terminal_command')
        .at(-1)?.basis.workspaceRevision,
    ).toBe(1)
  }, 15_000)

  test('a sibling journal change during approval refuses the original commit without launching it', async () => {
    const f = fixture()
    expect(spawnSync('git', ['init', '--quiet'], { cwd: f.root }).status).toBe(
      0,
    )
    fs.writeFileSync(path.join(f.root, 'owned.txt'), 'owned\n')
    expect(spawnSync('git', ['add', 'owned.txt'], { cwd: f.root }).status).toBe(
      0,
    )
    const result = await f.run(
      [f.terminal('git commit -m "fix: align workspace fixture"')],
      {
        approvalMode: 'strict',
        requestApproval: async () => {
          const journal = await WorkspaceJournalService.create({
            rootDir: path.join(f.root, '.openbuff', 'harness'),
            cwd: f.root,
            executionContext: actualHosts[0]!.bootstrap,
          })
          fs.writeFileSync(path.join(f.root, 'sibling.txt'), 'sibling edit\n')
          journal.advance({
            runId: 'sibling',
            source: 'sibling-editor',
            actions: [{ action: 'unknown', path: 'sibling.txt' }],
          })
          return true
        },
      },
    )
    expect(terminalStarts(f.events)).toHaveLength(0)
    expect(
      result.actionOutcomes?.find(
        (action) => action.toolName === 'run_terminal_command',
      ),
    ).toMatchObject({
      outcome: 'refused',
      basis: { workspaceRevision: 0 },
      cause: { code: 'execution_stale-authority' },
    })
    const refused = f.events.find((event) => event.phase === 'no-launch')
    expect(refused?.phase === 'no-launch' && refused.refusal.cause).toContain(
      'expected workspace.v1.0.',
    )
    expect(refused?.phase === 'no-launch' && refused.refusal.cause).toContain(
      'actual workspace.v1.1.',
    )
    expect(result.sessionState!.mainAgentState.workspaceState?.revision).toBe(1)
  }, 15_000)
  test.each([false, true])(
    'git child status/status/commit retains host authority, supervision=%s',
    async (supervision) => {
      const f = fixture()
      f.environment.OPENBUFF_PROCESS_SUPERVISION = String(supervision)
      expect(
        spawnSync('git', ['init', '--quiet'], { cwd: f.root }).status,
      ).toBe(0)
      expect(
        spawnSync('git', ['config', 'user.name', 'Workspace fixture'], {
          cwd: f.root,
        }).status,
      ).toBe(0)
      expect(
        spawnSync('git', ['config', 'user.email', 'fixture@example.invalid'], {
          cwd: f.root,
        }).status,
      ).toBe(0)
      fs.writeFileSync(path.join(f.root, 'owned.txt'), 'owned change\n')
      expect(
        spawnSync('git', ['add', 'owned.txt'], { cwd: f.root }).status,
      ).toBe(0)
      const commands = [
        'git status --short',
        'git status --short',
        'git commit -m "fix: align workspace fixture"',
      ]
      let generations = 0
      const stream = spyOn(llm, 'promptAiSdkStream').mockImplementation(
        async function* () {
          const command = commands[generations++]
          yield createToolCallChunk(
            command ? 'run_terminal_command' : 'end_turn',
            command ? { command } : {},
          )
          return promptSuccess('fixture-response')
        },
      )
      const child: AgentDefinition = {
        id: 'workspace-git-child',
        displayName: 'Git child',
        model: 'fixture-model',
        toolNames: ['run_terminal_command', 'end_turn'],
        outputMode: 'last_message',
        includeMessageHistory: false,
      }
      const parent: AgentDefinition = {
        id: 'workspace-git-parent',
        displayName: 'Git parent',
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
                  agent_type: 'workspace-git-child',
                  prompt: 'Commit the staged owned change. Do not push.',
                },
              ],
            },
          }
          yield { toolName: 'set_output', input: { result: toolResult } }
        },
      }
      try {
        const result = await f.run([], {
          agent: parent,
          agentDefinitions: [child],
        })
        assertStructuredOutput(result)
        expect(generations).toBe(4)
        expect(
          spawnSync('git', ['log', '-1', '--format=%s'], {
            cwd: f.root,
            encoding: 'utf8',
          }).stdout.trim(),
        ).toBe('fix: align workspace fixture')
        expect(terminalStarts(f.events)).toHaveLength(3)
        expect(
          result.sessionState!.mainAgentState.workspaceState?.revision,
        ).toBe(3)
        expect(
          f.events.some(
            (event) =>
              event.phase === 'no-launch' &&
              event.refusal.reason === 'stale-authority',
          ),
        ).toBe(false)
        if (supervision)
          expect(
            f.events.some(
              (event) =>
                event.phase === 'spawn-observed' &&
                event.facts.family === 'supervised-child',
            ),
          ).toBe(true)
        else
          expect(
            f.events.some(
              (event) =>
                event.phase === 'spawn-observed' &&
                event.facts.family === 'supervised-child',
            ),
          ).toBe(false)
      } finally {
        stream.mockRestore()
      }
    },
    30_000,
  )

  test('a started command that writes and fails advances host state; a denied command does not', async () => {
    const f = fixture()
    const changed = await f.run([
      f.terminal(
        `${shellArg(nodeExecutable!)} -e 'require("fs").writeFileSync("partial.txt", "changed"); process.exit(7)'`,
      ),
    ])
    assertStructuredOutput(changed)
    expect(changed.sessionState!.mainAgentState.workspaceState?.revision).toBe(
      1,
    )
    expect(fs.readFileSync(path.join(f.root, 'partial.txt'), 'utf8')).toBe(
      'changed',
    )
    const denied = await f.run(
      [f.terminal('rm -rf disposable'), f.terminal('printf must-not-run')],
      {
        approvalMode: 'strict',
        requestApproval: async () => false,
      },
    )
    expect(denied.runOutcome?.termination).toBe('failed')
    expect(
      denied.actionOutcomes?.filter(
        (action) => action.toolName === 'run_terminal_command',
      ),
    ).toHaveLength(1)
    expect(denied.actionOutcomes?.at(-1)).toMatchObject({
      outcome: 'refused',
      cause: { code: 'execution_denied' },
    })
    expect(denied.sessionState!.mainAgentState.workspaceState).toEqual(
      changed.sessionState!.mainAgentState.workspaceState,
    )
  }, 15_000)
  test('loaded approval config applies to actual SDK runs without an explicit option', async () => {
    const f = fixture({ approvalMode: 'allow-all' })
    let prompts = 0
    const result = await f.run(
      [
        f.terminal(
          `${shellArg(nodeExecutable!)} -e 'process.stdout.write("configured")'`,
        ),
      ],
      {
        approvalMode: undefined,
        requestApproval: async () => {
          prompts++
          return false
        },
      },
    )
    assertStructuredOutput(result)
    expect(prompts).toBe(0)
    expect(terminalStarts(f.events)).toHaveLength(1)
    expect(actualHosts[0]?.approvalMode).toBe('allow-all')
  }, 15_000)

  test('explicit SDK mode overrides config and config changes cannot alter an active run', async () => {
    const f = fixture({ approvalMode: 'allow-all' })
    let prompts = 0
    const result = await f.run(
      [
        f.terminal('printf routine'),
        f.terminal(
          `${shellArg(nodeExecutable!)} -e 'process.stdout.write("first")'`,
        ),
        f.terminal(
          `${shellArg(nodeExecutable!)} -e 'process.stdout.write("second")'`,
        ),
      ],
      {
        approvalMode: 'strict',
        requestApproval: async () => {
          prompts++
          fs.writeFileSync(
            f.configFile,
            JSON.stringify({ approvalMode: 'allow-all' }),
          )
          return false
        },
      },
    )
    expect(result.runOutcome?.termination).toBe('failed')
    expect(prompts).toBe(1)
    expect(terminalStarts(f.events)).toHaveLength(1)
    expect(actualHosts[0]?.approvalMode).toBe('strict')
  }, 15_000)

  test('configured strict asks for classified effects while routine commands remain prompt-free', async () => {
    const f = fixture({ approvalMode: 'strict' })
    const actions: string[] = []
    const result = await f.run(
      [
        f.terminal('printf routine'),
        f.terminal('git commit -m example'),
        f.terminal('rm -rf disposable'),
      ],
      {
        approvalMode: undefined,
        requestApproval: async (request) => {
          actions.push(request.action)
          return false
        },
      },
    )
    expect(result.runOutcome?.termination).toBe('failed')
    expect(actions).toEqual(['commit'])
    expect(terminalStarts(f.events)).toHaveLength(1)
    expect(actualHosts[0]?.approvalMode).toBe('strict')
  }, 15_000)

  test('balanced runs execute Git reads and prompt only for a destructive command', async () => {
    const f = fixture()
    expect(spawnSync('git', ['init', '--quiet'], { cwd: f.root }).status).toBe(
      0,
    )
    const approvedTargets: string[] = []
    const result = await f.run(
      [
        { toolName: 'git_status', input: {} },
        f.terminal('git status --short'),
        f.terminal('rm -rf disposable'),
      ],
      {
        approvalMode: 'balanced',
        requestApproval: async (request) => {
          approvedTargets.push(request.target)
          return false
        },
      },
    )
    expect(result.runOutcome?.termination).toBe('failed')
    expect(approvedTargets).toHaveLength(1)
    expect(approvedTargets[0]).toContain('disposable')
    expect(f.launches.some((launch) => launch.argv.includes('status'))).toBe(
      true,
    )
    expect(terminalStarts(f.events)).toHaveLength(1)
    const read = result.actionOutcomes?.find(
      (action) => action.toolName === 'git_status',
    )
    expect(read?.outcome).toBe('succeeded')
  }, 15_000)

  test('terminal callbacks retain actual B02 action/attempt/run identities and unbounded default/-1', async () => {
    const f = fixture()
    const result = await f.run([
      f.terminal('printf first'),
      f.terminal('printf second', { timeout_seconds: -1 }),
    ])
    assertStructuredOutput(result)
    expect(result.runOutcome?.termination).toBe('completed')
    const starts = terminalStarts(f.events)
    expect(starts).toHaveLength(2)
    const actions = result.actionOutcomes!.filter(
      (action) => action.toolName === 'run_terminal_command',
    )
    expect(actions).toHaveLength(2)
    for (const start of starts) {
      const correlation = start.facts.correlation
      if (correlation.kind !== 'action')
        throw new Error('Tool launch lost B02 action correlation')
      const action = actions.find(
        (action) => action.actionId === correlation.actionId,
      )!
      expect(action).toBeDefined()
      expect(action.attemptId).toBe(correlation.attemptId)
      expect(action.runId).toBe(result.sessionState!.mainAgentState.runId!)
      expect(correlation.owner.parentRunId).toBe(action.runId)
      expect(correlation.owner.rootRunId).toBe(action.runId)
      expect(correlation.owner.parentAgentId).toBe(
        result.sessionState!.mainAgentState.agentId,
      )
      expect(start.facts.deadlines.requestAdmission.kind).toBe('unbounded')
      const callback = f.callbacks.find(
        (event) =>
          event.type === 'tool_result' &&
          event.actionOutcome?.actionId === action.actionId,
      )
      expect(callback).toMatchObject({
        type: 'tool_result',
        actionOutcome: action,
      })
    }
    expect(
      new Set(
        starts.map(
          (start) =>
            start.facts.correlation.kind === 'action' &&
            start.facts.correlation.actionId,
        ),
      ).size,
    ).toBe(2)
    expect(f.configReads.every((file) => file === f.configFile)).toBe(true)
  }, 15_000)

  test('configured hooks honor the selected cap, default to unbounded, and do not infer repository scripts', async () => {
    const f = fixture({
      fileChangeHooks: [
        { name: 'default', command: 'printf default-hook' },
        { name: 'bounded', command: 'printf bounded-hook', timeoutSeconds: 300 },
        {
          name: 'unbounded',
          command: 'printf unbounded-hook',
          timeoutSeconds: -1,
        },
      ],
    })
    const forbidden = path.join(f.root, 'inferred-must-not-run')
    fs.writeFileSync(
      path.join(f.root, 'package.json'),
      JSON.stringify({
        scripts: { test: `touch ${forbidden}`, lint: `touch ${forbidden}` },
      }),
    )
    const before = hostExecution.executionClock.nowMs()
    const result = await f.run([
      {
        toolName: 'run_file_change_hooks',
        input: { files: ['src/example.ts'] },
      },
    ])
    const after = hostExecution.executionClock.nowMs()
    expect(result.output.type).toBe('structuredOutput')
    const hooks = f.events.filter(
      (event): event is Extract<LaunchEvent, { phase: 'spawn-observed' }> =>
        event.phase === 'spawn-observed' &&
        event.facts.family === 'configured-hook',
    )
    expect(hooks).toHaveLength(3)
    expect(
      hooks.every(
        (event) => event.facts.branchId === 'hook.configured.project',
      ),
    ).toBe(true)
    const bounded = hooks.find(
      (event) => event.facts.deadlines.requestAdmission.kind === 'finite',
    )!
    const deadline = bounded.facts.deadlines.requestAdmission
    if (deadline.kind !== 'finite')
      throw new Error('Explicit hook deadline must be finite')
    expect(deadline.expiresAtMs).toBeGreaterThanOrEqual(before + 300_000)
    expect(deadline.expiresAtMs).toBeLessThanOrEqual(after + 300_000)
    expect(
      hooks.filter(
        (event) => event.facts.deadlines.requestAdmission.kind === 'unbounded',
      ),
    ).toHaveLength(2)
    expect(fs.existsSync(forbidden)).toBe(false)
    expect(
      f.launches.some((launch) => /^(npm|pnpm|bun)$/.test(launch.command)),
    ).toBe(false)
  }, 15_000)

  test.each(['journal', 'broker'])(
    'an unavailable backend at %s bootstrap refuses before process dispatch',
    async (bootstrap) => {
      const f = fixture()
      const stateDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'openbuff-run-bootstrap-state-'),
      )
      roots.push(stateDir)
      const result = await f.run([f.terminal('printf must-not-run')], {
        harnessStateDir: stateDir,
        ...(bootstrap === 'broker' ? { fsSource: undefined } : {}),
        executionProfile: {
          policy: 'full-access',
          preferredBackend: 'native-exec',
          required: ['exact-env'],
          allowBackendFallback: false,
        },
      })
      expect(f.launches).toEqual([])
      expect(f.events.some((event) => event.phase === 'dispatched')).toBe(false)
      expect(JSON.stringify(result)).toMatch(/unavailable|required|backend/i)
    },
    15_000,
  )

  test('an inherited deadline retains its original expiry and a relative limit can only narrow it', async () => {
    for (const runTimeoutMs of [undefined, 1000]) {
      const f = fixture()
      const captured = captureRunDeadline(5000)
      if (!captured.ok) throw new Error(captured.cause)
      const parent = captured.value.deadline
      if (parent.kind !== 'finite')
        throw new Error('Expected a finite captured deadline')
      const before = performance.now()
      const result = await f.run([f.terminal('printf inherited-deadline')], {
        runDeadline: captured.value,
        runTimeoutMs,
      })
      expect(result.output.type).toBe('structuredOutput')
      const starts = terminalStarts(f.events)
      expect(starts).toHaveLength(1)
      const deadline = starts[0]!.facts.deadlines.action
      expect(deadline.kind).toBe('finite')
      if (deadline.kind !== 'finite')
        throw new Error('Expected inherited finite action deadline')
      expect(deadline.expiresAtMs).toBeLessThanOrEqual(parent.expiresAtMs)
      if (runTimeoutMs === undefined)
        expect(deadline.expiresAtMs).toBe(parent.expiresAtMs)
      else {
        expect(deadline.expiresAtMs).toBeGreaterThanOrEqual(
          before + runTimeoutMs,
        )
        expect(deadline.expiresAtMs).toBeLessThanOrEqual(
          performance.now() + runTimeoutMs,
        )
        expect(deadline.expiresAtMs).toBeLessThan(parent.expiresAtMs)
      }
    }
  })

  test('an expired inherited deadline refuses before configuration and target setup', async () => {
    const f = fixture()
    const captured = captureRunDeadline(5)
    if (!captured.ok) throw new Error(captured.cause)
    const until = performance.now() + 10
    while (performance.now() < until) {
      /* host/client setup consumed the original budget */
    }
    const result = await f.run([f.terminal('printf must-not-run')], {
      runDeadline: captured.value,
      runTimeoutMs: 5000,
    })
    expect(result.runOutcome?.termination).toBe('deadline_exhausted')
    expect(result.output).toMatchObject({
      type: 'error',
      message: 'Run deadline exhausted before setup',
    })
    expect(f.configReads).toEqual([])
    expect(f.launches).toEqual([])
  })

  test('foreign-clock and malformed inherited deadline seeds fail closed before setup', async () => {
    const captured = captureRunDeadline(5000)
    if (!captured.ok) throw new Error(captured.cause)
    for (const runDeadline of [
      { ...captured.value, domainId: 'foreign-sdk-clock' },
      {
        domainId: captured.value.domainId,
        sampledAtMs: captured.value.sampledAtMs,
      },
    ] as import('@codebuff/common/types/contracts/execution-context').RootDeadlineSeed[]) {
      const f = fixture()
      const result = await f.run([f.terminal('printf must-not-run')], {
        runDeadline,
      })
      expect(result.runOutcome).toMatchObject({
        termination: 'failed',
        cause: { code: 'execution_invalid-context' },
      })
      expect(f.configReads).toEqual([])
      expect(f.launches).toEqual([])
    }
  })

  test('the root deadline starts before a blocking configuration read', async () => {
    const f = fixture()
    let blocked = false
    const reader: ConfigReadFs = {
      ...f.configReadFs,
      readFile(file) {
        if (!blocked) {
          blocked = true
          const until = performance.now() + 40
          while (performance.now() < until) {
            /* deliberately block synchronous setup */
          }
        }
        return f.configReadFs.readFile(file)
      },
    }
    const result = await f.run([f.terminal('printf must-not-run')], {
      runTimeoutMs: 10,
      configReadFs: reader,
    })
    expect(blocked).toBe(true)
    expect(result.runOutcome?.termination).toBe('deadline_exhausted')
    expect(f.launches).toEqual([])
    expect(f.events.some((event) => event.phase === 'dispatched')).toBe(false)
  })

  test('a pending asynchronous spawn setup cannot renew the root deadline', async () => {
    const f = fixture()
    let release!: (launch: CodebuffSpawn) => void
    const pending = new Promise<CodebuffSpawn>((resolve) => {
      release = resolve
    })
    const result = await f.run([f.terminal('printf must-not-run')], {
      runTimeoutMs: 20,
      spawnSource: pending,
    })
    release(f.launch)
    expect(result.runOutcome?.termination).toBe('deadline_exhausted')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.launches).toEqual([])
  })

  test('same-text caller cancellation during asynchronous setup remains cancelled', async () => {
    const f = fixture(),
      stop = new AbortController()
    let release!: (launch: CodebuffSpawn) => void
    const spawnSource = new Promise<CodebuffSpawn>((resolve) => {
      release = resolve
    })
    const pending = f.run(
      [f.terminal('printf must-not-run')],
      { runTimeoutMs: 5_000, spawnSource },
      stop.signal,
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    stop.abort(new Error('Execution deadline exhausted'))
    const result = await pending
    release(f.launch)
    expect(result.runOutcome).toMatchObject({
      termination: 'cancelled',
      cause: { code: 'run_cancelled' },
    })
    expect(f.launches).toEqual([])
  })

  test('same-text caller cancellation during an actual SDK terminal action remains cancelled', async () => {
    const f = fixture(),
      stop = new AbortController()
    const journal: JournalEvent[] = []
    let started!: () => void
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    const pending = f.run(
      [f.terminal('/usr/bin/sleep 30')],
      {
        runTimeoutMs: 5_000,
        journalWriter: {
          append: (_id, event) => journal.push(structuredClone(event)),
        },
        recordExecution(event) {
          f.events.push(event)
          if (
            event.phase === 'spawn-observed' &&
            event.facts.branchId === 'terminal.sync'
          )
            started()
        },
      },
      stop.signal,
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        start,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('SDK terminal did not start within 1s')),
            1_000,
          )
        }),
      ])
      stop.abort(new Error('Execution deadline exhausted'))
      const result = await pending
      expect(result.runOutcome).toMatchObject({
        termination: 'cancelled',
        cause: { code: 'run_cancelled' },
      })
      expect(result.sessionState).toBeDefined()
      expect(terminalStarts(f.events)).toHaveLength(1)
      expect(result.sessionState!.mainAgentState.workspaceState?.revision).toBe(
        1,
      )
      const terminal = journal.filter(
        (event) => (event.payload as { terminal?: boolean }).terminal,
      )
      expect(terminal).toHaveLength(1)
      expect(terminal[0].payload).toMatchObject({
        runOutcome: result.runOutcome,
        taskAcceptance: { status: 'unknown' },
      })
      expect(result.output).toEqual({
        type: 'error',
        message: result.runOutcome!.cause!.message,
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      stop.abort(new Error('Fixture cleanup'))
      await pending
    }
  })

  test('authenticated root deadline agrees across SDK output and terminal journal', async () => {
    const f = fixture(),
      journal: JournalEvent[] = []
    const result = await f.run([f.terminal('/usr/bin/sleep 30')], {
      runTimeoutMs: 500,
      journalWriter: {
        append: (_id, event) => journal.push(structuredClone(event)),
      },
    })
    expect(terminalStarts(f.events)).toHaveLength(1)
    expect(result.runOutcome).toEqual({
      termination: 'deadline_exhausted',
      cause: {
        code: 'run_deadline_exhausted',
        message: 'Run timed out after 500ms',
      },
    })
    expect(result.sessionState!.mainAgentState.workspaceState?.revision).toBe(1)
    const terminal = journal.filter(
      (event) => (event.payload as { terminal?: boolean }).terminal,
    )
    expect(terminal).toHaveLength(1)
    expect(terminal[0].payload).toMatchObject({
      runOutcome: result.runOutcome,
      taskAcceptance: { status: 'unknown' },
    })
    expect(result.output).toEqual({
      type: 'error',
      message: result.runOutcome!.cause!.message,
    })
  }, 5_000)

  test('caller abort after terminal journal publication preserves the finalized outcome', async () => {
    const f = fixture(),
      stop = new AbortController(),
      journal: JournalEvent[] = []
    const result = await f.run(
      [],
      {
        journalWriter: {
          append: (_id, event) => {
            journal.push(structuredClone(event))
            if ((event.payload as { terminal?: boolean }).terminal)
              stop.abort(new Error('late caller cancellation'))
          },
        },
      },
      stop.signal,
    )
    expect(stop.signal.aborted).toBe(true)
    expect(result.runOutcome).toEqual({ termination: 'completed' })
    expect(result.output.type).toBe('structuredOutput')
    const terminal = journal.filter(
      (event) => (event.payload as { terminal?: boolean }).terminal,
    )
    expect(terminal).toHaveLength(1)
    expect(terminal[0].payload).toMatchObject({ runOutcome: result.runOutcome })
  })

  test('child-local failure cannot select the root outcome by clearing mutable ancestry', async () => {
    const f = fixture(),
      journal: Array<{ runId: string; event: JournalEvent }> = []
    const child: AgentDefinition = {
      id: 'b19-child-outcome',
      displayName: 'Child outcome control',
      model: 'fixture-model',
      toolNames: [],
      outputMode: 'structured_output',
      handleSteps: function* ({ agentState }) {
        const state = agentState as unknown as AgentState
        state.ancestorRunIds = []
        throw new Error('Execution deadline exhausted')
      },
    }
    const parent: AgentDefinition = {
      id: 'b19-parent-outcome',
      displayName: 'Parent outcome control',
      model: 'fixture-model',
      toolNames: ['spawn_agent_inline'],
      spawnableAgents: [child.id],
      outputMode: 'structured_output',
      handleSteps: function* ({ agentState }) {
        // The runtime's internal inline tool is omitted from the public ToolCall union.
        yield {
          toolName: 'spawn_agent_inline',
          input: {
            agent_type: 'b19-child-outcome',
            prompt: 'local failure control',
          },
        } as unknown as ToolCall
        const state = agentState as unknown as AgentState
        state.output = { childReturned: true }
      },
    }
    const result = await f.client.run({
      agent: parent,
      prompt: 'root outcome control',
      agentDefinitions: [child],
      journalWriter: {
        append: (runId, event) =>
          journal.push({ runId, event: structuredClone(event) }),
      },
    })
    expect(result.runOutcome).toEqual({ termination: 'completed' })
    const terminal = journal.filter(
      ({ event }) => (event.payload as { terminal?: boolean }).terminal,
    )
    expect(terminal).toHaveLength(2)
    const rootRunId = result.sessionState!.mainAgentState.runId
    const root = terminal.find((row) => row.runId === rootRunId)!
    const local = terminal.find((row) => row.runId !== rootRunId)!
    expect(root.event.payload).toMatchObject({ runOutcome: result.runOutcome })
    expect(local.event.payload).toMatchObject({
      runOutcome: {
        termination: 'failed',
        cause: { code: 'programmatic_execution_error' },
      },
    })
  })

  test.each([false, true])(
    'child inheritance=%s preserves deletion and keeps provider credentials separate',
    async (inheritEnv) => {
      const f = fixture(),
        recorder = path.join(f.root, 'recorder.cjs'),
        observed = path.join(f.root, 'observed.json')
      fs.writeFileSync(
        recorder,
        'require("node:fs").writeFileSync(process.argv[2],JSON.stringify(process.env))',
      )
      const env = {
        PROJECT_VALUE: 'child-public',
        DELETE_ME: undefined,
        OPENAI_API_KEY: 'child-reinsert',
        CUSTOM_PROVIDER_KEY: 'child-reinsert-custom',
      }
      const result = await f.run(
        [
          f.terminal(
            `${shellArg(nodeExecutable)} ${shellArg(recorder)} ${shellArg(observed)}`,
          ),
        ],
        { inheritEnv, env },
      )
      expect(result.output.type).toBe('structuredOutput')
      const recorded = JSON.parse(fs.readFileSync(observed, 'utf8'))
      expect(recorded.PROJECT_VALUE).toBe('child-public')
      expect(recorded.DELETE_ME).toBeUndefined()
      expect(recorded.OPENAI_API_KEY).toBeUndefined()
      expect(recorded.CUSTOM_PROVIDER_KEY).toBeUndefined()
      expect(recorded.HOME).toBe(inheritEnv ? f.environment.HOME : undefined)
      expect(actualHosts).toHaveLength(1)
      expect(actualHosts[0].provider.credentialEnvironment.OPENAI_API_KEY).toBe(
        'host-canonical-secret',
      )
      expect(
        actualHosts[0].provider.credentialEnvironment.CUSTOM_PROVIDER_KEY,
      ).toBe('host-configured-secret')
      expect(actualHosts[0].provider.credentialEnvironment.PROJECT_VALUE).toBe(
        'host-public',
      )
      expect(JSON.stringify(f.events)).not.toContain('host-canonical-secret')
    },
    15_000,
  )

  test('configuration and child env stay captured while asynchronous setup waits', async () => {
    const f = fixture(),
      recorder = path.join(f.root, 'recorder.cjs'),
      observed = path.join(f.root, 'observed.json')
    fs.writeFileSync(
      recorder,
      'require("node:fs").writeFileSync(process.argv[2],JSON.stringify(process.env))',
    )
    let release!: (launch: CodebuffSpawn) => void
    const ready = new Promise<CodebuffSpawn>((resolve) => {
      release = resolve
    })
    const env = { PROJECT_VALUE: 'first-child' }
    const pending = f.run(
      [
        f.terminal(
          `${shellArg(nodeExecutable)} ${shellArg(recorder)} ${shellArg(observed)}`,
        ),
      ],
      { spawnSource: ready, env },
    )
    f.environment.PROJECT_VALUE = 'late-host'
    f.environment.OPENAI_API_KEY = 'late-host-secret'
    env.PROJECT_VALUE = 'late-child'
    release(f.launch)
    const result = await pending
    expect(result.output.type).toBe('structuredOutput')
    expect(JSON.parse(fs.readFileSync(observed, 'utf8')).PROJECT_VALUE).toBe(
      'first-child',
    )
    expect(actualHosts[0].provider.credentialEnvironment.PROJECT_VALUE).toBe(
      'host-public',
    )
    expect(actualHosts[0].provider.credentialEnvironment.OPENAI_API_KEY).toBe(
      'host-canonical-secret',
    )
  }, 15_000)

  test('synchronous config readers cannot change the already captured child env or execution profile', async () => {
    const f = fixture(),
      recorder = path.join(f.root, 'recorder.cjs'),
      observed = path.join(f.root, 'observed.json')
    fs.writeFileSync(
      recorder,
      'require("node:fs").writeFileSync(process.argv[2],JSON.stringify(process.env))',
    )
    const env = { PROJECT_VALUE: 'before-config-read' }
    const profile: NonNullable<OpenbuffClientOptions['executionProfile']> = {
      policy: 'full-access',
      preferredBackend: 'portable-ts',
      required: ['exact-env'],
      allowBackendFallback: false,
    }
    const callerProfile = { ...profile }
    const reader: ConfigReadFs = {
      ...f.configReadFs,
      readFile(file) {
        env.PROJECT_VALUE = 'during-config-read'
        callerProfile.preferredBackend = 'native-exec'
        f.environment.OPENAI_API_KEY = 'during-config-secret'
        return f.configReadFs.readFile(file)
      },
    }
    const result = await f.run(
      [
        f.terminal(
          `${shellArg(nodeExecutable)} ${shellArg(recorder)} ${shellArg(observed)}`,
        ),
      ],
      { env, executionProfile: callerProfile, configReadFs: reader },
    )
    expect(result.output.type).toBe('structuredOutput')
    expect(JSON.parse(fs.readFileSync(observed, 'utf8')).PROJECT_VALUE).toBe(
      'before-config-read',
    )
    expect(terminalStarts(f.events)[0].facts.profile.selected?.backend).toBe(
      'portable-ts',
    )
    expect(actualHosts[0].provider.credentialEnvironment.OPENAI_API_KEY).toBe(
      'host-canonical-secret',
    )
  }, 15_000)

  test('detached real child survives sender cancellation but stops at the transferred finite cap', async () => {
    const f = fixture(),
      stop = new AbortController(),
      recorder = path.join(f.root, 'background.cjs'),
      observed = path.join(f.root, 'ticks')
    fs.writeFileSync(
      recorder,
      'const fs=require("node:fs");const p=process.argv[2];fs.appendFileSync(p,"start\\n");setInterval(()=>fs.appendFileSync(p,"tick\\n"),30)',
    )
    const command = `exec ${shellArg(nodeExecutable)} ${shellArg(recorder)} ${shellArg(observed)}`
    const result = await f.run(
      [
        f.terminal(command, {
          process_type: 'BACKGROUND',
          detach: true,
          timeout_seconds: 1.5,
        }),
      ],
      {},
      stop.signal,
    )
    expect(result.output.type).toBe('structuredOutput')
    const launchIndex = f.launches.findIndex((launch) =>
      launch.argv.some((arg) => arg.includes(recorder)),
    )
    expect(launchIndex).toBeGreaterThanOrEqual(0)
    const child = f.spawned[launchIndex]
    const closed =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once('close', resolve))
    const until = performance.now() + 1000
    while (!fs.existsSync(observed)) {
      if (performance.now() > until)
        throw new Error('Detached recorder never started')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const before = fs.readFileSync(observed, 'utf8').length
    stop.abort(new Error('sender run cancelled after detach'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fs.readFileSync(observed, 'utf8').length).toBeGreaterThan(before)
    const transferred = f.events.find(
      (event) => event.phase === 'resource-transferred',
    )!
    const started = f.events.find(
      (event) =>
        event.phase === 'spawn-observed' &&
        event.facts.branchId === 'background.transferred',
    )!
    expect(transferred?.phase).toBe('resource-transferred')
    if (
      transferred.phase !== 'resource-transferred' ||
      started.phase !== 'spawn-observed'
    )
      throw new Error('Missing detached transfer/start evidence')
    expect(started.facts.ownerId).toBe(transferred.newOwnerId)
    expect(started.facts.ownerId).not.toBe(transferred.oldOwnerId)
    expect(started.facts.deadlines.resourceLifetime).toEqual(
      transferred.resourceLifetime,
    )
    expect(transferred.resourceLifetime.kind).toBe('finite')
    await closed
    expect(child.signalCode).not.toBeNull()
  }, 10_000)
})

describe('repository intelligence before actor execution', () => {
  test.each([false, true])(
    'fresh sessions and transcript-isolated children receive their own packet, supervision=%s',
    async (supervision) => {
      const f = fixture()
      f.environment.OPENBUFF_PROCESS_SUPERVISION = String(supervision)
      const roles: string[] = [],
        modelPackets: string[] = []
      const source = {
        query: async (request: { agentType: string }) => {
          roles.push(request.agentType)
          return {
            freshness: 'current' as const,
            candidates: [
              {
                path: `src/${request.agentType}.ts`,
                reasons: ['remembered-feature'],
              },
            ],
          }
        },
      }
      const stream = spyOn(llm, 'promptAiSdkStream').mockImplementation(
        async function* (input) {
          const packet = JSON.stringify(input.messages)
          expect(packet).toContain('src/context-child.ts')
          expect(packet).not.toContain('src/context-parent.ts')
          modelPackets.push(packet)
          yield createToolCallChunk('end_turn', {})
          return promptSuccess('known feature')
        },
      )
      const child: AgentDefinition = {
        id: 'context-child',
        displayName: 'Context child',
        model: 'fixture-model',
        toolNames: ['end_turn'],
        outputMode: 'last_message',
        includeMessageHistory: false,
      }
      const parent: AgentDefinition = {
        id: 'context-parent',
        displayName: 'Context parent',
        model: 'fixture-model',
        toolNames: ['spawn_agents', 'set_output'],
        spawnableAgents: [child.id],
        outputMode: 'structured_output',
        handleSteps: function* ({ agentState }) {
          const packet = agentState.repositoryContext
          if (!packet?.briefing.includes('src/context-parent.ts'))
            throw new Error('Parent context missing before first execution')
          const { toolResult } = yield {
            toolName: 'spawn_agents',
            input: {
              agents: [
                {
                  agent_type: 'context-child',
                  prompt: 'Use prior feature context.',
                },
              ],
            },
          }
          yield {
            toolName: 'set_output',
            input: {
              ready: true,
              packetActor: packet.actor,
              metrics: packet.metrics,
              child: toolResult,
            },
          }
        },
      }
      try {
        const first = await f.client.run({
          agent: parent,
          prompt: 'Continue the feature',
          agentDefinitions: [child],
          repositoryIntelligence: source,
        })
        const second = await f.client.run({
          agent: parent,
          prompt: 'Continue the feature',
          agentDefinitions: [child],
          repositoryIntelligence: source,
        })
        assertStructuredOutput(first)
        assertStructuredOutput(second)
        expect(first.sessionState!.mainAgentState.runId).not.toBe(
          second.sessionState!.mainAgentState.runId,
        )
        expect(roles).toEqual([
          'context-parent',
          'context-child',
          'context-parent',
          'context-child',
        ])
        expect(modelPackets).toHaveLength(2)
        expect(terminalStarts(f.events)).toHaveLength(0)
      } finally {
        stream.mockRestore()
      }
    },
    30_000,
  )
})

describe('host validation production and child gate reuse', () => {
  test.each([
    [false, true],
    [true, true],
    [false, false],
    [true, false],
  ])(
    'native validation receipts cross actors without another check, supervision=%s, validation=%s',
    async (supervision, validate) => {
      const f = fixture({
        fileChangeHooks: [
          { name: 'typecheck', command: 'tsc --noEmit -p .' },
          { name: 'test', command: 'bun test --isolate' },
        ],
      })
      f.environment.OPENBUFF_PROCESS_SUPERVISION = String(supervision)
      f.environment.OPENBUFF_PLAYBOOK_GATE = 'block'
      fs.mkdirSync(path.join(f.root, 'src'))
      fs.mkdirSync(path.join(f.root, 'node_modules', '.bin'), {
        recursive: true,
      })
      const tsc = path.resolve(
        import.meta.dir,
        '../../../node_modules/typescript/bin/tsc',
      )
      fs.symlinkSync(tsc, path.join(f.root, 'node_modules', '.bin', 'tsc'))
      const node = Bun.which('node')
      if (!node) throw new Error('The validation fixture requires Node for tsc')
      f.environment.PATH = [
        path.join(f.root, 'node_modules', '.bin'),
        path.dirname(process.execPath),
        path.dirname(node),
        '/usr/bin',
        '/bin',
      ].join(path.delimiter)
      fs.writeFileSync(
        path.join(f.root, 'package.json'),
        JSON.stringify({
          scripts: {
            typecheck: 'tsc --noEmit -p .',
            test: 'bun test --isolate',
          },
        }),
      )
      fs.writeFileSync(
        path.join(f.root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { skipLibCheck: true, target: 'es2022' },
          include: ['src/*.ts'],
        }),
      )
      fs.writeFileSync(
        path.join(f.root, 'src', 'feature.ts'),
        'export const feature: number = 1\n',
      )
      fs.writeFileSync(
        path.join(f.root, 'feature.test.ts'),
        'import {test, expect} from "bun:test"; test("feature", () => expect(1).toBe(1));\n',
      )
      for (const args of [
        ['init', '--quiet'],
        ['config', 'user.name', 'Receipt fixture'],
        ['config', 'user.email', 'fixture@example.invalid'],
        ['add', 'src/feature.ts'],
      ])
        expect(spawnSync('git', args, { cwd: f.root }).status).toBe(0)
      const projectId = ProjectIdSchema.parse('project-validation-host')
      const trigger = {
        tool: 'run_terminal_command' as const,
        terminalAction: 'git-commit' as const,
        requireEvidence: [
          {
            kind: 'validationSucceeded' as const,
            validationKinds: ['package-checks'],
          },
        ],
      }
      const scope = { repos: [projectId], agentTypes: ['receipt-child'] }
      const rule = MemoryPlaybookSchema.parse({
        schemaVersion: 1,
        playbookId: 'receipt-precondition',
        workspaceId: projectId,
        title: 'Validate before commit',
        instruction: 'Run the package checks successfully before committing.',
        trigger,
        scope,
        triggerSignature: computeTriggerSignature(trigger, scope),
        status: 'verified',
        enforcement: 'block',
        counters: {},
        provenance: {
          origin: 'user',
          recordedBy: 'fixture',
          sourceEventIds: [],
          metadata: {},
        },
        createdAt: 1,
        updatedAt: 1,
      })
      const repository = {
        listPlaybooks: async () => [rule],
      } as unknown as MemoryRepositoryV2
      let childSteps = 0
      const stream = spyOn(llm, 'promptAiSdkStream').mockImplementation(
        async function* (input) {
          if (validate)
            expect(JSON.stringify(input.messages)).toContain(
              'Validated: package-checks',
            )
          else
            expect(JSON.stringify(input.messages)).not.toContain(
              'Validated: package-checks',
            )
          yield createToolCallChunk(
            childSteps++ === 0 ? 'run_terminal_command' : 'end_turn',
            childSteps === 1
              ? { command: 'git commit -m "fix: receipt reuse"' }
              : {},
          )
          return promptSuccess('receipt fixture')
        },
      )
      const child: AgentDefinition = {
        id: 'receipt-child',
        displayName: 'Receipt child',
        model: 'fixture-model',
        toolNames: ['run_terminal_command', 'end_turn'],
        outputMode: 'last_message',
        includeMessageHistory: false,
      }
      const parent: AgentDefinition = {
        id: 'receipt-parent',
        displayName: 'Receipt parent',
        model: 'fixture-model',
        toolNames: [
          'run_file_change_hooks',
          'run_terminal_command',
          'spawn_agents',
          'set_output',
        ],
        spawnableAgents: [child.id],
        outputMode: 'structured_output',
        handleSteps: function* ({ prompt }) {
          const { toolResult } = yield prompt === 'validate'
            ? {
                toolName: 'run_file_change_hooks',
                input: { files: ['src/feature.ts'] },
              }
            : {
                toolName: 'run_terminal_command',
                input: { command: 'echo check:ci-local LOOKS_GOOD' },
              }
          const { toolResult: childResult } = yield {
            toolName: 'spawn_agents',
            input: {
              agents: [
                {
                  agent_type: 'receipt-child',
                  prompt: 'Commit the validated owned change. Do not push.',
                },
              ],
            },
          }
          yield {
            toolName: 'set_output',
            input: { hooks: toolResult, child: childResult },
          }
        },
      }
      try {
        const result = await f.client.run({
          agent: parent,
          prompt: validate ? 'validate' : 'echo',
          agentDefinitions: [child],
          memoryV2: { repository, projectId, mode: 'shadow', capture: 'off' },
          repositoryIntelligence: {
            locality: 'local',
            query: async () => ({ freshness: 'current', candidates: [] }),
          },
        })
        assertStructuredOutput(result)
        expect(
          spawnSync('git', ['log', '-1', '--format=%s'], {
            cwd: f.root,
            encoding: 'utf8',
          }).stdout.trim(),
        ).toBe(validate ? 'fix: receipt reuse' : '')
        expect(childSteps).toBe(2)
        expect(
          f.launches.filter((item) =>
            item.argv.some((arg) => arg.includes('tsc --noEmit')),
          ),
        ).toHaveLength(validate ? 1 : 0)
        expect(
          f.launches.filter((item) =>
            item.argv.some((arg) => arg.includes('bun test --isolate')),
          ),
        ).toHaveLength(validate ? 1 : 0)
      } finally {
        stream.mockRestore()
      }
    },
    30_000,
  )
})
