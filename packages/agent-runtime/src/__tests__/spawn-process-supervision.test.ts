/**
 * P2-T8 adoption slice: flag-gated process-supervisor routing tests.
 *
 *  - Flag OFF (unset dep): executeSubagent calls loopAgentSteps in-process
 *    and returns NO supervisedReceipt — the byte-identical default path.
 *  - Flag ON with an INJECTED spawnSupervised seam: the seam is called with
 *    a serialized-shape request, loopAgentSteps is never touched, ok receipts
 *    ride `supervisedReceipt` into the settle chain verbatim, and crashed /
 *    missing_output / schema_invalid / child-declared-failure settle into the
 *    same structured crash-envelope output the in-process path produces (the
 *    settle chain folds them into failed receipts; no dangling spawns or
 *    leases — asserted on the inline handler settle chain).
 *
 * Pattern follows spawn-settle-fault-injection.test.ts: spyOn(loopAgentSteps)
 * for the flag-off parity probe; the seam is injected directly through the
 * context params (no module mock needed — extractSubagentContextParams
 * forwards it).
 */
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'

import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'

import * as runAgentStep from '../run-agent-step'
import {
  executeSubagent,
  extractSubagentContextParams,
} from '../tools/handlers/tool/spawn-agent-utils'
import { mockFileContext } from './test-utils'

import type { SettledSubagentResult } from '@codebuff/common/types/contracts/agent-runtime'
import type { SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'
import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

// Fixture envelope semantics mirror supervision/__fixtures__/settle-child.ts:
// the required fields of agentReceiptSchema, nothing else.
const OK_RECEIPT: AgentReceipt = {
  schemaVersion: 1,
  receiptId: 'sup-fixture-receipt',
  taskId: 'sup-fixture-task',
  role: 'specialist',
  agentId: 'sup-fixture-agent',
  status: 'completed',
  outcome: 'ok',
  changedFiles: [],
  requirementsAddressed: [],
  acceptanceCriteriaAddressed: [],
  findingsAddressed: [],
  evidence: [],
  assumptions: [],
  unresolved: [],
  requestedValidation: [],
  artifacts: [],
  errors: [],
}

const FAILED_RECEIPT: AgentReceipt = {
  ...OK_RECEIPT,
  receiptId: 'sup-fixture-failed-receipt',
  status: 'failed',
  outcome: 'crashed',
  errors: [
    {
      code: 'unsupported-deps',
      message:
        'Supervised spawn of "thinker" cannot run: the required parent-callback deps are not serializable and the parent→child RPC bridge has not landed (P2-T8 follow-up).',
      retryable: false,
    },
  ],
}

function settledOk(receipt: AgentReceipt): SettledSubagentResult {
  return {
    outcome: 'ok',
    receipt,
    exitCode: 0,
    durationMs: 5,
    stdoutBytes: 256,
    killed: false,
    stderrTail: '',
  }
}

function settledCrash(
  stderrTail = 'child stderr tail line',
): SettledSubagentResult {
  return {
    outcome: 'crashed',
    crashReason: 'nonzero_exit',
    exitCode: 1,
    durationMs: 5,
    stdoutBytes: 0,
    killed: false,
    stderrTail,
  }
}

function makeTemplate(id: string, spawnableAgents: string[] = []): AgentTemplate {
  return {
    id,
    displayName: `Mock ${id}`,
    outputMode: 'last_message' as const,
    inputSchema: {
      prompt: {
        safeParse: () => ({ success: true }),
      } as unknown as AgentTemplate['inputSchema']['prompt'],
    },
    spawnerPrompt: '',
    model: '',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    mcpServers: {},
    toolNames: [],
    spawnableAgents,
    systemPrompt: '',
    instructionsPrompt: '',
    stepPrompt: '',
  }
}

const parentState = {
  agentId: 'sup-parent-1',
  agentType: 'parent',
  runId: 'sup-parent-run',
  ancestorRunIds: [],
  childRunIds: [],
  messageHistory: [],
} as unknown as AgentState

const childState = {
  agentId: 'sup-child-1',
  agentType: 'thinker',
  messageHistory: [],
  ancestorRunIds: [],
} as unknown as AgentState

function buildExecuteParams(overrides: Record<string, unknown> = {}) {
  return {
    ...TEST_AGENT_RUNTIME_IMPL,
    agentState: childState,
    agentTemplate: makeTemplate('thinker'),
    parentAgentState: parentState,
    ancestorRunIds: [],
    prompt: 'Probe',
    spawnParams: undefined,
    userInputId: 'test-input',
    fingerprintId: 'test-fingerprint',
    clientSessionId: 'test-session',
    userId: TEST_USER_ID,
    parentSystemPrompt: '',
    parentTools: {},
    onResponseChunk: () => {},
    signal: new AbortController().signal,
    fileContext: mockFileContext,
    ...overrides,
  } as never
}

describe('processSupervision flag routing (P2-T8)', () => {
  let loopSpy: ReturnType<typeof spyOn>

  afterEach(() => {
    loopSpy.mockRestore()
  })

  it('flag off (unset dep): loopAgentSteps runs in-process, no supervisedReceipt', async () => {
    loopSpy = spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async (options) => ({
        agentState: options.agentState,
        output: { type: 'lastMessage', value: [] },
      }),
    )
    const result = await executeSubagent(buildExecuteParams())
    expect(loopSpy).toHaveBeenCalledTimes(1)
    expect('supervisedReceipt' in result).toBe(false)
    expect(result.output).toEqual({ type: 'lastMessage', value: [] })
  })

  it('flag explicitly false: identical to unset', async () => {
    loopSpy = spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async (options) => ({
        agentState: options.agentState,
        output: { type: 'lastMessage', value: [] },
      }),
    )
    const result = await executeSubagent(
      buildExecuteParams({ processSupervision: false }),
    )
    expect(loopSpy).toHaveBeenCalledTimes(1)
    expect('supervisedReceipt' in result).toBe(false)
  })

  it('flag on without a wired seam: fails open to the in-process path with a warn', async () => {
    loopSpy = spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async (options) => ({
        agentState: options.agentState,
        output: { type: 'lastMessage', value: [] },
      }),
    )
    const warnCalls: unknown[] = []
    const result = await executeSubagent(
      buildExecuteParams({
        processSupervision: true,
        logger: {
          debug: () => {},
          info: () => {},
          warn: (data: unknown, msg?: string) => {
            warnCalls.push(msg)
          },
          error: () => {},
        },
      }),
    )
    expect(loopSpy).toHaveBeenCalledTimes(1)
    expect('supervisedReceipt' in result).toBe(false)
    expect(warnCalls.some((msg) => String(msg).includes('spawnSupervised'))).toBe(
      true,
    )
  })

  it('flag on with an injected seam: ok receipt routes to supervisedReceipt, loopAgentSteps untouched', async () => {
    loopSpy = spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async () => {
        throw new Error('loopAgentSteps must not run when supervision is on')
      },
    )
    const seenRequests: SupervisedSpawnRequest[] = []
    const result = await executeSubagent(
      buildExecuteParams({
        processSupervision: true,
        spawnSupervised: async (request: SupervisedSpawnRequest) => {
          seenRequests.push(request)
          return settledOk(OK_RECEIPT)
        },
      }),
    )
    expect(loopSpy).not.toHaveBeenCalled()
    expect(seenRequests).toHaveLength(1)
    expect(seenRequests[0].agentType).toBe('thinker')
    expect(seenRequests[0].child?.agentId).toBe('sup-child-1')
    // The request must be JSON-serializable (the default seam persists it to
    // a temp file): round-trip it.
    expect(() => JSON.stringify(seenRequests[0])).not.toThrow()
    expect(seenRequests[0].ancestorRunIds).toContain('sup-parent-run')
    expect(result.supervisedReceipt).toEqual(OK_RECEIPT)
    expect(result.output).toEqual({
      type: 'structuredOutput',
      value: { message: 'Supervised subagent thinker completed.' },
    })
  })

  it('flag on: crashed settle maps to the crash-envelope output with the stderr tail folded in', async () => {
    loopSpy = spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async () => {
        throw new Error('loopAgentSteps must not run when supervision is on')
      },
    )
    const result = await executeSubagent(
      buildExecuteParams({
        processSupervision: true,
        spawnSupervised: async () => settledCrash('boom from child'),
      }),
    )
    expect('supervisedReceipt' in result).toBe(false)
    const output = result.output as { type: string; message: string }
    // The crash-envelope shape the settle chain classifies as outcome
    // 'crashed' → failed receipt with the stderr tail inside errors[].
    expect(output.type).toBe('error')
    expect(output.message).toContain('Subagent thinker crashed:')
    expect(output.message).toContain('boom from child')
  })

  it('flag on: a child-declared failed receipt (unsupported-deps) is carried verbatim', async () => {
    loopSpy = spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async () => {
        throw new Error('loopAgentSteps must not run when supervision is on')
      },
    )
    const result = await executeSubagent(
      buildExecuteParams({
        processSupervision: true,
        spawnSupervised: async () => settledOk(FAILED_RECEIPT),
      }),
    )
    // Honest degradation: the child's own failed receipt rides through
    // verbatim so the parent settle chain reconciles it like any failure.
    expect(result.supervisedReceipt?.receiptId).toBe(
      'sup-fixture-failed-receipt',
    )
    expect(result.supervisedReceipt?.errors[0]?.code).toBe('unsupported-deps')
    const output = result.output as { type: string; message: string }
    expect(output.type).toBe('error')
    expect(output.message).toContain('unsupported-deps')
  })

  it('flag on: a malformed envelope from the seam degrades to the crashed mapping', async () => {
    loopSpy = spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async () => {
        throw new Error('loopAgentSteps must not run when supervision is on')
      },
    )
    const result = await executeSubagent(
      buildExecuteParams({
        processSupervision: true,
        spawnSupervised: async () =>
          settledOk({ nope: true } as unknown as AgentReceipt),
      }),
    )
    expect('supervisedReceipt' in result).toBe(false)
    const output = result.output as { type: string; message: string }
    expect(output.type).toBe('error')
    expect(output.message).toContain('Subagent thinker crashed:')
  })

  it('flag on: a throwing seam degrades to the structured error output without throwing', async () => {
    loopSpy = spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async () => {
        throw new Error('loopAgentSteps must not run when supervision is on')
      },
    )
    const result = await executeSubagent(
      buildExecuteParams({
        processSupervision: true,
        spawnSupervised: async () => {
          throw new Error('supervisor transport down')
        },
      }),
    )
    expect('supervisedReceipt' in result).toBe(false)
    const output = result.output as { type: string; message: string }
    expect(output.type).toBe('error')
    expect(output.message).toContain('supervised spawn seam threw')
    expect(output.message).toContain('supervisor transport down')
  })
})

describe('extractSubagentContextParams supervision propagation (P2-T8)', () => {
  it('forwards processSupervision + spawnSupervised with the journal deps', () => {
    const spawnSupervised = async () => settledOk(OK_RECEIPT)
    const extracted = extractSubagentContextParams({
      clientSessionId: 'test-session',
      fileContext: mockFileContext,
      signal: new AbortController().signal,
      userId: TEST_USER_ID,
      processSupervision: true,
      spawnSupervised,
    } as unknown as Parameters<typeof extractSubagentContextParams>[0])
    expect(extracted.processSupervision).toBe(true)
    expect(extracted.spawnSupervised).toBe(spawnSupervised)
  })
})

// Handler-level settle-chain integration: the flag-on inline spawn must
// settle through the REAL reconcile chain with the child's receipt — no
// dangling spawns, no active leases.
describe('inline handler settle chain under supervision (P2-T8)', () => {
  it('ok receipt from the seam reconciles into the parent with no dangling spawns or leases', async () => {
    const { handleSpawnAgentInline } = await import(
      '../tools/handlers/tool/spawn-agent-inline'
    )
    // Own spy (the flag-routing describe's spy + afterEach live in that
    // describe's scope; this describe restores explicitly below).
    const inlineLoopSpy = spyOn(
      runAgentStep,
      'loopAgentSteps',
    ).mockImplementation(async () => {
      throw new Error('loopAgentSteps must not run when supervision is on')
    })
    try {
    const parent = getInitialSessionState(mockFileContext).mainAgentState
    const { output } = await handleSpawnAgentInline({
      ...TEST_AGENT_RUNTIME_IMPL,
      tools: {},
      agentState: parent,
      agentTemplate: makeTemplate('parent', ['thinker']),
      localAgentTemplates: { thinker: makeTemplate('thinker') },
      fileContext: mockFileContext,
      fingerprintId: 'test-fingerprint',
      previousToolCallFinished: Promise.resolve(),
      clientSessionId: 'test-session',
      userId: TEST_USER_ID,
      userInputId: 'test-input',
      writeToClient: () => {},
      processSupervision: true,
      spawnSupervised: async () => settledOk(OK_RECEIPT),
      toolCall: {
        toolName: 'spawn_agent_inline',
        toolCallId: 'sup-inline-1',
        input: { agent_type: 'thinker', prompt: 'Probe' },
      },
    } as never)
    expect(inlineLoopSpy).not.toHaveBeenCalled()

    // The child's validated receipt was reconciled verbatim.
    const report = (output as Array<{ type: string; value: Record<string, unknown> }>)[0]
      .value as { agentReceipt: AgentReceipt }
    expect(report.agentReceipt.receiptId).toBe('sup-fixture-receipt')
    expect(report.agentReceipt.taskId).toBe('sup-fixture-task')

    // Same no-dangling / no-lease invariants the fault-injection suite asserts.
    const events = parent.orchestrationLedger?.events ?? []
    const finished = new Set(
      events
        .filter((event) => event.type === 'spawn_finished')
        .map((event) => event.spawnId),
    )
    const started = events.filter((event) => event.type === 'spawn_started')
    expect(started.length).toBeGreaterThan(0)
    for (const event of started) {
      expect(finished.has(event.spawnId)).toBe(true)
    }
    for (const lease of parent.workspacePathLeases ?? []) {
      expect(lease.status).not.toBe('active')
    }
    } finally {
      inlineLoopSpy.mockRestore()
    }
  })
})

// Compatibility finding
// compatibility-reviewer:serialization_and_persisted_formats:empty-runid-in-ancestor-chain:
// an unset parentAgentState.runId must never emit an empty-string runId
// ('' is not a valid runId) into a child's ancestorRunIds — neither into
// the serialized SupervisedSpawnRequest (the temp-file transport format)
// nor into the in-process loopAgentSteps call. The fallback is the parent's
// stable agentId (the same convention createAgentState and
// reconcileAgentReceiptIntoParent use).
describe('ancestorRunIds fallback for an unset parent runId', () => {
  const parentWithoutRunId = {
    agentId: 'sup-parent-no-run',
    agentType: 'parent',
    ancestorRunIds: [],
    childRunIds: [],
    messageHistory: [],
  } as unknown as AgentState

  it('supervised request falls back to the parent agentId, never an empty string', async () => {
    const seenRequests: SupervisedSpawnRequest[] = []
    await executeSubagent(
      buildExecuteParams({
        parentAgentState: parentWithoutRunId,
        processSupervision: true,
        spawnSupervised: async (request: SupervisedSpawnRequest) => {
          seenRequests.push(request)
          return settledOk(OK_RECEIPT)
        },
      }),
    )
    expect(seenRequests).toHaveLength(1)
    expect(seenRequests[0].ancestorRunIds).toEqual(['sup-parent-no-run'])
    expect(seenRequests[0].ancestorRunIds).not.toContain('')
  })

  it('in-process path falls back to the parent agentId, never an empty string', async () => {
    const loopSpy = spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async (options) => ({
        agentState: options.agentState,
        output: { type: 'lastMessage', value: [] },
      }),
    )
    try {
      await executeSubagent(
        buildExecuteParams({ parentAgentState: parentWithoutRunId }),
      )
      expect(loopSpy).toHaveBeenCalledTimes(1)
      const call = loopSpy.mock.calls[0][0] as unknown as {
        ancestorRunIds: string[]
      }
      expect(call.ancestorRunIds).toEqual(['sup-parent-no-run'])
      expect(call.ancestorRunIds).not.toContain('')
    } finally {
      loopSpy.mockRestore()
    }
  })
})

// Finding code-reviewer:packages/agent-runtime/src/supervision/supervised-spawn.ts:request-file-world-readable:
// the default seam persists the JSON-serialized SupervisedSpawnRequest (user
// prompt, child systemPrompt, child agent state) to disk. The request file
// must be written INSIDE the 0700 mkdtemp sandbox dir — never directly in the
// shared tmpdir — with mode 0o600, so only the owning user can read it for
// the spawn's duration. The writeFileSync spy both captures the call and
// aborts the seam before a real child process is spawned.
describe('buildDefaultSpawnSupervised request-file permissions', () => {
  it('writes the request file inside the mkdtemp sandbox with mode 0o600', async () => {
    const fs = await import('node:fs')
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(
      (() => {
        throw new Error('stop before spawning a real child')
      }) as unknown as typeof writeFileSync,
    )
    try {
      const { buildDefaultSpawnSupervised } = await import(
        '../supervision/supervised-spawn'
      )
      const seam = buildDefaultSpawnSupervised({})
      const request = {
        agentType: 'thinker',
        prompt: 'Probe',
        child: { agentId: 'child-1' },
        ancestorRunIds: [],
        clientSessionId: 'test-session',
        userInputId: 'test-input',
        fingerprintId: 'test-fingerprint',
      } as unknown as SupervisedSpawnRequest
      await expect(seam(request)).rejects.toThrow(
        'stop before spawning a real child',
      )

      expect(writeSpy).toHaveBeenCalledTimes(1)
      const [requestPath, serialized, options] = writeSpy.mock
        .calls[0] as unknown as [string, string, { mode?: number }]
      // Inside the 0700 mkdtemp sandbox dir, never the shared tmpdir root.
      expect(basename(dirname(requestPath))).toMatch(
        /^openbuff-supervised-cwd-/,
      )
      expect(dirname(dirname(requestPath))).toBe(tmpdir())
      // Owner-only read/write, regardless of the process umask.
      expect(options.mode).toBe(0o600)
      expect(serialized).toContain('thinker')
    } finally {
      writeSpy.mockRestore()
    }
  })
})

// P2-T8 pruner carve-out routing: under the SAME flag-on deps, a
// context-pruner child is DELIBERATELY in-process — its pruned history
// must land on the parent's in-memory AgentState, which a supervised
// serialized copy can never deliver (see the carve-out in
// spawn-agent-utils.ts executeSubagent). The identity check is
// agent-id-based (isContextPrunerAgentId), so the publisher-qualified +
// version-pinned spelling used here carves out exactly like a bare
// spelling. Contrast test: a non-pruner child routes to the seam under
// identical deps.
describe('context-pruner supervision carve-out routing (P2-T8)', () => {
  it('a context-pruner child runs loopAgentSteps in-process even when supervision is on', async () => {
    const loopSpy = spyOn(runAgentStep, 'loopAgentSteps').mockImplementation(
      async (options) => ({
        agentState: options.agentState,
        output: { type: 'lastMessage', value: [] },
      }),
    )
    try {
      const warnCalls: unknown[] = []
      const result = await executeSubagent(
        buildExecuteParams({
          agentTemplate: makeTemplate('acme/context-pruner@1.2.3'),
          processSupervision: true,
          spawnSupervised: async () => {
            throw new Error(
              'supervised seam must not run for pruner children',
            )
          },
          logger: {
            debug: () => {},
            info: () => {},
            warn: (data: unknown, msg?: string) => {
              warnCalls.push(msg)
            },
            error: () => {},
          },
        }),
      )
      expect(loopSpy).toHaveBeenCalledTimes(1)
      expect('supervisedReceipt' in result).toBe(false)
      expect(result.output).toEqual({ type: 'lastMessage', value: [] })
      // In-process pruner routing is DELIBERATE, not a misconfiguration:
      // the genuinely-unwired warn must NOT fire for a pruner child,
      // otherwise it would emit once per compaction pass.
      expect(
        warnCalls.some((msg) => String(msg).includes('spawnSupervised')),
      ).toBe(false)
    } finally {
      loopSpy.mockRestore()
    }
  })

  it(
    'a non-pruner child still routes to the supervised seam under the same deps (contrast)',
    async () => {
      const loopSpy = spyOn(
        runAgentStep,
        'loopAgentSteps',
      ).mockImplementation(async () => {
        throw new Error('loopAgentSteps must not run when supervision is on')
      })
      try {
        const result = await executeSubagent(
          buildExecuteParams({
            agentTemplate: makeTemplate('thinker'),
            processSupervision: true,
            spawnSupervised: async () => settledOk(OK_RECEIPT),
          }),
        )
        expect(loopSpy).not.toHaveBeenCalled()
        expect('supervisedReceipt' in result).toBe(true)
        expect(result.supervisedReceipt).toEqual(OK_RECEIPT)
      } finally {
        loopSpy.mockRestore()
      }
    },
  )
})
