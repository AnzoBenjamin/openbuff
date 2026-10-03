/**
 * P2-T5: durable transaction-intent log for crash-atomic multi-file
 * transactions.
 *
 * A tiny JSON-lines log, colocated with the harness state dir (never inside
 * the project tree it guards), that records the pre-image of every staged
 * path BEFORE the first file of a multi-file transaction commits:
 *
 *   {"kind":"tx_begin","transactionId":...,"operationId":...,"callId":...,"startedAt":...,"entries":[{"path":...,"beforeHash":...,"beforeBytes":...}]}
 *   {"kind":"tx_commit","transactionId":...,"committedAt":...}
 *   {"kind":"tx_abort","transactionId":...,"abortedAt":...,"reason":...}
 *
 * The point is making rollback bytes DURABLE: the in-memory rollback already
 * holds pre-images, but a crash between the first and last file commit loses
 * them. With an intent log, a later process sees a transaction whose LAST
 * event is tx_begin (half-applied) and can revert each path from the recorded
 * before-bytes (null = the path did not exist before, so undo = delete).
 * Recovery is LIVENESS-GUARDED: every tx_begin records the owning process id
 * AND that process instance's liveness token (a random per-process-lifetime
 * id also published to a `.live-<pid>` file next to the log BEFORE the
 * tx_begin is appended), and a half-applied transaction whose owner is a
 * live process OTHER than this one is left alone — a sibling process sharing
 * this state dir may be mid multi-file commit (its tx_commit has not been
 * appended yet), so startup recovery must never revert files that
 * transaction already committed. A transaction whose ownerPid is THIS
 * process is the process's own half-applied work and stays recoverable by
 * its own recovery and revertTransaction path. The pid alone is NOT a
 * sufficient liveness identity — operating systems recycle pids, so a dead
 * writer's recycled pid would make every later recovery skip the revert
 * forever. Recovery therefore treats the recorded owner as alive only when
 * the pid is alive AND the `.live-<pid>` token file still carries the exact
 * token the tx_begin recorded; a missing or different token means the pid
 * now belongs to a different (recycled) process and the half-applied
 * transaction is reverted. Residual window: a recycled pid whose new
 * occupant never touches this log still publishes no fresh token, so its
 * predecessor's stale token keeps deferring the revert until the occupant
 * touches the log or dies. A legacy tx_begin without a recorded token keeps
 * the old conservative skip-while-pid-alive behavior. Once the owner dies, a
 * later recovery reverts the transaction.
 *
 * Invariants:
 * - only before-images are stored (never after-bytes), and no cap.v3 secrets:
 *   paths, hashes and pre-images only.
 * - every append is tmp+rename atomic and fsynced: the tmp file's data is
 *   fsynced before the rename and the containing directory is fsynced after
 *   (best effort, on platforms that support directory fsync), so the durable
 *   pre-image survives power loss and not just process crashes; a crash
 *   mid-append leaves the previous log intact.
 * - appends are serialized by an exclusive-create lock file next to the log,
 *   so concurrent appenders (a parallel changeFiles transaction, or a second
 *   openbuff process sharing the harness state dir) can never interleave the
 *   read-rewrite and silently drop another transaction's tx_begin or
 *   tx_commit/tx_abort line; the lock file records its holder's process id
 *   AND that process instance's liveness token, so a lock whose holder is
 *   PROVABLY DEAD is broken immediately, a lock whose recorded pid was
 *   RECYCLED to a different process (the token file that pid publishes no
 *   longer carries the recorded token) is broken instead of wedging every
 *   later append, and a lock with no parsable holder identity is broken once
 *   stale — a LIVE holder's lock is never broken by a waiter (waiting callers
 *   fail with a structured timeout error instead), so a crash can never
 *   permanently wedge the log.
 * - the file is bounded: at most MAX_TRANSACTIONS transactions and MAX_BYTES
 *   total, oldest transactions dropped first. An appended event that cannot
 *   fit the byte cap is REJECTED (ok:false), never silently dropped: dropping
 *   a just-appended tx_begin while reporting success would leave the durable
 *   pre-image unwritten while the commit path believes it exists.
 * - corrupted lines are tolerated (skipped) on read.
 * - no ambient process.env reads: the state dir is injected.
 * - every operation is a never-reject helper returning a structured outcome;
 *   intent-log failures must never break the commit path (fail-open on
 *   logging, fail-closed on the existing in-memory rollback).
 */

import path from 'node:path'
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'

import { stableHash } from '@codebuff/common/util/stable-hash'
import { resolveProjectPath } from '@codebuff/common/util/project-path-containment'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { Logger } from '@codebuff/common/types/contracts/logger'

export const TRANSACTION_INTENT_LOG_MAX_TRANSACTIONS = 100
export const TRANSACTION_INTENT_LOG_MAX_BYTES = 8 * 1024 * 1024
export const TRANSACTION_INTENT_LOG_MAX_ENTRIES_PER_TRANSACTION = 128

/** How long an append waits for a contending lock holder before giving up. */
const TRANSACTION_INTENT_LOG_LOCK_TIMEOUT_MS = 5_000
/**
 * Age after which a lock file with NO parsable holder identity (a legacy or
 * foreign holder, or a read that raced the holder's identity write) is
 * treated as left behind by a crashed process. A lock WITH a holder identity
 * is never broken on age alone — see withIntentLogLock.
 */
const TRANSACTION_INTENT_LOG_LOCK_STALE_MS = 30_000
/** Delay between lock-acquisition retries while another holder is live. */
const TRANSACTION_INTENT_LOG_LOCK_RETRY_DELAY_MS = 25

/**
 * Per-process-lifetime identity token, stamped on this process's tx_begin
 * events and published to the `.live-<pid>` token file next to the log. Two
 * processes — and two incarnations of one recycled pid — never share a
 * token, which is what lets recovery distinguish a live owner from a
 * recycled pid occupying its former slot.
 */
const PROCESS_INSTANCE_TOKEN = crypto.randomUUID()

export type TransactionIntentEntry = {
  path: string
  beforeHash: string | null
  /** Durable pre-image used for undo; omitted means the path did not exist. */
  beforeBytes?: string
  /**
   * Permission bits (the stat mode) of the pre-image, restored on revert so
   * a crash-restored executable keeps its +x bit; omitted for paths that did
   * not exist before the transaction (their undo is a delete).
   */
  beforeMode?: number
}

export type BeginTransactionParams = {
  transactionId: string
  operationId: string
  callId: string
  entries: readonly TransactionIntentEntry[]
}

type TransactionBeginEvent = {
  kind: 'tx_begin'
  transactionId: string
  operationId: string
  callId: string
  startedAt: string
  /**
   * Process id of the writer that appended this tx_begin. Recovery and the
   * lock use it as a liveness guard: a still-alive owner OTHER than this
   * process means the transaction may be mid-commit in a sibling process, so
   * it must not be reverted — an ownerPid equal to process.pid marks this
   * process's own transaction, which its own recovery path still reverts.
   * The lock side is unchanged: a live holder (including this process) is
   * never broken. Omitted in legacy logs.
   */
  ownerPid?: number
  /**
   * Liveness token of the owner's PROCESS INSTANCE (not just its pid):
   * published to the `.live-<pid>` token file next to the log before this
   * tx_begin was appended. Recovery defers the revert only while the
   * recorded pid is alive AND this file still carries this exact token — a
   * missing or different token means the pid was recycled to another
   * process, whose liveness says nothing about the dead original writer.
   * Omitted in legacy logs (which keep the conservative
   * skip-while-pid-alive behavior).
   */
  ownerToken?: string
  entries: TransactionIntentEntry[]
}

type TransactionCommitEvent = {
  kind: 'tx_commit'
  transactionId: string
  committedAt: string
}

type TransactionAbortEvent = {
  kind: 'tx_abort'
  transactionId: string
  abortedAt: string
  reason: string
}

type TransactionIntentEvent =
  | TransactionBeginEvent
  | TransactionCommitEvent
  | TransactionAbortEvent

export type IntentOutcome = { ok: true } | { ok: false; error: string }

export type RecoveredInterruptedTransaction = {
  transactionId: string
  operationId: string
  entries: TransactionIntentEntry[]
  startedAt: string
}

export type RecoveryOutcome =
  | { ok: true; transactions: RecoveredInterruptedTransaction[] }
  | { ok: false; error: string }

export type RevertTransactionOutcome =
  | { ok: true; status: 'reverted' | 'already_resolved'; revertedPaths: number }
  | {
      ok: false
      status: 'revert_failed'
      error: string
      revertedPaths: number
    }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isIntentEntryArray(value: unknown): value is TransactionIntentEntry[] {
  if (!Array.isArray(value)) return false
  return value.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const record = entry as Record<string, unknown>
    if (!isNonEmptyString(record.path)) return false
    if (record.beforeHash !== null && typeof record.beforeHash !== 'string') {
      return false
    }
    if (record.beforeBytes !== undefined && typeof record.beforeBytes !== 'string') {
      return false
    }
    if (
      record.beforeMode !== undefined &&
      (typeof record.beforeMode !== 'number' ||
        !Number.isInteger(record.beforeMode) ||
        record.beforeMode < 0)
    ) {
      return false
    }
    return true
  })
}

/**
 * Read-side event validation. Corrupted or unrecognized lines are skipped by
 * the caller; this only accepts well-formed events so recovery never acts on
 * a half-written line.
 */
function isIntentEvent(value: unknown): value is TransactionIntentEvent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.kind === 'tx_begin') {
    return (
      isNonEmptyString(record.transactionId) &&
      isNonEmptyString(record.operationId) &&
      isNonEmptyString(record.callId) &&
      typeof record.startedAt === 'string' &&
      isIntentEntryArray(record.entries) &&
      (record.ownerPid === undefined ||
        (typeof record.ownerPid === 'number' &&
          Number.isInteger(record.ownerPid) &&
          record.ownerPid > 0)) &&
      (record.ownerToken === undefined || isNonEmptyString(record.ownerToken))
    )
  }
  if (record.kind === 'tx_commit') {
    return (
      isNonEmptyString(record.transactionId) &&
      typeof record.committedAt === 'string'
    )
  }
  if (record.kind === 'tx_abort') {
    return (
      isNonEmptyString(record.transactionId) &&
      typeof record.abortedAt === 'string' &&
      typeof record.reason === 'string'
    )
  }
  return false
}

/**
 * Groups events into transactions in file order: a transaction starts at its
 * tx_begin and runs until the next tx_begin. Terminal events without a
 * preceding begin (e.g. leftovers after a trim) are dropped.
 */
function groupTransactionEvents(
  events: readonly TransactionIntentEvent[],
): TransactionIntentEvent[][] {
  const groups: TransactionIntentEvent[][] = []
  let current: TransactionIntentEvent[] | undefined
  for (const event of events) {
    if (event.kind === 'tx_begin') {
      current = [event]
      groups.push(current)
      continue
    }
    current?.push(event)
  }
  return groups
}

function measuredBytes(groups: readonly TransactionIntentEvent[][]): number {
  let total = 0
  for (const group of groups) {
    for (const event of group) {
      total += Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8')
    }
  }
  return total
}

/**
 * Bounded-file policy: drop the OLDEST transactions first until the log fits
 * both the transaction-count cap and the byte cap. Returns the SURVIVING
 * groups (not pre-serialized lines) so appendEvent can tell whether the
 * just-appended event survived the trim.
 */
function boundTransactionGroups(
  groups: readonly TransactionIntentEvent[][],
  maxTransactions: number,
  maxBytes: number,
): TransactionIntentEvent[][] {
  const bounded = [...groups]
  while (
    bounded.length > 0 &&
    (bounded.length > maxTransactions || measuredBytes(bounded) > maxBytes)
  ) {
    bounded.shift()
  }
  return bounded
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Cross-process liveness probe used by the lock and recovery guards: signal 0
 * never kills, it only tests existence. ESRCH means no such process (dead);
 * EPERM means the process exists but may not be signaled (alive). Any other
 * error is treated as ALIVE — a liveness guard must never break a lock or
 * revert a transaction on a false "dead" answer. Exported for tests.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown } | undefined)?.code !== 'ESRCH'
  }
}

/**
 * Identity a lock holder records in the lock file: `<pid> <instance-token>`.
 * `token` is absent in legacy lock files written by older builds (pid only).
 */
type IntentLogLockHolder = { pid: number; token?: string }

/**
 * Reads the holder identity a live holder writes into the lock file.
 * Returns undefined when the file is empty, unparsable, or unreadable —
 * callers then fall back to the age-based staleness window instead of
 * probing a guessed identity.
 */
async function readIntentLogLockHolder(
  lockPath: string,
): Promise<IntentLogLockHolder | undefined> {
  try {
    const raw = (await readFile(lockPath, 'utf8')).trim()
    if (!raw) return undefined
    const [pidField, tokenField] = raw.split(/\s+/)
    const pid = Number(pidField)
    if (!Number.isInteger(pid) || pid <= 0) return undefined
    return tokenField ? { pid, token: tokenField } : { pid }
  } catch {
    return undefined
  }
}

/**
 * Seam parameters the lock needs to tell a LIVE holder from a RECYCLED pid
 * occupying its slot: the holder identity to record, and the instance-token
 * publication/read seams shared with the recovery liveness guard.
 */
type IntentLogLockSeams = {
  ownerPid: number
  ownerToken: string
  /** Best-effort publication of the holder's `.live-<pid>` token file. */
  publishOwnerToken: () => Promise<void>
  /** Reads the instance token a pid currently publishes (undefined if none). */
  readOwnerToken: (pid: number) => Promise<string | undefined>
}

/**
 * Cross-process mutual exclusion for the whole-file read-rewrite append. The
 * lock is an exclusive-create (O_EXCL) sentinel file next to the log: atomic
 * on every supported filesystem, with no native flock dependency. The holder
 * records `<pid> <instance-token>` in the file — and publishes its
 * `.live-<pid>` token file BEFORE that identity becomes readable — and a
 * waiter breaks the lock only when:
 * - the recorded pid no longer exists (the holder is PROVABLY DEAD), OR
 * - the pid is alive but the recorded instance token no longer matches the
 *   token file that pid currently publishes — the pid was RECYCLED to a
 *   different process, whose liveness says nothing about the dead original
 *   holder. Without this check a recycled pid would look alive forever and
 *   every later append would time out, silently disabling durable pre-image
 *   recording.
 * A legacy pid-only identity keeps the old conservative behavior (a live pid
 * is never broken on age alone, since it cannot be distinguished from a
 * recycled one), and a file with NO parsable identity is broken once stale.
 * A LIVE holder whose token still matches is never broken: contention that
 * outlives TRANSACTION_INTENT_LOG_LOCK_TIMEOUT_MS throws so appendEvent can
 * surface a structured ok:false instead of racing another writer and
 * dropping its event.
 */
const withIntentLogLock = async <T>(
  lockPath: string,
  operation: () => Promise<T>,
  seams: IntentLogLockSeams,
  timeoutMs: number = TRANSACTION_INTENT_LOG_LOCK_TIMEOUT_MS,
): Promise<T> => {
  await mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let handle: FileHandle
    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined
      if (code !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for the transaction intent log lock`,
        )
      }
      try {
        const lockStat = await stat(lockPath)
        const holder = await readIntentLogLockHolder(lockPath)
        const breakLock =
          holder === undefined
            ? // No parsable holder identity (legacy or foreign holder, or a
              // read that raced the holder's identity write): fall back to
              // the age-based staleness window.
              Date.now() - lockStat.mtimeMs >=
              TRANSACTION_INTENT_LOG_LOCK_STALE_MS
            : !isProcessAlive(holder.pid)
              ? // Provably dead holder: break immediately.
                true
              : holder.token === undefined
                ? // Legacy pid-only identity: a live pid cannot be
                  // distinguished from a recycled one, so keep the old
                  // conservative never-break-on-age behavior.
                  false
                : // Live pid whose published instance token no longer
                  // matches the recorded one: the pid was recycled to a
                  // different process; break instead of wedging forever.
                  (await seams.readOwnerToken(holder.pid)) !== holder.token
        if (breakLock) {
          await unlink(lockPath).catch(() => undefined)
        }
      } catch {
        // The lock vanished between the failed create and the stat: retry.
      }
      await sleep(TRANSACTION_INTENT_LOG_LOCK_RETRY_DELAY_MS)
      continue
    }
    try {
      // Publish the instance token BEFORE the lock identity becomes
      // readable: a waiter that reads `<pid> <token>` must find a matching
      // token file, or it would break the lock of a LIVE holder.
      await seams.publishOwnerToken()
      // Record the holder identity immediately: a concurrent waiter that
      // reads the lock probes the recorded identity instead of guessing
      // from file age, so a long-but-live append can never lose its lock to
      // a waiter that crossed the staleness window.
      await handle
        .write(`${seams.ownerPid} ${seams.ownerToken}\n`, 0, 'utf8')
        .catch(() => undefined)
      return await operation()
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
    }
  }
}

export type TransactionIntentLog = {
  /** Absolute path of the underlying JSON-lines file (exposed for tests). */
  readonly filePath: string
  beginTransaction(params: BeginTransactionParams): Promise<IntentOutcome>
  commitTransaction(transactionId: string): Promise<IntentOutcome>
  abortTransaction(transactionId: string, reason: string): Promise<IntentOutcome>
  recoverInterruptedTransactions(): Promise<RecoveryOutcome>
  revertTransaction(
    transactionId: string,
    revert: (
      path: string,
      beforeBytes: string | null,
      beforeMode?: number,
    ) => Promise<void>,
  ): Promise<RevertTransactionOutcome>
}

export function createTransactionIntentLog(params: {
  /** State directory that owns the log; injected, never read from process.env. */
  stateDir: string
  fileName?: string
  now?: () => string
  maxTransactions?: number
  maxBytes?: number
  /**
   * Owner process id stamped on every tx_begin and written into the lock
   * file. Defaults to process.pid; tests inject a dead or live pid to model
   * sibling processes sharing one state dir.
   */
  ownerPid?: number
  /**
   * Owner instance token stamped on every tx_begin and published to the
   * `.live-<pid>` token file. Defaults to this process's per-lifetime token;
   * tests inject a token plus a matching/stale `.live-<pid>` file to model
   * sibling processes and pid reuse sharing one state dir.
   */
  ownerToken?: string
  /** Lock-wait budget override (tests shrink it instead of waiting 5s). */
  lockTimeoutMs?: number
}): TransactionIntentLog {
  const fileName = params.fileName ?? 'transaction-intents.jsonl'
  const filePath = path.join(params.stateDir, fileName)
  const now = params.now ?? (() => new Date().toISOString())
  const ownerPid = params.ownerPid ?? process.pid
  const ownerToken = params.ownerToken ?? PROCESS_INSTANCE_TOKEN
  const maxTransactions =
    params.maxTransactions ?? TRANSACTION_INTENT_LOG_MAX_TRANSACTIONS
  const maxBytes = params.maxBytes ?? TRANSACTION_INTENT_LOG_MAX_BYTES

  /**
   * Token file recording the CURRENT occupant of a pid: `<log>.live-<pid>`.
   * A live owner keeps it carrying its own instance token (re-published on
   * every tx_begin), so a recycled pid's token file either names the new
   * occupant or is missing — both distinguishable from the dead original
   * writer's recorded token.
   */
  const ownerTokenFilePath = (pid: number): string => `${filePath}.live-${pid}`

  const readOwnerTokenFile = async (
    pid: number,
  ): Promise<string | undefined> => {
    try {
      const raw = (await readFile(ownerTokenFilePath(pid), 'utf8')).trim()
      return raw.length > 0 ? raw : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Publish this process instance's liveness identity BEFORE appending a
   * tx_begin, so any tx_begin that exists durably has a matching token file
   * on disk. Best-effort: a failed publication leaves the tx_begin without a
   * matching token, which recovery treats as a recycled pid (revert) — the
   * fail-open direction for reverting the durable pre-image.
   */
  const publishOwnerToken = async (): Promise<void> => {
    try {
      await writeFile(ownerTokenFilePath(ownerPid), `${ownerToken}\n`, 'utf8')
    } catch {
      // Best-effort identity publication; see above.
    }
  }

  const readEvents = async (): Promise<TransactionIntentEvent[]> => {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return []
      }
      throw error
    }
    const events: TransactionIntentEvent[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (isIntentEvent(parsed)) events.push(parsed)
        // A corrupted line is tolerated: skipped, never fatal.
      } catch {
        // Corrupted line tolerated.
      }
    }
    return events
  }

  const writeAtomic = async (content: string): Promise<void> => {
    const tmpPath = path.join(
      params.stateDir,
      `.${fileName}.${crypto.randomUUID()}.tmp`,
    )
    try {
      // Write and FSYNC the tmp file BEFORE the rename: the rename alone
      // makes the new bytes visible but not durable — without flushing the
      // file's data blocks, a power loss (not just a process crash) can leave
      // the renamed log zero-length or truncated and destroy the durable
      // pre-image a half-applied transaction needs to be recovered.
      const handle = await open(tmpPath, 'w')
      try {
        await handle.write(content, 0, 'utf8')
        await handle.sync()
      } finally {
        await handle.close().catch(() => undefined)
      }
      await rename(tmpPath, filePath)
      // Best-effort directory fsync AFTER the rename: on many filesystems
      // the rename itself is not durable until the containing directory is
      // flushed, so a power cycle could otherwise lose the just-appended
      // tx_begin while the caller was told it persisted. Platforms that
      // reject fsync on a directory handle (e.g. Windows) degrade to
      // file-level durability and must not fail the append.
      try {
        const dirHandle = await open(params.stateDir, 'r')
        try {
          await dirHandle.sync()
        } finally {
          await dirHandle.close().catch(() => undefined)
        }
      } catch {
        // Directory fsync unsupported here: file-level durability stands.
      }
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined)
      throw error
    }
  }

  const appendEvent = async (
    event: TransactionIntentEvent,
  ): Promise<IntentOutcome> => {
    try {
      // The whole-file read-rewrite is serialized behind an exclusive-create
      // lock: a concurrent appender (a parallel changeFiles transaction, or a
      // second openbuff process sharing the harness state dir) must never
      // interleave its read with another writer's rename, or one transaction's
      // tx_begin / tx_commit / tx_abort line is silently dropped. A lost
      // tx_begin leaves a half-applied transaction unrecoverable; a lost
      // terminal marker makes startup recovery revert already-committed user
      // changes.
      return await withIntentLogLock(
        `${filePath}.lock`,
        async () => {
        const existing = await readEvents()
        const appendedGroup: TransactionIntentEvent[] = [event]
        const groups = [...groupTransactionEvents(existing), appendedGroup]
        const bounded = boundTransactionGroups(groups, maxTransactions, maxBytes)
        // The trim drops OLDEST groups first, so the just-appended event
        // survives unless it alone cannot fit the byte cap. Dropping it while
        // reporting ok:true would leave the durable tx_begin unwritten while
        // the commit path proceeds believing a durable pre-image exists (and
        // startup recovery would find no intent for a half-applied
        // transaction), so an oversized event is a structured failure and the
        // log is left byte-identical: existing recoverable transactions are
        // never destroyed to make room for an event that cannot be persisted.
        if (
          bounded.length === 0 ||
          bounded[bounded.length - 1] !== appendedGroup
        ) {
          return {
            ok: false,
            error: `transaction intent event for ${event.transactionId} exceeds the ${maxBytes}-byte intent-log cap; the log was left unchanged`,
          }
        }
        const lines = bounded
          .flat()
          .map((surviving) => JSON.stringify(surviving))
        await mkdir(params.stateDir, { recursive: true })
        await writeAtomic(`${lines.join('\n')}\n`)
        return { ok: true }
        },
        {
          ownerPid,
          ownerToken,
          publishOwnerToken,
          readOwnerToken: readOwnerTokenFile,
        },
        params.lockTimeoutMs,
      )
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const beginTransaction = async (
    transaction: BeginTransactionParams,
  ): Promise<IntentOutcome> => {
    if (
      !isNonEmptyString(transaction.transactionId) ||
      !isNonEmptyString(transaction.operationId) ||
      !isNonEmptyString(transaction.callId)
    ) {
      return {
        ok: false,
        error:
          'beginTransaction requires nonempty transactionId, operationId and callId',
      }
    }
    if (!isIntentEntryArray(transaction.entries)) {
      return {
        ok: false,
        error:
          'beginTransaction entries must be { path, beforeHash, beforeBytes? } records',
      }
    }
    if (
      transaction.entries.length >
      TRANSACTION_INTENT_LOG_MAX_ENTRIES_PER_TRANSACTION
    ) {
      return {
        ok: false,
        error: `beginTransaction exceeds the ${TRANSACTION_INTENT_LOG_MAX_ENTRIES_PER_TRANSACTION}-entry-per-transaction limit`,
      }
    }
    // Publish our instance identity BEFORE the tx_begin is appended so a
    // durable tx_begin always has a matching `.live-<ownerPid>` token file
    // for the recovery guard to verify against.
    await publishOwnerToken()
    return appendEvent({
      kind: 'tx_begin',
      transactionId: transaction.transactionId,
      operationId: transaction.operationId,
      callId: transaction.callId,
      startedAt: now(),
      // Recovery liveness guard: the owning process id lets a later process
      // distinguish a crashed writer (safe to revert) from a LIVE sibling
      // sharing this state dir that may be mid multi-file commit (never
      // revert — its tx_commit has not been appended yet).
      ownerPid,
      // PID-REUSE GUARD: the owner's process-instance token (published to
      // `.live-<ownerPid>` just above) lets recovery tell a still-live owner
      // from a RECYCLED pid occupying the dead writer's slot — a bare pid
      // match would defer the revert forever.
      ownerToken,
      entries: transaction.entries.map((entry) => ({ ...entry })),
    })
  }

  const commitTransaction = async (
    transactionId: string,
  ): Promise<IntentOutcome> => {
    if (!isNonEmptyString(transactionId)) {
      return { ok: false, error: 'commitTransaction requires a transactionId' }
    }
    return appendEvent({
      kind: 'tx_commit',
      transactionId,
      committedAt: now(),
    })
  }

  const abortTransaction = async (
    transactionId: string,
    reason: string,
  ): Promise<IntentOutcome> => {
    if (!isNonEmptyString(transactionId)) {
      return { ok: false, error: 'abortTransaction requires a transactionId' }
    }
    return appendEvent({
      kind: 'tx_abort',
      transactionId,
      abortedAt: now(),
      reason,
    })
  }

  /**
   * Whether a half-applied transaction's recorded owner may still be
   * mid-commit, so recovery must defer the revert. The pid alone is not a
   * sufficient identity (pids are recycled), so the tx_begin's owner token
   * is cross-checked against the `.live-<pid>` token file the owner
   * published before appending:
   * - no recorded owner, or an ownerPid equal to this process: never blocks
   *   (legacy always-revert / this process's own recovery path).
   * - a provably dead owner: does not block; its token file is removed so
   *   token files for dead pids do not accumulate in the state dir.
   * - a legacy row without an owner token: blocks while the pid is alive
   *   (the old conservative behavior — the owner cannot be distinguished
   *   from a recycled pid).
   * - a live pid whose token file is missing or carries a DIFFERENT token:
   *   does not block. The pid was recycled to a different process instance;
   *   the original writer is gone and its half-applied transaction must be
   *   reverted instead of deferred forever behind the recycled pid.
   */
  const ownerBlocksRevert = async (
    begin: TransactionBeginEvent,
  ): Promise<boolean> => {
    if (begin.ownerPid === undefined || begin.ownerPid === process.pid) {
      return false
    }
    if (!isProcessAlive(begin.ownerPid)) {
      await unlink(ownerTokenFilePath(begin.ownerPid)).catch(() => undefined)
      return false
    }
    if (begin.ownerToken === undefined) {
      return true
    }
    const liveToken = await readOwnerTokenFile(begin.ownerPid)
    return liveToken !== undefined && liveToken === begin.ownerToken
  }

  const recoverInterruptedTransactions =
    async (): Promise<RecoveryOutcome> => {
      try {
        const events = await readEvents()
        const begins = new Map<string, TransactionBeginEvent>()
        const lastEvents = new Map<string, TransactionIntentEvent>()
        for (const event of events) {
          if (
            event.kind === 'tx_begin' &&
            !begins.has(event.transactionId)
          ) {
            begins.set(event.transactionId, event)
          }
          lastEvents.set(event.transactionId, event)
        }
        const transactions: RecoveredInterruptedTransaction[] = []
        for (const [transactionId, begin] of begins) {
          // A transaction whose LAST event is tx_begin was interrupted between
          // its first and last file commit (half-applied). Completed or aborted
          // transactions are skipped. LIVENESS GUARD (see ownerBlocksRevert):
          // the revert is deferred only while the recorded owner is provably
          // the SAME live process instance — the pid is alive AND the
          // `.live-<pid>` token file still carries the tx_begin's owner
          // token. A dead owner, or a live pid whose token no longer matches
          // (the pid was recycled to a different process), is reverted from
          // the durable pre-image instead of being deferred forever.
          if (lastEvents.get(transactionId)?.kind !== 'tx_begin') continue
          if (await ownerBlocksRevert(begin)) continue
          transactions.push({
            transactionId,
            operationId: begin.operationId,
            entries: begin.entries,
            startedAt: begin.startedAt,
          })
        }
        return { ok: true, transactions }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

  const revertTransaction = async (
    transactionId: string,
    revert: (
      path: string,
      beforeBytes: string | null,
      beforeMode?: number,
    ) => Promise<void>,
  ): Promise<RevertTransactionOutcome> => {
    const recovery = await recoverInterruptedTransactions()
    if (!recovery.ok) {
      return {
        ok: false,
        status: 'revert_failed',
        error: recovery.error,
        revertedPaths: 0,
      }
    }
    const transaction = recovery.transactions.find(
      (candidate) => candidate.transactionId === transactionId,
    )
    if (!transaction) {
      return { ok: true, status: 'already_resolved', revertedPaths: 0 }
    }
    // Undo in reverse commit order; a failed entry never blocks the remaining
    // undo steps, and the abort marker is always written so recovery does not
    // retry the same half-applied transaction forever.
    let revertedPaths = 0
    let firstError: string | undefined
    for (const entry of [...transaction.entries].reverse()) {
      try {
        await revert(entry.path, entry.beforeBytes ?? null, entry.beforeMode)
        revertedPaths += 1
      } catch (error) {
        firstError ??= error instanceof Error ? error.message : String(error)
      }
    }
    const aborted = await abortTransaction(
      transactionId,
      firstError ? `revert incomplete: ${firstError}` : 'reverted',
    )
    if (firstError) {
      return {
        ok: false,
        status: 'revert_failed',
        error: firstError,
        revertedPaths,
      }
    }
    if (!aborted.ok) {
      return {
        ok: false,
        status: 'revert_failed',
        error: aborted.error,
        revertedPaths,
      }
    }
    return { ok: true, status: 'reverted', revertedPaths }
  }

  return {
    filePath,
    beginTransaction,
    commitTransaction,
    abortTransaction,
    recoverInterruptedTransactions,
    revertTransaction,
  }
}

/**
 * The log is colocated with the harness state dir (outside the project tree
 * it guards) but scoped to ONE workspace: two projects sharing a state dir
 * must never revert each other's half-applied transactions. The stable hash
 * keeps the name filesystem-safe without embedding raw paths.
 */
export function transactionIntentLogFileName(cwd: string): string {
  return `transaction-intents-${stableHash(path.resolve(cwd))}.jsonl`
}

export function createTransactionIntentLogForWorkspace(params: {
  stateDir: string
  cwd: string
}): TransactionIntentLog {
  return createTransactionIntentLog({
    stateDir: params.stateDir,
    fileName: transactionIntentLogFileName(params.cwd),
  })
}

/**
 * Default revert callback for startup recovery: restores the durable
 * pre-image (or deletes when beforeBytes is null) at the given path. Paths in
 * the intent log are project-relative, so they are resolved against cwd. A
 * delete of an already-absent path is tolerated (the undo target state). A
 * recorded beforeMode is restored through fs.setMode so a crash-restored
 * file keeps its original permission bits (e.g. an executable's +x bit).
 *
 * CONTAINMENT GUARD: persisted tx_begin entries are only validated as
 * nonempty strings at write time (the write side resolves each staged path
 * through the containment resolvers, but the persisted bytes carry no such
 * guarantee), so a buggy or tampered-but-well-formed log line must not drive
 * startup recovery to overwrite or delete files outside the workspace the
 * log guards. The entry path is therefore resolved through the canonical
 * containment resolver and REFUSED — fail closed, via a thrown error that
 * the per-entry revert loop converts into a structured revert_failed outcome
 * (the abort marker is still written so the transaction is never replayed) —
 * unless its resolved AND symlink-dereferenced location is inside cwd with
 * `scope: 'project'`.
 */
export async function revertPathToPreImage(params: {
  cwd: string
  fs: Pick<CodebuffFileSystem, 'mkdir' | 'unlink' | 'writeFile' | 'setMode'>
  entryPath: string
  beforeBytes: string | null
  beforeMode?: number
}): Promise<void> {
  const { cwd, fs, entryPath, beforeBytes, beforeMode } = params
  const resolved = resolveProjectPath(cwd, entryPath)
  if (!resolved || resolved.scope !== 'project') {
    throw new Error(
      `transaction intent log entry path is not contained in the workspace; refusing to revert: ${entryPath}`,
    )
  }
  const fullPath = resolved.realFullPath
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  if (beforeBytes === null) {
    try {
      await fs.unlink(fullPath)
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return
      }
      throw error
    }
    return
  }
  await fs.writeFile(fullPath, beforeBytes, 'utf8')
  // MODE RESTORATION: the pre-image entry also carries the file's permission
  // bits, so a crash-restored executable keeps its +x bit (matching the
  // in-memory rollback, which already preserves beforeMode). Best-effort: an
  // adapter without setMode degrades to default permissions rather than
  // failing the revert.
  if (beforeMode !== undefined && fs.setMode) {
    await fs.setMode(fullPath, beforeMode)
  }
}

/**
 * Startup recovery (P2-T5): reverts every half-applied transaction (its last
 * intent event is tx_begin) using the durable pre-images, then marks each one
 * aborted so it is never replayed. Best-effort per transaction and never
 * throws — a failed revert is reported in the outcome and logged, never fatal
 * to startup.
 */
export async function recoverAndRevertInterruptedTransactions(params: {
  intentLog: TransactionIntentLog
  cwd: string
  fs: Pick<CodebuffFileSystem, 'mkdir' | 'unlink' | 'writeFile' | 'setMode'>
  logger?: Pick<Logger, 'debug' | 'warn'>
}): Promise<
  | { ok: true; revertedTransactions: number; revertedPaths: number }
  | {
      ok: false
      error: string
      revertedTransactions: number
      revertedPaths: number
    }
> {
  const { intentLog, cwd, fs, logger } = params
  const recovery = await intentLog.recoverInterruptedTransactions()
  if (!recovery.ok) {
    logger?.warn?.(
      { error: recovery.error },
      'Transaction intent log could not be read; skipping startup recovery of interrupted transactions',
    )
    return {
      ok: false,
      error: recovery.error,
      revertedTransactions: 0,
      revertedPaths: 0,
    }
  }
  let revertedTransactions = 0
  let revertedPaths = 0
  let firstError: string | undefined
  for (const transaction of recovery.transactions) {
    const outcome = await intentLog.revertTransaction(
      transaction.transactionId,
      async (entryPath, beforeBytes, beforeMode) =>
        revertPathToPreImage({ cwd, fs, entryPath, beforeBytes, beforeMode }),
    )
    if (outcome.ok) {
      if (outcome.status === 'reverted') {
        revertedTransactions += 1
        revertedPaths += outcome.revertedPaths
        logger?.debug?.(
          {
            transactionId: transaction.transactionId,
            operationId: transaction.operationId,
            revertedPaths: outcome.revertedPaths,
          },
          'Reverted an interrupted multi-file transaction from the durable intent log',
        )
      }
      continue
    }
    firstError ??= outcome.error
    logger?.warn?.(
      {
        transactionId: transaction.transactionId,
        error: outcome.error,
        revertedPaths: outcome.revertedPaths,
      },
      'Best-effort revert of an interrupted multi-file transaction failed; the abort marker still records the attempt',
    )
  }
  if (firstError) {
    return {
      ok: false,
      error: firstError,
      revertedTransactions,
      revertedPaths,
    }
  }
  return { ok: true, revertedTransactions, revertedPaths }
}
