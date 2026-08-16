import {
  decodeReadCapabilityToken,
  encodeReadCapabilityToken,
  hasAuthoritativeReadCapabilityScope,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'

import { normalizeToolPath } from '../tools/handlers/tool/write-file'

import type {
  AgentState,
  ConfirmedPostEditAnchor,
} from '@codebuff/common/types/session-state'

const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const HOSTILE_ANCHOR_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isWellFormedStoredAnchor(
  value: unknown,
): value is ConfirmedPostEditAnchor {
  if (value === null || typeof value !== 'object') return false
  const anchor = value as Partial<ConfirmedPostEditAnchor>
  return (
    anchor.startLine === 1 &&
    isPositiveInteger(anchor.endLine) &&
    typeof anchor.contentHash === 'string' &&
    CONTENT_HASH_PATTERN.test(anchor.contentHash) &&
    typeof anchor.readCapability === 'string' &&
    anchor.readCapability.length > 0
  )
}

function isSafeAnchorPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false
  if (HOSTILE_ANCHOR_KEYS.has(path)) return false
  // Reject traversal / absolute / non-canonical keys; never assign hostile keys.
  return normalizeToolPath(path) === path
}

/**
 * Remint durable confirmed post-edit anchors only when issuer-bound to the
 * current project/run. cap.v3 is reminted when the stored token authenticates
 * for that scope, or when stamped projectId+runId match (process-restart path).
 * Unauthenticated / cross-scope / malformed / hostile entries are dropped.
 */
export function remintConfirmedPostEditAnchors(params: {
  anchors: Record<string, ConfirmedPostEditAnchor> | undefined
  projectId: string
  runId: string
}): Record<string, ConfirmedPostEditAnchor> {
  const { anchors, projectId, runId } = params
  const result: Record<string, ConfirmedPostEditAnchor> = {}
  if (!anchors) return result

  for (const [path, stored] of Object.entries(anchors)) {
    if (!isSafeAnchorPath(path)) continue
    if (!isWellFormedStoredAnchor(stored)) continue

    const scope = { projectId, path, runId }
    if (!hasAuthoritativeReadCapabilityScope(scope)) continue

    const decoded = decodeReadCapabilityToken(stored.readCapability)
    const tokenAuthenticatesForScope =
      typeof decoded !== 'string' &&
      readCapabilityMatchesScope(decoded, scope) &&
      decoded.startLine === stored.startLine &&
      decoded.endLine === stored.endLine &&
      decoded.hash === stored.contentHash

    const issuerMatchesCurrent =
      typeof stored.projectId === 'string' &&
      stored.projectId.length > 0 &&
      typeof stored.runId === 'string' &&
      stored.runId.length > 0 &&
      stored.projectId === projectId &&
      stored.runId === runId

    // Path 3: live HMAC authenticates for current scope.
    // Path 4: process restart — in-process HMAC dies, but stamped issuer matches.
    if (!tokenAuthenticatesForScope && !issuerMatchesCurrent) continue

    result[path] = {
      startLine: stored.startLine,
      endLine: stored.endLine,
      contentHash: stored.contentHash,
      readCapability: encodeReadCapabilityToken({
        startLine: stored.startLine,
        endLine: stored.endLine,
        hash: stored.contentHash,
        scope,
      }),
      projectId,
      runId,
    }
  }

  return result
}

/**
 * After context compaction removes exact read bodies from model-visible context,
 * record a typed reread reason for telemetry/guidance — but keep sticky whole-file
 * authorizations and hashes. Edit-time `isWholeFileReadAuthorizationFresh` still
 * fails closed when disk content has drifted from the stored hash.
 * Confirmed post-edit anchors are also kept (same durability as sticky hashes).
 */
export function revokeImplicitReadAuthorizationsAfterCompaction(
  agentState: AgentState,
): void {
  const paths = new Set([
    ...Object.keys(agentState.readAuthorizationsByPath ?? {}),
    ...Object.keys(agentState.readAuthorizationHashesByPath ?? {}),
  ])
  if (paths.size === 0) return

  agentState.editRereadRequirementsByPath ??= {}
  for (const path of paths) {
    agentState.editRereadRequirementsByPath[path] = {
      reason: 'context_compacted',
      sourceTool: 'context compaction',
    }
  }
  // Sticky maps and confirmed post-edit anchors intentionally preserved:
  // hash freshness is enforced at edit time.
}
