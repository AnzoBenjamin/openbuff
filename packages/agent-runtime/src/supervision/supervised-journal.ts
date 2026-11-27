import type {
  JournalEvent,
  JournalWriter,
} from '@codebuff/common/types/contracts/agent-runtime'

const retainedEvents = new Set<JournalEvent['eventType']>([
  'llm_request',
  'llm_response',
  'llm_replay_boundary',
  'tool_call',
  'tool_result',
  'spawn',
  'step_boundary',
  'error',
])
const maxRecordBytes = 2 * 1024 * 1024
const maxPendingWrites = 64

/** Generic child observations only. The bridge cannot grant an immutable replay claim. */
export function readSupervisedJournalAppend(raw: unknown): {
  runId: string
  event: JournalEvent
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid supervised journal append')
  const { runId, event } = raw as { runId?: unknown; event?: unknown }
  if (
    typeof runId !== 'string' ||
    runId.length === 0 ||
    runId.length > 256 ||
    !event ||
    typeof event !== 'object' ||
    Array.isArray(event)
  )
    throw new Error('Invalid supervised journal append')
  const item = event as JournalEvent
  if (
    !retainedEvents.has(item.eventType) ||
    !Number.isSafeInteger(item.stepNumber) ||
    item.stepNumber < 0 ||
    !Object.hasOwn(item, 'payload') ||
    (item.correlation != null &&
      (typeof item.correlation !== 'string' ||
        item.correlation.length > 512)) ||
    Object.keys(item).some(
      (key) =>
        !['eventType', 'stepNumber', 'correlation', 'payload'].includes(key),
    ) ||
    Buffer.byteLength(JSON.stringify(item)) > maxRecordBytes
  )
    throw new Error('Invalid or oversized supervised journal event')
  return { runId, event: item }
}

/** Keep enqueue-time bytes and ordered durable acknowledgements; a gap poisons the tape. */
export function createSupervisedJournalWriter(
  publish: (append: { runId: string; event: JournalEvent }) => Promise<unknown>,
): JournalWriter & { flush(): Promise<void> } {
  let tail = Promise.resolve()
  let failure: Error | undefined
  let pending = 0
  function enqueue(runId: string, event: JournalEvent): Promise<void> {
    if (failure) throw failure
    let captured: ReturnType<typeof readSupervisedJournalAppend>
    try {
      if (pending >= maxPendingWrites)
        throw new Error('Supervised journal queue is full')
      captured = readSupervisedJournalAppend(
        JSON.parse(
          JSON.stringify({
            runId,
            event: { ...event, payload: event.payload ?? null },
          }),
        ),
      )
    } catch (error) {
      failure =
        error instanceof Error
          ? error
          : new Error('Supervised journal serialization failed')
      throw failure
    }
    pending++
    const result = tail
      .then(async () => {
        if (failure) throw failure
        await publish(captured)
      })
      .catch((error) => {
        failure ??=
          error instanceof Error
            ? error
            : new Error('Supervised journal acknowledgement failed')
        throw failure
      })
      .finally(() => {
        pending--
      })
    tail = result
    void result.catch(() => {}) // void append callers observe a poisoned tape at flush or the next durable boundary
    return result
  }
  return {
    append(runId, event) {
      void enqueue(runId, event)
    },
    appendDurable: enqueue,
    async flush() {
      await tail
      if (failure) throw failure
    },
  }
}
