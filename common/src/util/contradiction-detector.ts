import { createHash } from 'node:crypto'

/**
 * P7 contradiction detection over observation candidates. Pure and
 * deterministic: derives topic keys from stable chunk ids and groups live
 * decision/constraint observations into bounded contradiction candidates.
 * (NO Date.now anywhere in this module.)
 */

export type ContradictionCandidate = {
  observationId: string
  kind: string
  stableChunkIds: string[]
  forgotten: boolean
  superseded: boolean
  corrected: boolean
}

const MAX_OBSERVATIONS_PER_TOPIC = 4
const MAX_TOPICS = 16

const LIVE_KINDS = new Set(['decision', 'constraint'])

const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

const cleanStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === 'string' && item.length > 0,
      )
    : []

/**
 * Derive a stable topic key from stable chunk ids. Returns null when the
 * input is empty after cleanup (non-strings and empty strings are dropped),
 * so topic grouping only happens when a real overlap anchor exists.
 */
export function deriveTopicKey(stableChunkIds: unknown): string | null {
  const ids = [...new Set(cleanStrings(stableChunkIds))].sort(compareCodePoints)
  if (ids.length === 0) return null
  return createHash('sha256')
    .update(ids.join('\u0000'), 'utf8')
    .digest('hex')
}

/**
 * The persisted stableChunkId contract: chunk evidence carries its stable
 * chunk identity in evidence provenance metadata under exactly this key with
 * a value matching STABLE_CHUNK_ID_RE (the same shape the coordinator's
 * capture path accepts). Read-side topic grouping must key on this pair —
 * never on value-shape scans over arbitrary metadata keys, which both
 * overmatch unrelated 64-hex values (e.g. claim-id-like hashes under other
 * keys) and undermatch persisted non-hex stable chunk ids.
 */
export const STABLE_CHUNK_ID_METADATA_KEY = 'stableChunkId'

/**
 * Shape of a stable chunk id as persisted by the capture writer: an
 * alphanumeric-leading id of at most 128 characters drawn from
 * [A-Za-z0-9._:-]. Deliberately not hex-only: synthetic ids such as
 * `lines-12-40` are valid persisted stable chunk ids.
 */
export const STABLE_CHUNK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * Extract the stable chunk id an evidence provenance metadata record carries
 * under the canonical key. Malformed or hostile input yields [] (never a
 * throw); a valid value is returned as a single-element array.
 */
export function extractStableChunkIds(metadata: unknown): string[] {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return []
  }
  const value: unknown = (metadata as Record<string, unknown>)[
    STABLE_CHUNK_ID_METADATA_KEY
  ]
  return typeof value === 'string' && STABLE_CHUNK_ID_RE.test(value)
    ? [value]
    : []
}

/**
 * Group live decision/constraint observations by topic key. A group is a
 * contradiction candidate only when it has at least two members; members are
 * code-point sorted and capped at 4 per topic, topics are code-point sorted
 * by key and capped at 16 total. Deterministic for the same input batch.
 */
export function detectContradictions(params: {
  observations: ContradictionCandidate[]
}): Array<{ topicKey: string; observationIds: string[] }> {
  const groups = new Map<string, string[]>()
  for (const observation of params.observations) {
    const topicKey = deriveTopicKey(observation.stableChunkIds)
    if (topicKey === null) continue
    const live =
      !observation.forgotten &&
      !observation.superseded &&
      !observation.corrected &&
      LIVE_KINDS.has(observation.kind)
    if (!live) continue
    const existing = groups.get(topicKey)
    if (existing) {
      if (!existing.includes(observation.observationId)) {
        existing.push(observation.observationId)
      }
    } else {
      groups.set(topicKey, [observation.observationId])
    }
  }
  const candidates = [...groups.entries()]
    .filter(([, observationIds]) => observationIds.length >= 2)
    .map(([topicKey, observationIds]) => ({
      topicKey,
      observationIds: [...observationIds].sort(compareCodePoints).slice(0, MAX_OBSERVATIONS_PER_TOPIC),
    }))
    .sort((left, right) => compareCodePoints(left.topicKey, right.topicKey))
    .slice(0, MAX_TOPICS)
  return candidates
}

/**
 * Resolve the head of a supersession chain: follow supersededBy edges until
 * a node has no outgoing edge. Cycle- and missing-edge-safe by returning the
 * current node when the chain cannot continue.
 */
export function resolveSupersessionHead(
  observationId: string,
  supersededBy: Map<string, string>,
): string {
  const visited = new Set<string>()
  let current = observationId
  while (supersededBy.has(current)) {
    if (visited.has(current)) return current
    visited.add(current)
    const next = supersededBy.get(current)
    if (next === undefined) return current
    current = next
  }
  return current
}
