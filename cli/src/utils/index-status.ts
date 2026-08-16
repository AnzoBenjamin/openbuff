import { IndexManager } from '@codebuff/indexer'
import { loadProviderConfigSync } from '@openbuff/sdk'

import { getProjectRoot } from '../project-files'

export type IndexStatusChip = {
  label: string
  tone: 'secondary' | 'warning' | 'error'
} | null

export type IndexStatusPeek = {
  state: string
  refreshing: boolean
} | null

/** Peek the CLI index singleton without constructing an embedder. */
export function peekIndexStatus(): IndexStatusPeek {
  try {
    const indexing = loadProviderConfigSync().config.indexing
    if (indexing.enabled === false) return null
    const status = IndexManager.getInstance(
      getProjectRoot(),
      indexing,
    ).getStatus()
    if (status.state === 'disabled') return null
    return {
      state: status.state,
      refreshing: status.refreshing,
    }
  } catch {
    return null
  }
}

export function formatIndexStatusChip(
  status: { state: string; refreshing: boolean } | null,
): IndexStatusChip {
  if (!status) return null
  if (status.state === 'disabled' || status.state === 'empty') return null
  if (status.state === 'failed') {
    return { label: 'idx failed', tone: 'error' }
  }
  if (status.state === 'building') {
    return { label: 'idx building', tone: 'warning' }
  }
  if (status.refreshing) {
    return { label: 'idx refreshing', tone: 'warning' }
  }
  if (status.state === 'stale') {
    return { label: 'idx stale', tone: 'warning' }
  }
  // Healthy snapshots are silent; only building / refreshing / stale / failed show.
  return null
}

export function shouldForceStatusLineForIndex(
  status: { state: string; refreshing: boolean } | null,
): boolean {
  if (!status) return false
  return (
    status.state === 'building' ||
    status.state === 'failed' ||
    status.refreshing
  )
}
