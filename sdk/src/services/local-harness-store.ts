import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { z } from 'zod/v4'

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  repositoryId: z.string().min(1),
  workspaceId: z.string().min(1),
  runId: z.string().min(1),
  snapshotId: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

export type LocalHarnessRecord = z.infer<typeof recordSchema> &
  Record<string, unknown>

export type HarnessRecordKind =
  | 'tasks'
  | 'workspaces'
  | 'snapshots'
  | 'artifacts'
  | 'ownership'
  | 'validation'
  | 'findings'
  | 'approvals'
  | 'workspace-journals'

const recordKinds: HarnessRecordKind[] = [
  'tasks',
  'workspaces',
  'snapshots',
  'artifacts',
  'ownership',
  'validation',
  'findings',
  'approvals',
  'workspace-journals',
]

const LOCK_WAIT_MS = 10
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4))

export type HarnessStoreDiagnostic = {
  filePath: string
  message: string
  quarantinedPath?: string
}

function assertSafeSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid harness ${label} '${value}'.`)
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  })
  fs.renameSync(tempPath, filePath)
}

export class LocalHarnessStore {
  readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir)
  }

  private recordPath(
    repositoryId: string,
    kind: HarnessRecordKind,
    id: string,
  ): string {
    assertSafeSegment(repositoryId, 'repository id')
    assertSafeSegment(id, 'record id')
    if (!recordKinds.includes(kind)) {
      throw new Error(`Invalid harness record kind '${kind}'.`)
    }
    return path.join(this.rootDir, repositoryId, kind, `${id}.json`)
  }

  private kindDirectory(repositoryId: string, kind: HarnessRecordKind): string {
    assertSafeSegment(repositoryId, 'repository id')
    if (!recordKinds.includes(kind)) {
      throw new Error(`Invalid harness record kind '${kind}'.`)
    }
    return path.join(this.rootDir, repositoryId, kind)
  }

  /**
   * True when the lock's recorded owner is verifiably dead, so a stale-by-
   * mtime lock can be reclaimed safely. Mtime alone is not sufficient: a
   * merely-slow holder (past LOCK_STALE_MS) must never lose its lock to a
   * waiter, and a reused pid fails closed — the waiter times out instead of
   * corrupting the live holder's critical section.
   */
  private isFilesystemLockOwnerDead(ownerFilePath: string): boolean {
    let owner: { pid?: unknown }
    try {
      owner = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as {
        pid?: unknown
      }
    } catch {
      // Missing or unreadable owner file (lock directories that predate the
      // owner record): fall back to the mtime-only staleness behavior.
      return true
    }
    if (
      typeof owner.pid !== 'number' ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0
    ) {
      return true
    }
    try {
      process.kill(owner.pid, 0)
      // A live process owns the lock: do not steal it.
      return false
    } catch (killError) {
      // ESRCH: no such process — safe to reclaim. Any other error (EPERM,
      // ...) is indeterminate: fail closed and leave the lock alone.
      return (killError as NodeJS.ErrnoException).code === 'ESRCH'
    }
  }

  /**
   * Reclaim a stale lock by renaming the lock dir out of its namespace — but
   * only when the displaced copy still records a verifiably dead owner at
   * delete time (reliability finding
   * harness-lock-reclaim-unverified-delete). The rename is atomic: a
   * competing waiter can never re-acquire between the owner verification and
   * the delete, because both act on a private displaced copy instead of the
   * shared lock path. A displaced live owner's lock dir is restored to the
   * lock path so the re-acquired holder keeps its critical section. Returns
   * true when the caller may proceed to (re)acquire: either the stale lock
   * was deleted here, or it had already vanished (reclaimed by another
   * waiter).
   */
  private reclaimStaleFilesystemLock(lockPath: string): boolean {
    const displacedPath = `${lockPath}.reclaim.${process.pid}.${randomUUID()}`
    try {
      fs.renameSync(lockPath, displacedPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // The lock is gone: another waiter already reclaimed it.
        return true
      }
      throw error
    }
    // The owner record is re-verified on the displaced private copy, so the
    // verdict cannot race a re-acquiring waiter writing a fresh owner record
    // at the shared lock path.
    if (this.isFilesystemLockOwnerDead(path.join(displacedPath, 'owner.json'))) {
      fs.rmSync(displacedPath, { recursive: true, force: true })
      return true
    }
    // The displaced lock records a live owner: a competing waiter re-acquired
    // between the caller's staleness check and this rename. Restore its lock
    // dir untouched; if the lock path was taken again in the meantime the
    // restore fails harmlessly and the displaced dir is left in place rather
    // than deleting a live lock.
    try {
      fs.renameSync(displacedPath, lockPath)
    } catch {
      // Restore raced a newer waiter's re-acquire: the lock path is occupied
      // by a newer holder's lock and the displaced copy is private scratch
      // that can no longer be restored. Remove it instead of leaking
      // unbounded `.reclaim.*` dirs in the store dir (reliability finding
      // reclaim-displaced-lock-leak-on-restore-race).
      try {
        fs.rmSync(displacedPath, { recursive: true, force: true })
      } catch {
        // Best effort: the next successful reclaim of this lock path cleans
        // up any residual scratch.
      }
    }
    return false
  }

  private withFilesystemLock<T>(lockPath: string, operation: () => T): T {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
    const startedAt = Date.now()
    const ownerToken = randomUUID()
    const ownerFilePath = path.join(lockPath, 'owner.json')
    while (true) {
      try {
        // Acquire in its own step: a mkdir failure that is not EEXIST is an
        // environment refusal (EACCES/EMFILE/ENOSPC, ...). The directory at
        // lockPath — if any — is not ours, so it must never be deleted here:
        // an unconditional cleanup could remove a competing waiter's freshly
        // acquired lock and break mutual exclusion (reliability finding
        // harness-lock-cleanup-on-non-eexist-acquire-failure).
        fs.mkdirSync(lockPath, { mode: 0o700 })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') {
          throw error
        }
        try {
          const age = Date.now() - fs.statSync(lockPath).mtimeMs
          // Staleness alone is not enough to reclaim: a merely-slow live
          // holder (or a pid-reused one) must keep its critical section.
          // The recorded owner must also be verifiably dead.
          if (
            age > LOCK_STALE_MS &&
            this.isFilesystemLockOwnerDead(ownerFilePath)
          ) {
            // Rename-verified reclaim: the lock dir is moved aside atomically
            // and the owner record is re-verified on the displaced copy at
            // delete time, so a competing waiter that already reclaimed and
            // re-acquired never loses its live lock here.
            if (this.reclaimStaleFilesystemLock(lockPath)) continue
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw statError
        }
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error(
            `Timed out acquiring harness store lock '${lockPath}'.`,
          )
        }
        Atomics.wait(lockWaitArray, 0, 0, LOCK_WAIT_MS)
        continue
      }
      // This acquire owns the lock dir: write the owner record. If the write
      // fails, remove the dir only when it still carries this acquire's
      // token, so a waiter can never delete an unowned-looking lock that
      // another process actually holds (reliability finding
      // local-harness-lock-unverified-owner-write).
      try {
        fs.writeFileSync(
          ownerFilePath,
          JSON.stringify({
            pid: process.pid,
            acquiredAt: Date.now(),
            token: ownerToken,
          }),
          { mode: 0o600 },
        )
        break
      } catch (error) {
        try {
          const owner = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as {
            token?: unknown
          }
          if (owner.token === ownerToken) {
            fs.rmSync(lockPath, { recursive: true, force: true })
          }
        } catch {
          // Owner record unreadable or already gone: leave the lock dir alone.
        }
        throw error
      }
    }

    try {
      return operation()
    } finally {
      // Ownership-verified release: remove the lock only when it still
      // carries this acquire's token, so a holder that was stolen from can
      // never delete the new owner's lock on exit.
      let stillOwned = false
      try {
        const owner = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as {
          token?: unknown
        }
        stillOwned = owner.token === ownerToken
      } catch {
        // Owner record unreadable or already removed: the lock was reclaimed
        // by another process — do not delete a lock we may no longer own.
        stillOwned = false
      }
      if (stillOwned) {
        fs.rmSync(lockPath, { recursive: true, force: true })
      }
    }
  }

  withKindLock<T>(
    repositoryId: string,
    kind: HarnessRecordKind,
    operation: () => T,
  ): T {
    const dir = this.kindDirectory(repositoryId, kind)
    return this.withFilesystemLock(`${dir}.lock`, operation)
  }

  read(
    repositoryId: string,
    kind: HarnessRecordKind,
    id: string,
  ): LocalHarnessRecord | undefined {
    const filePath = this.recordPath(repositoryId, kind, id)
    if (!fs.existsSync(filePath)) return undefined
    const parsed = recordSchema
      .passthrough()
      .safeParse(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    if (!parsed.success) {
      throw new Error(
        `Invalid harness record at ${filePath}: ${parsed.error.message}`,
      )
    }
    return parsed.data
  }

  list(repositoryId: string, kind: HarnessRecordKind): LocalHarnessRecord[] {
    return this.listWithDiagnostics(repositoryId, kind).records
  }

  listWithDiagnostics(
    repositoryId: string,
    kind: HarnessRecordKind,
  ): { records: LocalHarnessRecord[]; diagnostics: HarnessStoreDiagnostic[] } {
    const dir = this.kindDirectory(repositoryId, kind)
    if (!fs.existsSync(dir)) return { records: [], diagnostics: [] }
    const records: LocalHarnessRecord[] = []
    const diagnostics: HarnessStoreDiagnostic[] = []
    for (const name of fs
      .readdirSync(dir)
      .filter((entry) => entry.endsWith('.json'))
      .sort()) {
      const filePath = path.join(dir, name)
      try {
        const record = this.read(repositoryId, kind, name.slice(0, -5))
        if (record) records.push(record)
      } catch (error) {
        const quarantineDir = path.join(dir, '.corrupt')
        const quarantinedPath = path.join(
          quarantineDir,
          `${name}.${Date.now()}.${randomUUID()}`,
        )
        try {
          fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 })
          fs.renameSync(filePath, quarantinedPath)
          diagnostics.push({
            filePath,
            quarantinedPath,
            message: error instanceof Error ? error.message : String(error),
          })
        } catch (quarantineError) {
          diagnostics.push({
            filePath,
            message: `${error instanceof Error ? error.message : String(error)}; quarantine failed: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`,
          })
        }
      }
    }
    return { records, diagnostics }
  }

  put<T extends LocalHarnessRecord>(
    kind: HarnessRecordKind,
    record: T,
    expectedRevision?: number,
  ): T {
    const parsed = recordSchema.passthrough().parse(record) as T
    const filePath = this.recordPath(parsed.repositoryId, kind, parsed.id)
    return this.withFilesystemLock(`${filePath}.lock`, () => {
      const existing = this.read(parsed.repositoryId, kind, parsed.id)
      if (existing) {
        if (expectedRevision === undefined) {
          throw new Error(
            `Harness record '${parsed.id}' already exists; expectedRevision is required.`,
          )
        }
        if (existing.revision !== expectedRevision) {
          throw new Error(
            `Harness record revision conflict: expected ${expectedRevision}, current ${existing.revision}.`,
          )
        }
        if (parsed.revision !== existing.revision + 1) {
          throw new Error(
            `Harness record '${parsed.id}' must advance revision from ${existing.revision} to ${existing.revision + 1}.`,
          )
        }
        if (existing.repositoryId !== parsed.repositoryId) {
          throw new Error('Harness records cannot move between repositories.')
        }
      } else if (parsed.revision !== 0) {
        throw new Error('New harness records must start at revision 0.')
      }
      writeJsonAtomic(filePath, parsed)
      return parsed
    })
  }
}
