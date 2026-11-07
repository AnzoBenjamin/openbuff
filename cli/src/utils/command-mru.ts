import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { getProjectDataDir } from '../project-files'

/**
 * Workspace-scoped most-recently-used command ids for the command palette.
 *
 * Repeat workflows dominate CLI usage: the palette's empty-query view puts
 * recently-used commands first (fzf-style history merge) so `/doctor` or
 * `/plan` is one Enter away instead of a scan down an alphabetical list.
 *
 * Persisted as a tiny JSON array under the project data dir, next to the
 * chats/ tree, so recency survives restarts and stays per-project. Every
 * read and write is FAIL-OPEN: a missing/unreadable/corrupt file behaves as
 * "no history" rather than breaking the palette.
 */

const MRU_FILENAME = 'command-mru.json'
const MAX_ENTRIES = 10

let cached: string[] | null = null

function mruPath(): string {
  return path.join(getProjectDataDir(), MRU_FILENAME)
}

function load(): string[] {
  if (cached !== null) return cached
  try {
    const parsed = JSON.parse(readFileSync(mruPath(), 'utf8')) as unknown
    cached = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    cached = []
  }
  return cached!
}

/** Recent command ids, most recent first (bounded). */
export function getRecentCommandIds(): string[] {
  return load().slice(0, MAX_ENTRIES)
}

/** Whether a command id is in the recent set (for accent highlighting). */
export function isRecentCommand(id: string): boolean {
  return load().includes(id)
}

/**
 * Move a command id to the front of the MRU. Best-effort persistence: a
 * failed write keeps the in-memory order for this session.
 */
export function recordCommandUse(id: string): void {
  if (!id.trim()) return
  const next = [id, ...load().filter((entry) => entry !== id)].slice(
    0,
    MAX_ENTRIES,
  )
  cached = next
  try {
    mkdirSync(getProjectDataDir(), { recursive: true })
    writeFileSync(mruPath(), JSON.stringify(next), 'utf8')
  } catch {
    // Fail-open: recency degrades to session-only.
  }
}
