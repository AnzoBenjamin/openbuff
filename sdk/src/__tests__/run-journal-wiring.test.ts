import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { Database } from 'bun:sqlite'

import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { createRunJournal } from '@codebuff/agent-runtime/util/run-journal'
import type { RunResumeReport } from '@codebuff/agent-runtime/util/run-journal'
import type { RunReplayDriverOutcome } from '@codebuff/agent-runtime/util/run-replay-driver'
import type {
  JournalReader,
  JournalWriter,
} from '@codebuff/common/types/contracts/agent-runtime'

// P2-T2 wiring proof: capture the deps callMainPrompt receives so the test can
// assert OpenbuffClient.run() threaded journalWriter/journalReader from
// OpenbuffClientOptions into the agent-runtime deps (the dormant-journal fix).
// The capture is deliberately NOT awaited (run() awaits it, which would
// deadlock); an interval in the test polls the captured value.
let capturedDeps:
  | {
      journalWriter?: JournalWriter
      journalReader?: JournalReader
      hasJournalWriter: boolean
      hasJournalReader: boolean
      resumeDriver?: (report: RunResumeReport) => Promise<unknown>
      hasResumeDriver: boolean
    }
  | undefined
let callMainPromptCount = 0

// spyOn the module NAMESPACE — never mock.module. bun's mock.module is
// registry-wide for the whole test process and CANNOT be unregistered, so a
// stubbed callMainPrompt leaks into sibling files sharing the process and
// poisoned the sdk e2e suites that run later in the full `bun run test`
// ordering (empty output -> batch failures). A namespace spy restored via
// afterEach(mock.restore) is fully hermetic with zero registry-wide state.
const installCallMainPromptSpy = () =>
  spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
    async (
      params: Parameters<typeof mainPromptModule.callMainPrompt>[0] & {
        journalWriter?: JournalWriter
        journalReader?: JournalReader
        resumeDriver?: (report: RunResumeReport) => Promise<unknown>
      },
    ) => {
      callMainPromptCount += 1
      capturedDeps = {
        journalWriter: params.journalWriter,
        journalReader: params.journalReader,
        hasJournalWriter: 'journalWriter' in params,
        hasJournalReader: 'journalReader' in params,
        resumeDriver: params.resumeDriver,
        hasResumeDriver: 'resumeDriver' in params,
      }
      return {
        sessionState: params.action.sessionState,
        output: { type: 'lastMessage' as const, value: [] },
      }
    },
  )

const { OpenbuffClient } = await import('../client')

const waitForCapture = async () => {
  while (capturedDeps === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return capturedDeps
}

describe('run-journal wiring (P2-T2)', () => {
  beforeEach(() => {
    installCallMainPromptSpy()
  })

  afterEach(() => {
    mock.restore()
  })

  it('OpenbuffClient.run() accepts and threads journalWriter/journalReader into the agent-runtime deps', async () => {
    const journal = createRunJournal({
      path: ':memory:',
      clock: { now: () => 1_000 },
      createDatabase: (path) => new Database(path),
    })
    try {
      capturedDeps = undefined
      callMainPromptCount = 0
      const client = new OpenbuffClient({
        apiKey: 'test-key',
        journalWriter: journal,
        journalReader: journal,
        agentDefinitions: [
          {
            id: 'journal-test-agent',
            displayName: 'Journal Test Agent',
            model: 'openai/gpt-5.1',
            outputMode: 'last_message',
          },
        ],
      })

      await client.run({ agent: 'journal-test-agent', prompt: 'hi' })

      const captured = await waitForCapture()
      expect(callMainPromptCount).toBe(1)
      // The SAME object identity was threaded through runOnce ->
      // getAgentRuntimeImpl -> callMainPrompt, so the runtime's guarded
      // journalWriter/journalReader block is now reachable.
      expect(captured.journalWriter).toBe(journal)
      expect(captured.journalReader).toBe(journal)
      expect(captured.hasJournalWriter).toBe(true)
      expect(captured.hasJournalReader).toBe(true)
    } finally {
      journal.close()
    }
  })

  it('journalWriter/journalReader passed PER RUN (the CLI shape) thread into the agent-runtime deps', async () => {
    // The CLI wires the live journal lazily per run (use-send-message.ts /
    // run-command.ts pass { journalWriter, journalReader } into client.run),
    // so the per-call RunOptions surface must thread them too.
    const journal = createRunJournal({
      path: ':memory:',
      clock: { now: () => 1_000 },
      createDatabase: (path) => new Database(path),
    })
    try {
      capturedDeps = undefined
      callMainPromptCount = 0
      const client = new OpenbuffClient({
        apiKey: 'test-key',
        agentDefinitions: [
          {
            id: 'journal-test-agent',
            displayName: 'Journal Test Agent',
            model: 'openai/gpt-5.1',
            outputMode: 'last_message',
          },
        ],
      })

      await client.run({
        agent: 'journal-test-agent',
        prompt: 'hi',
        journalWriter: journal,
        journalReader: journal,
      })

      const captured = await waitForCapture()
      expect(callMainPromptCount).toBe(1)
      expect(captured.journalWriter).toBe(journal)
      expect(captured.journalReader).toBe(journal)
      expect(captured.hasJournalWriter).toBe(true)
      expect(captured.hasJournalReader).toBe(true)
    } finally {
      journal.close()
    }
  })

  it('a run with no journal wired stays byte-identical (no journal fields on the deps)', async () => {
    capturedDeps = undefined
    callMainPromptCount = 0
    const client = new OpenbuffClient({
      apiKey: 'test-key',
      agentDefinitions: [
        {
          id: 'journal-test-agent',
          displayName: 'Journal Test Agent',
          model: 'openai/gpt-5.1',
          outputMode: 'last_message',
        },
      ],
    })

    await client.run({ agent: 'journal-test-agent', prompt: 'hi' })

    const captured = await waitForCapture()
    expect(callMainPromptCount).toBe(1)
    // Additive-optional: with no journal options, the deps carry no journal
    // fields at all, so runAgentStep's guarded replay block cannot fire.
    expect(captured.journalWriter).toBeUndefined()
    expect(captured.journalReader).toBeUndefined()
    expect(captured.hasJournalWriter).toBe(false)
    expect(captured.hasJournalReader).toBe(false)
  })

  it('the threaded journalReader resolves a journaled tool result deterministically by toolName+input', async () => {
    // A journal that already holds a COMPLETED tool_call/tool_result under a
    // runId. With the reader threaded through run(), the runtime's §4c
    // short-circuit can resolve it deterministically — keying on toolName+input
    // (reproducible across resume), never on the pre-crash random correlation.
    const journal = createRunJournal({
      path: ':memory:',
      clock: { now: () => 1_000 },
      createDatabase: (path) => new Database(path),
    })
    try {
      const runId = 'run-resumed-1'
      journal.append(runId, {
        eventType: 'tool_call',
        stepNumber: 0,
        correlation: 'uuid-pre-crash-1',
        payload: { toolName: 'write_file', input: { path: 'a.ts' } },
      })
      journal.append(runId, {
        eventType: 'tool_result',
        stepNumber: 0,
        correlation: 'uuid-pre-crash-1',
        payload: { toolName: 'write_file', result: [{ type: 'json', value: 1 }] },
      })

      capturedDeps = undefined
      callMainPromptCount = 0
      const client = new OpenbuffClient({
        apiKey: 'test-key',
        journalWriter: journal,
        journalReader: journal,
        agentDefinitions: [
          {
            id: 'journal-test-agent',
            displayName: 'Journal Test Agent',
            model: 'openai/gpt-5.1',
            outputMode: 'last_message',
          },
        ],
      })
      await client.run({ agent: 'journal-test-agent', prompt: 'hi' })

      const captured = await waitForCapture()
      expect(captured.journalReader).toBe(journal)
      // The threaded reader resolves the journaled result by toolName+input
      // (deterministic, reproducible across resume).
      const reader = captured.journalReader!
      expect(
        reader.toolResultForInput(runId, 'write_file', { path: 'a.ts' }, 0),
      ).toEqual({
        toolName: 'write_file',
        result: [{ type: 'json', value: 1 }],
      })
      // A fresh random id (what a resumed run would mint via idGen.uuid())
      // never matches the journaled correlation — proving the §4c fix cannot
      // rely on toolCallId and must use toolResultForInput.
      expect(reader.toolResultFor(runId, 'a-brand-new-uuid')).toBeUndefined()
    } finally {
      journal.close()
    }
  })

  it('threads a production resumeDriver when a journalReader is wired (P2-audit-fix-8)', async () => {
    const journal = createRunJournal({
      path: ':memory:',
      clock: { now: () => 1_000 },
      createDatabase: (path) => new Database(path),
    })
    try {
      capturedDeps = undefined
      callMainPromptCount = 0
      const client = new OpenbuffClient({
        apiKey: 'test-key',
        journalWriter: journal,
        journalReader: journal,
        agentDefinitions: [
          {
            id: 'journal-test-agent',
            displayName: 'Journal Test Agent',
            model: 'openai/gpt-5.1',
            outputMode: 'last_message',
          },
        ],
      })

      await client.run({ agent: 'journal-test-agent', prompt: 'hi' })

      const captured = await waitForCapture()
      expect(callMainPromptCount).toBe(1)
      // The driver rides the SAME additive-optional seam as the journal deps
      // (getAgentRuntimeImpl → callMainPrompt), so the runtime's not-clean
      // branch can now ACT on the resume report in production.
      expect(captured.hasResumeDriver).toBe(true)
      expect(typeof captured.resumeDriver).toBe('function')
    } finally {
      journal.close()
    }
  })

  it('passes NO resumeDriver when no journal is wired (byte-identical deps)', async () => {
    capturedDeps = undefined
    callMainPromptCount = 0
    const client = new OpenbuffClient({
      apiKey: 'test-key',
      agentDefinitions: [
        {
          id: 'journal-test-agent',
          displayName: 'Journal Test Agent',
          model: 'openai/gpt-5.1',
          outputMode: 'last_message',
        },
      ],
    })

    await client.run({ agent: 'journal-test-agent', prompt: 'hi' })

    const captured = await waitForCapture()
    expect(callMainPromptCount).toBe(1)
    // Additive-optional: with no journal options, the deps carry no
    // resumeDriver field at all, so the loop's guarded replay block cannot
    // fire and the default path stays byte-identical.
    expect(captured.hasResumeDriver).toBe(false)
    expect(captured.resumeDriver).toBeUndefined()
  })

  it('the production resumeDriver journals the respawnOf marker once, records skips, and never throws', async () => {
    const journal = createRunJournal({
      path: ':memory:',
      clock: { now: () => 1_000 },
      createDatabase: (path) => new Database(path),
    })
    try {
      capturedDeps = undefined
      callMainPromptCount = 0
      const client = new OpenbuffClient({
        apiKey: 'test-key',
        journalWriter: journal,
        journalReader: journal,
        agentDefinitions: [
          {
            id: 'journal-test-agent',
            displayName: 'Journal Test Agent',
            model: 'openai/gpt-5.1',
            outputMode: 'last_message',
          },
        ],
      })
      await client.run({ agent: 'journal-test-agent', prompt: 'hi' })

      const captured = await waitForCapture()
      const resumeDriver = captured.resumeDriver!
      const runId = 'run-resume-driver-1'
      const jobId = 'bg-agent-job-respawn-test'
      const report: RunResumeReport = {
        runId,
        self: { kind: 'in_flight_tool', toolCallId: 'tc-self' },
        children: {
          kind: 'needs_children',
          inFlight: [
            {
              kind: 'child_in_flight_tool',
              childRunId: 'child-1',
              toolCallId: 'tc-child',
            },
          ],
          awaiting: [{ childRunId: 'child-done', childLastSeq: 7 }],
        },
        background: [
          { kind: 'respawn', jobId, agentType: 'librarian' },
          { kind: 'still_running', jobId: 'bg-agent-job-live' },
        ],
      }

      const outcome = (await resumeDriver(report)) as RunReplayDriverOutcome
      // In-flight child handed to the (best-effort) re-drive seam, the
      // respawn decision handed to the respawn seam, and both skippable
      // items (completed child + still_running job) recorded as skips.
      expect(outcome).toEqual({
        ok: true,
        childrenReplayed: 1,
        backgroundRespawned: 1,
        skipped: 2,
      })

      const respawnMarkersFor = (markerJobId: string) =>
        journal
          .events(runId)
          .filter(
            (event) =>
              event.eventType === 'spawn' &&
              typeof event.payload === 'object' &&
              event.payload !== null &&
              (event.payload as Record<string, unknown>).respawnOf ===
                markerJobId,
          )

      // The durable respawnOf marker was journaled under the interrupted
      // run's own runId (so the next resume's planner can see it), with the
      // launch-time jobId correlation convention and the intent's agentType.
      const markers = respawnMarkersFor(jobId)
      expect(markers).toHaveLength(1)
      expect(markers[0].correlation).toBe(jobId)
      expect(
        (markers[0].payload as Record<string, unknown>).agentType,
      ).toBe('librarian')

      // Idempotent journaling: a second drive does NOT append a second marker
      // (the planner keeps re-planning the intent until a real respawned
      // child settles, but the marker itself is journaled once per run).
      await resumeDriver(report)
      expect(respawnMarkersFor(jobId)).toHaveLength(1)

      // A still_running decision is recorded as a skip and journals nothing.
      expect(respawnMarkersFor('bg-agent-job-live')).toHaveLength(0)

      // The best-effort child re-drive records the attempt WITHOUT journaling
      // a phantom child spawn (planChildResume must not see one).
      const childMarkers = journal
        .events(runId)
        .filter(
          (event) =>
            event.eventType === 'spawn' && event.correlation === 'child-1',
        )
      expect(childMarkers).toHaveLength(0)
    } finally {
      journal.close()
    }
  })

  it('the production resumeDriver is fail-open: a throwing logger never breaks the drive', async () => {
    const journal = createRunJournal({
      path: ':memory:',
      clock: { now: () => 1_000 },
      createDatabase: (path) => new Database(path),
    })
    try {
      capturedDeps = undefined
      callMainPromptCount = 0
      const brokenLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {
          throw new Error('logger exploded')
        },
        error: () => {},
      }
      const client = new OpenbuffClient({
        apiKey: 'test-key',
        journalWriter: journal,
        journalReader: journal,
        logger: brokenLogger,
        agentDefinitions: [
          {
            id: 'journal-test-agent',
            displayName: 'Journal Test Agent',
            model: 'openai/gpt-5.1',
            outputMode: 'last_message',
          },
        ],
      })
      await client.run({ agent: 'journal-test-agent', prompt: 'hi' })

      const captured = await waitForCapture()
      const resumeDriver = captured.resumeDriver!
      const runId = 'run-resume-driver-failopen'
      const report: RunResumeReport = {
        runId,
        self: { kind: 'clean' },
        children: {
          kind: 'needs_children',
          inFlight: [{ kind: 'child_in_flight_llm', childRunId: 'child-2' }],
          awaiting: [],
        },
        background: [
          {
            kind: 'respawn',
            jobId: 'bg-agent-job-failopen',
            agentType: 'thinker',
          },
        ],
      }

      // Every logger call and every handler inside the driver is guarded: the
      // drive resolves (never rejects) even though the host logger throws on
      // every warn, and the respawn marker is still journaled.
      const outcome = (await resumeDriver(report)) as RunReplayDriverOutcome
      expect(outcome.ok).toBe(true)
      expect(outcome.backgroundRespawned).toBe(1)
      const markers = journal
        .events(runId)
        .filter(
          (event) =>
            event.eventType === 'spawn' &&
            typeof event.payload === 'object' &&
            event.payload !== null &&
            (event.payload as Record<string, unknown>).respawnOf ===
              'bg-agent-job-failopen',
        )
      expect(markers).toHaveLength(1)
    } finally {
      journal.close()
    }
  })
})
