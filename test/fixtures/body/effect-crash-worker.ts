import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { AgentDefinition } from '../../../common/src/templates/initial-agents-dir/types/agent-definition'
import type {
  JournalEvent,
  JournalWriter,
} from '../../../common/src/types/contracts/agent-runtime'
import type { RunState } from '../../../sdk/src/run-state'
import {
  appendOwnedShellMarker,
  openOwnedEffectPeer,
} from './effect-crash-transports'

export const boundaries = [
  'before-dispatch',
  'during-effect',
  'after-effect',
  'after-confirmation',
] as const
export type Boundary = (typeof boundaries)[number]
export type Attempt = { runId: string; callId: string; attemptId: string }
export const families = ['custom', 'terminal-override', 'loopback-mcp'] as const
export type EffectFamily = (typeof families)[number]
const toolName = 'b15_owned_effect'
const effectTools: Record<EffectFamily, string> = {
  custom: toolName,
  'terminal-override': 'run_terminal_command',
  'loopback-mcp': 'fixture/owned_effect',
}
const writeJson = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })

// The generator is serialized by the SDK and must not close over this runner.
const agent: AgentDefinition = {
  id: 'b15-crash-fixture',
  displayName: 'B15 crash fixture',
  model: 'fixture/model',
  toolNames: ['b15_owned_effect'],
  spawnableAgents: [],
  outputMode: 'structured_output',
  handleSteps: function* ({ agentState, params }) {
    if (params?.perform === true) {
      if (params.family === 'terminal-override') {
        yield {
          toolName: 'run_terminal_command',
          input: { command: 'owned-fixture-terminal', process_type: 'SYNC' },
        }
      } else if (params.family === 'loopback-mcp') {
        yield { toolName: 'fixture/owned_effect', input: { canary: 'owned' } }
      } else {
        yield { toolName: 'b15_owned_effect', input: { canary: 'owned' } }
      }
    }
    agentState.output = { fixture: 'finished' }
  },
}

export const effectProgramSha256 = createHash('sha256')
  .update(agent.handleSteps!.toString())
  .digest('hex')

function sentinel(
  root: string,
  filename: string,
  text: string,
  flag: 'a' | 'wx',
) {
  const fd = fs.openSync(path.join(root, filename), flag, 0o600)
  try {
    fs.writeFileSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export async function runEffectCrashChild(
  mode: 'worker' | 'reenter',
  family: EffectFamily,
  boundary: Boundary,
  root: string,
  originalRun?: string,
) {
  assert(boundaries.includes(boundary))
  assert(families.includes(family))
  assert(root === fs.realpathSync(root))
  let fetchCalls = 0
  let peer: ReturnType<typeof openOwnedEffectPeer> | undefined
  const localFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = input instanceof Request ? input.url : String(input)
      if (peer && url === peer.url) return localFetch(input, init)
      fetchCalls++
      throw new Error('B15 fixture refuses any non-fixture fetch')
    },
    { preconnect() {} },
  ) as typeof fetch
  const [
    { OpenbuffClient },
    { getCustomToolDefinition },
    { createRunJournal },
    { z },
  ] = await Promise.all([
    import('../../../sdk/src/client'),
    import('../../../sdk/src/custom-tool'),
    import('../../../packages/agent-runtime/src/util/run-journal'),
    import('zod/v4'),
  ])
  let attempt: Attempt | undefined
  const pause = async (): Promise<never> => {
    assert(attempt)
    assert.equal(fetchCalls, 0)
    process.stdout.write(
      'B15_PAUSED ' +
        JSON.stringify({
          family,
          boundary,
          ...attempt,
          fetchCalls,
          peerCalls: peer?.calls(),
        }) +
        '\n',
    )
    return new Promise<never>(() => {
      setInterval(() => {}, 1_000)
    })
  }
  const workspace = path.join(root, 'workspace')
  const journal = createRunJournal({
    path: path.join(root, 'run.sqlite'),
    batching: { maxBatchEvents: 50, maxBatchDelayMs: 60_000 },
  })
  let effectCalls = 0
  const performEffect = async () => {
    effectCalls++
    // Independent file canaries, never derived from journal values. For the
    // terminal override the marker commands are real and joined; the
    // during-effect stop is between those two bounded commands.
    if (family === 'terminal-override') appendOwnedShellMarker(root, 'effect')
    else sentinel(root, 'counter.txt', 'effect\n', 'a')
    if (mode === 'worker' && boundary === 'during-effect') await pause()
    if (family === 'terminal-override') appendOwnedShellMarker(root, 'finished')
    else sentinel(root, 'finished.txt', 'finished\n', 'a')
  }
  if (family === 'loopback-mcp') peer = openOwnedEffectPeer(performEffect)
  const selectedAgent = {
    ...agent,
    toolNames: [effectTools[family]],
    ...(peer
      ? {
          mcpServers: {
            fixture: {
              type: 'http' as const,
              url: peer.url,
              params: {},
              headers: {},
            },
          },
        }
      : {}),
  }
  const tool = getCustomToolDefinition({
    toolName,
    description:
      'Write one owned fixture counter, with no network or other process effects',
    inputSchema: z.object({ canary: z.literal('owned') }),
    async execute() {
      await performEffect()
      return [{ type: 'json', value: { canary: 'owned', finished: true } }]
    },
  })
  const client = new OpenbuffClient({
    cwd: workspace,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    agentDefinitions: [selectedAgent],
    customToolDefinitions: family === 'custom' ? [tool] : [],
    requestApproval: async (request) =>
      peer !== undefined &&
      request.action === 'mcp-tool' &&
      request.target === `${peer.url} owned_effect`,
    ...(family === 'terminal-override'
      ? {
          overrideTools: {
            run_terminal_command: async (input) => {
              assert.equal(input.command, 'owned-fixture-terminal')
              await performEffect()
              return [
                {
                  type: 'json' as const,
                  value: {
                    command: input.command,
                    stdout: 'owned effect finished',
                    exitCode: 0,
                  },
                },
              ]
            },
          },
        }
      : {}),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    hostConfiguration: {
      environment: {
        PATH: '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
        ...(peer
          ? { OPENBUFF_ALLOWED_LOOPBACK_MCP: new URL(peer.url).host }
          : {}),
      },
      platform: process.platform,
      invocationCwd: workspace,
      projectRoot: workspace,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: {
        kind: 'explicit',
        path: path.join(root, 'provider.json'),
        required: true,
      },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  })
  try {
    const base = { agent: agent.id, prompt: 'Owned effect crash control' }
    const seedFile = path.join(root, 'seed.json')
    if (mode === 'reenter') {
      assert(originalRun)
      // This is a guard probe, not a reconstructed checkpoint. Use a valid
      // SDK session envelope and select the actual journaled interrupted run.
      const previous = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as RunState
      assert(previous.sessionState)
      previous.sessionState.mainAgentState.runId = originalRun
      const result = await client.run({
        ...base,
        previousRun: previous,
        params: { family, perform: true },
        resumeInterruptedTurn: true,
        journalReader: journal,
        journalWriter: journal,
      })
      process.stdout.write(
        'B15_REENTRY ' +
          JSON.stringify({
            output: result.output,
            termination: result.runOutcome?.termination,
            outcomeCode: result.runOutcome?.cause?.code,
            returnedRunId: result.sessionState?.mainAgentState.runId,
            effectCalls,
            fetchCalls,
          }) +
          '\n',
      )
      return
    }
    const seed = await client.run({
      ...base,
      params: { family, perform: false },
    })
    assert.equal(
      seed.runOutcome?.termination,
      'completed',
      JSON.stringify(seed.output),
    )
    assert(seed.sessionState)
    writeJson(seedFile, seed)
    const writer: JournalWriter = {
      captureProgrammaticReplay: true,
      append: (runId, event) => journal.append(runId, event),
      flush: () => journal.flush(),
      async appendDurable(runId: string, event: JournalEvent) {
        const payload = event.payload as {
          toolName?: string
          attemptId?: string
        }
        const fixtureEvent = payload.toolName === effectTools[family]
        if (fixtureEvent && event.eventType === 'tool_call') {
          assert(event.correlation && payload.attemptId)
          attempt = {
            runId,
            callId: event.correlation,
            attemptId: payload.attemptId,
          }
        }
        if (
          fixtureEvent &&
          event.eventType === 'tool_result' &&
          boundary === 'after-effect'
        )
          await pause()
        await journal.appendDurable!(runId, event)
        if (
          fixtureEvent &&
          ((event.eventType === 'tool_call' &&
            boundary === 'before-dispatch') ||
            (event.eventType === 'tool_result' &&
              boundary === 'after-confirmation'))
        )
          await pause()
      },
    }
    const result = await client.run({
      ...base,
      previousRun: seed,
      params: { family, perform: true },
      journalReader: journal,
      journalWriter: writer,
    })
    throw new Error(
      'Fixture was not stopped at the selected effect boundary: ' +
        JSON.stringify(result.output),
    )
  } finally {
    peer?.stop()
    await journal.close()
  }
}
