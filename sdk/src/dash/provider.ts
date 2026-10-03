/**
 * P2-T7: the default {@link DashDataProvider} backed by a P2-T2 run journal
 * (plus optional receipt/gate seams). Deliberately thin and injectable: the
 * journal reader is a seam (`JournalReader`), so tests inject hermetic fakes
 * and the dashboard never opens sqlite itself. When no reader is wired the
 * provider serves EMPTY run/event data (additive-and-optional, matching the
 * journal contract) while receipts/gate still surface from their seams.
 */

import type { JournalReader } from '@codebuff/common/types/contracts/agent-runtime'

import type { DashDataProvider, DashRunEvent, DashRunSummary } from './server'

/** payloadSummary is a bounded JSON.stringify of the event payload. */
export const MAX_PAYLOAD_SUMMARY_LENGTH = 300

/** Bounded listRuns: at most the 64 most recent runs are surfaced. */
export const MAX_LISTED_RUNS = 64

/**
 * Bounded JSON summary of a journal payload: JSON.stringify, truncated to
 * `MAX_PAYLOAD_SUMMARY_LENGTH` chars. A cyclic/unserializable payload falls
 * back to a constant marker so the provider can never throw on a
 * partially-shaped journal row.
 */
export function summarizePayload(payload: unknown): string {
  let text: string
  try {
    text = JSON.stringify(payload) ?? 'undefined'
  } catch {
    return '[unserializable payload]'
  }
  if (text.length <= MAX_PAYLOAD_SUMMARY_LENGTH) return text
  return `${text.slice(0, MAX_PAYLOAD_SUMMARY_LENGTH)}...`
}

/**
 * REAL wall-clock timestamp (ISO 8601) for a journal row, from the
 * `createdAt` (epoch ms) the reader surfaced — or undefined when the journal
 * carries no timestamp. Never a synthetic ordering label: a field named
 * createdAt must carry a timestamp or be absent.
 */
function createdAtIsoFor(event: { createdAt?: number }): string | undefined {
  return typeof event.createdAt === 'number'
    ? new Date(event.createdAt).toISOString()
    : undefined
}

function mapEvent(event: {
  seq: number
  eventType: string
  payload: unknown
  createdAt?: number
}): DashRunEvent {
  const createdAt = createdAtIsoFor(event)
  return {
    seq: event.seq,
    eventType: event.eventType,
    payloadSummary: summarizePayload(event.payload),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

export type CreateDashProviderFromJournalParams = {
  /** P2-T2 run-journal reader; when absent, runs/events are empty arrays. */
  journalReader?: JournalReader
  /**
   * Run-id enumeration seam. `JournalReader.events` is per-runId, so
   * listing runs needs a source of ids: an explicit injection wins, then
   * the reader's optional non-contract `runIds()` extension (the production
   * sqlite journal provides it). Without either, listRuns surfaces no runs
   * (fail-closed, never guesses ids).
   */
  runIds?: () => string[]
  /** Redacted receipt wire shapes; defaults to empty. */
  receipts?: () => unknown[]
  /** Redacted gate state; defaults to null. */
  gateState?: () => unknown | null
}

/**
 * Build the dashboard provider from the journal/receipt/gate seams.
 *
 * listRuns groups the journal's events by runId: it scans the run ids the
 * reader exposes through its optional non-contract `runIds` extension (the
 * production sqlite journal provides it), bounded to `MAX_LISTED_RUNS`, and
 * derives `eventCount` — plus the run's REAL `startedAt` when the journal
 * carries a timestamp for its first event — from each run's own event list. A reader
 * without the extension surfaces no runs (fail-closed, never guesses ids).
 */
export function createDashProviderFromJournal(
  params: CreateDashProviderFromJournalParams = {},
): DashDataProvider {
  const journalReader = params.journalReader

  const knownRunIds = (): string[] => {
    if (params.runIds) return params.runIds().slice(0, MAX_LISTED_RUNS)
    if (!journalReader) return []
    const readerWithIds = journalReader as JournalReader & {
      runIds?: () => string[]
    }
    if (typeof readerWithIds.runIds === 'function') {
      return readerWithIds.runIds().slice(0, MAX_LISTED_RUNS)
    }
    return []
  }

  return {
    async listRuns(): Promise<DashRunSummary[]> {
      if (!journalReader) return []
      const summaries: DashRunSummary[] = []
      for (const runId of knownRunIds()) {
        const events = journalReader.events(runId)
        if (events.length === 0) continue
        const startedAt = createdAtIsoFor(events[0]!)
        summaries.push({
          runId,
          eventCount: events.length,
          ...(startedAt !== undefined ? { startedAt } : {}),
        })
      }
      return summaries
    },

    async getRunEvents(runId: string): Promise<DashRunEvent[]> {
      if (!journalReader) return []
      return journalReader.events(runId).map((event) => mapEvent(event))
    },

    async getReceipts(): Promise<unknown[]> {
      return params.receipts?.() ?? []
    },

    async getGateState(): Promise<unknown | null> {
      return params.gateState?.() ?? null
    },
  }
}
