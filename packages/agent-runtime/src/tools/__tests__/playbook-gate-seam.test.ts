/**
 * Integration coverage for the executeToolCall pre-dispatch playbook gate seam
 * (tool-executor.ts). The unit tests in memory/__tests__/playbook-gate.test.ts
 * would stay green if the seam were deleted, so this file drives executeToolCall
 * end-to-end with a minimal `as any` harness (mirroring
 * runtime-path-hardening.test.ts) and proves the seam itself: a gated
 * spawn_agents call is refused BEFORE any dispatch, the same call proceeds once
 * the required evidence is recorded on the session ledger, and a failed
 * run_terminal_command result never becomes evidence. The producer-outcome
 * cases additionally pin the Phase 4 counter seam: every warned/blocked verdict
 * reaches the onPlaybookGateOutcome dep exactly once, a throwing or rejecting
 * producer can never reach the gate's fail-open catch (so a BLOCKED call still
 * aborts), and an absent dep keeps behavior byte-identical. The comply-
 * detection cases extend the Phase 4 seam: an `allowed` verdict is
 * behavior-invisible (no chunk, no dispatch change, never a store report on
 * its own) yet lands in the per-agent-state gate history, a blocked-then-
 * satisfied arc reports exactly one 'compliedAfterBlock', a heeded warn never
 * correlates, and a repeat allowed call reports nothing more.
 */
import { describe, expect, it } from 'bun:test'

import { MemoryPlaybookSchema } from '@codebuff/common/types/memory-playbook'
import { jsonToolResult } from '@codebuff/common/util/messages'

import { createSessionEvidenceLog } from '../../memory/session-evidence-log'
import { executeToolCall, recordToolEvidence } from '../tool-executor'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  MemoryPlaybook,
  PlaybookGateOutcomeEvent,
} from '@codebuff/common/types/memory-playbook'

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/**
 * Schema-valid block-mode playbook: run local CI before spawning the git
 * committer. Parsing through MemoryPlaybookSchema keeps the fixture honest —
 * an invalid shape would make the gate fail open and the block assertion below
 * would fail.
 */
const ciPlaybook: MemoryPlaybook = MemoryPlaybookSchema.parse({
  schemaVersion: 1,
  playbookId: 'pb-seam-1',
  workspaceId: 'ws-1',
  title: 'Run local CI before spawning the git committer',
  instruction:
    'Run `bun run check:ci-local` and fix failures before committing.',
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
  triggerSignature: 'sig-seam-1',
  createdAt: 1,
  updatedAt: 2,
})

const spawnGitCommitterInput = {
  agents: [
    { agent_type: 'git-committer', prompt: 'Commit the task-owned changes' },
  ],
}

const ciSuccessOutput = () =>
  jsonToolResult({
    command: 'bun run check:ci-local',
    output: 'all checks passed',
  })

const entriesOf = (agentState: Record<string, unknown>) =>
  (agentState.sessionEvidenceLog as { entries: unknown[] }).entries

const gateHistoryEntriesOf = (agentState: Record<string, unknown>) =>
  (agentState.sessionGateHistory as { entries: unknown[] }).entries

/**
 * Dispatch one spawn_agents(git-committer) call through executeToolCall with
 * the minimal harness preconditions and collect everything it publishes.
 * canSuggestFollowups is left undefined so the commit-scope guards stay
 * inactive, and `requestToolCall` returns [] so an unblocked spawn terminates
 * harmlessly right after the seam.
 */
const dispatchGatedSpawn = async (
  agentState: Record<string, unknown>,
  overrides?: {
    /** Gate-mode env; defaults to block mode like the original harness. */
    clientEnv?: Record<string, string | undefined>
    /** Producer-outcome stub riding the additive AgentRuntimeDeps seam. */
    onPlaybookGateOutcome?: (
      event: PlaybookGateOutcomeEvent,
    ) => void | Promise<void>
  },
) => {
  const chunks: Array<Record<string, unknown>> = []
  const toolResults: unknown[] = []
  await executeToolCall({
    toolName: 'spawn_agents',
    input: spawnGitCommitterInput,
    agentState,
    agentTemplate: {
      id: 'test-agent',
      toolNames: ['spawn_agents'],
      programmaticToolNames: ['spawn_agents'],
      spawnableAgents: [],
    },
    logger,
    // The seam reads the gate mode from params.clientEnv, never process.env.
    clientEnv: overrides?.clientEnv ?? { OPENBUFF_PLAYBOOK_GATE: 'block' },
    // The producer-outcome seam dep: absent (the default) reports nothing.
    onPlaybookGateOutcome: overrides?.onPlaybookGateOutcome,
    // Once the gate allows the call, post-seam dispatch dereferences
    // fileContext.projectRoot for filesystem containment; a virtual tree keeps
    // the harness free of real filesystem paths.
    fileContext: {
      projectRoot: '/tmp/playbook-gate-seam',
      fileTreeSource: 'virtual',
      tokenCallers: {},
    },
    previousToolCallFinished: Promise.resolve(),
    signal: new AbortController().signal,
    toolCalls: [],
    toolCallsToAddToMessageHistory: [],
    toolResults,
    toolResultsToAddToMessageHistory: [],
    onResponseChunk: (chunk: unknown) => {
      chunks.push(chunk as Record<string, unknown>)
    },
    requestToolCall: async () => [],
    onCostCalculated: async () => undefined,
  } as any)
  return { chunks, toolResults }
}

describe('executeToolCall playbook gate seam', () => {
  it('refuses the gated spawn before dispatch, then allows it once the CI evidence is recorded', async () => {
    const agentState: Record<string, unknown> = {
      agentId: 'agent-1',
      playbookContext: [ciPlaybook],
    }

    // Missing evidence: the seam emits the playbook error and returns before
    // any dispatch — no tool_call chunk, no tool result.
    const blocked = await dispatchGatedSpawn(agentState)
    expect(blocked.chunks).toHaveLength(1)
    expect(blocked.chunks[0]?.type).toBe('error')
    const blockedMessage = String(blocked.chunks[0]?.message)
    expect(blockedMessage).toContain('Playbook')
    expect(blockedMessage).toContain(ciPlaybook.title)
    expect(blockedMessage).toContain('*check:ci-local*')
    expect(blockedMessage).toContain('spawn_agents')
    expect(blocked.chunks.some((chunk) => chunk.type === 'tool_call')).toBe(
      false,
    )
    expect(blocked.toolResults).toHaveLength(0)

    // Recording the real successful CI check satisfies the playbook.
    recordToolEvidence({
      agentState,
      toolName: 'run_terminal_command',
      input: { command: 'bun run check:ci-local' },
      output: ciSuccessOutput(),
    } as any)
    expect(entriesOf(agentState)).toHaveLength(1)

    // The SAME call now proceeds past the seam: the tool_call chunk is
    // published and the dispatch settles into exactly one tool result. Any
    // post-seam failure must come from the stubs, never from the playbook.
    const allowed = await dispatchGatedSpawn(agentState)
    const messages = allowed.chunks
      .filter((chunk) => typeof chunk.message === 'string')
      .map((chunk) => String(chunk.message))
    expect(
      messages.some(
        (message) =>
          message.includes('Playbook') || message.includes('check:ci-local'),
      ),
    ).toBe(false)
    expect(
      allowed.chunks.some(
        (chunk) =>
          chunk.type === 'tool_call' && chunk.toolName === 'spawn_agents',
      ),
    ).toBe(true)
    expect(allowed.toolResults).toHaveLength(1)
  })

  it('records nothing for a failed run_terminal_command output', () => {
    const agentState: Record<string, unknown> = {
      agentId: 'agent-2',
      sessionEvidenceLog: createSessionEvidenceLog(),
    }

    recordToolEvidence({
      agentState,
      toolName: 'run_terminal_command',
      input: { command: 'bun run check:ci-local' },
      output: jsonToolResult({
        command: 'bun run check:ci-local',
        errorMessage: 'Command failed with exit code 1',
      }),
    } as any)
    expect(entriesOf(agentState)).toHaveLength(0)

    // Positive control: the same call with a successful output records exactly
    // one entry, so the zero above is the error skip, not a dead recorder.
    recordToolEvidence({
      agentState,
      toolName: 'run_terminal_command',
      input: { command: 'bun run check:ci-local' },
      output: ciSuccessOutput(),
    } as any)
    expect(entriesOf(agentState)).toHaveLength(1)
    expect(
      (entriesOf(agentState)[0] as { commandText?: string }).commandText,
    ).toBe('bun run check:ci-local')
  })

  it('uses an injected timestamp when recording evidence', () => {
    const agentState: Record<string, unknown> = {
      agentId: 'agent-3',
      sessionEvidenceLog: createSessionEvidenceLog(),
    }

    recordToolEvidence({
      agentState,
      toolName: 'run_terminal_command',
      input: { command: 'bun run check:ci-local' },
      output: ciSuccessOutput(),
      atMs: 12_345,
    } as any)

    expect((entriesOf(agentState)[0] as { atMs?: number }).atMs).toBe(12_345)
  })

  it('reports a warned outcome to the producer and still dispatches under warn mode', async () => {
    const agentState: Record<string, unknown> = {
      agentId: 'agent-outcome-warn',
      playbookContext: [ciPlaybook],
    }
    const events: PlaybookGateOutcomeEvent[] = []

    const { chunks, toolResults } = await dispatchGatedSpawn(agentState, {
      // An unset gate env resolves to warn mode; a 'block' playbook only warns.
      clientEnv: {},
      onPlaybookGateOutcome: (event) => {
        events.push(event)
      },
    })

    expect(events).toEqual([
      {
        playbookId: ciPlaybook.playbookId,
        triggerSignature: ciPlaybook.triggerSignature,
        outcome: 'warned',
      },
    ])
    // The warned verdict is advisory: the spawn still dispatched.
    expect(chunks.some((chunk) => chunk.type === 'tool_call')).toBe(true)
    expect(toolResults).toHaveLength(1)
  })

  it('reports a blocked outcome to the producer when block mode aborts the dispatch', async () => {
    const agentState: Record<string, unknown> = {
      agentId: 'agent-outcome-block',
      playbookContext: [ciPlaybook],
    }
    const events: PlaybookGateOutcomeEvent[] = []

    const { chunks, toolResults } = await dispatchGatedSpawn(agentState, {
      onPlaybookGateOutcome: (event) => {
        events.push(event)
      },
    })

    expect(events).toEqual([
      {
        playbookId: ciPlaybook.playbookId,
        triggerSignature: ciPlaybook.triggerSignature,
        outcome: 'blocked',
      },
    ])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.type).toBe('error')
    expect(chunks.some((chunk) => chunk.type === 'tool_call')).toBe(false)
    expect(toolResults).toHaveLength(0)
  })

  it('isolates a synchronously throwing producer so the blocked abort still happens', async () => {
    // The hazard this seam must never allow: a throwing producer inside the
    // gate's fail-open try block would be swallowed by its catch and let a
    // BLOCKED call proceed. The reporter isolates the emission, so the
    // blocked abort stands and the tool call returns without dispatch.
    const agentState: Record<string, unknown> = {
      agentId: 'agent-outcome-throw',
      playbookContext: [ciPlaybook],
    }

    const { chunks, toolResults } = await dispatchGatedSpawn(agentState, {
      onPlaybookGateOutcome: () => {
        throw new Error('producer callback exploded')
      },
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.type).toBe('error')
    expect(chunks.some((chunk) => chunk.type === 'tool_call')).toBe(false)
    expect(toolResults).toHaveLength(0)
  })

  it('isolates a rejecting producer with no unhandled rejection and unchanged behavior', async () => {
    const agentState: Record<string, unknown> = {
      agentId: 'agent-outcome-reject',
      playbookContext: [ciPlaybook],
    }

    const { chunks, toolResults } = await dispatchGatedSpawn(agentState, {
      onPlaybookGateOutcome: () =>
        Promise.reject(new Error('producer callback rejected')),
    })
    // Give the rejection a microtask to propagate through the reporter's
    // .catch; an unhandled rejection would fail this test run.
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.type).toBe('error')
    expect(chunks.some((chunk) => chunk.type === 'tool_call')).toBe(false)
    expect(toolResults).toHaveLength(0)
  })

  it('behaves byte-identically when the producer dep is absent', async () => {
    const withStub = await dispatchGatedSpawn(
      { agentId: 'agent-outcome-absent-a', playbookContext: [ciPlaybook] },
      { onPlaybookGateOutcome: () => undefined },
    )
    const without = await dispatchGatedSpawn({
      agentId: 'agent-outcome-absent-b',
      playbookContext: [ciPlaybook],
    })

    expect(without.chunks).toEqual(withStub.chunks)
    expect(without.toolResults).toEqual(withStub.toolResults)
    expect(
      without.chunks.some((chunk) => chunk.type === 'tool_call'),
    ).toBe(false)
  })

  it('records a satisfied playbook as an allowed verdict that is invisible to dispatch and to the store', async () => {
    // Comply-detection case (a): fresh arc with the evidence already
    // recorded, so the very first gated call yields an `allowed` verdict. It
    // must be behavior-invisible — no playbook error chunk, dispatch
    // unaffected — while landing exactly one `allowed` entry in the agent
    // state's session gate history. The `allowed` outcome itself is NEVER
    // reported to the producer (the outcome mapping's counter effect is '—'),
    // so a wired producer sees an empty events array.
    const agentState: Record<string, unknown> = {
      agentId: 'agent-comply-allowed',
      playbookContext: [ciPlaybook],
    }
    recordToolEvidence({
      agentState,
      toolName: 'run_terminal_command',
      input: { command: 'bun run check:ci-local' },
      output: ciSuccessOutput(),
    } as any)
    const events: PlaybookGateOutcomeEvent[] = []

    const { chunks, toolResults } = await dispatchGatedSpawn(agentState, {
      onPlaybookGateOutcome: (event) => {
        events.push(event)
      },
    })

    expect(events).toEqual([])
    const messages = chunks
      .filter((chunk) => typeof chunk.message === 'string')
      .map((chunk) => String(chunk.message))
    expect(
      messages.some(
        (message) =>
          message.includes('Playbook') || message.includes('check:ci-local'),
      ),
    ).toBe(false)
    expect(chunks.some((chunk) => chunk.type === 'tool_call')).toBe(true)
    expect(toolResults).toHaveLength(1)
    expect(gateHistoryEntriesOf(agentState)).toHaveLength(1)
    const recorded = gateHistoryEntriesOf(agentState)[0] as {
      playbookId?: string
      triggerSignature?: string
      outcome?: string
      atMs?: number
    }
    expect(recorded.playbookId).toBe(ciPlaybook.playbookId)
    expect(recorded.triggerSignature).toBe(ciPlaybook.triggerSignature)
    expect(recorded.outcome).toBe('allowed')
    expect(typeof recorded.atMs).toBe('number')
  })

  it('reports exactly one compliedAfterBlock when a blocked call is later satisfied in-session', async () => {
    // Comply-detection case (b): blocked(sig) at t1 under block mode, the
    // required evidence recorded, then the SAME call at t2. The t2 call
    // surfaces no playbook error and reports exactly ONE
    // 'compliedAfterBlock' through the same isolation seam.
    const agentState: Record<string, unknown> = {
      agentId: 'agent-comply-block-then-allowed',
      playbookContext: [ciPlaybook],
    }
    const events: PlaybookGateOutcomeEvent[] = []
    const producer = (event: PlaybookGateOutcomeEvent) => {
      events.push(event)
    }

    // t1: the harness's default env is OPENBUFF_PLAYBOOK_GATE=block and the
    // playbook enforces 'block', so the verdict is a hard block.
    const blocked = await dispatchGatedSpawn(agentState, {
      onPlaybookGateOutcome: producer,
    })
    expect(blocked.chunks).toHaveLength(1)
    expect(blocked.chunks[0]?.type).toBe('error')
    expect(events).toEqual([
      {
        playbookId: ciPlaybook.playbookId,
        triggerSignature: ciPlaybook.triggerSignature,
        outcome: 'blocked',
      },
    ])

    recordToolEvidence({
      agentState,
      toolName: 'run_terminal_command',
      input: { command: 'bun run check:ci-local' },
      output: ciSuccessOutput(),
    } as any)

    // t2: satisfied — no playbook error chunk, dispatch proceeds, and the
    // correlated comply report fires exactly once.
    const allowed = await dispatchGatedSpawn(agentState, {
      onPlaybookGateOutcome: producer,
    })
    const messages = allowed.chunks
      .filter((chunk) => typeof chunk.message === 'string')
      .map((chunk) => String(chunk.message))
    expect(
      messages.some(
        (message) =>
          message.includes('Playbook') || message.includes('check:ci-local'),
      ),
    ).toBe(false)
    expect(allowed.chunks.some((chunk) => chunk.type === 'tool_call')).toBe(
      true,
    )
    expect(allowed.toolResults).toHaveLength(1)
    expect(events).toEqual([
      {
        playbookId: ciPlaybook.playbookId,
        triggerSignature: ciPlaybook.triggerSignature,
        outcome: 'blocked',
      },
      {
        playbookId: ciPlaybook.playbookId,
        triggerSignature: ciPlaybook.triggerSignature,
        outcome: 'compliedAfterBlock',
      },
    ])
    // The prior block is the correlated (compensated) entry; the allowed
    // verdict is recorded beside it.
    const historyEntries = gateHistoryEntriesOf(agentState) as Array<{
      outcome?: string
      compensated?: boolean
    }>
    expect(historyEntries).toHaveLength(2)
    expect(historyEntries[0]?.outcome).toBe('blocked')
    expect(historyEntries[0]?.compensated).toBe(true)
    expect(historyEntries[1]?.outcome).toBe('allowed')
  })

  it('never reports compliedAfterBlock for a heeded warn', async () => {
    // Comply-detection case (c), the design-doc invariant:
    // 'compliedAfterBlock' correlates ONLY against a prior 'blocked' — NEVER
    // a 'warned'. A warned-then-allowed arc must report the warn and nothing
    // more; polluting the after-block counter would destroy the one strong
    // effectiveness signal.
    const agentState: Record<string, unknown> = {
      agentId: 'agent-comply-warn-then-allowed',
      playbookContext: [ciPlaybook],
    }
    const events: PlaybookGateOutcomeEvent[] = []
    const producer = (event: PlaybookGateOutcomeEvent) => {
      events.push(event)
    }

    // t1: an unset gate env resolves to warn mode, so the 'block' playbook
    // downgrades to a warning and the spawn still dispatches.
    const warned = await dispatchGatedSpawn(agentState, {
      clientEnv: {},
      onPlaybookGateOutcome: producer,
    })
    expect(events).toEqual([
      {
        playbookId: ciPlaybook.playbookId,
        triggerSignature: ciPlaybook.triggerSignature,
        outcome: 'warned',
      },
    ])
    expect(warned.chunks.some((chunk) => chunk.type === 'tool_call')).toBe(
      true,
    )

    recordToolEvidence({
      agentState,
      toolName: 'run_terminal_command',
      input: { command: 'bun run check:ci-local' },
      output: ciSuccessOutput(),
    } as any)

    // t2: satisfied under warn mode yields the allowed verdict, but the only
    // prior outcome for the signature is a WARN — no compliedAfterBlock may
    // ever fire.
    await dispatchGatedSpawn(agentState, {
      clientEnv: {},
      onPlaybookGateOutcome: producer,
    })
    expect(events).toEqual([
      {
        playbookId: ciPlaybook.playbookId,
        triggerSignature: ciPlaybook.triggerSignature,
        outcome: 'warned',
      },
    ])
  })

  it('does not report a second compliedAfterBlock on a repeat allowed call', async () => {
    // Comply-detection case (d): once per prior block. After the
    // block→comply arc reports once, a repeat satisfied call must report
    // nothing more — the blocked entry is already compensated.
    const agentState: Record<string, unknown> = {
      agentId: 'agent-comply-once-per-block',
      playbookContext: [ciPlaybook],
    }
    const events: PlaybookGateOutcomeEvent[] = []
    const producer = (event: PlaybookGateOutcomeEvent) => {
      events.push(event)
    }

    await dispatchGatedSpawn(agentState, { onPlaybookGateOutcome: producer })
    recordToolEvidence({
      agentState,
      toolName: 'run_terminal_command',
      input: { command: 'bun run check:ci-local' },
      output: ciSuccessOutput(),
    } as any)
    await dispatchGatedSpawn(agentState, { onPlaybookGateOutcome: producer })
    expect(
      events.filter((event) => event.outcome === 'compliedAfterBlock'),
    ).toHaveLength(1)

    // t3: the same satisfied call again — no second comply report, and the
    // allowed verdict itself is still never a store event.
    await dispatchGatedSpawn(agentState, { onPlaybookGateOutcome: producer })
    expect(
      events.filter((event) => event.outcome === 'compliedAfterBlock'),
    ).toHaveLength(1)
    expect(events).toEqual([
      {
        playbookId: ciPlaybook.playbookId,
        triggerSignature: ciPlaybook.triggerSignature,
        outcome: 'blocked',
      },
      {
        playbookId: ciPlaybook.playbookId,
        triggerSignature: ciPlaybook.triggerSignature,
        outcome: 'compliedAfterBlock',
      },
    ])
    const historyEntries = gateHistoryEntriesOf(agentState) as Array<{
      outcome?: string
      compensated?: boolean
    }>
    expect(historyEntries).toHaveLength(3)
    expect(historyEntries[0]?.outcome).toBe('blocked')
    expect(historyEntries[0]?.compensated).toBe(true)
  })
})
