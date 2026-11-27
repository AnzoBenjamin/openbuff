import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  computeValidationDependencyFingerprint,
  ValidationReceiptSchema,
  type MemoryPlaybook,
  type PlaybookGateOutcomeEvent,
  type ValidationEvidenceContext,
} from '@codebuff/common/types/memory-playbook'
import { ProjectIdSchema } from '@codebuff/common/types/memory-v2'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { jsonToolResult } from '@codebuff/common/util/messages'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { PlaybookApplicabilityContext } from '@codebuff/common/util/playbook-applicability'
import type { PlaybookUpsertInput } from '@codebuff/common/types/contracts/playbook-store'

import { compileActivePlaybooksContext } from '../../../../../packages/agent-runtime/src/memory/playbook-context'
import { createSessionEvidenceLog } from '../../../../../packages/agent-runtime/src/memory/session-evidence-log'
import { getFileProcessingValues } from '../../../../../packages/agent-runtime/src/tools/handlers/tool/write-file'
import {
  executeToolCall,
  recordToolEvidence,
} from '../../../../../packages/agent-runtime/src/tools/tool-executor'
import { buildPlaybookGateOutcomeReporter } from '../../../../../sdk/src/run'
import { MemoryV2OperatorService } from '../../../../../sdk/src/services/memory-v2/operator-service'
import {
  handleMemoryCommandBlocks,
  type MemoryCommandDeps,
} from '../../../commands/memory-command'
import { BunSQLiteMemoryRepository } from '../bun-sqlite-memory-repository'

const WORKSPACE = ProjectIdSchema.parse('project:b14-lifecycle')
const ROOT_RUN = 'b14-root'
const ROLE = 'git-committer'
const TS_PATH = 'src/change.ts'
const PY_PATH = 'src/change.py'
const scope = { repos: ['b14-repo'], agentTypes: [ROLE], glob: ['src/**/*.ts'] }
const focus: PlaybookApplicabilityContext = {
  repoIds: ['b14-repo'],
  actorAgentType: ROLE,
  affectedPaths: [TS_PATH],
}
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** Track the real store promises, not timers: the SDK reporter deliberately returns void. */
function trackedReporter(repository: BunSQLiteMemoryRepository) {
  const pending: Promise<void>[] = []
  const events: PlaybookGateOutcomeEvent[] = []
  const record = repository.recordPlaybookGateOutcome.bind(repository)
  const observedRepository = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === 'recordPlaybookGateOutcome') {
        return (...args: Parameters<typeof record>) => {
          const call = record(...args)
          pending.push(call)
          return call
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const report = buildPlaybookGateOutcomeReporter(observedRepository, logger)
  if (!report) throw new Error('Expected the SDK gate-outcome reporter')
  return {
    events,
    onOutcome(event: PlaybookGateOutcomeEvent) {
      events.push(event)
      report(event)
    },
    async drain() {
      // Join every underlying call, including rejections the advisory reporter swallows.
      while (pending.length) await Promise.all(pending.splice(0))
    },
  }
}

type State = ReturnType<typeof getInitialAgentState> & {
  sessionEvidenceLog: ReturnType<typeof createSessionEvidenceLog>
  playbookApplicability: PlaybookApplicabilityContext
}

class LifecycleFixture {
  readonly root = mkdtempSync(join(tmpdir(), 'openbuff-b14-lifecycle-'))
  readonly now = Date.now()
  readonly registry = new Map<string, ValidationEvidenceContext>()
  readonly repositories: BunSQLiteMemoryRepository[] = []
  repository!: BunSQLiteMemoryRepository
  reporter!: ReturnType<typeof trackedReporter>
  rule!: MemoryPlaybook
  retired!: MemoryPlaybook
  expired!: MemoryPlaybook
  shadow!: MemoryPlaybook

  async open() {
    const result = await BunSQLiteMemoryRepository.open({
      repositoryRoot: this.root,
    })
    if (result.status !== 'ok') throw new Error(result.error.message)
    this.repositories.push(result.repository)
    this.repository = result.repository
    this.reporter = trackedReporter(this.repository)
  }

  input(title: string, withinMs = 300_000): PlaybookUpsertInput {
    return {
      workspaceId: WORKSPACE,
      title,
      instruction:
        'Obtain an unchanged host validation receipt before staging TypeScript changes.',
      trigger: {
        tool: 'run_terminal_command',
        terminalAction: 'git-stage',
        requireEvidence: [
          {
            kind: 'validationSucceeded',
            validationKinds: ['package-checks'],
            withinMs,
          },
        ],
      },
      scope,
      status: 'active',
      enforcement: 'block',
      provenance: {
        origin: 'repository',
        recordedBy: 'b14-test',
        sourceEventIds: [],
        metadata: {},
      },
    }
  }

  state(playbooks: MemoryPlaybook[], applicability = focus): State {
    return {
      ...getInitialAgentState(),
      agentId: 'b14-actor',
      runId: 'b14-run',
      ancestorRunIds: [ROOT_RUN],
      playbookContext: playbooks,
      playbookApplicability: { ...applicability },
      sessionEvidenceLog: createSessionEvidenceLog(),
    }
  }

  validation(): ValidationEvidenceContext {
    const dependencyHashes = {
      [`source:${TS_PATH}`]: 'source-hash',
      'config:package.json': 'config-hash',
    }
    const receipt = ValidationReceiptSchema.parse({
      receiptId: 'b14-host-receipt',
      workspaceId: WORKSPACE,
      rootRunId: ROOT_RUN,
      checkKind: 'package-checks',
      command: 'bun run typecheck',
      cwd: this.root,
      exitCode: 0,
      completedAt: this.now - 1,
      producer: { runId: 'b14-validation-child', agentId: 'basher' },
      dependencyHashes,
      dependencyFingerprint:
        computeValidationDependencyFingerprint(dependencyHashes),
    })
    return {
      workspaceId: WORKSPACE,
      rootRunId: ROOT_RUN,
      receipts: [receipt],
      currentDependencyHashes: dependencyHashes,
    }
  }

  async dispatch(
    state: State,
    options: {
      mode?: 'block' | 'warn' | 'default'
      actor?: string
      path?: string
    } = {},
  ) {
    const chunks: Array<Record<string, unknown>> = []
    const toolResults: unknown[] = []
    const requests: Array<Record<string, unknown>> = []
    const command = `git add -- ${options.path ?? state.playbookApplicability.affectedPaths?.[0] ?? TS_PATH}`
    await executeToolCall({
      toolName: 'run_terminal_command',
      input: { command, cwd: this.root },
      runId: 'b14-run',
      ancestorRunIds: [ROOT_RUN],
      userInputId: 'b14-input',
      clientSessionId: 'b14-session',
      agentState: state,
      agentTemplate: {
        id: options.actor ?? ROLE,
        toolNames: ['run_terminal_command'],
        programmaticToolNames: ['run_terminal_command'],
        spawnableAgents: [],
      },
      logger,
      clock: { now: () => this.now },
      clientEnv:
        options.mode === 'default'
          ? {}
          : { OPENBUFF_PLAYBOOK_GATE: options.mode ?? 'block' },
      onPlaybookGateOutcome: this.reporter.onOutcome,
      getPlaybookValidationEvidence: async (actor: {
        runId: string
        rootRunId: string
        agentId: string
      }) => {
        expect(actor).toEqual({
          runId: 'b14-run',
          rootRunId: ROOT_RUN,
          agentId: state.agentId,
        })
        return this.registry.get(actor.rootRunId)
      },
      // Host action classification is injected; no shell parsing, git or process spawn runs here.
      classifyPlaybookTerminalActions: async () => ['git-stage'],
      fileContext: {
        projectRoot: this.root,
        fileTreeSource: 'virtual',
        tokenCallers: {},
      },
      fileProcessingState: getFileProcessingValues({}),
      previousToolCallFinished: Promise.resolve(),
      signal: new AbortController().signal,
      toolCalls: [],
      toolCallsToAddToMessageHistory: [],
      toolResults,
      toolResultsToAddToMessageHistory: [],
      onResponseChunk: (chunk: unknown) =>
        chunks.push(chunk as Record<string, unknown>),
      requestToolCall: async (request: Record<string, unknown>) => {
        requests.push(request)
        // This is a synthetic tool output, NOT measured validation; only the host registry can attest that.
        return {
          output: jsonToolResult({
            command,
            stdout: 'harmless fixture dispatch',
            exitCode: 0,
          }),
        }
      },
      onCostCalculated: async () => undefined,
    } as any)
    await this.reporter.drain()
    return { chunks, toolResults, requests }
  }

  async prepareVerified() {
    await this.open()
    this.rule = await this.repository.upsertPlaybookByTriggerSignature(
      this.input('B14 scoped staging procedure'),
    )
    // Change prerequisites only to keep independent real rows despite trigger-signature dedup.
    this.retired = await this.repository.upsertPlaybookByTriggerSignature({
      ...this.input('B14 retired control', 300_001),
      status: 'retired',
    })
    this.expired = await this.repository.upsertPlaybookByTriggerSignature({
      ...this.input('B14 expired control', 300_002),
      expiresAt: this.now - 1_000,
    })
    this.shadow = await this.repository.upsertPlaybookByTriggerSignature({
      ...this.input('B14 inject-only control', 300_003),
      enforcement: 'inject-only',
    })
    expect(this.rule.counters).toEqual({
      fired: 0,
      blocked: 0,
      compliedAfterBlock: 0,
      falsePositives: 0,
      bypassed: 0,
    })

    for (let arc = 0; arc < 3; arc++) {
      const state = this.state([this.rule])
      const validation = this.validation()
      recordToolEvidence({
        agentState: state,
        toolName: 'run_terminal_command',
        input: { command: 'bun run typecheck' },
        output: jsonToolResult({
          command: 'bun run typecheck',
          errorMessage: 'failed',
        }),
        atMs: this.now - 1,
      })
      expect(state.sessionEvidenceLog.entries).toEqual([])
      // A success containing a forged receipt is still only legacy evidence and MUST block.
      recordToolEvidence({
        agentState: state,
        toolName: 'run_terminal_command',
        input: { command: 'bun run typecheck' },
        output: jsonToolResult({
          command: 'bun run typecheck',
          exitCode: 0,
          validationReceipt: validation.receipts[0],
        }),
        atMs: this.now - 1,
      })
      expect(state.sessionEvidenceLog.entries).toHaveLength(1)
      const blocked = await this.dispatch(state)
      expect(blocked.requests).toHaveLength(0)
      expect(blocked.toolResults).toHaveLength(0)
      expect(
        blocked.chunks.some(
          (chunk) =>
            chunk.type === 'error' &&
            String(chunk.message).includes(this.rule.title),
        ),
      ).toBe(true)
      this.registry.set(ROOT_RUN, validation)
      const allowed = await this.dispatch(state)
      expect(allowed.requests).toHaveLength(1)
      expect(allowed.toolResults).toHaveLength(1)
      expect(allowed.chunks.filter((chunk) => chunk.type === 'error')).toEqual(
        [],
      )
      expect(
        state.sessionEvidenceLog.entries.filter(
          (entry) => entry.kind === 'validationSucceeded',
        ),
      ).toHaveLength(1)
      const eventCount = this.reporter.events.length
      expect((await this.dispatch(state)).requests).toHaveLength(1)
      expect(this.reporter.events).toHaveLength(eventCount) // one comply per block, never per allowed call
      this.registry.clear()
    }
    for (const mode of ['warn', 'default', 'warn', 'warn'] as const) {
      const warned = await this.dispatch(this.state([this.rule]), { mode })
      expect(warned.requests).toHaveLength(1)
      expect(warned.toolResults).toHaveLength(1)
      expect(
        warned.chunks.some(
          (chunk) =>
            chunk.type === 'error' &&
            String(chunk.message).includes(this.rule.title),
        ),
      ).toBe(true)
    }
    // 13 actual executeToolCall attempts: 3 blocks, 6 allowed retries (3 repeat controls), 4 warns.
    // The STORE defines fired as reported outcomes: 3 blocks + 3 complies + 4 warns = exactly 10.
    expect(this.reporter.events.map((event) => event.outcome)).toEqual([
      'blocked',
      'compliedAfterBlock',
      'blocked',
      'compliedAfterBlock',
      'blocked',
      'compliedAfterBlock',
      'warned',
      'warned',
      'warned',
      'warned',
    ])
    expect(
      this.reporter.events.every(
        (event) =>
          event.playbookId === this.rule.playbookId &&
          event.triggerSignature === this.rule.triggerSignature,
      ),
    ).toBe(true)
    const measured = (await this.repository.listAllPlaybooks(WORKSPACE)).find(
      (row) => row.playbookId === this.rule.playbookId,
    )!
    expect(measured.counters).toMatchObject({
      fired: 10,
      blocked: 3,
      compliedAfterBlock: 3,
      falsePositives: 0,
      bypassed: 0,
      lastFiredAt: expect.any(Number),
    })

    const unused = async (): Promise<never> => {
      throw new Error('Unexpected legacy memory operation')
    }
    const deps: MemoryCommandDeps = {
      getRootDir: () => this.root,
      loadPersistedTaskMemory: unused,
      reconcileTaskMemoryEvidence: unused,
      pruneStaleTaskMemoryEvidence: unused,
      auditTaskMemoryV1Migration: unused,
      getWorkspaceMoves: unused,
      getMemoryV2: async () => ({
        status: 'available',
        requestedAuthority: 'sqlite-v2-opt-in',
        effectiveAuthority: 'sqlite-v2-opt-in',
        projectId: WORKSPACE,
        repository: this.repository,
        operator: new MemoryV2OperatorService(this.repository),
        release: async () => undefined,
      }),
    }
    const beforePreview = await this.repository.listAllPlaybooks(WORKSPACE)
    const preview = await handleMemoryCommandBlocks('playbooks', deps)
    if (preview.state !== 'report')
      throw new Error('Expected lifecycle preview report')
    expect(preview.tone).toBe('secondary')
    expect(preview.lines.join('\n')).toContain(
      `Verify ${this.rule.title} → verified`,
    )
    expect(await this.repository.listAllPlaybooks(WORKSPACE)).toEqual(
      beforePreview,
    )
    const applied = await handleMemoryCommandBlocks('playbooks --apply', deps)
    if (applied.state !== 'report')
      throw new Error('Expected lifecycle apply report')
    expect(applied.tone).toBe('success')
    expect(applied.lines.join('\n')).toContain(
      `Applied: Verify ${this.rule.title} → verified`,
    )
    expect(applied.lines.join('\n')).toContain('Outcome: applied.')
    const verified = (await this.repository.listAllPlaybooks(WORKSPACE)).find(
      (row) => row.playbookId === this.rule.playbookId,
    )!
    expect(verified).toMatchObject({
      ...measured,
      status: 'verified',
      updatedAt: expect.any(Number),
    })
    await this.reporter.drain()
    const databasePath = this.repository.databasePath
    await this.repository.close()
    await this.open()
    expect(this.repository.databasePath).toBe(databasePath)
    const loaded = await this.repository.listPlaybooks(WORKSPACE)
    this.rule = loaded.find((row) => row.playbookId === this.rule.playbookId)!
    expect(this.rule).toEqual(verified)
    expect(loaded.map((row) => row.playbookId).sort()).toEqual(
      [this.rule.playbookId, this.shadow.playbookId].sort(),
    )
  }

  async close() {
    try {
      await this.reporter?.drain()
    } finally {
      await Promise.all(
        this.repositories.map((repository) => repository.close()),
      )
      rmSync(this.root, { recursive: true, force: true })
    }
  }
}

const render = (rules: MemoryPlaybook[], applicability = focus) =>
  compileActivePlaybooksContext(rules, {
    maxChars: 8_000,
    applicability: { nowMs: Date.now(), ...applicability },
  })

let fixture: LifecycleFixture
beforeEach(async () => {
  fixture = new LifecycleFixture()
  await fixture.prepareVerified()
})
afterEach(async () => {
  await fixture?.close()
})

describe('B14 actual operator lifecycle → SQLite reopen → runtime consumers', () => {
  test('keeps the verified scoped procedure rendered and blocking after reopen', async () => {
    const loaded = await fixture.repository.listPlaybooks(WORKSPACE)
    const prompt = render(loaded)
    expect(prompt).toContain(fixture.rule.title)
    expect(prompt).toContain(fixture.rule.instruction)
    expect(prompt).toContain('quality=verified')
    expect(prompt).toContain('Enforcement: block')
    expect(prompt).toContain('package-checks')
    expect(prompt).toContain(
      'repos=["b14-repo"]; actor=["git-committer"]; paths=["src/**/*.ts"]',
    )
    expect(prompt).not.toContain(fixture.retired.title)
    expect(prompt).not.toContain(fixture.expired.title)
    const blocked = await fixture.dispatch(fixture.state(loaded))
    expect(blocked.requests).toHaveLength(0)
    expect(blocked.toolResults).toHaveLength(0)
    expect(
      fixture.reporter.events.map((event) => [event.playbookId, event.outcome]),
    ).toEqual([[fixture.rule.playbookId, 'blocked']])
    expect(
      (await fixture.repository.listPlaybooks(WORKSPACE)).find(
        (row) => row.playbookId === fixture.rule.playbookId,
      )?.counters,
    ).toMatchObject({ fired: 11, blocked: 4, compliedAfterBlock: 3 })
  })

  for (const [label, applicability, actor] of [
    ['other repository', { ...focus, repoIds: ['other-repo'] }, ROLE],
    // Keep the stale captured role matching: the actual template identity must win at the seam.
    ['other actor', { ...focus, actorAgentType: 'editor' }, 'editor'],
    ['Python path', { ...focus, affectedPaths: [PY_PATH] }, ROLE],
  ] as const) {
    test(`does not render or gate for ${label} independently`, async () => {
      const loaded = await fixture.repository.listPlaybooks(WORKSPACE)
      const before = await fixture.repository.listAllPlaybooks(WORKSPACE)
      expect(render(loaded, applicability)).toBe('')
      const state = fixture.state(loaded, {
        ...applicability,
        actorAgentType: ROLE,
      })
      const allowed = await fixture.dispatch(state, { actor })
      expect(allowed.requests).toHaveLength(1)
      expect(allowed.toolResults).toHaveLength(1)
      expect(allowed.chunks.filter((chunk) => chunk.type === 'error')).toEqual(
        [],
      )
      expect(fixture.reporter.events).toEqual([])
      expect(await fixture.repository.listAllPlaybooks(WORKSPACE)).toEqual(
        before,
      )
    })
  }

  test('retired and expired controls cannot render or report even if installed directly', async () => {
    const rows = await fixture.repository.listAllPlaybooks(WORKSPACE)
    const controls = rows.filter((row) =>
      [fixture.retired.playbookId, fixture.expired.playbookId].includes(
        row.playbookId,
      ),
    )
    expect(controls).toHaveLength(2)
    expect(render(controls)).toBe('')
    const allowed = await fixture.dispatch(fixture.state(controls))
    expect(allowed.requests).toHaveLength(1)
    expect(allowed.chunks.filter((chunk) => chunk.type === 'error')).toEqual([])
    expect(fixture.reporter.events).toEqual([])
    expect(await fixture.repository.listAllPlaybooks(WORKSPACE)).toEqual(rows)
  })

  test('inject-only renders but actual dispatch never increments its persisted counters', async () => {
    const shadow = (await fixture.repository.listPlaybooks(WORKSPACE)).find(
      (row) => row.playbookId === fixture.shadow.playbookId,
    )!
    expect(render([shadow])).toContain(shadow.title)
    expect(render([shadow])).toContain('Enforcement: inject-only')
    const state = fixture.state([shadow])
    for (let attempt = 0; attempt < 3; attempt++) {
      const allowed = await fixture.dispatch(state)
      expect(allowed.requests).toHaveLength(1)
      expect(allowed.toolResults).toHaveLength(1)
      expect(allowed.chunks.filter((chunk) => chunk.type === 'error')).toEqual(
        [],
      )
    }
    expect(fixture.reporter.events).toEqual([])
    expect(
      (await fixture.repository.listAllPlaybooks(WORKSPACE)).find(
        (row) => row.playbookId === shadow.playbookId,
      ),
    ).toEqual(shadow)
    expect(shadow.counters).toEqual({
      fired: 0,
      blocked: 0,
      compliedAfterBlock: 0,
      falsePositives: 0,
      bypassed: 0,
    })
  })

  test('warn enforcement downgrades block mode without disabling the verified procedure', async () => {
    const warnedRule =
      await fixture.repository.upsertPlaybookByTriggerSignature({
        ...fixture.input(fixture.rule.title),
        status: 'verified',
        enforcement: 'warn',
      })
    expect(warnedRule.playbookId).toBe(fixture.rule.playbookId)
    expect(warnedRule.counters).toEqual(fixture.rule.counters)
    expect(render([warnedRule])).toContain(
      'Enforcement: warn; quality=verified',
    )
    const warned = await fixture.dispatch(fixture.state([warnedRule]))
    expect(warned.requests).toHaveLength(1)
    expect(warned.toolResults).toHaveLength(1)
    expect(
      warned.chunks.some(
        (chunk) =>
          chunk.type === 'error' &&
          String(chunk.message).includes(warnedRule.title),
      ),
    ).toBe(true)
    expect(fixture.reporter.events.map((event) => event.outcome)).toEqual([
      'warned',
    ])
    expect(
      (await fixture.repository.listPlaybooks(WORKSPACE)).find(
        (row) => row.playbookId === warnedRule.playbookId,
      )?.counters,
    ).toMatchObject({ fired: 11, blocked: 3, compliedAfterBlock: 3 })
  })
})
