/**
 * P2-T2b gate test: background-agent resume-from-own-journal.
 *
 * Hermetic by construction: a real createRunJournal over an :memory: sqlite db
 * (the run-journal.test.ts makeJournal pattern — the injected createDatabase
 * seam is the guaranteed-clean path), a fake launch seam that only RECORDS the
 * states it is handed, and NO network / real LLM / real loop. What this suite
 * pins is the ENGINE contract the runtime seam delegates to plus the planner
 * contract that keeps re-launches idempotent:
 *
 *  - S1 mid-tool resume (child tail llm_response): reconstructed history,
 *    pinned original runId, settleable marker, two-phase re-planning.
 *  - S2 mid-llm resume (child tail llm_request): the same last llm_request is
 *    reconstructed and the step re-issues it.
 *  - S3 the engine is stateless (a second pass launches again); the
 *    no-double-launch gates are the PLANNER's marker settlement (across
 *    turns/processes) and the runtime seam's in-process live-drive reservation
 *    (see reserveBackgroundReDrive in background-resume.ts) — the seam is the
 *    layer that must dedupe, never the engine.
 *  - S4 no linkage -> {kind:'no_linkage'}: no launch, no marker, the intent
 *    keeps re-planning exactly as before this slice.
 *  - S5 linkage but no reconstructable llm_request -> {kind:'unrecoverable'}:
 *    no launch, no marker, the intent keeps re-planning.
 *  - S6 the LAST linkage event for a jobId wins (a re-launched job resumes its
 *    newest stream).
 */

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

import {
  findBackgroundChildLinkage,
  reconstructBackgroundChildHistory,
  resumeBackgroundFromOwnJournal,
} from '../background-resume'
import { createRunJournal, planBackgroundAgentResume } from '../run-journal'

import type {
  BackgroundAgentIntent,
  CreatedRunJournal,
} from '../run-journal'
import type { JournalReader } from '@codebuff/common/types/contracts/agent-runtime'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

/** Deterministic clock so created_at is reproducible in tests. */
const fixedClock = { now: () => 1_000 }

const makeJournal = () =>
  createRunJournal({
    path: ':memory:',
    clock: fixedClock,
    createDatabase: (path) => new Database(path),
  })

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * Minimal read-only background agent template. `file-picker` is in
 * DEFAULT_RERUNNABLE_BACKGROUND_AGENT_TYPES, which is what gates every
 * `respawn` decision planBackgroundAgentResume emits. includeMessageHistory:
 * false => messageHistoryMode 'none', so createAgentState starts the child
 * from an EMPTY history and the engine's override is the only source of the
 * transcript — pinning exactly the resume contract under test.
 */
const agentTemplate: AgentTemplate = {
  id: 'file-picker',
  displayName: 'File Picker',
  mcpServers: {},
  toolNames: ['list_files'],
  spawnableAgents: [],
  systemPrompt: 'system',
  instructionsPrompt: 'instructions',
  stepPrompt: 'step',
  inputSchema: {},
  includeMessageHistory: false,
  inheritParentSystemPrompt: false,
  outputMode: 'last_message',
}

const parentAgentState: AgentState = {
  agentId: 'parent-agent',
  agentType: 'base',
  agentContext: {},
  ancestorRunIds: [],
  runId: 'parent-run-1',
  subagents: [],
  childRunIds: [],
  messageHistory: [],
  stepsRemaining: 100,
  creditsUsed: 0,
  directCreditsUsed: 0,
  cacheInputTokens: 0,
  cacheTotalInputTokens: 0,
  output: undefined,
  parentId: undefined,
  systemPrompt: '',
  toolDefinitions: {},
  contextTokenCount: 0,
}

const userMsg = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

const assistantMsg = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})

const toolResultMsg = (toolCallId: string, toolName: string): Message => ({
  role: 'tool',
  toolCallId,
  toolName,
  content: [{ type: 'json', value: { ok: true } }],
})

/**
 * The pre-crash transcript as the child journaled it at its last llm_request:
 * the FULL message history at step start. The trailing tool result is the
 * mid-tool kill window — the model-path tool call that followed was never
 * journaled (processStream -> executeToolCall does not journal), which is why
 * reconstruction is at STEP level from this payload.
 */
const midToolHistory: Message[] = [
  userMsg('do the thing'),
  assistantMsg('working'),
  toolResultMsg('call-1', 'list_files'),
]

const interruptedIntent: BackgroundAgentIntent = {
  jobId: 'job-1',
  agentType: 'file-picker',
  status: 'interrupted',
  startedAt: fixedClock.now(),
}

// ── journal append helpers (mirroring the runtime's own write points) ──────

/** The launch-time durable intent (spawn-agents.ts): correlation = jobId. */
const appendLaunchIntent = (
  journal: CreatedRunJournal,
  parentRunId: string,
  jobId: string,
  agentType: string,
) =>
  journal.append(parentRunId, {
    eventType: 'spawn',
    stepNumber: 0,
    correlation: jobId,
    payload: { agentType, background: true, jobId },
  })

/** The P2-T2b linkage event (loopAgentSteps mint site): correlation = jobId. */
const appendLinkage = (
  journal: CreatedRunJournal,
  parentRunId: string,
  jobId: string,
  childRunId: string,
  agentType = 'file-picker',
) =>
  journal.append(parentRunId, {
    eventType: 'spawn',
    stepNumber: 0,
    correlation: jobId,
    payload: { backgroundLink: true, jobId, childRunId, agentType },
  })

const appendLlmRequest = (
  journal: CreatedRunJournal,
  childRunId: string,
  stepNumber: number,
  messages: Message[],
) =>
  journal.append(childRunId, {
    eventType: 'llm_request',
    stepNumber,
    correlation: `step-${stepNumber}`,
    payload: { model: 'm', system: 's', n: null, messages },
  })

const appendLlmResponse = (
  journal: CreatedRunJournal,
  childRunId: string,
  stepNumber: number,
) =>
  journal.append(childRunId, {
    eventType: 'llm_response',
    stepNumber,
    correlation: `step-${stepNumber}`,
    payload: { messageId: null, fullResponse: 'partial' },
  })

const appendTerminalBoundary = (
  journal: CreatedRunJournal,
  childRunId: string,
  stepNumber: number,
) =>
  journal.append(childRunId, {
    eventType: 'step_boundary',
    stepNumber,
    correlation: childRunId,
    payload: { status: 'completed', terminal: true },
  })

/** Fake launch seam: records every state it is handed, launches nothing. */
const makeRecordingLaunch = () => {
  const launched: AgentState[] = []
  return {
    launched,
    launch: async (state: AgentState) => {
      launched.push(state)
    },
  }
}

/** The respawn marker(s) the engine journaled for a jobId, read from the parent. */
const respawnMarkerFor = (
  journal: CreatedRunJournal,
  parentRunId: string,
  jobId: string,
) =>
  journal.events(parentRunId).filter(
    (event) =>
      event.eventType === 'spawn' &&
      typeof event.payload === 'object' &&
      event.payload !== null &&
      (event.payload as Record<string, unknown>).respawnOf === jobId,
  )

/** Markers journaled with a given correlation (the respawned child's runId). */
const markersForRunId = (journal: CreatedRunJournal, childRunId: string) =>
  journal
    .events('parent-run-1')
    .filter(
      (event) =>
        event.eventType === 'spawn' && event.correlation === childRunId,
    )

/** resumeBackgroundFromOwnJournal wired to the suite's shared fixtures. */
const resume = (
  journal: CreatedRunJournal,
  launch: (state: AgentState) => Promise<unknown>,
) =>
  resumeBackgroundFromOwnJournal({
    reader: journal,
    writer: journal,
    parentRunId: 'parent-run-1',
    jobId: 'job-1',
    agentType: 'file-picker',
    agentTemplate,
    parentAgentState,
    logger,
    launch,
  })

// ── the gate ──────────────────────────────────────────────────────────────

describe('P2-T2b background-agent resume-from-own-journal', () => {
  it('S1 mid-tool resume: reconstructs the last llm_request history, pins the original runId, and journals the settleable marker', async () => {
    const journal = makeJournal()
    try {
      // Parent stream: the launch-time intent, then the linkage event the
      // child journaled at its own runId-mint site.
      appendLaunchIntent(journal, 'parent-run-1', 'job-1', 'file-picker')
      appendLinkage(journal, 'parent-run-1', 'job-1', 'child-run-1')
      // Child stream: one journaled step, then an llm_response whose
      // model-path tool call was NEVER journaled — the mid-tool kill window.
      appendLlmRequest(journal, 'child-run-1', 1, midToolHistory)
      appendLlmResponse(journal, 'child-run-1', 1)

      const { launched, launch } = makeRecordingLaunch()
      const outcome = await resume(journal, launch)

      expect(outcome).toEqual({ kind: 'resumed', childRunId: 'child-run-1' })
      // Launched exactly ONCE, pinned to the ORIGINAL child runId, with the
      // journaled history reconstructed verbatim.
      expect(launched).toHaveLength(1)
      expect(launched[0].runId).toBe('child-run-1')
      expect(launched[0].messageHistory).toEqual(midToolHistory)
      // The relaunch state is a RESUME, not a fresh spawn: it carries no
      // background intents of its own, which is what keeps the re-driven
      // child's own entry-block report inert (no self-respawn recursion).
      expect(launched[0].backgroundAgentJobs).toEqual([])
      // Parent identity transfers like any spawn (the ancestor chain the
      // detached re-drive re-passes to loopAgentSteps).
      expect(launched[0].ancestorRunIds).toEqual(['parent-run-1'])
      expect(launched[0].parentId).toBe('parent-agent')

      // The respawn marker: parent stream, correlation = the CHILD's runId per
      // the documented contract, payload naming the original job. The payload
      // carries the full marker vocabulary the planner matches on.
      const markers = respawnMarkerFor(journal, 'parent-run-1', 'job-1')
      expect(markers).toHaveLength(1)
      expect(markers[0].correlation).toBe('child-run-1')
      expect(markers[0].payload).toEqual({
        respawnOf: 'job-1',
        background: true,
        jobId: 'job-1',
        agentType: 'file-picker',
        resumedFromJournal: true,
      })

      // Idempotent re-planning, phase 1: the child tail is STILL llm_response
      // (non-terminal), so respawnMarkerIsSettled is false and the planner
      // keeps re-planning the respawn — the pre-existing planner contract,
      // unchanged by this slice.
      const before = planBackgroundAgentResume({
        intents: [interruptedIntent],
        reader: journal,
        parentRunId: 'parent-run-1',
      })
      expect(before).toEqual([
        { kind: 'respawn', jobId: 'job-1', agentType: 'file-picker' },
      ])

      // Phase 2: the re-driven child journals a terminal tail, the marker
      // settles, and re-planning flips to already_respawned — blocking the
      // second launch.
      appendTerminalBoundary(journal, 'child-run-1', 2)
      const after = planBackgroundAgentResume({
        intents: [interruptedIntent],
        reader: journal,
        parentRunId: 'parent-run-1',
      })
      expect(after).toEqual([
        {
          kind: 'already_respawned',
          jobId: 'job-1',
          respawnSpawnSeq: markers[0].seq,
        },
      ])
    } finally {
      journal.close()
    }
  })

  it('S2 mid-llm resume: the same last llm_request is reconstructed when the tail has no response', async () => {
    const journal = makeJournal()
    try {
      appendLaunchIntent(journal, 'parent-run-1', 'job-1', 'file-picker')
      appendLinkage(journal, 'parent-run-1', 'job-1', 'child-run-1')
      // Mid-LLM kill: the llm_request was journaled but no response ever
      // arrived, so the child's tail IS the request.
      appendLlmRequest(journal, 'child-run-1', 1, midToolHistory)

      const { launched, launch } = makeRecordingLaunch()
      const outcome = await resume(journal, launch)

      expect(outcome).toEqual({ kind: 'resumed', childRunId: 'child-run-1' })
      expect(launched).toHaveLength(1)
      expect(launched[0].runId).toBe('child-run-1')
      // Reconstruction resolves to the SAME last llm_request either way; the
      // re-driven step re-issues it (side-effect-free: it never completed).
      expect(launched[0].messageHistory).toEqual(midToolHistory)
      expect(respawnMarkerFor(journal, 'parent-run-1', 'job-1')).toHaveLength(1)
    } finally {
      journal.close()
    }
  })

  it('S3 the engine is stateless: a second pass launches again, and the no-double-launch gate is the PLANNER', async () => {
    const journal = makeJournal()
    try {
      appendLaunchIntent(journal, 'parent-run-1', 'job-1', 'file-picker')
      appendLinkage(journal, 'parent-run-1', 'job-1', 'child-run-1')
      appendLlmRequest(journal, 'child-run-1', 1, midToolHistory)
      appendLlmResponse(journal, 'child-run-1', 1)

      const { launched, launch } = makeRecordingLaunch()
      await resume(journal, launch)
      await resume(journal, launch)

      // The ENGINE holds no dedupe state by design — it launches twice. The
      // honest no-double-launch gate is decision-level: planBackgroundAgentResume.
      expect(launched).toHaveLength(2)
      expect(launched.map((state) => state.runId)).toEqual([
        'child-run-1',
        'child-run-1',
      ])

      // Two-phase planner behavior: marker journaled + child tail NOT
      // terminal -> still 'respawn' (the intent keeps re-planning until the
      // re-drive journals a terminal tail; documented, pre-existing).
      expect(
        planBackgroundAgentResume({
          intents: [interruptedIntent],
          reader: journal,
          parentRunId: 'parent-run-1',
        }),
      ).toEqual([{ kind: 'respawn', jobId: 'job-1', agentType: 'file-picker' }])

      // Once the re-drive journals its terminal tail, already_respawned blocks
      // any further launch.
      appendTerminalBoundary(journal, 'child-run-1', 2)
      const settled = planBackgroundAgentResume({
        intents: [interruptedIntent],
        reader: journal,
        parentRunId: 'parent-run-1',
      })
      expect(settled).toHaveLength(1)
      expect(settled[0].kind).toBe('already_respawned')
    } finally {
      journal.close()
    }
  })

  it('S4 honest degradation: no linkage event -> no_linkage, no launch, no marker', async () => {
    const journal = makeJournal()
    try {
      // Launch-time intent only: the child died before its loopAgentSteps could
      // journal the backgroundLink event — e.g. a process-supervised child,
      // which receives no journalWriter through the P2-T8b bridge.
      appendLaunchIntent(journal, 'parent-run-1', 'job-1', 'file-picker')

      const { launched, launch } = makeRecordingLaunch()
      const outcome = await resume(journal, launch)

      expect(outcome).toEqual({ kind: 'no_linkage' })
      expect(launched).toHaveLength(0)
      expect(respawnMarkerFor(journal, 'parent-run-1', 'job-1')).toHaveLength(0)
      // The intent keeps re-planning — exactly today's behavior for a job
      // whose child stream cannot be found.
      expect(
        planBackgroundAgentResume({
          intents: [interruptedIntent],
          reader: journal,
          parentRunId: 'parent-run-1',
        }),
      ).toEqual([{ kind: 'respawn', jobId: 'job-1', agentType: 'file-picker' }])
    } finally {
      journal.close()
    }
  })

  it('S5 honest degradation: linkage present but an EMPTY child journal -> unrecoverable, no launch, no marker', async () => {
    const journal = makeJournal()
    try {
      appendLaunchIntent(journal, 'parent-run-1', 'job-1', 'file-picker')
      appendLinkage(journal, 'parent-run-1', 'job-1', 'child-run-1')
      // The child journaled NOTHING: killed before its first LLM call.

      const { launched, launch } = makeRecordingLaunch()
      const outcome = await resume(journal, launch)

      expect(outcome.kind).toBe('unrecoverable')
      if (outcome.kind === 'unrecoverable') {
        expect(outcome.reason).toContain('llm_request')
      }
      expect(launched).toHaveLength(0)
      expect(respawnMarkerFor(journal, 'parent-run-1', 'job-1')).toHaveLength(0)
    } finally {
      journal.close()
    }
  })

  it('S5b a child journal whose llm_request lacks an array messages payload is equally unrecoverable', async () => {
    const journal = makeJournal()
    try {
      appendLaunchIntent(journal, 'parent-run-1', 'job-1', 'file-picker')
      appendLinkage(journal, 'parent-run-1', 'job-1', 'child-run-1')
      // A malformed/foreign llm_request payload: no array `messages` field, so
      // no history can be reconstructed from it.
      journal.append('child-run-1', {
        eventType: 'llm_request',
        stepNumber: 1,
        correlation: 'step-1',
        payload: { model: 'm', system: 's', n: null },
      })

      const { launched, launch } = makeRecordingLaunch()
      const outcome = await resume(journal, launch)

      expect(outcome.kind).toBe('unrecoverable')
      if (outcome.kind === 'unrecoverable') {
        expect(outcome.reason).toContain('llm_request')
      }
      expect(launched).toHaveLength(0)
      expect(respawnMarkerFor(journal, 'parent-run-1', 'job-1')).toHaveLength(0)
    } finally {
      journal.close()
    }
  })

  it('S6 the LAST linkage event for a jobId wins (a re-launched job resumes its newest stream)', async () => {
    const journal = makeJournal()
    try {
      appendLaunchIntent(journal, 'parent-run-1', 'job-1', 'file-picker')
      appendLinkage(journal, 'parent-run-1', 'job-1', 'child-run-A')
      appendLinkage(journal, 'parent-run-1', 'job-1', 'child-run-B')
      appendLlmRequest(journal, 'child-run-A', 1, [userMsg('older attempt')])
      appendLlmRequest(journal, 'child-run-B', 1, midToolHistory)

      // Pure lookup: the newest linkage supersedes the earlier one.
      expect(
        findBackgroundChildLinkage(journal, 'parent-run-1', 'job-1'),
      ).toEqual({ jobId: 'job-1', childRunId: 'child-run-B' })

      const { launched, launch } = makeRecordingLaunch()
      const outcome = await resume(journal, launch)

      expect(outcome).toEqual({ kind: 'resumed', childRunId: 'child-run-B' })
      expect(launched).toHaveLength(1)
      expect(launched[0].runId).toBe('child-run-B')
      expect(launched[0].messageHistory).toEqual(midToolHistory)
      // The marker settles against the NEWEST stream's runId.
      expect(markersForRunId(journal, 'child-run-B')).toHaveLength(1)
      expect(markersForRunId(journal, 'child-run-A')).toHaveLength(0)
    } finally {
      journal.close()
    }
  })

  it('reconstructBackgroundChildHistory returns the LAST llm_request messages payload verbatim', () => {
    const journal = makeJournal()
    try {
      appendLinkage(journal, 'parent-run-1', 'job-1', 'child-run-1')
      appendLlmRequest(journal, 'child-run-1', 1, [userMsg('first step')])
      appendLlmRequest(journal, 'child-run-1', 2, midToolHistory)

      const reconstructed = reconstructBackgroundChildHistory(
        journal,
        'child-run-1',
      )
      // The last llm_request's messages array, deep-equal to the journal
      // payload: the engine returns the array AS-IS (the values already came
      // from the journal's JSON.parse), so no re-serialization drift is
      // possible.
      const journaled = journal
        .events('child-run-1')
        .filter((event) => event.eventType === 'llm_request')
        .map(
          (event) => (event.payload as { messages: Message[] }).messages,
        )
      expect(journaled).toHaveLength(2)
      expect(reconstructed).toEqual(journaled[1])
      expect(reconstructed).toEqual(midToolHistory)
    } finally {
      journal.close()
    }
  })

  it('a reader that throws degrades to a lookup miss instead of throwing (never-throws contract)', () => {
    const throwingReader: JournalReader = {
      lastEvent: () => {
        throw new Error('journal closed')
      },
      events: () => {
        throw new Error('journal closed')
      },
      toolResultFor: () => undefined,
      toolResultForInput: () => undefined,
    }
    expect(
      findBackgroundChildLinkage(throwingReader, 'parent-run-1', 'job-1'),
    ).toBeUndefined()
    expect(
      reconstructBackgroundChildHistory(throwingReader, 'child-run-1'),
    ).toBeUndefined()
  })
})

// S7 (runtime-seam integration) is exercised in
// packages/agent-runtime/src/__tests__/background-agent-jobs.test.ts under
// 'background resume from own journal (P2-T2b runtime seam)': those cases
// drive the REAL loopAgentSteps — pinnedRunId never mints via startAgentRun
// and journals under the pinned runId; a loop-entry resume of a pre-populated
// interrupted intent + linkage + child llm_request launches the detached
// re-drive, journals the respawn marker, settles the intent, and a live
// re-drive suppresses duplicate launches on a second pass. This file keeps
// the ENGINE contract hermetic (S1-S6); the seam's own wiring is enforced by
// those integration cases plus the typecheck (its object literal must satisfy
// resumeBackgroundFromOwnJournal's params type).
