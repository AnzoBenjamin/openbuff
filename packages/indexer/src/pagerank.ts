/**
 * P3-T9: personalized PageRank over the index code graph. Pure, deterministic
 * power iteration — stable iteration order (sorted node ids), no randomness —
 * with bounded work (maxIterations x edges, node-count cap) so it is safe to
 * run per query on large repositories. No dependencies.
 */

import type { MetadataIndex } from './types'

/** Sparse outgoing link: `to` is the target node id, `weight` defaults to 1. */
export interface PageRankEdge {
  to: string
  weight?: number
}

export interface PersonalizedPageRankParams {
  /** nodeId -> outgoing edges. Nodes known only as edge targets are valid. */
  adjacency: ReadonlyMap<string, readonly PageRankEdge[]>
  /**
   * Personalization/seed vector (nodeId -> importance). Unknown node ids are
   * ignored; when no usable (finite, positive) seed mass remains, a uniform
   * vector over every node is used so scores still sum to 1.
   */
  seeds?: ReadonlyMap<string, number>
  /**
   * Damping factor (probability of following a link). Default: 0.85. Clamped
   * internally to (0, 1) EXCLUSIVE — damping exactly 1 makes the power
   * iteration a fixed point that never converges.
   */
  damping?: number
  /** Power-iteration cap. Default: 50. Clamped internally to [1, 200]. */
  maxIterations?: number
  /**
   * L1 convergence epsilon. Default: 1e-6. Clamped internally to a minimum
   * floor of 1e-12 so pathological inputs cannot loop unboundedly.
   */
  epsilon?: number
}

export const DEFAULT_PAGERANK_DAMPING = 0.85
export const DEFAULT_PAGERANK_MAX_ITERATIONS = 50
export const DEFAULT_PAGERANK_EPSILON = 1e-6
/** Node count above which iteration is skipped entirely (bounded-work guard). */
export const MAX_PAGERANK_NODES = 50_000
/** Hard clamp on the power-iteration cap so callers cannot trigger unbounded loops. */
const MAX_PAGERANK_ITERATIONS = 200
/** Floor on the convergence epsilon so pathological inputs cannot loop forever. */
const MIN_PAGERANK_EPSILON = 1e-12
/**
 * Damping clamp bounds, EXCLUSIVE of 1: damping exactly 1 never converges
 * (the iteration can oscillate as a fixed point), so the clamp keeps strictly
 * inside (0, 1).
 */
const MIN_PAGERANK_DAMPING = 1e-6
const MAX_PAGERANK_DAMPING = 1 - 1e-6

/**
 * Personalized PageRank: scores sum to <= 1 (rank pointed at unknown nodes is
 * dropped), dangling nodes redistribute through the personalization vector,
 * and the returned map contains exactly the adjacency keys in sorted order.
 */
export function personalizedPageRank(
  params: PersonalizedPageRankParams,
): Map<string, number> {
  const { adjacency } = params
  const damping = sanitize(
    params.damping,
    DEFAULT_PAGERANK_DAMPING,
    MIN_PAGERANK_DAMPING,
    MAX_PAGERANK_DAMPING,
  )
  const maxIterations = Math.floor(
    sanitize(
      params.maxIterations,
      DEFAULT_PAGERANK_MAX_ITERATIONS,
      1,
      MAX_PAGERANK_ITERATIONS,
    ),
  )
  const epsilon = sanitize(
    params.epsilon,
    DEFAULT_PAGERANK_EPSILON,
    MIN_PAGERANK_EPSILON,
    Number.POSITIVE_INFINITY,
  )

  if (adjacency.size === 0 || adjacency.size > MAX_PAGERANK_NODES) {
    return new Map()
  }

  // Sorted ids give every iteration a deterministic traversal order.
  const nodeIds = Array.from(adjacency.keys()).sort()
  const nodeCount = nodeIds.length

  const personalization = new Map<string, number>()
  let seedMass = 0
  if (params.seeds) {
    for (const nodeId of nodeIds) {
      const value = params.seeds.get(nodeId) ?? 0
      const mass =
        typeof value === 'number' && Number.isFinite(value) && value > 0
          ? value
          : 0
      if (mass > 0) {
        personalization.set(nodeId, mass)
        seedMass += mass
      }
    }
  }
  if (seedMass > 0) {
    for (const [nodeId, mass] of personalization) {
      personalization.set(nodeId, mass / seedMass)
    }
  } else {
    const uniform = 1 / nodeCount
    for (const nodeId of nodeIds) personalization.set(nodeId, uniform)
  }

  // Normalize outgoing weights per source node once. Nodes with no usable
  // outgoing mass are dangling: their rank flows through the personalization
  // vector, which keeps the score vector normalized on every iteration.
  const transitions = new Map<string, { to: string; share: number }[]>()
  for (const nodeId of nodeIds) {
    const edges = adjacency.get(nodeId) ?? []
    const usable: { to: string; weight: number }[] = []
    let totalWeight = 0
    for (const edge of edges) {
      const weight =
        typeof edge.weight === 'number' &&
        Number.isFinite(edge.weight) &&
        edge.weight > 0
          ? edge.weight
          : 1
      usable.push({ to: edge.to, weight })
      totalWeight += weight
    }
    if (totalWeight > 0) {
      transitions.set(
        nodeId,
        usable.map((edge) => ({ to: edge.to, share: edge.weight / totalWeight })),
      )
    }
  }

  let scores = new Map<string, number>()
  for (const nodeId of nodeIds) {
    scores.set(nodeId, personalization.get(nodeId) ?? 0)
  }

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let danglingMass = 0
    for (const nodeId of nodeIds) {
      if (!transitions.has(nodeId)) danglingMass += scores.get(nodeId) ?? 0
    }

    const next = new Map<string, number>()
    for (const nodeId of nodeIds) {
      next.set(
        nodeId,
        (personalization.get(nodeId) ?? 0) *
          (1 - damping + damping * danglingMass),
      )
    }
    for (const nodeId of nodeIds) {
      const outEdges = transitions.get(nodeId)
      if (!outEdges) continue
      const rank = (scores.get(nodeId) ?? 0) * damping
      if (rank === 0) continue
      for (const edge of outEdges) {
        const target = next.get(edge.to)
        if (target === undefined) continue // rank to unknown nodes is dropped
        next.set(edge.to, target + rank * edge.share)
      }
    }

    let delta = 0
    for (const nodeId of nodeIds) {
      delta += Math.abs((next.get(nodeId) ?? 0) - (scores.get(nodeId) ?? 0))
    }
    scores = next
    if (delta <= epsilon) break
  }

  return scores
}

const pageRankAdjacencyCache = new WeakMap<
  MetadataIndex,
  Map<string, PageRankEdge[]>
>()

/**
 * Directed outgoing adjacency for the index code graph, built once per
 * immutable index object and cached (same WeakMap-per-revision pattern as
 * query.ts's adjacencyCache — IndexManager swaps in a fresh MetadataIndex per
 * rebuild, so a cached entry can never go stale). Every incident node is
 * registered, so pure edge targets participate as (dangling) PageRank nodes.
 */
export function getPageRankAdjacency(
  index: MetadataIndex,
): Map<string, PageRankEdge[]> {
  const cached = pageRankAdjacencyCache.get(index)
  if (cached) return cached

  const adjacency = new Map<string, PageRankEdge[]>()
  const nodeIds = new Set<string>()
  for (const edge of index.graph?.edges ?? []) {
    nodeIds.add(edge.from)
    nodeIds.add(edge.to)
    let outEdges = adjacency.get(edge.from)
    if (!outEdges) {
      outEdges = []
      adjacency.set(edge.from, outEdges)
    }
    outEdges.push({ to: edge.to, weight: edge.weight })
  }
  for (const nodeId of nodeIds) {
    if (!adjacency.has(nodeId)) adjacency.set(nodeId, [])
  }

  pageRankAdjacencyCache.set(index, adjacency)
  return adjacency
}

function sanitize(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
