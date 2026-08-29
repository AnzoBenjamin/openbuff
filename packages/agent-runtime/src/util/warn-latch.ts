/**
 * Generic "report a failure mode once" latch.
 *
 * Lives in the shared runtime util layer rather than next to any one consumer:
 * both the gate-telemetry sink's warn wrapper
 * (`../orchestration/gate-telemetry-sink.ts`) and run-programmatic-step's
 * blank-projectRoot warning key off it, so an unrelated module does not have to
 * depend on the telemetry sink for a latch primitive.
 */

/**
 * One place that defines the "report a failure mode once" policy: `shouldWarn`
 * is true the FIRST time a key is seen and false afterwards, until `clear`
 * re-arms every key.
 *
 * Each owner picks its own key dimension and lifetime. A key dimension that is
 * not inherently bounded must pass `maxKeys` so the latch itself caps its key
 * set; without it the set grows for the latch's lifetime.
 */
export type WarnLatch = {
  shouldWarn: (key: string) => boolean
  clear: () => void
}

/**
 * Fresh, fully armed latch.
 *
 * `maxKeys` bounds how many DISTINCT keys the latch ever reports: past it a
 * fresh key is not reported and is not remembered either, so the key set stays
 * capped even under a caller-controlled key dimension. Omit it only when the key
 * dimension is inherently finite. Already-warned keys are unaffected, since they
 * are latched regardless.
 */
export function createWarnLatch(options?: { maxKeys?: number }): WarnLatch {
  const maxKeys = options?.maxKeys
  const warnedKeys = new Set<string>()
  return {
    shouldWarn: (key: string) => {
      if (warnedKeys.has(key)) return false
      if (maxKeys !== undefined && warnedKeys.size >= maxKeys) return false
      warnedKeys.add(key)
      return true
    },
    clear: () => warnedKeys.clear(),
  }
}
