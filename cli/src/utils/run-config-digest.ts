/**
 * Log-safe size digest for the SDK run config. The config carries per-run
 * transcript state (the previous run state, agent definitions, and streaming
 * closures), so log call sites emit per-top-level-field byte lengths instead
 * of serializing the config — transcript-bearing bodies are only ever
 * measured, never logged.
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
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined
      ? undefined
      : Buffer.byteLength(serialized, 'utf8')
  } catch {
    // A circular or otherwise unserializable body is deliberately worth
    // zero log bytes: printing it would defeat the purpose of a size digest.
    return undefined
  }
}

/**
 * Per-top-level-field byte-length digest of a run config: each key maps to
 * the serialized byte length of its value (UTF-8 byteLength for strings,
 * JSON byte length for structured values). Functions, symbols, and absent
 * values are skipped. Never includes any field's body content.
 */
export function describeRunConfigForLog(
  runConfig: unknown,
): RunConfigSizeDigest {
  if (runConfig === null || typeof runConfig !== 'object' ||
      Array.isArray(runConfig)) {
    return {}
  }
  const digest: RunConfigSizeDigest = {}
  for (const [key, value] of Object.entries(runConfig)) {
    if (value === undefined || typeof value === 'function' ||
        typeof value === 'symbol') {
      continue
    }
    const bytes = measureValue(value)
    if (bytes === undefined) continue
    digest[key] = bytes
  }
  return digest
}
