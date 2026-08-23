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
  lstat?(path: Parameters<FsModule['stat']>[0]): Promise<Stats>
  realpath?(path: Parameters<FsModule['stat']>[0]): Promise<string>
  readlink?(path: Parameters<FsModule['stat']>[0]): Promise<string>
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
 * Serialization state for the record's load→revision→commit section, keyed by
 * the resolved record path. Entries are dropped once the last queued writer
 * settles, so this cannot grow with the number of saves.
 */
const IN_PROCESS_MEMORY_LOCKS = new Map<string, Promise<void>>()

/** Bounded wait for another process's lock: 50 * 20ms ≈ 1s, then degrade. */
const LOCK_ACQUIRE_ATTEMPTS = 50
const LOCK_RETRY_DELAY_MS = 20

/**
 * A lock older than this is treated as abandoned by a crashed writer and
 * reclaimed. Locked sections are short (one load plus one rename), so a
 * lock this old cannot belong to a live writer.
 */
const LOCK_STALE_MS = 10_000

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

function isPathInsideRootLexical(rootDir: string, candidatePath: string): boolean {
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
 * True when candidatePath resolves inside rootDir. Evidence paths originate
 * from persisted state and journal destinations, so anything resolving
 * outside the project root is treated as untrusted and never read.
 *
 * Lexical check is followed by a symlink-escape guard when the filesystem
 * exposes lstat/realpath: a symlink planted inside rootDir that points
 * outside is treated as outside and never hashed. Exposure on adapters
 * without those primitives remains limited to feeding outside bytes into the
 * freshness digest (contents are never surfaced to callers). Degrades to
 * lexical-only when those primitives are unavailable or the target is
 * missing (hashFile will then mark stale).
 */
async function isPathInsideRoot(
  rootDir: string,
  candidatePath: string,
  fs: TaskMemoryStoreFs,
): Promise<boolean> {
  if (!isPathInsideRootLexical(rootDir, candidatePath)) return false
  if (
    typeof fs.lstat !== 'function' ||
    typeof fs.realpath !== 'function'
  ) {
    return true
  }
  try {
    const lst = await fs.lstat(candidatePath)
    const isSymlink =
      typeof (lst as unknown as { isSymbolicLink?: () => boolean })
        .isSymbolicLink === 'function'
        ? (lst as unknown as { isSymbolicLink: () => boolean }).isSymbolicLink()
        : false
    if (!isSymlink) return true
    const real = await fs.realpath(candidatePath)
    return isPathInsideRootLexical(rootDir, real)
  } catch {
    return true
  }
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
    if (!(await isPathInsideRoot(params.rootDir, absolutePath, fs))) {
      // evidence.path comes from persisted state and journal destinations;
      // refuse to read (or adopt) any path resolving outside the root,
      // including symlink-escape when the filesystem exposes lstat/realpath.
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
 * Evidence ids the caller's hydrated snapshot still carries but the newer
 * on-disk merge base does not: the other writer (`/memory prune`, or list-cap
 * eviction) removed them after this session hydrated, so re-adding them from
 * the session's own copy would resurrect deleted content.
 */
function collectDroppedEvidenceIds(
  hydrated: TaskMemoryEvidenceV1[] | undefined,
  base: TaskMemoryEvidenceV1[] | undefined,
): Set<string> {
  const dropped = new Set<string>()
  if (!hydrated?.length) return dropped
  const baseIds = new Set((base ?? []).map((item) => item.id))
  for (const item of hydrated) {
    if (!baseIds.has(item.id)) dropped.add(item.id)
  }
  return dropped
}

/**
 * Merge a finished run's task memory into the previously persisted one and
 * write the result atomically. Lists concatenate prior-then-run with exact
 * duplicates dropped (first occurrence wins); scalar fields prefer the run's
 * non-empty values. Returns undefined when there is nothing to write or
 * when the write or schema validation fails; never throws.
 *
 * The merge base is the NEWER of the caller's `priorMemory` and the record
 * currently on disk, and the emitted revision is one past both. task-memory.json
 * has more than one writer (`pruneStaleTaskMemoryEvidence` is the other), and a
 * session hydrates `priorMemory` once at start, so trusting the hydrated copy
 * would reuse a revision another writer already published and resurrect the
 * evidence it dropped.
 *
 * Two separate guards, because a revision number says nothing about content:
 * the load→revision→commit section runs under {@link withMemoryFileLock} so
 * two writers cannot derive the same revision, and evidence the merge base no
 * longer carries but the caller's hydrated snapshot still does is treated as
 * deliberately dropped by the other writer and filtered out of the run's
 * still-hydrated `evidence` instead of being merged back in.
 */
export async function saveMergedTaskMemory(params: {
  rootDir: string
  runMemory?: TaskMemoryV1
  priorMemory?: TaskMemoryV1
  fs?: TaskMemoryStoreFs
}): Promise<TaskMemoryV1 | undefined> {
  const { runMemory } = params
  if (!runMemory) return undefined
  const fs = params.fs ?? nodeFsPromises
  // Load, revision derivation and commit run as one serialized section: the
  // revision this save reads from disk must not also be publishable by the
  // other writer (see withMemoryFileLock).
  return withMemoryFileLock(fs, getMemoryFilePath(params.rootDir), () =>
    commitMergedTaskMemory({
      rootDir: params.rootDir,
      runMemory,
      priorMemory: params.priorMemory,
      fs,
    }),
  )
}

/** Serialized body of {@link saveMergedTaskMemory}. */
async function commitMergedTaskMemory(params: {
  rootDir: string
  runMemory: TaskMemoryV1
  priorMemory?: TaskMemoryV1
  fs: TaskMemoryStoreFs
}): Promise<TaskMemoryV1 | undefined> {
  const { runMemory, priorMemory, fs } = params

  // Re-read the record on disk so this save composes with the other writer
  // (`pruneStaleTaskMemoryEvidence`) instead of clobbering it: when the file
  // has advanced past the revision this session hydrated, the on-disk record
  // is the merge base and the stale hydrated copy is discarded.
  const persisted = await loadPersistedTaskMemory({
    rootDir: params.rootDir,
    fs,
  })
  const basePrior =
    persisted !== undefined && persisted.revision > (priorMemory?.revision ?? -1)
      ? persisted
      : priorMemory

  // Content-level resurrection guard. `/memory prune` runs from inside a live
  // session, so the session's `runMemory.evidence` still holds the entries it
  // dropped; merging them against the pruned on-disk record would republish
  // them under the next revision. Every id the hydrated snapshot carries but
  // the (newer) on-disk merge base does not was deliberately removed by that
  // writer, so it is dropped from the run's contribution. Evidence the run
  // recorded itself is untouched, and the next session re-verifies anyway.
  const droppedByOtherWriter =
    basePrior === persisted
      ? collectDroppedEvidenceIds(priorMemory?.evidence, persisted?.evidence)
      : new Set<string>()
  const runEvidence =
    droppedByOtherWriter.size === 0
      ? runMemory.evidence
      : runMemory.evidence.filter((item) => !droppedByOtherWriter.has(item.id))

  const mergeStrings = (prior: string[], run: string[]): string[] => [
    ...new Set([...prior, ...run]),
  ]

  const parsedDraft = taskMemoryDraftV1Schema.safeParse({
    schemaVersion: 1 as const,
    goal: runMemory.goal || basePrior?.goal || '',
    requirements: truncateToCap(
      mergeStrings(basePrior?.requirements ?? [], runMemory.requirements),
      LIST_CAPS.requirements,
    ),
    decisions: truncateToCap(
      mergeStrings(basePrior?.decisions ?? [], runMemory.decisions),
      LIST_CAPS.decisions,
    ),
    filesInspected: truncateToCap(
      mergeStrings(basePrior?.filesInspected ?? [], runMemory.filesInspected),
      LIST_CAPS.filesInspected,
    ),
    editsMade: truncateToCap(
      mergeStrings(basePrior?.editsMade ?? [], runMemory.editsMade),
      LIST_CAPS.editsMade,
    ),
    validationResults: truncateToCap(
      mergeStrings(
        basePrior?.validationResults ?? [],
        runMemory.validationResults,
      ),
      LIST_CAPS.validationResults,
    ),
    reviewReceipts: truncateToCap(
      mergeStrings(basePrior?.reviewReceipts ?? [], runMemory.reviewReceipts),
      LIST_CAPS.reviewReceipts,
    ),
    blockers: truncateToCap(
      mergeStrings(basePrior?.blockers ?? [], runMemory.blockers),
      LIST_CAPS.blockers,
    ),
    nextActions: truncateToCap(
      mergeStrings(basePrior?.nextActions ?? [], runMemory.nextActions),
      LIST_CAPS.nextActions,
    ),
    historicalSummary:
      runMemory.historicalSummary || basePrior?.historicalSummary || '',
    evidence: truncateToCap(
      mergeEvidenceLists(basePrior?.evidence ?? [], runEvidence),
      LIST_CAPS.evidence,
    ),
    workspaceRevision:
      runMemory.workspaceRevision ?? basePrior?.workspaceRevision,
    workspaceSnapshotId:
      runMemory.workspaceSnapshotId ?? basePrior?.workspaceSnapshotId,
  })
  if (!parsedDraft.success) return undefined

  // Monotonic past EVERY writer: the run's own counter, the caller's merge
  // base, and whatever is currently on disk.
  const revision =
    Math.max(
      runMemory.revision,
      basePrior?.revision ?? -1,
      persisted?.revision ?? -1,
    ) + 1
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

  // Shared atomic-write path: identical unique pid+uuid tmp scheme, owner-only
  // perms, rename commit and unlink cleanup, so the tmp-name contract pinned
  // by store tests is preserved.
  return (await writeRecordAtomically(
    fs,
    getMemoryFilePath(params.rootDir),
    record,
  ))
    ? record
    : undefined
}

// Atomic record write shared by saveMergedTaskMemory and
// pruneStaleTaskMemoryEvidence. Unique pid+uuid tmp: a fixed `${filePath}.tmp`
// lets two concurrent writers in one cwd interleave writeFile/rename and
// silently lose a write. Owner-only perms because the record summarizes work
// history (paths, decisions, review receipts) that other local users have no
// business reading.
async function writeRecordAtomically(
  fs: TaskMemoryStoreFs,
  filePath: string,
  record: TaskMemoryV1,
): Promise<boolean> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), {
      mode: 0o600,
    })
    await fs.rename(tmpPath, filePath)
    return true
  } catch {
    // Best-effort cleanup so failed writes do not litter unique tmp files.
    try {
      await fs.unlink(tmpPath)
    } catch {
      // Ignore: the tmp file may never have been created.
    }
    return false
  }
}

/**
 * Serialize the load→revision→commit section shared by both task-memory
 * writers.
 *
 * `saveMergedTaskMemory` and `pruneStaleTaskMemoryEvidence` each read the
 * record, derive the next `revision` from what they read, and commit by
 * rename. With no mutual exclusion those windows interleave — a save landing
 * between prune's revision check and its rename, or two saves loading the
 * same record — and both writers publish the SAME revision with different
 * payloads, which is exactly what the record's monotonic-and-unique revision
 * contract forbids.
 *
 * Two layers, because neither alone covers the writers:
 * - an in-process promise chain keyed by the resolved record path, which
 *   handles the common case (a CLI `/memory prune` and an SDK save in one
 *   process) without needing any filesystem support;
 * - an exclusive-create (`wx`) lock file for other processes sharing the
 *   project, reclaimed after {@link LOCK_STALE_MS} so a crashed writer cannot
 *   block later ones forever.
 *
 * The cross-process layer is advisory: an adapter that ignores the `flag`
 * option, or a lock that cannot be taken within the bounded attempt budget,
 * degrades to running the section unlocked rather than dropping the write.
 * Both callers keep their own on-disk re-read (save) and revision guard
 * (prune), so the degraded path is exactly as safe as before this lock
 * existed.
 *
 * Evidence reconciliation deliberately stays OUTSIDE the section: it hashes
 * every evidence file, so holding the lock across it would stall the other
 * writer, and a run finishing mid-prune (which reconciliation's own IO can
 * trigger) would deadlock against it.
 */
async function withMemoryFileLock<T>(
  fs: TaskMemoryStoreFs,
  filePath: string,
  section: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(filePath)
  const previous = IN_PROCESS_MEMORY_LOCKS.get(key) ?? Promise.resolve()
  const run = async (): Promise<T> => {
    // The lock file sits beside the record, so its directory must exist first.
    // A failing mkdir is not fatal here: the section's own write path creates
    // the directory and reports the failure through its normal outcome.
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {})
    const lockPath = `${filePath}.lock`
    const locked = await acquireRecordLock(fs, lockPath)
    try {
      return await section()
    } finally {
      if (locked) {
        await fs.unlink(lockPath).catch(() => {
          // Ignore: a reclaimed or already-removed lock is not this writer's
          // problem, and the section has already committed.
        })
      }
    }
  }
  const result = previous.then(run, run)
  // Keep the chain alive across failures: one rejected section must not
  // poison every later writer in this process.
  const settled = result.then(
    () => {},
    () => {},
  )
  IN_PROCESS_MEMORY_LOCKS.set(key, settled)
  void settled.then(() => {
    if (IN_PROCESS_MEMORY_LOCKS.get(key) === settled) {
      IN_PROCESS_MEMORY_LOCKS.delete(key)
    }
  })
  return result
}

/**
 * Take the cross-process lock file, or report that this writer is proceeding
 * without it. Returns true only when the lock was created here, so the caller
 * never unlinks a lock it does not hold.
 */
async function acquireRecordLock(
  fs: TaskMemoryStoreFs,
  lockPath: string,
): Promise<boolean> {
  let missingLockObservations = 0
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      await fs.writeFile(lockPath, `${process.pid}\n`, {
        flag: 'wx',
        mode: 0o600,
      })
      return true
    } catch {
      const stats = await fs.stat(lockPath).catch(() => undefined)
      if (!stats) {
        // Nothing holds the lock, so the rejection was not contention: this
        // adapter does not honor exclusive-create. Give up after a second
        // observation (which absorbs a holder releasing between the write and
        // this stat) instead of burning the whole budget on every write.
        missingLockObservations += 1
        if (missingLockObservations >= 2) return false
        continue
      }
      missingLockObservations = 0
      // Reclaim a lock abandoned by a crashed writer. A stat without a usable
      // mtime keeps waiting rather than stealing a possibly-live lock.
      if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lockPath).catch(() => {
          // Ignore: another writer may have reclaimed it first.
        })
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS))
    }
  }
  return false
}

/**
 * Outcome of {@link pruneStaleTaskMemoryEvidence}.
 *
 * `status` is the field callers must branch on. "There is no record"
 * (`no-record`) and "the prune could not be committed" (`failed`) are
 * deliberately distinct so a silently failed write is never presented to a
 * user as "nothing to prune". On `failed`, `removed`/`remaining` describe the
 * prune that WOULD have been written, so the record still holds `removed`
 * stale entries.
 */
export type TaskMemoryPruneOutcome =
  | { status: 'pruned'; removed: number; remaining: number }
  | { status: 'no-record' }
  | {
      status: 'failed'
      reason: 'invalid-record' | 'concurrent-write' | 'write-failed'
      removed: number
      remaining: number
    }

/**
 * Drop stale evidence from the persisted record and rewrite it atomically
 * (revision bumped past the loaded record, checksum recomputed over the same
 * draft-shaped payload saves use). Staleness is decided by reconciling
 * against CURRENT disk state first rather than trusting the persisted
 * `stale` flag: a record written before files moved or changed still carries
 * `stale: false` for entries that no longer verify. Entries that reconcile
 * fresh are never dropped, and a fully-fresh record is left unwritten
 * (reported as a `pruned` outcome with `removed: 0`).
 *
 * Reconciliation hashes evidence files, so a concurrent `saveMergedTaskMemory`
 * can publish a new revision in the meantime; the revision check and the
 * commit therefore run inside {@link withMemoryFileLock} (reconciliation
 * stays outside it) and are still guarded on the record sitting at the
 * revision this call loaded, because emitting `loaded.revision + 1` after
 * that would put a second, different payload under a revision number the save
 * already used. Every failure mode (schema reject, lost race, unwritable
 * target or rename-less adapter) is reported as `status: 'failed'`; never
 * throws.
 *
 * Staleness is evaluated under the SAME move contract as hydration: callers
 * that can see workspace moves must pass them, or evidence bound to a renamed
 * file reconciles stale and is permanently deleted instead of rebinding to
 * its destination.
 */
export async function pruneStaleTaskMemoryEvidence(params: {
  rootDir: string
  fs?: TaskMemoryStoreFs
  /**
   * Known file moves, identical in meaning to hydration's
   * {@link reconcileTaskMemoryEvidence} parameter: evidence bound to a moved
   * file rebinds to the destination instead of reconciling stale. Prune
   * DELETES stale entries, so omitting known moves loses that evidence
   * permanently.
   */
  workspaceMoves?: WorkspaceMoveRecord[]
}): Promise<TaskMemoryPruneOutcome> {
  const fs = params.fs ?? nodeFsPromises
  const persisted = await loadPersistedTaskMemory({
    rootDir: params.rootDir,
    fs,
  })
  if (!persisted) return { status: 'no-record' }
  // Re-verify against disk so pruning reflects reality rather than the
  // staleness verdict captured when the record was last written. Moves are
  // applied first so a renamed file's evidence is rebound, never dropped.
  const memory = await reconcileTaskMemoryEvidence({
    memory: persisted,
    rootDir: params.rootDir,
    fs,
    workspaceMoves: params.workspaceMoves,
  })
  const kept = memory.evidence.filter((item) => item.stale !== true)
  const removed = memory.evidence.length - kept.length
  const remaining = kept.length
  if (removed === 0) return { status: 'pruned', removed: 0, remaining }

  const parsedDraft = taskMemoryDraftV1Schema.safeParse({
    ...memory,
    evidence: kept,
  })
  if (!parsedDraft.success) {
    return { status: 'failed', reason: 'invalid-record', removed, remaining }
  }

  // Serialized section: the revision check and the commit must not straddle
  // another writer's commit (reconciliation above is deliberately outside it).
  return withMemoryFileLock(
    fs,
    getMemoryFilePath(params.rootDir),
    async (): Promise<TaskMemoryPruneOutcome> => {
      // Revision guard: bail out rather than reuse a revision another writer
      // published while this call was reconciling.
      const current = await loadPersistedTaskMemory({
        rootDir: params.rootDir,
        fs,
      })
      if (!current || current.revision !== persisted.revision) {
        return {
          status: 'failed',
          reason: 'concurrent-write',
          removed,
          remaining,
        }
      }

      const revision = persisted.revision + 1
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
      if (!parsedRecord.success) {
        return { status: 'failed', reason: 'invalid-record', removed, remaining }
      }

      const written = await writeRecordAtomically(
        fs,
        getMemoryFilePath(params.rootDir),
        parsedRecord.data,
      )
      if (!written) {
        return { status: 'failed', reason: 'write-failed', removed, remaining }
      }
      return { status: 'pruned', removed, remaining }
    },
  )
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
  const maybeLstat = (codebuffFs as { lstat?: FsModule['stat'] }).lstat
  const lstat: TaskMemoryStoreFs['lstat'] =
    typeof maybeLstat === 'function'
      ? (p) => (maybeLstat as unknown as (p: string) => Promise<Stats>)(p as string)
      : undefined
  const maybeRealpath = (
    codebuffFs as { realpath?: (p: string) => Promise<string> }
  ).realpath
  const realpath: TaskMemoryStoreFs['realpath'] =
    typeof maybeRealpath === 'function'
      ? (p) => maybeRealpath(p as string)
      : undefined
  const maybeReadlink = (
    codebuffFs as { readlink?: (p: string) => Promise<string> }
  ).readlink
  const readlink: TaskMemoryStoreFs['readlink'] =
    typeof maybeReadlink === 'function'
      ? (p) => maybeReadlink(p as string)
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
    lstat,
    realpath,
    readlink,
    stat: (path) => codebuffFs.stat(path),
    unlink: (path) => codebuffFs.unlink(path),
    writeFile: (file, data, options) =>
      codebuffFs.writeFile(file, data, options),
  }
}
