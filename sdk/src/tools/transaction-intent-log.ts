/**
 * Workspace-scoped, owner-only write-ahead log for sequential file groups.
 * A durable begin records exact pre-images and expected after-state before
 * effects. A matching pre-image needs no write. Restoring a changed path
 * requires an exact, physically attested broker receipt, not just matching bytes.
 *
 * Appends and trims are serialized. Active and unresolved intents cannot be
 * evicted. Before-images contain private source bytes: keep the state directory
 * private. No code here makes arbitrary external filesystem writers cooperate.
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

import { getExactContentHash } from '@codebuff/common/util/content-hash'
import { stableHash } from '@codebuff/common/util/stable-hash'
import { resolveProjectPath } from '@codebuff/common/util/project-path-containment'
import { captureHostMutationBroker } from '../services/host-filesystem'
import {
  isTransactionActionId,
  type TransactionActionCorrelation,
  type TransactionMutationEvidence,
  type TransactionStageProof,
} from '../services/transaction-mutation-proof'
import type {
  CodebuffFileSystem,
  CodebuffTransactionParentIdentity,
} from '@codebuff/common/types/filesystem'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import {
  observeTransactionPath,
  verifyTransactionParent,
} from './transaction-path-identity'

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
 * Bounded retry budget for the tx_commit append: the files are already
 * committed by the time the marker is written, so a transient lock/IO
 * failure is retried with a tiny backoff before the (then lossy) structured
 * failure is surfaced to the caller.
 */
const TRANSACTION_INTENT_LOG_COMMIT_APPEND_ATTEMPTS = 3
const TRANSACTION_INTENT_LOG_COMMIT_RETRY_DELAY_MS = 50

/**
 * Per-process-lifetime identity token, stamped on this process's tx_begin
 * events and published to the `.live-<pid>` token file next to the log. Two
 * processes — and two incarnations of one recycled pid — never share a
 * token, which is what lets recovery distinguish a live owner from a
 * recycled pid occupying its former slot.
 */
const PROCESS_INSTANCE_TOKEN = crypto.randomUUID()
const activeCoordinators = new Map<string, Set<string>>()
// Reserve space for a bounded recovery marker and terminal acknowledgement.
const MODERN_TRANSACTION_HEADROOM = 2048

export type TransactionIntentEntry = {
  path: string
  beforeHash: string | null
  /** Exact UTF-8 pre-image; absent only for a path that did not exist. */
  beforeBytes?: string
  beforeMode?: number
  /** Exact byte hash or confirmed absence. Omission denotes legacy uncertainty. */
  afterHash?: string | null
  afterMode?: number
  parent?: CodebuffTransactionParentIdentity
}

type OwnedIntentEntry = TransactionIntentEntry & { afterHash: string | null }

export type TransactionCurrentState = {
  hash: string | null
  mode?: number
}

export type BeginTransactionParams = {
  transactionId: string
  operationId: string
  callId: string
  entries: readonly TransactionIntentEntry[]
  /** Coordinator owns the group until releaseTransaction, including during awaits. */
  inFlight?: true
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
  inFlight?: true
  entries: TransactionIntentEntry[]
}

type TransactionCommitEvent = {
  kind: 'tx_commit'
  transactionId: string
  committedAt: string
  recovered?: true
}

type TransactionAbortEvent = {
  kind: 'tx_abort'
  transactionId: string
  abortedAt: string
  reason: string
}

/** Historical ambiguous terminal marker; not evidence of a committed group. */
type TransactionAmbiguousCommitEvent = {
  kind: 'tx_ambiguous_commit'
  transactionId: string
  ambiguousAt: string
  /** Staged paths whose current bytes diverged from the recorded pre-image. */
  divergedPaths: string[]
}

type RecoveryRequiredEvent = {
  kind: 'tx_recovery_required'
  transactionId: string
  /** Bounded stage indices, not unconstrained path/error text. */
  unresolved: number[]
  /** Entries known not to have acquired forward authority. */
  unowned: number[]
}

type TransactionDispatchEvent = {
  kind: 'tx_dispatch'
  transactionId: string
  /** Highest staged path index authorized to enter the sequential commit loop. */
  through: number
  /** Absent together on legacy dispatches: those carry no ownership proof. */
  from?: number
  actionId?: string
}

type TransactionIntentEvent =
  | TransactionBeginEvent
  | TransactionDispatchEvent
  | TransactionCommitEvent
  | TransactionAbortEvent
  | TransactionAmbiguousCommitEvent
  | RecoveryRequiredEvent

export type IntentOutcome =
  | { ok: true }
  | { ok: false; error: string; code?: 'capacity' | 'recovery_required' }

export type RecoveredInterruptedTransaction = {
  transactionId: string
  operationId: string
  entries: TransactionIntentEntry[]
  startedAt: string
  dispatchedThrough?: number
  actions?: TransactionActionCorrelation[]
  recovery?: { unresolved: number[]; unowned: number[] }
}

export type RecoveryOutcome =
  | {
      ok: true
      transactions: RecoveredInterruptedTransaction[]
      liveTransactionIds?: string[]
    }
  | { ok: false; error: string }

export type RevertTransactionOutcome =
  | {
      ok: true
      status: 'reverted' | 'already_resolved' | 'recovered_committed'
      revertedPaths: number
      ownedPaths?: string[]
    }
  | {
      ok: false
      status: 'recovery_required'
      error: string
      revertedPaths: number
      unresolvedPaths: string[]
      uncertainty?: 'legacy_missing_after_state'
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
    if (
      record.beforeBytes !== undefined &&
      typeof record.beforeBytes !== 'string'
    ) {
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

function isMode(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0o777
  )
}

function isExactHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

function isParentIdentity(
  value: unknown,
): value is CodebuffTransactionParentIdentity {
  if (!value || typeof value !== 'object') return false
  const parent = value as Record<string, unknown>
  return (
    typeof parent.canonicalPath === 'string' &&
    path.isAbsolute(parent.canonicalPath) &&
    typeof parent.dev === 'string' &&
    /^\d+$/.test(parent.dev) &&
    typeof parent.ino === 'string' &&
    /^\d+$/.test(parent.ino)
  )
}

function validateOwnership(
  entries: readonly TransactionIntentEntry[],
): entries is readonly OwnedIntentEntry[] {
  return (
    entries.length > 0 &&
    new Set(entries.map((entry) => entry.path)).size === entries.length &&
    entries.every(
      (entry) =>
        (entry.beforeHash === null
          ? entry.beforeBytes === undefined && entry.beforeMode === undefined
          : typeof entry.beforeBytes === 'string' &&
            entry.beforeHash === getExactContentHash(entry.beforeBytes) &&
            (entry.beforeMode === undefined || isMode(entry.beforeMode))) &&
        (entry.afterHash === null
          ? entry.afterMode === undefined
          : isExactHash(entry.afterHash) &&
            (entry.afterMode === undefined || isMode(entry.afterMode))) &&
        (entry.parent === undefined || isParentIdentity(entry.parent)),
    )
  )
}

const isRecoveryIndexList = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length <= TRANSACTION_INTENT_LOG_MAX_ENTRIES_PER_TRANSACTION &&
  value.every(
    (index) =>
      Number.isInteger(index) &&
      index >= 0 &&
      index < TRANSACTION_INTENT_LOG_MAX_ENTRIES_PER_TRANSACTION,
  )

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
      (record.ownerToken === undefined ||
        isNonEmptyString(record.ownerToken)) &&
      (record.inFlight === undefined || record.inFlight === true)
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
  if (record.kind === 'tx_dispatch') {
    return (
      isNonEmptyString(record.transactionId) &&
      isRecoveryIndexList([record.through]) &&
      ((record.from === undefined && record.actionId === undefined) ||
        (isTransactionActionId(record.actionId) &&
          isRecoveryIndexList([record.from]) &&
          Number(record.through) - Number(record.from) >= 0 &&
          Number(record.through) - Number(record.from) <= 1))
    )
  }
  if (record.kind === 'tx_recovery_required') {
    return (
      isNonEmptyString(record.transactionId) &&
      isRecoveryIndexList(record.unresolved) &&
      isRecoveryIndexList(record.unowned)
    )
  }
  if (record.kind === 'tx_ambiguous_commit') {
    return (
      isNonEmptyString(record.transactionId) &&
      typeof record.ambiguousAt === 'string' &&
      Array.isArray(record.divergedPaths) &&
      record.divergedPaths.every(isNonEmptyString)
    )
  }
  return false
}

/** Other processes can append between begin and terminal; group by ID. */
function groupTransactionEvents(
  events: readonly TransactionIntentEvent[],
): Map<string, TransactionIntentEvent[]> {
  const groups = new Map<string, TransactionIntentEvent[]>()
  for (const event of events) {
    const group = groups.get(event.transactionId)
    if (group) group.push(event)
    else groups.set(event.transactionId, [event])
  }
  return groups
}

function correlatedActions(
  group: readonly TransactionIntentEvent[],
  entryCount: number,
): TransactionActionCorrelation[] | undefined {
  const actions: TransactionActionCorrelation[] = []
  const ids = new Set<string>()
  let next = 0
  for (const event of group) {
    if (event.kind !== 'tx_dispatch') continue
    const { transactionId, actionId, from, through } = event
    if (
      !actionId ||
      from !== next ||
      through >= entryCount ||
      ids.has(actionId)
    )
      return undefined
    ids.add(actionId)
    actions.push({ transactionId, actionId, from, through })
    next = through + 1
  }
  return actions
}

function measuredBytes(groups: readonly TransactionIntentEvent[][]): number {
  let total = 0
  for (const group of groups) {
    const groupBytes = group.reduce(
      (sum, event) =>
        sum + Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8'),
      0,
    )
    const begin = group[0]
    if (
      begin?.kind === 'tx_begin' &&
      begin.inFlight &&
      !isFinishedTransactionGroup(group)
    ) {
      // One small dispatch event per action, plus rollback/terminal records.
      const reserved =
        Buffer.byteLength(`${JSON.stringify(begin)}\n`, 'utf8') +
        MODERN_TRANSACTION_HEADROOM +
        256 * begin.entries.length
      total += Math.max(groupBytes, reserved)
    } else {
      total += groupBytes
    }
  }
  return total
}

/**
 * Whether a transaction group has seen its terminal event. A group whose
 * events are still only its tx_begin is UNRESOLVED: its owner may be a live
 * sibling mid multi-file commit, so its durable pre-image must survive every
 * trim even when the group is the oldest in the log.
 */
function isFinishedTransactionGroup(
  group: readonly TransactionIntentEvent[],
): boolean {
  const last = group.at(-1)
  return (
    last?.kind === 'tx_commit' ||
    (last?.kind === 'tx_abort' && !last.reason.startsWith('revert incomplete:'))
  )
}

/**
 * Bounded-file policy: drop the OLDEST transactions first until the log fits
 * both the transaction-count cap and the byte cap — but only transactions
 * that already saw their terminal commit/abort are droppable. An unresolved
 * transaction (tx_begin with no terminal event) is never evicted, even when
 * it is the oldest: dropping it would destroy a possibly live transaction's
 * durable pre-image. Returns the SURVIVING groups; the LAST group (the
 * just-appended event) is never dropped here, so if the result still exceeds
 * the caps because nothing droppable remains, the caller rejects the append
 * with a structured outcome instead of writing anything.
 */
function boundTransactionGroups(
  groups: readonly TransactionIntentEvent[][],
  protectedId: string,
  maxTransactions: number,
  maxBytes: number,
): TransactionIntentEvent[][] {
  const bounded = [...groups]
  while (
    bounded.length > 1 &&
    (bounded.length > maxTransactions || measuredBytes(bounded) > maxBytes)
  ) {
    const droppableIndex = bounded.findIndex(
      (group) =>
        group[0]?.transactionId !== protectedId &&
        (group[0]?.kind !== 'tx_begin' || isFinishedTransactionGroup(group)),
    )
    if (droppableIndex === -1) break
    bounded.splice(droppableIndex, 1)
  }
  return bounded
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const recoveryRequired = (
  error: string,
  unresolvedPaths: string[],
  revertedPaths = 0,
): Extract<RevertTransactionOutcome, { ok: false }> => ({
  ok: false,
  status: 'recovery_required',
  error,
  unresolvedPaths,
  revertedPaths,
})

function stateMatches(
  state: TransactionCurrentState,
  hash: string | null,
  mode?: number,
): boolean {
  return state.hash === hash && (mode === undefined || state.mode === mode)
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
 * Re-verifies, immediately before a break unlink, that the lock file is
 * still the SAME lock that was observed at break-decision time: the recorded
 * pid AND instance token must still match. A lock that was released and
 * re-acquired by a fresh holder in between — the pid-recycle race — does not
 * match and is left alone, because unlinking it would delete a fresh
 * holder's lock and allow dual writers. A lock that vanished entirely needs
 * no unlink either; the waiter's next exclusive-create retry simply
 * proceeds. Residual window: a fresh holder that re-created the lock but has
 * not yet written its identity is indistinguishable from the observed
 * identity-less lock; the waiter's next retry re-evaluates it once its
 * identity is parsable, and the timeout path handles any genuinely stale
 * leftover.
 */
async function confirmLockIdentity(
  lockPath: string,
  observed: IntentLogLockHolder | undefined,
): Promise<boolean> {
  const current = await readIntentLogLockHolder(lockPath)
  if (observed === undefined || current === undefined) {
    return observed === undefined && current === undefined
  }
  return current.pid === observed.pid && current.token === observed.token
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
 * Cross-process mutual exclusion for intent-log appends and trims. The
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
 * BREAK CONFIRMATION: even after deciding to break, the waiter re-reads the
 * lock file (see confirmLockIdentity) and unlinks ONLY when the recorded pid
 * AND instance token still match what it observed at decision time — a lock
 * that was released and re-acquired by a fresh holder in between is left
 * intact, because unlinking it would let two writers run concurrently.
 */
const withIntentLogLock = async <T>(
  lockPath: string,
  operation: () => Promise<T>,
  seams: IntentLogLockSeams,
  timeoutMs: number = TRANSACTION_INTENT_LOG_LOCK_TIMEOUT_MS,
  confirmDelayMs: number = 0,
): Promise<T> => {
  await mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let handle: FileHandle
    try {
      // 0o600: artifact files in the shared state dir stay owner-only.
      handle = await open(lockPath, 'wx', 0o600)
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
          // Widen the decision→confirmation window on demand (test seam) so
          // tests can model a fresh holder acquiring the lock in between.
          if (confirmDelayMs > 0) await sleep(confirmDelayMs)
          // IDENTITY CONFIRMATION: the lock may have been released and
          // re-acquired by a DIFFERENT holder between the observation above
          // and this unlink (pid recycle, or a fresh process). Deleting
          // without re-verifying would remove the fresh holder's lock and
          // allow dual writers, so only unlink when the recorded pid AND
          // instance token still match what was observed at break-decision
          // time. Anything else is left alone: the timeout path handles a
          // genuinely stale leftover, and a vanished lock needs no unlink.
          const confirmed = await confirmLockIdentity(lockPath, holder)
          if (confirmed) {
            await unlink(lockPath).catch(() => undefined)
          }
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
  abortTransaction(
    transactionId: string,
    reason: string,
  ): Promise<IntentOutcome>
  authorizeDispatch?(
    transactionId: string,
    through: number,
    correlation?: TransactionActionCorrelation,
  ): Promise<IntentOutcome>
  markRecoveryRequired?(
    transactionId: string,
    unresolved: number[],
    unowned?: number[],
  ): Promise<IntentOutcome>
  releaseTransaction?(transactionId: string): void
  recoverInterruptedTransactions(): Promise<RecoveryOutcome>
  revertTransaction(
    transactionId: string,
    /** Legacy callback; arbitrary adapter writes cannot perform durable recovery. */
    revert: (
      path: string,
      beforeBytes: string | null,
      beforeMode?: number,
      entry?: TransactionIntentEntry,
    ) => Promise<unknown>,
    /** No reader means no ownership proof, never unconditional restoration. */
    readCurrent?: (
      path: string,
      entry: TransactionIntentEntry,
    ) => Promise<string | null | TransactionCurrentState>,
    workspace?: { cwd: string; fs: CodebuffFileSystem },
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
  /**
   * Test seam: delay between a lock breaker's break decision and its
   * re-verification of the lock identity, widening the race window so tests
   * can replace the lock file with a fresh holder's in between.
   */
  lockBreakConfirmDelayMs?: number
  /**
   * Test seam: bounded attempts the tx_commit append makes on a transient
   * lock/IO failure (tests shrink or count the retry budget for speed).
   */
  commitAppendAttempts?: number
  /** Test seam: backoff between tx_commit append retries (ms). */
  commitRetryDelayMs?: number
}): TransactionIntentLog {
  const fileName = params.fileName ?? 'transaction-intents.jsonl'
  const filePath = path.join(params.stateDir, fileName)
  const now = params.now ?? (() => new Date().toISOString())
  const ownerPid = params.ownerPid ?? process.pid
  const ownerToken = params.ownerToken ?? PROCESS_INSTANCE_TOKEN
  const maxTransactions =
    params.maxTransactions ?? TRANSACTION_INTENT_LOG_MAX_TRANSACTIONS
  const maxBytes = params.maxBytes ?? TRANSACTION_INTENT_LOG_MAX_BYTES
  const commitAppendAttempts =
    params.commitAppendAttempts ?? TRANSACTION_INTENT_LOG_COMMIT_APPEND_ATTEMPTS
  const commitRetryDelayMs =
    params.commitRetryDelayMs ?? TRANSACTION_INTENT_LOG_COMMIT_RETRY_DELAY_MS

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

  const publishOwnerToken = async (
    pid = ownerPid,
    token = ownerToken,
  ): Promise<void> => {
    if ((await readOwnerTokenFile(pid)) === token) return
    const tokenPath = ownerTokenFilePath(pid)
    const nextPath = `${tokenPath}.${crypto.randomUUID()}.new`
    try {
      await writeFile(nextPath, `${token}\n`, { mode: 0o600, flag: 'wx' })
      await rename(nextPath, tokenPath)
    } finally {
      await unlink(nextPath).catch(() => undefined)
    }
  }

  const lockSeams = {
    ownerPid,
    ownerToken,
    publishOwnerToken,
    readOwnerToken: readOwnerTokenFile,
  }

  const releaseTransaction = (transactionId: string) => {
    const ids = activeCoordinators.get(filePath)
    ids?.delete(transactionId)
    if (ids?.size === 0) activeCoordinators.delete(filePath)
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
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue // An interrupted append can leave a torn line.
      }
      if (isIntentEvent(parsed)) events.push(parsed)
      else if (
        parsed &&
        typeof parsed === 'object' &&
        'kind' in parsed &&
        (parsed.kind === 'tx_begin' ||
          parsed.kind === 'tx_dispatch' ||
          parsed.kind === 'tx_recovery_required')
      ) {
        throw new Error(
          'Invalid durable transaction intent; recovery cannot prove the workspace state.',
        )
      }
    }
    return events
  }

  /**
   * Best-effort directory fsync: on many filesystems a rename — or a newly
   * created file's directory entry — is not durable until the containing
   * directory is flushed. Platforms that reject fsync on a directory handle
   * (e.g. Windows) degrade to file-level durability and must not fail the
   * append.
   */
  const fsyncDirectory = async (): Promise<void> => {
    try {
      const dirHandle = await open(params.stateDir, 'r')
      try {
        await dirHandle.sync()
      } finally {
        await dirHandle.close().catch(() => undefined)
      }
    } catch (error) {
      // Our Linux durability lane must not acknowledge a failed directory sync.
      if (process.platform === 'linux') throw error
    }
  }

  /**
   * Append-only write of ONE event line: open the log with the 'a' flag,
   * write the line, and fsync it before reporting the append durable. The
   * whole-file rewrite is reserved for the bounded trim — rewriting (and
   * re-fsyncing) the entire log on every append costs O(n^2) cumulative
   * under the 8 MiB cap. A crash mid-append can tear the final line; the
   * next append closes the torn line off with a newline first so the reader
   * skips the fragment instead of concatenating it onto (and thereby
   * dropping) the new event. When this append creates the log file, the
   * containing directory is fsynced best-effort so the new directory entry
   * survives a power cycle too.
   */
  const appendEventLine = async (
    line: string,
    ensureDirectory: boolean,
  ): Promise<void> => {
    let previousSize = 0
    let created = false
    try {
      previousSize = (await stat(filePath)).size
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        created = true
      } else {
        throw error
      }
    }
    // 0o600: the log carries plaintext pre-images of user files (see the
    // module header's residual-risk note).
    const handle = await open(filePath, 'a', 0o600)
    try {
      if (previousSize > 0) {
        const tail = Buffer.alloc(1)
        const readHandle = await open(filePath, 'r')
        try {
          const { bytesRead } = await readHandle.read(
            tail,
            0,
            1,
            previousSize - 1,
          )
          if (bytesRead === 1 && tail[0] !== 0x0a) {
            await handle.write('\n', 0, 'utf8')
          }
        } finally {
          await readHandle.close().catch(() => undefined)
        }
      }
      await handle.writeFile(`${line}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close().catch(() => undefined)
    }
    if (created || ensureDirectory) await fsyncDirectory()
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
      // 0o600: the tmp file becomes the log on rename, and the log carries
      // plaintext pre-images of user files (see the module header).
      const handle = await open(tmpPath, 'wx', 0o600)
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      } finally {
        await handle.close().catch(() => undefined)
      }
      await rename(tmpPath, filePath)
      // Best-effort directory fsync AFTER the rename: on many filesystems
      // the rename itself is not durable until the containing directory is
      // flushed, so a power cycle could otherwise lose the just-appended
      // tx_begin while the caller was told it persisted.
      await fsyncDirectory()
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined)
      throw error
    }
  }

  const appendEvent = async (
    event: TransactionIntentEvent,
  ): Promise<IntentOutcome> => {
    try {
      // The append (and any trim it triggers) is serialized behind an
      // exclusive-create lock: a concurrent appender (a parallel changeFiles
      // transaction, or a second openbuff process sharing the harness state
      // dir) must never interleave its read of the log with another writer's
      // append or rename, or one transaction's tx_begin / tx_commit /
      // tx_abort line is silently dropped. A lost tx_begin leaves a
      // half-applied transaction unrecoverable; a lost terminal marker makes
      // startup recovery revert already-committed user changes.
      return await withIntentLogLock<IntentOutcome>(
        `${filePath}.lock`,
        async () => {
          const existing = await readEvents()
          const groups = groupTransactionEvents(existing)
          const previous = groups.get(event.transactionId) ?? []
          if (event.kind === 'tx_begin' && previous.length) {
            return { ok: false, error: 'Transaction intent ID already exists' }
          }
          if (
            event.kind === 'tx_begin' &&
            event.inFlight &&
            [...groups.values()].some(
              (group) =>
                group[0]?.kind === 'tx_begin' &&
                !isFinishedTransactionGroup(group),
            )
          ) {
            return {
              ok: false,
              code: 'recovery_required',
              error:
                'An unresolved workspace transaction requires reconciliation.',
            }
          }
          if (event.kind === 'tx_dispatch') {
            const begin = previous[0]
            if (
              begin?.kind !== 'tx_begin' ||
              !begin.inFlight ||
              !correlatedActions([...previous, event], begin.entries.length) ||
              (previous.at(-1)?.kind !== 'tx_begin' &&
                previous.at(-1)?.kind !== 'tx_dispatch')
            ) {
              return {
                ok: false,
                error: 'Dispatch cannot advance this transaction intent',
              }
            }
          }
          const replaceRecovery =
            event.kind === 'tx_recovery_required' &&
            previous.some((value) => value.kind === 'tx_recovery_required')
          if (
            event.kind === 'tx_recovery_required' &&
            (previous[0]?.kind !== 'tx_begin' ||
              isFinishedTransactionGroup(previous))
          ) {
            return {
              ok: false,
              error: 'No unfinished intent can accept this recovery marker',
            }
          }
          groups.set(event.transactionId, [
            ...previous.filter(
              (value) =>
                !replaceRecovery || value.kind !== 'tx_recovery_required',
            ),
            event,
          ])
          const bounded = boundTransactionGroups(
            [...groups.values()],
            event.transactionId,
            maxTransactions,
            maxBytes,
          )
          if (
            bounded.length > maxTransactions ||
            measuredBytes(bounded) > maxBytes
          ) {
            return {
              ok: false,
              code: 'capacity',
              error: `transaction intent event for ${event.transactionId} exceeds the ${maxBytes}-byte intent-log cap (max ${maxTransactions} transactions); the log was left unchanged`,
            }
          }
          const line = JSON.stringify(event)
          const logSize = await stat(filePath).then(
            (value) => value.size,
            (error) => {
              if (error?.code === 'ENOENT') return 0
              throw error
            },
          )
          if (
            !replaceRecovery &&
            bounded.length === groups.size &&
            logSize + Buffer.byteLength(line, 'utf8') + 2 <= maxBytes
          ) {
            await appendEventLine(
              line,
              event.kind === 'tx_begin' && event.inFlight === true,
            )
          } else {
            const lines = bounded.flat().map((value) => JSON.stringify(value))
            await writeAtomic(`${lines.join('\n')}\n`)
          }
          return { ok: true }
        },
        lockSeams,
        params.lockTimeoutMs,
        params.lockBreakConfirmDelayMs,
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
    if (
      (transaction.inFlight ||
        transaction.entries.some((entry) => entry.afterHash !== undefined)) &&
      !validateOwnership(transaction.entries)
    ) {
      return {
        ok: false,
        error: 'Invalid before/after ownership in transaction intent',
      }
    }
    if (
      transaction.inFlight &&
      (transaction.transactionId.length > 128 ||
        !transaction.entries.every((entry) => entry.parent !== undefined))
    ) {
      return {
        ok: false,
        error: 'Missing physical parent identity in transaction intent',
      }
    }
    if (transaction.inFlight) {
      let active = activeCoordinators.get(filePath)
      if (!active) activeCoordinators.set(filePath, (active = new Set()))
      if (active.has(transaction.transactionId))
        return { ok: false, error: 'Transaction is already active' }
      active.add(transaction.transactionId)
    }
    const result = await appendEvent({
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
      ...(transaction.inFlight ? { inFlight: true as const } : {}),
      entries: transaction.entries.map((entry) => ({
        ...entry,
        ...(entry.parent ? { parent: { ...entry.parent } } : {}),
      })),
    })
    if (!result.ok && transaction.inFlight)
      releaseTransaction(transaction.transactionId)
    return result
  }

  const commitTransaction = async (
    transactionId: string,
  ): Promise<IntentOutcome> => {
    if (!isNonEmptyString(transactionId)) {
      return { ok: false, error: 'commitTransaction requires a transactionId' }
    }
    // Retry the acknowledgement; the already-written group is not rolled back
    // just because a terminal marker failed to persist.
    let lastOutcome: IntentOutcome = {
      ok: false,
      error: 'commitTransaction did not run',
    }
    for (let attempt = 1; attempt <= commitAppendAttempts; attempt += 1) {
      lastOutcome = await appendEvent({
        kind: 'tx_commit',
        transactionId,
        committedAt: now(),
      })
      if (lastOutcome.ok) return lastOutcome
      if (attempt < commitAppendAttempts) {
        await sleep(commitRetryDelayMs)
      }
    }
    return lastOutcome
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

  const authorizeDispatch = (
    transactionId: string,
    through: number,
    correlation?: TransactionActionCorrelation,
  ): Promise<IntentOutcome> =>
    correlation?.transactionId === transactionId &&
    correlation.through === through &&
    isTransactionActionId(correlation.actionId) &&
    isRecoveryIndexList([correlation.from, through]) &&
    through >= correlation.from &&
    through <= correlation.from + 1 &&
    activeCoordinators.get(filePath)?.has(transactionId)
      ? appendEvent({
          kind: 'tx_dispatch',
          transactionId,
          through,
          from: correlation.from,
          actionId: correlation.actionId,
        })
      : Promise.resolve({
          ok: false,
          error:
            'Dispatch has no active coordinator or valid action correlation',
        })

  const markRecoveryRequired = (
    transactionId: string,
    unresolved: number[],
    unowned: number[] = [],
  ): Promise<IntentOutcome> => {
    if (!isRecoveryIndexList(unresolved) || !isRecoveryIndexList(unowned)) {
      return Promise.resolve({
        ok: false,
        error: 'Invalid transaction recovery indices',
      })
    }
    return appendEvent({
      kind: 'tx_recovery_required',
      transactionId,
      unresolved: [...unresolved],
      unowned: [...unowned],
    })
  }

  const ownerBlocksRevert = async (
    begin: TransactionBeginEvent,
  ): Promise<boolean> => {
    if (begin.ownerPid === undefined) return false
    if (begin.ownerPid === process.pid) {
      return activeCoordinators.get(filePath)?.has(begin.transactionId) ?? false
    }
    if (!isProcessAlive(begin.ownerPid)) return false
    if (begin.ownerToken === undefined) return true
    const liveToken = await readOwnerTokenFile(begin.ownerPid)
    return (
      liveToken === begin.ownerToken ||
      (begin.inFlight === true && liveToken === undefined)
    )
  }

  const recoverInterruptedTransactions = async (): Promise<RecoveryOutcome> => {
    try {
      const transactions: RecoveredInterruptedTransaction[] = []
      const liveTransactionIds: string[] = []
      for (const [transactionId, group] of groupTransactionEvents(
        await readEvents(),
      )) {
        const begin = group[0]
        if (begin?.kind !== 'tx_begin' || isFinishedTransactionGroup(group))
          continue
        if (await ownerBlocksRevert(begin)) {
          liveTransactionIds.push(transactionId)
          continue
        }
        const marker = group.at(-1)
        transactions.push({
          transactionId,
          operationId: begin.operationId,
          entries: begin.entries,
          startedAt: begin.startedAt,
          ...(begin.inFlight
            ? {
                dispatchedThrough:
                  group.findLast((value) => value.kind === 'tx_dispatch')
                    ?.through ?? -1,
                actions: correlatedActions(group, begin.entries.length),
              }
            : {}),
          ...(marker?.kind === 'tx_recovery_required'
            ? {
                recovery: {
                  unresolved: marker.unresolved,
                  unowned: marker.unowned,
                },
              }
            : {}),
        })
      }
      return {
        ok: true,
        transactions,
        ...(liveTransactionIds.length ? { liveTransactionIds } : {}),
      }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  const revertTransaction: TransactionIntentLog['revertTransaction'] = async (
    transactionId,
    _revert,
    readCurrent,
    workspace,
  ) => {
    try {
      return await withIntentLogLock<RevertTransactionOutcome>(
        `${filePath}.recovery.lock`,
        async () => {
          const recovery = await recoverInterruptedTransactions()
          if (!recovery.ok) return recoveryRequired(recovery.error, [])
          if (recovery.liveTransactionIds?.includes(transactionId)) {
            return recoveryRequired(
              'Transaction is still owned by a live coordinator.',
              [],
            )
          }
          const transaction = recovery.transactions.find(
            (candidate) => candidate.transactionId === transactionId,
          )
          if (!transaction)
            return { ok: true, status: 'already_resolved', revertedPaths: 0 }
          const { entries } = transaction
          const paths = entries.map((entry) => entry.path)
          if (!validateOwnership(entries)) {
            return {
              ...recoveryRequired(
                'Transaction lacks verified before/after ownership.',
                paths,
              ),
              ...(entries.some((entry) => entry.afterHash === undefined)
                ? { uncertainty: 'legacy_missing_after_state' as const }
                : {}),
            }
          }
          if (!readCurrent)
            return recoveryRequired(
              'Transaction recovery has no current-state reader.',
              paths,
            )

          const classify = async (entry: OwnedIntentEntry) => {
            const read = await readCurrent(entry.path, entry)
            const state =
              typeof read === 'object' && read !== null
                ? read
                : { hash: read === null ? null : getExactContentHash(read) }
            return {
              before: stateMatches(state, entry.beforeHash, entry.beforeMode),
              after: stateMatches(state, entry.afterHash, entry.afterMode),
            }
          }
          const owned = new Map<number, TransactionStageProof>()
          const unresolved: number[] = []
          const unowned = transaction.recovery?.unowned ?? []
          const broker = workspace && captureHostMutationBroker(workspace.fs)
          let firstError: string | undefined
          let allAfter = true
          const ownedEntries: readonly OwnedIntentEntry[] = entries
          for (const [index, entry] of ownedEntries.entries()) {
            try {
              const match = await classify(entry)
              allAfter &&= match.after
              const correlation = transaction.actions?.find(
                ({ from, through }) => index >= from && index <= through,
              )
              // A same-byte update need not be undone if it is already at its
              // preimage, but cannot attest a recovered commit without a receipt.
              if (match.before && (!match.after || transaction.recovery))
                continue
              if (
                workspace &&
                broker &&
                match.after &&
                correlation &&
                !unowned.includes(index)
              ) {
                const proof = {
                  evidence: {
                    correlation,
                    stages: entries.slice(
                      correlation.from,
                      correlation.through + 1,
                    ),
                  },
                  index,
                  fullPath: await verifyTransactionParent(
                    workspace.cwd,
                    workspace.fs,
                    entry.path,
                    entry.parent!,
                  ),
                }
                try {
                  await broker.verifyTransactionStage(proof)
                  owned.set(index, proof)
                  continue
                } catch (error) {
                  if (!match.before) throw error
                }
              }
              if (match.before) {
                allAfter = false
                continue
              }
              firstError ??= `Foreign or unowned transaction state at ${entry.path}.`
            } catch (error) {
              firstError ??= errorText(error)
            }
            unresolved.push(index)
            allAfter = false
          }
          // A lost terminal acknowledgement is not a rollback, unless recovery
          // or the original coordinator already durably chose compensation.
          if (
            !transaction.recovery &&
            allAfter &&
            broker &&
            owned.size === entries.length &&
            transaction.dispatchedThrough === entries.length - 1
          ) {
            const commit = await broker.withVerifiedTransactionCommit(
              [...owned.values()],
              () =>
                appendEvent({
                  kind: 'tx_commit',
                  transactionId,
                  committedAt: now(),
                  recovered: true,
                }),
            )
            return commit.ok
              ? { ok: true, status: 'recovered_committed', revertedPaths: 0 }
              : recoveryRequired(commit.error, paths)
          }
          if ((owned.size || unresolved.length) && !transaction.recovery) {
            const marker = await markRecoveryRequired(
              transactionId,
              [...owned.keys(), ...unresolved].sort((a, b) => a - b),
              unowned,
            )
            if (!marker.ok) return recoveryRequired(marker.error, paths)
          }

          let revertedPaths = 0
          for (const [index, proof] of [...owned].toReversed()) {
            const entry = ownedEntries[index]!
            try {
              revertedPaths += await restoreOwnedTransactionPath(
                workspace!.cwd,
                workspace!.fs,
                entry,
                proof.evidence,
                index,
              )
            } catch (error) {
              firstError ??= errorText(error)
              unresolved.push(index)
            }
          }
          if (unresolved.length) {
            const recorded = await markRecoveryRequired(
              transactionId,
              unresolved.sort((a, b) => a - b),
              unowned,
            )
            return recoveryRequired(
              recorded.ok
                ? (firstError ?? 'Transaction recovery is incomplete.')
                : `${firstError ?? 'Transaction recovery is incomplete.'} (${recorded.error})`,
              unresolved.map((index) => paths[index]!),
              revertedPaths,
            )
          }
          const acknowledgeAbort = () =>
            abortTransaction(transactionId, 'reverted or already at pre-image')
          const aborted = broker
            ? await broker
                .withVerifiedTransactionAbort(
                  transactionId,
                  entries,
                  acknowledgeAbort,
                )
                .catch((error: unknown) => ({
                  ok: false as const,
                  error: errorText(error),
                }))
            : await acknowledgeAbort()
          return aborted.ok
            ? {
                ok: true,
                status: 'reverted',
                revertedPaths,
                ownedPaths: [...owned.keys()].map((index) => paths[index]!),
              }
            : recoveryRequired(aborted.error, paths, revertedPaths)
        },
        {
          ownerPid: process.pid,
          ownerToken: PROCESS_INSTANCE_TOKEN,
          publishOwnerToken: () =>
            publishOwnerToken(process.pid, PROCESS_INSTANCE_TOKEN),
          readOwnerToken: readOwnerTokenFile,
        },
        params.lockTimeoutMs,
        params.lockBreakConfirmDelayMs,
      )
    } catch (error) {
      return recoveryRequired(errorText(error), [])
    }
  }

  return {
    filePath,
    beginTransaction,
    commitTransaction,
    abortTransaction,
    authorizeDispatch,
    markRecoveryRequired,
    releaseTransaction,
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
 * The entry path is contained through resolveContainedEntryPath (fail
 * closed; see there).
 */
/**
 * Resolves a persisted intent-log entry path against the workspace its log
 * guards. Persisted tx_begin entries are only validated as nonempty strings
 * at write time (the write side resolves each staged path through the
 * containment resolvers, but the persisted bytes carry no such guarantee),
 * so a buggy or tampered-but-well-formed log line must not reach files
 * outside the workspace: the path is resolved through the canonical
 * containment resolver and REFUSED — fail closed, via a thrown error —
 * unless its resolved AND symlink-dereferenced location is inside cwd with
 * `scope: 'project'`. Shared by the revert and the lossless-aware current-
 * content inspection, so a tampered path can neither be written nor probed
 * outside the workspace.
 */
function resolveContainedEntryPath(cwd: string, entryPath: string) {
  const resolved = resolveProjectPath(cwd, entryPath)
  if (!resolved || resolved.scope !== 'project') {
    throw new Error(
      `transaction intent log entry path is not contained in the workspace; refusing: ${entryPath}`,
    )
  }
  return resolved
}

export async function revertPathToPreImage(params: {
  cwd: string
  fs: Pick<CodebuffFileSystem, 'mkdir' | 'unlink' | 'writeFile' | 'setMode'>
  entryPath: string
  beforeBytes: string | null
  beforeMode?: number
}): Promise<void> {
  const { cwd, fs, entryPath, beforeBytes, beforeMode } = params
  const fullPath = resolveContainedEntryPath(cwd, entryPath).realFullPath
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

/** Restore through the captured adapter with a second parent/after-state check. */
export async function restoreOwnedTransactionPath(
  cwd: string,
  fs: CodebuffFileSystem,
  entry: TransactionIntentEntry,
  evidence: TransactionMutationEvidence | undefined,
  index: number,
): Promise<number> {
  const { parent, afterHash, beforeHash, beforeMode } = entry
  if (!parent || afterHash === undefined || !validateOwnership([entry])) {
    throw new Error('Missing transaction recovery guard.')
  }
  const observe = () => observeTransactionPath(cwd, fs, entry.path, parent)
  const live = await observe()
  if (stateMatches(live, beforeHash, beforeMode)) return 0
  if (!stateMatches(live, afterHash, entry.afterMode)) {
    throw new Error(
      `Transaction path changed before restoration: ${entry.path}.`,
    )
  }
  const broker = captureHostMutationBroker(fs)
  if (!broker || !evidence)
    throw new Error(`Missing broker receipt proof for ${entry.path}.`)
  const restored = await broker.restoreTransactionStage({
    evidence,
    index,
    fullPath: live.fullPath,
  })
  if (!restored || !stateMatches(await observe(), beforeHash, beforeMode)) {
    throw new Error(
      `Conditional restoration could not verify the pre-image of ${entry.path}.`,
    )
  }
  return restored
}

/** Conditional, retryable recovery of workspace-scoped intents. */
export async function recoverAndRevertInterruptedTransactions(params: {
  intentLog: TransactionIntentLog
  cwd: string
  fs: CodebuffFileSystem
  logger?: Pick<Logger, 'debug' | 'warn'>
}): Promise<
  {
    revertedTransactions: number
    revertedPaths: number
    recoveredCommittedTransactions: number
  } & (
    | { ok: true }
    | {
        ok: false
        status: 'recovery_required'
        error: string
        transactionIds: string[]
      }
  )
> {
  const { intentLog, cwd, fs, logger } = params
  const report = {
    revertedTransactions: 0,
    revertedPaths: 0,
    recoveredCommittedTransactions: 0,
  }
  const recovery = await intentLog.recoverInterruptedTransactions()
  if (!recovery.ok) {
    logger?.warn(
      { error: recovery.error },
      'Transaction recovery could not read the intent log',
    )
    return {
      ...report,
      ok: false,
      status: 'recovery_required',
      error: recovery.error,
      transactionIds: [],
    }
  }
  const blocked = [...(recovery.liveTransactionIds ?? [])]
  let failure: string | undefined
  const observe = (entryPath: string, entry: TransactionIntentEntry) => {
    if (!entry.parent)
      throw new Error(
        `Missing physical parent proof for transaction path ${entryPath}.`,
      )
    return observeTransactionPath(cwd, fs, entryPath, entry.parent)
  }
  for (const transaction of recovery.transactions) {
    const outcome = await intentLog.revertTransaction(
      transaction.transactionId,
      async () => {
        throw new Error('Durable recovery requires broker authority.')
      },
      observe,
      { cwd, fs },
    )
    report.revertedPaths += outcome.revertedPaths
    if (outcome.ok) {
      if (outcome.status === 'reverted') report.revertedTransactions++
      if (outcome.status === 'recovered_committed')
        report.recoveredCommittedTransactions++
      logger?.debug(
        { transactionId: transaction.transactionId, outcome },
        'Reconciled transaction intent',
      )
    } else {
      blocked.push(transaction.transactionId)
      failure ??= outcome.error
      logger?.warn(
        { transactionId: transaction.transactionId, outcome },
        'Transaction recovery is required; intent retained',
      )
    }
  }
  return blocked.length
    ? {
        ...report,
        ok: false,
        status: 'recovery_required',
        transactionIds: blocked,
        error: failure ?? 'A live coordinator owns an unfinished transaction.',
      }
    : { ...report, ok: true }
}
