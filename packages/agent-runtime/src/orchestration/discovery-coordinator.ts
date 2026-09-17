import { createHash } from 'node:crypto'

import { discoveryCoverageV1Schema } from '@codebuff/common/types/discovery-coverage'

import type { DiscoveryCoverageV1 } from '@codebuff/common/types/discovery-coverage'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function canonicalizeDiscoveryInput(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  if (depth >= 8) return '[nested input omitted]'
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeDiscoveryInput(item, depth + 1))
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalizeDiscoveryInput(item, depth + 1)]),
  )
}

export function buildDiscoveryQuestion(params: {
  agentType: string
  prompt?: string
  objective?: string
  spawnParams?: Record<string, unknown>
}): string {
  const explicitQuestion = [params.prompt, params.objective]
    .find((value) => typeof value === 'string' && value.trim().length > 0)
    ?.trim()
  if (explicitQuestion) return explicitQuestion

  const canonicalParams = canonicalizeDiscoveryInput(params.spawnParams)
  const serializedParams = canonicalParams
    ? JSON.stringify(canonicalParams)
    : ''
  if (serializedParams && serializedParams !== '{}') {
    return `${params.agentType} parameters: ${serializedParams.slice(0, 4_000)}`
  }
  return `${params.agentType} discovery`
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function looksLikePath(value: string): boolean {
  return (
    value.length < 1_000 &&
    !value.includes('\n') &&
    /(?:^|\/)[^/]+\.[A-Za-z0-9]{1,12}(?::\d+)?$/.test(value)
  )
}

function extractCandidates(value: unknown): Map<string, Set<string>> {
  const candidates = new Map<string, Set<string>>()
  const add = (raw: string, reason: string) => {
    const withoutLine = raw.replace(/:\d+(?::\d+)?$/, '')
    const path = normalizePath(withoutLine)
    if (!looksLikePath(path)) return
    const reasons = candidates.get(path) ?? new Set<string>()
    reasons.add(reason)
    candidates.set(path, reasons)
  }
  const visit = (item: unknown, key = 'result', depth = 0): void => {
    if (!item || depth > 10) return
    if (typeof item === 'string') {
      add(item, key)
      return
    }
    if (Array.isArray(item)) {
      for (const nested of item) visit(nested, key, depth + 1)
      return
    }
    if (typeof item !== 'object') return
    for (const [nestedKey, nested] of Object.entries(
      item as Record<string, unknown>,
    )) {
      visit(nested, nestedKey, depth + 1)
    }
  }
  visit(value)
  return candidates
}

function extractCandidateSymbols(value: unknown): Map<string, string[]> {
  const byPath = new Map<string, string[]>()
  try {
    const addSymbols = (rawPath: unknown, rawSymbols: unknown) => {
      if (typeof rawPath !== 'string' || !Array.isArray(rawSymbols)) return
      let normalized = ''
      try {
        normalized = normalizePath(rawPath)
      } catch {
        return
      }
      if (!normalized || !looksLikePath(normalized)) return
      const symbols: string[] = []
      for (const entry of rawSymbols) {
        if (typeof entry !== 'string') continue
        const trimmed = entry.trim().slice(0, 200)
        if (!trimmed) continue
        if (!symbols.includes(trimmed)) symbols.push(trimmed)
        if (symbols.length >= 32) break
      }
      if (symbols.length === 0) return
      const previous = byPath.get(normalized) ?? []
      const merged = [...previous]
      for (const symbol of symbols) {
        if (!merged.includes(symbol)) merged.push(symbol)
        if (merged.length >= 32) break
      }
      byPath.set(normalized, merged.slice(0, 32))
    }
    const visit = (item: unknown, depth = 0): void => {
      if (!item || depth > 10) return
      if (Array.isArray(item)) {
        for (const nested of item) visit(nested, depth + 1)
        return
      }
      if (typeof item !== 'object') return
      const record = item as Record<string, unknown>
      if (typeof record['path'] === 'string' && record['symbols'] !== undefined) {
        addSymbols(record['path'], record['symbols'])
      }
      for (const nested of Object.values(record)) visit(nested, depth + 1)
    }
    visit(value)
  } catch {
    // Best-effort only.
  }
  return byPath
}

export type VerifiedExcerpt = {
  path: string
  chunkId?: string
  excerpt?: string
  contentDigest?: string
  workspaceRevision?: number
  workspaceSnapshotId?: string
}

export function getVerifiedMemoryExcerpts(
  agentState: { memoryV2Context?: unknown } | null | undefined,
  options?: { limit?: number; maxCharsPerExcerpt?: number },
): VerifiedExcerpt[] {
  const excerpts: VerifiedExcerpt[] = []
  try {
    if (!agentState || typeof agentState !== 'object') return excerpts
    const memoryV2Context = (
      agentState as { memoryV2Context?: unknown }
    ).memoryV2Context
    if (!memoryV2Context || typeof memoryV2Context !== 'object')
      return excerpts
    const contextRecord = memoryV2Context as Record<string, unknown>
    const resultRecord =
      contextRecord['result'] && typeof contextRecord['result'] === 'object'
        ? (contextRecord['result'] as Record<string, unknown>)
        : undefined
    const rawVerifiedKnowledge = resultRecord?.['verifiedKnowledge']
    const verifiedKnowledge = Array.isArray(rawVerifiedKnowledge)
      ? rawVerifiedKnowledge
      : Array.isArray(contextRecord['verifiedKnowledge'])
        ? (contextRecord['verifiedKnowledge'] as unknown[])
        : undefined
    if (!verifiedKnowledge) return excerpts
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 32)
    const maxChars = Math.min(
      Math.max(options?.maxCharsPerExcerpt ?? 1_000, 100),
      4_000,
    )
    for (const entry of verifiedKnowledge) {
      if (excerpts.length >= limit) break
      if (!entry || typeof entry !== 'object') continue
      const entryRecord = entry as Record<string, unknown>
      const verifiedEvidence = entryRecord['verifiedEvidence']
      if (!Array.isArray(verifiedEvidence)) continue
      for (const evidence of verifiedEvidence) {
        if (excerpts.length >= limit) break
        if (!evidence || typeof evidence !== 'object') continue
        const evidenceRecord = evidence as Record<string, unknown>
        const selector = evidenceRecord['selector']
        if (!selector || typeof selector !== 'object') continue
        const selectorRecord = selector as Record<string, unknown>
        const rawPath = selectorRecord['path']
        if (typeof rawPath !== 'string' || rawPath.length === 0) continue
        let normalized = ''
        try {
          normalized = normalizePath(rawPath)
        } catch {
          continue
        }
        if (!normalized) continue
        const rawChunkId = selectorRecord['chunkId']
        const chunkId =
          typeof rawChunkId === 'string' && rawChunkId.length > 0
            ? rawChunkId.slice(0, 128)
            : undefined
        const rawExcerpt = evidenceRecord['excerpt']
        const excerpt =
          typeof rawExcerpt === 'string' && rawExcerpt.length > 0
            ? rawExcerpt.slice(0, maxChars)
            : undefined
        const rawDigest = evidenceRecord['contentDigest']
        const contentDigest =
          typeof rawDigest === 'string' && rawDigest.length > 0
            ? rawDigest.slice(0, 256)
            : undefined
        let workspaceRevision: number | undefined
        let workspaceSnapshotId: string | undefined
        try {
          const directRevision = evidenceRecord['workspaceRevision']
          if (
            typeof directRevision === 'number' &&
            Number.isInteger(directRevision) &&
            directRevision >= 0
          ) {
            workspaceRevision = directRevision
          } else {
            const entryRevision = entryRecord['workspaceRevision']
            if (
              typeof entryRevision === 'number' &&
              Number.isInteger(entryRevision) &&
              entryRevision >= 0
            ) {
              workspaceRevision = entryRevision
            } else {
              const provenance = evidenceRecord['provenance']
              if (provenance && typeof provenance === 'object') {
                const metadata = (provenance as Record<string, unknown>)[
                  'metadata'
                ]
                if (metadata && typeof metadata === 'object') {
                  const metaRevision = (metadata as Record<string, unknown>)[
                    'workspaceRevision'
                  ]
                  if (
                    typeof metaRevision === 'number' &&
                    Number.isInteger(metaRevision) &&
                    metaRevision >= 0
                  ) {
                    workspaceRevision = metaRevision
                  }
                }
              }
            }
          }
          const directSnapshot = evidenceRecord['workspaceSnapshotId']
          if (
            typeof directSnapshot === 'string' &&
            directSnapshot.length > 0
          ) {
            workspaceSnapshotId = directSnapshot.slice(0, 256)
          } else {
            const entrySnapshot = entryRecord['workspaceSnapshotId']
            if (typeof entrySnapshot === 'string' && entrySnapshot.length > 0) {
              workspaceSnapshotId = entrySnapshot.slice(0, 256)
            }
          }
        } catch {
          // Best-effort revision/snapshot extraction only.
        }
        excerpts.push({
          path: normalized,
          ...(chunkId ? { chunkId } : {}),
          ...(excerpt ? { excerpt } : {}),
          ...(contentDigest ? { contentDigest } : {}),
          ...(workspaceRevision !== undefined ? { workspaceRevision } : {}),
          ...(workspaceSnapshotId ? { workspaceSnapshotId } : {}),
        })
      }
    }
    return excerpts
  } catch {
    return excerpts
  }
}

export function getVerifiedMemoryPaths(
  agentState: { memoryV2Context?: unknown } | null | undefined,
): Set<string> {
  const verified = new Set<string>()
  try {
    if (!agentState || typeof agentState !== 'object') return verified
    const memoryV2Context = (
      agentState as { memoryV2Context?: unknown }
    ).memoryV2Context
    if (!memoryV2Context || typeof memoryV2Context !== 'object')
      return verified
    const contextRecord = memoryV2Context as Record<string, unknown>
    const resultRecord =
      contextRecord['result'] && typeof contextRecord['result'] === 'object'
        ? (contextRecord['result'] as Record<string, unknown>)
        : undefined
    const rawVerifiedKnowledge = resultRecord?.['verifiedKnowledge']
    const verifiedKnowledge = Array.isArray(rawVerifiedKnowledge)
      ? rawVerifiedKnowledge
      : Array.isArray(contextRecord['verifiedKnowledge'])
        ? (contextRecord['verifiedKnowledge'] as unknown[])
        : undefined
    if (!verifiedKnowledge) return verified
    for (const entry of verifiedKnowledge) {
      const verifiedEvidence = (entry as { verifiedEvidence?: unknown })
        ?.verifiedEvidence
      if (!Array.isArray(verifiedEvidence)) continue
      for (const evidence of verifiedEvidence) {
        const selector = (evidence as { selector?: unknown })?.selector as
          | { path?: unknown }
          | undefined
        if (!selector || typeof selector !== 'object') continue
        const selectorPath = (selector as { path?: unknown }).path
        if (typeof selectorPath !== 'string' || selectorPath.length === 0)
          continue
        try {
          const normalized = normalizePath(selectorPath)
          if (normalized) verified.add(normalized)
        } catch {
          continue
        }
      }
    }
    return verified
  } catch {
    return verified
  }
}

function deriveCoveredDomains(
  candidates: Array<{ path: string; verified?: boolean; stale?: boolean }>,
  existing?: unknown,
): string[] {
  try {
    const existingDomains = Array.isArray(existing)
      ? (existing as unknown[])
          .filter(
            (domain): domain is string =>
              typeof domain === 'string' && domain.trim().length > 0,
          )
          .slice(0, 64)
      : []
    const derived = new Set<string>()
    for (const candidate of candidates) {
      try {
        if (!candidate || typeof candidate.path !== 'string') continue
        if (candidate.verified !== true || candidate.stale === true) continue
        const normalized = normalizePath(candidate.path)
        if (!normalized) continue
        const slash = normalized.indexOf('/')
        const domain = slash > 0 ? normalized.slice(0, slash) : normalized
        if (domain && domain.length < 200) derived.add(domain)
        if (derived.size >= 32) break
      } catch {
        continue
      }
    }
    return [...new Set([...existingDomains, ...derived])].slice(0, 64)
  } catch {
    return Array.isArray(existing) ? (existing as string[]) : []
  }
}

export function planDiscoveryBatch(params: {
  existing?: DiscoveryCoverageV1
  query: string
  result: unknown
  workspaceRevision?: number
  workspaceSnapshotId?: string
  indexSnapshotId?: string
  verifiedPaths?: Set<string> | string[]
}): DiscoveryCoverageV1 {
  const queryHash = hash(
    params.query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim(),
  )
  const extracted = extractCandidates(params.result)
  const workspaceChanged =
    params.existing !== undefined &&
    params.workspaceRevision !== undefined &&
    params.existing.workspaceRevision !== params.workspaceRevision
  const previousByPath = new Map<
    string,
    DiscoveryCoverageV1['candidates'][number]
  >(
    (params.existing?.candidates ?? []).map((candidate) => {
      return [
        candidate.path,
        workspaceChanged ? { ...candidate, stale: true } : candidate,
      ] as const
    }),
  )
  let verifiedSet: Set<string> | undefined
  if (params.verifiedPaths) {
    try {
      verifiedSet = new Set<string>()
      for (const raw of params.verifiedPaths) {
        if (typeof raw !== 'string') continue
        try {
          const normalized = normalizePath(raw)
          if (normalized) verifiedSet.add(normalized)
        } catch {
          continue
        }
      }
    } catch {
      verifiedSet = undefined
    }
  }
  const extractedSymbols = extractCandidateSymbols(params.result)
  for (const [path, reasons] of extracted) {
    const previous = previousByPath.get(path)
    let symbols: string[] = previous?.symbols ?? []
    try {
      const fresh = extractedSymbols.get(path)
      if (fresh && fresh.length > 0) {
        const merged = [...symbols]
        for (const symbol of fresh) {
          if (
            typeof symbol !== 'string' ||
            symbol.length === 0 ||
            symbol.length > 200
          )
            continue
          if (!merged.includes(symbol)) merged.push(symbol)
          if (merged.length >= 32) break
        }
        symbols = merged.slice(0, 32)
      }
    } catch {
      symbols = previous?.symbols ?? []
    }
    previousByPath.set(path, {
      path,
      symbols,
      reasons: [...new Set([...(previous?.reasons ?? []), ...reasons])],
      verified:
        verifiedSet?.has(path) === true ? true : (previous?.verified ?? false),
      stale: false,
      workspaceRevision: params.workspaceRevision,
    })
  }
  const mergedCandidates = [...previousByPath.values()]
  let coveredDomains: string[] = params.existing?.coveredDomains ?? []
  try {
    const derived = deriveCoveredDomains(
      mergedCandidates,
      params.existing?.coveredDomains,
    )
    if (Array.isArray(derived)) coveredDomains = derived
  } catch {
    coveredDomains = params.existing?.coveredDomains ?? []
  }
  return discoveryCoverageV1Schema.parse({
    schemaVersion: 1,
    revision: (params.existing?.revision ?? -1) + 1,
    workspaceRevision: params.workspaceRevision,
    queryHash,
    indexSnapshotId:
      params.indexSnapshotId ?? params.existing?.indexSnapshotId,
    workspaceSnapshotId: params.workspaceSnapshotId,
    candidates: mergedCandidates.slice(-512),
    shards: params.existing?.shards ?? [],
    coveredDomains,
    unresolvedGaps: mergedCandidates
      .filter((candidate) => !candidate.verified || candidate.stale)
      .map((candidate) => candidate.path)
      .slice(0, 128),
  })
}

function normalizeQuestion(question: string): string {
  const stop = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'to',
    'of',
    'for',
    'in',
    'on',
    'please',
    'find',
    'search',
    'read',
  ])
  return question
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((token) => token && !stop.has(token))
    .sort()
    .join(' ')
}

export function claimDiscoveryShard(params: {
  existing?: DiscoveryCoverageV1
  agentType: string
  question: string
  workspaceRevision?: number
  taskId?: string
  workspaceSnapshotId?: string
}): { state: DiscoveryCoverageV1; shardKey: string } {
  const question =
    params.question.trim() ||
    `${params.agentType.trim() || 'unknown-agent'} discovery`
  const existing =
    params.existing ??
    planDiscoveryBatch({
      query: question,
      result: [],
      workspaceRevision: params.workspaceRevision,
    })
  const shardKey = hash(
    `${params.agentType}:${normalizeQuestion(question)}:${params.workspaceRevision ?? 'unknown'}:${params.taskId ?? 'no-task'}`,
  )
  const duplicate = existing.shards.find(
    (shard) =>
      shard.key === shardKey &&
      (shard.status === 'active' || (
        shard.status === 'completed' &&
        shard.taskId === params.taskId &&
        (!params.workspaceSnapshotId || !existing.workspaceSnapshotId || params.workspaceSnapshotId === existing.workspaceSnapshotId)
      )),
  )
  if (duplicate) {
    throw new Error(
      `Duplicate discovery shard ${shardKey} is already ${duplicate.status}. Consume the existing discovery receipt instead of respawning it.`,
    )
  }
  const state = discoveryCoverageV1Schema.parse({
    ...existing,
    revision: existing.revision + 1,
    workspaceSnapshotId: params.workspaceSnapshotId ?? existing.workspaceSnapshotId,
    shards: [
      ...existing.shards,
      {
        key: shardKey,
        agentType: params.agentType,
        question,
        taskId: params.taskId,
        status: 'active',
        assignedAt: Date.now(),
      },
    ].slice(-256),
  })
  return { state, shardKey }
}

function computeDiscoveryShardKey(params: {
  agentType: string
  question: string
  workspaceRevision?: number
  taskId?: string
}): string {
  const question =
    params.question.trim() ||
    `${params.agentType.trim() || 'unknown-agent'} discovery`
  return hash(
    `${params.agentType}:${normalizeQuestion(question)}:${params.workspaceRevision ?? 'unknown'}:${params.taskId ?? 'no-task'}`,
  )
}

export type MemoryCoverDecision = 'skip' | 'narrow' | 'full'

export type MemoryCoverEvaluation = {
  decision: MemoryCoverDecision
  coveringExcerpts: VerifiedExcerpt[]
  remainingGaps: string[]
  reason?: string
}

/**
 * Best-effort memory-first cover check. Never throws: any unexpected input
 * falls through to `{ decision: 'full' }` so callers proceed with a full read.
 *
 * Freshness requires the same workspace revision/snapshot when both sides
 * carry one; a missing revision on either side is treated as usable (it cannot
 * be proven stale). Index-snapshot mismatch is stale when both sides carry one.
 */
export function evaluateMemoryCover(params: {
  excerpts?: VerifiedExcerpt[] | null
  pathPrefixes?: string[] | null
  query?: string | null
  unresolvedGaps?: string[] | null
  workspaceRevision?: number
  workspaceSnapshotId?: string
  indexSnapshotId?: string
  existingIndexSnapshotId?: string
}): MemoryCoverEvaluation {
  try {
    if (
      params.indexSnapshotId &&
      params.existingIndexSnapshotId &&
      params.indexSnapshotId !== params.existingIndexSnapshotId
    ) {
      return {
        decision: 'full',
        coveringExcerpts: [],
        remainingGaps: [],
        reason: 'stale-index-snapshot',
      }
    }
    const rawExcerpts = Array.isArray(params.excerpts) ? params.excerpts : []
    const fresh: VerifiedExcerpt[] = []
    for (const entry of rawExcerpts) {
      try {
        if (!entry || typeof entry !== 'object') continue
        const record = entry as VerifiedExcerpt
        if (typeof record.path !== 'string' || record.path.length === 0)
          continue
        let normalized = ''
        try {
          normalized = normalizePath(record.path)
        } catch {
          continue
        }
        if (!normalized) continue
        if (
          typeof params.workspaceRevision === 'number' &&
          typeof record.workspaceRevision === 'number' &&
          record.workspaceRevision !== params.workspaceRevision
        ) {
          continue
        }
        if (
          params.workspaceSnapshotId &&
          record.workspaceSnapshotId &&
          record.workspaceSnapshotId !== params.workspaceSnapshotId
        ) {
          continue
        }
        fresh.push({ ...record, path: normalized })
        if (fresh.length >= 32) break
      } catch {
        continue
      }
    }
    if (fresh.length === 0) {
      return {
        decision: 'full',
        coveringExcerpts: [],
        remainingGaps: [],
        reason: 'missing-cover',
      }
    }
    const normalizeList = (list: unknown, cap: number): string[] => {
      if (!Array.isArray(list)) return []
      const out: string[] = []
      for (const raw of list) {
        if (typeof raw !== 'string') continue
        try {
          const normalized = normalizePath(raw)
          if (!normalized) continue
          if (!out.includes(normalized)) out.push(normalized)
          if (out.length >= cap) break
        } catch {
          continue
        }
      }
      return out
    }
    const prefixes = normalizeList(params.pathPrefixes, 64)
    const gaps = normalizeList(params.unresolvedGaps, 128)
    const queryTokens: string[] = []
    try {
      if (typeof params.query === 'string' && params.query.trim().length > 0) {
        const parts = params.query.split(/[\s,;|]+/).slice(0, 128)
        for (const part of parts) {
          try {
            const cleaned = part
              .replace(/^[(\["']+|[)\]"'.,;:!?]+$/g, '')
              .trim()
            if (!cleaned) continue
            const withoutLine = cleaned.replace(/:\d+(?::\d+)?$/, '')
            const normalized = normalizePath(withoutLine)
            if (!normalized || !looksLikePath(normalized)) continue
            if (
              !queryTokens.includes(normalized) &&
              !prefixes.includes(normalized) &&
              !gaps.includes(normalized)
            ) {
              queryTokens.push(normalized)
            }
            if (queryTokens.length >= 32) break
          } catch {
            continue
          }
        }
      }
    } catch {
      // Best-effort query token extraction only.
    }
    let targets: string[] = []
    if (prefixes.length > 0) {
      targets = [...prefixes, ...queryTokens].slice(0, 128)
    } else if (gaps.length > 0) {
      targets = [...gaps, ...queryTokens].slice(0, 128)
    } else if (queryTokens.length > 0) {
      targets = [...queryTokens].slice(0, 128)
    } else {
      return {
        decision: 'full',
        coveringExcerpts: [],
        remainingGaps: [],
        reason: 'no-scope',
      }
    }
    const coveredPaths = new Set(fresh.map((entry) => entry.path))
    const covers = (target: string): boolean => {
      if (coveredPaths.has(target)) return true
      const withSlash = target.endsWith('/') ? target : `${target}/`
      for (const covered of coveredPaths) {
        if (covered === target || covered.startsWith(withSlash)) return true
      }
      return false
    }
    const coveredTargets = targets.filter((target) => covers(target))
    const uncovered = targets.filter((target) => !covers(target))
    const covering = fresh
      .filter((entry) => {
        for (const target of targets) {
          const withSlash = target.endsWith('/') ? target : `${target}/`
          if (entry.path === target || entry.path.startsWith(withSlash))
            return true
        }
        return false
      })
      .slice(0, 32)
    if (uncovered.length === 0 && coveredTargets.length > 0) {
      return {
        decision: 'skip',
        coveringExcerpts: covering,
        remainingGaps: [],
        reason: 'full-cover',
      }
    }
    if (coveredTargets.length > 0) {
      return {
        decision: 'narrow',
        coveringExcerpts: covering,
        remainingGaps: uncovered.slice(0, 128),
        reason: 'partial-cover',
      }
    }
    return {
      decision: 'full',
      coveringExcerpts: [],
      remainingGaps: targets.slice(0, 128),
      reason: 'no-cover',
    }
  } catch {
    return {
      decision: 'full',
      coveringExcerpts: [],
      remainingGaps: [],
      reason: 'error',
    }
  }
}

/**
 * Non-throwing shard claim for new call sites. Keeps
 * {@link claimDiscoveryShard} throw semantics untouched: a duplicate claim
 * returns the existing state unchanged with `duplicate: true` instead of
 * throwing, so batch callers can serve the existing receipt.
 */
export function tryClaimDiscoveryShard(params: {
  existing?: DiscoveryCoverageV1
  agentType: string
  question: string
  workspaceRevision?: number
  taskId?: string
  workspaceSnapshotId?: string
}): {
  state: DiscoveryCoverageV1
  shardKey: string
  duplicate: boolean
} {
  try {
    const claimed = claimDiscoveryShard(params)
    return { state: claimed.state, shardKey: claimed.shardKey, duplicate: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('Duplicate discovery shard')) throw error
    const shardKey = computeDiscoveryShardKey({
      agentType: params.agentType,
      question: params.question,
      workspaceRevision: params.workspaceRevision,
      taskId: params.taskId,
    })
    const fallback =
      params.existing ??
      planDiscoveryBatch({
        query: params.question,
        result: [],
        workspaceRevision: params.workspaceRevision,
      })
    return { state: fallback, shardKey, duplicate: true }
  }
}

export function completeDiscoveryShard(params: {
  existing?: DiscoveryCoverageV1
  shardKey?: string
  status: 'completed' | 'failed' | 'interrupted'
}): DiscoveryCoverageV1 | undefined {
  if (!params.existing || !params.shardKey) return params.existing
  return discoveryCoverageV1Schema.parse({
    ...params.existing,
    revision: params.existing.revision + 1,
    shards: params.existing.shards.map((shard) =>
      shard.key === params.shardKey
        ? { ...shard, status: params.status, completedAt: Date.now() }
        : shard,
    ),
  })
}

/**
 * Extract candidates from a completed discovery agent's output and merge them
 * into the parent's discovery coverage via {@link planDiscoveryBatch}.
 */
export function recordDiscoveryResult(params: {
  existing?: DiscoveryCoverageV1
  agentType: string
  question: string
  result: unknown
  workspaceRevision?: number
  workspaceSnapshotId?: string
  verifiedPaths?: Set<string> | string[]
}): DiscoveryCoverageV1 {
  return planDiscoveryBatch({
    existing: params.existing,
    query: params.question,
    result: params.result,
    workspaceRevision: params.workspaceRevision,
    workspaceSnapshotId: params.workspaceSnapshotId,
    verifiedPaths: params.verifiedPaths,
  })
}

/**
 * Settle discovery shards left `active` by a spawn that never recorded a
 * terminal receipt (an interrupted or unsettled turn). Shard claims are durable
 * parent state, so without this an `active` shard would make
 * {@link claimDiscoveryShard} throw for that question forever — and that throw
 * fails the whole spawn batch. An `interrupted` shard is reclaimable, exactly
 * like a `failed` one, so the next turn can legitimately re-ask the question.
 *
 * Call ONLY at run entry, where no spawn of the current run is in flight yet:
 * an `active` shard observed there necessarily belongs to a previous,
 * interrupted turn. Idempotent — a reconciled shard is no longer `active`, and
 * a state with nothing to reconcile is returned unchanged (same reference, no
 * revision churn).
 */
export function reconcileInterruptedDiscoveryShards(
  existing?: DiscoveryCoverageV1,
): DiscoveryCoverageV1 | undefined {
  const hasActiveShard = existing?.shards.some(
    (shard) => shard.status === 'active',
  )
  if (!existing || !hasActiveShard) return existing
  const completedAt = Date.now()
  return discoveryCoverageV1Schema.parse({
    ...existing,
    revision: existing.revision + 1,
    shards: existing.shards.map((shard) =>
      shard.status === 'active'
        ? { ...shard, status: 'interrupted', completedAt }
        : shard,
    ),
  })
}
