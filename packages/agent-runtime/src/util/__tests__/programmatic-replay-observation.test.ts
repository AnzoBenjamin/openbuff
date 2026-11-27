import { describe, expect, test } from 'bun:test'

import type {
  JournalEvent,
  JournalWriter,
} from '@codebuff/common/types/contracts/agent-runtime'
import { beginProgrammaticReplayObservation } from '../programmatic-replay-observation'

type Options = Parameters<typeof beginProgrammaticReplayObservation>[0]
function facts(writer: JournalWriter): Options {
  return {
    writer,
    runId: 'fixture-run',
    agentId: 'fixture-actor',
    templateId: 'fixture',
    stepNumber: 1,
    program: 'function* () { yield "STEP" }',
    runtimeSource: 'actual component source',
    configuration: { mode: 'fixture' },
    input: { prompt: 'owned input' },
  }
}

describe('bounded production replay observations', () => {
  test('does not allocate rows without opt-in and an acknowledging writer', async () => {
    const events: JournalEvent[] = []
    const append = (_run: string, event: JournalEvent) => {
      events.push(event)
    }
    expect(
      await beginProgrammaticReplayObservation(
        facts({ append, appendDurable: append }),
      ),
    ).toBeUndefined()
    expect(
      await beginProgrammaticReplayObservation(
        facts({ append, captureProgrammaticReplay: true }),
      ),
    ).toBeUndefined()
    expect(events).toEqual([])
  })

  test('an unrecordable value stops the tape rather than claiming a later return', async () => {
    const events: JournalEvent[] = []
    const recorder = await beginProgrammaticReplayObservation({
      ...facts({
        captureProgrammaticReplay: true,
        append() {},
        appendDurable: (_run, event) => {
          events.push(event)
        },
      }),
      program: function* () {
        yield 'STEP'
      },
      configuration: { unresolved: () => null },
    })
    expect(recorder).toBeDefined()
    await recorder!.yielded(1, 'STEP')
    await recorder!.beforeNext(2, { toolResult: ['x'.repeat(80_000)] })
    await recorder!.returned(2, 'no terminal claim')
    expect(events.map((event) => event.payload)).toMatchObject([
      {
        kind: 'basis',
        artifact: { kind: 'opaque_callable' },
        configurationSha256: null,
        replayPermitted: false,
      },
      { kind: 'yield', ordinal: 0, value: 'STEP', replayPermitted: false },
      {
        kind: 'gap',
        ordinal: 0,
        reason: 'unrecordable_data',
        replayPermitted: false,
      },
    ])
  })

  test('a failed durable observation cannot be replaced by a guessed completion', async () => {
    const events: JournalEvent[] = []
    const recorder = await beginProgrammaticReplayObservation(
      facts({
        captureProgrammaticReplay: true,
        append() {},
        appendDurable: (_run, event) => {
          if ((event.payload as { kind: string }).kind === 'yield')
            throw new Error('fixture storage refusal')
          events.push(event)
        },
      }),
    )
    await recorder!.yielded(1, 'STEP_ALL')
    await recorder!.beforeNext(2, { stepsComplete: true })
    await recorder!.returned(2, null)
    expect(events.map((event) => event.payload)).toMatchObject([
      { kind: 'basis', replayPermitted: false },
    ])
  })
})
