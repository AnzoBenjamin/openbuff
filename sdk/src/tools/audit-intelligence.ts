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
  const key = `${inventory.root}\0${inventory.snapshotId}`
  if (inventoryCache.has(key)) return
  if (inventoryCache.size >= inventoryCacheLimit) {
    const oldest = inventoryCache.keys().next().value
    if (oldest !== undefined) inventoryCache.delete(oldest)
  }
  inventoryCache.set(key, inventory)
}

function attestInventory(
  cwd: string,
  snapshotId: string,
  scope?: string[],
):
  | { inventory: CodebaseInventory }
  | { errorMessage: string; sourceBinding: JSONObject } {
  const cached = inventoryCache.get(`${path.resolve(cwd)}\0${snapshotId}`)
  try {
    const inventory = inspectCodebaseStructure(cwd, scope ?? cached?.scope)
    if (inventory.snapshotId !== snapshotId)
      return {
        errorMessage:
          'The codebase snapshot is stale. Re-run inspect_codebase_structure.',
        sourceBinding: {
          status: 'stale',
          expectedSnapshotId: snapshotId,
          observedSnapshotId: inventory.snapshotId,
        },
      }
    cacheInventory(inventory)
    return { inventory }
  } catch (error) {
    return {
      errorMessage: error instanceof Error ? error.message : String(error),
      sourceBinding: { status: 'unavailable', expectedSnapshotId: snapshotId },
    }
  }
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
  const attestation = attestInventory(cwd, input.snapshot_id, input.scope)
  if ('errorMessage' in attestation) return json(attestation)
  const { inventory } = attestation
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
      maturity: record.maturity,
      status: record.status,
      missing: record.missing,
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
  maturity?: FeatureCompletenessRecord['maturity']
  status?: FeatureCompletenessRecord['status']
  missing?: string[]
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
  const attestation = attestInventory(cwd, input.snapshot_id, input.scope)
  if ('errorMessage' in attestation) return json(attestation)
  const { inventory } = attestation
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
        snapshotId: receipt.snapshot_id,
        evidenceKind: receipt.evidence_kind,
        maturity: receipt.maturity ?? 'unknown',
        evidence: normalizedEvidence,
        status: receipt.status ?? 'unknown',
        missing: receipt.missing ?? missing,
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
