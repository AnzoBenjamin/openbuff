/**
 * P2-T8: child-entry contract tests.
 *
 *  - The child emits EXACTLY ONE newline-terminated JSON envelope that
 *    validates against `agentReceiptSchema`, exit 0.
 *  - Missing argv / corrupt request file → exit 1 with NO envelope written.
 *  - Honest degradation: every request yields the structured
 *    'unsupported-deps' FAILED receipt (never a crash, never a half-run).
 *  - Supervised success receipts carry the child's bounded evidence-ledger
 *    snapshot (`sessionEvidence`): entries verbatim in order, LAST ≤50 bound,
 *    field omitted for an absent/empty ledger, schema-valid throughout.
 *  - Real-process + default-seam end-to-end (skipIf no Bun.spawn).
 */
import { agentReceiptSchema } from '@codebuff/common/types/agent-handoff'
import { MemoryPlaybookSchema } from '@codebuff/common/types/memory-playbook'
import { createInitialWorkspaceState } from '@codebuff/common/types/workspace-state'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { convertJsonSchemaToZod } from 'zod-from-json-schema'

import {
  buildChildAgentState,
  buildChildOnResponseChunk,
  buildSupervisedSuccessReceipt,
  buildUnsupportedDepsReceipt,
  missingChildCallbackDeps,
  rehydrateLocalAgentTemplates,
  abortAndAwaitChildLoop,
  runChildEntryMain,
  runSupervisedChildEntry,
  SESSION_EVIDENCE_RECEIPT_MAX_ENTRIES,
} from '../child-entry'
import { buildDefaultSpawnSupervised } from '../supervised-spawn'
import { buildRuntimeAgentReceipt } from '../../tools/handlers/tool/spawn-agent-utils'
import {
  createSessionEvidenceLog,
  recordSessionEvidence,
} from '../../memory/session-evidence-log'

import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type { MemoryPlaybook } from '@codebuff/common/types/memory-playbook'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'
import type {
  SendActionFn,
  SendSubagentChunkFn,
} from '@codebuff/common/types/contracts/client'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { SessionEvidenceLog } from '../../memory/session-evidence-log'

const canSpawn =
  typeof Bun !== 'undefined' && typeof Bun.spawn === 'function'

function captureWrite(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = []
  return { lines, write: (line) => { lines.push(line) } }
}

function makeRequest(
  overrides: Partial<SupervisedSpawnRequest> = {},
): SupervisedSpawnRequest {
  return {
    agentType: 'thinker',
    prompt: 'Probe',
    spawnParams: undefined,
    child: { agentId: 'child-entry-agent-1' },
    ...overrides,
  }
}

/**
 * Schema-valid playbook fixture (shape copied from
 * memory/__tests__/playbook-gate.test.ts's makePlaybook/seededCommitterPlaybook
 * helpers) — the rules a parent threads into the serialized child slice.
 */
const makePlaybook = (playbookId = 'pb-1'): MemoryPlaybook =>
  MemoryPlaybookSchema.parse({
    schemaVersion: 1,
    playbookId,
    workspaceId: 'ws-1',
    title: 'Run local CI before spawning the git committer',
    instruction: 'Run `npm run check:ci-local` and fix failures.',
    trigger: {
      tool: 'spawn_agents',
      spawnAgentType: 'git-committer',
      requireEvidence: [
        {
          kind: 'toolSucceeded',
          tool: 'run_terminal_command',
          commandPattern: '*check:ci-local*',
          withinMs: 30 * 60 * 1_000,
        },
      ],
    },
    scope: { repos: [] },
    status: 'active',
    enforcement: 'block',
    counters: {
      fired: 0,
      blocked: 0,
      compliedAfterBlock: 0,
      falsePositives: 0,
      bypassed: 0,
    },
    provenance: {
      origin: 'derived',
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    triggerSignature: `sig-${playbookId}`,
    createdAt: 1,
    updatedAt: 2,
  })

describe('child-entry cancellation and cleanup ordering', () => {
  it('aborts immediately but does not finish cleanup until the loop settles', async () => {
    let settleLoop!: () => void
    let loopSettled = false
    let abortCalled = false
    const loopPromise = new Promise<void>((resolve) => {
      settleLoop = () => {
        loopSettled = true
        resolve()
      }
    })

    const cleanup = abortAndAwaitChildLoop(loopPromise, () => {
      abortCalled = true
    })
    expect(abortCalled).toBe(true)
    expect(loopSettled).toBe(false)

    settleLoop()
    await cleanup
    expect(loopSettled).toBe(true)
  })

  it('bounds cooperative cleanup and closes owned resources when the loop ignores abort', async () => {
    let abortCalled = false
    let cleanupTimedOut = false
    const neverSettles = new Promise<void>(() => {})

    await abortAndAwaitChildLoop(
      neverSettles,
      () => {
        abortCalled = true
      },
      () => {
        cleanupTimedOut = true
      },
      10,
    )

    expect(abortCalled).toBe(true)
    expect(cleanupTimedOut).toBe(true)
  })

  it('awaits cleanup after a rejected loop without swallowing that rejection from the caller race', async () => {
    const loopFailure = new Error('child loop failed')
    const loopPromise = Promise.reject(loopFailure)

    await expect(
      Promise.race([loopPromise, Promise.resolve('bridge remained open')]),
    ).rejects.toBe(loopFailure)
    // The cleanup wait observes rejection only to know the loop has settled;
    // it must not rethrow during finally and obscure the structured failure.
    await expect(
      abortAndAwaitChildLoop(loopPromise, () => {}),
    ).resolves.toBeUndefined()

    // Pin the child-entry settle chain: a rejection must propagate out of the
    // race into the structured failed-child receipt path, not be converted to
    // undefined and passed to the normal runtime receipt builder.
    const childEntrySource = readFileSync(
      join(import.meta.dir, '../child-entry.ts'),
      'utf8',
    )
    expect(childEntrySource).toContain(
      'const loopPromise = Promise.resolve(\n      loopAgentStepsFn(loopParams),\n    ).then((value) => value as { agentState: unknown; output: unknown })',
    )
    expect(childEntrySource).toContain(
      'return buildFailedChildReceipt({\n      agentType: request.agentType,\n      agentId,\n      message: error instanceof Error ? error.message : String(error),\n    })',
    )
  })
})

describe('child-entry honest degradation (P2-T8)', () => {
  it('every request yields a schema-valid FAILED receipt with code unsupported-deps', async () => {
    const receipt = await runSupervisedChildEntry(makeRequest())
    const parsed = agentReceiptSchema.safeParse(receipt)
    expect(parsed.success).toBe(true)
    expect(receipt.status).toBe('failed')
    expect(receipt.outcome).toBe('crashed')
    expect(receipt.agentId).toBe('child-entry-agent-1')
    expect(receipt.errors).toHaveLength(1)
    expect(receipt.errors[0]?.code).toBe('unsupported-deps')
    expect(receipt.errors[0]?.message).toContain('thinker')
  })

  it('the missing-deps gate fails closed: all callback deps are reported missing', () => {
    const missing = missingChildCallbackDeps(makeRequest())
    expect(missing.length).toBeGreaterThan(0)
    expect(missing).toContain('promptAiSdkStream')
    expect(missing).toContain('sendAction')
    expect(missing).toContain('requestToolCall')
    const receipt = buildUnsupportedDepsReceipt({
      agentType: 'thinker',
      agentId: 'agent-1',
      missing,
    })
    expect(agentReceiptSchema.safeParse(receipt).success).toBe(true)
  })
})

describe('supervised success receipt evidence transport (sessionEvidence)', () => {
  /**
   * A child state carrying the additive evidence ledger tool-executor.ts
   * records onto (one entry per command, in order) — the state the
   * supervised child's loop owns when it finishes.
   */
  function makeChildStateWithLedger(
    commands: string[],
  ): AgentState & { sessionEvidenceLog?: SessionEvidenceLog } {
    const state = buildChildAgentState(
      makeRequest(),
    ) as AgentState & { sessionEvidenceLog?: SessionEvidenceLog }
    if (commands.length > 0) {
      const log = createSessionEvidenceLog()
      state.sessionEvidenceLog = log
      commands.forEach((commandText, index) => {
        recordSessionEvidence(log, {
          toolName: 'run_terminal_command',
          commandText,
          atMs: 1_000 + index,
        })
      })
    }
    return state
  }

  /**
   * Builds the success receipt exactly as runSupervisedChildEntry does: the
   * REAL in-process receipt derivation wrapped by
   * buildSupervisedSuccessReceipt. The agentState crosses the loop boundary
   * as unknown there, hence the cast on the wrapped builder's param.
   */
  function buildReceipt(agentState: unknown): AgentReceipt {
    return buildSupervisedSuccessReceipt({
      agentType: 'thinker',
      agentId: 'child-entry-agent-1',
      output: { type: 'structuredOutput', value: { summary: 'done' } },
      agentState,
      buildRuntimeAgentReceipt: (buildParams) =>
        buildRuntimeAgentReceipt({
          agentType: buildParams.agentType,
          agentId: buildParams.agentId,
          output: buildParams.output,
          agentState: buildParams.agentState as AgentState | undefined,
        }),
    })
  }

  it('carries the child ledger entries verbatim, oldest→newest order preserved, and still validates', () => {
    const receipt = buildReceipt(
      makeChildStateWithLedger(['cmd-a', 'cmd-b', 'cmd-c']),
    )
    // A supervised child's subprocess-local ledger dies with the process;
    // the receipt is the only transport, so the entries must ride VERBATIM
    // in order.
    expect(receipt.sessionEvidence).toEqual([
      { toolName: 'run_terminal_command', commandText: 'cmd-a', atMs: 1_000 },
      { toolName: 'run_terminal_command', commandText: 'cmd-b', atMs: 1_001 },
      { toolName: 'run_terminal_command', commandText: 'cmd-c', atMs: 1_002 },
    ])
    // The evidence-carrying receipt still validates against the strict
    // schema — the field is additive-optional, never a breaking change.
    expect(agentReceiptSchema.safeParse(receipt).success).toBe(true)
  })

  it('serializes exactly the LAST 50 entries when the ledger holds more', () => {
    const commands = Array.from(
      { length: SESSION_EVIDENCE_RECEIPT_MAX_ENTRIES + 10 },
      (_, index) => `cmd-${index}`,
    )
    const receipt = buildReceipt(makeChildStateWithLedger(commands))
    expect(receipt.sessionEvidence).toHaveLength(
      SESSION_EVIDENCE_RECEIPT_MAX_ENTRIES,
    )
    // The bound keeps the NEWEST entries (the tail freshness-bound parent
    // rules evaluate) and preserves oldest→newest order within the slice.
    expect(receipt.sessionEvidence?.map((entry) => entry.commandText)).toEqual(
      commands.slice(-SESSION_EVIDENCE_RECEIPT_MAX_ENTRIES),
    )
    expect(receipt.sessionEvidence?.[0]?.commandText).toBe('cmd-10')
    expect(receipt.sessionEvidence?.at(-1)?.commandText).toBe('cmd-59')
    expect(agentReceiptSchema.safeParse(receipt).success).toBe(true)
  })

  it('an absent or empty ledger omits sessionEvidence from the built receipt entirely', () => {
    // Absent ledger: the fresh child state carries no ledger member at all.
    expect('sessionEvidence' in buildReceipt(makeChildStateWithLedger([]))).toBe(
      false,
    )
    // Empty ledger: nothing was recorded, so the field stays off — receipts
    // stay lean and byte-identical to the pre-evidence shape.
    const emptyLedgerChild = makeChildStateWithLedger([])
    emptyLedgerChild.sessionEvidenceLog = createSessionEvidenceLog()
    expect('sessionEvidence' in buildReceipt(emptyLedgerChild)).toBe(false)
  })
})

describe('child-state rehydration validation (json-roundtrip repair)', () => {
  it('a valid serialized child state rehydrates into the rebuilt AgentState', () => {
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        messageHistory: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }], sentAt: 1234 },
        ],
        systemPrompt: 'be brief',
        taskMemory: {
          schemaVersion: 1,
          revision: 2,
          updatedAt: 5,
          checksum: 'abc123',
        },
        workspaceState: createInitialWorkspaceState(1000),
        contextTokenCount: 42,
      },
      ancestorRunIds: ['run-1'],
    })
    expect(state.agentId).toBe('child-entry-agent-1')
    expect(state.agentType).toBe('thinker')
    expect(state.systemPrompt).toBe('be brief')
    expect(state.contextTokenCount).toBe(42)
    expect(state.ancestorRunIds).toEqual(['run-1'])
    expect(state.messageHistory).toHaveLength(1)
    expect(state.taskMemory?.revision).toBe(2)
    expect(state.workspaceState?.revision).toBe(0)
  })

  it('a valid positive contextWindowTokens rehydrates into the rebuilt AgentState', () => {
    // The parent stamps the resolved BYOK window into the child slice
    // (runSupervisedSubagent) so a supervised child does not fall back to the
    // unknown-window compaction policy; the child must rehydrate it verbatim.
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        contextWindowTokens: 1_000_000,
      },
    })
    expect(state.contextWindowTokens).toBe(1_000_000)
  })

  it('a contextWindowTokens that fails rehydration validation is DROPPED, not blind-cast', () => {
    // 0 / negative / string / NaN all fail the finite-positive-number check,
    // so the fresh initial-state default (undefined) stands in — the same
    // dropped-field contract as messageHistory/taskMemory/workspaceState.
    for (const bad of [
      0,
      -5,
      '1000000',
      Number.NaN,
    ] as unknown as number[]) {
      const state = buildChildAgentState({
        ...makeRequest(),
        child: {
          agentId: 'child-entry-agent-1',
          contextWindowTokens: bad,
        },
      })
      expect(state.contextWindowTokens).toBeUndefined()
    }
  })

  it('a messageHistory whose sentAt was coerced to an ISO string by the JSON round trip is DROPPED, not blind-cast', () => {
    // Simulates the wire: a live Date timestamp serialized to an ISO string.
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        messageHistory: [
          { role: 'user', content: [], sentAt: new Date(0).toISOString() },
        ],
      },
    })
    // The fresh initial-state default stands in — the malformed field never
    // reaches loopAgentSteps under the live Message[] type.
    expect(state.messageHistory).toEqual([])
  })

  it('a taskMemory that fails its schema validation is DROPPED, not blind-cast', () => {
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        // Missing the required revision/updatedAt/checksum members.
        taskMemory: { schemaVersion: 1, goal: 'x' } as unknown,
      },
    })
    expect(state.taskMemory).toBeUndefined()
  })

  it('a playbook array of schema-valid entries rehydrates every entry into the rebuilt AgentState', () => {
    const playbooks = [makePlaybook('pb-1'), makePlaybook('pb-2')]
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        playbookContext: playbooks,
      },
    })
    // The child's own gate/band key on agentState.playbookContext, so the
    // rehydrated rules must be the full validated set.
    expect(state.playbookContext).toHaveLength(2)
    expect(state.playbookContext).toEqual(playbooks)
  })

  it('a playbook array with one invalid entry keeps only the valid entry (partial drop)', () => {
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        playbookContext: [
          makePlaybook('pb-1'),
          // Not a schema-valid memory playbook.
          { schemaVersion: 1, title: 'not a playbook' } as unknown,
        ],
      },
    })
    // Assign the valid entries (possibly fewer than sent); the band and the
    // gate both revalidate anyway, so a partial drop is safe.
    expect(state.playbookContext).toHaveLength(1)
    expect(state.playbookContext?.[0]?.playbookId).toBe('pb-1')
  })

  it('a non-array playbookContext is DROPPED, not blind-cast', () => {
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        playbookContext: { playbookId: 'pb-1' } as unknown,
      },
    })
    // The fresh initial-state default stands in — the malformed field never
    // reaches loopAgentSteps under the live MemoryPlaybook[] type.
    expect(state.playbookContext).toBeUndefined()
  })

  it('an empty playbook array leaves the fresh default (undefined) in place', () => {
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        playbookContext: [],
      },
    })
    expect(state.playbookContext).toBeUndefined()
  })

  it('a workspaceState whose occurredAt was coerced to an ISO string is DROPPED, not blind-cast', () => {
    const base = createInitialWorkspaceState(1000)
    // A DROPPED field leaves the fresh initial-state default standing in
    // (see the buildChildAgentState docblock), so assert against a baseline
    // request that carries no workspaceState at all.
    const baseline = buildChildAgentState({
      ...makeRequest(),
      child: { agentId: 'baseline-1' },
    })
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        workspaceState: {
          ...base,
          updatedAt: '1970-01-01T00:00:01.000Z',
          changes: [
            {
              revision: 1,
              source: 'edit',
              occurredAt: '1970-01-01T00:00:01.000Z',
              actions: [],
            },
          ],
        },
      },
    })
    expect(state.workspaceState).toEqual(baseline.workspaceState)
  })

  it('a workspaceState with an invalid schemaVersion is DROPPED, not blind-cast', () => {
    const baseline = buildChildAgentState({
      ...makeRequest(),
      child: { agentId: 'baseline-1' },
    })
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        workspaceState: { ...createInitialWorkspaceState(1), schemaVersion: 2 },
      },
    })
    expect(state.workspaceState).toEqual(baseline.workspaceState)
  })

  it.skipIf(!canSpawn)(
    'a non-JSON-serializable request settles a structured crashed result instead of throwing across the spawnSupervised seam',
    async () => {
      const seam = buildDefaultSpawnSupervised({ openbuffApiKey: 'sk-test' })
      // A circular child-state field makes the parent-side JSON.stringify
      // throw; the seam must encode that as outcome 'crashed' — never an
      // uncaught exception across the seam boundary.
      const circular: Record<string, unknown> = { agentId: 'circular-1' }
      circular.self = circular
      const result = await seam({
        ...makeRequest(),
        child: circular as unknown as SupervisedSpawnRequest['child'],
      })
      expect(result.outcome).toBe('crashed')
      expect(result.crashReason).toContain('not JSON-serializable')
      expect(result.exitCode).toBeNull()
    },
  )
})

describe('rehydrateLocalAgentTemplates (transport-boundary zod repair)', () => {
  it('re-coerces plain JSON-Schema schema members back to live zod schemas', () => {
    // Simulates the JSON.stringify transport boundary: a live zod schema
    // member arrives in the request file as a plain JSON-Schema object.
    const rehydrated = rehydrateLocalAgentTemplates({
      'test-agent': {
        id: 'test-agent',
        inputSchema: {
          prompt: { type: 'string' },
          params: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      } as never,
    })
    const template = rehydrated['test-agent']
    expect(template).toBeDefined()
    // Every schema member must now be a live zod schema: it carries a
    // callable safeParse, so asSchema no longer routes to the zod-v3
    // converter that crashes on schema._def.typeName.
    expect(typeof (template.inputSchema?.prompt as { safeParse?: unknown })?.safeParse).toBe('function')
    expect(typeof (template.inputSchema?.params as { safeParse?: unknown })?.safeParse).toBe('function')
    expect(typeof (template.outputSchema as { safeParse?: unknown })?.safeParse).toBe('function')
    // And the coerced schemas still VALIDATE correctly (structure preserved).
    expect(
      (template.inputSchema?.prompt as { safeParse: (v: unknown) => { success: boolean } }).safeParse('hello').success,
    ).toBe(true)
    expect(
      (template.inputSchema?.params as { safeParse: (v: unknown) => { success: boolean } }).safeParse({ command: 'ls' }).success,
    ).toBe(true)
  })

  it('repairs a degraded zod-v4 husk (~standard marker, no live internals) instead of crashing asSchema', () => {
    // The worst case: a husk that still carries zod-v4's `~standard` marker
    // but lost its live internals across JSON.stringify. Left unrepaired it
    // reaches asSchema, which reads schema._def.typeName on undefined.
    const husk = { '~standard': { version: 1, vendor: 'zod' } }
    const rehydrated = rehydrateLocalAgentTemplates({
      'husk-agent': {
        id: 'husk-agent',
        inputSchema: { prompt: husk, params: husk },
        outputSchema: husk,
      } as never,
    })
    const template = rehydrated['husk-agent']
    for (const member of [
      template.inputSchema?.prompt,
      template.inputSchema?.params,
      template.outputSchema,
    ]) {
      expect(typeof (member as { safeParse?: unknown })?.safeParse).toBe('function')
    }
  })

  it('passes through templates whose members are already live zod schemas unchanged', () => {
    const livePrompt = convertJsonSchemaToZod({ type: 'string' })
    const liveOutput = convertJsonSchemaToZod({
      type: 'object',
      properties: { ok: { type: 'boolean' } },
    })
    const rehydrated = rehydrateLocalAgentTemplates({
      'live-agent': {
        id: 'live-agent',
        inputSchema: { prompt: livePrompt },
        outputSchema: liveOutput,
      } as never,
    })
    const template = rehydrated['live-agent']
    // Identity: an already-live member is returned untouched (no double
    // conversion). Compare as unknown — convertJsonSchemaToZod's inferred
    // generic differs from the template member's declared ZodType, so a bare
    // toBe hits a spurious overload mismatch without changing the assertion.
    expect(template.inputSchema?.prompt as unknown).toBe(livePrompt as unknown)
    expect(template.outputSchema as unknown).toBe(liveOutput as unknown)
  })

  it('returns an empty record for an absent localAgentTemplates field', () => {
    expect(rehydrateLocalAgentTemplates(undefined)).toEqual({})
  })
})

/** A Logger-contract stand-in that records warn messages. */
function makeLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = []
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (data, msg) => {
      warns.push(msg ?? '')
    },
    error: () => {},
  }
  return { logger, warns }
}

describe('buildChildOnResponseChunk (supervised child live display forwarding)', () => {
  /**
   * A recording stand-in for the bridged fire-and-forget sendSubagentChunk
   * dep — the same mock-the-bridge-surface, assert-call-payloads convention
   * the bridge tests use. The forwarder must push the EXACT foreground-spawn
   * forwarding payload (spawn-agents.ts onResponseChunk shape).
   */
  function makeForwarder(
    overrides: Partial<Parameters<typeof buildChildOnResponseChunk>[0]> = {},
  ) {
    const { logger, warns } = makeLogger()
    const sent: Parameters<SendSubagentChunkFn>[0][] = []
    const actions: Parameters<SendActionFn>[0][] = []
    const onResponseChunk = buildChildOnResponseChunk({
      sendSubagentChunk: (params) => {
        sent.push(params)
      },
      sendAction: (params) => {
        actions.push(params)
      },
      agentId: 'child-entry-agent-1',
      agentType: 'thinker',
      userInputId: 'ui-parent-1',
      prompt: 'Probe',
      logger,
      ...overrides,
    })
    return { sent, actions, onResponseChunk, warns }
  }

  it(
    "string chunks forward verbatim through the bridged sendSubagentChunk keyed to the child's OWN agentId/agentType and the request's verbatim userInputId",
    () => {
      const { sent, onResponseChunk } = makeForwarder()
      onResponseChunk('hello ')
      onResponseChunk('world')
      // The exact foreground-spawn forwarding shape (spawn-agents.ts
      // onResponseChunk): the child's own agentId — the CLI appends to the
      // EXISTING agent block it already created from the spawn event — and
      // the parent's verbatim userInputId.
      expect(sent).toEqual([
        {
          userInputId: 'ui-parent-1',
          agentId: 'child-entry-agent-1',
          agentType: 'thinker',
          chunk: 'hello ',
          prompt: 'Probe',
        },
        {
          userInputId: 'ui-parent-1',
          agentId: 'child-entry-agent-1',
          agentType: 'thinker',
          chunk: 'world',
          prompt: 'Probe',
        },
      ])
    },
  )

  it(
    'a text-type PrintModeEvent forwards its non-empty text as the string chunk through the same sendSubagentChunk call',
    () => {
      const { sent, onResponseChunk } = makeForwarder()
      onResponseChunk({ type: 'text', text: 'reasoning delta' } as PrintModeEvent)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toEqual({
        userInputId: 'ui-parent-1',
        agentId: 'child-entry-agent-1',
        agentType: 'thinker',
        chunk: 'reasoning delta',
        prompt: 'Probe',
      })
    },
  )

  it('an EMPTY text event forwards nothing (no sendSubagentChunk call)', () => {
    const { sent, onResponseChunk } = makeForwarder()
    onResponseChunk({ type: 'text', text: '' } as PrintModeEvent)
    expect(sent).toHaveLength(0)
  })

  it('a text event and its identical string twin forward EXACTLY ONCE (single-forward pairing)', () => {
    // Regression: the child runtime emits each streamed text delta twice —
    // a {type:'text'} PrintModeEvent followed by the identical string — and
    // forwarding both rendered interleaved duplicated text in the TUI.
    const { sent, onResponseChunk } = makeForwarder()
    onResponseChunk({ type: 'text', text: 'hello ' } as PrintModeEvent)
    onResponseChunk('hello ')
    onResponseChunk({ type: 'text', text: 'world' } as PrintModeEvent)
    onResponseChunk('world')
    expect(sent).toHaveLength(2)
    expect(sent.map((s) => s.chunk)).toEqual(['hello ', 'world'])
  })

  it('a repeated identical delta still forwards once per delta (pairing resets after each twin)', () => {
    const { sent, onResponseChunk } = makeForwarder()
    onResponseChunk({ type: 'text', text: 'yes' } as PrintModeEvent)
    onResponseChunk('yes')
    onResponseChunk({ type: 'text', text: 'yes' } as PrintModeEvent)
    onResponseChunk('yes')
    expect(sent).toHaveLength(2)
    expect(sent.every((s) => s.chunk === 'yes')).toBe(true)
  })

  it('a string with no preceding event still forwards (string-only sources)', () => {
    const { sent, onResponseChunk } = makeForwarder()
    onResponseChunk('standalone')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      userInputId: 'ui-parent-1',
      agentId: 'child-entry-agent-1',
      agentType: 'thinker',
      chunk: 'standalone',
      prompt: 'Probe',
    })
  })

  it('a string that differs from the pending event text forwards (mismatch clears the pair)', () => {
    const { sent, onResponseChunk } = makeForwarder()
    onResponseChunk({ type: 'text', text: 'event text' } as PrintModeEvent)
    onResponseChunk('different string')
    expect(sent).toHaveLength(2)
    expect(sent.map((s) => s.chunk)).toEqual(['event text', 'different string'])
  })

  it('reasoning_delta pairing is unaffected (reasoning has its own channel tagging)', () => {
    const { sent, onResponseChunk } = makeForwarder()
    onResponseChunk({
      type: 'reasoning_delta',
      text: 'thought',
      ancestorRunIds: ['run-root'],
      runId: 'run-1',
    } as PrintModeEvent)
    // No string twin is expected for reasoning deltas in the child runtime
    // emission order; verify an unrelated string right after still forwards.
    onResponseChunk('next')
    expect(sent).toHaveLength(2)
    expect(sent[0]?.chunkKind).toBe('reasoning')
    expect(sent[1]?.chunk).toBe('next')
  })

  it(
    "non-text PrintModeEvent variants (tool_call, subagent_start, phase, error) are relayed VERBATIM over the bridged sendAction channel as 'response-chunk' actions — exactly one notification per event",
    () => {
      const { sent, actions, onResponseChunk } = makeForwarder()
      const toolCallEvent = {
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'read_files',
        input: {},
      } as unknown as PrintModeEvent
      const subagentStartEvent = {
        type: 'subagent_start',
        agentId: 'nested-1',
        agentType: 'editor',
        displayName: 'Editor',
        onlyChild: false,
      } as PrintModeEvent
      const phaseEvent = {
        type: 'phase',
        phase: 'thinking',
      } as unknown as PrintModeEvent
      const errorEvent = {
        type: 'error',
        message: 'boom',
      } as unknown as PrintModeEvent
      for (const event of [
        toolCallEvent,
        subagentStartEvent,
        phaseEvent,
        errorEvent,
      ]) {
        onResponseChunk(event)
      }
      // The display channel stays clean: it carries text and reasoning
      // chunks only (the documented forward rule in the child-entry
      // docblock; handleStepsLogChunk's log-record shape does not fit
      // display events).
      expect(sent).toHaveLength(0)
      // Each event is relayed VERBATIM as a `response-chunk` action over
      // the bridged sendAction channel — the exact shape the parent's
      // sendAction handler routes to onResponseChunk → handleEvent (the
      // same createEventHandler path the in-process stream uses), so the
      // child's tool/lifecycle events render like the orchestrator's own.
      // Exactly ONE notification per event (no per-token/per-field
      // fan-out), keeping the notify budget bounded.
      expect(actions).toEqual([
        {
          action: {
            type: 'response-chunk',
            userInputId: 'ui-parent-1',
            chunk: toolCallEvent,
          },
        },
        {
          action: {
            type: 'response-chunk',
            userInputId: 'ui-parent-1',
            chunk: subagentStartEvent,
          },
        },
        {
          action: {
            type: 'response-chunk',
            userInputId: 'ui-parent-1',
            chunk: phaseEvent,
          },
        },
        {
          action: {
            type: 'response-chunk',
            userInputId: 'ui-parent-1',
            chunk: errorEvent,
          },
        },
      ])
    },
  )

  it(
    'text and reasoning_delta events do NOT touch the sendAction relay channel (display-only boundary)',
    () => {
      const { sent, actions, onResponseChunk } = makeForwarder()
      onResponseChunk({ type: 'text', text: 'delta' } as PrintModeEvent)
      onResponseChunk({
        type: 'reasoning_delta',
        text: 'thought',
        ancestorRunIds: ['run-root'],
        runId: 'run-1',
      } as PrintModeEvent)
      // Text/reasoning deltas ride the display channel only; the sendAction
      // relay is reserved for the remaining (tool/lifecycle) variants.
      expect(actions).toHaveLength(0)
      expect(sent).toHaveLength(2)
    },
  )

  it(
    "a reasoning_delta event forwards its non-empty text as a reasoning chunk (chunkKind 'reasoning' + the event's ancestorRunIds) keyed to the child's OWN agentId/agentType and the request's verbatim userInputId",
    () => {
      const { sent, onResponseChunk } = makeForwarder()
      onResponseChunk({
        type: 'reasoning_delta',
        text: 'thinking...',
        ancestorRunIds: ['run-root', 'run-child'],
        runId: 'run-1',
      } as PrintModeEvent)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toEqual({
        userInputId: 'ui-parent-1',
        agentId: 'child-entry-agent-1',
        agentType: 'thinker',
        chunk: 'thinking...',
        prompt: 'Probe',
        chunkKind: 'reasoning',
        ancestorRunIds: ['run-root', 'run-child'],
      })
    },
  )

  it('an EMPTY reasoning_delta event forwards nothing (no sendSubagentChunk call)', () => {
    const { sent, onResponseChunk } = makeForwarder()
    onResponseChunk({
      type: 'reasoning_delta',
      text: '',
      ancestorRunIds: ['run-root'],
      runId: 'run-1',
    } as PrintModeEvent)
    expect(sent).toHaveLength(0)
  })

  it(
    'a THROWING sendSubagentChunk never crashes the forwarder: the failure is warned at most once and later chunks still forward',
    () => {
      const sent: Parameters<SendSubagentChunkFn>[0][] = []
      const { logger, warns } = makeLogger()
      let failNext = true
      const onResponseChunk = buildChildOnResponseChunk({
        sendSubagentChunk: (params) => {
          if (failNext) {
            failNext = false
            throw new Error('bridge socket closed mid-run')
          }
          sent.push(params)
        },
        sendAction: () => {},
        agentId: 'child-entry-agent-1',
        agentType: 'thinker',
        userInputId: 'ui-parent-1',
        prompt: 'Probe',
        logger,
      })
      // First chunk: the dep throws — swallowed, never propagated.
      expect(() => onResponseChunk('first')).not.toThrow()
      expect(sent).toHaveLength(0)
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('display-stream forwarding failed')
      // Later chunks still attempt to forward (only the WARN is once).
      onResponseChunk('second')
      expect(sent).toHaveLength(1)
      expect(sent[0]?.chunk).toBe('second')
      // And a SECOND failure is swallowed without another warn.
      failNext = true
      expect(() => onResponseChunk('third')).not.toThrow()
      expect(warns).toHaveLength(1)
      expect(sent).toHaveLength(1)
    },
  )
})

describe('child-entry process contract (P2-T8)', () => {
  it('writes EXACTLY ONE newline-terminated JSON envelope and exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'child-entry-test-'))
    try {
      const requestPath = join(dir, 'request.json')
      writeFileSync(requestPath, JSON.stringify(makeRequest()))
      const { lines, write } = captureWrite()
      const exitCode = await runChildEntryMain(
        ['bun', 'child-entry.ts', requestPath],
        write,
      )
      expect(exitCode).toBe(0)
      expect(lines).toHaveLength(1)
      expect(lines[0].endsWith('\n')).toBe(true)
      const parsed = agentReceiptSchema.safeParse(JSON.parse(lines[0]))
      expect(parsed.success).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('missing request-file argv: exit 1, no envelope written', async () => {
    const { lines, write } = captureWrite()
    const exitCode = await runChildEntryMain(['bun', 'child-entry.ts'], write)
    expect(exitCode).toBe(1)
    expect(lines).toHaveLength(0)
  })

  it('corrupt request file: exit 1, no envelope written (crash classification upstream)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'child-entry-test-'))
    try {
      const requestPath = join(dir, 'request.json')
      writeFileSync(requestPath, 'not json at all')
      const { lines, write } = captureWrite()
      const exitCode = await runChildEntryMain(
        ['bun', 'child-entry.ts', requestPath],
        write,
      )
      expect(exitCode).toBe(1)
      expect(lines).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSpawn)(
    'real child process: exactly one newline-terminated envelope on stdout, exit 0',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'child-entry-proc-'))
      try {
        const requestPath = join(dir, 'request.json')
        writeFileSync(requestPath, JSON.stringify(makeRequest()))
        const proc = Bun.spawn(
          [
            process.execPath,
            'run',
            join(import.meta.dir, '../child-entry.ts'),
            requestPath,
          ],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        )
        const stdout = await new Response(proc.stdout).text()
        const exitCode = await proc.exited
        expect(exitCode).toBe(0)
        expect(stdout.endsWith('\n')).toBe(true)
        const lines = stdout.split('\n').filter((line) => line.trim().length > 0)
        expect(lines).toHaveLength(1)
        const parsed = agentReceiptSchema.safeParse(JSON.parse(lines[0]))
        expect(parsed.success).toBe(true)
        expect(
          (parsed.data as AgentReceipt).errors[0]?.code,
        ).toBe('unsupported-deps')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!canSpawn)(
    'real child process: a LARGE envelope fully flushes before exit (fire-and-forget stdout regression)',
    async () => {
      // Regression: the default stdout sink used to `void` the Bun.write
      // promise, so process.exit fired while a large envelope (>64KB pipe
      // buffer) was still pending — the supervisor settled 'schema_invalid'
      // on the truncated stdout and every large-receipt spawn crashed. A
      // huge child agentId rides the unsupported-deps receipt's agentId and
      // taskId fields so the REAL process emits a >1MB envelope; the fixed
      // sink awaits the write, so the envelope must arrive complete.
      const largeAgentId = 'large-envelope-'.repeat(40_000) // ~560KB, doubled by taskId
      const dir = mkdtempSync(join(tmpdir(), 'child-entry-large-'))
      try {
        const requestPath = join(dir, 'request.json')
        writeFileSync(
          requestPath,
          JSON.stringify(makeRequest({ child: { agentId: largeAgentId } })),
        )
        const proc = Bun.spawn(
          [
            process.execPath,
            'run',
            join(import.meta.dir, '../child-entry.ts'),
            requestPath,
          ],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        )
        const stdout = await new Response(proc.stdout).text()
        const exitCode = await proc.exited
        expect(exitCode).toBe(0)
        expect(stdout.endsWith('\n')).toBe(true)
        const lines = stdout.split('\n').filter((line) => line.trim().length > 0)
        expect(lines).toHaveLength(1)
        // The whole envelope survived the process boundary: no mid-flush cut.
        expect(lines[0].length).toBeGreaterThan(1_000_000)
        const parsed = agentReceiptSchema.safeParse(JSON.parse(lines[0]))
        expect(parsed.success).toBe(true)
        expect((parsed.data as AgentReceipt).agentId).toBe(largeAgentId)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!canSpawn)(
    'default seam end-to-end: the supervised child degrades honestly with an unsupported-deps receipt',
    async () => {
      const seam = buildDefaultSpawnSupervised({
        openbuffApiKey: 'sk-supervised-test',
        // The extended P2-T8 seed (provider-config override, proxy, TMPDIR,
        // locale, ripgrep override) flows through the default seam without
        // disturbing the child-entry contract; the supervisor forwards the
        // built allowlist verbatim.
        passthroughEnv: {
          OPENBUFF_PROVIDER_CONFIG: '/tmp/openbuff-provider.json',
          HTTPS_PROXY: 'http://proxy.test:8443',
          TMPDIR: '/tmp/child-entry-test',
          CODEBUFF_RG_PATH: '/opt/openbuff/vendor/rg',
        },
      })
      const settled = await seam(makeRequest())
      // The child reported its honest degradation; the supervisor settles a
      // valid envelope as 'ok' at the transport level and preserves the
      // child-declared failed receipt untouched.
      expect(settled.outcome).toBe('ok')
      expect(settled.exitCode).toBe(0)
      const receipt = settled.receipt as AgentReceipt
      expect(receipt.status).toBe('failed')
      expect(receipt.errors[0]?.code).toBe('unsupported-deps')
      expect(receipt.agentId).toBe('child-entry-agent-1')
    },
  )
})
