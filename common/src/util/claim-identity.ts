import { createHash } from 'node:crypto'

/**
 * Deterministic claim identity derivation for P7 persistent memory. Pure:
 * only node:crypto, no ambient clock, no I/O.
 */

/**
 * Normalize claim text for identity purposes: NFC, trim, whitespace collapse,
 * lowercase. Ordering matters — normalize first so that equivalent unicode
 * sequences collapse identically before whitespace is canonicalized.
 */
export function normalizeClaimText(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Derive a stable claim id from kind, normalized text, and evidence paths.
 * Evidence order is irrelevant (deduped + code-point sorted) so the same
 * logical claim always yields the same id regardless of discovery order.
 */
export function deriveClaimId(params: {
  kind: string
  text: string
  evidencePaths?: string[]
}): string {
  const evidence = [...new Set(params.evidencePaths ?? [])]
    .sort((left, right) => {
      const leftPoints = Array.from(left, (character) =>
        character.codePointAt(0)!,
      )
      const rightPoints = Array.from(right, (character) =>
        character.codePointAt(0)!,
      )
      const length = Math.min(leftPoints.length, rightPoints.length)
      for (let index = 0; index < length; index++) {
        const difference = leftPoints[index]! - rightPoints[index]!
        if (difference !== 0) return difference
      }
      return leftPoints.length - rightPoints.length
    })
    .join('\u0000')
  return createHash('sha256')
    .update(
      ['claim-id', 'v1', params.kind, normalizeClaimText(params.text), evidence].join(
        '\u0000',
      ),
      'utf8',
    )
    .digest('hex')
}
