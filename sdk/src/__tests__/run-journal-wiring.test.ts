import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { Database } from 'bun:sqlite'

import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { createRunJournal } from '@codebuff/agent-runtime/util/run-journal'
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
      },
    ) => {
      callMainPromptCount += 1
      capturedDeps = {
        journalWriter: params.journalWriter,
        journalReader: params.journalReader,
        hasJournalWriter: 'journalWriter' in params,
        hasJournalReader: 'journalReader' in params,
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
})
