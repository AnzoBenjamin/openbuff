import { decodeJsonObjectString } from '../tools/params/tool/set-output'

/**
 * Hard ceiling on the serialized JSON text accepted in the set_output `data`
 * field. Oversized payloads historically slipped through decoding and vanished
 * downstream as transport-truncated garbage, so oversize is rejected before any
 * decode attempt — with explicit recovery guidance instead of failing silently
 * (M0-T3 sub-agent output durability).
 */
export const MODEL_PAYLOAD_JSON_CHAR_LIMIT = 1_000_000

// WHY THIS MODULE EXISTS (C1 of the json-overhaul): the reviewer-receipt shape
// constants below used to live in common/src/tools/params/tool/set-output.ts,
// but the runtime-side envelope unwrapping (below) needs the same
// receipt-shape concept. Consolidating them here gives both consumers one
// canonical definition; the params file re-imports them verbatim, so their
// values (and the `===`-identity-insensitive use via Set.has/every there)
// are unchanged.

// Reviewer-receipt enum values (mirrors outputSchema in
// agents/reviewer/code-reviewer.ts). The placeholder fill below is gated on
// these values so its coupling to the review receipt shape stays explicit
// instead of firing for any output that happens to reuse the field names.
export const REVIEWER_VERDICT_VALUES = new Set([
  'LOOKS_GOOD',
  'NON_BLOCKING',
  'BLOCKING',
])
export const REVIEWER_COVERAGE_VALUES = new Set(['covered', 'missing', 'n/a'])

export const GATE_CRITICAL_KEYS = [
  'verdict',
  'snapshotFingerprint',
  'reviewedFiles',
] as const

export const ATTESTATION_CORE_KEYS = [
  'schemaVersion',
  'verdict',
  'snapshotFingerprint',
  'reviewedFiles',
  'findings',
  'coverage',
] as const

export const REQUIRED_DIMENSION_KEYS = [
  'correctness',
  'security',
  'tests',
  'apiCompatibility',
  'performance',
] as const

export const TRUNCATION_DIMENSION_PLACEHOLDER =
  'recovered-from-truncated-receipt'

/** A receipt shape: object (non-null, non-array) with string verdict AND string snapshotFingerprint. */
export function isReceiptShape(candidate: unknown): boolean {
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    typeof (candidate as Record<string, unknown>).verdict === 'string' &&
    typeof (candidate as Record<string, unknown>).snapshotFingerprint ===
      'string'
  )
}

/**
 * Content-addressed envelope recovery.
 *
 * WHY (user-corrected 2026-10-19): the previous jsonKey-only unwrap was a
 * narrow patch — models keep inventing envelope key names (jsonKey,
 * jsonValue, output, result, ...), so keying on the FIELD NAME chases the
 * bug forever. The principled rule is CONTENT-based: any object whose value
 * yields a receipt shape (string verdict + snapshotFingerprint) is the
 * receipt, regardless of the field name it traveled under.
 *
 * Applies ONLY when the rawOutput itself carries no verdict/fingerprint
 * keys (i.e. it is an envelope, not a receipt). All decode paths are
 * bounded, try/catch, and fall through to the ORIGINAL output unchanged so
 * the existing malformed-JSON + transport-truncation diagnostics keep
 * applying.
 */
export function unwrapArbitraryEnvelope(
  rawOutput: Record<string, unknown> | undefined,
  opts?: { maxJsonChars?: number },
): Record<string, unknown> | undefined {
  const maxJsonChars = opts?.maxJsonChars ?? MODEL_PAYLOAD_JSON_CHAR_LIMIT
  if (!rawOutput) return rawOutput

  // Fast path: the rawOutput is already a receipt at top level.
  if (isReceiptShape(rawOutput)) return rawOutput
  if ('verdict' in rawOutput || 'snapshotFingerprint' in rawOutput) {
    // Semi-receipt shape (has fingerprint but not verdict, or vice versa) —
    // NOT an envelope, so leave it for schema validation to diagnose.
    return rawOutput
  }

  // 1. Native-object receipt candidate: any value field whose native object
  //    is already receipt-shaped. Returns the receipt itself.
  for (const candidate of Object.values(rawOutput)) {
    if (isReceiptShape(candidate)) {
      return candidate as Record<string, unknown>
    }
  }

  // 2. Stringified receipt candidate: any string-valued field that decodes
  //    (bounded, try/catch) to a receipt-shaped object. Reuses the existing
  //    decoder so fenced-json + truncated-receipt recovery keep applying —
  //    and the field NAME is irrelevant (jsonKey, jsonValue, output,
  //    result, ... are all covered by the same content rule).
  for (const candidate of Object.values(rawOutput)) {
    if (typeof candidate !== 'string' || candidate.length > maxJsonChars) {
      continue
    }
    const decoded = decodeJsonObjectString(candidate)
    if (isReceiptShape(decoded)) {
      return decoded as Record<string, unknown>
    }
  }

  return rawOutput
}
