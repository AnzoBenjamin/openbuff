import { createHash } from 'node:crypto'

import {
  MemoryEventDraftSchema,
  MemoryEventIdSchema,
  MemorySessionIdSchema,
  ObservationIdSchema,
  QueryIdSchema,
  TaskIdSchema,
  type MemoryEventDraft,
  type MemoryEventType,
  type MemorySessionId,
  type ProjectId,
  type QueryId,
  type TaskId,
} from '@codebuff/common/types/memory-v2'

export type DeterministicMemoryIdInput = {
  projectId: ProjectId
  sessionId?: MemorySessionId
  userInputId: string
  callId?: string
  eventType: MemoryEventType | 'session.identity' | 'task.identity' | 'query.identity' | 'observation.identity'
  sourceIndex?: number
}

const hashIdentity = (input: DeterministicMemoryIdInput): string =>
  createHash('sha256')
    .update(
      [
        input.projectId,
        input.sessionId ?? '',
        input.userInputId,
        input.callId ?? '',
        input.eventType,
        String(input.sourceIndex ?? 0),
      ].join('\u0000'),
    )
    .digest('hex')

export const deriveMemoryEventId = (
  input: DeterministicMemoryIdInput,
) => MemoryEventIdSchema.parse(`event:${hashIdentity(input)}`)

export const deriveMemorySessionId = (
  input: Omit<DeterministicMemoryIdInput, 'eventType' | 'sessionId'>,
): MemorySessionId =>
  MemorySessionIdSchema.parse(
    `session:${hashIdentity({ ...input, eventType: 'session.identity' })}`,
  )

export const deriveTaskId = (
  input: Omit<DeterministicMemoryIdInput, 'eventType'>,
): TaskId =>
  TaskIdSchema.parse(`task:${hashIdentity({ ...input, eventType: 'task.identity' })}`)

export const deriveQueryId = (
  input: Omit<DeterministicMemoryIdInput, 'eventType'>,
): QueryId =>
  QueryIdSchema.parse(`query:${hashIdentity({ ...input, eventType: 'query.identity' })}`)

export const deriveObservationId = (
  input: Omit<DeterministicMemoryIdInput, 'eventType'>,
) =>
  ObservationIdSchema.parse(
    `observation:${hashIdentity({ ...input, eventType: 'observation.identity' })}`,
  )

export function createMemoryEventDraft(params: {
  projectId: ProjectId
  sessionId: MemorySessionId
  userInputId: string
  callId?: string
  sourceIndex?: number
  occurredAt: string
  eventType: MemoryEventType
  payload: unknown
}): MemoryEventDraft {
  return MemoryEventDraftSchema.parse({
    schemaVersion: 2,
    eventSchemaVersion: 1,
    eventType: params.eventType,
    eventId: deriveMemoryEventId(params),
    projectId: params.projectId,
    sessionId: params.sessionId,
    occurredAt: params.occurredAt,
    payload: params.payload,
  })
}
