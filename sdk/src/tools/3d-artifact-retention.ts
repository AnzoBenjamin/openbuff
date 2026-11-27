import path from 'node:path'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

export const MUTATION_RETAINED_ATTEMPT_ARTIFACTS = 8
export const MUTATION_ARTIFACT_PRUNE_MAX_STATS = 64
export const MUTATION_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000
export const MUTATION_PRUNE_STRIDE_EDITS = 8
const MAX_OPERATION_DIRS = 32
const MAX_PROJECTS_PER_FILESYSTEM = 64

type RetentionState = {
  strideTick: number
  operationCursor: number
  lastNames: Map<string, string>
  receiptIds: Set<string>
}

// The adapter owns the state. Each project has independent stride, cursors and
// receipt protection, and repeated tool calls reuse it instead of resetting it.
const states = new WeakMap<CodebuffFileSystem, Map<string, RetentionState>>()

function retentionState(fs: CodebuffFileSystem, root: string): RetentionState {
  const projects = states.get(fs) ?? new Map<string, RetentionState>()
  states.set(fs, projects)
  const state = projects.get(root) ?? {
    strideTick: 0,
    operationCursor: 0,
    lastNames: new Map(),
    receiptIds: new Set(),
  }
  projects.delete(root)
  projects.set(root, state)
  if (projects.size > MAX_PROJECTS_PER_FILESYSTEM)
    projects.delete(projects.keys().next().value!)
  return state
}

/** Retain recent receipts and reclaim older copies with bounded metadata I/O. */
export async function prune3dMutationArtifacts(params: {
  fs: CodebuffFileSystem
  currentOperationDir: string
  attemptId: string
  now?: number
}): Promise<void> {
  const { fs, currentOperationDir, attemptId } = params
  const root = path.dirname(path.dirname(currentOperationDir))
  const state = retentionState(fs, root)
  state.receiptIds.delete(attemptId)
  state.receiptIds.add(attemptId)
  if (state.receiptIds.size > MUTATION_RETAINED_ATTEMPT_ARTIFACTS)
    state.receiptIds.delete(state.receiptIds.values().next().value!)
  if (state.strideTick-- > 0) return
  state.strideTick = MUTATION_PRUNE_STRIDE_EDITS - 1

  const list = async (dir: string): Promise<string[]> => {
    try {
      const entries: unknown = await fs.readdir(dir)
      return Array.isArray(entries) ? entries.map(String).sort() : []
    } catch {
      return []
    }
  }
  try {
    const others = (await list(root))
      .map((name) => path.join(root, name, 'current'))
      .filter((dir) => dir !== currentOperationDir)
    const cursor = state.operationCursor % Math.max(1, others.length)
    state.operationCursor += MAX_OPERATION_DIRS - 1
    const dirs = [
      currentOperationDir,
      ...others.slice(cursor),
      ...others.slice(0, cursor),
    ].slice(0, MAX_OPERATION_DIRS)
    const quota = Math.max(
      1,
      Math.floor(MUTATION_ARTIFACT_PRUNE_MAX_STATS / dirs.length),
    )
    const candidates: Array<{
      dir: string
      entries: string[]
      id: string
      mtimeMs: number
    }> = []
    let statsUsed = 0
    for (const dir of dirs) {
      const entries = await list(dir)
      const names = entries.filter(
        (name) =>
          name.endsWith('.blend') && !state.receiptIds.has(name.slice(0, -6)),
      )
      if (!names.length) {
        state.lastNames.delete(dir)
        continue
      }
      const after = names.findIndex(
        (name) => name > (state.lastNames.get(dir) ?? ''),
      )
      const start = after < 0 ? 0 : after
      for (const name of [
        ...names.slice(start),
        ...names.slice(0, start),
      ].slice(0, quota)) {
        if (statsUsed++ >= MUTATION_ARTIFACT_PRUNE_MAX_STATS) break
        state.lastNames.delete(dir)
        state.lastNames.set(dir, name)
        try {
          const metadata = await fs.stat(path.join(dir, name))
          if (metadata.isFile())
            candidates.push({
              dir,
              entries,
              id: name.slice(0, -6),
              mtimeMs: metadata.mtimeMs,
            })
        } catch {
          /* A raced deletion is already reclaimed. */
        }
      }
    }
    // Keep only the unclaimed slots beside receipts this adapter still protects.
    // Reserving slots first prevents the mtime keep set and receipt keep set
    // from independently retaining twice the intended count.
    const unclaimedSlots =
      MUTATION_RETAINED_ATTEMPT_ARTIFACTS - state.receiptIds.size
    const expiredBefore =
      (params.now ?? Date.now()) - MUTATION_ARTIFACT_RETENTION_MS
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const [index, candidate] of candidates.entries()) {
      if (state.receiptIds.has(candidate.id)) continue
      if (index < unclaimedSlots && candidate.mtimeMs > expiredBefore) continue
      for (const name of candidate.entries) {
        if (!name.startsWith(`${candidate.id}.`)) continue
        await fs.unlink(path.join(candidate.dir, name)).catch(() => {})
      }
    }
    // Empty operation directories need not accumulate cursor metadata forever.
    while (state.lastNames.size > MAX_OPERATION_DIRS * 2)
      state.lastNames.delete(state.lastNames.keys().next().value!)
  } catch {
    /* Cleanup must never turn an applied edit into a failure. */
  }
}
