import type {
  ContextArchiveBodyReference,
  ContextArchiveRetentionReceipt,
} from './context-archive'

export type ContextArchiveSearchMatch = {
  runId: string
  archivedAt: number
  step: number
  toolName: string
  toolCallId: string
  snippet: string
  body?: ContextArchiveBodyReference
}

export type ContextArchiveSearchOutcome = {
  status?: 'ok' | 'degraded' | 'unavailable'
  reasons?: string[]
  matches: ContextArchiveSearchMatch[]
  snapshotsSearched: number
  retention?: ContextArchiveRetentionReceipt
}
