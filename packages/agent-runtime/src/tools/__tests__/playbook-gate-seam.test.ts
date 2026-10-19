/**
 * Integration coverage for the executeToolCall pre-dispatch playbook gate seam
 * (tool-executor.ts). The unit tests in memory/__tests__/playbook-gate.test.ts
 * would stay green if the seam were deleted, so this file drives executeToolCall
 * end-to-end with a minimal `as any` harness (mirroring
 * runtime-path-hardening.test.ts) and proves the seam itself: a gated
 * spawn_agents call is refused BEFORE any dispatch, the same call proceeds once
 * the required evidence is recorded on the session ledger, and a failed
 * run_terminal_command result never becomes evidence.
 */
import { describe, expect, it } from 'bun:test'

import { MemoryPlaybookSchema } from '@codebuff/common/types/memory-playbook'
import { jsonToolResult } from '@codebuff/common/util/messages'

import { createSessionEvidenceLog } from '../../memory/session-evidence-log'
import { executeToolCall, recordToolEvidence } from '../tool-executor'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { MemoryPlaybook } from '@codebuff/common/types/memory-playbook'

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

/**
 * Dispatch one spawn_agents(git-committer) call through executeToolCall with
 * the minimal harness preconditions and collect everything it publishes.
 * canSuggestFollowups is left undefined so the commit-scope guards stay
 * inactive, and `requestToolCall` returns [] so an unblocked spawn terminates
 * harmlessly right after the seam.
 */
const dispatchGatedSpawn = async (agentState: Record<string, unknown>) => {
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
    clientEnv: { OPENBUFF_PLAYBOOK_GATE: 'block' },
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
})
