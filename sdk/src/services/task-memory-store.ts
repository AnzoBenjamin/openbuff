import { createHash, randomUUID } from 'node:crypto'
import type { PathLike, Stats } from 'node:fs'
import * as nodeFsPromises from 'node:fs/promises'
import path from 'node:path'

import {
  TASK_MEMORY_LIST_CAPS,
  taskMemoryDraftV1Schema,
  taskMemoryV1Schema,
} from '@codebuff/common/types/task-memory'
import { errorCode } from '@codebuff/common/util/error'
import { stableHash } from '@codebuff/common/util/stable-hash'

import type {
  CodebuffFileContent,
  CodebuffFileSystem,
} from '@codebuff/common/types/filesystem'
import type {
  TaskMemoryEvidenceV1,
  TaskMemoryV1,
} from '@codebuff/common/types/task-memory'

/**
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
 */
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
 *
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
 */
export interface TaskMemoryStoreFs {
  mkdir(
    path: Parameters<FsModule['mkdir']>[0],
    options?: Parameters<FsModule['mkdir']>[1],
  ): Promise<void>
  readFile(file: Parameters<FsModule['readFile']>[0]): Promise<Buffer>
  /**
   * Explicit atomic-create capability used for cross-process locking. Merely
   * accepting node's `wx` write option is not sufficient: virtual adapters
   * have historically ignored it while reporting a successful write.
   */
  createFileExclusive?(file: PathLike, data: CodebuffFileContent): Promise<void>
  /**
   * Partial-read primitive used to hash large evidence files incrementally.
   * Stores without it treat large targets as unverifiable rather than change
   * the digest contract or buffer an unbounded body.
   */
  open?: FsModule['open']
  rename(
    oldPath: Parameters<FsModule['rename']>[0],
    newPath: Parameters<FsModule['rename']>[1],
  ): Promise<void>
  stat(path: Parameters<FsModule['stat']>[0]): Promise<Stats>
  realpath?(path: Parameters<FsModule['stat']>[0]): Promise<string>
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

/** Files above this size are hashed incrementally instead of buffered whole. */
const EVIDENCE_STREAM_THRESHOLD_BYTES = 1_000_000
const WHOLE_CONTENT_HASH_PREFIX = 'sha256-whole:'
const LEGACY_PREFIX_HASH_PREFIX = 'sha256-prefix-1m:'
const SHA256_HEX = /^[0-9a-f]{64}$/

/** Fixed working buffer for whole-content hashing of large evidence files. */
const EVIDENCE_HASH_BUFFER_BYTES = 64 * 1024

/** Evidence reads processed per Promise.all batch during reconciliation. */
const EVIDENCE_HASH_CONCURRENCY = 16

/**
 * Serialization state for the record's load→revision→commit section, keyed by
 * the resolved record path. Entries are dropped once the last queued writer
 * settles, so this cannot grow with the number of saves.
 */
const IN_PROCESS_MEMORY_LOCKS = new Map<string, Promise<void>>()

/** Bounded wait for another process's lock: failure skips the write. */
const LOCK_ACQUIRE_ATTEMPTS = 50
const LOCK_RETRY_DELAY_MS = 20

const DEFAULT_TASK_MEMORY_FS: TaskMemoryStoreFs = {
  ...nodeFsPromises,
  createFileExclusive: async (file, data) => {
    await nodeFsPromises.writeFile(file, data, { flag: 'wx', mode: 0o600 })
  },
}

function taskMemoryFs(fs: TaskMemoryStoreFs | undefined): TaskMemoryStoreFs {
  if (!fs) return DEFAULT_TASK_MEMORY_FS
  // Direct node:fs/promises adapters have native exclusive-create semantics.
  // Virtual adapters must instead opt in through createFileExclusive.
  if (fs === nodeFsPromises && typeof fs.createFileExclusive !== 'function') {
    return {
      ...fs,
      createFileExclusive: DEFAULT_TASK_MEMORY_FS.createFileExclusive,
    }
  }
  return fs
}

export type TaskMemoryV1Inspection =
  | { status: 'absent' }
  | { status: 'valid'; memory: TaskMemoryV1 }
  | {
      status: 'invalid'
      reason: 'malformed-json' | 'schema-invalid' | 'checksum-mismatch'
    }
  | { status: 'unreadable'; reason: 'read-failed' }

/**
 * Inspect the persisted V1 record without mutating storage. The bounded result
 * deliberately exposes no path, contents, validation issues, or raw read
 * error. Only ENOENT proves absence; every other read failure is unreadable.
 *
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
 */
export async function inspectPersistedTaskMemoryV1(params: {
  rootDir: string
  fs?: Pick<TaskMemoryStoreFs, 'readFile'>
}): Promise<TaskMemoryV1Inspection> {
  const fs = params.fs ?? nodeFsPromises
  let raw: Buffer
  try {
    raw = await fs.readFile(getMemoryFilePath(params.rootDir))
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'unreadable', reason: 'read-failed' }
  }

  let candidate: unknown
  try {
    candidate = JSON.parse(raw.toString('utf8'))
  } catch {
    return { status: 'invalid', reason: 'malformed-json' }
  }

  const parsed = taskMemoryV1Schema.safeParse(candidate)
  if (!parsed.success) return { status: 'invalid', reason: 'schema-invalid' }
  const parsedDraft = taskMemoryDraftV1Schema.safeParse(parsed.data)
  if (!parsedDraft.success)
    return { status: 'invalid', reason: 'schema-invalid' }
  const expectedChecksum = stableHash(
    JSON.stringify({
      revision: parsed.data.revision,
      updatedAt: parsed.data.updatedAt,
      memory: parsedDraft.data,
    }),
  )
  if (expectedChecksum !== parsed.data.checksum) {
    return { status: 'invalid', reason: 'checksum-mismatch' }
  }
  return { status: 'valid', memory: parsed.data }
}

/**
 * Load and schema-validate persisted task memory. Compatibility callers keep
 * the historical behavior: every non-valid inspection collapses to undefined.
 *
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
 */
export async function loadPersistedTaskMemory(params: {
  rootDir: string
  fs?: TaskMemoryStoreFs
}): Promise<TaskMemoryV1 | undefined> {
  const inspected = await inspectPersistedTaskMemoryV1(params)
  return inspected.status === 'valid' ? inspected.memory : undefined
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

type EvidenceFileHashes =
  | { status: 'hashed'; whole: string; legacyPrefix?: string }
  | { status: 'missing' }
  | { status: 'outside' }
  | { status: 'unverifiable' }

/**
 * Open, contain, and hash one stable file descriptor. Opening before canonical
 * validation closes the check/use gap: even if an ancestor pathname is
 * replaced while realpath runs, descriptor identity must still match the
 * contained canonical target before any bytes are read. Every size uses the
 * same fixed buffer, and reads stop at the descriptor's initial size so growth
 * cannot turn a small-file stat into an unbounded allocation or read.
 */
async function hashFile(
  fs: TaskMemoryStoreFs,
  rootDir: string,
  absolutePath: string,
): Promise<EvidenceFileHashes> {
  if (!isPathInsideRootLexical(rootDir, absolutePath)) {
    return { status: 'outside' }
  }
  if (typeof fs.open !== 'function' || typeof fs.realpath !== 'function') {
    return { status: 'unverifiable' }
  }

  let handle: Awaited<ReturnType<FsModule['open']>> | undefined
  try {
    handle = await fs.open(absolutePath, 'r')
    const realRoot = await fs.realpath(rootDir)
    const realCandidate = await fs.realpath(absolutePath)
    if (!isPathInsideRootLexical(realRoot, realCandidate)) {
      return { status: 'outside' }
    }

    const [openedStats, canonicalStats] = await Promise.all([
      handle.stat(),
      fs.stat(realCandidate),
    ])
    if (
      !openedStats.isFile() ||
      openedStats.dev !== canonicalStats.dev ||
      openedStats.ino !== canonicalStats.ino ||
      !Number.isSafeInteger(openedStats.size) ||
      openedStats.size < 0
    ) {
      return { status: 'unverifiable' }
    }

    const wholeDigest = createHash('sha256')
    const legacyPrefixDigest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(EVIDENCE_HASH_BUFFER_BYTES)
    let position = 0
    let legacyBytes = 0
    while (position < openedStats.size) {
      const length = Math.min(buffer.length, openedStats.size - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead === 0) return { status: 'unverifiable' }
      const bytes = buffer.subarray(0, bytesRead)
      wholeDigest.update(bytes)
      if (legacyBytes < EVIDENCE_STREAM_THRESHOLD_BYTES) {
        const prefixBytes = Math.min(
          bytesRead,
          EVIDENCE_STREAM_THRESHOLD_BYTES - legacyBytes,
        )
        legacyPrefixDigest.update(bytes.subarray(0, prefixBytes))
        legacyBytes += prefixBytes
      }
      position += bytesRead
    }

    const finalStats = await handle.stat()
    if (
      finalStats.dev !== openedStats.dev ||
      finalStats.ino !== openedStats.ino ||
      finalStats.size !== openedStats.size ||
      finalStats.mtimeMs !== openedStats.mtimeMs ||
      finalStats.ctimeMs !== openedStats.ctimeMs
    ) {
      return { status: 'unverifiable' }
    }
    return {
      status: 'hashed',
      whole: wholeDigest.digest('hex'),
      legacyPrefix: legacyPrefixDigest.digest('hex'),
    }
  } catch (error) {
    return handle === undefined && errorCode(error) === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unverifiable' }
  } finally {
    await handle?.close().catch(() => {})
  }
}

function reconcileFreshnessHash(
  recorded: string | undefined,
  hashes: Extract<EvidenceFileHashes, { status: 'hashed' }>,
): { status: 'fresh' | 'stale' | 'unverifiable'; freshnessHash?: string } {
  if (recorded === undefined) return { status: 'fresh' }

  let expected: string
  let matches: boolean
  if (recorded.startsWith(WHOLE_CONTENT_HASH_PREFIX)) {
    expected = recorded.slice(WHOLE_CONTENT_HASH_PREFIX.length)
    if (!SHA256_HEX.test(expected)) return { status: 'unverifiable' }
    matches = expected === hashes.whole
  } else if (recorded.startsWith(LEGACY_PREFIX_HASH_PREFIX)) {
    expected = recorded.slice(LEGACY_PREFIX_HASH_PREFIX.length)
    if (!SHA256_HEX.test(expected)) return { status: 'unverifiable' }
    // For files at or below the historical prefix limit, the prefix digest is
    // identical to the whole-content digest and hashFile need not produce both.
    matches = expected === (hashes.legacyPrefix ?? hashes.whole)
  } else if (SHA256_HEX.test(recorded)) {
    // Unversioned records may be either the historical one-megabyte prefix
    // digest or the newer whole-content digest. A match can be upgraded. A
    // mismatch is still reported stale by reconciliation, but prune separately
    // refuses to delete a present file on this ambiguous evidence alone.
    matches = recorded === hashes.whole || recorded === hashes.legacyPrefix
  } else {
    return { status: 'unverifiable' }
  }

  return matches
    ? {
        status: 'fresh',
        freshnessHash: `${WHOLE_CONTENT_HASH_PREFIX}${hashes.whole}`,
      }
    : { status: 'stale' }
}

function isPathInsideRootLexical(
  rootDir: string,
  candidatePath: string,
): boolean {
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
 *
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
 */
export async function reconcileTaskMemoryEvidence(params: {
  memory: TaskMemoryV1
  rootDir: string
  fs?: TaskMemoryStoreFs
  workspaceMoves?: WorkspaceMoveRecord[]
}): Promise<TaskMemoryV1> {
  const fs = taskMemoryFs(params.fs)
  const reconcileItem = async (
    item: TaskMemoryEvidenceV1,
  ): Promise<TaskMemoryEvidenceV1> => {
    if (!item.path) {
      return item
    }
    const boundPath = resolveMoveTarget(item.path, params.workspaceMoves)
    const absolutePath = path.join(params.rootDir, boundPath)
    const hashes = await hashFile(fs, params.rootDir, absolutePath)
    if (hashes.status === 'outside') {
      // A proven lexical or descriptor-validated canonical escape is stale and
      // no bytes from the opened target are read.
      return { ...item, stale: true }
    }
    if (hashes.status === 'missing') {
      // ENOENT while opening is positive evidence that the file is gone.
      return { ...item, path: boundPath, stale: true }
    }
    if (hashes.status === 'unverifiable') {
      // Capability/read failures and unknown hash formats are not evidence
      // that the file changed. Preserve the prior verdict so prune cannot
      // destroy evidence merely because this adapter cannot validate it.
      return { ...item, path: boundPath }
    }
    const freshness = reconcileFreshnessHash(item.freshnessHash, hashes)
    if (freshness.status === 'unverifiable') {
      // Unknown formats and read-capability failures cannot establish a new
      // verdict. Preserve the prior state; prune treats them non-destructively.
      return { ...item, path: boundPath }
    }
    return freshness.status === 'fresh'
      ? {
          ...item,
          path: boundPath,
          ...(freshness.freshnessHash
            ? { freshnessHash: freshness.freshnessHash }
            : {}),
          stale: false,
          verifiedAt: Date.now(),
        }
      : { ...item, path: boundPath, stale: true }
  }
  // Evidence lists are capped (LIST_CAPS.evidence), and large files use a
  // fixed streaming buffer. Chunks bound the number of simultaneous file
  // descriptors and buffered small-file reads while preserving output order.
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
 *
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
 */
export async function saveMergedTaskMemory(params: {
  rootDir: string
  runMemory?: TaskMemoryV1
  priorMemory?: TaskMemoryV1
  fs?: TaskMemoryStoreFs
}): Promise<TaskMemoryV1 | undefined> {
  const { runMemory } = params
  if (!runMemory) return undefined
  const fs = taskMemoryFs(params.fs)
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
    persisted !== undefined &&
    persisted.revision > (priorMemory?.revision ?? -1)
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
 * writers. The in-process chain covers callers in this process, while an
 * exclusive-create lock covers other processes.
 *
 * Cross-process exclusion is mandatory: failure to acquire the lock returns
 * `undefined` and the write is skipped. Acquisition requires an explicit
 * atomic-create capability, rather than trusting an adapter's handling of
 * `writeFile(..., { flag: 'wx' })`. An old same-host lock is reclaimed only
 * after its recorded owner process is proven dead; age alone never steals a
 * live writer's lock. Automatic stale-lock deletion is deliberately avoided:
 * portable filesystem APIs cannot atomically compare ownership and unlink, so
 * reclaiming could remove a replacement owner's lock. The unique token is
 * checked before release.
 */
async function withMemoryFileLock<T>(
  fs: TaskMemoryStoreFs,
  filePath: string,
  section: () => Promise<T>,
): Promise<T | undefined> {
  const key = path.resolve(filePath)
  const previous = IN_PROCESS_MEMORY_LOCKS.get(key) ?? Promise.resolve()
  const run = async (): Promise<T | undefined> => {
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {})
    const lockPath = `${filePath}.lock`
    const token = await acquireRecordLock(fs, lockPath)
    if (!token) return undefined
    try {
      return await section()
    } finally {
      const currentToken = await fs
        .readFile(lockPath)
        .then((contents) => contents.toString('utf8'))
        .catch(() => undefined)
      if (currentToken === token) {
        await fs.unlink(lockPath).catch(() => {})
      }
    }
  }
  const result = previous.then(run, run)
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

type RecordLockPayload = {
  token: string
  pid: number
  createdAt: number
}

/**
 * Take the cross-process lock and return its ownership bytes. Contention is
 * bounded, but exhaustion and adapters without explicit atomic create fail
 * closed: callers never enter the mutation section without proven exclusion.
 */
async function acquireRecordLock(
  fs: TaskMemoryStoreFs,
  lockPath: string,
): Promise<string | undefined> {
  if (typeof fs.createFileExclusive !== 'function') return undefined
  const payload: RecordLockPayload = {
    token: randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
  }
  const token = `${JSON.stringify(payload)}\n`
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      await fs.createFileExclusive(lockPath, token)
      const observed = await fs.readFile(lockPath)
      if (observed.toString('utf8') !== token) return undefined
      return token
    } catch {
      if (attempt + 1 < LOCK_ACQUIRE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS))
      }
    }
  }
  return undefined
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
 *
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
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
 * Decide whether the current disk state supplies format-compatible authority
 * to remove one reconciled item. A persisted or inherited `stale` flag is
 * never sufficient by itself: older writers used unversioned hashes, and
 * future writers may introduce formats this process cannot interpret.
 *
 * Missing and escaping targets are independently destructive-safe. For a
 * present contained target, only a syntactically valid, explicitly versioned
 * digest can prove a content mismatch. Bare and unknown digests are always
 * preserved, as are pathless items and any item whose current bytes cannot be
 * read. This deliberately repeats the bounded hash after reconciliation so a
 * transient read failure cannot turn an inherited stale verdict into deletion
 * authority.
 */
async function canPruneReconciledEvidence(params: {
  item: TaskMemoryEvidenceV1
  recordedHash: string | undefined
  rootDir: string
  fs: TaskMemoryStoreFs
}): Promise<boolean> {
  const { item, recordedHash, rootDir, fs } = params
  if (item.stale !== true || !item.path) return false

  const absolutePath = path.join(rootDir, item.path)
  const hashes = await hashFile(fs, rootDir, absolutePath)
  if (hashes.status === 'missing' || hashes.status === 'outside') return true
  if (hashes.status !== 'hashed' || recordedHash === undefined) return false

  let expected: string
  let algorithm: 'whole' | 'legacy-prefix'
  if (recordedHash.startsWith(WHOLE_CONTENT_HASH_PREFIX)) {
    expected = recordedHash.slice(WHOLE_CONTENT_HASH_PREFIX.length)
    algorithm = 'whole'
  } else if (recordedHash.startsWith(LEGACY_PREFIX_HASH_PREFIX)) {
    expected = recordedHash.slice(LEGACY_PREFIX_HASH_PREFIX.length)
    algorithm = 'legacy-prefix'
  } else {
    // Unversioned and unknown formats cannot authorize destructive pruning.
    return false
  }
  if (!SHA256_HEX.test(expected)) return false

  const actual =
    algorithm === 'whole' ? hashes.whole : (hashes.legacyPrefix ?? hashes.whole)
  return expected !== actual
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
 *
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
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
  const fs = taskMemoryFs(params.fs)
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
  const persistedById = new Map(
    persisted.evidence.map((item) => [item.id, item] as const),
  )
  const kept: TaskMemoryEvidenceV1[] = []
  for (const item of memory.evidence) {
    const removalSafe = await canPruneReconciledEvidence({
      item,
      recordedHash: persistedById.get(item.id)?.freshnessHash,
      rootDir: params.rootDir,
      fs,
    })
    if (!removalSafe) kept.push(item)
  }
  const removed = memory.evidence.length - kept.length
  const remaining = kept.length
  const needsHashBackfill = memory.evidence.some(
    (item, index) =>
      item.freshnessHash !== persisted.evidence[index]?.freshnessHash,
  )
  if (removed === 0 && !needsHashBackfill) {
    return { status: 'pruned', removed: 0, remaining }
  }

  const parsedDraft = taskMemoryDraftV1Schema.safeParse({
    ...memory,
    evidence: kept,
  })
  if (!parsedDraft.success) {
    return { status: 'failed', reason: 'invalid-record', removed, remaining }
  }

  // Serialized section: the revision check and the commit must not straddle
  // another writer's commit (reconciliation above is deliberately outside it).
  const outcome = await withMemoryFileLock(
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
        return {
          status: 'failed',
          reason: 'invalid-record',
          removed,
          remaining,
        }
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
  return (
    outcome ?? { status: 'failed', reason: 'write-failed', removed, remaining }
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
 * fs) is forwarded so large evidence files receive the same whole-content
 * digest as buffered files without unbounded memory use.
 *
 * @deprecated Memory V1 compatibility surface; use Memory V2. Removal will occur only after the documented compatibility window and migration audit.
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
  // runtime. Detect and forward it for bounded whole-content streaming.
  const maybeOpen = (codebuffFs as { open?: FsModule['open'] }).open
  const open: TaskMemoryStoreFs['open'] =
    typeof maybeOpen === 'function'
      ? (file, flags, mode) => maybeOpen(file, flags, mode)
      : undefined
  const createFileExclusive: TaskMemoryStoreFs['createFileExclusive'] =
    typeof codebuffFs.createFileExclusive === 'function'
      ? (file, data) => codebuffFs.createFileExclusive!(file, data)
      : undefined
  const maybeRealpath = (
    codebuffFs as { realpath?: (p: string) => Promise<string> }
  ).realpath
  const realpath: TaskMemoryStoreFs['realpath'] =
    typeof maybeRealpath === 'function'
      ? (p) => maybeRealpath(p as string)
      : undefined
  return {
    // Discard recursive mkdir's first-created-path result; the store only
    // needs completion, and TaskMemoryStoreFs declares Promise<void>.
    mkdir: async (path, options) => {
      await codebuffFs.mkdir(path, options)
    },
    readFile: (file) => codebuffFs.readFile(file) as Promise<Buffer>,
    createFileExclusive,
    rename,
    open,
    realpath,
    stat: (path) => codebuffFs.stat(path),
    unlink: (path) => codebuffFs.unlink(path),
    writeFile: (file, data, options) =>
      codebuffFs.writeFile(file, data, options),
  }
}
