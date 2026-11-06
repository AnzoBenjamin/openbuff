import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import z from 'zod/v4'

import type { AgentDefinition } from '../../../common/src/templates/initial-agents-dir/types/agent-definition'
import type { AgentState } from '../../../common/src/types/session-state'
import type { RunState } from '../../../sdk/src/run-state'
import type { ChatMessage } from '../../../cli/src/types/chat'

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const evidenceDir = path.resolve(
  argument('--evidence-dir') ??
    '/tmp/openbuff-body-execution-20261106/B02/actual-consumers',
)
assert.equal(Bun.version, '1.3.5', 'B02 acceptance requires pinned Bun')
mkdirSync(evidenceDir, { recursive: true })
const invocationDir = path.join(evidenceDir, crypto.randomUUID())
mkdirSync(invocationDir)
const providerConfigPath = path.join(invocationDir, 'providers.json')
const providerConfig = JSON.stringify({
  providers: {},
  autoFileChangeHooks: false,
  fileChangeHooks: [],
})
writeFileSync(providerConfigPath, providerConfig)
const previousConfig = process.env.OPENBUFF_PROVIDER_CONFIG
process.env.OPENBUFF_PROVIDER_CONFIG = providerConfigPath
let providerCalls = 0
const previousFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  async () => {
    providerCalls++
    throw new Error('B02 fixture attempted a provider/network request')
  },
  { preconnect: () => {} },
) as typeof fetch
const observations: unknown[] = []

// This function is serialized and materialized by the actual SDK/runtime.
// It intentionally captures no fixture closures or imported helpers.
const handleSteps: AgentDefinition['handleSteps'] = function* ({
  agentState,
  params,
}) {
  const state = agentState as unknown as AgentState
  const name = params?.name
  if (name === 'fatal_generator') {
    state.output = { summary: 'retained partial work' }
    throw new Error('fixture fatal generator')
  }
  if (name === 'awaited_rejection' || name === 'mid_cancel') {
    yield { toolName: 'fixture_await', input: {} }
    throw new Error('unreachable after rejected awaited tool')
  }
  if (name === 'recovered_accepted') {
    const failed = yield {
      toolName: 'run_terminal_command',
      input: { command: 'exit 7', process_type: 'SYNC' },
    }
    if (!JSON.stringify(failed.toolResult).includes('7'))
      throw new Error('Failure was not retained')
    const recovered = yield {
      toolName: 'run_terminal_command',
      input: {
        command: 'printf recovered > recovery.txt; cat recovery.txt',
        process_type: 'SYNC',
      },
    }
    if (!JSON.stringify(recovered.toolResult).includes('recovered'))
      throw new Error('Recovery oracle failed')
    state.output = { summary: 'verified recovered bytes' }
    state.taskAcceptance = {
      status: 'accepted',
      oracle: 'recovery-file-bytes',
      basis: 'actual terminal result and postimage',
    }
    return
  }
  state.output = { summary: 'fixture returned' }
  state.taskAcceptance =
    name === 'completed_rejected'
      ? {
          status: 'rejected',
          oracle: 'fixture-output',
          basis: 'expected result missing',
        }
      : {
          status: 'accepted',
          oracle: 'fixture-output',
          basis: 'expected result present',
        }
}

try {
  // Install configuration and the fetch barrier before loading SDK consumers.
  const [
    { createRunJournal },
    { runHeadlessCommand },
    { handleRunCompletion },
    { createBatchedMessageUpdater },
    { OpenbuffClient },
    { getCustomToolDefinition },
    { buildRuntimeAgentReceipt },
  ] = await Promise.all([
    import('../../../packages/agent-runtime/src/util/run-journal'),
    import('../../../cli/src/commands/run-command'),
    import('../../../cli/src/hooks/helpers/send-message'),
    import('../../../cli/src/utils/message-updater'),
    import('../../../sdk/src/client'),
    import('../../../sdk/src/custom-tool'),
    import('../../../packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils'),
  ])
  for (const name of [
    'happy_generator',
    'fatal_generator',
    'awaited_rejection',
    'pre_cancel',
    'mid_cancel',
    'zero_cost',
    'zero_steps',
    'recovered_accepted',
    'completed_rejected',
  ]) {
    const root = path.join(invocationDir, name)
    mkdirSync(root, { recursive: true })
    const controller = new AbortController()
    if (name === 'pre_cancel')
      controller.abort(new Error('fixture pre-cancellation'))
    let awaitedCalls = 0
    const custom = getCustomToolDefinition({
      toolName: 'fixture_await',
      description: 'controlled rejected await',
      inputSchema: z.object({}),
      execute: async () => {
        awaitedCalls++
        await Promise.resolve()
        if (name === 'mid_cancel')
          controller.abort(new Error('fixture mid-cancellation'))
        throw new Error('fixture awaited rejection')
      },
    })
    const agent: AgentDefinition = {
      id: 'body-runtime-fixture',
      displayName: 'Body runtime fixture',
      model: 'fixture-model',
      toolNames: ['fixture_await', 'run_terminal_command'],
      spawnableAgents: [],
      outputMode: 'structured_output',
      terminalPermissionProfile: 'workspace-write',
      handleSteps,
      ...(name === 'zero_cost' ? { maxCostCents: 0 } : {}),
    }
    const journalPath = path.join(root, `journal-${crypto.randomUUID()}.sqlite`)
    const journal = createRunJournal({
      path: journalPath,
      createDatabase: (file) => new Database(file),
    })
    let result: RunState | undefined
    const client = new OpenbuffClient({
      cwd: root,
      harnessStateDir: path.join(root, 'harness'),
      agentDefinitions: [agent],
      customToolDefinitions: [custom],
      maxAgentSteps: name === 'zero_steps' ? 0 : 10,
      env: {
        HOME: path.join(root, 'home'),
        PATH: '/usr/bin:/bin',
        OPENBUFF_PROVIDER_CONFIG: providerConfigPath,
      },
      inheritEnv: false,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    })
    // Retain the actual returned RunState while headless supplies its production
    // event and journal consumers. No runtime/backend result is mocked.
    const realRun = client.run.bind(client)
    client.run = async (input) => {
      result = await realRun({ ...input, params: { name } })
      return result
    }
    const stdout: string[] = []
    const stderr: string[] = []
    const startedAt = new Date().toISOString()
    const started = performance.now()
    const exitCode = await runHeadlessCommand(
      {
        prompt: 'fixed local body outcome control',
        agentId: agent.id,
        json: true,
      },
      {
        getClient: async () => client,
        projectRoot: root,
        signal: controller.signal,
        journalPath,
        openRunJournal: () => journal,
        writeStdout: (text) => {
          stdout.push(text)
        },
        writeStderr: (text) => {
          stderr.push(text)
        },
      },
    )
    assert.ok(result, 'headless must receive an actual SDK result')
    writeFileSync(
      path.join(root, 'result-before-oracle.json'),
      JSON.stringify(
        {
          output: result.output,
          runOutcome: result.runOutcome,
          taskAcceptance: result.taskAcceptance,
          actionOutcomes: result.actionOutcomes,
          agentId: result.sessionState?.mainAgentState.agentId,
          runId: result.sessionState?.mainAgentState.runId,
          awaitedCalls,
          aborted: controller.signal.aborted,
        },
        null,
        2,
      ) + '\n',
    )
    writeFileSync(path.join(root, 'stdout.ndjson'), stdout.join(''))
    writeFileSync(path.join(root, 'stderr.txt'), stderr.join('\n'))
    const expected =
      name === 'zero_cost'
        ? 'budget_exhausted'
        : name === 'zero_steps'
          ? 'step_exhausted'
          : name === 'pre_cancel' || name === 'mid_cancel'
            ? 'cancelled'
            : name === 'fatal_generator' || name === 'awaited_rejection'
              ? 'failed'
              : 'completed'
    assert.equal(result.runOutcome?.termination, expected, name)
    assert.equal(
      exitCode,
      ['happy_generator', 'recovered_accepted'].includes(name) ? 0 : 1,
      name,
    )
    const reopened = createRunJournal({
      path: journalPath,
      createDatabase: (file) => new Database(file),
    })
    const journalEvents = reopened.runIds().flatMap((id) => reopened.events(id))
    await reopened.close()
    const terminalEvents = journalEvents.filter(
      (event) => event.payload?.terminal === true,
    )
    assert.equal(terminalEvents.length, name === 'pre_cancel' ? 0 : 1, name)
    if (terminalEvents.length)
      assert.deepEqual(terminalEvents[0].payload.runOutcome, result.runOutcome)
    let messages: ChatMessage[] = [
      {
        id: 'ai',
        variant: 'ai',
        timestamp: 'fixture',
        content: '',
        blocks: [],
      },
    ]
    const updater = createBatchedMessageUpdater('ai', (update) => {
      messages = update(messages)
    })
    const timerOutcomes: string[] = []
    handleRunCompletion({
      runState: result,
      actualCredits: undefined,
      agentMode: 'DEFAULT',
      updater,
      aiMessageId: 'ai',
      wasAbortedByUser: controller.signal.aborted,
      timerController: {
        start: () => {},
        stop: (outcome) => {
          timerOutcomes.push(outcome)
          return { finishedAt: Date.now(), elapsedMs: 0 }
        },
        pause: () => {},
        resume: () => {},
        isActive: () => false,
      },
      setStreamStatus: () => {},
      setCanProcessQueue: () => {},
      updateChainInProgress: () => {},
      setHasReceivedPlanResponse: () => {},
    })
    updater.flush()
    updater.dispose()
    assert.deepEqual(messages[0].runOutcome, result.runOutcome)
    assert.deepEqual(messages[0].actionOutcomes, result.actionOutcomes)
    const receipt =
      result.sessionState &&
      buildRuntimeAgentReceipt({
        agentType: agent.id,
        agentId: result.sessionState.mainAgentState.agentId,
        output: result.output,
        agentState: result.sessionState.mainAgentState,
      })
    if (receipt) assert.deepEqual(receipt.runOutcome, result.runOutcome)
    if (name === 'recovered_accepted') {
      assert.equal(
        readFileSync(path.join(root, 'recovery.txt'), 'utf8'),
        'recovered',
      )
      assert.equal(result.actionOutcomes?.[0].outcome, 'failed')
      assert.equal(result.taskAcceptance?.status, 'accepted')
    }
    if (name === 'zero_cost' || name === 'zero_steps' || name === 'pre_cancel')
      assert.equal(awaitedCalls, 0)
    if (name === 'awaited_rejection' || name === 'mid_cancel')
      assert.equal(awaitedCalls, 1)
    const events = stdout
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    if (name === 'zero_cost' || name === 'zero_steps') {
      assert.equal(events.filter((event) => event.type === 'finish').length, 1)
      assert.equal(events.filter((event) => event.type === 'error').length, 1)
      assert.equal(result.actionOutcomes?.length ?? 0, 0)
    }
    writeFileSync(path.join(root, 'stdout.ndjson'), stdout.join(''))
    writeFileSync(path.join(root, 'stderr.txt'), stderr.join('\n'))
    observations.push({
      name,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: performance.now() - started,
      exitCode,
      awaitedCalls,
      runOutcome: result.runOutcome,
      taskAcceptance: result.taskAcceptance,
      actionOutcomes: result.actionOutcomes,
      output: result.output,
      receipt,
      cliMessage: messages[0],
      timerOutcomes,
      journalPath,
      terminalEvents,
      stdoutSha256: createHash('sha256').update(stdout.join('')).digest('hex'),
    })
  }
  assert.equal(providerCalls, 0)
  writeFileSync(
    path.join(evidenceDir, 'observations.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        bun: Bun.version,
        providerCalls,
        providerConfigSha256: createHash('sha256')
          .update(providerConfig)
          .digest('hex'),
        invocationDir,
        coverageTier:
          'actual serialized SDK generator → headless → persisted SQLite → CLI completion; local temp shell recovery; no model/provider',
        observations,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    JSON.stringify({ cases: observations.length, providerCalls, evidenceDir }),
  )
} finally {
  globalThis.fetch = previousFetch
  if (previousConfig === undefined) delete process.env.OPENBUFF_PROVIDER_CONFIG
  else process.env.OPENBUFF_PROVIDER_CONFIG = previousConfig
}
