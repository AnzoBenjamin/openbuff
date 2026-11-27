import { getExactContentHash } from '@codebuff/common/util/content-hash'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ReadFilesItemV1 } from '@codebuff/common/tools/results/filesystem'
import type { MemoryReuseReceiptV1 } from '@codebuff/common/types/memory-v2'
import { recordMemoryReuse } from '../orchestration/discovery-coordinator'

/** Actual completed native reads only. No model result text or aggregate count identifies a reread. */
export function recordMemoryReadObservation(params: {
  state: AgentState
  results: readonly ReadFilesItemV1[]
  requiredRefreshPaths: ReadonlySet<string>
}): void {
  if (
    !params.state.memoryV2Context ||
    !params.state.memoryV2EmittedObservationIds?.length
  )
    return
  const context = params.state.memoryV2Context
  const emitted = new Set(params.state.memoryV2EmittedObservationIds)
  const evidence = context.result.verifiedKnowledge
    .filter((item) => emitted.has(item.observation.observationId))
    .flatMap((item) => item.verifiedEvidence)
  const observedReads: NonNullable<
    NonNullable<MemoryReuseReceiptV1['byTool']>[number]['observedReads']
  > = []
  for (const item of params.results) {
    if (
      item.status !== 'ok' ||
      !('complete' in item) ||
      !item.complete ||
      !('content' in item) ||
      typeof item.content !== 'string'
    )
      continue
    if (item.selector !== 'file' && item.selector !== 'range') continue
    const anchor = item.editAnchor
    // The handler attaches only authenticated anchors. Display-only/partial reads do not establish equivalent source.
    if (!anchor?.rawBasis || item.path.length > 1024) continue
    const contentDigest =
      item.selector === 'file'
        ? anchor.rawBasis.documentRawHash
        : getExactContentHash(item.content)
    const startLine = item.selector === 'range' ? item.startLine : undefined
    const endLine = item.selector === 'range' ? item.endLine : undefined
    const matches = evidence.some(
      (entry) =>
        entry.contentDigest === contentDigest &&
        'path' in entry.selector &&
        entry.selector.path === item.path &&
        (entry.selector.kind === 'file'
          ? startLine === undefined
          : (entry.selector.kind === 'line-range' ||
              entry.selector.kind === 'chunk') &&
            entry.selector.startLine === startLine &&
            entry.selector.endLine === endLine),
    )
    const required =
      params.requiredRefreshPaths.has(item.path) ||
      context.result.rereadRequired.some(
        (entry) =>
          'path' in entry.selector && entry.selector.path === item.path,
      )
    observedReads.push({
      path: item.path,
      contentDigest,
      ...(startLine === undefined ? {} : { startLine, endLine }),
      reason: required
        ? 'required-refresh'
        : matches
          ? 'unchanged-reread'
          : 'unknown',
    })
    if (observedReads.length === 32) break
  }
  if (observedReads.length)
    recordMemoryReuse(params.state, {
      tool: 'read_files',
      decision: 'full',
      served: 0,
      gaps: 0,
      observedReads,
    })
}
