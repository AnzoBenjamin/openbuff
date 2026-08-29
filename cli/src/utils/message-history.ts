/**
 * Process-wide session stores: sessionUnpersistedHistory and sessionHistoryRetry
 * are intentionally process-global singletons shared across the TUI and tests.
 * There is exactly one persisted history per process, so per-consumer state
 * would bound nothing in aggregate — every retry of an unavailable load pays a
 * blocking lock acquisition on the single shared event loop. File-scoped
 * beforeEach/afterEach hooks reset both stores so a test that mutates them and
 * then throws does not leak memory-only prompts or a spent retry budget into
 * later tests (see message-history.test.ts and
 * prompt-history-search-screen.test.ts).
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

import { getConfigDir } from './auth'
import { formatTimestamp } from './helpers'
import { logger } from './logger'

import type {
  ChatMessage,
  ContentBlock,
  FileAttachment,
  ImageAttachment,
  TextAttachment,
} from '../types/chat'

const MAX_HISTORY_SIZE = 1000
export const MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES = 256 * 1024
// Upper bound for reading persisted history back into memory: an oversized
// snapshot is treated as corrupt and skipped, while an oversized journal is
// read as a bounded tail of its last MESSAGE_HISTORY_READ_MAX_BYTES bytes
// (see loadMessageHistoryUnlocked).
export const MESSAGE_HISTORY_READ_MAX_BYTES = 10 * 1024 * 1024
const MESSAGE_HISTORY_LOCK_STALE_MS = 30_000
/**
 * Lock acquisition budget for non-interactive callers (CLI commands, tests):
 * MESSAGE_HISTORY_LOCK_MAX_ATTEMPTS * MESSAGE_HISTORY_LOCK_POLL_MS ≈ 500ms.
 * These callers have no event loop to starve, so they wait longer to maximise
 * the chance of persisting.
 */
export const MESSAGE_HISTORY_LOCK_MAX_ATTEMPTS = 50
/**
 * Lock acquisition budget for interactive TUI callers (input submit, history
 * screens): ≈100ms. History is best-effort, so giving up early and degrading
 * is preferable to stalling the terminal event loop for half a second.
 */
export const MESSAGE_HISTORY_UI_LOCK_MAX_ATTEMPTS = 10
export const MESSAGE_HISTORY_LOCK_POLL_MS = 10
/**
 * Wall-clock acquisition budget for an attempt count, enforced as a deadline:
 * the stat/unlink syscalls each retry performs can outlast a poll interval, so
 * an attempt-count bound alone would let a caller block past its budget.
 */
export const messageHistoryLockBudgetMs = (maxAttempts: number): number =>
  maxAttempts * MESSAGE_HISTORY_LOCK_POLL_MS
/**
 * Minimum spacing between retries of an unavailable history load, and the hard
 * cap on how many such retries a session performs. Every retry pays a blocking
 * lock acquisition, so a persistently unreadable or contended history must not
 * be re-read once per arrow keypress.
 */
export const MESSAGE_HISTORY_RETRY_COOLDOWN_MS = 2_000
export const MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS = 3
/**
 * Idle interval after which the retry budget is refunded — a multiple of the
 * cooldown, so a refunded retry is never cheaper than a normal one. Without it
 * a session contended for its first keypresses stays history-less until a
 * submit happens to reload successfully.
 */
export const MESSAGE_HISTORY_RETRY_REFUND_MS =
  MESSAGE_HISTORY_RETRY_COOLDOWN_MS * 30

export function getUserMessage(
  message: string | ContentBlock[],
  attachments?: ImageAttachment[],
  textAttachments?: TextAttachment[],
  fileAttachments?: FileAttachment[],
): ChatMessage {
  return {
    id: `user-${Date.now()}`,
    variant: 'user',
    ...(typeof message === 'string'
      ? {
          content: message,
        }
      : {
          content: '',
          blocks: message,
        }),
    timestamp: formatTimestamp(),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(textAttachments && textAttachments.length > 0
      ? { textAttachments }
      : {}),
    ...(fileAttachments && fileAttachments.length > 0
      ? { fileAttachments }
      : {}),
  }
}

export function getSystemMessage(content: string | ContentBlock[]): ChatMessage
export function getSystemMessage(
  blocks: ContentBlock[],
  legacyContent: string,
): ChatMessage
export function getSystemMessage(
  content: string | ContentBlock[],
  legacyContent?: string,
): ChatMessage {
  if (typeof content === 'string') {
    return {
      id: `sys-${Date.now()}`,
      variant: 'ai' as const,
      content,
      timestamp: formatTimestamp(),
    }
  }
  if (legacyContent !== undefined) {
    return {
      id: `sys-${Date.now()}`,
      variant: 'ai' as const,
      content: legacyContent,
      blocks: content,
      timestamp: formatTimestamp(),
    }
  }
  return {
    id: `sys-${Date.now()}`,
    variant: 'ai' as const,
    content: '',
    blocks: content,
    timestamp: formatTimestamp(),
  }
}

/**
 * Get the message history file path
 */
export const getMessageHistoryPath = (): string => {
  return path.join(getConfigDir(), 'message-history.json')
}

export const getMessageHistoryJournalPath = (): string =>
  path.join(getConfigDir(), 'message-history.jsonl')

const getMessageHistoryLockPath = (): string =>
  path.join(getConfigDir(), 'message-history.lock')

/**
 * Inode of the lock file this process currently holds, published for the
 * destructive paths inside the critical section: a stalled section can be
 * reclaimed as stale (SIGSTOP/Ctrl+Z, host suspend, very slow FS), and the
 * successor's appends must not be overwritten by writes built from a read that
 * predates it.
 */
let heldLockIno: number | undefined

/**
 * Whether the lock file at the lock path is still the one this process created.
 * False once our lock was reclaimed as stale and replaced by a successor, or
 * when the lock is simply gone.
 */
const holdsMessageHistoryLock = (): boolean => {
  if (heldLockIno === undefined) return false
  try {
    return fs.statSync(getMessageHistoryLockPath()).ino === heldLockIno
  } catch {
    return false
  }
}

/**
 * Synchronous file lock for message history, using blocking Atomics.wait on the
 * single-threaded CLI main thread; every critical section is a short local file
 * op.
 *
 * Acquisition is bounded in wall-clock time by
 * messageHistoryLockBudgetMs(maxAttempts) and throws "busy" instead of waiting,
 * so a contended lock cannot stall the shared TUI event loop past the caller's
 * own budget even when the per-retry syscalls are slow.
 */
function withMessageHistoryLock<T>(
  operation: () => T,
  maxAttempts: number = MESSAGE_HISTORY_LOCK_MAX_ATTEMPTS,
): T {
  const lockPath = getMessageHistoryLockPath()
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  const outerHeldLockIno = heldLockIno
  let lockFd: number | undefined
  // Inode of the lock we created, captured at acquisition time. Release below
  // only unlinks when the file at lockPath still has this inode, so a lock
  // that was reclaimed as stale and replaced by another process survives.
  let lockIno: number | undefined
  try {
    const waitState = new Int32Array(new SharedArrayBuffer(4))
    const deadlineMs = Date.now() + messageHistoryLockBudgetMs(maxAttempts)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        lockFd = fs.openSync(lockPath, 'wx', 0o600)
        try {
          lockIno = fs.fstatSync(lockFd).ino
          // Published for the destructive paths inside this critical section:
          // they re-verify that the file at lockPath is still this inode
          // before overwriting the snapshot or blanking the journal.
          heldLockIno = lockIno
        } catch (statError) {
          // Without an inode the release below would skip its unlink and leave
          // a lock we own orphaned at the path until the staleness horizon,
          // blocking every history operation until then. Nothing can have
          // replaced this lock yet (reclaiming one requires
          // MESSAGE_HISTORY_LOCK_STALE_MS of staleness), so drop it here while
          // it is provably still ours, then report the failure. A throwing
          // close must not skip that unlink either.
          try {
            fs.closeSync(lockFd)
          } catch {
            // Descriptor leaked for this process; releasing the lock matters
            // more than the fd.
          }
          lockFd = undefined
          try {
            fs.unlinkSync(lockPath)
          } catch {
            // Already gone — nothing to clean up.
          }
          throw statError
        }
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
        try {
          const initialStat = fs.statSync(lockPath)
          const lockAge = Date.now() - initialStat.mtimeMs
          if (lockAge > MESSAGE_HISTORY_LOCK_STALE_MS) {
            // TOCTOU mitigation: re-stat and verify file identity + age before unlink.
            // Without this, stat+unlink could delete a fresh lock created between checks.
            try {
              const verifyStat = fs.statSync(lockPath)
              const isSameFile = verifyStat.ino === initialStat.ino
              const stillStale =
                Date.now() - verifyStat.mtimeMs > MESSAGE_HISTORY_LOCK_STALE_MS
              if (isSameFile && stillStale) {
                // Residual race, inherent to unlink-based recovery: between
                // verifyStat and unlinkSync a second reclaimer can win the
                // unlink and a third process install a fresh lock that this
                // unlink then deletes. Unavoidable with advisory lock files;
                // a future mitigation could use O_DIRECTORY + flock on the
                // config directory instead of unlink-based stale reclamation.
                fs.unlinkSync(lockPath)
              }
            } catch {
              // If verify fails (e.g., lock removed concurrently), retry acquisition
            }
          }
        } catch (statError) {
          // The lock vanished between EEXIST and stat: fall through to the poll
          // wait and retry acquisition.
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT')
            throw statError
        }
        // Every retry path — fresh lock, stale-lock recovery, vanished lock —
        // pays the poll wait, so the acquisition bound holds on all of them
        // instead of only the fresh-lock path. The wait is clamped to the time
        // left in the budget and the loop stops as soon as that budget is
        // spent: the stat/unlink syscalls above are not free, so counting
        // attempts alone would let a slow or contended filesystem stretch an
        // interactive acquisition far past its ≈100ms bound and stall the TUI
        // event loop.
        const remainingMs = deadlineMs - Date.now()
        if (remainingMs <= 0) break
        Atomics.wait(
          waitState,
          0,
          0,
          Math.min(remainingMs, MESSAGE_HISTORY_LOCK_POLL_MS),
        )
      }
    }
    // Budget exhausted — attempts or wall-clock deadline, on fresh-lock
    // contention or repeated stale-recovery retries: report the same specific
    // "busy" failure on every exit path.
    if (lockFd === undefined)
      throw new Error('Message history is busy in another Openbuff process')
    return operation()
  } finally {
    heldLockIno = outerHeldLockIno
    if (lockFd !== undefined) {
      try {
        fs.closeSync(lockFd)
      } catch {
        // A throwing close must not skip the release below: the lock file is
        // still ours, and leaving it behind blocks every history read/write
        // until the MESSAGE_HISTORY_LOCK_STALE_MS horizon. Losing one fd for
        // the rest of the process is the cheaper failure.
      }
      try {
        // Only remove the lock we created: if ours was reclaimed as stale and
        // a successor took over the path, its inode differs and it must stay.
        if (lockIno !== undefined && fs.statSync(lockPath).ino === lockIno) {
          fs.unlinkSync(lockPath)
        }
      } catch {
        // The lock is already gone or unreadable — nothing to clean up.
      }
    }
  }
}

/**
 * Atomically replace `filePath` with `contents` using a pid+randomUUID temp
 * file. The temp file is fsynced before the rename, so a completed rename
 * always exposes fully-written contents instead of a renamed-but-empty file.
 * The parent directory is not fsynced, so a crash can still lose the rename
 * itself — which leaves the previous file intact. Rename success is tracked so
 * a failed write or rename unlinks the temp file in the finally block instead
 * of leaving *.tmp debris behind.
 */
function atomicWriteFile(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const temporaryFd = fs.openSync(temporaryPath, 'w', 0o600)
    try {
      fs.writeFileSync(temporaryFd, contents, 'utf8')
      fs.fsyncSync(temporaryFd)
    } finally {
      fs.closeSync(temporaryFd)
    }
    fs.renameSync(temporaryPath, filePath)
    renamed = true
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(temporaryPath)
      } catch {
        // The temp file may not exist if the initial write itself failed.
      }
    }
  }
}

function writeHistorySnapshot(history: string[]): void {
  atomicWriteFile(getMessageHistoryPath(), JSON.stringify(history, null, 2))
}

function truncateJournal(): void {
  atomicWriteFile(getMessageHistoryJournalPath(), '')
}

/**
 * Identity of the journal at the moment its bytes were folded into an in-memory
 * history: inode plus byte length, with `ino: undefined` for an absent journal
 * (a known length of 0).
 *
 * Every destructive rewrite below compares this against the journal on disk, so
 * lines appended after the fold — by a process that reclaimed our stalled lock
 * as stale — are never truncated away as if they had been folded in.
 */
type JournalState = {
  ino: number | undefined
  size: number
}

/**
 * Read the journal's identity. A missing journal is a known empty one; any other
 * stat failure returns undefined, which makes the rewrite paths decline rather
 * than truncate against an unknown state.
 */
const readJournalState = (): JournalState | undefined => {
  try {
    const { ino, size } = fs.statSync(getMessageHistoryJournalPath())
    return { ino, size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { ino: undefined, size: 0 }
    return undefined
  }
}

const journalStatesMatch = (
  folded: JournalState,
  current: JournalState | undefined,
): boolean =>
  current !== undefined &&
  current.ino === folded.ino &&
  current.size === folded.size

/**
 * Rewrite the journal to keep only the lines appended after `folded`, the state
 * the snapshot we just wrote was built from. Blanking it instead would erase a
 * successor's appends, which that snapshot cannot contain.
 *
 * Preserved lines are re-emitted untagged: their sequence tags describe the
 * snapshot generation just replaced, so keeping them would make the next load
 * drop them as crash replay. A duplicated prompt beats a lost one.
 *
 * Nothing is rewritten at all when the lock is no longer ours, when the journal
 * was replaced or shrunk, or when the appended tail exceeds the bounded read: in
 * each case the folded prefix cannot be located within a read this function may
 * perform, and rewriting would destroy lines it never saw.
 */
function preserveJournalTail(folded: JournalState): void {
  const journalPath = getMessageHistoryJournalPath()
  // Same ownership recheck as the snapshot write: a successor that reclaimed our
  // stalled lock may be appending right now, and our rename would drop whatever
  // landed between the read below and the write. Leaving the folded prefix in
  // place costs nothing — the next load drops it as crash-replay overlap.
  if (!holdsMessageHistoryLock()) {
    logger.warn(
      'Leaving the message history journal as-is: the lock was reclaimed while compacting',
    )
    return
  }
  const current = readJournalState()
  if (
    current === undefined ||
    (folded.ino !== undefined && current.ino !== folded.ino) ||
    current.size <= folded.size
  ) {
    logger.warn(
      'Leaving the message history journal as-is: it was replaced while compacting',
    )
    return
  }
  const tailLength = current.size - folded.size
  // Reads stay bounded by MESSAGE_HISTORY_READ_MAX_BYTES, and a window of the
  // tail is not enough to rewrite from: the lines between folded.size and the
  // window start would be destroyed by the rewrite below. Leave the journal
  // alone instead, so every appended line survives.
  if (tailLength > MESSAGE_HISTORY_READ_MAX_BYTES) {
    logger.warn(
      'Leaving the message history journal as-is: the tail appended while compacting exceeds the bounded read size',
    )
    return
  }
  const journalFd = fs.openSync(journalPath, 'r')
  let tail: string
  try {
    const buffer = Buffer.alloc(tailLength)
    const bytesRead = fs.readSync(journalFd, buffer, 0, tailLength, folded.size)
    tail = buffer.toString('utf8', 0, bytesRead)
  } finally {
    fs.closeSync(journalFd)
  }
  const preserved = tail
    .split('\n')
    .map((line) => (line ? parseJournalLine(line) : undefined))
    .filter((entry): entry is JournalEntry => entry !== undefined)
    .map((entry) => `${JSON.stringify(entry.text)}\n`)
    .join('')
  atomicWriteFile(journalPath, preserved)
}

/**
 * Overwrite the snapshot with `history` and retire the journal state `folded`
 * it was built from.
 *
 * Every destructive write re-verifies lock ownership, and the journal ones that
 * the journal is byte-for-byte the one we folded, so appends by a process that
 * reclaimed our stalled lock survive: a change before the snapshot write cancels
 * the rewrite entirely, a change after it retires only the folded prefix.
 *
 * Residual race, inherent to advisory unlink-based locking: a successor can
 * append (or compact) in the instant between a check and the following write.
 */
function persistCompactedHistory(
  history: string[],
  folded: JournalState | undefined,
): void {
  if (
    folded === undefined ||
    !journalStatesMatch(folded, readJournalState()) ||
    !holdsMessageHistoryLock()
  ) {
    logger.warn(
      'Skipping message history rewrite: the lock was reclaimed or the journal changed mid-operation',
    )
    return
  }
  writeHistorySnapshot(history)
  if (
    journalStatesMatch(folded, readJournalState()) &&
    holdsMessageHistoryLock()
  ) {
    truncateJournal()
    return
  }
  preserveJournalTail(folded)
}

/**
 * Fold the journal into the snapshot. Refuses to run on a degraded load: a
 * snapshot rewritten from a read that could not see the existing entries — and
 * a journal truncated afterwards — would destroy history we merely failed to
 * read. Deterministically corrupt content is still compacted away.
 *
 * The journal state is captured *before* the read it folds, so
 * persistCompactedHistory can prove the destructive writes still apply to the
 * state this snapshot was built from.
 */
function compactMessageHistory(): void {
  const folded = readJournalState()
  const { history, degraded } = loadMessageHistoryUnlocked()
  if (degraded) {
    logger.warn(
      'Skipping message history compaction: persisted history is not fully readable',
    )
    return
  }
  persistCompactedHistory(history, folded)
}

type JournalEntry = {
  text: string
  /**
   * Snapshot entry count recorded when the line was appended, or undefined for
   * legacy bare-string journal lines written before sequence tagging.
   */
  snapshotLength: number | undefined
}

/**
 * Outcome of reading the persisted snapshot.
 *
 * The status matters beyond the entries themselves: `ok` means the snapshot's
 * length is known (an absent snapshot is a known length of 0) and may be used
 * to tag journal lines, `corrupt` means the content is deterministically
 * unusable and safe to overwrite, and `unreadable` means an I/O failure hid
 * contents that still exist on disk.
 */
type SnapshotRead = {
  status: 'ok' | 'corrupt' | 'unreadable'
  entries: string[]
}

/**
 * Read the persisted snapshot. A missing snapshot reads as an empty `ok` one;
 * malformed, non-array or oversized content is reported as `corrupt`; an I/O
 * failure is reported as `unreadable` instead of being collapsed to `[]`.
 *
 * That last distinction is load-bearing: treating "could not read it" as "it is
 * empty" would make appendMessageHistory tag its entry s=0, and the next
 * successful load would classify that entry as crash-replay overlap and drop
 * it silently. It would also let compaction overwrite a snapshot whose entries
 * were never seen.
 */
const readSnapshotUnlocked = (): SnapshotRead => {
  const historyPath = getMessageHistoryPath()
  let raw: string
  try {
    // Size sanity-check before the read: a corrupted or runaway snapshot must
    // not be slurped into memory whole. Oversized snapshots are treated like
    // other corrupt snapshots — warned about and ignored.
    if (fs.statSync(historyPath).size > MESSAGE_HISTORY_READ_MAX_BYTES) {
      logger.warn(
        { error: `snapshot exceeds ${MESSAGE_HISTORY_READ_MAX_BYTES} bytes` },
        'Message history snapshot is oversized, ignoring it',
      )
      return { status: 'corrupt', entries: [] }
    }
    raw = fs.readFileSync(historyPath, 'utf8')
    // TOCTOU: the file may have grown between the stat above and the read.
    // Re-check the bytes actually read and treat an oversized result as corrupt
    // rather than slurping an unbounded snapshot into memory.
    if (Buffer.byteLength(raw, 'utf8') > MESSAGE_HISTORY_READ_MAX_BYTES) {
      logger.warn(
        { error: `snapshot exceeds ${MESSAGE_HISTORY_READ_MAX_BYTES} bytes` },
        'Message history snapshot is oversized, ignoring it',
      )
      return { status: 'corrupt', entries: [] }
    }
  } catch (error) {
    // A snapshot that does not exist is genuinely empty; any other failure
    // (EACCES, EIO, EISDIR, ...) hides contents we must assume are still there.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { status: 'ok', entries: [] }
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Message history snapshot is unreadable, preserving it as-is',
    )
    return { status: 'unreadable', entries: [] }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed))
      return {
        status: 'ok',
        entries: parsed.filter(
          (item): item is string => typeof item === 'string',
        ),
      }
    logger.warn(
      {
        error:
          'Expected a JSON array of strings; ignoring the invalid snapshot',
      },
      'Message history file has invalid format, ignoring it',
    )
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Ignoring malformed legacy message history',
    )
  }
  return { status: 'corrupt', entries: [] }
}

/**
 * Read the journal, bounded to its last MESSAGE_HISTORY_READ_MAX_BYTES bytes.
 * An externally enlarged journal keeps its newest entries instead of being
 * discarded wholesale; only the first line of the window is dropped, since a
 * byte-offset window almost always starts mid-line.
 */
const readJournalTail = (journalPath: string): string => {
  const { size } = fs.statSync(journalPath)
  if (size <= MESSAGE_HISTORY_READ_MAX_BYTES)
    return fs.readFileSync(journalPath, 'utf8')
  const journalFd = fs.openSync(journalPath, 'r')
  try {
    const buffer = Buffer.alloc(MESSAGE_HISTORY_READ_MAX_BYTES)
    const bytesRead = fs.readSync(
      journalFd,
      buffer,
      0,
      MESSAGE_HISTORY_READ_MAX_BYTES,
      size - MESSAGE_HISTORY_READ_MAX_BYTES,
    )
    const tail = buffer.toString('utf8', 0, bytesRead)
    const firstLineEnd = tail.indexOf('\n')
    return firstLineEnd === -1 ? '' : tail.slice(firstLineEnd + 1)
  } finally {
    fs.closeSync(journalFd)
  }
}

/**
 * Parse one journal line. Current lines are {"s":<snapshotLength>,"t":<text>};
 * bare JSON strings written by older versions are still accepted.
 *
 * Compatibility is one-way: a pre-tagging CLI treats a tagged line as malformed
 * and so drops the journal tail appended since the upgrade. Dual-writing both
 * shapes would duplicate every entry for this reader, so that rollback cost is
 * accepted rather than mitigated.
 */
const parseJournalLine = (line: string): JournalEntry | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed === 'string')
    return { text: parsed, snapshotLength: undefined }
  if (typeof parsed === 'object' && parsed !== null) {
    const { s, t } = parsed as { s?: unknown; t?: unknown }
    if (
      typeof t === 'string' &&
      typeof s === 'number' &&
      Number.isInteger(s) &&
      s >= 0
    )
      return { text: t, snapshotLength: s }
  }
  return undefined
}

type MessageHistoryLoad = {
  history: string[]
  /**
   * True when a persisted source could not be read at all (unreadable
   * snapshot, failed journal read), so the result is known to be incomplete.
   * Deterministically corrupt content — an unparseable snapshot, a malformed
   * journal line — is not degradation: it is skipped and safe to compact away.
   */
  degraded: boolean
}

/**
 * Load message history from file system.
 *
 * Size bound: appendMessageHistory compacts (snapshot + truncate) as soon as
 * the journal reaches MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES (256 KiB), and
 * snapshots themselves are capped at MAX_HISTORY_SIZE entries, so under normal
 * operation neither file grows past roughly the compaction threshold plus a
 * single appended entry. As defense in depth against externally enlarged or
 * corrupt files, an oversized snapshot is ignored and an oversized journal is
 * read as a bounded tail instead of being slurped whole into memory.
 *
 * @returns The messages (most recent last) plus whether the read degraded
 */
const loadMessageHistoryUnlocked = (): MessageHistoryLoad => {
  const snapshot = readSnapshotUnlocked()
  const history = [...snapshot.entries]
  let degraded = snapshot.status === 'unreadable'
  const journalPath = getMessageHistoryJournalPath()
  if (fs.existsSync(journalPath)) {
    const journalEntries: JournalEntry[] = []
    try {
      for (const line of readJournalTail(journalPath).split('\n')) {
        if (!line) continue
        const entry = parseJournalLine(line)
        if (entry) journalEntries.push(entry)
        else logger.warn('Ignoring malformed message history journal entry')
      }
    } catch (error) {
      degraded = true
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Error reading message history journal',
      )
    }
    // A crash between the snapshot write and the journal truncation leaves
    // journal lines the snapshot already contains. Each line records the
    // snapshot length it was appended after, so that overlap is detected by
    // sequence instead of content equality (which lost verbatim repeats): a
    // recorded length below the current one was already folded in. Untagged
    // legacy lines always replay.
    //
    // The comparison needs a *known* snapshot length — an unreadable snapshot
    // reads as 0, which would make every tagged entry look stale — so it is
    // skipped entirely then. Accepted limitation: at the MAX_HISTORY_SIZE cap
    // the length stops growing, so an overlapping entry replays once.
    const snapshotLength = snapshot.status === 'ok' ? history.length : undefined
    for (const entry of journalEntries) {
      if (
        snapshotLength !== undefined &&
        entry.snapshotLength !== undefined &&
        entry.snapshotLength < snapshotLength
      )
        continue
      history.push(entry.text)
    }
  }
  return { history: history.slice(-MAX_HISTORY_SIZE), degraded }
}

/**
 * Load message history. Unlike the writers below, this propagates errors
 * (including "busy" lock failures) to the caller, and uses the longer
 * non-interactive acquisition budget.
 */
export const loadMessageHistory = (): string[] =>
  withMessageHistoryLock(loadMessageHistoryUnlocked).history

/**
 * Load message history for interactive callers: never throws, uses the short
 * MESSAGE_HISTORY_UI_LOCK_MAX_ATTEMPTS budget so a contended lock cannot stall
 * the TUI event loop, and degrades to whatever could be read.
 *
 * `onUnavailable` fires whenever the result is not a trustworthy view of the
 * persisted history — a "busy" lock held by another Openbuff process, an
 * unreadable snapshot, or a failed journal read — so the UI can distinguish an
 * unavailable history from a genuinely empty one.
 */
export const loadMessageHistorySafe = (
  onUnavailable?: (error: unknown) => void,
): string[] => {
  try {
    const { history, degraded } = withMessageHistoryLock(
      loadMessageHistoryUnlocked,
      MESSAGE_HISTORY_UI_LOCK_MAX_ATTEMPTS,
    )
    if (degraded)
      onUnavailable?.(new Error('Message history could not be read completely'))
    return history
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to load message history, degrading to an empty list',
    )
    onUnavailable?.(error)
    return []
  }
}

/**
 * Upper bound on the memory-only entries one session carries. Prompts whose
 * append never reached disk are re-folded into every later reload, so the list
 * must stay bounded even when persistence is broken for a long session.
 */
export const MESSAGE_HISTORY_MAX_UNPERSISTED = 100

/**
 * An in-memory history view plus the session state needed to keep it correct
 * across later reloads.
 */
export type FoldedMessageHistory = {
  history: string[]
  /**
   * Prompts this session appended that never reached disk. They are carried
   * forward so every later reload can re-fold them.
   */
  unpersisted: string[]
}

/**
 * Fold a session's memory-only entries into a fresh, trustworthy view of the
 * persisted history. `persisted` must come from a non-degraded load: it is
 * treated as authoritative for what actually reached disk.
 *
 * Re-folding on *every* reload, not only the one after the failed append, is
 * what keeps a memory-only prompt navigable for the rest of the session: folding
 * it once lost it at the next successful reload. Memory-only entries sort after
 * the persisted ones, so a failed prompt stays this session's newest.
 *
 * An entry found in `persisted` stops being carried (a late failure, or another
 * terminal wrote the same text). Accepted limitation: a failed prompt repeating
 * an existing entry verbatim counts as already present, since navigation
 * surfaces the same text either way.
 */
export const foldUnpersistedMessageHistory = (
  persisted: string[],
  unpersisted: string[],
): FoldedMessageHistory => {
  const history = [...persisted]
  // Set membership, not Array.includes per entry: this runs per arrow keypress
  // via retryUnavailableHistoryNavigation, over up to 1000 x 100 entries.
  const persistedEntries = new Set(persisted)
  const stillUnpersisted: string[] = []
  for (const entry of unpersisted) {
    if (persistedEntries.has(entry)) continue
    history.push(entry)
    stillUnpersisted.push(entry)
  }
  return {
    history: history.slice(-MAX_HISTORY_SIZE),
    unpersisted: stillUnpersisted,
  }
}

/**
 * Reload history for an interactive session that has just appended `appended`.
 *
 * An unavailable reload must not be mistaken for an empty history: the caller
 * keeps its `lastGood` list plus the new entry, resolved through the shared
 * resolveDegradedMessageHistory rule (a partial read may grow that view, never
 * shrink it), so a single contended reload cannot wipe a session's up/down
 * navigation and both consumers of the same degraded read resolve alike.
 *
 * `appendPersisted: false` closes the other half of that partial failure — a
 * reload that succeeds while the append failed cannot contain the prompt, so it
 * joins `unpersisted`, which the caller passes back on every later reload.
 */
export const reloadMessageHistoryAfterAppend = ({
  lastGood,
  appended,
  onUnavailable,
  appendPersisted = true,
  unpersisted = [],
}: {
  lastGood: string[]
  appended: string
  onUnavailable?: (error: unknown) => void
  appendPersisted?: boolean
  unpersisted?: string[]
}): FoldedMessageHistory => {
  let unavailable = false
  const reloaded = loadMessageHistorySafe((error) => {
    unavailable = true
    onUnavailable?.(error)
  })
  const pending = appendPersisted
    ? unpersisted
    : [...unpersisted, appended].slice(-MESSAGE_HISTORY_MAX_UNPERSISTED)
  // A degraded reload proves nothing about what is on disk, so the carried
  // memory-only entries are kept as-is and the view to keep is resolved by the
  // same shared rule every other consumer of a degraded read uses, over
  // `lastGood` (which already contains the entries folded earlier) extended with
  // this entry. Returning that list directly instead let a post-submit degraded
  // reload diverge from what the Ctrl+R overlay resolves for the very same read.
  if (unavailable)
    return {
      history: resolveDegradedMessageHistory(
        [...lastGood, appended].slice(-MAX_HISTORY_SIZE),
        reloaded,
        pending,
      ),
      unpersisted: pending,
    }
  return foldUnpersistedMessageHistory(reloaded, pending)
}

/**
 * Bounded retry budget for an interactive caller whose last history load was
 * unavailable: how many retries it has already spent and when the last attempt
 * ran.
 *
 * `lastAttemptMs` lives on the monotonic historyRetryNowMs timeline, not on the
 * wall clock: a backwards system clock adjustment must not strand a session on
 * an unavailable history for the length of the jump.
 */
export type HistoryRetryState = {
  attempts: number
  lastAttemptMs: number
}

/**
 * Clock for the retry cooldown/refund budget. performance.now() is monotonic
 * from process start, so an NTP correction or a manual clock change cannot make
 * a recorded attempt appear to be in the future (which pinned
 * shouldRetryUnavailableHistory to false for the whole duration of a backwards
 * jump) nor fake a refund by jumping forwards.
 *
 * Every call site — the mount load, the mid-navigation retry, the prompt history
 * search screen — must timestamp with this rather than Date.now(), otherwise the
 * two clock domains get compared against each other.
 */
export const historyRetryNowMs = (): number => performance.now()

/**
 * Idle time since the last attempt. A negative interval is not reachable on one
 * monotonic clock, so it means the state was timestamped in another clock domain
 * (a persisted or wall-clock value): treat it as fully idle rather than as "the
 * cooldown has not elapsed", so the session recovers immediately instead of
 * waiting out the discrepancy.
 */
const historyRetryIdleMs = (
  state: HistoryRetryState,
  nowMs: number,
): number => {
  const idleMs = nowMs - state.lastAttemptMs
  return idleMs < 0 ? Number.POSITIVE_INFINITY : idleMs
}

/**
 * Whether an unavailable history may be reloaded again. Retries are spaced by
 * MESSAGE_HISTORY_RETRY_COOLDOWN_MS and capped at
 * MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS, so a persistently unreadable history costs
 * a bounded number of blocking lock acquisitions instead of one per keypress.
 * The cap is refunded after MESSAGE_HISTORY_RETRY_REFUND_MS of idleness so the
 * session can recover.
 *
 * `nowMs` must come from historyRetryNowMs.
 */
export const shouldRetryUnavailableHistory = (
  state: HistoryRetryState,
  nowMs: number,
): boolean => {
  const idleMs = historyRetryIdleMs(state, nowMs)
  if (idleMs < MESSAGE_HISTORY_RETRY_COOLDOWN_MS) return false
  return (
    idleMs >= MESSAGE_HISTORY_RETRY_REFUND_MS ||
    state.attempts < MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS
  )
}

/**
 * Fold the outcome of a load into the retry budget: a trustworthy load clears
 * it, a failed one spends one attempt, and an attempt made after
 * MESSAGE_HISTORY_RETRY_REFUND_MS of idleness starts from a refunded budget so
 * the session can recover.
 *
 * `nowMs` must come from historyRetryNowMs.
 */
export const recordHistoryRetryAttempt = (
  state: HistoryRetryState,
  nowMs: number,
  unavailable: boolean,
): HistoryRetryState => {
  if (!unavailable) return { attempts: 0, lastAttemptMs: nowMs }
  const spent =
    historyRetryIdleMs(state, nowMs) >= MESSAGE_HISTORY_RETRY_REFUND_MS
      ? 0
      : state.attempts
  return { attempts: spent + 1, lastAttemptMs: nowMs }
}

/**
 * The retry budget for unavailable history loads, held per process rather than
 * per consumer or per component mount.
 *
 * Session state for the same reason sessionUnpersistedHistory is: there is
 * exactly one persisted history per process, and every retry of an unavailable
 * load pays a blocking lock acquisition on the single shared TUI event loop.
 * A budget owned by each consumer bounded nothing in aggregate — the navigation
 * hook, every open of the Ctrl+R overlay and every remount each paid up to
 * MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS of their own, so the bound the callers
 * documented was weaker than it claimed. One shared budget makes it hold.
 */
let sessionHistoryRetry: HistoryRetryState = {
  attempts: 0,
  lastAttemptMs: Number.NEGATIVE_INFINITY,
}

/** The retry budget every interactive consumer of a history load shares. */
export const getSessionHistoryRetry = (): HistoryRetryState =>
  sessionHistoryRetry

/**
 * Replace the shared retry budget with the state a retry composition resolved
 * to, so the next attempt — from any consumer — starts from it.
 */
export const setSessionHistoryRetry = (state: HistoryRetryState): void => {
  sessionHistoryRetry = state
}

/**
 * Fold the outcome of a load into the shared retry budget and return the new
 * state: a trustworthy load clears it for every consumer, a failed one spends
 * one of the process's attempts.
 *
 * `nowMs` must come from historyRetryNowMs.
 */
export const recordSessionHistoryRetryAttempt = (
  nowMs: number,
  unavailable: boolean,
): HistoryRetryState => {
  sessionHistoryRetry = recordHistoryRetryAttempt(
    sessionHistoryRetry,
    nowMs,
    unavailable,
  )
  return sessionHistoryRetry
}

/**
 * Whether `candidate` keeps every entry of `retained`, duplicates included: a
 * verbatim repeat is its own navigable entry, so losing one of two identical
 * prompts shrinks the view just as losing a unique one does.
 */
const keepsEveryEntry = (candidate: string[], retained: string[]): boolean => {
  const remaining = new Map<string, number>()
  for (const entry of candidate)
    remaining.set(entry, (remaining.get(entry) ?? 0) + 1)
  for (const entry of retained) {
    const count = remaining.get(entry)
    if (count === undefined || count === 0) return false
    remaining.set(entry, count - 1)
  }
  return true
}

/**
 * Pick the in-memory history to keep after a *degraded* load. A trustworthy load
 * is authoritative and used as-is by the caller, so there is nothing to resolve.
 *
 * Invariant: a degraded load may grow the retained view but must never shrink
 * it. The partial read is adopted only when the view it resolves to is strictly
 * larger *and* still holds every entry the retained view held, so a read that
 * merely saw different entries cannot drop navigable prompts. A session whose
 * first load was partial can therefore still grow within its bounded retry
 * budget, and a smaller, equal or lossy read changes nothing.
 *
 * `unpersisted` are this session's memory-only prompts. They are re-folded onto
 * whichever view wins, after the persisted entries and without duplicating an
 * entry already present, and stay pending either way: a partial read cannot
 * prove anything reached disk.
 */
export const resolveDegradedMessageHistory = (
  current: string[],
  loaded: string[],
  unpersisted: string[] = [],
): string[] => {
  const withPending = (base: string[]): string[] => {
    if (unpersisted.length === 0) return base
    // Membership is tested against `base` only and deliberately not extended
    // with the entries pushed below: a verbatim repeat is its own navigable
    // entry, so a session that submitted the same prompt twice with both
    // appends failing keeps both here — the rule
    // foldUnpersistedMessageHistory applies on a trustworthy read, and the one
    // keepsEveryEntry already assumes. Collapsing the repeat here made the same
    // session show two entries after a trustworthy read and one after a
    // degraded read.
    //
    // Set membership, not Array.includes per entry: this runs per arrow keypress
    // via retryUnavailableHistoryNavigation, over up to 1000 x 100 entries.
    const present = new Set(base)
    const history = [...base]
    for (const entry of unpersisted) {
      if (present.has(entry)) continue
      history.push(entry)
    }
    return history.slice(-MAX_HISTORY_SIZE)
  }
  // Compare the two *resolved* views, not the raw lists: both then carry this
  // session's memory-only prompts. Discounting the pending entries out of
  // `current` instead overshot whenever a pending text also existed on disk (it
  // matched every such entry), letting a strictly smaller degraded read shrink
  // the retained history.
  const candidate = withPending(loaded)
  const retained = withPending(current)
  return candidate.length > retained.length &&
    keepsEveryEntry(candidate, retained)
    ? candidate
    : retained
}

/**
 * This session's memory-only prompts: entries whose append to disk failed, in
 * submission order.
 *
 * Session state rather than per-consumer state on purpose. Both consumers of a
 * history load — up/down navigation in use-input-history and the Ctrl+R prompt
 * history search overlay — read the same persisted history, so a prompt that
 * only exists in memory has to be visible in both. Holding the list inside the
 * navigation hook left such a prompt reachable with up/down while being
 * permanently invisible in the overlay, including after a retry that recovered
 * the load. There is exactly one persisted history per process, so
 * process-wide state is the same scope as the history it supplements.
 */
let sessionUnpersistedHistory: string[] = []

/** This session's memory-only prompts, oldest first. */
export const getUnpersistedMessageHistory = (): string[] =>
  sessionUnpersistedHistory

/**
 * Replace this session's memory-only prompts, bounded by
 * MESSAGE_HISTORY_MAX_UNPERSISTED so a long session with broken persistence
 * cannot grow the list without limit.
 */
export const setUnpersistedMessageHistory = (entries: string[]): void => {
  sessionUnpersistedHistory = entries.slice(-MESSAGE_HISTORY_MAX_UNPERSISTED)
}

/**
 * Read the persisted history for an interactive consumer and resolve the view it
 * should keep, folding in this session's memory-only prompts.
 *
 * `current` is the view the caller already holds, in persisted
 * (most-recent-last) order. A trustworthy read is authoritative: entries it
 * proves reached disk stop being carried as memory-only. A degraded read may
 * only grow the retained view and retires nothing, since a partial read proves
 * nothing about what is on disk.
 *
 * Shared by every consumer of a history load — the navigation hook and the
 * prompt history search overlay — so the same load can never resolve to
 * different histories for each of them. Never throws and uses the short
 * interactive lock budget, so it cannot stall the TUI event loop.
 */
export const loadSessionMessageHistory = (
  current: string[],
): MessageHistoryLoadOutcome => {
  let unavailable = false
  const loaded = loadMessageHistorySafe(() => {
    unavailable = true
  })
  if (unavailable)
    return {
      history: resolveDegradedMessageHistory(
        current,
        loaded,
        sessionUnpersistedHistory,
      ),
      unavailable,
    }
  const folded = foldUnpersistedMessageHistory(
    loaded,
    sessionUnpersistedHistory,
  )
  sessionUnpersistedHistory = folded.unpersisted
  return { history: folded.history, unavailable }
}

/**
 * Whether two in-memory history views hold the same entries in the same order.
 * Reloads always allocate a fresh array, so sameness is a content property.
 */
const messageHistoriesEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((entry, index) => entry === b[index])

/**
 * Outcome of re-anchoring a navigation cursor onto a freshly reloaded history.
 */
export type HistoryNavigationReanchor = {
  index: number
  /**
   * True when the caller was navigating and no longer is, so the draft saved at
   * the start of the sequence must be restored into the input.
   */
  restoreDraft: boolean
}

/**
 * Re-anchor a history navigation cursor onto a freshly reloaded list.
 *
 * Interactive navigation may retry a previously unavailable load in the middle
 * of an up/down sequence, and the reloaded list can be shorter or shifted (a
 * concurrent terminal compacted it, or the degraded list it replaces was
 * partial). Keeping the old numeric index would park the cursor past the end,
 * where up/down silently do nothing for several keypresses.
 *
 * The entry currently shown wins when it still exists — the cursor follows it to
 * its new position — otherwise the index is clamped back into range. An empty
 * reload resets navigation to the draft.
 */
export const reconcileHistoryIndex = (
  index: number,
  previous: string[],
  reloaded: string[],
): number => {
  if (index < 0 || reloaded.length === 0) return -1
  // Content equality, not array identity: every reload builds a fresh array, so
  // an identity check would re-anchor even when nothing actually changed, and
  // the lastIndexOf below would then move the cursor forward onto a later
  // verbatim duplicate and make the next up-arrow skip entries. Only the clamp
  // still applies, for an index that was already out of range.
  if (messageHistoriesEqual(previous, reloaded))
    return Math.min(index, reloaded.length - 1)
  const focused = previous[index]
  // lastIndexOf: verbatim repeats are legal history entries, and the newest
  // occurrence is the one navigation walks back from.
  const relocated = focused === undefined ? -1 : reloaded.lastIndexOf(focused)
  return relocated === -1 ? Math.min(index, reloaded.length - 1) : relocated
}

/**
 * Re-anchor a navigation cursor and report whether navigation ended.
 *
 * `restoreDraft` is true exactly when a caller that was navigating no longer
 * is: the reload proved the history is empty, so the cursor is back at -1 and
 * the input still shows a history entry the cursor can no longer reach. The
 * caller must put its saved draft back, otherwise that draft is unreachable —
 * down-arrow returns early at index -1 and up-arrow returns early on the empty
 * history.
 */
export const reconcileHistoryNavigation = (
  index: number,
  previous: string[],
  reloaded: string[],
): HistoryNavigationReanchor => {
  const next = reconcileHistoryIndex(index, previous, reloaded)
  return { index: next, restoreDraft: index >= 0 && next === -1 }
}

/**
 * Outcome of one history load: the view to keep in memory plus whether the read
 * was a trustworthy picture of the persisted history.
 */
export type MessageHistoryLoadOutcome = {
  history: string[]
  unavailable: boolean
}

/**
 * Everything an interactive caller must apply after retrying a previously
 * unavailable load in the middle of a navigation sequence.
 */
export type RetriedHistoryNavigation = MessageHistoryLoadOutcome & {
  retry: HistoryRetryState
  index: number
  /** True when the caller must put its saved draft back into the input. */
  restoreDraft: boolean
}

/**
 * Retry an unavailable history load mid-navigation.
 *
 * Composes the three rules the interactive caller must not get wrong, so its
 * own wiring stays a plain state assignment: the retry budget gates the load
 * (`load` is not called at all when the retry is refused, which is what keeps a
 * contended history from paying a blocking lock acquisition per keypress), the
 * navigation cursor is re-anchored onto whatever came back, and a reload that
 * ended navigation reports that the saved draft has to be restored.
 *
 * Returns undefined when no retry is due: nothing was loaded and no state
 * changes.
 *
 * `nowMs` must come from historyRetryNowMs.
 */
export const retryUnavailableHistoryNavigation = (params: {
  history: string[]
  index: number
  retry: HistoryRetryState
  nowMs: number
  load: () => MessageHistoryLoadOutcome
}): RetriedHistoryNavigation | undefined => {
  const { history, index, retry, nowMs, load } = params
  if (!shouldRetryUnavailableHistory(retry, nowMs)) return undefined
  const loaded = load()
  const reanchored = reconcileHistoryNavigation(index, history, loaded.history)
  return {
    history: loaded.history,
    unavailable: loaded.unavailable,
    retry: recordHistoryRetryAttempt(retry, nowMs, loaded.unavailable),
    index: reanchored.index,
    restoreDraft: reanchored.restoreDraft,
  }
}

/**
 * Draft text as it must be shown when navigation returns to the draft. A
 * bash-mode draft is stored with the '!' prefix its input never displays, so
 * that prefix is stripped; a default-mode draft is shown verbatim even when it
 * happens to start with '!'.
 */
export const resolveNavigationDraftText = (
  draft: string,
  bashDraft: boolean,
): string => (bashDraft && draft.startsWith('!') ? draft.slice(1) : draft)

/**
 * '\n' when the journal on disk does not end in a newline, otherwise ''.
 *
 * A crash mid-append can leave an unterminated trailing line; O_APPEND would
 * glue the next entry onto it and both would be dropped on load while the append
 * still reported success, breaking the appendPersisted contract. Terminating
 * first confines the damage to the already-torn line. An unreadable trailing
 * byte counts as torn: a redundant '\n' only adds a line load ignores.
 */
const journalTerminatorPrefix = (journalPath: string): string => {
  let journalFd: number | undefined
  try {
    const { size } = fs.statSync(journalPath)
    if (size === 0) return ''
    journalFd = fs.openSync(journalPath, 'r')
    const buffer = Buffer.alloc(1)
    const bytesRead = fs.readSync(journalFd, buffer, 0, 1, size - 1)
    if (bytesRead === 1 && buffer[0] === 0x0a) return ''
    logger.warn(
      'Message history journal does not end in a newline, terminating the torn line before appending',
    )
    return '\n'
  } catch (error) {
    // A journal that does not exist yet needs no terminator. Any other failure
    // (EIO, EACCES, ...) leaves the trailing byte unknown, so terminate
    // defensively rather than risk concatenating onto a torn line.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Could not verify the message history journal terminator, appending on a fresh line',
    )
    return '\n'
  } finally {
    if (journalFd !== undefined) fs.closeSync(journalFd)
  }
}

/**
 * Append one prompt using O_APPEND. This avoids the cross-terminal lost-update
 * race inherent in read/modify/rename of a shared JSON array.
 *
 * Swallows all errors (logged only); never throws.
 *
 * @returns true when the entry reached the journal on disk. Returning void made
 * a swallowed failure indistinguishable from success, so an interactive caller
 * whose append failed while its reload succeeded lost the prompt from up/down
 * navigation entirely.
 */
export const appendMessageHistory = (message: string): boolean => {
  let appended = false
  try {
    withMessageHistoryLock(() => {
      // withMessageHistoryLock has already created the config directory.
      const journalPath = getMessageHistoryJournalPath()
      const snapshot = readSnapshotUnlocked()
      // Tag the entry with the snapshot length it is appended after so a crash
      // between snapshot write and journal truncation is detected by sequence
      // on load, instead of by content equality (which lost verbatim repeats).
      // The tag is only meaningful when that length is known: when the snapshot
      // is unreadable or corrupt, fall back to the legacy untagged line (which
      // load always replays) rather than claiming s=0 and having this entry
      // dropped later as crash-replay overlap. See parseJournalLine for the
      // one-way rollback consequence of writing the tagged shape.
      const line = JSON.stringify(
        snapshot.status === 'ok'
          ? { s: snapshot.entries.length, t: message }
          : message,
      )
      // A journal left unterminated by a crashed append must not absorb this
      // entry: terminate the torn line first so exactly one (already damaged)
      // line stays malformed instead of two entries being lost.
      fs.appendFileSync(
        journalPath,
        `${journalTerminatorPrefix(journalPath)}${line}\n`,
        {
          encoding: 'utf8',
          mode: 0o600,
        },
      )
      // The entry is durable from here on: a later compaction failure does not
      // un-append it, so callers must not fold it in memory a second time.
      appended = true
      if (
        fs.statSync(journalPath).size >= MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES
      ) {
        // compactMessageHistory is the single authority on whether the current
        // persisted state is safe to rewrite; it declines on a degraded read.
        compactMessageHistory()
      }
      // Interactive budget: this runs from the input submit handler, so a
      // contended lock must not stall the terminal for half a second. History
      // persistence is best-effort and the entry stays in the session's
      // in-memory list either way.
    }, MESSAGE_HISTORY_UI_LOCK_MAX_ATTEMPTS)
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Error appending message history',
    )
  }
  return appended
}

/**
 * Save message history to file system
 *
 * Swallows all errors (logged only); never throws.
 */
export const saveMessageHistory = (history: string[]): void => {
  try {
    // Config directory creation is handled by withMessageHistoryLock.

    // Limit history size to prevent file from growing too large
    const limitedHistory =
      history.length > MAX_HISTORY_SIZE
        ? history.slice(history.length - MAX_HISTORY_SIZE)
        : history

    withMessageHistoryLock(() => {
      // Same reclaim hazard as compaction: capture the journal state this
      // rewrite retires up front, so entries appended by a process that took
      // the lock over mid-operation are preserved instead of truncated away.
      persistCompactedHistory(limitedHistory, readJournalState())
    })
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving message history',
    )
    // Don't throw - history persistence is not critical
  }
}

/**
 * Clear message history from file system
 *
 * Swallows all errors (logged only); never throws.
 */
export const clearMessageHistory = (): void => {
  try {
    withMessageHistoryLock(() => {
      for (const historyPath of [
        getMessageHistoryPath(),
        getMessageHistoryJournalPath(),
      ]) {
        if (fs.existsSync(historyPath)) fs.unlinkSync(historyPath)
      }
    })
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error clearing message history',
    )
  }
}
