import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as nodeFsPromises from 'node:fs/promises'
import path from 'node:path'

import {
  TASK_MEMORY_LIST_CAPS,
  taskMemoryDraftV1Schema,
  taskMemoryV1Schema,
} from '@codebuff/common/types/task-memory'
import { stableHash } from '@codebuff/common/util/stable-hash'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type {
  TaskMemoryEvidenceV1,
  TaskMemoryV1,
} from '@codebuff/common/types/task-memory'

export interface WorkspaceMoveRecord {
  from: string
  to: string
}

type FsModule = typeof nodeFsPromises

/**
 * The exact `node:fs/promises` subset this store consumes. Adapters built by
 * {@link codebuffFsToNodePromises} guarantee only these members, so exposing
 * them as the full `FsModule` would let callers invoke anything else (e.g.
 * `copyFile`) and hit a silent runtime `undefined` instead of a compile
 * error.
 */
export interface TaskMemoryStoreFs {
  mkdir(
    path: Parameters<FsModule['mkdir']>[0],
    options?: Parameters<FsModule['mkdir']>[1],
  ): Promise<void>
  readFile(file: Parameters<FsModule['readFile']>[0]): Promise<Buffer>
  /**
   * Partial-read primitive; exposing it enables streamed hashing of
   * oversized evidence files. Stores without it never buffer past
   * MAX_EVIDENCE_HASH_BYTES: hashFile treats an oversized target as
   * unverifiable (stale) rather than reading it whole.
   */
  open?: FsModule['open']
  rename(
    oldPath: Parameters<FsModule['rename']>[0],
    newPath: Parameters<FsModule['rename']>[1],
  ): Promise<void>
  stat(path: Parameters<FsModule['stat']>[0]): Promise<Stats>
  unlink(path: Parameters<FsModule['unlink']>[0]): Promise<void>
  writeFile(
    file: Parameters<FsModule['writeFile']>[0],
    data: Parameters<FsModule['writeFile']>[1],
    options?: Parameters<FsModule['writeFile']>[2],
  ): Promise<void>
}

function getMemoryFilePath(rootDir: string): string {
  return path.join(rootDir, '.openbuff', 'memory', 'task-memory.json')
}

// Canonical caps exported from @codebuff/common alongside
// taskMemoryDraftV1Schema — the single source of truth, so the store
// cannot drift from the schema's enforced limits.
const LIST_CAPS = TASK_MEMORY_LIST_CAPS

function truncateToCap<T>(values: T[], cap: number): T[] {
  return values.length > cap ? values.slice(-cap) : values
}

/**
 * Upper bound for hashing a single evidence target during reconciliation
 * (same spirit as MAX_DISCOVERED_PROJECT_READ_BYTES in run-state.ts).
 * Freshness digests only need a stable prefix; capping bounds memory and
 * cold-cache read cost per evidence item. Known trade-off: mutations beyond
 * the cap do not flip staleness.
 */
const MAX_EVIDENCE_HASH_BYTES = 1_000_000

/** Evidence reads processed per Promise.all batch during reconciliation. */
const EVIDENCE_HASH_CONCURRENCY = 16

/**
 * Load and schema-validate the persisted task memory for a project root,
 * re-verifying the stored checksum against the loaded payload. Missing,
 * corrupt, or checksum-mismatched data yields undefined; never throws.
 */
export async function loadPersistedTaskMemory(params: {
  rootDir: string
  fs?: TaskMemoryStoreFs
}): Promise<TaskMemoryV1 | undefined> {
  const fs = params.fs ?? nodeFsPromises
  try {
    const raw = await fs.readFile(getMemoryFilePath(params.rootDir))
    const parsed = taskMemoryV1Schema.safeParse(
      JSON.parse(raw.toString('utf8')),
    )
    if (!parsed.success) return undefined
    // A corrupted-but-schema-valid file must not hydrate silently: recompute
    // the checksum over the same draft-shaped payload saveMergedTaskMemory
    // hashed (memory WITHOUT the revision/updatedAt/checksum envelope) and
    // reject mismatches.
    //
    // Compatibility: records written before checksum enforcement are also
    // rejected here (fail-closed). No pre-checksum format was ever deployed
    // — this store shipped alongside enforcement — so tolerate-and-upgrade
    // would only weaken the corruption guard above. Revisit only if a
    // deployed legacy format ever materializes.
    const parsedDraft = taskMemoryDraftV1Schema.safeParse(parsed.data)
    if (!parsedDraft.success) return undefined
    const expectedChecksum = stableHash(
      JSON.stringify({
        revision: parsed.data.revision,
        updatedAt: parsed.data.updatedAt,
        memory: parsedDraft.data,
      }),
    )
    if (expectedChecksum !== parsed.data.checksum) return undefined
    return parsed.data
  } catch {
    return undefined
  }
}

// Evidence paths and journal destinations are stored with forward slashes;
// normalize Windows separators so move matching stays platform-independent.
function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/')
}

function resolveMoveTarget(
  relativePath: string,
  workspaceMoves: WorkspaceMoveRecord[] | undefined,
): string {
  if (!workspaceMoves?.length) return relativePath
  // First move wins per source path, matching the prior find()-based
  // behavior for duplicate journal entries.
  const byFrom = new Map<string, string>()
  for (const move of workspaceMoves) {
    const from = normalizeRelativePath(move.from)
    if (!byFrom.has(from)) {
      byFrom.set(from, normalizeRelativePath(move.to))
    }
  }
  // Follow the from→to chain transitively: a journal holding a→b then b→c
  // must rebind evidence pointing at a all the way to c, not leave it
  // stale one hop behind. The visited set guards against cycles in
  // persisted or journal-sourced move records.
  let current = normalizeRelativePath(relativePath)
  const visited = new Set<string>([current])
  for (;;) {
    const next = byFrom.get(current)
    if (next === undefined || visited.has(next)) break
    visited.add(next)
    current = next
  }
  // Paths no move binds keep their original spelling; rebound paths adopt
  // the canonical forward-slash destination.
  return visited.size > 1 ? current : relativePath
}

async function hashFile(
  fs: TaskMemoryStoreFs,
  absolutePath: string,
): Promise<string | undefined> {
  try {
    const stats = await fs.stat(absolutePath)
    if (stats.size > MAX_EVIDENCE_HASH_BYTES) {
      if (typeof fs.open !== 'function') {
        // Oversized target with no partial-read primitive: refuse to buffer
        // a multi-GB body just to feed the digest. Returning undefined marks
        // the entry stale (unverifiable) instead of risking OOM at session
        // start.
        return undefined
      }
      // Read only the leading bytes so a multi-GB evidence file never gets
      // buffered whole just to feed the digest.
      const handle = await fs.open(absolutePath, 'r')
      try {
        const leading = Buffer.alloc(MAX_EVIDENCE_HASH_BYTES)
        const { bytesRead } = await handle.read(
          leading,
          0,
          MAX_EVIDENCE_HASH_BYTES,
          0,
        )
        return createHash('sha256')
          .update(leading.subarray(0, bytesRead))
          .digest('hex')
      } finally {
        try {
          await handle.close()
        } catch {
          // Ignore: the digest is already computed.
        }
      }
    }
    let contents = await fs.readFile(absolutePath)
    if (contents.length > MAX_EVIDENCE_HASH_BYTES) {
      // Growth raced past the cap between stat and read: still digest only
      // the leading bytes.
      contents = contents.subarray(0, MAX_EVIDENCE_HASH_BYTES)
    }
    return createHash('sha256').update(contents).digest('hex')
  } catch {
    return undefined
  }
}

/**
 * True when candidatePath resolves inside rootDir. Evidence paths originate
 * from persisted state and journal destinations, so anything resolving
 * outside the project root is treated as untrusted and never read.
 *
 * This check is purely lexical: it does not resolve symlinks, so a symlink
 * planted inside rootDir that points outside will still be hashed. Exposure
 * is limited to feeding outside bytes into the freshness digest (contents
 * are never surfaced to callers), which is accepted here rather than paying
 * an lstat/realpath syscall per evidence item.
 */
function isPathInsideRoot(rootDir: string, candidatePath: string): boolean {
  const root = path.resolve(rootDir)
  const resolved = path.resolve(candidatePath)
  if (resolved === root) return true
  const rel = path.relative(root, resolved)
  return (
    rel !== '' &&
    !path.isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`)
  )
}

/**
 * Re-evaluate each evidence item against current disk state. Missing or
 * changed files mark the entry stale; a matching workspace move rebinds the
 * path to its destination before evaluating. Entries are never deleted.
 */
export async function reconcileTaskMemoryEvidence(params: {
  memory: TaskMemoryV1
  rootDir: string
  fs?: TaskMemoryStoreFs
  workspaceMoves?: WorkspaceMoveRecord[]
}): Promise<TaskMemoryV1> {
  const fs = params.fs ?? nodeFsPromises
  const reconcileItem = async (
    item: TaskMemoryEvidenceV1,
  ): Promise<TaskMemoryEvidenceV1> => {
    if (!item.path) {
      return item
    }
    const boundPath = resolveMoveTarget(item.path, params.workspaceMoves)
    const absolutePath = path.join(params.rootDir, boundPath)
    if (!isPathInsideRoot(params.rootDir, absolutePath)) {
      // evidence.path comes from persisted state and journal destinations;
      // refuse to read (or adopt) any path resolving outside the root.
      return { ...item, stale: true }
    }
    const digest = await hashFile(fs, absolutePath)
    const isFresh =
      digest !== undefined &&
      (item.freshnessHash === undefined || digest === item.freshnessHash)
    return isFresh
      ? { ...item, path: boundPath, stale: false, verifiedAt: Date.now() }
      : { ...item, path: boundPath, stale: true }
  }
  // Evidence lists are capped (LIST_CAPS.evidence), but each item may read
  // up to MAX_EVIDENCE_HASH_BYTES, so hashing every entry concurrently
  // spiked ~256MB of transient buffers on a cold cache. Chunks keep reads
  // pipelined while bounding peak memory; output order follows input.
  const evidence: TaskMemoryEvidenceV1[] = []
  for (
    let start = 0;
    start < params.memory.evidence.length;
    start += EVIDENCE_HASH_CONCURRENCY
  ) {
    const chunk = params.memory.evidence.slice(
      start,
      start + EVIDENCE_HASH_CONCURRENCY,
    )
    evidence.push(...(await Promise.all(chunk.map(reconcileItem))))
  }
  return { ...params.memory, evidence }
}

// Dedupe keeps the FIRST occurrence (prior wins) even though agent-runtime's
// normalizeEvidence prefers newer verifiedAt. Prior-wins is safe because
// priorMemory has already been through reconcileTaskMemoryEvidence (its
// stale/verifiedAt reflect current disk state) and runMemory was normalized
// by the runtime before reaching the store, so neither side carries an
// unverified staleness verdict for a shared id; the next session's reconcile
// pass re-verifies anyway. Do not "fix" the asymmetry by switching to
// newest-verifiedAt here without revisiting that invariant.
function mergeEvidenceLists(
  prior: TaskMemoryEvidenceV1[],
  run: TaskMemoryEvidenceV1[],
): TaskMemoryEvidenceV1[] {
  const byId = new Map<string, TaskMemoryEvidenceV1>()
  for (const item of [...prior, ...run]) {
    if (!byId.has(item.id)) byId.set(item.id, item)
  }
  return [...byId.values()]
}

/**
 * Merge a finished run's task memory into the previously persisted one and
 * write the result atomically. Lists concatenate prior-then-run with exact
 * duplicates dropped (first occurrence wins); scalar fields prefer the run's
 * non-empty values. Returns undefined when there is nothing to write or
 * when the write or schema validation fails; never throws.
 */
export async function saveMergedTaskMemory(params: {
  rootDir: string
  runMemory?: TaskMemoryV1
  priorMemory?: TaskMemoryV1
  fs?: TaskMemoryStoreFs
}): Promise<TaskMemoryV1 | undefined> {
  const { runMemory, priorMemory } = params
  if (!runMemory) return undefined
  const fs = params.fs ?? nodeFsPromises

  const mergeStrings = (prior: string[], run: string[]): string[] => [
    ...new Set([...prior, ...run]),
  ]

  const parsedDraft = taskMemoryDraftV1Schema.safeParse({
    schemaVersion: 1 as const,
    goal: runMemory.goal || priorMemory?.goal || '',
    requirements: truncateToCap(
      mergeStrings(priorMemory?.requirements ?? [], runMemory.requirements),
      LIST_CAPS.requirements,
    ),
    decisions: truncateToCap(
      mergeStrings(priorMemory?.decisions ?? [], runMemory.decisions),
      LIST_CAPS.decisions,
    ),
    filesInspected: truncateToCap(
      mergeStrings(priorMemory?.filesInspected ?? [], runMemory.filesInspected),
      LIST_CAPS.filesInspected,
    ),
    editsMade: truncateToCap(
      mergeStrings(priorMemory?.editsMade ?? [], runMemory.editsMade),
      LIST_CAPS.editsMade,
    ),
    validationResults: truncateToCap(
      mergeStrings(
        priorMemory?.validationResults ?? [],
        runMemory.validationResults,
      ),
      LIST_CAPS.validationResults,
    ),
    reviewReceipts: truncateToCap(
      mergeStrings(priorMemory?.reviewReceipts ?? [], runMemory.reviewReceipts),
      LIST_CAPS.reviewReceipts,
    ),
    blockers: truncateToCap(
      mergeStrings(priorMemory?.blockers ?? [], runMemory.blockers),
      LIST_CAPS.blockers,
    ),
    nextActions: truncateToCap(
      mergeStrings(priorMemory?.nextActions ?? [], runMemory.nextActions),
      LIST_CAPS.nextActions,
    ),
    historicalSummary:
      runMemory.historicalSummary || priorMemory?.historicalSummary || '',
    evidence: truncateToCap(
      mergeEvidenceLists(priorMemory?.evidence ?? [], runMemory.evidence),
      LIST_CAPS.evidence,
    ),
    workspaceRevision:
      runMemory.workspaceRevision ?? priorMemory?.workspaceRevision,
    workspaceSnapshotId:
      runMemory.workspaceSnapshotId ?? priorMemory?.workspaceSnapshotId,
  })
  if (!parsedDraft.success) return undefined

  const revision = Math.max(runMemory.revision, priorMemory?.revision ?? -1) + 1
  const updatedAt = Date.now()
  const checksum = stableHash(
    JSON.stringify({ revision, updatedAt, memory: parsedDraft.data }),
  )
  const parsedRecord = taskMemoryV1Schema.safeParse({
    ...parsedDraft.data,
    revision,
    updatedAt,
    checksum,
  })
  if (!parsedRecord.success) return undefined

  const record = parsedRecord.data

  const filePath = getMemoryFilePath(params.rootDir)
  // Unique tmp suffix: a fixed `${filePath}.tmp` lets two concurrent saves in
  // one cwd interleave writeFile/rename and silently lose a save.
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // Owner-only perms: the record summarizes work history (paths, decisions,
    // review receipts) that other local users have no business reading.
    await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), {
      mode: 0o600,
    })
    await fs.rename(tmpPath, filePath)
  } catch {
    // Best-effort cleanup so failed saves do not litter unique tmp files.
    try {
      await fs.unlink(tmpPath)
    } catch {
      // Ignore: the tmp file may never have been created.
    }
    return undefined
  }
  return record
}

/**
 * Adapt the caller-supplied {@link CodebuffFileSystem} to the narrow
 * {@link TaskMemoryStoreFs} subset the store consumes, so hydration honors
 * virtual-fs hosts instead of always touching node fs. The return type is
 * deliberately the subset interface — not `FsModule` — because an adapter
 * guarantees nothing beyond these members; calling anything else must be a
 * compile error rather than a silent runtime `undefined`. Atomic renames
 * require the optional `renameFile` capability; without it, persistence
 * degrades to a skipped save (saveMergedTaskMemory returns undefined)
 * rather than a non-atomic write. A native `open` on the host (real node
 * fs) is forwarded so oversized evidence hashing streams leading bytes
 * instead of buffering the file.
 */
export function codebuffFsToNodePromises(
  codebuffFs: CodebuffFileSystem,
): TaskMemoryStoreFs {
  const rename: TaskMemoryStoreFs['rename'] = codebuffFs.renameFile
    ? (oldPath, newPath) => codebuffFs.renameFile!(oldPath, newPath)
    : async () => {
        throw new Error(
          'Filesystem adapter does not support atomic renames; skipping task-memory persistence',
        )
      }
  // CodebuffFileSystem's published type omits `open`, but node-fs-backed
  // hosts (spreads of fs.promises, createNodeFileSystem()) still carry it at
  // runtime. Detect and forward it so oversized evidence hashing streams
  // leading bytes instead of taking the buffered fallback.
  const maybeOpen = (codebuffFs as { open?: FsModule['open'] }).open
  const open: TaskMemoryStoreFs['open'] =
    typeof maybeOpen === 'function'
      ? (file, flags, mode) => maybeOpen(file, flags, mode)
      : undefined
  return {
    // Discard recursive mkdir's first-created-path result; the store only
    // needs completion, and TaskMemoryStoreFs declares Promise<void>.
    mkdir: async (path, options) => {
      await codebuffFs.mkdir(path, options)
    },
    readFile: (file) => codebuffFs.readFile(file) as Promise<Buffer>,
    rename,
    open,
    stat: (path) => codebuffFs.stat(path),
    unlink: (path) => codebuffFs.unlink(path),
    writeFile: (file, data, options) =>
      codebuffFs.writeFile(file, data, options),
  }
}
