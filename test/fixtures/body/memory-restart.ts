import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import z from 'zod/v4'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { RunState } from '../../../sdk/src/run-state'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import { OpenbuffClient } from '../../../sdk/src/client'
import { getCustomToolDefinition } from '../../../sdk/src/custom-tool'
import { BunSQLiteMemoryRepository } from '../../../cli/src/services/memory-v2/bun-sqlite-memory-repository'
import { ProjectIdSchema } from '@codebuff/common/types/memory-v2'
import {
  archivePreCompaction,
  archiveEvictedToolResults,
} from '../../../packages/agent-runtime/src/util/context-archive'
import { evictStaleToolResults } from '../../../packages/agent-runtime/src/util/tool-result-eviction'
import { handleSetMessages } from '../../../packages/agent-runtime/src/tools/handlers/tool/set-messages'
import {
  normalizePersistedArchive,
  projectCommittedArchive,
} from '../../../cli/src/utils/persisted-context-archive'
import contextPruner from '../../../agents/context-pruner'
import {
  MEMORY_FIXTURE_FACTS,
  renderFixtureFact,
  collectFactualEvidence,
  evaluateFactualCoverage,
} from '../../../evals/compaction-fidelity/factual-oracle'

const projectId = ProjectIdSchema.parse('project:b13-restart')
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const sha = (text: string | Buffer) =>
  createHash('sha256').update(text).digest('hex')
const originalText = (index: number) =>
  `RESULT-${String(index).padStart(3, '0')}\n${'x'.repeat(32748)}\nTAIL-${String(index).padStart(3, '0')}`
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

// Constants are inside the generator because the production loader serializes it.
const recorder = {
  id: 'b13-recorder',
  displayName: 'B13 recorder',
  toolNames: ['read_files', 'record_decision', 'b13_result'],
  handleSteps: function* () {
    yield { toolName: 'read_files', input: { paths: ['src/order.ts'] } }
    const values = [
      { id: 'timeout', value: { timeoutMs: 1500 } },
      {
        id: 'force-push',
        value: {
          forcePushMainRequiresExplicitRequest: true,
          instruction: 'do not force-push main without an explicit request',
        },
      },
      {
        id: 'blocker',
        value: { blockerId: 'contract-consumer-v2', status: 'open' },
      },
      { id: 'source-revision', value: { sourceRevision: 'order-schema@2' } },
      {
        id: 'next-action',
        value: { nextAction: 'verify-order-contract-before-task-acceptance' },
      },
      {
        id: 'amounts-decision',
        value: {
          decision: 'represent amounts in integer minor units',
          rationale: 'avoid binary floating-point drift at the shared contract',
        },
      },
    ]
    const paths = [
      'src/services/keystone-config.ts',
      'src/services/session-store.ts',
      'src/services/token-refresh.ts',
      'src/services/retry-policy.ts',
      'src/services/retry-policy.ts',
      'src/services/keystone-config.ts',
    ]
    for (let i = 0; i < values.length; i++) {
      yield {
        toolName: 'record_decision',
        input: {
          kind: i === 5 ? 'decision' : 'fact',
          text:
            `FACT[${values[i].id}][${paths[i]}]=${JSON.stringify(values[i].value)}` +
            (i === 5 ? ' because shared amounts must stay exact.' : ''),
          evidenceSelectors: ['src/order.ts'],
          excerpt: 'Order contract recovery evidence.',
        },
      }
    }
    yield { toolName: 'read_files', input: { paths: ['src/unrelated.css'] } }
    yield {
      toolName: 'record_decision',
      input: {
        kind: 'fact',
        text: 'B13_UNRELATED_STYLE purple typography only.',
        evidenceSelectors: ['src/unrelated.css'],
      },
    }
    yield { toolName: 'read_files', input: { paths: ['src/order.ts'] } }
    for (let index = 0; index < 30; index++)
      yield { toolName: 'b13_result', includeToolCall: true, input: { index } }
    yield { type: 'STEP_TEXT', text: 'Order contract capture finished.' }
  },
} as unknown as AgentDefinition

const consumer = {
  id: 'b13-consumer',
  displayName: 'B13 consumer',
  toolNames: ['recall_context', 'set_output'],
  outputMode: 'structured_output',
  handleSteps: function* ({ params }: { params?: Record<string, unknown> }) {
    // The first request is a real inference request; later metadata recall does not rerun producer effects.
    yield 'STEP'
    const calls = params?.calls as
      | Array<{
          toolCallId: string
          sourceRunId: string
          expectedSha256: string
        }>
      | undefined
    for (const call of calls ?? []) {
      let offsetBytes = 0
      for (let page = 0; page < 10; page++) {
        const result: unknown = yield {
          toolName: 'recall_context',
          includeToolCall: true,
          input: { ...call, offsetBytes, maxBytes: 4096 },
        }
        const raw = (
          result as {
            toolResult?: Array<{
              value?: {
                matches?: Array<{ page?: { nextOffset: number | null } }>
              }
            }>
          }
        )?.toolResult
        const next = raw?.[0]?.value?.matches?.[0]?.page?.nextOffset
        if (next === null) break
        if (typeof next !== 'number' || next <= offsetBytes)
          throw new Error('B13 recall failed to advance its actual byte cursor')
        offsetBytes = next
      }
    }
    yield { toolName: 'set_output', input: { completed: true } }
  },
} as unknown as AgentDefinition

function clientOptions(
  root: string,
  config: string,
  repository: BunSQLiteMemoryRepository,
) {
  return {
    cwd: root,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false as const,
    agentDefinitions: [recorder, consumer],
    logger,
    handleEvent() {},
    harnessStateDir: path.join(root, 'harness'),
    memoryV2: {
      repository,
      projectId,
      authority: 'sqlite-v2-opt-in' as const,
      capture: 'safe' as const,
    },
    hostConfiguration: {
      environment: {
        PATH: process.env.PATH,
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
      },
      platform: process.platform,
      invocationCwd: root,
      projectRoot: root,
      home: { kind: 'none' as const },
      globals: { kind: 'disabled' as const },
      selection: {
        kind: 'explicit' as const,
        path: config,
        required: true as const,
      },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  }
}

async function childRun(manifestPath: string) {
  const input = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    root: string
    config: string
    stateFile: string
    calls: Array<{
      toolCallId: string
      sourceRunId: string
      expectedSha256: string
    }>
  }
  const opened = await BunSQLiteMemoryRepository.open({
    repositoryRoot: input.root,
    contextArchiveRetention: { mode: 'rolling', maxBytes: 4 * 1024 * 1024 },
  })
  ensure(opened.status === 'ok', 'Fresh SQLite open failed')
  const repository = opened.repository
  try {
    const previousRun = JSON.parse(
      fs.readFileSync(input.stateFile, 'utf8'),
    ) as RunState
    const main = previousRun.sessionState!.mainAgentState
    // No restored transcript or V1/compiler band can counterfeit canonical next-task delivery.
    main.messageHistory = []
    main.taskMemory = undefined
    main.memoryV2Context = undefined
    main.playbookContext = []
    const queries: unknown[] = [],
      pages: unknown[] = [],
      events: unknown[] = []
    const query = repository.query.bind(repository),
      read = repository.readContextArchiveBodyPage.bind(repository)
    repository.query = async (request) => {
      queries.push(structuredClone(request))
      return query(request)
    }
    repository.readContextArchiveBodyPage = async (request) => {
      const value = await read(request)
      pages.push({ request, value })
      return value
    }
    const client = new OpenbuffClient({
      ...clientOptions(input.root, input.config, repository),
      handleEvent: (event) => {
        if (event.type === 'tool_result' && event.toolName === 'recall_context')
          events.push(event)
      },
    })
    const result = await client.run({
      agent: consumer.id,
      prompt:
        'Order contract recovery: timeout, force push, blocker, source revision, next action, integer amounts rationale.',
      params: { calls: input.calls },
      previousRun,
    })
    if (result.runOutcome?.termination !== 'completed')
      process.stderr.write(
        JSON.stringify({
          outcome: result.runOutcome,
          output: result.output,
          pages: pages.length,
          queries: queries.length,
          events: events.length,
          steps: result.sessionState?.mainAgentState.stepsRemaining,
          lastMessages:
            result.sessionState?.mainAgentState.messageHistory.slice(-2),
        }) + '\n',
      )
    ensure(
      result.runOutcome?.termination === 'completed',
      `Fresh consumer failed: ${JSON.stringify(result.output)}`,
    )
    process.stdout.write(
      'B13_RESULT:' +
        JSON.stringify({
          pid: process.pid,
          home: process.env.HOME,
          authority: result.sessionState?.mainAgentState.memoryAuthority,
          memory: result.sessionState?.mainAgentState.memoryV2,
          queries,
          pages,
          events,
          outcome: result.runOutcome,
        }) +
        '\n',
    )
  } finally {
    await repository.close()
  }
}

export async function runMemoryRestartFixture(options: {
  root: string
  evidenceDir?: string
  manifest?: string
}) {
  const root = fs.realpathSync(options.root),
    config = path.join(root, 'provider.json')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'src/order.ts'),
    'export const timeoutMs = 1500\nexport const revision = "order-schema@2"\n',
  )
  fs.writeFileSync(
    path.join(root, 'src/unrelated.css'),
    '.example { color: purple }\n',
  )
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      const chunk = (delta: unknown, reason: string | null) =>
        `data: ${JSON.stringify({
          id: 'b13-wire',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fixture',
          choices: [{ index: 0, delta, finish_reason: reason }],
        })}\n\n`
      return new Response(
        chunk(
          {
            role: 'assistant',
            content: 'Canonical recovery request observed.',
          },
          null,
        ) +
          chunk({}, 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  fs.writeFileSync(
    config,
    JSON.stringify({
      defaultModel: 'fixture/model',
      indexing: { enabled: false },
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          models: ['model'],
        },
      },
    }),
  )
  const opened = await BunSQLiteMemoryRepository.open({
    repositoryRoot: root,
    contextArchiveRetention: { mode: 'rolling', maxBytes: 4 * 1024 * 1024 },
  })
  ensure(opened.status === 'ok', 'Initial SQLite open failed')
  const repository = opened.repository,
    home = process.env.HOME
  let customCalls = 0
  try {
    const tool = getCustomToolDefinition({
      toolName: 'b13_result',
      description: 'Owned immutable result fixture',
      inputSchema: z.object({ index: z.number().int().min(0).max(29) }),
      execute: ({ index }) => {
        customCalls++
        return [{ type: 'json', value: originalText(index) }]
      },
    })
    const client = new OpenbuffClient({
      ...clientOptions(root, config, repository),
      customToolDefinitions: [tool],
    })
    const result = await client.run({
      agent: recorder.id,
      prompt:
        'Record order contract evidence and immutable original tool results.',
    })
    ensure(
      result.runOutcome?.termination === 'completed',
      `Producer failed: ${JSON.stringify(result.output)}`,
    )
    ensure(
      customCalls === 30,
      `Expected30 actual tool calls; got ${customCalls}`,
    )
    ensure(
      requests.length === 0,
      'Programmatic producer unexpectedly called a model',
    )
    const state = result.sessionState!.mainAgentState,
      sourceRunId = state.runId!
    const calls = state.messageHistory
      .filter(
        (message) =>
          message.role === 'tool' && message.toolName === 'b13_result',
      )
      .map((message) => {
        ensure(message.role === 'tool', 'Invalid result role')
        const part = message.content[0]
        ensure(
          part.type === 'json' && typeof part.value === 'string',
          'Custom result was not exact scalar text',
        )
        ensure(
          Buffer.byteLength(part.value) === 32768,
          'Custom result UTF8 length changed',
        )
        return {
          toolCallId: message.toolCallId,
          sourceRunId,
          expectedSha256: sha(part.value),
        }
      })
    ensure(
      calls.length === 30,
      `Production history lost an original custom result: calls=${calls.length} tools=${JSON.stringify(state.messageHistory.filter((message) => message.role === 'tool').map((message) => ({ name: message.toolName, id: message.toolCallId })))}`,
    )
    const chronological: Message[] = Array.from(
      { length: 200 },
      (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: [
          {
            type: 'text',
            text: `DIALOGUE-${index}: ${index < MEMORY_FIXTURE_FACTS.length ? 'Decision: ' + renderFixtureFact(MEMORY_FIXTURE_FACTS[index]) : 'Owned chronological order evidence.'}`,
          },
        ],
      }),
    )
    const originalHistory = state.messageHistory
    const evicted = evictStaleToolResults(originalHistory, {
      keepRecentSteps: 0,
      minSavingsTokens: 1,
    })
    ensure(
      evicted.evictedCount >= 30,
      'Actual production evictor did not evict the thirty fixture results',
    )
    archiveEvictedToolResults(state, evicted.evicted!, Date.now())
    state.messageHistory = [...chronological, ...evicted.messages]
    const passRecords: unknown[] = []
    for (let pass = 0; pass < 3; pass++) {
      const before = state.messageHistory
      archivePreCompaction(state, before, 'semantic_compaction', 0, Date.now())
      state.contextTokenCount = 20000
      const generator = contextPruner.handleSteps!({
        agentState: state as never,
        logger,
        params: {
          semanticBudget: {
            triggerBudgetTokens: 2800,
            targetBudgetTokens: 2500,
          },
          taskMemory: state.taskMemory,
          archivePointers: state.compactionArchive!.map(
            (snapshot) => `Original archive ${snapshot.archivedAt}`,
          ),
        },
      } as never)
      let next = generator.next(),
        writes = 0
      while (!next.done) {
        const call = next.value as { toolName?: string; input?: unknown }
        ensure(
          call.toolName === 'set_messages',
          'The real pruner yielded an unexpected action',
        )
        await handleSetMessages({
          previousToolCallFinished: Promise.resolve(),
          agentState: state,
          toolCall: {
            toolName: 'set_messages',
            toolCallId: `prune-${pass}`,
            input: call.input as never,
          },
        })
        writes++
        next = generator.next()
      }
      ensure(
        writes === 1,
        'A compaction pass did not execute its real set_messages transaction',
      )
      passRecords.push({
        pass,
        beforeMessages: before.length,
        afterMessages: state.messageHistory.length,
        output: state.messageHistory,
        archiveSnapshots: state.compactionArchive!.length,
      })
    }
    normalizePersistedArchive(result)
    const persisted = await repository.persistContextArchiveSnapshots({
      runId: sourceRunId,
      snapshots: state.compactionArchive!,
      bodies: state.contextArchiveBodies,
    })
    ensure(
      persisted.status === 'ok' && persisted.skipped === 0,
      `Original archive persistence failed: ${JSON.stringify(persisted)}`,
    )
    projectCommittedArchive(result, persisted)
    ensure(
      state.contextArchiveBodies === undefined &&
        state.contextArchiveStorage === 'references',
      'Reference-only state was not confirmed',
    )
    const stateFile = path.join(root, 'saved-run.json'),
      manifestPath = path.join(root, 'restart-input.json')
    fs.writeFileSync(stateFile, JSON.stringify(result), { mode: 0o600 })
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ root, config, stateFile, calls }),
      { mode: 0o600 },
    )
    const canonicalEvents = await repository.listEvents({ limit: 1000 })
    await repository.close()
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '--no-install',
        import.meta.path,
        '--child',
        manifestPath,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          OPENBUFF_PROCESS_SUPERVISION: '0',
          OPENBUFF_TELEMETRY: '0',
          DO_NOT_TRACK: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => child.kill('SIGKILL'),
      60000,
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(timer)
    timer = undefined
    ensure(code === 0, `Fresh process failed (${code}): ${stderr}\n${stdout}`)
    const line = stdout
      .split('\n')
      .find((line) => line.startsWith('B13_RESULT:'))
    ensure(line, 'Fresh process returned no structured fixture report')
    const fresh = JSON.parse(line.slice('B13_RESULT:'.length)) as {
      pid: number
      home?: string
      authority: { active: string }
      queries: Array<Record<string, unknown>>
      pages: Array<{
        request: { toolCallId: string; offsetBytes?: number; maxBytes?: number }
        value: {
          status: string
          text?: string
          sha256?: string
          utf8Bytes?: number
        }
      }>
      events: Array<{
        output: Array<{
          type: string
          value: {
            matches?: Array<{
              snippet: string
              toolCallId: string
              page?: { startByte: number; nextOffset: number | null }
            }>
          }
        }>
      }>
    }
    ensure(
      fresh.pid !== process.pid &&
        fresh.home === home &&
        process.env.HOME === home,
      'Fresh process or inherited HOME invariant failed',
    )
    ensure(
      Number(requests.length) === 1,
      `Expected one actual consumer request; got ${requests.length}`,
    )
    const firstRequest = requests[0] as { messages: unknown[] }
    const memory = collectFactualEvidence(firstRequest.messages).filter(
      (text) => text.includes('Memory V2 retrieval context'),
    )
    // record_decision adds rationale prose outside the structured factual record; the retained record itself stays exact.
    const cleaned = memory.map((text) =>
      text.replace(
        /(FACT\[amounts-decision\][^\n]*?\}) because shared amounts must stay exact\./g,
        '$1',
      ),
    )
    const score = evaluateFactualCoverage(cleaned)
    ensure(
      score.factualScore === 1,
      `First canonical prompt lost factual values: ${JSON.stringify(score)}`,
    )
    ensure(
      !JSON.stringify(firstRequest).includes('B13_UNRELATED_STYLE'),
      'Unrelated memory leaked into the next task',
    )
    ensure(
      !JSON.stringify(firstRequest).includes('TASK_MEMORY_CONTEXT'),
      'V1 substituted for canonical memory',
    )
    ensure(
      JSON.stringify(firstRequest).includes('ARCHIVE_BODY'),
      'Next actual model request received no available original reference/hash',
    )
    ensure(
      fresh.authority.active === 'sqlite-v2-opt-in' &&
        fresh.queries.every((query) => !Object.hasOwn(query, 'taskId')),
      'New task filtering/authority changed',
    )
    for (const call of calls) {
      const hits = fresh.events
        .flatMap((event) =>
          event.output.flatMap((part) => part.value?.matches ?? []),
        )
        .filter((match) => match.toolCallId === call.toolCallId)
      const body = hits
        .sort((a, b) => (a.page?.startByte ?? 0) - (b.page?.startByte ?? 0))
        .map((hit) => hit.snippet)
        .join('')
      ensure(
        Buffer.byteLength(body) === 32768 &&
          sha(body) === call.expectedSha256 &&
          /TAIL-\d{3}$/.test(body),
        'Actual recall_context pages lost original hash/tail',
      )
    }
    ensure(customCalls === 30, 'Recall reran the original effects')
    const report = {
      schemaVersion: 1,
      status: 'local-verified',
      sourcePid: process.pid,
      freshPid: fresh.pid,
      customCalls,
      chronologicalMessages: 200,
      originalResults: 30,
      originalBytes: 32768,
      compactions: 3,
      factualScore: score.factualScore,
      identifierScore: score.identifierScore,
      providerRequests: requests.length,
      externalProviderRequests: 0,
      homeUnchanged: process.env.HOME === home,
      retention: persisted.retention,
      calls,
      passes: passRecords,
      firstRequest,
      fresh,
      canonicalEvents,
      toolchain: {
        bun: Bun.version,
        executable: process.execPath,
        sha256: sha(fs.readFileSync(process.execPath)),
      },
      manifest: options.manifest
        ? {
            path: options.manifest,
            sha256: sha(fs.readFileSync(options.manifest)),
          }
        : undefined,
      limits: [
        'Owned loopback provider, not live model quality.',
        'Source SDK/SQLite, not full installed/cross-platform roadmap acceptance.',
      ],
    }
    if (options.evidenceDir) {
      fs.mkdirSync(options.evidenceDir, { recursive: true })
      fs.writeFileSync(
        path.join(options.evidenceDir, 'receipt.json'),
        JSON.stringify(report, null, 2),
      )
    }
    return report
  } finally {
    await repository.close()
    server.stop(true)
  }
}

if (import.meta.main) {
  const child = process.argv.indexOf('--child')
  if (child >= 0) await childRun(process.argv[child + 1]!)
  else {
    const option = (name: string) => {
      const index = process.argv.indexOf(name)
      return index < 0 ? undefined : process.argv[index + 1]
    }
    const evidenceDir = option('--evidence-dir'),
      manifest = option('--manifest')
    ensure(
      evidenceDir && manifest,
      'Usage: memory-restart.ts --manifest <file> --evidence-dir <owned-directory>',
    )
    const root = fs.mkdtempSync(
      path.join((await import('node:os')).tmpdir(), 'openbuff-b13-restart-'),
    )
    try {
      const report = await runMemoryRestartFixture({
        root,
        evidenceDir,
        manifest,
      })
      console.log(JSON.stringify({ status: report.status, evidenceDir }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}
