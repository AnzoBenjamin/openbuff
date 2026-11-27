import { LRUCache } from '@codebuff/common/util/lru-cache'
const statsCache = new LRUCache<string, { added: number; removed: number }>(32)

/** Count captured change rows; headers require a pair outside an unfinished hunk. */
export function countCapturedDiffChanges(diff: string): {
  added: number
  removed: number
} {
  const cached = statsCache.get(diff)
  if (cached) return cached
  const lines = diff.split('\n')
  let added = 0,
    removed = 0,
    oldRemaining = 0,
    newRemaining = 0,
    inHunk = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const hunk = /^@@\s+-\d+(?:,(\d+))?\s+\+\d+(?:,(\d+))?\s+@@/.exec(line)
    if (hunk) {
      oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1])
      newRemaining = hunk[2] === undefined ? 1 : Number(hunk[2])
      inHunk = true
      continue
    }
    if (
      (!inHunk || (oldRemaining <= 0 && newRemaining <= 0)) &&
      /^---\s+(?:a\/|\/dev\/null)/.test(line) &&
      /^\+\+\+\s+(?:b\/|\/dev\/null)/.test(lines[index + 1] ?? '')
    ) {
      index++
      inHunk = false
      continue
    }
    if (line.startsWith('+')) {
      added++
      newRemaining--
    } else if (line.startsWith('-')) {
      removed++
      oldRemaining--
    } else if (line.startsWith(' ')) {
      oldRemaining--
      newRemaining--
    }
  }
  const stats = Object.freeze({ added, removed })
  statsCache.set(diff, stats)
  return stats
}
