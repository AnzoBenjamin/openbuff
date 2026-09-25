import path from 'node:path'

import {
  evaluateAuditCoverage,
  inspectCodebaseStructure,
  inspectFeatureCompleteness,
} from '../services/audit-intelligence'
import type {
  AuditCoverageReceipt,
  CodebaseInventory,
  FeatureCompletenessRecord,
} from '../services/audit-intelligence'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { JSONObject } from '../../../common/src/types/json'

const json = (value: JSONObject): [{ type: 'json'; value: JSONObject }] => [
  { type: 'json', value },
]

const inventoryCache = new Map<string, CodebaseInventory>()
const inventoryCacheLimit = 16

function cacheInventory(inventory: CodebaseInventory): void {
  if (inventoryCache.has(inventory.snapshotId)) return
  if (inventoryCache.size >= inventoryCacheLimit) {
    const oldest = inventoryCache.keys().next().value
    if (oldest !== undefined) inventoryCache.delete(oldest)
  }
  inventoryCache.set(inventory.snapshotId, inventory)
}

export function inspectCodebaseStructureTool(
  cwd: string,
  scope?: string[],
): CodebuffToolOutput<'inspect_codebase_structure'> {
  const inventory = inspectCodebaseStructure(cwd, scope)
  cacheInventory(inventory)
  return json(inventory as unknown as JSONObject)
}

export function inspectFeatureCompletenessTool(
  cwd: string,
  input: { feature: string; snapshot_id: string; scope?: string[] },
): CodebuffToolOutput<'inspect_feature_completeness'> {
  // snapshotId hashes only file contents, never the root path, so the same
  // snapshot_id can exist across different (possibly deleted) directories.
  // Treat a cache entry as valid only if it was built for this exact cwd.
  const cachedCandidate = inventoryCache.get(input.snapshot_id)
  const cached =
    cachedCandidate && cachedCandidate.root === path.resolve(cwd)
      ? cachedCandidate
      : undefined
  const inventory = cached ?? inspectCodebaseStructure(cwd, input.scope)
  if (!cached && inventory.snapshotId !== input.snapshot_id)
    return json({
      errorMessage:
        'The codebase snapshot is stale. Re-run inspect_codebase_structure.',
    })
  if (!cached) cacheInventory(inventory)
  const record = inspectFeatureCompleteness(
    inventory.root,
    input.feature,
    inventory,
  )
  const { failureStates, ...evidence } = record.evidence
  return json({
    ...record,
    coverageReceipt: {
      schema_version: 1,
      snapshot_id: inventory.snapshotId,
      feature: record.feature,
      evidence_kind: record.evidenceKind,
      evidence: {
        ...evidence,
        failure_states: failureStates,
      },
    },
  } as unknown as JSONObject)
}

type FeatureReceiptInput = {
  schema_version: 1
  snapshot_id: string
  feature: string
  evidence_kind: 'heuristic' | 'verified'
  evidence: {
    entrypoints: string[]
    implementation: string[]
    consumers: string[]
    tests: string[]
    docs: string[]
    failure_states: string[]
  }
}

export function evaluateAuditCoverageTool(
  cwd: string,
  input: {
    snapshot_id: string
    structural_receipts: Array<{
      schema_version: 1
      snapshot_id: string
      shard_id: string
      subsystem_ids: string[]
      files: string[]
      domains: AuditCoverageReceipt['domains']
    }>
    features: FeatureReceiptInput[]
    out_of_scope?: Array<{ id: string; reason: string }>
    scope?: string[]
  },
): CodebuffToolOutput<'evaluate_audit_coverage'> {
  // snapshotId hashes only file contents, never the root path, so the same
  // snapshot_id can exist across different (possibly deleted) directories.
  // Treat a cache entry as valid only if it was built for this exact cwd.
  const cachedCandidate = inventoryCache.get(input.snapshot_id)
  const cached =
    cachedCandidate && cachedCandidate.root === path.resolve(cwd)
      ? cachedCandidate
      : undefined
  const inventory = cached ?? inspectCodebaseStructure(cwd, input.scope)
  if (!cached && inventory.snapshotId !== input.snapshot_id)
    return json({
      errorMessage:
        'The codebase snapshot is stale. Re-run inspect_codebase_structure.',
    })
  if (!cached) cacheInventory(inventory)
  const structuralReceipts: AuditCoverageReceipt[] =
    input.structural_receipts.map((receipt) => ({
      schemaVersion: receipt.schema_version,
      snapshotId: receipt.snapshot_id,
      shardId: receipt.shard_id,
      subsystemIds: receipt.subsystem_ids,
      files: receipt.files,
      domains: receipt.domains,
    }))
  const featureRecords: FeatureCompletenessRecord[] = input.features.map(
    (receipt) => {
      const evidence = {
        ...receipt.evidence,
        failureStates: receipt.evidence.failure_states,
      }
      const { failure_states: _ignored, ...rest } = evidence
      const normalizedEvidence = rest as FeatureCompletenessRecord['evidence']
      const missing = Object.entries(normalizedEvidence)
        .filter(([, files]) => files.length === 0)
        .map(([name]) => name)
      return {
        feature: receipt.feature,
        evidenceKind: receipt.evidence_kind,
        evidence: normalizedEvidence,
        status: missing.length === 0 ? 'complete' : 'partial',
        missing,
      }
    },
  )
  return json(
    evaluateAuditCoverage({
      inventory,
      structuralReceipts,
      featureRecords,
      outOfScope: input.out_of_scope,
    }) as unknown as JSONObject,
  )
}
