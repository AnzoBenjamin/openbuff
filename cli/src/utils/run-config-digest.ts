/**
 * Log-safe size digest for the SDK run config. The config carries per-run
 * transcript state, so measure scalar bytes and shallow collection counts.
 * Measuring JSON byte lengths would serialize the entire prior session on
 * every send, blocking the TUI even though the body never reaches the log.
 */

export type RunConfigSizeDigest = Record<string, number>

/** Unserializable measurement: the field is reported with no entry rather
 * than logging a body; callers that need a guaranteed entry for every field
 * can branch on `'key' in digest`. */
const measureValue = (value: unknown): number | undefined => {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8')
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).length
  }
  return undefined
}

/**
 * Scalars retain byte lengths; structured fields use Items/Fields suffixes
 * for shallow counts. Never traverses or serializes transcript bodies.
 */
export function describeRunConfigForLog(
  runConfig: unknown,
): RunConfigSizeDigest {
  if (
    runConfig === null ||
    typeof runConfig !== 'object' ||
    Array.isArray(runConfig)
  ) {
    return {}
  }
  const digest: RunConfigSizeDigest = {}
  for (const [key, value] of Object.entries(runConfig)) {
    if (
      value === undefined ||
      typeof value === 'function' ||
      typeof value === 'symbol'
    ) {
      continue
    }
    if (Array.isArray(value)) {
      digest[`${key}Items`] = value.length
      continue
    }
    if (value !== null && typeof value === 'object') {
      digest[`${key}Fields`] = Object.keys(value).length
      continue
    }
    const bytes = measureValue(value)
    if (bytes === undefined) continue
    digest[key] = bytes
  }
  return digest
}
