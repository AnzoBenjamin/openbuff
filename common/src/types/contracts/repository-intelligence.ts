import type { ExecutionActor } from './client'
import type { MemoryTurnContextV2 } from '../memory-v2'
import type {
  MemoryPlaybook,
  ValidationEvidenceContext,
} from '../memory-playbook'
import type { PlaybookApplicabilityContext } from '../../util/playbook-applicability'

export const REPOSITORY_INTELLIGENCE_VERSION = 1 as const

/** Host-authenticated actor identity; relevance never confers tool authority. */
export interface PrepareRepositoryContextRequest {
  actor: ExecutionActor
  agentType: string
  userInputId: string
  query: string
  focusPaths?: string[]
  deadlineMs?: number
  signal?: AbortSignal
}

export interface RepositoryContextPacket {
  schemaVersion: typeof REPOSITORY_INTELLIGENCE_VERSION
  projectId: string
  actor: ExecutionActor
  agentType: string
  userInputId: string
  queryHash: string
  generatedAt: number
  freshness: 'current' | 'unverified' | 'degraded'
  /** Bounded, cited discovery hints. Never instructions or read/edit grants. */
  briefing: string
  knowledge?: MemoryTurnContextV2
  playbooks: MemoryPlaybook[]
  applicability: PlaybookApplicabilityContext
  validationEvidence?: ValidationEvidenceContext
  reasons: string[]
  metrics: {
    indexedCandidates: number
    rememberedFacts: number
    reused: boolean
  }
}

/** A CLI, an embedded SDK, and a native service share this consumer boundary. */
export type PrepareRepositoryContext = (
  request: PrepareRepositoryContextRequest,
) => Promise<RepositoryContextPacket | undefined>

export interface RepositoryDiscoveryResult {
  snapshotId?: string
  freshness: 'current' | 'unverified' | 'degraded'
  candidates: Array<{
    path: string
    indexedHash?: string
    symbols?: string[]
    reasons?: string[]
    relatedFiles?: string[]
    snippets?: string[]
    explanation?: string
  }>
  reasons?: string[]
}

export interface RepositoryIntelligenceSource {
  /** Host-selected source backing; virtual views never attest local command dependencies. */
  locality?: 'local' | 'virtual'
  query(request: {
    query: string
    focusPaths: readonly string[]
    agentType: string
    limit: number
    deadlineMs?: number
    signal?: AbortSignal
  }): Promise<RepositoryDiscoveryResult>
}
