/**
 * Near-match path suggestions for "file does not exist" errors
 * (read-search-12). Pure and bounded: callers supply the candidate paths
 * (a project file tree or a bounded directory walk) and must apply their own
 * read policy to the returned paths before showing them.
 */

export const MAX_PATH_SUGGESTIONS = 3

function toPortable(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function basenameOf(value: string): string {
  const index = value.lastIndexOf('/')
  return index === -1 ? value : value.slice(index + 1)
}

function dirnameOf(value: string): string {
  const index = value.lastIndexOf('/')
  return index === -1 ? '' : value.slice(0, index)
}

/** Levenshtein distance with an early exit once `max` is exceeded. */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      )
      current.push(value)
      if (value < rowMin) rowMin = value
    }
    if (rowMin > max) return max + 1
    previous = current
  }
  return previous[b.length]!
}

/**
 * Rank `candidates` by basename edit distance to `requestedPath`. A candidate
 * qualifies when its basename is within about a third of the requested
 * basename's length (at least 1 edit). Ties prefer the same directory, then
 * the closer full path. Returns at most `limit` distinct paths, never the
 * requested path itself.
 */
export function rankNearPaths(
  requestedPath: string,
  candidates: Iterable<string>,
  limit: number = MAX_PATH_SUGGESTIONS,
): string[] {
  const requested = toPortable(requestedPath)
  const requestedBase = basenameOf(requested).toLowerCase()
  if (!requestedBase) return []
  const requestedDir = dirnameOf(requested).toLowerCase()
  const maxDistance = Math.max(1, Math.floor(requestedBase.length / 3))
  const scored: Array<{
    path: string
    distance: number
    sameDir: number
    full: number
  }> = []
  const seen = new Set<string>()
  for (const raw of candidates) {
    const candidate = toPortable(raw)
    if (!candidate || candidate === requested || seen.has(candidate)) continue
    seen.add(candidate)
    const distance = boundedEditDistance(
      requestedBase,
      basenameOf(candidate).toLowerCase(),
      maxDistance,
    )
    if (distance > maxDistance) continue
    scored.push({
      path: candidate,
      distance,
      sameDir: dirnameOf(candidate).toLowerCase() === requestedDir ? 0 : 1,
      full: boundedEditDistance(
        requested.toLowerCase(),
        candidate.toLowerCase(),
        64,
      ),
    })
  }
  scored.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.sameDir - b.sameDir ||
      a.full - b.full ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  )
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.path)
}
